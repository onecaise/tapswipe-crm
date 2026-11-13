-- Merchant bulk import: two staging tables, the commit function, the sixth
-- processor, and the one sanctioned exception to "a new merchant needs a
-- location". Phase 14 of docs/design/intake-and-reports.md.
--
-- Matches docs/tapswipe_crm_schema.sql, updated first; the block below is
-- copied from it verbatim.
--
-- =====================================================================
-- MERCHANT IMPORT (20261106120000) — phase 14 of
-- docs/design/intake-and-reports.md.
--
-- An admin uploads the ISO Hub merchants export (CSV or XLSX). The Edge
-- Function stage-merchant-import parses it into merchant_import_rows and
-- marks every problem; the review page shows them; "Read again" re-stages
-- the stored file; commit_merchant_import() re-derives EVERY check from the
-- staged cells, in one transaction, and creates all the merchants or none.
-- The user bulk import's shape (docs/claude/user-accounts.md), with the
-- residual commit's all-or-nothing, because every write here is Postgres.
--
-- 1. THE SIXTH PROCESSOR, '365 Pay', sort order 60 (after Square). An
--    idempotent insert. Refused, naming it, if a different row already
--    holds that code in another spelling or case, or holds sort order 60.
--
-- 2. merchant_import_batches / merchant_import_rows. NO reference to
--    profiles: who committed is the audit row's actor_id (the phase 8 rule
--    for rep_payout_batches), and a staged owner is re-derived at commit, so
--    owner_id is a display hint with no FK. So no 27th profiles FK and no
--    teardown list changes. RLS on, one admin SELECT policy each, an admin
--    UPDATE policy on batches for Abandon. Grants, after revoking everything:
--      batches  authenticated SELECT + UPDATE (status) only;
--               service_role SELECT, INSERT, UPDATE (stage-merchant-import)
--      rows     authenticated SELECT;
--               service_role SELECT, INSERT, DELETE (re-staging clears first)
--    The batch keeps the uploaded file (source_bytes, at most 2 MiB) so Read
--    again needs no re-upload. A batch moves only review -> abandoned (any
--    admin) or review -> committed (inside the commit, which sets
--    tapswipe.merchant_import_write); nothing changes on a settled batch.
--
-- 3. THE LOCATION EXCEPTION. The file has no address. enforce_merchant_
--    location() still refuses a new merchant without a city and state,
--    EXCEPT an insert with neither, made while tapswipe.merchant_import_write
--    is 'on' -- which only commit_merchant_import() sets, transaction-local,
--    and clears again. Such merchants are the legacy shape the app already
--    handles: /admin/merchants/missing-location and the dashboard notice list
--    them, and the merchant form treats their location as optional. No
--    address is invented. The migration refuses unless the function body is
--    the one it rewrites.
--
-- 4. merchant_import_findings(batch_id) -- the commit's re-derivation, from
--    the staged RAW cells only (never the parser's parsed columns, blockers
--    or notes): type MERCHANT; MID trimmed, 6-20 letters and digits, not a
--    spreadsheet number (mid_source 'unsafe_number', or text in float or
--    exponent form); name required, <= 200; Agent matched to
--    profiles.llc_legal_name (normalised: non-breaking spaces and their
--    mojibake to spaces, ASCII whitespace collapsed, trimmed, lower case) --
--    none, several, inactive, or not an agent each refuse; Split a fraction
--    0-1 or a percentage with %, in hundredths, at most 50, blank = the
--    owner's profile rate (A31); Processor a processors code or label, blank
--    allowed (A6); Status Active or Inactive. A MID repeated in the file
--    (case-insensitive) is ONE merchant when owner, rate and status agree
--    (first non-blank processor, first name) and refuses otherwise, as do
--    two different processors; a MID already on a merchant (case-
--    insensitive) refuses. Internal: no client may call it.
--
-- 5. commit_merchant_import(batch_id_input int) returns jsonb
--    {created, rows, merged}. security definer, search_path public, pg_temp,
--    is_admin() FIRST (PT403), an advisory lock (one import at a time, so two
--    batches naming one MID cannot both pass), the batch FOR UPDATE, review
--    only (PT409), 1 to 2000 rows. Refuses (PT409) if the re-derivation or
--    the staged blockers find anything, listing each code with its rows.
--    Inserts one merchant per MID with no SET of the split guard's flag: an
--    explicit rate is carried by the INSERT (guard_merchant_split_and_owner
--    watches UPDATE only; merchants_split_zero_to_fifty still applies) and a
--    blank one arrives NULL for default_merchant_split() (A31). Every
--    existing merchant trigger fires: one cross_agent_insert audit row per
--    merchant the admin does not own. Then the batch is committed and ONE
--    'commit_merchant_import' audit row records the file name and counts.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Guards: refuse, naming them, only the rows this cannot handle.
-- ---------------------------------------------------------------------
do $$
declare
  clash text;
  body text;
