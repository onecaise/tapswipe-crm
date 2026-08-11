-- Security audit remediation: M1 (over-broad grants), L4 (stray production
-- function grant), and the first half of M2 (cross-agent audit trigger).
--
-- Mirrors docs/tapswipe_crm_schema.sql, which is the spec.
--
-- The trigger is attached to `merchants` only in this migration, pending
-- sign-off on the design before it is repeated across the other six tables.

-- ---------------------------------------------------------------------
-- M1 — take back what a plain `grant` could never remove.
--
-- 20260805200000 granted `select, insert, update, delete`, and that is what this
-- schema has always claimed. The enforced state on both the local stack and the
-- linked project was `GRANT ALL`, because:
--
--   * 20260805210000 revokes `all on all tables ... from anon` and never names
--     `authenticated`; and
--   * its `alter default privileges` binds FUTURE objects only, so the 13 tables
--     that already existed kept Supabase's legacy blanket grant.
--
-- `ALL` beyond those four verbs means TRUNCATE, REFERENCES and TRIGGER. The one
-- that matters is TRUNCATE, because **RLS does not apply to it** -- every
-- row-level protection in this schema is silent on TRUNCATE.
--
-- Honest scope: this is not reachable through the API today. PostgREST issues
-- only SELECT/INSERT/UPDATE/DELETE, and no `security invoker` RPC here contains
-- a TRUNCATE, so exploiting it needs a direct Postgres connection as a role that
-- has no password. It is removed because "unreachable" describes today's
-- surface rather than a guarantee, and because an enforced grant that
-- contradicts the documented model is the drift the grants-versus-RLS split
-- exists to prevent.
--
-- Revoke first, then re-grant exactly the intended verbs. The revoke is
-- deliberately `all tables` / `all sequences`: it also re-asserts that the three
-- *_secrets tables hold nothing for `authenticated`, since they are simply
-- absent from the re-grant below.
-- ---------------------------------------------------------------------
revoke all on all tables in schema public from authenticated;
revoke all on all sequences in schema public from authenticated;

grant select, insert, update, delete on
  profiles,
  merchants,
  leads,
  ghost_sheets,
  pre_apps,
  pre_app_owners,
  pre_app_terminal,
  pre_app_business_profile,
  documents,
  support_tickets,
  notes,
  tasks
to authenticated;

-- audit_log drops to SELECT, and is the reason this migration exists at all.
--
-- It is the tamper-evidence table. Everything else here can be corrected; a
-- forged or deleted audit row destroys the only record of who did what. Its
-- INSERT/UPDATE/DELETE grants were previously held back by nothing but the
-- absence of a policy for those verbs -- so one permissive policy, or one
-- `disable row level security`, and any signed-in rep could rewrite the trail.
--
-- No legitimate writer loses anything: every one is either a `security definer`
-- function (runs as the owner, bypasses RLS and grants alike) or a service-role
-- Edge Function.
grant select on audit_log to authenticated;

-- USAGE only, never SELECT (last_value is a free row count of every other
-- agent's book) and never UPDATE (setval() could reset an id sequence into
-- collisions). The legacy grant had included UPDATE.
grant usage on
  merchants_id_seq,
  leads_id_seq,
  ghost_sheets_id_seq,
  pre_apps_id_seq,
  pre_app_owners_id_seq,
  pre_app_terminal_id_seq,
  pre_app_business_profile_id_seq,
  documents_id_seq,
  support_tickets_id_seq,
  notes_id_seq,
  tasks_id_seq,
  audit_log_id_seq
to authenticated;

-- ---------------------------------------------------------------------
-- L4 — trigger functions hold no grant.
--
-- A trigger fires whether or not the querying role holds EXECUTE, so a grant
-- widens the surface for nothing. The linked project had `set_updated_at()`
-- granted to `authenticated` from the same legacy default. Harmless in practice
-- (Postgres refuses a direct call to a function returning `trigger`) but it
-- contradicts the schema doc, which says it is deliberately not granted.
--
-- Local already lacked these grants, so these are no-ops there and only bite on
-- the linked project.
-- ---------------------------------------------------------------------
revoke all on function set_updated_at() from authenticated;
revoke all on function pre_apps_guard_transitions() from authenticated;

