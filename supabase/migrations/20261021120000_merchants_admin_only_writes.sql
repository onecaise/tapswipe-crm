-- Merchants become admin-only to change, and every MID change is audited.
-- Security fix phase 1; docs/claude/security-fixes.md.
--
-- Matches docs/tapswipe_crm_schema.sql, updated first: the MERCHANTS policy
-- block and "EVERY MID CHANGE IS AUDITED" next to the cross-agent trigger.
--
-- The finding, reproduced by tests/rls/merchants-admin-only-writes.test.ts
-- against the schema before this file: "insert own" and "update own or admin"
-- let a rep write every column of their own merchant, MID included, and
-- commit_residual_import_v2 finds the share covering a staged row by the
-- merchant's CURRENT mid. A rep padding the MID while a month was in review
-- made the signer's row match no merchant -- it committed unshared, the
-- partner got nothing -- then the rep restored the MID, and
-- log_cross_agent_change() recorded nothing because the editor owned the row.
--
-- Product rule (Owen): merchant information is changed by admins only. A rep
-- keeps SELECT on their own book; notes and tasks are other tables and are
-- untouched here. approve_pre_app() is `security definer` behind is_admin()
-- and keeps creating merchants exactly as before.
--
-- GRANTS ARE UNCHANGED, on purpose. Admins and reps are both `authenticated`,
-- so a grant cannot distinguish them, and the admin's merchant form and the
-- missing-location screen need insert and update. The policies are the layer
-- that can express this rule.

-- 1. Writes: admin only. SELECT ("select own or admin") and DELETE ("admin
-- delete only") are already right and are not touched.
drop policy if exists "insert own" on merchants;
create policy "admin insert only" on merchants
  for insert with check (is_admin());

drop policy if exists "update own or admin" on merchants;
create policy "admin update only" on merchants
  for update using (is_admin()) with check (is_admin());

-- 2. Every MID change is audited, for every caller, admins included. Fails
-- closed: no exception handler, so a change that cannot be audited does not
-- happen.
create or replace function audit_merchant_mid_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if NEW.mid is distinct from OLD.mid then
    insert into audit_log (actor_id, action, table_name, row_id)
    values (auth.uid(), 'merchant_mid_changed', 'merchants', OLD.id::text);
  end if;
  return NEW;
end;
$$;

-- A trigger function needs no EXECUTE grant to fire, so nobody gets one.
revoke all on function audit_merchant_mid_change() from public;
revoke all on function audit_merchant_mid_change() from anon, authenticated;

drop trigger if exists merchants_mid_audit on merchants;
create trigger merchants_mid_audit
  before update of mid on merchants
  for each row execute function audit_merchant_mid_change();
