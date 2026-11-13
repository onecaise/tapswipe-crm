-- The import schema: processor and month on a residual import batch, one
-- committed batch per (processor, month), status 'replaced' and the replace
-- pair, the staging warnings and blocker codes, the ledger's processor and
-- confirmed-negative-volume marker, the merge key with the processor, and
-- payout_period_closures (Mark paid). Phase 6 of
-- docs/design/intake-and-reports.md. Database only.
--
-- Matches docs/tapswipe_crm_schema.sql, updated first; the block below is
-- copied from it verbatim.
--
-- =====================================================================
-- IMPORT SCHEMA (20261030120000) — the database half of the residual
-- import redesign: processor and month on a batch, one committed batch per
-- (processor, month), the paid-month table, the confirmed-negative-volume
-- marker, and the merge key with the processor in it. Phase 6 of
-- docs/design/intake-and-reports.md (§1.F-G, §2.1-2.4, §3.2, §8.1, §8.4).
--
-- DATABASE ONLY, AND THE CURRENT IMPORT KEEPS WORKING. No parser, upload
-- page or commit logic changes here (phases 7 and 8). The one Edge Function
-- that creates batches, residual-import-file-url, still sends neither a
-- processor nor a month, so both new batch columns are NULLABLE in this
-- phase and every rule below is written to hold for a batch that has them
-- and to leave a batch that does not exactly as it was:
--
--   rep_payout_batches
--     processor  text references processors(code)       (memo §1.B)
--     period     date, the 1st of a month                 (memo §2.2)
--       Set together or not at all
--       (rep_payout_batches_processor_period_together), so a batch can never
--       carry a processor with no month -- the one shape that would slip past
--       the one-committed rule below. The period must be the 1st
--       (rep_payout_batches_period_first_of_month) and inside the import
--       window, checked by guard_payout_batch_period() (memo A11): not after
--       the current month, and not more than 24 months before it -- the
--       month exactly 24 back is accepted, 25 back is refused. "Current
--       month" is the month of now() in UTC, pinned so the answer does not
--       depend on a session's TimeZone. A TRIGGER, not a CHECK, because the
--       window moves: a CHECK reading the clock would pass on insert and then
--       refuse the same row on a dump/restore two years later. The trigger
--       checks the period only when it is written (INSERT, or an UPDATE that
--       changes it), so an old batch stays valid as it ages.
--     replaces_batch_id, replaced_by_batch_id  int references
--       rep_payout_batches(id)                            (memo §2.2, §3.2)
--       The two ends of a replace. Neither may point at its own row, a
--       batch that replaces another must carry a processor and month (a
--       replace is per processor-month), and replaced_by_batch_id is set
--       EXACTLY when status = 'replaced' (rep_payout_batches_replaced_by_
--       when_replaced). Nothing writes them yet: phase 9 builds the replace.
--     status gains 'replaced'. A replaced batch is no longer 'committed', so
--       it drops out of the rule below and its successor can commit. The
--       client rule is unchanged: guard_batch_status_transition() still
--       admits only review -> abandoned from a signed-in session, so a
--       client can never set 'replaced'; only a definer function can (phase
--       9). Transitions among definer writers ('committed' -> 'replaced'
--       only, 'replaced' terminal) are phase 9's to enforce.
--
--   rep_payout_batches_one_committed_per_month
--     unique (processor, period) where status = 'committed'
--     A second committed batch for the same processor and month is
--     impossible, whoever writes it. Review and abandoned batches are not
--     limited (an admin may upload a corrected file while the first is in
--     review), and nor are replaced ones. A batch with NO processor -- every
--     batch today -- is outside it (NULLs are distinct in this index on
--     purpose: those batches have no month to be unique on).
--
--   rep_payout_import_rows (staging)
--     warnings text[] not null default '{}', each element one of the three
--       confirmable warning types (memo §2.4): processor_mismatch,
--       inactive_merchant, bad_numbers.
--     blocker vocabulary WIDENED with the six new codes (unknown_mid,
--       duplicate_mid, mid_in_other_batch, wrong_income_type,
--       missing_figure, unreadable_number). The five old codes stay, because
--       the parser that writes them is still the deployed one; phase 7
--       removes them with it.
--
--   rep_payout_rows (the ledger)
--     processor text references processors(code). A snapshot of the
--       batch's processor on import lines. NULL on every line written before
--       a batch carries one, and on adjustment lines.
--     volume_confirmed_negative boolean not null default false. The marker
--       for a line whose negative volume an admin confirmed (memo §2.4,
--       bad_numbers). rep_payout_rows_volume_check, which was
--       `volume >= 0`, becomes `volume_confirmed_negative = coalesce(volume
--       < 0, false)`: a negative volume is allowed ONLY on a marked line,
--       and the marker is allowed only on a line whose volume IS negative, so
--       the column says exactly which lines entered that way. Zero volume,
--       and a NULL one, stay allowed unmarked. No client can set the marker:
--       authenticated holds UPDATE on residual_income and rep_split_pct
--       only. The writer is commit v3 (phase 8), for a row whose
--       bad_numbers warning was confirmed.
--     THE MERGE KEY GAINS THE PROCESSOR. rep_payout_rows_import_merge_key,
--       which was `(period, agent_id, mid) where line_kind = 'import'`,
--       becomes `(period, processor, agent_id, mid) NULLS NOT DISTINCT
--       where line_kind = 'import'` (memo §2.1). The predicate is KEPT, and
--       every ON CONFLICT still names it. NULLS NOT DISTINCT is what keeps
--       today's import working unchanged: every line today has a NULL
--       processor, and with the default (NULLs distinct) two NULL-processor
--       lines on one key would no longer collide, so a re-import would
--       duplicate a month instead of merging into it.
--
--   Both commit functions are re-created with that one change -- the
--   conflict target names the processor, the insert writes batch.processor,
--   and v2's partner line copies its signer line's processor -- and nothing
--   else. THE COALESCE MERGE RULE IS UNTOUCHED in
--   both: `coalesce(excluded.residual_income, rep_payout_rows.residual_
--   income)` and the same for rep_split_pct, in commit_residual_import()
--   and in v2's step 3 (ordinary rows). Phase 8 retires it in v3 (which
--   never merges: a second import of a processor-month is a replace) and
--   drops v2; phase 13 drops commit_residual_import() and the rule's
--   CLAUDE.md text with it.
--
--   payout_period_closures -- "Mark paid" (memo §3.2, A8). One row per
--     (period, processor) that an admin has marked paid. Columns exactly as
--     the memo specifies: period, processor, closed_at. NO closed_by: who
--     marked it is the audit_log row the trigger below writes (actor_id =
--     auth.uid()), which keeps the profiles foreign-key count at 25 (decided
--     30 Oct 2026, following the memo). The typed confirmation is a UI step
--     (phase 9) and is stored nowhere.
--     * Admin SELECT through RLS; SELECT is the only grant, to
--       authenticated and service_role. No client write of any kind: the
--       writers are phase 9's close_payout_period() (an insert) and
--       reopen_payout_period() (a delete, its written reason kept on a
--       payout_period_reopenings row that phase 9 adds), both security
--       definer, so neither needs a grant.
--     * A closure is never edited. guard_payout_period_closure() refuses
--       every UPDATE (close is an insert, reopen is a delete) and a closure
--       for a month after the current one.
--     * EVERY VERB IS AUDITED HERE, at the table, by
--       log_payout_period_closure(): AFTER INSERT writes
--       'close_payout_period', AFTER DELETE writes 'reopen_payout_period',
--       table_name 'payout_period_closures', row_id '<period>/<processor>'
--       (for example '2026-07-01/TSYS'). It fails closed (no EXCEPTION
--       block), so a closure cannot land or go without its audit row. Phase
--       9's two functions therefore write no audit row of their own for the
--       closure itself (a second one would double the trail); the reopen's
--       reason goes on its reopenings row. UPDATE is refused, so it needs no
--       audit; TRUNCATE fires no row trigger and is not a client verb (the
--       reset script's own marker row covers it).
--
-- WHAT THIS DOES NOT DO, and which phase does:
--   * A batch's processor and month are not yet REQUIRED (phase 7 sets them
--     at upload; the phase that makes them NOT NULL must first refuse, by
--     id, any committed batch that has none).
--   * Nothing yet checks a staged row's period against its batch's period
--     (phase 8: v3 takes the month from the batch).
--   * A NULL-processor import line and a processor-tagged one are different
--     keys now, so a legacy month re-imported under a processor would sit
--     beside the old lines rather than merge. No path writes a processor-
--     tagged line until phase 7; its mid_in_other_batch blocker (memo §2.4)
--     must count a NULL-processor line as "another processor's".
--
-- REFUSES TO RUN over rows it cannot carry, naming them, and otherwise
-- changes no existing row. What it checks first:
--   1. no ledger line has a negative volume. Impossible under the old
--      CHECK, so this only fires on a project where that CHECK was altered
--      by hand; such a line would need a confirmation nobody gave, so it is
--      named (by id) rather than silently marked.
--   2. the four definitions it replaces are exactly the ones it expects
--      (merge key, volume CHECK, status CHECK, blocker CHECK), so a project
--      whose definitions were hand-altered stops rather than losing
--      something quietly.
-- Not "the tables must be empty": the hermetic suites seed rows and replay
-- later migrations over them (the phase 1 lesson), and every row they seed
-- is one this migration carries unchanged.
-- =====================================================================

