-- Residuals are not edited after commit: rep_payout_rows has no client UPDATE
-- path at all, set_shared_residual() goes. Phase 11 of
-- docs/design/intake-and-reports.md.
--
-- Matches docs/tapswipe_crm_schema.sql, updated first; the block below is
-- copied from it verbatim.
--
-- =====================================================================
-- LOCK RESIDUALS (20261102140000) — phase 11 of
-- docs/design/intake-and-reports.md (§0.5, §1.C, §2.1, A7).
--
-- A committed line is never edited, by anyone using the app, an admin
-- included. A fix is a REPLACE of the processor-month until it is marked paid
-- (commit_residual_import_v3 on a replacing batch), or an ADJUSTMENT line
-- after (post_payout_adjustment, post_share_correction), both phase 9.
--
-- 1. THE GRANT. authenticated's column UPDATE on residual_income and
--    rep_split_pct (20261014160000) is revoked, with the table-level UPDATE
--    for anon, authenticated and PUBLIC (none is held today; revoked so the
--    grant layer says "nothing" whatever a hand-run grant once added). The
--    "admin only update" policy is dropped: no client UPDATE policy remains.
--    service_role keeps its privileges: the test teardowns detach lines from a
--    batch they delete, and no Edge Function updates the ledger.
--
-- 2. THE DATABASE REFUSES IT TOO. guard_client_payout_update(), BEFORE UPDATE
--    on rep_payout_rows: when the session role is authenticated or anon, the
--    update is refused (PT409) with the sentence an admin can act on. Security
--    invoker on purpose (current_user is the caller's role); definer functions
--    run as the owner and the service role is neither, so commit v3, replace,
--    the period delete's batch update and the teardowns are untouched. It is
--    the backstop for a grant added by hand later: the grant layer and this
--    trigger each refuse alone.
--
-- 3. set_shared_residual(int, date, numeric) is DROPPED. The file supplies a
--    shared account's residual and v3 writes both pieces at commit (phase 8);
--    the function was the shared-pair editor of a ledger nobody edits now.
--    guard_shared_line() and copy_signer_rate_to_partner() are KEPT, as
--    backstops with no client path (memo §2.1): they bind any owner-side
--    update that might be written later.
--
-- REFUSES TO RUN, naming what it found, if the definitions it removes are not
-- there (the update policy, set_shared_residual). No row is touched: nothing
-- here reads or writes a ledger line.
-- =====================================================================

-- 0. What this migration removes, checked.
do $$
begin
  if not exists (select 1 from pg_policy
                  where polrelid = 'public.rep_payout_rows'::regclass
                    and polname = 'admin only update' and polcmd = 'w') then
    raise exception 'rep_payout_rows has no "admin only update" policy here. Inspect its policies before applying 20261102140000.';
  end if;

  if to_regprocedure('public.set_shared_residual(int, date, numeric)') is null then
    raise exception 'set_shared_residual(int, date, numeric) does not exist here. Inspect the functions before applying 20261102140000.';
  end if;
end $$;

-- 1. No client UPDATE grant and no UPDATE policy.
revoke update (residual_income, rep_split_pct) on rep_payout_rows from authenticated;
revoke update on rep_payout_rows from public, anon, authenticated;
drop policy "admin only update" on rep_payout_rows;

-- 2. The database refuses a client update whatever the grants say.
create or replace function guard_client_payout_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user in ('authenticated', 'anon') then
    raise exception 'A committed payout line is never edited. Replace the month (until it is marked paid), or post an adjustment after.'
      using errcode = 'PT409';
  end if;
  return new;
end;
$$;

revoke all on function guard_client_payout_update() from public;
revoke all on function guard_client_payout_update() from anon, authenticated;

create trigger rep_payout_rows_guard_client_update
  before update on rep_payout_rows
  for each row execute function guard_client_payout_update();

-- 3. The shared-pair editor goes.
drop function set_shared_residual(int, date, numeric);
