-- Override funding: an override is paid from the owner's side or from the
-- company's share, chosen per override. docs/design/override-funding.md.
--
-- Matches docs/tapswipe_crm_schema.sql, updated first; the block below is
-- copied from it verbatim.
--
-- =====================================================================
-- OVERRIDE FUNDING (20261116120000) — docs/design/override-funding.md.
--
-- An override (20261102120000) is a percent o of a merchant's FULL residual
-- R paid to a named person. It is now paid from one of two places, chosen
-- per override and never inferred:
--   'owner'   out of the owner's rep side (how every override was paid until
--             now): R = $100, rate 50, o = 5 -> recipient 5, owner 45,
--             company 50.
--   'company' out of the company's share: recipient 5, owner the full 50,
--             company 45.
-- Every other override rule holds in both modes: at most the merchant's rate
-- (rate > 0), never paid to the owner or a party of a covering share, no
-- move of the merchant while it is live, one per merchant per month.
--
-- 1. merchant_overrides.funded_by text not null, CHECK in ('owner',
--    'company') (merchant_overrides_funded_by). Existing rows are 'owner',
--    which is how their committed lines were worked out; the DEFAULT used to
--    fill them is dropped in the same migration, so nothing can create an
--    override without saying who pays it. Grants unchanged.
--
-- 2. THE LEDGER. rep_payout_rows.override_funded_by: the funding AS AT
--    COMMIT, snapshotted on every override line like override_amount, so a
--    committed month never depends on the override's current state. Existing
--    override lines are filled with 'owner' after this migration proves that
--    to be true: every (batch, override) among them has exactly one credit
--    and at least one debit, and the debits total minus the credit. Then,
--    added VALIDATED so every existing row is checked:
--      * rep_payout_rows_override_columns (rewritten): override_id,
--        override_role, override_amount and override_funded_by are set
--        together, on override lines only (plus processor, no share, as
--        before);
--      * rep_payout_rows_override_funded_by: 'owner' or 'company';
--      * rep_payout_rows_company_override_no_debit: a company-funded override
--        has no debit line. A CHECK sees one row, so "an owner-funded
--        override's debits total minus its credit" stays the commit's, pinned
--        by the tests.
--    The generated rep_payout is NOT touched (the override branch is still
--    override_amount). Nothing else moves: the count, total and per-row md5
--    of rep_payout are compared before and after the backfill.
--
-- 3. COMMIT V3 STEP 6. X = round(R * o / 100, 2), once, from the account
--    residual, as before.
--      owner-funded:   the owner's debit -X (shared: the partner's piece
--                      shared_part(X, b, a + b), the signer the rest) and the
--                      recipient's credit +X. Unchanged.
--      company-funded: the recipient's credit +X ONLY. No debit, to anyone:
--                      the owner (or the shared pair) keeps T, the company
--                      keeps R - T - X.
--    Every override line carries override_funded_by = the override's
--    funded_by at commit. owner + override + company = R to the cent in both
--    modes. The result gains company_overrides (credits written for
--    company-funded overrides); overrides still counts every credit. Its
--    cap backstop says "cannot be more than the merchant's rate", no longer
--    "comes out of the rep side". Otherwise the body of 20261111120000.
--    guard_merchant_split_and_owner still refuses moving a merchant with a
--    live override, in both modes; its message no longer says the override
--    comes out of the owner's side.
--
-- 4. set_merchant_override(merchant, recipient, pct, from, funded_by_input)
--    takes the funding as a REQUIRED fifth argument (NULL is 22023 with
--    "every field is required"; anything but 'owner' or 'company' is 22023).
--    The four-argument function is DROPPED here, so no caller can create an
--    override of undeclared funding through an overload. "Change" (a later
--    start ending the open override) takes the funding passed, never the old
--    one's. Its audit row's detail is 'funded_by=<value>'. Otherwise the body
--    of 20261102120000.
--
-- 5. set_merchant_override_funding(override_id, funded_by, reason) — the
--    ONLY way to change funded_by after creation. security definer, is_admin()
--    first, search_path pinned. Takes the residual-month lock of every
--    committed processor-month the override's lines are in (its "touched
--    months"), sorted, then the share lock, in commit v3's order, and refuses
--    if that set grew meanwhile. Refuses (PT409, naming them) while any
--    touched month is marked paid: reopen it first. A reason of 10-500
--    characters is required. Switching to 'owner' re-checks what owner
--    funding needs against the merchant as it is now (a rate above 0 and at
--    least the percent; the recipient not the owner, nor a party of an
--    overlapping share). The same value as now changes nothing and writes
--    nothing. One audit row, 'set_override_funding', detail '<old> -> <new>;
--    replace: <months>; reason: <reason>', no exception handler. It never
--    touches rep_payout_rows: a committed month picks the change up only by a
--    REPLACE, whose step 6 writes the lines again from the override as it is.
--
-- 6. override_funding_pending() — admin only (PT403), security INVOKER: the
--    committed processor-months whose override lines' override_funded_by
--    disagrees with their override's funded_by now, with the batch and the
--    number of overrides. These are the months to replace.
--
-- 7. close_payout_period refuses (PT409) to mark a processor-month paid
--    while it is in override_funding_pending(): replace it first. Otherwise
--    the body of 20261030190000.
--
-- 8. merchant_processor_summary (Report 2) gains company_overrides, the
--    MID's committed company-funded credits in the processor-month, and
--    company_share becomes residual - rep_side - company_overrides. So each
--    row reads residual = rep side + overrides from company + company share.
--    An owner-funded override moves money inside the rep side and does not
--    appear. A change of return type, so the function is dropped and created
--    again: still security invoker, is_admin() first, search_path pinned.
--    rep_payout_summary (Report 1) needs no change: a company-funded override
--    has no debit, so the owner's split is the full T.
--
-- Every new or re-created function carries its own revoke/grant lines; anon
-- has EXECUTE on none.
--
-- REFUSES TO RUN, naming what it found, unless rep_payout_rows_override_
-- columns is the 20261102120000 CHECK, commit v3 is the 20261111120000 body
-- (its step-6 lines, each exactly once), the four-argument
-- set_merchant_override exists, and every existing override pair is a true
-- owner-funded pair.
-- =====================================================================

-- 0. The definitions this migration rewrites, and the ledger it backfills.
do $$
declare
  definition text;
  v3         text := pg_get_functiondef('public.commit_residual_import_v3(int, text[])'::regprocedure);
  fragment   text;
  bad        text;