begin
  select string_agg(format('%L (sort order %s)', code, sort_order), ', ' order by code)
    into clash
    from processors
   where (lower(btrim(code)) = '365 pay' or lower(btrim(label)) = '365 pay')
     and not (code = '365 Pay' and label = '365 Pay' and sort_order = 60);
  if clash is not null then
    raise exception 'merchant import migration refuses to run: processors already holds %, which is not the row this migration adds (code ''365 Pay'', label ''365 Pay'', sort order 60). Reconcile it by hand, then re-run.', clash;
  end if;

  select string_agg(quote_literal(code), ', ' order by code)
    into clash
    from processors
   where sort_order = 60 and code <> '365 Pay';
  if clash is not null then
    raise exception 'merchant import migration refuses to run: sort order 60 is already held by processor %. Move it, then re-run.', clash;
  end if;

  select prosrc into body from pg_proc
   where oid = 'public.enforce_merchant_location()'::regprocedure;
  if body is null
     or (length(body) - length(replace(body,
           'if NEW.city is null or NEW.state is null then', '')))
        / length('if NEW.city is null or NEW.state is null then') <> 1 then
    raise exception 'merchant import migration refuses to run: enforce_merchant_location() is not the body this migration rewrites (its INSERT branch must read "if NEW.city is null or NEW.state is null then" exactly once). Inspect it first.';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- 1. The sixth processor.
-- ---------------------------------------------------------------------
insert into processors (code, label, sort_order) values
  ('365 Pay', '365 Pay', 60)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------
-- 2. The staging tables.
-- ---------------------------------------------------------------------
create table merchant_import_batches (
  id serial primary key,
  file_name text not null
    constraint merchant_import_batches_file_name_length
      check (char_length(file_name) between 1 and 200),
  file_kind text not null
    constraint merchant_import_batches_file_kind check (file_kind in ('csv', 'xlsx')),
  -- The file as uploaded, so Read again needs no re-upload. 2 MiB, the
  -- function's own cap.
  source_bytes bytea not null
    constraint merchant_import_batches_source_size
      check (octet_length(source_bytes) between 1 and 2097152),
  status text not null default 'review'
    constraint merchant_import_batches_status
      check (status in ('review', 'committed', 'abandoned')),
  row_count int not null default 0
    constraint merchant_import_batches_row_count check (row_count between 0 and 2000),
  merchant_count int,
  uploaded_at timestamptz not null default now(),
  committed_at timestamptz,
  constraint merchant_import_batches_committed_shape
    check ((status = 'committed') = (committed_at is not null)
           and (status = 'committed') = (merchant_count is not null))
);

-- Step 2 of the four, written although ensure_rls would do it here: the
-- event trigger is skipped where the migration role lacks superuser.
alter table merchant_import_batches enable row level security;

create policy "admin only select" on merchant_import_batches
  for select using (is_admin());
create policy "admin abandons" on merchant_import_batches
  for update using (is_admin()) with check (is_admin());