-- 0. What this migration cannot carry, named; then the definitions it
-- replaces, checked.
do $$
declare
  bad text;
  definition text;
begin
  select string_agg(id::text, ', ' order by id) into bad
    from rep_payout_rows where volume < 0;
  if bad is not null then
    raise exception 'import schema migration refuses to run: rep_payout_rows line(s) % have a negative volume that no admin confirmed. Correct or remove them deliberately, then re-run.', bad;
  end if;

  select indexdef into definition from pg_indexes
   where schemaname = 'public' and indexname = 'rep_payout_rows_import_merge_key';
  if definition is distinct from
     'CREATE UNIQUE INDEX rep_payout_rows_import_merge_key ON public.rep_payout_rows USING btree (period, agent_id, mid) WHERE (line_kind = ''import''::text)' then
    raise exception 'rep_payout_rows_import_merge_key is not the (period, agent_id, mid) import key here (found: %). Inspect it before applying 20261030120000.',
      coalesce(definition, 'no such index');
  end if;

  select pg_get_constraintdef(oid) into definition from pg_constraint
   where conrelid = 'public.rep_payout_rows'::regclass and conname = 'rep_payout_rows_volume_check';
  if definition is distinct from 'CHECK ((volume >= (0)::numeric))' then
    raise exception 'rep_payout_rows_volume_check is not CHECK (volume >= 0) here (found: %). Inspect it before applying 20261030120000.',
      coalesce(definition, 'no such constraint');
  end if;

  select pg_get_constraintdef(oid) into definition from pg_constraint
   where conrelid = 'public.rep_payout_batches'::regclass and conname = 'rep_payout_batches_status_check';
  if definition is distinct from
     'CHECK ((status = ANY (ARRAY[''review''::text, ''committed''::text, ''abandoned''::text])))' then
    raise exception 'rep_payout_batches_status_check is not (review, committed, abandoned) here (found: %). Inspect it before applying 20261030120000.',
      coalesce(definition, 'no such constraint');
  end if;

  select pg_get_constraintdef(oid) into definition from pg_constraint
   where conrelid = 'public.rep_payout_import_rows'::regclass and conname = 'rep_payout_import_rows_blocker_check';
  if definition is distinct from
     'CHECK ((blocker = ANY (ARRAY[''unknown_agent''::text, ''unparseable_period''::text, ''bad_number''::text, ''missing_mid''::text, ''duplicate_in_file''::text])))' then
    raise exception 'rep_payout_import_rows_blocker_check is not the five-code vocabulary here (found: %). Inspect it before applying 20261030120000.',
      coalesce(definition, 'no such constraint');
  end if;
