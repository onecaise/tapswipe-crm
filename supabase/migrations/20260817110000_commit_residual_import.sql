-- commit_residual_import(batch_id_input int): a reviewed batch becomes ledger rows.
--
-- Matches docs/tapswipe_crm_schema.sql, updated first.
--
-- Tier 3, `security definer`, for three things the caller genuinely may not do:
-- rep_payout_rows has no INSERT policy, rep_payout_import_rows has no DELETE
-- policy, and audit_log has no INSERT policy at all. Same shape as
-- approve_pre_app, which this closely resembles -- it creates rows from a staged
-- record, flips the parent's status, writes audit_log, and guards itself with an
-- explicit is_admin() because `definer` bypasses RLS.
--
-- WHY AN RPC RATHER THAN AN EIGHTH EDGE FUNCTION. RESIDUALS_SPEC.md specified a
-- function; SQL turned out to be the better place, for four reasons:
--
--   1. Atomicity. supabase-js has no client-side transaction, so a function would
--      insert the ledger rows, then delete the staging rows, then flip the status
--      as three separate round trips -- with a real window in which a period is
--      half-imported. Here it all lands or none of it does. For a commission
--      import that is not a nicety.
--   2. No pagination to get wrong. PostgREST caps a response ([api] max_rows), so
--      a function would have to page through staging rows, and would silently
--      import only a prefix if anyone forgot. `insert ... select` has no limit.
--   3. The audit row fails closed for free. Inside the transaction a failed
--      audit_log insert rolls the whole import back, so the best-effort
--      `auditWriteFailed` asymmetry that submit-pre-app-secrets needs does not
--      arise here -- nothing is written until commit.
--   4. auth.uid() survives `security definer` (it changes current_user, not the
--      session's JWT claims), so the rep_payout_row_history rows this upsert
--      triggers are attributed to the committing admin rather than to nobody.
--
-- THE COALESCE IS THE WHOLE MERGE RULE, and it is the one line in this file worth
-- reading twice. On conflict the file-sourced columns are overwritten and the two
-- hand-entered ones are coalesce(excluded.<col>, rep_payout_rows.<col>) -- written
-- only where the file actually supplied a value. That is what lets a corrected
-- processor file be re-imported without wiping a month of typed-in residuals, and
-- lets this app's own round-trip export fill them in in bulk. Reverse those two
-- arguments and every re-import silently clears every figure; nothing else in the
-- schema would notice, which is why tests/rls/commit-residual-import.test.ts
-- asserts both directions.

create or replace function commit_residual_import(batch_id_input int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  batch    rep_payout_batches;
  blocked  int;
  staged   int;
  imported int;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  select * into batch from rep_payout_batches where id = batch_id_input;
  if not found then
    raise exception 'import not found' using errcode = 'PT404';
  end if;

  if batch.status <> 'review' then
    raise exception 'this import is already %', batch.status
      using errcode = 'PT409';
  end if;

  select count(*) into staged
    from rep_payout_import_rows where batch_id = batch_id_input;

  -- Refused rather than treated as a trivial success. Flipping a batch to
  -- 'committed' having imported nothing reads as a successful import of an empty
  -- month, which is worse than an error someone has to read.
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

-- Postgres grants EXECUTE to PUBLIC (which includes anon) on every new function,
-- and there is no declarative backstop -- see tests/rls/grants.test.ts. Without
-- these two lines this is callable unauthenticated, and it writes the ledger.
revoke all on function commit_residual_import(int) from public;
grant execute on function commit_residual_import(int) to authenticated, service_role;
