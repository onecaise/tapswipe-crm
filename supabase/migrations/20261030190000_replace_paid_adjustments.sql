-- Replace, Mark paid and Reopen, the audited period delete, and the general
-- adjustment. Phase 9 of docs/design/intake-and-reports.md.
--
-- Matches docs/tapswipe_crm_schema.sql, updated first; the block below is
-- copied from it verbatim.
--
-- =====================================================================
-- REPLACE, PAID, ADJUSTMENTS (20261030190000) — phase 9 of
-- docs/design/intake-and-reports.md (§3.2-3.4, §0.5, A8, A23).
--
-- A committed processor-month now changes in exactly three ways, each an
-- audited admin-only `security definer` function with is_admin() first,
-- search_path public, pg_temp and its own revoke/grant lines:
--   * REPLACE (commit_residual_import_v3 on a batch that replaces another),
--     until the month is marked paid;
--   * DELETE (delete_payout_period), until the month is marked paid;
--   * an ADJUSTMENT line (post_payout_adjustment), once it is paid.
-- And a paid month changes state only by Mark paid / Reopen.
--
-- Every function that touches one processor-month takes the same advisory
-- lock v3 takes, hashtext('tapswipe.residual_month:<processor>/<period>'),
-- before reading anything about that month, and the share lock after it
-- (the order v3 uses), so a close, a reopen, a delete, a replace and an
-- adjustment on one month are serialised and none decides on a stale read.
--
-- 1. AUDIT DETAIL. audit_log gains `detail text` (NULL, at most 1000
--    characters), written only where a reason or count is the point of the
--    entry: the Reopen reason and the period delete's line count. Nothing
--    else changes on audit_log: still no INSERT policy, authenticated still
--    holds SELECT only. This replaces the memo's payout_period_reopenings
--    table (§3.2), whose only reason to exist was that audit_log had no
--    detail column: the reason now sits on the one audit row of the reopen,
--    so there is one home for it, not two.
--
-- 2. MARK PAID AND REOPEN (A8), on payout_period_closures (20261030120000),
--    whose triggers stay the only audit: these functions write NO audit row
--    of their own, so each action leaves exactly one.
--    close_payout_period(period_input date, processor_input text,
--                        confirmation_input text) returns timestamptz
--      THE TYPED CONFIRMATION is checked here, not in the browser: the admin
--      types the processor and month exactly as the page shows them, for
--      example "TSYS July 2026" (case and runs of space ignored). Anything
--      else is PT400. Refused: not the 1st (22023), an unknown processor
--      (PT404), nothing committed for that processor-month (PT409: there is
--      nothing to have paid), already marked paid (PT409, saying when), and
--      a month that has not begun (the closure guard, PT400).
--    reopen_payout_period(period_input date, processor_input text,
--                         reason_input text) returns void
--      A written reason of 10 to 500 characters after trimming (22023), and
--      the month must be marked paid (PT404). The reason reaches the audit
--      row through a TRANSACTION-LOCAL setting, tapswipe.reopen_reason, set
--      just before the DELETE and cleared just after it.
--    log_payout_period_closure() is re-created to carry it: the DELETE's
--    audit row gets detail = the reason, and a DELETE with no reason set is
--    REFUSED (PT409), so no path removes a closure without one. INSERT is
--    audited as before (detail NULL). Still no exception handler: if the
--    audit insert fails, the close or reopen does not happen.
--
-- 3. REPLACE (memo §3.2), inside commit_residual_import_v3 -- the same
--    function, the same read-review-confirm path, the same money: a batch
--    whose replaces_batch_id is set is committed AS a replacement. One
--    function, so a replace cannot drift from a first commit. Before
--    anything is written, under the batch lock, the processor-month lock
--    and the share lock:
--      * the batch it replaces must still be THE committed batch for the
--        same processor and month (FOR UPDATE; PT409 otherwise -- a second
--        replace of one batch, or a replace of a deleted one, is refused
--        here, never applied twice);
--      * the month must not be marked paid (PT409: "… is marked paid and
--        cannot be replaced. Reopen it … or post an adjustment");
--      * no adjustment line may adjust that month on a MID the old batch
--        paid, or under its processor (PT409, naming the MIDs): a share
--        correction or adjustment was worked out from the old figures;
--      * every refusal and warning of a first commit, re-derived as before,
--        except that the no-merge check ignores the old batch's own lines.
--    Then: the old batch's lines are deleted (batch_id = old, which is its
--    import lines AND the shared signer/partner lines derived from them --
--    never an adjustment, never another processor's line); the old batch
--    becomes 'replaced' with replaced_by_batch_id = the new one; the new
--    lines are written exactly as a first commit writes them; and beside
--    the commit's own audit row a 'replace_residual_import' row names the
--    old batch. replaced_lines in the result counts the lines removed. The
--    old file stays in the residual-imports bucket: nothing here touches
--    Storage. PHASE 10 HOOK: override lines will carry the batch_id too, so
--    the delete above removes the old ones, and v3 step 6 (the marked spot
--    below) writes the new ones -- replace rebuilds overrides with no
--    change here.
--    A second file for a committed month that is NOT a replacement is still
--    refused, now saying to upload it again and answer Yes to replace.
--
-- 4. BATCH STATUS. 'deleted' joins the vocabulary (a committed month whose
--    lines delete_payout_period removed; the slot is free again). The two
--    CHECKs that list the committed states (month_when_committed,
--    confirmed_warnings_shape) admit it too. guard_batch_status_transition()
--    keeps its client rule exactly (a signed-in user: review -> abandoned
--    only) and gains rules for EVERY writer, definer functions and the
--    service role included: 'replaced' only from 'committed', 'deleted'
--    only from 'committed', and a replaced or deleted batch is final --
--    no update of any kind.
--
-- 5. PERIOD DELETE (memo §3.4). delete_payout_period(period_input date,
--    processor_input text) returns jsonb {deleted, batch_id}. Deletes the
--    IMPORT lines of that processor-month (a NULL processor means the
--    lines committed before processors were recorded) and nothing else:
--    adjustment lines stay, they are corrections already made. Refused: a
--    month marked paid (PT409), an adjustment adjusting that month on one of
--    its MIDs or under its processor (PT409, naming them), and nothing to
--    delete (PT404). The month's committed batch becomes 'deleted'. ONE
--    audit row, 'delete_payout_period' on rep_payout_rows, row_id
--    '<period>/<processor>' ('…/none' for the old lines), detail the line
--    count and the batch; no exception handler, so a failed audit write
--    undoes the delete. rep_payout_row_history rows outlive the lines (no
--    foreign key), as before. FIXES A DEFECT: the old client DELETE wrote no
--    audit row, though 20260817102000 and this file said it did.
--    The client path is closed: DELETE is revoked on rep_payout_rows from
--    authenticated and the "admin only delete" policy is dropped.
--
-- 6. GENERAL ADJUSTMENT (memo §3.3, A23). post_payout_adjustment(
--      agent_id_input uuid, mid_input text, adjusts_period_input date,
--      processor_input text, amount_input numeric, note_input text)
--    returns jsonb {line_id, posting_period, amount}.
--    The way to fix a PAID month (memo §0.5: replace before paid, an
--    adjustment after), so it is REFUSED for a processor-month that is not
--    marked paid (PT409: replace it instead). One line_kind 'adjustment'
--    line for the payee: adjustment_amount = the amount (non-zero, cents),
--    adjusts_period = the paid month, processor = the paid month's
--    processor, mid = a merchant's MID (the ledger requires one; merchant
--    id and name come from the merchant), note = the reason (1 to 500
--    characters; the rep reads it on their statement). Posted in the same
--    open month post_share_correction uses -- the month after the latest
--    month with any import line, share_correction_posting_period()'s rule --
--    and never in the paid month. The payee must exist (PT404) and be active
--    (PT409, as a share correction's partner must be). Audited
--    'post_payout_adjustment' (rep_payout_rows, the line), failing closed.
--    RECONCILED with what exists: post_share_correction() is KEPT unchanged
--    (a different job -- it moves a share of one month between two reps and
--    nets to zero); the two share the posting-month rule and the ledger's
--    adjustment shape; neither replaces the other, and replace and delete
--    refuse a month that either kind adjusts.
--
-- REFUSES TO RUN, naming what it found, over definitions it rewrites that
-- are not the ones it expects: the batch status CHECK, the two committed-
-- state CHECKs, and the client delete policy. No row of any table is one
-- this migration cannot carry: every constraint it changes is widened, and
-- the new guard rules bind future updates only.
-- =====================================================================

-- 0. The definitions this migration rewrites, checked.
do $$
declare
  definition text;
begin
  select pg_get_constraintdef(oid) into definition from pg_constraint
   where conrelid = 'public.rep_payout_batches'::regclass
     and conname = 'rep_payout_batches_status_check';
  if definition is distinct from 'CHECK ((status = ANY (ARRAY[''review''::text, ''committed''::text, ''abandoned''::text, ''replaced''::text])))' then
    raise exception 'rep_payout_batches_status_check is not (review, committed, abandoned, replaced) here (found: %). Inspect it before applying 20261030190000.',
      coalesce(definition, 'no such constraint');
  end if;

  select pg_get_constraintdef(oid) into definition from pg_constraint
   where conrelid = 'public.rep_payout_batches'::regclass
     and conname = 'rep_payout_batches_month_when_committed';
  if definition is distinct from 'CHECK (((status <> ALL (ARRAY[''committed''::text, ''replaced''::text])) OR (processor IS NOT NULL)))' then
    raise exception 'rep_payout_batches_month_when_committed is not the phase 7 CHECK here (found: %). Inspect it before applying 20261030190000.',
      coalesce(definition, 'no such constraint');
  end if;

  select pg_get_constraintdef(oid) into definition from pg_constraint
   where conrelid = 'public.rep_payout_batches'::regclass
     and conname = 'rep_payout_batches_confirmed_warnings_shape';
  if definition is distinct from 'CHECK (((confirmed_warnings IS NULL) OR ((jsonb_typeof(confirmed_warnings) = ''object''::text) AND (status = ANY (ARRAY[''committed''::text, ''replaced''::text])))))' then
    raise exception 'rep_payout_batches_confirmed_warnings_shape is not the phase 8 CHECK here (found: %). Inspect it before applying 20261030190000.',
      coalesce(definition, 'no such constraint');
  end if;

  if not exists (select 1 from pg_policy
                  where polrelid = 'public.rep_payout_rows'::regclass
                    and polname = 'admin only delete') then
    raise exception 'rep_payout_rows has no "admin only delete" policy here. Inspect its policies before applying 20261030190000.';
  end if;
end $$;

-- 1. Audit detail.
alter table audit_log
  add column detail text
    constraint audit_log_detail_length check (length(detail) <= 1000);

-- 2. Batch status: 'deleted', and the committed-state CHECKs admit it.
alter table rep_payout_batches drop constraint rep_payout_batches_status_check;
alter table rep_payout_batches
  add constraint rep_payout_batches_status_check
    check (status in ('review', 'committed', 'abandoned', 'replaced', 'deleted'));

alter table rep_payout_batches drop constraint rep_payout_batches_month_when_committed;
alter table rep_payout_batches
  add constraint rep_payout_batches_month_when_committed
    check (status not in ('committed', 'replaced', 'deleted') or processor is not null);

alter table rep_payout_batches drop constraint rep_payout_batches_confirmed_warnings_shape;
alter table rep_payout_batches
  add constraint rep_payout_batches_confirmed_warnings_shape
    check (confirmed_warnings is null
           or (jsonb_typeof(confirmed_warnings) = 'object'
               and status in ('committed', 'replaced', 'deleted')));

-- The client rule unchanged; the replaced/deleted rules for every writer.
create or replace function guard_batch_status_transition()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user = 'authenticated'
     and not (old.status = 'review' and new.status = 'abandoned') then
    raise exception 'Only an import still in review can be changed here, and only to abandoned. This one is %.', old.status
      using errcode = 'PT409';
  end if;

  if old.status in ('replaced', 'deleted') then
    raise exception 'Import #% was %. That is final: nothing about it changes.', old.id, old.status
      using errcode = 'PT409';
  end if;

  if new.status in ('replaced', 'deleted') and new.status <> old.status
     and old.status <> 'committed' then
    raise exception 'Only a committed import can become %; import #% is %.', new.status, old.id, old.status
      using errcode = 'PT409';
  end if;

  return new;
end;
$$;

revoke all on function guard_batch_status_transition() from public;

-- 3. The closure audit carries the Reopen reason, and a reopen needs one.
create or replace function log_payout_period_closure()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  closure payout_period_closures;
  reason  text;
begin
  if tg_op = 'DELETE' then
    closure := old;
    reason := nullif(btrim(coalesce(current_setting('tapswipe.reopen_reason', true), '')), '');
    if reason is null then
      raise exception 'A paid month is reopened only with a written reason (reopen_payout_period).'
        using errcode = 'PT409';
    end if;
  else
    closure := new;
  end if;

  insert into audit_log (actor_id, action, table_name, row_id, detail)
  values (auth.uid(),
          case tg_op when 'INSERT' then 'close_payout_period'
                     else 'reopen_payout_period' end,
          'payout_period_closures',
          to_char(closure.period, 'YYYY-MM-DD') || '/' || closure.processor,
          reason);

  return null;
end;
$$;

revoke all on function log_payout_period_closure() from public;

-- 4. Mark paid.
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

-- 5. Reopen.
create or replace function reopen_payout_period(
  period_input    date,
  processor_input text,
  reason_input    text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  reason text := btrim(coalesce(reason_input, ''));
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  if period_input is null or processor_input is null then
    raise exception 'Choose the processor and month to reopen.' using errcode = '22023';
  end if;
  if length(reason) < 10 then
    raise exception 'Say why this paid month is being reopened, in at least 10 characters. The reason is kept in the audit log.'
      using errcode = '22023';
  end if;
  if length(reason) > 500 then
    raise exception 'The reason can be at most 500 characters.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext(
    'tapswipe.residual_month:' || processor_input || '/' || period_input::text));

  if not exists (select 1 from payout_period_closures
                  where period = period_input and processor = processor_input) then
    raise exception '% % is not marked paid, so there is nothing to reopen.',
      processor_input, to_char(period_input, 'FMMonth YYYY')
      using errcode = 'PT404';
  end if;

  -- The reason reaches the closure's own audit row (log_payout_period_closure)
  -- through this transaction-local setting; that row is the only one written.
  perform set_config('tapswipe.reopen_reason', reason, true);
  delete from payout_period_closures
   where period = period_input and processor = processor_input;
  perform set_config('tapswipe.reopen_reason', '', true);