create table merchant_import_rows (
  id serial primary key,
  batch_id int not null references merchant_import_batches(id) on delete cascade,
  -- The spreadsheet's own row number (the header is row 1).
  row_number int not null constraint merchant_import_rows_row_number check (row_number >= 2),
  -- The cells as read. The commit re-derives everything from these.
  type_raw text,
  mid_raw text,
  -- How the Merchant ID cell arrived: text; a whole number of 15 digits or
  -- fewer from a spreadsheet (leading zeros lost); or a number that may have
  -- lost digits (float, exponent, more than 15 digits), which refuses.
  mid_source text not null default 'text'
    constraint merchant_import_rows_mid_source
      check (mid_source in ('text', 'number', 'unsafe_number')),
  name_raw text,
  split_raw text,
  agent_raw text,
  processor_raw text,
  status_raw text,
  -- The parser's reading, for the review page only.
  mid text,
  name text,
  owner_id uuid,
  rate numeric(5,2),
  processor text,
  status text,
  -- The first row of the same MID, when this row merges into it.
  merged_into int,
  blockers text[] not null default '{}'
    constraint merchant_import_rows_blockers check (blockers <@ array[
      'invalid_type', 'missing_mid', 'invalid_mid', 'mid_precision',
      'missing_name', 'invalid_name',
      'missing_agent', 'unknown_agent', 'ambiguous_agent', 'inactive_agent',
      'agent_not_rep',
      'invalid_split', 'split_above_50',
      'unknown_processor', 'invalid_status',
      'duplicate_mid_conflict', 'duplicate_mid_processor', 'mid_exists'
    ]::text[]),
  notes text[] not null default '{}'
    constraint merchant_import_rows_notes check (notes <@ array[
      'mid_from_number', 'rate_from_profile', 'rate_differs', 'merged',
      'name_differs'
    ]::text[]),
  constraint merchant_import_rows_cell_length check (
    coalesce(char_length(type_raw), 0) <= 1000
    and coalesce(char_length(mid_raw), 0) <= 1000
    and coalesce(char_length(name_raw), 0) <= 1000
    and coalesce(char_length(split_raw), 0) <= 1000
    and coalesce(char_length(agent_raw), 0) <= 1000
    and coalesce(char_length(processor_raw), 0) <= 1000
    and coalesce(char_length(status_raw), 0) <= 1000),
  constraint merchant_import_rows_batch_row unique (batch_id, row_number)
);

alter table merchant_import_rows enable row level security;

create policy "admin only select" on merchant_import_rows
  for select using (is_admin());

-- Nothing is granted by default (20260805210000), and nothing more than
-- this is wanted: revoke first so the grants below are the whole of it.
revoke all on merchant_import_batches from public, anon, authenticated, service_role;
revoke all on merchant_import_rows from public, anon, authenticated, service_role;
revoke all on sequence merchant_import_batches_id_seq from public, anon, authenticated, service_role;
revoke all on sequence merchant_import_rows_id_seq from public, anon, authenticated, service_role;

grant select on merchant_import_batches to authenticated;
-- Abandon is the one client write, and a status is the one column it moves.
grant update (status) on merchant_import_batches to authenticated;
grant select on merchant_import_rows to authenticated;

grant select, insert, update on merchant_import_batches to service_role;
grant select, insert, delete on merchant_import_rows to service_role;
grant usage on sequence merchant_import_batches_id_seq to service_role;
grant usage on sequence merchant_import_rows_id_seq to service_role;

-- A batch is settled once it leaves review; only the commit commits it.
create or replace function guard_merchant_import_batch()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.status <> 'review' then
    raise exception 'This import is % and can no longer change.', old.status
      using errcode = 'PT409';
  end if;

  if new.status is distinct from old.status
     and new.status <> 'abandoned'
     and not (new.status = 'committed'
              and coalesce(current_setting('tapswipe.merchant_import_write', true), '') = 'on') then
    raise exception 'An import is committed only by its Commit button, and can otherwise only be abandoned.'
      using errcode = 'PT409';
  end if;

  return new;
