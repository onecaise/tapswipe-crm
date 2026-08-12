-- Bug reports: the floating report bubble, on every CRM page.
--
-- Mirrors docs/tapswipe_crm_schema.sql, which is the spec and was updated first.
--
-- A rep hits something broken and has nowhere to say so short of a message to
-- whoever is nearest. This gives them one place, on the page it happened, and
-- gives admins a queue.

-- ---------------------------------------------------------------------
-- 1. The table.
--
-- Ordinary Tier 1 shape, and the reporter column is called agent_id rather than
-- reporter_id on purpose. That buys two things: the policies below are the same
-- ones every other table uses, and log_cross_agent_change() -- which reads
-- `agent_id` by name out of to_jsonb -- works unchanged, so an admin clearing a
-- rep's report is audited without a variant function. (Contrast
-- support_ticket_replies in 20260812154523, whose owner lives on its parent and
-- which therefore needed its own.)
--
-- CLEARED BY STATUS, NOT BY DELETE. Checking a report off the admin list sets
-- status and stamps resolved_at / resolved_by; the list filters status = 'open'.
-- Same reasoning as deactivating a user rather than deleting them: a report
-- describes something that went wrong, and it is worth more after it has been
-- dismissed than before -- when the same bug arrives again, or when someone
-- asks whether it was ever looked at. There is deliberately no delete policy
-- and no delete grant.
--
-- The cost, stated so it is not discovered later: this table only grows, and
-- every query meaning "the queue" must say `status = 'open'`. One that forgets
-- shows dismissed reports as live work rather than failing -- the quiet kind of
-- wrong. lib/bug-reports.ts owns that filter in one place for that reason.
--
-- `page` is free text rather than a check constraint: it holds a route path,
-- routes change with every feature, and a report filed against a path that no
-- longer exists is still worth reading.
-- ---------------------------------------------------------------------
create table bug_reports (
  id serial primary key,
  agent_id uuid references profiles(id) not null,
  page text not null,
  description text not null,
  -- Two ways to close because they mean different things: 'resolved' is fixed,
  -- 'dismissed' is not-a-bug or won't-fix. Both leave the queue; only the first
  -- claims anything was done. NOT NULL for the reason support_tickets.status
  -- is: a CHECK that evaluates to NULL passes, so a nullable status silently
  -- defeats both the check and every filter built on it.
  status text not null default 'open'
    check (status in ('open', 'resolved', 'dismissed')),
  resolved_at timestamptz,
  resolved_by uuid references profiles(id),
  created_at timestamptz default now()
);

-- Written out even though the linked project's ensure_rls event trigger would
-- also catch it: that trigger exists on the hosted project only, so relying on
-- it leaves this table wide open everywhere else.
alter table bug_reports enable row level security;

-- ---------------------------------------------------------------------
-- 2. Policies.
-- ---------------------------------------------------------------------
create policy "select own or admin" on bug_reports
  for select using ((agent_id = auth.uid() and is_active_agent()) or is_admin());

-- Pinned to the caller rather than the usual own-or-admin shape: a bug report is
-- a first-hand account, so filing one under someone else's name is not something
-- an admin should be able to do either. is_active_agent() checks is_active
-- without checking role, so an active admin reporting their own bug passes.
create policy "insert own" on bug_reports
  for insert with check (agent_id = auth.uid() and is_active_agent());

-- Admin-only, and this is the clear-from-the-list action. A rep cannot edit a
-- report after filing it -- including their own -- for the same reason notes are
-- append-only: the value is in what it said at the time.
create policy "admin resolves" on bug_reports
  for update using (is_admin()) with check (is_admin());

-- No delete policy, on purpose. See the header.

-- ---------------------------------------------------------------------
-- 3. Grants -- only the verbs a policy backs.
--
-- No DELETE, which is the design rather than an omission. The UPDATE is backed
-- by the admin-only policy above, so a rep holds the privilege but no policy
-- admits their write -- the one case where a granted verb is intentionally
-- unreachable for most callers, and it is reachable for admins, so the rule
-- "a verb is granted only where a policy backs it" still holds.
-- ---------------------------------------------------------------------
grant select, insert, update on bug_reports to authenticated;
grant usage on sequence bug_reports_id_seq to authenticated;

-- ---------------------------------------------------------------------
-- 4. Audit -- the generic function, no variant needed.
--
-- Clearing a report is an UPDATE by an admin on a rep's row, which is exactly
-- what cross_agent_update records. resolved_by on the row is the readable copy
-- of the same fact; audit_log is the one that cannot be edited afterwards.
--
-- Fail-closed like the other eight: no EXCEPTION block, so a failed audit
-- insert rolls back the write that triggered it.
-- ---------------------------------------------------------------------
drop trigger if exists bug_reports_audit_cross_agent on bug_reports;
create trigger bug_reports_audit_cross_agent
  after insert or update or delete on bug_reports
  for each row execute function log_cross_agent_change();

-- ---------------------------------------------------------------------
-- 5. Indexes.
-- ---------------------------------------------------------------------
create index idx_bug_reports_agent_id on bug_reports(agent_id);
-- The admin queue is `where status = 'open'`, and cleared reports accumulate
-- behind it forever -- the cost of clearing by status rather than by delete,
-- and this is what keeps paying it cheap.
create index idx_bug_reports_status on bug_reports(status);