end $$;

-- 1. Batches: processor, month, the replace pair, status 'replaced'.
alter table rep_payout_batches
  add column processor text
    constraint rep_payout_batches_processor_fkey references processors(code),
  add column period date
    constraint rep_payout_batches_period_first_of_month
      check (extract(day from period) = 1),
  add column replaces_batch_id int
    constraint rep_payout_batches_replaces_batch_id_fkey
      references rep_payout_batches(id),
  add column replaced_by_batch_id int
    constraint rep_payout_batches_replaced_by_batch_id_fkey
      references rep_payout_batches(id);

alter table rep_payout_batches
  add constraint rep_payout_batches_processor_period_together
    check ((processor is null) = (period is null)),
  add constraint rep_payout_batches_replace_pair_not_self
    check (replaces_batch_id <> id and replaced_by_batch_id <> id),
  add constraint rep_payout_batches_replace_needs_month
    check (replaces_batch_id is null or processor is not null),
  add constraint rep_payout_batches_replaced_by_when_replaced
    check ((status = 'replaced') = (replaced_by_batch_id is not null));

alter table rep_payout_batches drop constraint rep_payout_batches_status_check;
alter table rep_payout_batches
  add constraint rep_payout_batches_status_check
    check (status in ('review', 'committed', 'abandoned', 'replaced'));

