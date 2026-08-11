-- M2 (part 2 of 2) — cover INSERT, and attach the trigger to all seven tables.
--
-- Mirrors docs/tapswipe_crm_schema.sql, which is the spec.
--
-- 20260811143000 introduced log_cross_agent_change() covering UPDATE and DELETE
-- on `merchants` only, pending sign-off on the shape. This closes the INSERT gap
-- and completes the rollout.
--
-- ---------------------------------------------------------------------
-- What INSERT adds
--
-- An admin creating a record in a rep's name. The `insert own` policy is
-- `(agent_id = auth.uid() and is_active_agent()) or is_admin()`, so an admin may
-- supply ANY agent_id, and until now that left no trace anywhere. Checked
-- against NEW.agent_id, since there is no OLD row to compare with.
--
-- ---------------------------------------------------------------------
-- FAIL CLOSED, INTENTIONALLY
--
-- This is an AFTER ROW trigger with no EXCEPTION block, so it runs inside the
-- transaction of the statement that fired it and any error propagates. If the
-- audit_log insert fails, **the triggering INSERT/UPDATE/DELETE is rolled back
-- with it.** A write to these seven tables cannot succeed while its audit row
-- quietly does not.
--
-- Documented here because it is a deliberate choice and not an accident of
-- using a trigger, and because it is the opposite of the two other audit
-- behaviours in this codebase:
--
--   * rls_auto_enable() swallows per-table failures (EXCEPTION WHEN OTHERS),
--     because a backstop that breaks DDL is worse than one that misses a table.
--   * submit-pre-app-secrets CANNOT fail closed: by the time it audits, the
--     ciphertext is already committed, so it reports auditWriteFailed instead.
--   * read-pre-app-secrets DOES fail closed, for the same reason as here --
--     nothing has been handed over yet when the audit is written.
--
-- Here nothing is committed when the trigger runs, so refusing is both possible
-- and right: an unlogged admin edit is worse than a failed one, because a
-- failure is visible and a gap is not.
--
-- The realistic failure mode is audit_log.actor_id's FK to profiles(id) -- a JWT
-- whose sub has no profiles row. RLS makes that unreachable in practice (such a
-- caller satisfies neither is_active_agent() nor is_admin(), so no policy admits
-- their write at all), but tests/rls/audit-trigger.test.ts asserts the rollback
-- rather than trusting the reasoning.
-- ---------------------------------------------------------------------
create or replace function log_cross_agent_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor        uuid := auth.uid();
  row_agent_id uuid;
  new_agent_id uuid;
begin
  -- INSERT gets its own branch first because OLD is NOT ASSIGNED for an insert.
  -- Reading it here -- even inside a CASE that ought not to evaluate -- risks
  -- "record old is not assigned yet", which would break every insert on all
  -- seven tables. Nothing below touches OLD until TG_OP has ruled INSERT out.
  if TG_OP = 'INSERT' then
    row_agent_id := (to_jsonb(NEW) ->> 'agent_id')::uuid;
    if actor is distinct from row_agent_id then
      insert into audit_log (actor_id, action, table_name, row_id)
      values (
        actor, 'cross_agent_insert', TG_TABLE_NAME, to_jsonb(NEW) ->> 'id'
      );
    end if;
    return null;
  end if;

  -- UPDATE or DELETE from here, so OLD is assigned.
  row_agent_id := (to_jsonb(OLD) ->> 'agent_id')::uuid;

  if TG_OP = 'UPDATE' then
    new_agent_id := (to_jsonb(NEW) ->> 'agent_id')::uuid;
    -- Reassignment before ownership, and separate from it: an admin moving a
    -- record they themselves own into another rep's book has
    -- actor = OLD.agent_id, so the ownership test below would skip it.
    if new_agent_id is distinct from row_agent_id then
      insert into audit_log (actor_id, action, table_name, row_id)
      values (actor, 'record_reassigned', TG_TABLE_NAME, to_jsonb(OLD) ->> 'id');
      return null;
    end if;
  end if;

  if actor is distinct from row_agent_id then
    insert into audit_log (actor_id, action, table_name, row_id)
    values (
      actor,
      case TG_OP when 'DELETE' then 'cross_agent_delete'
                 else 'cross_agent_update' end,
      TG_TABLE_NAME,
      to_jsonb(OLD) ->> 'id'
    );
  end if;

  -- AFTER trigger: the return value is ignored.
  return null;
end;
$$;

revoke all on function log_cross_agent_change() from public;
revoke all on function log_cross_agent_change() from anon, authenticated;

-- ---------------------------------------------------------------------
-- Attach to all seven Tier 1 tables carrying agent_id.
--
-- `documents` is deliberately absent: its access is audited inside
-- create-upload-url and create-download-url, where the event worth recording is
-- the signed-URL mint rather than the metadata row -- bytes leave through the
-- URL, and a documents row can be read without one ever being issued.
--
-- `profiles` is absent too: it has no agent_id, and every privileged change to it
-- already writes its own audit row (create_user, deactivate_user,
-- admin_reset_password, promote_user_to_admin, demote_user_to_agent).
--
-- drop-then-create rather than `create or replace trigger`: the latter is
-- Postgres 14+, and being explicit keeps this migration replayable against the
-- merchants trigger 20260811143000 already created with the narrower event list.
-- ---------------------------------------------------------------------
drop trigger if exists merchants_audit_cross_agent on merchants;
create trigger merchants_audit_cross_agent
  after insert or update or delete on merchants
  for each row execute function log_cross_agent_change();

drop trigger if exists leads_audit_cross_agent on leads;
create trigger leads_audit_cross_agent
  after insert or update or delete on leads
  for each row execute function log_cross_agent_change();

drop trigger if exists ghost_sheets_audit_cross_agent on ghost_sheets;
create trigger ghost_sheets_audit_cross_agent
  after insert or update or delete on ghost_sheets
  for each row execute function log_cross_agent_change();

drop trigger if exists pre_apps_audit_cross_agent on pre_apps;
create trigger pre_apps_audit_cross_agent
  after insert or update or delete on pre_apps
  for each row execute function log_cross_agent_change();

drop trigger if exists support_tickets_audit_cross_agent on support_tickets;
create trigger support_tickets_audit_cross_agent
  after insert or update or delete on support_tickets
  for each row execute function log_cross_agent_change();

-- notes has no UPDATE policy (append-only by design), so the update arm never
-- fires there. Attached to the same event list anyway rather than special-cased:
-- if that policy is ever added, the trail should not have to be remembered
-- separately.
drop trigger if exists notes_audit_cross_agent on notes;
create trigger notes_audit_cross_agent
  after insert or update or delete on notes
  for each row execute function log_cross_agent_change();

drop trigger if exists tasks_audit_cross_agent on tasks;
create trigger tasks_audit_cross_agent
  after insert or update or delete on tasks
  for each row execute function log_cross_agent_change();