-- ---------------------------------------------------------------------
-- M2 (part 1 of 2) — cross-agent audit trigger.
--
-- Closes the gap §10 already promised to cover: an admin editing or deleting any
-- rep's record does it through plain supabase-js, RLS allows it via is_admin(),
-- and nothing was written to audit_log. Admin-only deletes were equally silent.
--
-- Only cross-agent mutations are recorded. A rep editing their own lead is
-- ordinary work, and logging it would bury the entries that matter under
-- thousands that do not.
--
-- `security definer` is required, not stylistic: audit_log has no INSERT policy
-- for `authenticated`, so a security invoker trigger would have its insert
-- refused by RLS and would fail the caller's UPDATE. Running as the owner is
-- also what lets audit_log keep a SELECT-only grant above.
--
-- auth.uid() still returns the real caller inside a definer function -- definer
-- changes current_user, not the session's JWT claims. submit_pre_app() relies on
-- the same property.
--
-- AFTER rather than BEFORE, so the trail records what actually happened: on
-- pre_apps the BEFORE guard trigger can still reject the write.
--
-- OLD is read through to_jsonb rather than as OLD.agent_id. All seven target
-- tables carry both columns, so direct access would work -- but attached to a
-- table without agent_id it would raise and break the caller's write, whereas
-- this yields NULL and merely over-logs. The safer failure mode for one function
-- bolted onto seven tables.
--
-- 'cross_agent_*' rather than 'admin_*': the condition actually tested is "the
-- actor is not this row's owner". Under RLS that means an admin, but it also
-- catches a service-role connection, which has no auth.uid() and is therefore
-- caught by `is distinct from` -- logging privileged server writes is wanted.
-- Calling those rows admin_* would assert a role nothing here checked.
--
-- INSERT is deliberately not covered: an admin creating a record in a rep's name
-- (the `insert own` policy permits an admin any agent_id) is not recorded here.
-- ---------------------------------------------------------------------
create or replace function log_cross_agent_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor        uuid := auth.uid();
  row_agent_id uuid := (to_jsonb(OLD) ->> 'agent_id')::uuid;
  new_agent_id uuid := case when TG_OP = 'UPDATE'
                            then (to_jsonb(NEW) ->> 'agent_id')::uuid end;
begin
  -- Reassignment is checked separately from ownership, and first. An admin
  -- moving a record they themselves own into another rep's book has
  -- actor = OLD.agent_id, so the ownership branch below would skip it -- yet
  -- moving a record between books is exactly the privileged act a trail is for.
  if TG_OP = 'UPDATE' and new_agent_id is distinct from row_agent_id then
    insert into audit_log (actor_id, action, table_name, row_id)
    values (actor, 'record_reassigned', TG_TABLE_NAME, to_jsonb(OLD) ->> 'id');

  elsif actor is distinct from row_agent_id then
    insert into audit_log (actor_id, action, table_name, row_id)
    values (
      actor,
      case TG_OP when 'DELETE' then 'cross_agent_delete'
                 else 'cross_agent_update' end,
      TG_TABLE_NAME,
      to_jsonb(OLD) ->> 'id'
    );
  end if;

  -- AFTER trigger: return value is ignored.
  return null;
end;
$$;

revoke all on function log_cross_agent_change() from public;
revoke all on function log_cross_agent_change() from authenticated;

-- One table for now. The remaining six (leads, ghost_sheets, pre_apps,
-- support_tickets, notes, tasks) follow in their own migration once the shape
-- above is agreed.
drop trigger if exists merchants_audit_cross_agent on merchants;
create trigger merchants_audit_cross_agent
  after update or delete on merchants
  for each row execute function log_cross_agent_change();