begin
  select pg_get_constraintdef(oid) into definition from pg_constraint
   where conrelid = 'public.rep_payout_rows'::regclass
     and conname = 'rep_payout_rows_override_columns';
  if definition is distinct from 'CHECK ((((line_kind <> ''override''::text) AND (override_id IS NULL) AND (override_role IS NULL) AND (override_amount IS NULL)) OR ((line_kind = ''override''::text) AND (override_id IS NOT NULL) AND (override_role IS NOT NULL) AND (override_amount IS NOT NULL) AND (processor IS NOT NULL) AND (rep_share_id IS NULL))))' then
    raise exception 'rep_payout_rows_override_columns is not the 20261102120000 CHECK here (found: %). Inspect it before applying 20261116120000.',
      coalesce(definition, 'no such constraint');
  end if;

  foreach fragment in array array[
    'case when a.secondary_agent_id is null then 0',
    'where secondary_agent_id is not null',
    'batch_id, line_kind, override_id, override_role, override_amount',
    '''overrides'', overrides,'
  ] loop
    if (length(v3) - length(replace(v3, fragment, ''))) / length(fragment) <> 1 then
      raise exception 'commit_residual_import_v3 is not the 20261111120000 body here (its step-6 line "%" is not there exactly once). Inspect pg_get_functiondef before applying 20261116120000.',
        fragment;
    end if;
  end loop;

  if to_regprocedure('public.set_merchant_override(int, uuid, numeric, date)') is null then
    raise exception 'set_merchant_override(int, uuid, numeric, date) is not here. Inspect it before applying 20261116120000.';
  end if;

  -- The backfill writes 'owner' on every existing override line. That is
  -- true only if each (batch, override) is an owner-funded pair: one credit,
  -- at least one debit, the debits totalling minus the credit.
  select string_agg(format('batch %s / override %s', p.batch_id, p.override_id), ', '
                    order by p.batch_id, p.override_id)
    into bad
    from (select batch_id, override_id,
                 count(*) filter (where override_role = 'credit') as credits,
                 count(*) filter (where override_role = 'debit') as debits,
                 coalesce(sum(override_amount) filter (where override_role = 'credit'), 0) as credit,
                 coalesce(sum(override_amount) filter (where override_role = 'debit'), 0) as debit
            from rep_payout_rows
           where line_kind = 'override'
           group by batch_id, override_id) p
   where p.credits <> 1 or p.debits < 1 or p.debit <> -p.credit;
  if bad is not null then
    raise exception 'Override lines that are not an owner-funded pair (one credit, debits totalling minus it): %. They cannot be marked owner-funded; inspect them before applying 20261116120000.',
      bad;
  end if;
end $$;

-- 1. merchant_overrides.funded_by.
alter table merchant_overrides
  add column funded_by text not null default 'owner'
    constraint merchant_overrides_funded_by check (funded_by in ('owner', 'company'));
alter table merchant_overrides alter column funded_by drop default;

-- 2. The ledger snapshot, backfilled, then the CHECKs.
create temp table rep_payout_funding_before on commit drop as
  select id, rep_payout from rep_payout_rows;

alter table rep_payout_rows add column override_funded_by text;

update rep_payout_rows
   set override_funded_by = 'owner'
 where line_kind = 'override';

do $$
declare
  missing  bigint;
  stray    bigint;
begin
  select count(*) into missing from rep_payout_rows
   where line_kind = 'override' and override_funded_by is null;
  select count(*) into stray from rep_payout_rows
   where line_kind <> 'override' and override_funded_by is not null;
  if missing <> 0 or stray <> 0 then
    raise exception 'override_funded_by backfill is wrong (% override lines without it, % other lines with it); rolled back',
      missing, stray;
  end if;
end $$;

alter table rep_payout_rows drop constraint rep_payout_rows_override_columns;
alter table rep_payout_rows
  add constraint rep_payout_rows_override_columns check (
    (line_kind <> 'override' and override_id is null and override_role is null
     and override_amount is null and override_funded_by is null)
    or (line_kind = 'override' and override_id is not null
        and override_role is not null and override_amount is not null
        and override_funded_by is not null
        and processor is not null and rep_share_id is null)
  );

alter table rep_payout_rows
  add constraint rep_payout_rows_override_funded_by
    check (override_funded_by is null or override_funded_by in ('owner', 'company'));

-- A company-funded override is the recipient's credit only.
alter table rep_payout_rows
  add constraint rep_payout_rows_company_override_no_debit
    check (not (override_funded_by = 'company' and override_role = 'debit'));

-- Nothing moved, to the cent, or nothing commits.
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
         md5(coalesce(string_agg(id::text || ':' || coalesce(rep_payout::text, 'null'),
                                 ',' order by id), ''))
    into before_rows, before_total, before_md5
    from rep_payout_funding_before;

  select count(*), sum(rep_payout),
         md5(coalesce(string_agg(id::text || ':' || coalesce(rep_payout::text, 'null'),
                                 ',' order by id), ''))
    into after_rows, after_total, after_md5
    from rep_payout_rows;

  if before_rows is distinct from after_rows
     or before_total is distinct from after_total
     or before_md5 is distinct from after_md5 then
    raise exception 'override_funded_by backfill changed existing payouts (rows % -> %, total %, per-row checksum %); rolled back',
      before_rows, after_rows,
      case when before_total is not distinct from after_total then 'matches' else 'DIFFERS' end,
      case when before_md5 = after_md5 then 'matches' else 'DIFFERS' end;
  end if;
end $$;

drop table rep_payout_funding_before;

-- 3. Commit v3: step 6 writes the debits for owner-funded overrides only,
-- and every override line carries its funding. Otherwise the body of
-- 20261111120000.
create or replace function commit_residual_import_v3(
  batch_id_input  int,
  confirmed_input text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  batch       rep_payout_batches;
  confirmed   text[] := coalesce(confirmed_input, '{}');
  other       rep_payout_batches;
  replaced    rep_payout_batches;
  staged      int;
  blocked     int;
  problem     text;
  unconfirmed text[];
  covered     jsonb;
  unshared    int;
  signers     int;
  partners    int;
  overrides   int := 0;
  company_overrides int := 0;
  removed     int := 0;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  if exists (select 1 from unnest(confirmed) as c(code)
              where c.code is null
                 or c.code not in ('processor_mismatch', 'inactive_merchant',
                                   'bad_numbers', 'other_income_type')) then
    raise exception 'Only processor_mismatch, inactive_merchant, bad_numbers and other_income_type can be confirmed.'
      using errcode = '22023';
  end if;

  -- 1-2. Locks and guards.
  select * into batch from rep_payout_batches where id = batch_id_input for update;
  if not found then
    raise exception 'import not found' using errcode = 'PT404';
  end if;

  if batch.status <> 'review' then
    raise exception 'this import is already %', batch.status
      using errcode = 'PT409';
  end if;

  if batch.processor is null or batch.period is null then
    raise exception 'This import was started before the processor and month were chosen at upload, so it cannot be committed. Abandon it and upload the file again.'
      using errcode = 'PT409';
  end if;

  -- One committed batch per processor-month, without a race between two
  -- different batches for the same pair.
  perform pg_advisory_xact_lock(hashtext(
    'tapswipe.residual_month:' || batch.processor || '/' || batch.period::text));

  -- A replacement: the batch it replaces must still be the committed one for
  -- this processor-month, and the month must not be marked paid.
  if batch.replaces_batch_id is not null then
    select * into replaced
      from rep_payout_batches where id = batch.replaces_batch_id for update;
    if not found or replaced.status <> 'committed'
       or replaced.processor is distinct from batch.processor
       or replaced.period is distinct from batch.period then
      raise exception 'This file was uploaded to replace import #%, which is no longer the committed import for % for %. Abandon it and upload the file again.',
        batch.replaces_batch_id, batch.processor, to_char(batch.period, 'FMMonth YYYY')
        using errcode = 'PT409';
    end if;

    if exists (select 1 from payout_period_closures
                where period = batch.period and processor = batch.processor) then
      raise exception '% for % is marked paid and cannot be replaced. Reopen it (with a reason), or post an adjustment instead.',
        batch.processor, to_char(batch.period, 'FMMonth YYYY')
        using errcode = 'PT409';
    end if;
  end if;

  select * into other
    from rep_payout_batches
   where processor = batch.processor and period = batch.period
     and status = 'committed' and id <> batch.id
     and id is distinct from batch.replaces_batch_id;
  if found then
    raise exception '% for % is already committed (import #%). A second file for that month replaces it: upload it again and answer Yes to replace.',
      batch.processor, to_char(batch.period, 'FMMonth YYYY'), other.id
      using errcode = 'PT409';
  end if;

  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  -- A replacement may not pull the month out from under an adjustment that
  -- was worked out from the figures it replaces.
  if batch.replaces_batch_id is not null then
    select string_agg(distinct a.mid, ', ') into problem
      from rep_payout_rows a
     where a.line_kind = 'adjustment' and a.adjusts_period = batch.period
       and (a.processor = batch.processor
            or mid_key(a.mid) in (select mid_key(l.mid) from rep_payout_rows l
                          where l.batch_id = replaced.id));
    if problem is not null then
      raise exception 'Adjustments already correct % for % (MIDs %). They were worked out from the committed figures, so the month cannot be replaced under them.',
        batch.processor, to_char(batch.period, 'FMMonth YYYY'), problem
        using errcode = 'PT409';
    end if;
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

  -- No owner, MID or rate of a merchant in this file changes until commit.
  perform 1 from merchants m
   where mid_key(m.mid) in (select mid_key(r.mid_raw) from rep_payout_import_rows r
                    where r.batch_id = batch_id_input)
   for share;

  -- 3. Re-derived from the database.
  select string_agg(r.row_number::text, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
   where r.batch_id = batch_id_input and r.period is distinct from batch.period;
  if problem is not null then
    raise exception 'Rows % were read for a different month than this import''s (%). Read the file again.',
      problem, to_char(batch.period, 'FMMonth YYYY')
      using errcode = 'PT409';
  end if;

  select string_agg(r.row_number::text, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
   where r.batch_id = batch_id_input
     and (r.mid_raw is null or btrim(r.mid_raw) = '');
  if problem is not null then
    raise exception 'Rows % have no MID. Fix the file and upload it again.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(d.spellings || ' (rows ' || d.row_list || ')', '; ' order by d.k)
    into problem
    from (select mid_key(r.mid_raw) as k,
                 string_agg(distinct r.mid_raw, ' / ') as spellings,
                 string_agg(r.row_number::text, ', ' order by r.row_number) as row_list
            from rep_payout_import_rows r
           where r.batch_id = batch_id_input
           group by mid_key(r.mid_raw)
          having count(*) > 1) d;
  if problem is not null then
    raise exception 'A MID appears on more than one row: %. Fix the file and upload it again.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(r.mid_raw, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
   where r.batch_id = batch_id_input
     and not exists (select 1 from merchants m where mid_key(m.mid) = mid_key(r.mid_raw));
  if problem is not null then
    raise exception 'MIDs % are not merchants in the CRM. Add them (or correct their MID), then read the file again.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(r.row_number::text, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
   where r.batch_id = batch_id_input
     and (r.volume is null or r.residual_income is null);
  if problem is not null then
    raise exception 'Rows % have no Volume or no Residual. Fix the file and upload it again.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(r.mid_raw, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
    join merchants m on mid_key(m.mid) = mid_key(r.mid_raw)
   where r.batch_id = batch_id_input
     and (r.merchant_id is distinct from m.id
          or r.agent_id is distinct from m.agent_id);
  if problem is not null then
    raise exception 'A merchant''s MID or owner changed after this file was read (MIDs %). Read it again.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(r.mid_raw, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
    join merchants m on mid_key(m.mid) = mid_key(r.mid_raw)
   where r.batch_id = batch_id_input and m.split_agent_pct is null;
  if problem is not null then
    raise exception 'MIDs % belong to merchants with no split rate. Set each merchant''s rate, then commit.', problem
      using errcode = 'PT409';
  end if;

  -- No merge. On a replacement, the lines of the batch being replaced are
  -- about to go, so they are not "already there".
  select string_agg(distinct r.mid_raw, ', ') into problem
    from rep_payout_import_rows r
    join rep_payout_rows l
      on mid_key(l.mid) = mid_key(r.mid_raw) and l.period = batch.period and l.line_kind = 'import'
   where r.batch_id = batch_id_input
     and (batch.replaces_batch_id is null
          or l.batch_id is distinct from batch.replaces_batch_id);
  if problem is not null then
    raise exception 'MIDs % already have a line for %. A committed month is never merged into: read the file again.',
      problem, to_char(batch.period, 'FMMonth YYYY')
      using errcode = 'PT409';
  end if;

  select string_agg(r.mid_raw, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
    join merchants m on mid_key(m.mid) = mid_key(r.mid_raw)
    join merchant_rep_shares s
      on s.merchant_id = m.id
     and batch.period >= s.effective_from
     and (s.effective_to is null or batch.period < s.effective_to)
   where r.batch_id = batch_id_input
     and (s.primary_agent_id <> m.agent_id
          or s.primary_rep_pct + s.secondary_rep_pct <> m.split_agent_pct);
  if problem is not null then
    raise exception 'MIDs % have a shared-account split whose signer is not the merchant''s owner, or whose shares do not total the merchant''s rate. End the share and set it again, then commit.', problem
      using errcode = 'PT409';
  end if;

  -- Overrides in force for the month (phase 10). The functions that set
  -- them hold these rules; a rate, an owner, a share or a person can change
  -- after that, so the commit checks them again.
  select string_agg(r.mid_raw || ' (override #' || o.id || ')', ', ' order by r.row_number)
    into problem
    from rep_payout_import_rows r
    join merchants m on mid_key(m.mid) = mid_key(r.mid_raw)
    join merchant_overrides o
      on o.merchant_id = m.id
     and batch.period >= o.effective_from
     and (o.effective_to is null or batch.period < o.effective_to)
   where r.batch_id = batch_id_input
     and o.override_pct > m.split_agent_pct;
  if problem is not null then
    raise exception 'MIDs % have an override above the merchant''s rate. An override cannot be more than the merchant''s rate: end or change it, then commit.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(r.mid_raw || ' (override #' || o.id || ')', ', ' order by r.row_number)
    into problem
    from rep_payout_import_rows r
    join merchants m on mid_key(m.mid) = mid_key(r.mid_raw)
    join merchant_overrides o
      on o.merchant_id = m.id
     and batch.period >= o.effective_from
     and (o.effective_to is null or batch.period < o.effective_to)
   where r.batch_id = batch_id_input
     and (o.recipient_id = m.agent_id
          or exists (select 1 from merchant_rep_shares s
                      where s.merchant_id = m.id
                        and batch.period >= s.effective_from
                        and (s.effective_to is null or batch.period < s.effective_to)
                        and o.recipient_id in (s.primary_agent_id, s.secondary_agent_id)));
  if problem is not null then
    raise exception 'MIDs % have an override paid to the merchant''s owner or to a party of its shared account. End the override and set it again, then commit.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(r.mid_raw || ' (override #' || o.id || ' to ' || p.full_name || ')', ', '
                    order by r.row_number)
    into problem
    from rep_payout_import_rows r
    join merchants m on mid_key(m.mid) = mid_key(r.mid_raw)
    join merchant_overrides o
      on o.merchant_id = m.id
     and batch.period >= o.effective_from
     and (o.effective_to is null or batch.period < o.effective_to)
    join profiles p on p.id = o.recipient_id
   where r.batch_id = batch_id_input
     and not p.is_active;
  if problem is not null then
    raise exception 'Overrides on MIDs % pay someone who is deactivated. End each override (or reactivate the person), then commit.', problem
      using errcode = 'PT409';
  end if;

  -- 4. The warnings, recomputed: the parser's rowWarnings().
  with flagged as (
    select r.row_number, w.code
      from rep_payout_import_rows r
      join merchants m on mid_key(m.mid) = mid_key(r.mid_raw)
      cross join lateral (values
        ('processor_mismatch',
         (processor_key(r.processor_raw) is not null
          and processor_key(r.processor_raw) is distinct from processor_key(batch.processor))
         or (m.processor is not null
             and processor_key(m.processor) is distinct from processor_key(batch.processor))),
        ('inactive_merchant', m.status = 'inactive'),
        ('bad_numbers', r.volume < 0 or (r.volume > 0 and r.residual_income > r.volume)),
        ('other_income_type',
         regexp_replace(lower(coalesce(r.income_type_raw, '')), '[^a-z0-9]', '', 'g')
           not in ('', 'residual', 'residuals'))
      ) as w(code, hit)
     where r.batch_id = batch_id_input and w.hit
  )
  select jsonb_object_agg(f.code, f.row_list),
         array_agg(f.code order by f.code)
           filter (where not (f.code = any(confirmed)))
    into covered, unconfirmed
    from (select code, jsonb_agg(row_number order by row_number) as row_list
            from flagged group by code) f;

  if cardinality(unconfirmed) > 0 then
    select string_agg(replace(u.code, '_', ' ') || ' (rows '
                      || (select string_agg(x.value, ', ')
                            from jsonb_array_elements_text(covered -> u.code) as x(value))
                      || ')', '; ' order by u.code)
      into problem
      from unnest(unconfirmed) as u(code);
    raise exception 'These warnings were not confirmed: %. Confirm them on the review screen, or fix the data and read the file again.', problem
      using errcode = 'PT409',
            detail = array_to_string(unconfirmed, ',');
  end if;

  -- 5. The replace, then the lines. Every refusal is behind us: from here
  -- on, the commit writes.
  if batch.replaces_batch_id is not null then
    -- The old batch's lines: its import lines, the shared lines derived from
    -- them, and its override lines, which step 6 writes again. Adjustments
    -- carry no batch and stay.
    delete from rep_payout_rows where batch_id = replaced.id;
    get diagnostics removed = row_count;

    update rep_payout_batches
       set status = 'replaced', replaced_by_batch_id = batch_id_input
     where id = replaced.id;
  end if;

  -- Plain inserts, never a merge.
  -- Unshared: the owner's one line at the merchant's rate.
  insert into rep_payout_rows (
    agent_id, period, processor, mid, merchant_name, merchant_id,
    volume, average_ticket, total_cost, volume_confirmed_negative,
    residual_income, rep_split_pct, batch_id
  )
  select
    m.agent_id, batch.period, batch.processor, m.mid,
    coalesce(m.dba, r.merchant_name_raw), m.id,
    r.volume, r.average_ticket, r.total_cost, r.volume < 0,
    r.residual_income, m.split_agent_pct, batch_id_input
    from rep_payout_import_rows r
    join merchants m on mid_key(m.mid) = mid_key(r.mid_raw)
   where r.batch_id = batch_id_input
     and not exists (
       select 1 from merchant_rep_shares s
        where s.merchant_id = m.id
          and batch.period >= s.effective_from
          and (s.effective_to is null or batch.period < s.effective_to));

  get diagnostics unshared = row_count;

  -- Shared, the signer's line: the volume, and the account residual less the
  -- partner's piece.
  insert into rep_payout_rows (
    agent_id, period, processor, mid, merchant_name, merchant_id,
    volume, average_ticket, total_cost, volume_confirmed_negative,
    residual_income, rep_split_pct, batch_id,
    rep_share_id, share_role, primary_rep_pct, secondary_rep_pct,
    account_residual_income
  )
  select
    m.agent_id, batch.period, batch.processor, m.mid,
    coalesce(m.dba, r.merchant_name_raw), m.id,
    r.volume, r.average_ticket, r.total_cost, r.volume < 0,
    r.residual_income
      - shared_part(r.residual_income, s.secondary_rep_pct,
                    s.primary_rep_pct + s.secondary_rep_pct),
    m.split_agent_pct, batch_id_input,
    s.id, 'primary', s.primary_rep_pct, s.secondary_rep_pct,
    r.residual_income
    from rep_payout_import_rows r
    join merchants m on mid_key(m.mid) = mid_key(r.mid_raw)
    join merchant_rep_shares s
      on s.merchant_id = m.id
     and batch.period >= s.effective_from
     and (s.effective_to is null or batch.period < s.effective_to)
   where r.batch_id = batch_id_input;

  get diagnostics signers = row_count;

  -- Shared, the partner's line: no volume (it is counted once, on the
  -- signer's line), the partner's piece of the residual.
  insert into rep_payout_rows (
    agent_id, period, processor, mid, merchant_name, merchant_id,
    volume, average_ticket, total_cost,
    residual_income, rep_split_pct, batch_id,
    rep_share_id, share_role, primary_rep_pct, secondary_rep_pct,
    account_residual_income
  )
  select
    s.secondary_agent_id, batch.period, batch.processor, m.mid,
    coalesce(m.dba, r.merchant_name_raw), m.id,
    null, null, null,
    shared_part(r.residual_income, s.secondary_rep_pct,
                s.primary_rep_pct + s.secondary_rep_pct),
    m.split_agent_pct, batch_id_input,
    s.id, 'secondary', s.primary_rep_pct, s.secondary_rep_pct,
    r.residual_income
    from rep_payout_import_rows r
    join merchants m on mid_key(m.mid) = mid_key(r.mid_raw)
    join merchant_rep_shares s
      on s.merchant_id = m.id
     and batch.period >= s.effective_from
     and (s.effective_to is null or batch.period < s.effective_to)
   where r.batch_id = batch_id_input;

  get diagnostics partners = row_count;

  -- 6. The override lines (phase 10; funding, 20261116120000). X = round(R *
  -- o / 100, 2), once, from the account residual. An OWNER-funded override:
  -- on a shared account the partner's piece of the deduction is
  -- shared_part(X, b, a + b) and the signer's the rest (the payout's own cent
  -- rule); debits -piece, the credit +X; they net to zero, and the reps' nets
  -- plus the credit are exactly T. A COMPANY-funded override: the credit +X
  -- only, no debit to anyone; the reps keep T and the company R - T - X.
  -- Every line carries the override's funding at commit. On a replacement
  -- this is what rebuilds them, from the override as it is now.
  with applied as (
    select m.id as merchant_id, m.agent_id as owner_id, m.mid,
           coalesce(m.dba, r.merchant_name_raw) as merchant_name,
           o.id as override_id, o.recipient_id, o.funded_by,
           round(r.residual_income * o.override_pct / 100, 2) as x,
           s.secondary_agent_id, s.primary_rep_pct, s.secondary_rep_pct
      from rep_payout_import_rows r
      join merchants m on mid_key(m.mid) = mid_key(r.mid_raw)
      join merchant_overrides o
        on o.merchant_id = m.id
       and batch.period >= o.effective_from
       and (o.effective_to is null or batch.period < o.effective_to)
      left join merchant_rep_shares s
        on s.merchant_id = m.id
       and batch.period >= s.effective_from
       and (s.effective_to is null or batch.period < s.effective_to)
     where r.batch_id = batch_id_input
  ),
  pieces as (
    select a.*,
           case when a.funded_by <> 'owner' or a.secondary_agent_id is null then 0
                else shared_part(a.x, a.secondary_rep_pct,
                                 a.primary_rep_pct + a.secondary_rep_pct)
           end as partner_piece
      from applied a
  ),
  lines as (
    select owner_id as agent_id, merchant_id, mid, merchant_name, override_id, funded_by,
           'debit' as role, -(x - partner_piece) as amount
      from pieces
     where funded_by = 'owner'
    union all
    select secondary_agent_id, merchant_id, mid, merchant_name, override_id, funded_by,
           'debit', -partner_piece
      from pieces
     where funded_by = 'owner' and secondary_agent_id is not null
    union all
    select recipient_id, merchant_id, mid, merchant_name, override_id, funded_by,
           'credit', x
      from pieces
  )
  insert into rep_payout_rows (
    agent_id, period, processor, mid, merchant_name, merchant_id,
    batch_id, line_kind, override_id, override_role, override_amount,
    override_funded_by
  )
  select
    l.agent_id, batch.period, batch.processor, l.mid, l.merchant_name, l.merchant_id,
    batch_id_input, 'override', l.override_id, l.role, l.amount, l.funded_by
    from lines l;

  select count(*),
         count(*) filter (where override_funded_by = 'company')
    into overrides, company_overrides
    from rep_payout_rows
   where batch_id = batch_id_input and line_kind = 'override'
     and override_role = 'credit';

  -- 7. Close the batch, and the audit rows.
  delete from rep_payout_import_rows where batch_id = batch_id_input;

  update rep_payout_batches
     set status = 'committed', committed_at = now(), row_count = staged,
         confirmed_warnings = coalesce(covered, '{}'::jsonb)
   where id = batch_id_input;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'commit_residual_import', 'rep_payout_batches',
          batch_id_input::text);

  if batch.replaces_batch_id is not null then
    insert into audit_log (actor_id, action, table_name, row_id)
    values (auth.uid(), 'replace_residual_import', 'rep_payout_batches',
            replaced.id::text);
  end if;

  return jsonb_build_object(
    'written', unshared + signers + partners,
    'rows', staged,
    'shared', signers,
    'overrides', overrides,
    'company_overrides', company_overrides,
    'replaced_lines', removed
  );
end;
$$;

-- PUBLIC (which includes anon) gets EXECUTE on every new function and nothing
-- declarative revokes it. Re-stated: create or replace keeps the existing ACL,
-- but these lines are what the grants test reads.
revoke all on function commit_residual_import_v3(int, text[]) from public;
revoke all on function commit_residual_import_v3(int, text[]) from anon;
grant execute on function commit_residual_import_v3(int, text[]) to authenticated, service_role;

-- 3b. Moving a merchant is still refused while it has a live override, in
-- both modes (design D2); the message no longer says it comes out of the
-- owner's side, which a company-funded one does not. Otherwise the body of
-- 20261102120000.
create or replace function guard_merchant_split_and_owner()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (new.split_agent_pct is distinct from old.split_agent_pct
      or new.split_company_pct is distinct from old.split_company_pct)
     and coalesce(current_setting('tapswipe.merchant_split_write', true), '') <> 'on' then
    raise exception 'A merchant''s split rate is changed only with its Split control (set_merchant_split), which records who changed it.'
      using errcode = 'PT409';
  end if;

  if new.agent_id is distinct from old.agent_id
     and merchant_has_live_share(old.id) then
    raise exception 'This merchant has a shared-account split. End it before moving the merchant.'
      using errcode = 'PT409';
  end if;

  if new.agent_id is distinct from old.agent_id
     and merchant_has_live_override(old.id) then
    raise exception 'This merchant has an override. End it before moving the merchant.'
      using errcode = 'PT409';
  end if;

  return new;
end;
$$;

revoke all on function guard_merchant_split_and_owner() from public;
revoke all on function guard_merchant_split_and_owner() from anon, authenticated;

-- 4. set_merchant_override takes the funding. The four-argument function is
-- dropped, so no overload can create an override of undeclared funding.
drop function set_merchant_override(int, uuid, numeric, date);

create function set_merchant_override(
  merchant_id_input    int,
  recipient_id_input   uuid,
  override_pct_input   numeric,
  effective_from_input date,
  funded_by_input      text
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  m          merchants;
  recipient  profiles;
  pre_status text;
  latest     date;
  open_one   merchant_overrides;
  new_id     int;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  if merchant_id_input is null or recipient_id_input is null
     or override_pct_input is null or effective_from_input is null
     or funded_by_input is null then
    raise exception 'Every field is required to set an override: who receives it, the percent, the first month and who pays it.'
      using errcode = '22023';
  end if;

  if funded_by_input not in ('owner', 'company') then
    raise exception 'Paid from must be the owner''s side or the company''s share.'
      using errcode = '22023';
  end if;

  select * into m from merchants where id = merchant_id_input for update;
  if not found then
    raise exception 'merchant not found' using errcode = 'PT404';
  end if;

  -- A4b: set only once the pre-app is submitted. A merchant exists from
  -- approval; this refuses one whose pre-app says otherwise. A merchant an
  -- admin made by hand has no pre-app and is allowed.
  if m.pre_app_id is not null then
    select status into pre_status from pre_apps where id = m.pre_app_id;
    if pre_status is distinct from 'submitted' and pre_status is distinct from 'approved' then
      raise exception 'This merchant''s pre-app has not been submitted, so it cannot carry an override yet.'
        using errcode = 'PT409';
    end if;
  end if;

  if m.mid is null or btrim(m.mid) = '' then
    raise exception 'This merchant has no MID, so no residual could ever carry an override. Add the MID first.'
      using errcode = 'PT409';
  end if;

  if override_pct_input <> round(override_pct_input, 2)
     or override_pct_input <= 0 or override_pct_input > 50 then
    raise exception 'An override is a percent of the full residual, above 0 and in hundredths at most, like 10 or 2.5.'
      using errcode = '22023';
  end if;

  if m.split_agent_pct is null then
    raise exception 'This merchant has no split rate yet. Set its rate before giving it an override.'
      using errcode = 'PT409';
  end if;

  if m.split_agent_pct = 0 then
    raise exception 'This merchant''s rate is 0, so it cannot carry an override.'
      using errcode = 'PT409';
  end if;

  -- The cap (memo §0b.5), in both modes (docs/design/override-funding.md D1):
  -- at most the merchant's rate -- not always 50.
  if override_pct_input > m.split_agent_pct then
    raise exception 'An override cannot be more than this merchant''s rate: %.',
      trim_scale(m.split_agent_pct)
      using errcode = '22023';
  end if;

  if extract(day from effective_from_input) <> 1 then
    raise exception 'An override starts on the first day of a month.'
      using errcode = '22023';
  end if;

  select * into recipient from profiles where id = recipient_id_input;
  if not found then
    raise exception 'recipient not found' using errcode = 'PT404';
  end if;

  if not recipient.is_active then
    raise exception '% is deactivated, so a new override cannot name them.', recipient.full_name
      using errcode = 'PT409';
  end if;

  if recipient.id = m.agent_id then
    raise exception 'The owner cannot also receive the override on their own merchant. Name their manager or another person.'
      using errcode = '22023';
  end if;

  if exists (
    select 1 from merchant_rep_shares s
     where s.merchant_id = m.id
       and recipient.id in (s.primary_agent_id, s.secondary_agent_id)
       and daterange(s.effective_from, s.effective_to)
           && daterange(effective_from_input, null)
  ) then
    raise exception '% is a party to this merchant''s shared account, so they cannot also receive its override.',
      recipient.full_name
      using errcode = 'PT409';
  end if;

  select max(period) into latest
    from rep_payout_rows
   where (merchant_id = m.id or mid = m.mid)
     and line_kind = 'import';

  if latest is not null and effective_from_input <= latest then
    raise exception '% is already committed for this MID. An override can only start after it; a committed month is corrected with an adjustment.',
      to_char(latest, 'FMMonth YYYY')
      using errcode = 'PT409';
  end if;

  select * into open_one
    from merchant_overrides
   where merchant_id = m.id and effective_to is null;

  if found then
    if open_one.effective_from >= effective_from_input then
      raise exception 'This merchant already has an override starting %. Cancel or end that one first.',
        to_char(open_one.effective_from, 'FMMonth YYYY')
        using errcode = 'PT409';
    end if;

    update merchant_overrides
       set effective_to = effective_from_input
     where id = open_one.id;

    insert into audit_log (actor_id, action, table_name, row_id)
    values (auth.uid(), 'end_merchant_override', 'merchant_overrides',
            open_one.id::text);
  end if;

  if exists (
    select 1 from merchant_overrides
     where merchant_id = m.id
       and daterange(effective_from, effective_to)
           && daterange(effective_from_input, null)
  ) then
    raise exception 'That month overlaps another override on this merchant.'
      using errcode = 'PT409';
  end if;

  insert into merchant_overrides (
    merchant_id, recipient_id, override_pct, effective_from, funded_by
  )
  values (
    m.id, recipient.id, override_pct_input, effective_from_input, funded_by_input
  )
  returning id into new_id;

  insert into audit_log (actor_id, action, table_name, row_id, detail)
  values (auth.uid(), 'set_merchant_override', 'merchant_overrides',
          new_id::text, 'funded_by=' || funded_by_input);

  return new_id;
end;
$$;

revoke all on function set_merchant_override(int, uuid, numeric, date, text) from public;
revoke all on function set_merchant_override(int, uuid, numeric, date, text) from anon;
grant execute on function set_merchant_override(int, uuid, numeric, date, text)
  to authenticated, service_role;

-- 5. set_merchant_override_funding: the only way to change who pays.
create function set_merchant_override_funding(
  override_id_input int,
  funded_by_input   text,
  reason_input      text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  reason    text := btrim(coalesce(reason_input, ''));
  o         merchant_overrides;
  m         merchants;
  recipient profiles;
  month_row record;
  touched   text[];
  again     text[];
  paid      text;
  months    jsonb;
  label     text;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  if override_id_input is null or funded_by_input is null then
    raise exception 'An override and who pays it are required.' using errcode = '22023';
  end if;
  if funded_by_input not in ('owner', 'company') then
    raise exception 'Paid from must be the owner''s side or the company''s share.'
      using errcode = '22023';
  end if;
  if length(reason) < 10 or length(reason) > 500 then
    raise exception 'Give a reason of 10 to 500 characters. It is kept in the audit log.'
      using errcode = '22023';
  end if;

  if not exists (select 1 from merchant_overrides where id = override_id_input) then
    raise exception 'override not found' using errcode = 'PT404';
  end if;

  -- The touched months: the committed processor-months this override's
  -- lines are in. Their residual-month locks first, sorted, then the share
  -- lock -- commit v3's order -- so no commit, replace, delete or Mark paid
  -- interleaves.
  select coalesce(array_agg(t.k order by t.k), '{}') into touched
    from (select distinct l.processor || '/' || l.period::text as k
            from rep_payout_rows l
            join rep_payout_batches b on b.id = l.batch_id
           where l.override_id = override_id_input
             and l.line_kind = 'override'
             and b.status = 'committed') t;

  for month_row in select unnest(touched) as k order by 1 loop
    perform pg_advisory_xact_lock(hashtext('tapswipe.residual_month:' || month_row.k));
  end loop;
  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  select coalesce(array_agg(t.k order by t.k), '{}') into again
    from (select distinct l.processor || '/' || l.period::text as k
            from rep_payout_rows l
            join rep_payout_batches b on b.id = l.batch_id
           where l.override_id = override_id_input
             and l.line_kind = 'override'
             and b.status = 'committed') t;
  if again <> touched then
    raise exception 'A month was committed for this override meanwhile. Try again.'
      using errcode = 'PT409';
  end if;

  select * into o from merchant_overrides where id = override_id_input for update;

  if o.funded_by = funded_by_input then
    return jsonb_build_object('changed', false, 'from', o.funded_by, 'to', funded_by_input,
                              'replace', '[]'::jsonb);
  end if;

  select string_agg(c.processor || ' ' || to_char(c.period, 'FMMonth YYYY'), ', '
                    order by c.period, c.processor)
    into paid
    from payout_period_closures c
   where c.processor || '/' || c.period::text = any(touched);
  if paid is not null then
    raise exception '% is marked paid. Reopen it (with a reason) before changing who pays this override.', paid
      using errcode = 'PT409';
  end if;

  select * into m from merchants where id = o.merchant_id;

  -- Owner funding comes out of the owner's side: what it needs, against the
  -- merchant as it is now. Backstops -- the rules hold for both modes.
  if funded_by_input = 'owner' then
    if m.split_agent_pct is null or m.split_agent_pct = 0 then
      raise exception 'This merchant has no rate above 0 now, so the override cannot come out of the owner''s side.'
        using errcode = 'PT409';
    end if;
    if o.override_pct > m.split_agent_pct then
      raise exception 'This merchant''s rate is now %, below the override''s %, so it cannot come out of the owner''s side.',
        trim_scale(m.split_agent_pct), trim_scale(o.override_pct)
        using errcode = 'PT409';
    end if;
    select * into recipient from profiles where id = o.recipient_id;
    if recipient.id = m.agent_id
       or exists (select 1 from merchant_rep_shares s
                   where s.merchant_id = m.id
                     and recipient.id in (s.primary_agent_id, s.secondary_agent_id)
                     and daterange(s.effective_from, s.effective_to)
                         && daterange(o.effective_from, o.effective_to)) then
      raise exception '% is now the owner or a party of this merchant''s shared account, so the override cannot come out of the owner''s side.',
        recipient.full_name
        using errcode = 'PT409';
    end if;
  end if;

  update merchant_overrides set funded_by = funded_by_input where id = o.id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'processor', b.processor,
           'period', to_char(b.period, 'YYYY-MM-DD'),
           'batch_id', b.id) order by b.period, b.processor), '[]'::jsonb),
         string_agg(b.processor || ' ' || to_char(b.period, 'YYYY-MM'), ', '
                    order by b.period, b.processor)
    into months, label
    from rep_payout_batches b
   where b.status = 'committed'
     and b.processor || '/' || b.period::text = any(touched);

  -- audit_log.detail is at most 1000 characters: the reason is at most 500,
  -- and a long month list is cut to its count.
  if label is not null and length(label) > 300 then
    label := cardinality(touched) || ' processor-months';
  end if;

  insert into audit_log (actor_id, action, table_name, row_id, detail)
  values (auth.uid(), 'set_override_funding', 'merchant_overrides', o.id::text,
          o.funded_by || ' -> ' || funded_by_input
          || '; replace: ' || coalesce(label, 'none')
          || '; reason: ' || reason);

  return jsonb_build_object('changed', true, 'from', o.funded_by, 'to', funded_by_input,
                            'replace', months);
end;
$$;

revoke all on function set_merchant_override_funding(int, text, text) from public;
revoke all on function set_merchant_override_funding(int, text, text) from anon;
grant execute on function set_merchant_override_funding(int, text, text)
  to authenticated, service_role;

-- 6. override_funding_pending: the committed months to replace.
create function override_funding_pending()
returns table (
  processor text,
  period date,
  batch_id int,
  override_count int
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  return query
  select l.processor, l.period, l.batch_id, count(distinct l.override_id)::int
    from rep_payout_rows l
    join rep_payout_batches b on b.id = l.batch_id
    join merchant_overrides o on o.id = l.override_id
   where l.line_kind = 'override'
     and b.status = 'committed'
     and l.override_funded_by is distinct from o.funded_by
   group by l.processor, l.period, l.batch_id
   order by l.period, l.processor;
end;
$$;

revoke all on function override_funding_pending() from public;
revoke all on function override_funding_pending() from anon;
grant execute on function override_funding_pending() to authenticated, service_role;

-- 7. Mark paid waits for a pending funding change to be replaced in.
-- Otherwise the body of 20261030190000.
create or replace function close_payout_period(
  period_input       date,
  processor_input    text,
  confirmation_input text
)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  label     text;
  typed     text;
  existing  payout_period_closures;
  closed_at timestamptz;
  stale     int;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  if period_input is null or processor_input is null then
    raise exception 'Choose the processor and month to mark paid.' using errcode = '22023';
  end if;
  if extract(day from period_input) <> 1 then
    raise exception 'A month is given as its first day.' using errcode = '22023';
  end if;
  if not exists (select 1 from processors where code = processor_input) then
    raise exception '"%" is not a processor in the CRM.', processor_input using errcode = 'PT404';
  end if;

  perform pg_advisory_xact_lock(hashtext(
    'tapswipe.residual_month:' || processor_input || '/' || period_input::text));

  label := processor_input || ' ' || to_char(period_input, 'FMMonth YYYY');
  typed := lower(regexp_replace(btrim(coalesce(confirmation_input, '')), '\s+', ' ', 'g'));
  if typed <> lower(label) then
    raise exception 'To mark it paid, type % exactly.', label using errcode = 'PT400';
  end if;

  if not exists (select 1 from rep_payout_batches
                  where processor = processor_input and period = period_input
                    and status = 'committed') then
    raise exception 'Nothing is committed for %, so there is nothing to mark paid.', label
      using errcode = 'PT409';
  end if;

  -- docs/design/override-funding.md §2.7: never mark paid on figures an
  -- override's funding change has made stale.
  select count(distinct l.override_id) into stale
    from rep_payout_rows l
    join rep_payout_batches b on b.id = l.batch_id
    join merchant_overrides o on o.id = l.override_id
   where l.line_kind = 'override'
     and b.status = 'committed'
     and l.processor = processor_input and l.period = period_input
     and l.override_funded_by is distinct from o.funded_by;
  if stale > 0 then
    raise exception '% override(s) on % changed who pays them after this month was committed. Replace the month first, then mark it paid.',
      stale, label
      using errcode = 'PT409';
  end if;

  select * into existing from payout_period_closures
   where period = period_input and processor = processor_input;
  if found then
    raise exception '% was already marked paid on %.', label,
      to_char(existing.closed_at at time zone 'UTC', 'FMMonth FMDD, YYYY')
      using errcode = 'PT409';
  end if;

  -- The table's own trigger writes the audit row (close_payout_period).
  insert into payout_period_closures (period, processor)
  values (period_input, processor_input)
  returning payout_period_closures.closed_at into closed_at;

  return closed_at;
end;
$$;

revoke all on function close_payout_period(date, text, text) from public;
revoke all on function close_payout_period(date, text, text) from anon;
grant execute on function close_payout_period(date, text, text) to authenticated, service_role;

-- 8. Report 2: the company-funded overrides, and the company's share net of
-- them. A change of return type, so dropped and created again.
drop function merchant_processor_summary(date, date, text);

create function merchant_processor_summary(
  period_from_input date,
  period_to_input date,
  processor_input text default null
)
returns table (
  row_kind text,
  period date,
  processor text,
  merchant_id int,
  mid text,
  merchant_name text,
  owner_id uuid,
  owner_code text,
  owner_name text,
  volume numeric,
  residual numeric,
  rep_side numeric,
  company_overrides numeric,
  company_share numeric
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  if not is_admin() then
    raise exception 'Reports are for admins.' using errcode = 'PT403';
  end if;
  if period_from_input is null or period_to_input is null
     or period_from_input <> date_trunc('month', period_from_input)::date
     or period_to_input <> date_trunc('month', period_to_input)::date
     or period_to_input < period_from_input then
    raise exception 'Choose a first and last month, the first no later than the last.'
      using errcode = '22023';
  end if;

  return query
  with lines as (
    -- The import lines, and the credits of company-funded overrides: the
    -- only override lines that move money out of the company's share.
    select l.period, l.processor, l.mid, l.merchant_id, l.merchant_name, l.agent_id,
           l.line_kind, l.share_role, l.volume, l.residual_income,
           l.account_residual_income, l.rep_payout,
           case when l.line_kind = 'override' then l.override_amount end as company_override
      from rep_payout_rows l
      join rep_payout_batches b on b.id = l.batch_id
     where l.period between period_from_input and period_to_input
       and (processor_input is null or l.processor = processor_input)
       and b.status = 'committed'
       and (l.line_kind = 'import'
            or (l.line_kind = 'override' and l.override_role = 'credit'
                and l.override_funded_by = 'company'))
  ),
  agg as (
    select grouping(l.period, l.processor, l.mid) as g, l.period, l.processor, l.mid,
           max(l.merchant_id) filter (where l.line_kind = 'import') as merchant_id,
           max(l.merchant_name)
             filter (where l.line_kind = 'import' and l.share_role is distinct from 'secondary')
             as merchant_name,
           (array_agg(l.agent_id)
              filter (where l.line_kind = 'import' and l.share_role is distinct from 'secondary'))[1]
             as owner_id,
           coalesce(sum(l.volume) filter (where l.line_kind = 'import'), 0) as vol,
           coalesce(sum(case when l.line_kind <> 'import' then null
                             when l.share_role is null then l.residual_income
                             when l.share_role = 'primary' then l.account_residual_income
                        end), 0) as res,
           coalesce(sum(l.rep_payout) filter (where l.line_kind = 'import'), 0) as rep,
           coalesce(sum(l.company_override), 0) as co
      from lines l
     group by grouping sets ((l.period, l.processor, l.mid), (l.period, l.processor), ())
  )
  select case a.g when 0 then 'merchant' when 1 then 'processor' else 'total' end,
         a.period, a.processor,
         case when a.g = 0 then a.merchant_id end, a.mid,
         case when a.g = 0 then a.merchant_name end,
         case when a.g = 0 then a.owner_id end,
         case when a.g = 0 then p.agent_number end,
         case when a.g = 0 then p.full_name end,
         round(a.vol, 2), round(a.res, 2), round(a.rep, 2), round(a.co, 2),
         round(a.res - a.rep - a.co, 2)
    from agg a
    left join profiles p on p.id = a.owner_id and a.g = 0
   where exists (select 1 from lines)
   order by a.period nulls last, a.processor nulls last, a.g, a.merchant_name, a.mid;
end;
$$;

revoke all on function merchant_processor_summary(date, date, text) from public;
revoke all on function merchant_processor_summary(date, date, text) from anon;
grant execute on function merchant_processor_summary(date, date, text) to authenticated, service_role;