end;
$$;

revoke all on function guard_merchant_import_batch() from public;
revoke all on function guard_merchant_import_batch() from anon, authenticated;

create trigger merchant_import_batches_guard
  before update on merchant_import_batches
  for each row execute function guard_merchant_import_batch();

create index idx_merchant_import_rows_batch on merchant_import_rows(batch_id);

-- ---------------------------------------------------------------------
-- 3. The location exception, for the import's own inserts only.
-- ---------------------------------------------------------------------
create or replace function enforce_merchant_location()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if NEW.city is null or NEW.state is null then
      -- The merchant import (20261106120000): its file has no address, so it
      -- creates merchants with NEITHER, the legacy shape the missing-location
      -- screen lists. Only commit_merchant_import() sets this flag.
      if not (NEW.city is null and NEW.state is null
              and coalesce(current_setting('tapswipe.merchant_import_write', true), '') = 'on') then
        raise exception 'A new merchant needs a city and a two-letter state.'
          using errcode = 'PT422';
      end if;
    end if;
  elsif OLD.city is not null and OLD.state is not null
        and (NEW.city is null or NEW.state is null) then
    raise exception 'A merchant''s city and state can be changed but not removed.'
      using errcode = 'PT422';
  end if;
  -- Shape (2..60 characters, a two-letter code) is merchants_location_format's
  -- job, on every row. This trigger only decides WHETHER one is required.
  return NEW;
end;
$$;

revoke all on function enforce_merchant_location() from public;
revoke all on function enforce_merchant_location() from anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. The re-derivation.
-- ---------------------------------------------------------------------