create unique index rep_payout_batches_one_committed_per_month
  on rep_payout_batches (processor, period)
  where status = 'committed';

-- The import window (memo A11). Invoker: it reads nothing but the clock.
create or replace function guard_payout_batch_period()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  this_month date := date_trunc('month', now() at time zone 'UTC')::date;
begin
  if new.period is not null
     and (tg_op = 'INSERT' or new.period is distinct from old.period) then
    if new.period > this_month then
      raise exception 'The import month % is in the future. Choose the month the residuals are for.',
        to_char(new.period, 'FMMonth YYYY')
        using errcode = 'PT400';
    end if;
    if new.period < (this_month - interval '24 months')::date then
      raise exception 'The import month % is more than 24 months ago. Post an adjustment for a month that old instead.',
        to_char(new.period, 'FMMonth YYYY')
        using errcode = 'PT400';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function guard_payout_batch_period() from public;

create trigger rep_payout_batches_period_window
  before insert or update of period on rep_payout_batches
  for each row execute function guard_payout_batch_period();

-- 2. Staging: the warnings, and the new blocker codes beside the old ones.
alter table rep_payout_import_rows
  add column warnings text[] not null default '{}'
    constraint rep_payout_import_rows_warnings_vocabulary
      check (warnings <@ array['processor_mismatch', 'inactive_merchant',
                               'bad_numbers']::text[]);

alter table rep_payout_import_rows drop constraint rep_payout_import_rows_blocker_check;
alter table rep_payout_import_rows
  add constraint rep_payout_import_rows_blocker_check check (blocker in (
    -- the deployed parser's codes; phase 7 removes them with it
    'unknown_agent', 'unparseable_period', 'bad_number',
    'missing_mid', 'duplicate_in_file',
    -- memo §2.4
    'unknown_mid', 'duplicate_mid', 'mid_in_other_batch',
    'wrong_income_type', 'missing_figure', 'unreadable_number'
  ));

-- 3. The ledger: the processor snapshot, the marker, the volume rule, the key.
alter table rep_payout_rows
  add column processor text
    constraint rep_payout_rows_processor_fkey references processors(code),
  add column volume_confirmed_negative boolean not null default false;

alter table rep_payout_rows drop constraint rep_payout_rows_volume_check;
alter table rep_payout_rows
  add constraint rep_payout_rows_volume_check
    check (volume_confirmed_negative = coalesce(volume < 0, false));

drop index rep_payout_rows_import_merge_key;
create unique index rep_payout_rows_import_merge_key
  on rep_payout_rows (period, processor, agent_id, mid) nulls not distinct
  where line_kind = 'import';

