-- Closing a support ticket is one-way.
--
-- Mirrors docs/tapswipe_crm_schema.sql, which is the spec.
--
-- Closing a ticket already worked before this migration, in the sense that the
-- vocabulary and the access were both there: support_tickets.status has allowed
-- 'closed' since 20260804201300, the check constraint was tightened and made
-- NOT NULL in 20260810171500, and "update own or admin" (20260805103000:229)
-- lets the owning rep or an admin set it. components/support-ticket-form.tsx
-- has offered it as a <select> option, and the list page has defaulted to the
-- open queue, so a closed ticket already dropped out of view.
--
-- So this migration adds NO access and NO column. It adds the one rule none of
-- that could express: a closed ticket stays closed.

-- ---------------------------------------------------------------------
-- Why a trigger, and not either declarative alternative.
--
--   * RLS cannot compare OLD to NEW. A policy's USING clause reads the row as
--     it stands, so "this row was closed and is now open" is not a predicate it
--     can write. It also could not be expressed per-column even if it could:
--     the same UPDATE carries priority and subject, which stay editable.
--   * A CHECK constraint sees a single row with no history. 'open' is a
--     perfectly legal value; what is illegal is reaching it from 'closed'.
--
-- pre_apps_guard_transitions() (20260806141000:66) is the established shape for
-- exactly this, and the differences from it are deliberate rather than
-- accidental:
--
--   * That trigger blocks EVERY direct status write and funnels all four
--     transitions through RPCs, because each one has a consequence to keep on a
--     single path -- a merchant row, a decline reason, a submission date, an
--     audit_log entry.
--   * This one blocks a single transition. There is no close_support_ticket()
--     RPC because a close needs no privilege the caller lacks, creates nothing,
--     and is already audited when it matters: log_cross_agent_change()
--     (20260811160000:143) logs an admin closing a rep's ticket, and a rep
--     closing their own is not cross-agent action to trail.
--   * open <-> pending stays completely unguarded. A ticket moving between
--     "working it" and "waiting on the processor" is ordinary traffic, several
--     times over in one ticket's life.
--
-- The predicate is `new.status <> 'closed'`, NOT
-- `new.status is distinct from old.status`. The edit form PATCHes every field
-- it renders, so saving a priority change on a closed ticket re-sends
-- status = 'closed'. Guarding on any-update-to-a-closed-row would make closed
-- tickets entirely immutable -- a broader decision than the one taken -- and it
-- would surface as an inexplicable error on a form showing no status control.
--
-- The escape hatch for a mis-click is the admin-only DELETE, and it is
-- deliberately a poor one: support_ticket_replies cascades, so it takes the
-- conversation with it and the follow-up is a new ticket. That cost is the
-- accepted price of finality. Adding reopening later means a reopen path with
-- its own guard and an audit row -- not weakening this trigger, which would
-- leave the transition unrecorded.
--
-- Not security definer: it reads OLD and NEW, which are handed to it, and calls
-- nothing. set search_path = public regardless, per the standing rule.
-- ---------------------------------------------------------------------
create or replace function support_tickets_guard_close()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.status = 'closed' and new.status <> 'closed' then
    -- PT409 is PostgREST's mapping to HTTP 409, so the browser sees a conflict
    -- rather than a flat 400. The message is written for a rep to read: it is
    -- reachable by someone acting on their own ticket, and it names no id.
    raise exception 'a closed ticket cannot be reopened'
      using errcode = 'PT409';
  end if;

  return new;
end;
$$;

-- Postgres grants EXECUTE to PUBLIC on every new function and PUBLIC includes
-- anon, and there is no declarative backstop (see the grants note in
-- docs/tapswipe_crm_schema.sql). A trigger function is harmless called directly
-- -- it raises without a trigger context -- but the rule holds with no
-- exceptions so the privilege surface stays greppable, and
-- tests/rls/grants.test.ts pins it.
revoke all on function support_tickets_guard_close() from public;
grant execute on function support_tickets_guard_close() to authenticated, service_role;

drop trigger if exists support_tickets_guard_close on support_tickets;
create trigger support_tickets_guard_close
  before update on support_tickets
  for each row execute function support_tickets_guard_close();

-- ---------------------------------------------------------------------
-- No backfill, and nothing to migrate.
--
-- Existing 'closed' rows simply become final from here; the trigger is BEFORE
-- UPDATE, so it judges transitions from now on and never re-examines history.
-- tests/helpers/db.ts seeds one closed ticket ('Old chargeback question'), which
-- is what the reopen-refused assertions in tests/rls/support-tickets.test.ts
-- act on.
-- ---------------------------------------------------------------------