-- One normal form for every text cell, the parser's normText(): the
-- mojibake pair and non-breaking spaces (and a BOM) become spaces, ASCII
-- whitespace runs collapse, trimmed; '' is NULL.
create or replace function merchant_import_norm(value text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select nullif(btrim(regexp_replace(
           replace(replace(replace(coalesce(value, ''),
             chr(194) || chr(160), ' '), chr(160), ' '), chr(65279), ' '),
           '[ \t\n\r\f\v]+', ' ', 'g')), '');
$$;

revoke all on function merchant_import_norm(text) from public;
revoke all on function merchant_import_norm(text) from anon, authenticated;

create or replace function merchant_import_findings(batch_id_input int)
returns table (
  row_number int,
  mid text,
  mid_key text,
  name text,
  owner_id uuid,
  rate numeric,
  processor text,
  status text,
  is_first boolean,
  blockers text[]
)
language sql
stable
set search_path = public, pg_temp
as $$
  with cells as (
    select r.row_number,
           r.mid_source,
           merchant_import_norm(r.type_raw) as type_text,
           merchant_import_norm(r.mid_raw) as mid_text,
           merchant_import_norm(r.name_raw) as name_text,
           merchant_import_norm(r.split_raw) as split_text,
           lower(merchant_import_norm(r.agent_raw)) as agent_key,
           lower(merchant_import_norm(r.processor_raw)) as processor_key,
           lower(merchant_import_norm(r.status_raw)) as status_key
      from merchant_import_rows r
     where r.batch_id = batch_id_input
  ),
  -- Each lookup normalised once, then joined (a correlated subquery per row
  -- was 27 s for 500 rows under PGlite).
  agent_keys as (
    select lower(merchant_import_norm(p.llc_legal_name)) as k,
           count(*) as n,
           (array_agg(p.id order by p.id))[1] as id
      from profiles p
     where merchant_import_norm(p.llc_legal_name) is not null
     group by 1
  ),
  processor_keys as (
    select distinct on (k) k, code
      from (select lower(merchant_import_norm(pr.code)) as k, pr.code, pr.sort_order from processors pr
            union all
            select lower(merchant_import_norm(pr.label)), pr.code, pr.sort_order from processors pr) named
     order by k, sort_order
  ),
  existing as (
    select distinct upper(merchant_import_norm(m.mid)) as k
      from merchants m
     where merchant_import_norm(m.mid) is not null
  ),
  derived as (
    select c.*,
           case
             when c.mid_source = 'unsafe_number' then 'mid_precision'
             when c.mid_text is null then 'missing_mid'
             when c.mid_text ~ '^[0-9]*\.[0-9]*$'
               or c.mid_text ~* '^[0-9]*\.?[0-9]+e[+-]?[0-9]+$' then 'mid_precision'
             when c.mid_text !~ '^[A-Za-z0-9]{6,20}$' then 'invalid_mid'
           end as mid_problem,
           case
             when c.split_text is null then null
             when c.split_text ~ '^[0-9]+(\.[0-9]+)?( )?%$'
               then rtrim(rtrim(c.split_text, '%'), ' ')::numeric
             when c.split_text ~ '^([01](\.[0-9]+)?|\.[0-9]+)$'
               then case when c.split_text::numeric <= 1
                         then c.split_text::numeric * 100 end
           end as pct,
           coalesce(a.n, 0) as matches,
           a.id as match_id,
           pk.code as processor_code
      from cells c
      left join agent_keys a on a.k = c.agent_key
      left join processor_keys pk on pk.k = c.processor_key
  ),
  owned as (
    select d.*,
           p.is_active as owner_active,
           p.role as owner_role,
           p.split_rate_pct as owner_rate,
           case when d.mid_problem is null then upper(d.mid_text) end as key
      from derived d
      left join profiles p on p.id = d.match_id and d.matches = 1
  ),
  grouped as (
    select o.*,
           coalesce(o.pct, o.owner_rate) as effective_rate,
           min(o.row_number) over (partition by o.key) as first_row,
           first_value(o.processor_code) over (
             partition by o.key
             order by o.processor_code is null, o.row_number) as group_processor
      from owned o
  ),
  groups as (
    select g.key,
           count(distinct coalesce(g.agent_key, '')) > 1
             or count(distinct g.effective_rate) > 1
             or (count(g.effective_rate) > 0 and count(g.effective_rate) < count(*))
             or count(distinct coalesce(g.status_key, '')) > 1 as conflict,
           count(distinct g.processor_code) > 1 as processor_conflict,
           bool_or(e.k is not null) as exists_already
      from grouped g
      left join existing e on e.k = g.key
     where g.key is not null
     group by g.key
  )
  select g.row_number,
         g.mid_text,
         g.key,
         g.name_text,
         case when g.matches = 1 then g.match_id end,
         g.pct,
         case when g.key is not null then g.group_processor else g.processor_code end,
         case g.status_key when 'active' then 'active' when 'inactive' then 'inactive' end,
         g.key is not null and g.row_number = g.first_row,
         array_remove(array[
           case when g.type_text is null or upper(g.type_text) <> 'MERCHANT' then 'invalid_type' end,
           g.mid_problem,
           case when g.name_text is null then 'missing_name'
                when char_length(g.name_text) > 200 then 'invalid_name' end,
           case when g.agent_key is null then 'missing_agent'
                when g.matches = 0 then 'unknown_agent'
                when g.matches > 1 then 'ambiguous_agent'
                when not g.owner_active then 'inactive_agent'
                when g.owner_role <> 'agent' then 'agent_not_rep' end,
           case when g.split_text is null then null
                when g.pct is null or g.pct <> round(g.pct, 2) then 'invalid_split'
                when g.pct > 50 then 'split_above_50' end,
           case when g.processor_key is not null and g.processor_code is null
                then 'unknown_processor' end,
           case when g.status_key is null or g.status_key not in ('active', 'inactive')
                then 'invalid_status' end,
           case when gr.conflict then 'duplicate_mid_conflict' end,
           case when gr.processor_conflict then 'duplicate_mid_processor' end,
           case when gr.exists_already then 'mid_exists' end
         ], null)
    from grouped g
    left join groups gr on gr.key = g.key
   order by g.row_number;
$$;

revoke all on function merchant_import_findings(int) from public;
revoke all on function merchant_import_findings(int) from anon, authenticated;

-- ---------------------------------------------------------------------
-- 5. The commit.
-- ---------------------------------------------------------------------
create or replace function commit_merchant_import(batch_id_input int)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  batch merchant_import_batches;
  row_total int;
  created int;
  problems text;
begin
  if not is_admin() then
    raise exception 'Only an admin can import merchants.'
      using errcode = 'PT403';
  end if;

  -- One merchant import at a time, so two batches naming one MID cannot
  -- both pass the "already a merchant" check.
  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_import'));

  select * into batch from merchant_import_batches
   where id = batch_id_input for update;
  if not found then
    raise exception 'That import does not exist.' using errcode = 'PT404';
  end if;
  if batch.status <> 'review' then
    raise exception 'This import is % and cannot be committed.', batch.status
      using errcode = 'PT409';
  end if;

  select count(*) into row_total from merchant_import_rows where batch_id = batch.id;
  if row_total = 0 then
    raise exception 'This import has no rows to commit.' using errcode = 'PT409';
  end if;
  if row_total > 2000 then
    raise exception 'This import has % rows; at most 2000 can be committed at once.', row_total
      using errcode = 'PT409';
  end if;

  drop table if exists pg_temp.merchant_import_commit;
  create temp table merchant_import_commit on commit drop as
    select * from merchant_import_findings(batch.id);

  -- Every refusal, re-derived above or staged by the parser, by code with
  -- its rows (the first twenty).
  select string_agg(per_code.line, '; ' order by per_code.code)
    into problems
    from (
      select hit.code,
             format('%s (row%s %s%s)', hit.code,
                    case when count(*) = 1 then '' else 's' end,
                    array_to_string((array_agg(hit.rn order by hit.rn))[1:20], ', '),
                    case when count(*) > 20 then format(' and %s more', count(*) - 20) else '' end) as line
        from (
          select b.code, f.row_number as rn
            from merchant_import_commit f, unnest(f.blockers) as b(code)
          union
          select b.code, r.row_number
            from merchant_import_rows r, unnest(r.blockers) as b(code)
           where r.batch_id = batch.id
        ) hit
       group by hit.code
    ) per_code;

  if problems is not null then
    raise exception 'This import cannot be committed: %. Fix the file or the CRM, then Read again.', problems
      using errcode = 'PT409';
  end if;

  perform set_config('tapswipe.merchant_import_write', 'on', true);

  -- One merchant per MID. An explicit rate is carried by the insert; a blank
  -- one arrives NULL/NULL for default_merchant_split() (A31).
  insert into merchants (agent_id, mid, dba, status, processor,
                         split_agent_pct, split_company_pct)
  select f.owner_id, f.mid, f.name, f.status, f.processor,
         f.rate, 100 - f.rate
    from merchant_import_commit f
   where f.is_first
   order by f.row_number;
  get diagnostics created = row_count;

  update merchant_import_batches
     set status = 'committed', committed_at = now(), merchant_count = created
   where id = batch.id;

  perform set_config('tapswipe.merchant_import_write', '', true);

  -- Fails closed: no exception handler.
  insert into audit_log (actor_id, action, table_name, row_id, detail)
  values (auth.uid(), 'commit_merchant_import', 'merchant_import_batches', batch.id::text,
          left(format('%s: %s rows, %s merchants created, %s duplicate rows merged',
                      batch.file_name, row_total, created, row_total - created), 1000));

  drop table if exists pg_temp.merchant_import_commit;

  return jsonb_build_object('created', created, 'rows', row_total,
                            'merged', row_total - created);
end;
$$;

revoke all on function commit_merchant_import(int) from public;
revoke all on function commit_merchant_import(int) from anon;
grant execute on function commit_merchant_import(int) to authenticated, service_role;
