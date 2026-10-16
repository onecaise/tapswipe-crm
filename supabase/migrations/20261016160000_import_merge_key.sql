-- The ledger merge key becomes a partial unique index over import lines;
-- both commit functions and the three share RPCs are re-created to match.
-- Phase 5 of docs/design/residual-splits.md.
--
-- Matches docs/tapswipe_crm_schema.sql, updated first; the block below is
-- copied from it verbatim.
--
-- =====================================================================
-- IMPORT MERGE KEY (20261016160000) — the ledger's merge key becomes a
-- partial unique index over IMPORT lines, so adjustment lines can exist.
-- Phase 5 of docs/design/residual-splits.md, §3.2, §5.1 and §6.
--
-- Until now the merge key was the ordinary `unique (period, agent_id, mid)`,
-- and rep_payout_rows_import_lines_only (20261014150000) refused every
-- adjustment line, because an adjustment posted on a MID that already had an
-- import line in the same month would have collided with it -- or been
-- merged into it by a commit's `on conflict ... do update`. This migration
-- does the three things that must happen together, and drops that constraint
-- in the same transaction; never one without the others:
--
--   1. THE KEY. The constraint rep_payout_rows_period_agent_id_mid_key is
--      dropped and replaced by
--        rep_payout_rows_import_merge_key
--          unique (period, agent_id, mid) where line_kind = 'import'
--      Import lines keep exactly the key they had; adjustment lines are
--      outside it and may share a key with an import line or with each other.
--      Plus idx_rep_payout_rows_period_agent on (period, agent_id): the planner
--      cannot use a partial index for a bare `where period = $1` (it does not
--      imply the predicate), and the old constraint's index served every
--      period page.
--   2. EVERY ON CONFLICT NAMES THE PREDICATE. Postgres infers a partial
--      unique index as an arbiter only when the statement says
--      `on conflict (period, agent_id, mid) where line_kind = 'import'`; with
--      no WHERE the statement fails with "no unique or exclusion constraint
--      matching the ON CONFLICT specification". So both commit functions are
--      re-created with that one change to each target (old: 1, v2: 3) --
--      THE COALESCE and "never the money on conflict" are byte-identical --
--      and the inserted rows are import lines by the column default, so the
--      arbiter can only ever be an import line: a re-import never merges into
--      an adjustment, and nothing can merge an adjustment into an import line.
--   3. EVERY "IS THIS MONTH COMMITTED" READ LOOKS AT IMPORT LINES ONLY. An
--      adjustment sits in a month nobody has committed yet (post_share_
--      correction, 20261016161000), so it must not make that month look
--      committed:
--        * v2's plan: `line_not_shared` asks whether a key of the pair already
--          holds a line that is not this share's. An adjustment on the
--          signer's key (rep_share_id NULL) would have answered yes and
--          skipped the signer row of the very month the correction was posted
--          into. It now asks about import lines only.
--        * set_merchant_rep_share, end_merchant_rep_share and
--          cancel_merchant_rep_share refuse a boundary at or before the MID's
--          latest committed month. Counting an adjustment would refuse the
--          share the correction is posted alongside (design §6: "usually
--          called alongside set_merchant_rep_share"), starting in the very
--          month the correction landed in. Each is re-created with
--          `and line_kind = 'import'` on that read and nothing else.
--
-- Plus one constraint the adjustment line needs now that it can exist:
-- rep_payout_rows_adjustment_no_figures. An adjustment line carries its
-- amount in adjustment_amount and NOTHING in residual_income, rep_split_pct,
-- volume, average_ticket, total_cost or batch_id. Its rep_payout is the
-- amount whatever those say, so a residual or rate on it would be counted
-- in the period's Residual income total while paying nothing, and the
-- grant does let an admin's session write those two columns. It also makes
-- PayoutBulkSplit's period-wide update fail loudly on an adjustment rather
-- than quietly stamp a rate on it -- which is why that component now filters
-- to import lines.
--
-- NOTHING MOVED, OR NOTHING COMMITS. The swap rewrites no row, but the claim
-- is checked rather than assumed: (id, rep_payout, period, agent_id, mid) of
-- every line is copied to a temp table first, and at the end of the file the
-- row count, the payout total and an md5 over every row's five values must
-- match the copy exactly, or the migration raises and everything above rolls
-- back. The message names which check failed, never a figure. The copy is
-- dropped before the end. tests/rls/import-merge-key.test.ts breaks it on
-- purpose three ways -- a row deleted, a payout changed, two MIDs swapped
-- (count and total unchanged) -- and requires the migration to refuse each.
--
-- PRECONDITION: the constraint being dropped must be exactly
-- `UNIQUE (period, agent_id, mid)` under its default name. A hosted project
-- whose key was hand-altered refuses rather than losing something quietly.
-- =====================================================================

-- 0. Precondition, then the copy every existing line is checked against.
do $$
declare
  definition text;
begin
  select pg_get_constraintdef(oid) into definition
    from pg_constraint
   where conrelid = 'public.rep_payout_rows'::regclass
     and conname = 'rep_payout_rows_period_agent_id_mid_key';

  if definition is distinct from 'UNIQUE (period, agent_id, mid)' then
    raise exception 'rep_payout_rows_period_agent_id_mid_key is not UNIQUE (period, agent_id, mid) here (found: %). Inspect it before applying 20261016160000.',
      coalesce(definition, 'no such constraint');
  end if;
end $$;

create temp table rep_payout_merge_key_before on commit drop as
  select id, rep_payout, period, agent_id, mid from rep_payout_rows;

-- 1. The key: a partial unique index over import lines, and a plain index for
-- the period reads the old constraint's index served.
alter table rep_payout_rows
  drop constraint rep_payout_rows_period_agent_id_mid_key;

create unique index rep_payout_rows_import_merge_key
  on rep_payout_rows (period, agent_id, mid)
  where line_kind = 'import';

create index idx_rep_payout_rows_period_agent
  on rep_payout_rows (period, agent_id);

-- 2. Adjustment lines may exist now; an adjustment carries no figures.
alter table rep_payout_rows
  drop constraint rep_payout_rows_import_lines_only;

alter table rep_payout_rows
  add constraint rep_payout_rows_adjustment_no_figures check (
    line_kind = 'import'
    or (residual_income is null and rep_split_pct is null
        and volume is null and average_ticket is null
        and total_cost is null and batch_id is null)
  );

-- 3. Both commit functions, with the predicate on every conflict target and
-- v2's line_not_shared reading import lines only. Otherwise the bodies of
-- 20261016140000 (old) and 20261016120000 (v2), unchanged.

create or replace function commit_residual_import(batch_id_input int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  batch      rep_payout_batches;
  blocked    int;
  staged     int;
  imported   int;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  -- `for update` is load-bearing, not defensive habit. Without it two
  -- concurrent commits of the same batch BOTH observe status = 'review' and
  -- both proceed: the ledger survives (the upsert on (period, agent_id, mid)
  -- makes the insert idempotent) but audit_log gets two rows for one commit,
  -- committed_at is overwritten, and both callers are told they succeeded.
  -- Reproduced deliberately with two overlapping transactions -- 2 audit rows,
  -- both returning 1. The status check below is only a guard if the row it read
  -- cannot change underneath it, so the lock is what makes this function
  -- genuinely idempotent rather than idempotent-if-you-click-slowly.
  select * into batch from rep_payout_batches where id = batch_id_input for update;
  if not found then
    raise exception 'import not found' using errcode = 'PT404';
  end if;

  if batch.status <> 'review' then
    raise exception 'this import is already %', batch.status
      using errcode = 'PT409';
  end if;

  select count(*) into staged
    from rep_payout_import_rows where batch_id = batch_id_input;

  -- Refused rather than treated as a trivial success: flipping a batch to
  -- 'committed' having imported nothing reads as a successful import of an empty
  -- month, which is worse than an error.
  if staged = 0 then
    raise exception 'this import has no rows' using errcode = 'PT409';
  end if;

  select count(*) into blocked
    from rep_payout_import_rows
   where batch_id = batch_id_input and blocker is not null;

  if blocked > 0 then
    raise exception '% of % rows are still blocked', blocked, staged
      using errcode = 'PT409';
  end if;

  -- THE SHARE GUARD (20261016120000), the one addition. Message reworded in
  -- 20261016140000: only an app version older than v2 reaches this.
  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  if exists (
    select 1
      from rep_payout_import_rows r
      join merchants m on m.mid = r.mid_raw
      join merchant_rep_shares s
        on s.merchant_id = m.id
       and r.period >= s.effective_from
       and (s.effective_to is null or r.period < s.effective_to)
     where r.batch_id = batch_id_input
  ) then
    raise exception 'This import contains shared accounts, which this version of the CRM cannot commit. It needs the current version of the app.'
      using errcode = 'PT409';
  end if;

  insert into rep_payout_rows (
    agent_id, period, mid, merchant_name, merchant_id,
    volume, average_ticket, total_cost,
    residual_income, rep_split_pct, batch_id
  )
  select
    r.agent_id, r.period, r.mid_raw, r.merchant_name_raw, r.merchant_id,
    r.volume, r.average_ticket, r.total_cost,
    r.residual_income, r.rep_split_pct, batch_id_input
    from rep_payout_import_rows r
   where r.batch_id = batch_id_input
  on conflict (period, agent_id, mid) where line_kind = 'import' do update set
    merchant_name   = excluded.merchant_name,
    merchant_id     = excluded.merchant_id,
    volume          = excluded.volume,
    average_ticket  = excluded.average_ticket,
    total_cost      = excluded.total_cost,
    -- See THE COALESCE above. Kept, not cleared, unless the file said otherwise.
    residual_income = coalesce(excluded.residual_income,
                               rep_payout_rows.residual_income),
    rep_split_pct   = coalesce(excluded.rep_split_pct,
                               rep_payout_rows.rep_split_pct),
    batch_id        = excluded.batch_id;

  get diagnostics imported = row_count;

  delete from rep_payout_import_rows where batch_id = batch_id_input;

  update rep_payout_batches
     set status = 'committed', committed_at = now(), row_count = staged
   where id = batch_id_input;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'commit_residual_import', 'rep_payout_batches',
          batch_id_input::text);

  return imported;
end;
$$;

revoke all on function commit_residual_import(int) from public;
grant execute on function commit_residual_import(int) to authenticated, service_role;

create or replace function commit_residual_import_v2(batch_id_input int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  batch       rep_payout_batches;
  blocked     int;
  staged      int;
  ordinary    int;
  shared      int;
  skipped     int;
  skip_record jsonb;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  -- The old function's guards, in its order, with its messages.
  select * into batch from rep_payout_batches where id = batch_id_input for update;
  if not found then
    raise exception 'import not found' using errcode = 'PT404';
  end if;

  if batch.status <> 'review' then
    raise exception 'this import is already %', batch.status
      using errcode = 'PT409';
  end if;

  select count(*) into staged
    from rep_payout_import_rows where batch_id = batch_id_input;

  if staged = 0 then
    raise exception 'this import has no rows' using errcode = 'PT409';
  end if;

  select count(*) into blocked
    from rep_payout_import_rows
   where batch_id = batch_id_input and blocker is not null;

  if blocked > 0 then
    raise exception '% of % rows are still blocked', blocked, staged
      using errcode = 'PT409';
  end if;

  -- 1. The share lock, before merchant_rep_shares is read.
  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  -- 2. The plan: every staged row, its share (if one covers it), and what
  -- happens to it. Taken before any write.
  drop table if exists pg_temp.residual_commit_plan;

  create temporary table residual_commit_plan on commit drop as
  select r.id as staging_id,
         r.row_number,
         r.period,
         r.mid_raw,
         r.agent_number_raw,
         s.id as share_id,
         s.secondary_agent_id,
         s.primary_rep_pct,
         s.secondary_rep_pct,
         case
           when s.id is null then 'ordinary'
           when r.agent_id = s.secondary_agent_id then 'partner_named'
           when r.agent_id <> s.primary_agent_id then 'ordinary'
           when exists (
             select 1 from rep_payout_rows l
              where l.period = r.period
                and l.mid = r.mid_raw
                and l.line_kind = 'import'
                and l.agent_id in (s.primary_agent_id, s.secondary_agent_id)
                and (l.rep_share_id is distinct from s.id
                     or l.share_role is distinct from
                        case when l.agent_id = s.primary_agent_id
                             then 'primary' else 'secondary' end)
           ) then 'line_not_shared'
           else 'shared'
         end as plan
    from rep_payout_import_rows r
    left join merchants m on m.mid = r.mid_raw
    left join merchant_rep_shares s
      on s.merchant_id = m.id
     and r.period >= s.effective_from
     and (s.effective_to is null or r.period < s.effective_to)
   where r.batch_id = batch_id_input;

  -- 3. Ordinary rows: the old upsert, with one predicate added.
  insert into rep_payout_rows (
    agent_id, period, mid, merchant_name, merchant_id,
    volume, average_ticket, total_cost,
    residual_income, rep_split_pct, batch_id
  )
  select
    r.agent_id, r.period, r.mid_raw, r.merchant_name_raw, r.merchant_id,
    r.volume, r.average_ticket, r.total_cost,
    r.residual_income, r.rep_split_pct, batch_id_input
    from rep_payout_import_rows r
   where r.batch_id = batch_id_input
     and r.id in (select p.staging_id from pg_temp.residual_commit_plan p
                   where p.plan = 'ordinary')
  on conflict (period, agent_id, mid) where line_kind = 'import' do update set
    merchant_name   = excluded.merchant_name,
    merchant_id     = excluded.merchant_id,
    volume          = excluded.volume,
    average_ticket  = excluded.average_ticket,
    total_cost      = excluded.total_cost,
    -- THE COALESCE. Kept, not cleared, unless the file said otherwise.
    residual_income = coalesce(excluded.residual_income,
                               rep_payout_rows.residual_income),
    rep_split_pct   = coalesce(excluded.rep_split_pct,
                               rep_payout_rows.rep_split_pct),
    batch_id        = excluded.batch_id;

  get diagnostics ordinary = row_count;

  -- 4a. Shared rows, the signer's line. The file's residual and rate are not
  -- read: NULL on insert, and on conflict only the file columns are written.
  insert into rep_payout_rows (
    agent_id, period, mid, merchant_name, merchant_id,
    volume, average_ticket, total_cost,
    residual_income, rep_split_pct, batch_id,
    rep_share_id, share_role, primary_rep_pct, secondary_rep_pct,
    account_residual_income
  )
  select
    r.agent_id, r.period, r.mid_raw, r.merchant_name_raw, r.merchant_id,
    r.volume, r.average_ticket, r.total_cost,
    null, null, batch_id_input,
    p.share_id, 'primary', p.primary_rep_pct, p.secondary_rep_pct,
    null
    from rep_payout_import_rows r
    join pg_temp.residual_commit_plan p on p.staging_id = r.id
   where r.batch_id = batch_id_input
     and p.plan = 'shared'
  on conflict (period, agent_id, mid) where line_kind = 'import' do update set
    -- NEVER THE MONEY ON CONFLICT (design §5.3). File columns only.
    merchant_name   = excluded.merchant_name,
    merchant_id     = excluded.merchant_id,
    volume          = excluded.volume,
    average_ticket  = excluded.average_ticket,
    total_cost      = excluded.total_cost,
    batch_id        = excluded.batch_id;

  get diagnostics shared = row_count;

  -- 4b. The partner's line, from the signer's line as it now stands: on a
  -- first commit that carries no figures; if only the partner's line was
  -- missing, it is rebuilt from the signer's account figure and rate.
  insert into rep_payout_rows (
    agent_id, period, mid, merchant_name, merchant_id,
    volume, average_ticket, total_cost,
    residual_income, rep_split_pct, batch_id,
    rep_share_id, share_role, primary_rep_pct, secondary_rep_pct,
    account_residual_income
  )
  select
    p.secondary_agent_id, sl.period, sl.mid, sl.merchant_name, sl.merchant_id,
    null, null, null,
    shared_part(sl.account_residual_income, sl.secondary_rep_pct,
                sl.primary_rep_pct + sl.secondary_rep_pct),
    sl.rep_split_pct, batch_id_input,
    sl.rep_share_id, 'secondary', sl.primary_rep_pct, sl.secondary_rep_pct,
    sl.account_residual_income
    from pg_temp.residual_commit_plan p
    join rep_payout_import_rows r on r.id = p.staging_id
    join rep_payout_rows sl
      on sl.period = p.period
     and sl.agent_id = r.agent_id
     and sl.mid = p.mid_raw
     and sl.rep_share_id = p.share_id
     and sl.share_role = 'primary'
   where p.plan = 'shared'
  on conflict (period, agent_id, mid) where line_kind = 'import' do nothing;

  -- 5. What was not applied, kept on the batch.
  select count(*),
         coalesce(jsonb_agg(jsonb_build_object(
                    'row_number',   p.row_number,
                    'period',       to_char(p.period, 'YYYY-MM-DD'),
                    'mid',          p.mid_raw,
                    'agent_number', p.agent_number_raw,
                    'reason',       p.plan)
                  order by p.row_number), '[]'::jsonb)
    into skipped, skip_record
    from pg_temp.residual_commit_plan p
   where p.plan in ('partner_named', 'line_not_shared');

  drop table pg_temp.residual_commit_plan;

  -- 6. As the old function: staging delete, status flip, one audit row.
  delete from rep_payout_import_rows where batch_id = batch_id_input;

  update rep_payout_batches
     set status = 'committed', committed_at = now(), row_count = staged,
         skipped_rows = skip_record
   where id = batch_id_input;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'commit_residual_import', 'rep_payout_batches',
          batch_id_input::text);

  return jsonb_build_object('written', ordinary + shared, 'skipped', skipped);
end;
$$;

revoke all on function commit_residual_import_v2(int) from public;
grant execute on function commit_residual_import_v2(int) to authenticated, service_role;

-- 4. The three share RPCs, with their "latest committed month" read
-- restricted to import lines. Otherwise the bodies of 20261014130000,
-- unchanged, comments included.

-- set_merchant_rep_share: start a share from a month. If an open share
-- exists on the merchant and started earlier, it is ended at that month in the
-- same transaction -- so "change the ratio from November" is one call, and the
-- table reads as the history of the account.
create or replace function set_merchant_rep_share(
  merchant_id_input        int,
  primary_agent_id_input   uuid,
  secondary_agent_id_input uuid,
  primary_rep_pct_input    numeric,
  secondary_rep_pct_input  numeric,
  effective_from_input     date
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  m          merchants;
  rep        profiles;
  latest     date;
  open_share merchant_rep_shares;
  new_id     int;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  if merchant_id_input is null or primary_agent_id_input is null
     or secondary_agent_id_input is null or primary_rep_pct_input is null
     or secondary_rep_pct_input is null or effective_from_input is null then
    raise exception 'Every field is required to set a shared account.'
      using errcode = '22023';
  end if;

  select * into m from merchants where id = merchant_id_input;
  if not found then
    raise exception 'merchant not found' using errcode = 'PT404';
  end if;

  if m.mid is null or btrim(m.mid) = '' then
    raise exception 'This merchant has no MID, so no residual could ever match a share on it. Add the MID first.'
      using errcode = 'PT409';
  end if;

  if primary_agent_id_input = secondary_agent_id_input then
    raise exception 'The signer and the partner must be two different reps.'
      using errcode = '22023';
  end if;

  -- Both reps must exist and be active. A NEW share naming someone who has
  -- left is almost certainly a mistake (design §9, Q10); an existing share
  -- keeps paying a rep deactivated later, which is a different question.
  for rep in
    select * from profiles
     where id in (primary_agent_id_input, secondary_agent_id_input)
  loop
    if not rep.is_active then
      raise exception '% is deactivated, so a new share cannot name them.', rep.full_name
        using errcode = 'PT409';
    end if;
  end loop;
  if (select count(*) from profiles
       where id in (primary_agent_id_input, secondary_agent_id_input)) <> 2 then
    raise exception 'rep not found' using errcode = 'PT404';
  end if;

  if primary_rep_pct_input <> round(primary_rep_pct_input, 2)
     or secondary_rep_pct_input <> round(secondary_rep_pct_input, 2)
     or primary_rep_pct_input <= 0 or secondary_rep_pct_input <= 0
     or primary_rep_pct_input + secondary_rep_pct_input <> 50 then
    raise exception 'The two shares must each be above 0, in hundredths at most, and add up to the rep side: 50.'
      using errcode = '22023';
  end if;

  if extract(day from effective_from_input) <> 1 then
    raise exception 'A share starts on the first day of a month.'
      using errcode = '22023';
  end if;

  select max(period) into latest
    from rep_payout_rows
   where (merchant_id = m.id or mid = m.mid)
     and line_kind = 'import';

  if latest is not null and effective_from_input <= latest then
    raise exception '% is already committed for this MID. A share can only start after it; earlier months are corrected with an adjustment.',
      to_char(latest, 'FMMonth YYYY')
      using errcode = 'PT409';
  end if;

  select * into open_share
    from merchant_rep_shares
   where merchant_id = m.id and effective_to is null;

  if found then
    if open_share.effective_from >= effective_from_input then
      raise exception 'This merchant already has a share starting %. Cancel or end that one first.',
        to_char(open_share.effective_from, 'FMMonth YYYY')
        using errcode = 'PT409';
    end if;

    update merchant_rep_shares
       set effective_to = effective_from_input
     where id = open_share.id;

    insert into audit_log (actor_id, action, table_name, row_id)
    values (auth.uid(), 'end_merchant_rep_share', 'merchant_rep_shares',
            open_share.id::text);
  end if;

  -- Overlap with a share that is already closed but runs past the new start
  -- (one ended in the future). The new share is open-ended, so anything
  -- reaching past effective_from_input collides.
  if exists (
    select 1 from merchant_rep_shares
     where merchant_id = m.id
       and daterange(effective_from, effective_to)
           && daterange(effective_from_input, null)
  ) then
    raise exception 'That month overlaps another share on this merchant.'
      using errcode = 'PT409';
  end if;

  insert into merchant_rep_shares (
    merchant_id, primary_agent_id, secondary_agent_id,
    primary_rep_pct, secondary_rep_pct, effective_from
  )
  values (
    m.id, primary_agent_id_input, secondary_agent_id_input,
    primary_rep_pct_input, secondary_rep_pct_input, effective_from_input
  )
  returning id into new_id;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'set_merchant_rep_share', 'merchant_rep_shares',
          new_id::text);

  return new_id;
end;
$$;

revoke all on function set_merchant_rep_share(int, uuid, uuid, numeric, numeric, date)
  from public;
grant execute on function set_merchant_rep_share(int, uuid, uuid, numeric, numeric, date)
  to authenticated, service_role;

-- end_merchant_rep_share: the share stops applying FROM effective_to_input
-- (exclusive). Also moves an existing end, in either direction, provided both
-- the old and the new boundary are still in uncommitted months -- an end that a
-- committed month already sits on is settled.
create or replace function end_merchant_rep_share(
  share_id_input     int,
  effective_to_input date
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s      merchant_rep_shares;
  m      merchants;
  latest date;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  if share_id_input is null or effective_to_input is null then
    raise exception 'A share and an end month are required.'
      using errcode = '22023';
  end if;

  select * into s from merchant_rep_shares where id = share_id_input;
  if not found then
    raise exception 'share not found' using errcode = 'PT404';
  end if;

  if extract(day from effective_to_input) <> 1 then
    raise exception 'A share ends on the first day of a month.'
      using errcode = '22023';
  end if;

  if effective_to_input <= s.effective_from then
    raise exception 'A share has to end after the month it starts. To remove it entirely, cancel it.'
      using errcode = '22023';
  end if;

  select * into m from merchants where id = s.merchant_id;
  select max(period) into latest
    from rep_payout_rows
   where (merchant_id = m.id or mid = m.mid)
     and line_kind = 'import';

  if latest is not null and effective_to_input <= latest then
    raise exception '% is already committed for this MID. A share can only end after it.',
      to_char(latest, 'FMMonth YYYY')
      using errcode = 'PT409';
  end if;

  if latest is not null and s.effective_to is not null and s.effective_to <= latest then
    raise exception 'This share already ended before a committed month, so its end is settled.'
      using errcode = 'PT409';
  end if;

  if exists (
    select 1 from merchant_rep_shares
     where merchant_id = s.merchant_id
       and id <> s.id
       and daterange(effective_from, effective_to)
           && daterange(s.effective_from, effective_to_input)
  ) then
    raise exception 'That end month overlaps another share on this merchant.'
      using errcode = 'PT409';
  end if;

  update merchant_rep_shares
     set effective_to = effective_to_input
   where id = s.id;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'end_merchant_rep_share', 'merchant_rep_shares',
          s.id::text);
end;
$$;

revoke all on function end_merchant_rep_share(int, date) from public;
grant execute on function end_merchant_rep_share(int, date)
  to authenticated, service_role;

-- cancel_merchant_rep_share: deletes a share that was never used -- one with
-- no committed month inside it. Once any month in its range is committed, the
-- share is part of how that month was paid, and the answer is to end it.
-- (Phase 3 adds rep_payout_rows.rep_share_id ON DELETE RESTRICT as the
-- backstop; until then this check is the whole guard, and it is equivalent:
-- a line can only reference a share if its month falls inside it.)
create or replace function cancel_merchant_rep_share(share_id_input int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s      merchant_rep_shares;
  m      merchants;
  latest date;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  select * into s from merchant_rep_shares where id = share_id_input;
  if not found then
    raise exception 'share not found' using errcode = 'PT404';
  end if;

  select * into m from merchants where id = s.merchant_id;
  select max(period) into latest
    from rep_payout_rows
   where (merchant_id = m.id or mid = m.mid)
     and line_kind = 'import';

  if latest is not null and s.effective_from <= latest then
    raise exception 'A month in this share is already committed, so it cannot be cancelled. End it instead.'
      using errcode = 'PT409';
  end if;

  delete from merchant_rep_shares where id = s.id;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'cancel_merchant_rep_share', 'merchant_rep_shares',
          s.id::text);
end;
$$;

revoke all on function cancel_merchant_rep_share(int) from public;
grant execute on function cancel_merchant_rep_share(int)
  to authenticated, service_role;

-- 9. Nothing moved, to the cent and to the key, or nothing commits.
do $$
declare
  before_rows  bigint;
  after_rows   bigint;
  before_total numeric;
  after_total  numeric;
  before_md5   text;
  after_md5    text;
begin
  select count(*), sum(rep_payout),
         md5(coalesce(string_agg(
           id::text || ':' || coalesce(rep_payout::text, 'null') || ':' ||
           period::text || ':' || agent_id::text || ':' || mid,
           ',' order by id), ''))
    into before_rows, before_total, before_md5
    from rep_payout_merge_key_before;

  select count(*), sum(rep_payout),
         md5(coalesce(string_agg(
           id::text || ':' || coalesce(rep_payout::text, 'null') || ':' ||
           period::text || ':' || agent_id::text || ':' || mid,
           ',' order by id), ''))
    into after_rows, after_total, after_md5
    from rep_payout_rows;

  if before_rows is distinct from after_rows
     or before_total is distinct from after_total
     or before_md5 is distinct from after_md5 then
    raise exception 'merge key swap changed existing lines (rows % -> %, total %, per-row checksum %); rolled back',
      before_rows, after_rows,
      case when before_total is not distinct from after_total then 'matches' else 'DIFFERS' end,
      case when before_md5 = after_md5 then 'matches' else 'DIFFERS' end;
  end if;
end $$;

drop table rep_payout_merge_key_before;