-- 4. Both commit functions: the processor on every insert and in every
-- conflict target, v2's partner line taking its signer line's. Otherwise the bodies of 20261016160000, unchanged -- THE COALESCE
-- included.


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
    residual_income, rep_split_pct, batch_id, processor
  )
  select
    r.agent_id, r.period, r.mid_raw, r.merchant_name_raw, r.merchant_id,
    r.volume, r.average_ticket, r.total_cost,
    r.residual_income, r.rep_split_pct, batch_id_input, batch.processor
    from rep_payout_import_rows r
   where r.batch_id = batch_id_input
  on conflict (period, processor, agent_id, mid) where line_kind = 'import' do update set
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
    residual_income, rep_split_pct, batch_id, processor
  )
  select
    r.agent_id, r.period, r.mid_raw, r.merchant_name_raw, r.merchant_id,
    r.volume, r.average_ticket, r.total_cost,
    r.residual_income, r.rep_split_pct, batch_id_input, batch.processor
    from rep_payout_import_rows r
   where r.batch_id = batch_id_input
     and r.id in (select p.staging_id from pg_temp.residual_commit_plan p
                   where p.plan = 'ordinary')
  on conflict (period, processor, agent_id, mid) where line_kind = 'import' do update set
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
    account_residual_income, processor
  )
  select
    r.agent_id, r.period, r.mid_raw, r.merchant_name_raw, r.merchant_id,
    r.volume, r.average_ticket, r.total_cost,
    null, null, batch_id_input,
    p.share_id, 'primary', p.primary_rep_pct, p.secondary_rep_pct,
    null, batch.processor
    from rep_payout_import_rows r
    join pg_temp.residual_commit_plan p on p.staging_id = r.id
   where r.batch_id = batch_id_input
     and p.plan = 'shared'
  on conflict (period, processor, agent_id, mid) where line_kind = 'import' do update set
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
    account_residual_income, processor
  )
  select
    p.secondary_agent_id, sl.period, sl.mid, sl.merchant_name, sl.merchant_id,
    null, null, null,
    shared_part(sl.account_residual_income, sl.secondary_rep_pct,
                sl.primary_rep_pct + sl.secondary_rep_pct),
    sl.rep_split_pct, batch_id_input,
    sl.rep_share_id, 'secondary', sl.primary_rep_pct, sl.secondary_rep_pct,
    sl.account_residual_income, sl.processor
    from pg_temp.residual_commit_plan p
    join rep_payout_import_rows r on r.id = p.staging_id
    join rep_payout_rows sl
      on sl.period = p.period
     and sl.agent_id = r.agent_id
     and sl.mid = p.mid_raw
     and sl.rep_share_id = p.share_id
     and sl.share_role = 'primary'
   where p.plan = 'shared'
  on conflict (period, processor, agent_id, mid) where line_kind = 'import' do nothing;

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


-- 5. payout_period_closures: Mark paid, per processor and month.
create table payout_period_closures (
  period date not null
    constraint payout_period_closures_period_first_of_month
      check (extract(day from period) = 1),
  processor text not null
    constraint payout_period_closures_processor_fkey references processors(code),
  closed_at timestamptz not null default now(),
  primary key (period, processor)
);

-- The four-step checklist with step 1 struck out (a closure belongs to no
-- rep) and step 3 one policy: there is no client write for a policy to admit.
alter table payout_period_closures enable row level security;

create policy "admin only select" on payout_period_closures
  for select using (is_admin());

-- SELECT only, and `revoke all` first, for the reason processors gives
-- (20261023130000: the local stack's default ACL hands service_role
-- TRUNCATE/REFERENCES/TRIGGER/MAINTAIN on every new table). No sequence: the
-- key is natural. Never anything for anon.
revoke all on payout_period_closures from anon, authenticated, service_role;
grant select on payout_period_closures to authenticated;
grant select on payout_period_closures to service_role;

-- A closure is inserted (close) or deleted (reopen), never edited, and never
-- for a month that has not begun.
create or replace function guard_payout_period_closure()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'A paid month is not edited. Reopen it (with a reason) instead.'
      using errcode = 'PT409';
  end if;
  if new.period > date_trunc('month', now() at time zone 'UTC')::date then
    raise exception 'The month % has not begun, so it cannot be marked paid.',
      to_char(new.period, 'FMMonth YYYY')
      using errcode = 'PT400';
  end if;
  return new;
end;
$$;

revoke all on function guard_payout_period_closure() from public;

create trigger payout_period_closures_guard
  before insert or update on payout_period_closures
  for each row execute function guard_payout_period_closure();

-- Every verb audited at the table. Definer, because audit_log has no insert
-- policy and authenticated holds SELECT on it only. Fails closed: no
-- EXCEPTION block, so the audit insert failing undoes the close or reopen.
create or replace function log_payout_period_closure()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  closure payout_period_closures;
begin
  if tg_op = 'DELETE' then
    closure := old;
  else
    closure := new;
  end if;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(),
          case tg_op when 'INSERT' then 'close_payout_period'
                     else 'reopen_payout_period' end,
          'payout_period_closures',
          to_char(closure.period, 'YYYY-MM-DD') || '/' || closure.processor);

  return null;
end;
$$;

revoke all on function log_payout_period_closure() from public;

create trigger payout_period_closures_audit
  after insert or delete on payout_period_closures
  for each row execute function log_payout_period_closure();
