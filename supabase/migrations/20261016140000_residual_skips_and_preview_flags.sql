-- Phase 4b of docs/design/residual-splits.md (the database part of the app
-- half): preview-flag columns on the staging rows, acknowledge_residual_skips(),
-- the old commit's guard message reworded, and the rep_payout_batches UPDATE
-- grant narrowed to (status).
--
-- Matches docs/tapswipe_crm_schema.sql, updated first; the block below is
-- copied from it verbatim, and the two grant statements at the end are the
-- GRANTS section's rep_payout_batches lines as of this migration.

-- =====================================================================
-- COMMIT V2, THE APP HALF (20261016140000) — preview flags, acknowledging
-- skipped rows, and the batch UPDATE grant narrowed to (status).
-- Phase 4b of docs/design/residual-splits.md, §5.4 and §7.
--
-- PREVIEW FLAGS ON THE STAGING ROW. parse-residual-import now works out, for
-- each resolved row, what commit_residual_import_v2 would do with it about a
-- shared account, and stores the answer beside the blocker:
--
--   preview_flag       share_not_applied  the file names a rep outside the
--                                         pair; the row imports as an
--                                         ordinary line for that rep and the
--                                         share pays nothing on it
--                      partner_named      the file names the PARTNER; v2 will
--                                         skip the row
--                      line_not_shared    the file names the signer but a key
--                                         of the pair already holds a line
--                                         that is not this share's; v2 will
--                                         skip the row
--   preview_note       the sentence the review screen shows, written by the
--                      function because it is the one place holding the
--                      pair's names (the `error` column's arrangement).
--
-- The codes are v2's own plan names, so a flag and the skip it predicts read
-- the same. A FLAG IS NEVER A BLOCKER: a flagged row still counts as ready,
-- and commit recomputes everything from the shares in force at commit (a
-- share can change between parse and commit -- the preview is advisory, the
-- commit authoritative). No CHECK ties a flag to a blocker, because a blocked
-- row is simply never flagged (the function flags only resolved rows).
--
-- The other four flags of design §7 (shared figures ignored, non-standard
-- rate, deactivated partner, looks shared) are deferred to phase 5; the
-- vocabulary is a CHECK so adding them is a deliberate migration.
--
-- acknowledge_residual_skips(batch_id_input int) returns timestamptz.
-- The button under the skipped-rows Callout. Sets skips_acknowledged_at on a
-- COMMITTED batch whose skipped_rows is non-empty, writes one audit_log row
-- (action 'acknowledge_residual_skips', row_id the batch id) and returns the
-- timestamp. Who acknowledged lives in audit_log and nowhere else: a
-- skips_acknowledged_by column would be a twenty-sixth profiles FK and one
-- more entry in every teardown list.
--
-- Refuses, by name, PT409: a batch that is not committed (nothing has been
-- skipped yet), a batch with no skipped rows (there is nothing to review),
-- and a SECOND acknowledgement (the first is the record; a second would move
-- the timestamp and add an audit row claiming a review that changes nothing).
-- PT404 for a missing batch. The batch is read `for update`, so two admins
-- pressing the button at once produce one acknowledgement and one refusal,
-- not two audit rows.
--
-- `security definer` because there is no other way to the column: the
-- UPDATE grant below stops at (status), and audit_log has no INSERT for any
-- client. Hand-written is_admin() guard as the first statement -- before the
-- batch is read, so an agent gets 'admin only' for a real batch and a missing
-- one alike (no id oracle) -- and search_path pinned. The audit insert has no
-- exception block: it FAILS CLOSED, so an acknowledgement cannot be recorded
-- without its trail.
--
-- THE BATCH UPDATE GRANT NARROWS TO (status), in the GRANTS section. `grant select, update on
-- rep_payout_batches` let an admin's session PATCH any column, so the skip
-- record this phase exists to keep visible could be cleared from the
-- browser's console -- skipped_rows set to '[]', or skips_acknowledged_at
-- set without an audit row. The one client writer is abandonResidualBatch()
-- (lib/residual-batches.ts), which writes status alone. Every other writer
-- is the service role (residual-import-file-url: file_key, status;
-- parse-residual-import: row_count) or a definer function (both commits,
-- this one), and a grant reaches none of them. The 20260812143407 lesson
-- again: a column the grant refuses is a loud 42501, where a policy can only
-- filter rows.
--
-- THE OLD COMMIT'S GUARD MESSAGE, reworded. It said "Reload the page to
-- commit it." -- untrue: the only caller that can reach it is an app version
-- that predates v2, and reloading that app calls the same function again.
-- The function is otherwise the 20261016120000 body, unchanged.
-- =====================================================================

alter table rep_payout_import_rows
  add column preview_flag text
    check (preview_flag in ('share_not_applied', 'partner_named', 'line_not_shared')),
  add column preview_note text;

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
  on conflict (period, agent_id, mid) do update set
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

create or replace function acknowledge_residual_skips(batch_id_input int)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  batch rep_payout_batches;
  stamp timestamptz := now();
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  select * into batch from rep_payout_batches where id = batch_id_input for update;
  if not found then
    raise exception 'import not found' using errcode = 'PT404';
  end if;

  if batch.status <> 'committed' then
    raise exception 'this import is %, so nothing has been skipped yet', batch.status
      using errcode = 'PT409';
  end if;

  if jsonb_array_length(batch.skipped_rows) = 0 then
    raise exception 'this import skipped no rows' using errcode = 'PT409';
  end if;

  if batch.skips_acknowledged_at is not null then
    raise exception 'these skipped rows have already been reviewed'
      using errcode = 'PT409';
  end if;

  update rep_payout_batches
     set skips_acknowledged_at = stamp
   where id = batch_id_input;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'acknowledge_residual_skips', 'rep_payout_batches',
          batch_id_input::text);

  return stamp;
end;
$$;

revoke all on function acknowledge_residual_skips(int) from public;
grant execute on function acknowledge_residual_skips(int) to authenticated, service_role;

revoke update on rep_payout_batches from authenticated;
grant update (status) on rep_payout_batches to authenticated;