end;
$$;

revoke all on function reopen_payout_period(date, text, text) from public;
revoke all on function reopen_payout_period(date, text, text) from anon;
grant execute on function reopen_payout_period(date, text, text) to authenticated, service_role;

-- 6. The period delete: one audited step; the client path closed.
create or replace function delete_payout_period(
  period_input    date,
  processor_input text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  label   text;
  problem text;
  batch   rep_payout_batches;
  deleted int;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  if period_input is null then
    raise exception 'Choose the month to delete.' using errcode = '22023';
  end if;
  if extract(day from period_input) <> 1 then
    raise exception 'A month is given as its first day.' using errcode = '22023';
  end if;

  label := coalesce(processor_input, 'Lines with no processor') || ' for '
           || to_char(period_input, 'FMMonth YYYY');

  perform pg_advisory_xact_lock(hashtext(
    'tapswipe.residual_month:' || coalesce(processor_input, '') || '/' || period_input::text));
  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  if processor_input is not null and exists (
    select 1 from payout_period_closures
     where period = period_input and processor = processor_input
  ) then
    raise exception '% is marked paid and cannot be deleted. Reopen it (with a reason) first, or post an adjustment instead.', label
      using errcode = 'PT409';
  end if;

  select string_agg(distinct a.mid, ', ') into problem
    from rep_payout_rows a
   where a.line_kind = 'adjustment' and a.adjusts_period = period_input
     and ((processor_input is not null and a.processor = processor_input)
          or a.mid in (select l.mid from rep_payout_rows l
                        where l.period = period_input and l.line_kind = 'import'
                          and l.processor is not distinct from processor_input));
  if problem is not null then
    raise exception 'Adjustments already correct % (MIDs %). They were worked out from these lines, so the month cannot be deleted under them.', label, problem
      using errcode = 'PT409';
  end if;

  delete from rep_payout_rows
   where period = period_input and line_kind = 'import'
     and processor is not distinct from processor_input;
  get diagnostics deleted = row_count;

  if deleted = 0 then
    raise exception '% has no lines to delete.', label using errcode = 'PT404';
  end if;

  if processor_input is not null then
    select * into batch from rep_payout_batches
     where processor = processor_input and period = period_input and status = 'committed'
     for update;
    if found then
      update rep_payout_batches set status = 'deleted' where id = batch.id;
    end if;
  end if;

  insert into audit_log (actor_id, action, table_name, row_id, detail)
  values (auth.uid(), 'delete_payout_period', 'rep_payout_rows',
          to_char(period_input, 'YYYY-MM-DD') || '/' || coalesce(processor_input, 'none'),
          deleted || ' lines' || coalesce('; import #' || batch.id, ''));

  return jsonb_build_object('deleted', deleted, 'batch_id', batch.id);
end;
$$;

revoke all on function delete_payout_period(date, text) from public;
revoke all on function delete_payout_period(date, text) from anon;
grant execute on function delete_payout_period(date, text) to authenticated, service_role;

revoke delete on rep_payout_rows from authenticated;
drop policy "admin only delete" on rep_payout_rows;

-- 7. The general adjustment, for a paid month.
create or replace function post_payout_adjustment(
  agent_id_input       uuid,
  mid_input            text,
  adjusts_period_input date,
  processor_input      text,
  amount_input         numeric,
  note_input           text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  note    text := btrim(coalesce(note_input, ''));
  label   text;
  payee   profiles;
  m       merchants;
  posting date;
  line_id int;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  if agent_id_input is null or mid_input is null or btrim(mid_input) = ''
     or adjusts_period_input is null or processor_input is null
     or amount_input is null then
    raise exception 'Every field is required to post an adjustment.' using errcode = '22023';
  end if;
  if note = '' then
    raise exception 'An adjustment needs a reason. The rep reads it on their statement.'
      using errcode = '22023';
  end if;
  if length(note) > 500 then
    raise exception 'The reason can be at most 500 characters.' using errcode = '22023';
  end if;
  if extract(day from adjusts_period_input) <> 1 then
    raise exception 'The month being adjusted is given as its first day.' using errcode = '22023';
  end if;
  if amount_input = 0 or amount_input <> round(amount_input, 2) then
    raise exception 'The amount is in whole cents and not zero: positive pays the rep, negative takes back.'
      using errcode = '22023';
  end if;
  if abs(amount_input) >= 1000000000000 then
    raise exception 'The amount is too large.' using errcode = '22023';
  end if;

  label := processor_input || ' ' || to_char(adjusts_period_input, 'FMMonth YYYY');

  perform pg_advisory_xact_lock(hashtext(
    'tapswipe.residual_month:' || processor_input || '/' || adjusts_period_input::text));
  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  if not exists (select 1 from payout_period_closures
                  where period = adjusts_period_input and processor = processor_input) then
    raise exception '% is not marked paid. Until it is, a correction is a replace: upload the corrected file for that month.', label
      using errcode = 'PT409';
  end if;

  select * into payee from profiles where id = agent_id_input;
  if not found then
    raise exception 'rep not found' using errcode = 'PT404';
  end if;
  if not payee.is_active then
    raise exception '% is deactivated, so an adjustment cannot name them.', payee.full_name
      using errcode = 'PT409';
  end if;

  select * into m from merchants where mid = btrim(mid_input);
  if not found then
    raise exception 'MID % is not a merchant in the CRM.', btrim(mid_input) using errcode = 'PT404';
  end if;

  select (max(period) + interval '1 month')::date into posting
    from rep_payout_rows where line_kind = 'import';

  insert into rep_payout_rows (
    agent_id, period, processor, mid, merchant_name, merchant_id,
    line_kind, adjustment_amount, adjusts_period, adjustment_note
  )
  values (
    agent_id_input, posting, processor_input, m.mid, m.dba, m.id,
    'adjustment', amount_input, adjusts_period_input, note
  )
  returning id into line_id;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'post_payout_adjustment', 'rep_payout_rows', line_id::text);

  return jsonb_build_object(
    'line_id', line_id,
    'posting_period', to_char(posting, 'YYYY-MM-DD'),
    'amount', amount_input
  );
end;
$$;

revoke all on function post_payout_adjustment(uuid, text, date, text, numeric, text) from public;
revoke all on function post_payout_adjustment(uuid, text, date, text, numeric, text) from anon;
grant execute on function post_payout_adjustment(uuid, text, date, text, numeric, text)
  to authenticated, service_role;

-- 8. v3, with the replace. Otherwise the body of 20261030160000.
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
  removed     int := 0;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  if exists (select 1 from unnest(confirmed) as c(code)
              where c.code is null
                 or c.code not in ('processor_mismatch', 'inactive_merchant',
                                   'bad_numbers')) then
    raise exception 'Only processor_mismatch, inactive_merchant and bad_numbers can be confirmed.'
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
            or a.mid in (select l.mid from rep_payout_rows l
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
   where m.mid in (select r.mid_raw from rep_payout_import_rows r
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

  select string_agg(d.mid_raw || ' (rows ' || d.row_list || ')', '; ' order by d.mid_raw)
    into problem
    from (select r.mid_raw,
                 string_agg(r.row_number::text, ', ' order by r.row_number) as row_list
            from rep_payout_import_rows r
           where r.batch_id = batch_id_input
           group by r.mid_raw
          having count(*) > 1) d;
  if problem is not null then
    raise exception 'A MID appears on more than one row: %. Fix the file and upload it again.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(r.mid_raw, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
   where r.batch_id = batch_id_input
     and not exists (select 1 from merchants m where m.mid = r.mid_raw);
  if problem is not null then
    raise exception 'MIDs % are not merchants in the CRM. Add them (or correct their MID), then read the file again.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(r.row_number::text, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
   where r.batch_id = batch_id_input
     and lower(regexp_replace(coalesce(r.income_type_raw, ''),
                              '^[\s﻿]+|[\s﻿]+$', '', 'g')) <> 'residuals';
  if problem is not null then
    raise exception 'Rows % have an Income Type other than Residuals. Fix the file and upload it again.', problem
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
    join merchants m on m.mid = r.mid_raw
   where r.batch_id = batch_id_input
     and (r.merchant_id is distinct from m.id
          or r.agent_id is distinct from m.agent_id);
  if problem is not null then
    raise exception 'A merchant''s MID or owner changed after this file was read (MIDs %). Read it again.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(r.mid_raw, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
    join merchants m on m.mid = r.mid_raw
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
      on l.mid = r.mid_raw and l.period = batch.period and l.line_kind = 'import'
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
    join merchants m on m.mid = r.mid_raw
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

  -- 4. The warnings, recomputed: the parser's rowWarnings().
  with flagged as (
    select r.row_number, w.code
      from rep_payout_import_rows r
      join merchants m on m.mid = r.mid_raw
      cross join lateral (values
        ('processor_mismatch',
         r.processor_raw is null
         or lower(btrim(regexp_replace(r.processor_raw, '[\s﻿]+', ' ', 'g')))
            <> lower(btrim(regexp_replace(batch.processor, '[\s﻿]+', ' ', 'g')))
         or (m.processor is not null and m.processor <> batch.processor)),
        ('inactive_merchant', m.status = 'inactive'),
        ('bad_numbers', r.volume <= 0 or r.residual_income > r.volume)
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
    -- The old batch's lines: its import lines and the shared lines derived
    -- from them. Adjustments carry no batch and stay. (Phase 10: override
    -- lines carry the batch too, so they go here and step 6 rebuilds them.)
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
    join merchants m on m.mid = r.mid_raw
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
    join merchants m on m.mid = r.mid_raw
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
    join merchants m on m.mid = r.mid_raw
    join merchant_rep_shares s
      on s.merchant_id = m.id
     and batch.period >= s.effective_from
     and (s.effective_to is null or batch.period < s.effective_to)
   where r.batch_id = batch_id_input;

  get diagnostics partners = row_count;

  -- 6. PHASE 10: override lines go here, from the same rows, counted in
  -- `overrides` below. On a replacement this is what rebuilds them.

  -- 7. Close the batch, and the audit rows.
  delete from rep_payout_import_rows where batch_id = batch_id_input;

  update rep_payout_batches
     set status = 'committed', committed_at = now(), row_count = staged,
         skipped_rows = '[]'::jsonb,
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
    'overrides', 0,
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
