-- Support ticket replies: the conversation on a ticket.
--
-- Mirrors docs/tapswipe_crm_schema.sql, which is the spec and was updated first.
--
-- Until now there was no way to respond to a ticket at all. What people did
-- instead was write a note on the merchant record, which is why "responding"
-- meant navigating away from the ticket. This puts the conversation on the
-- ticket itself, where both sides can read it.

-- ---------------------------------------------------------------------
-- 1. The table.
--
-- A child of support_tickets rather than a use of `notes`, and the reason is
-- the policy rather than the shape. notes is scoped own-or-admin, so an admin's
-- reply on a rep's ticket would be invisible to the rep -- the one person who
-- has to read it. Replies are scoped through the PARENT instead: whoever can
-- see the ticket sees its replies. That is what makes this a conversation
-- rather than two private monologues, and it is why notes.owner_type is NOT
-- being given a 'support_ticket' member.
--
-- APPEND-ONLY, like notes and for the same reason: a reply is a record of what
-- was said, and the correction for a wrong one is another reply. No update
-- policy, and no update grant either -- see step 3.
--
-- author_id is not an ownership column. It records who spoke; visibility comes
-- from the parent. That is why the insert policy pins it to auth.uid() rather
-- than trusting the client: without that conjunct a rep could post a reply
-- under the admin's name on their own ticket.
-- ---------------------------------------------------------------------
create table support_ticket_replies (
  id serial primary key,
  -- on delete cascade for the reason every pre-app child carries it
  -- (20260806140000:74-77): the parent's admin-only DELETE would otherwise fail
  -- on this FK.
  ticket_id int references support_tickets(id) on delete cascade not null,
  author_id uuid references profiles(id) not null,
  body text not null,
  created_at timestamptz default now()
);

-- Written out even though the linked project's ensure_rls event trigger would
-- also catch it: that trigger exists on the hosted project only, so relying on
-- it means this table is wide open everywhere else. Belt and braces, in that
-- order.
alter table support_ticket_replies enable row level security;

-- ---------------------------------------------------------------------
-- 2. Policies -- the pre_app_owners shape (20260805103000:139-159).
--
-- is_admin() is the first, unqualified disjunct, so an admin never touches the
-- exists(). is_active_agent() sits OUTSIDE the exists(), ANDed with it, because
-- the activity check is about the caller and not about the parent row.
--
-- No UPDATE policy: append-only.
-- ---------------------------------------------------------------------
create policy "select via parent ticket" on support_ticket_replies
  for select using (
    is_admin() or (is_active_agent() and exists (
      select 1 from support_tickets
       where support_tickets.id = ticket_id and support_tickets.agent_id = auth.uid()
    ))
  );
create policy "insert via parent ticket" on support_ticket_replies
  for insert with check (
    author_id = auth.uid() and (
      is_admin() or (is_active_agent() and exists (
        select 1 from support_tickets
         where support_tickets.id = ticket_id and support_tickets.agent_id = auth.uid()
      ))
    )
  );
create policy "admin delete only" on support_ticket_replies
  for delete using (is_admin());

-- ---------------------------------------------------------------------
-- 3. Grants -- in this migration, not a later one.
--
-- RLS decides which rows; grants decide whether the table is reachable at all.
-- A table with perfect policies and no grant answers every request with
-- "permission denied", and Supabase does not auto-expose new objects.
--
-- Three verbs, not four. The rule the grants block states is that a verb is
-- granted only where a policy backs it, and 20260812143407 made that rule
-- exception-free by revoking the last dead one. A new append-only table that
-- took the four-verb default would re-open exactly that defect on day one.
--
-- USAGE on the sequence, never SELECT: nextval() is all a serial insert needs,
-- and SELECT on a sequence hands out last_value -- a free row count.
--
-- service_role needs nothing explicit; it holds the blanket
-- `grant all on all tables in schema public`.
-- ---------------------------------------------------------------------
grant select, insert, delete on support_ticket_replies to authenticated;
grant usage on sequence support_ticket_replies_id_seq to authenticated;

-- ---------------------------------------------------------------------
-- 4. Its own audit trigger function, not log_cross_agent_change().
--
-- That function reads `agent_id` by name out of to_jsonb(NEW/OLD)
-- (20260811160000:63-77). This table has no such column -- author_id records
-- who spoke, and ownership lives on the parent -- so the read yields NULL,
-- `actor is distinct from null` is true for every caller, and every reply
-- including a rep's own would log a cross_agent_insert. That is the noise
-- 20260811143000:109-111 exists to avoid.
--
-- Skipping the trigger was the other option and it is wrong here: an admin
-- replying on a rep's ticket is exactly the event this mechanism records, and
-- no write to support_tickets accompanies it, so the parent's trigger does not
-- fire either.
--
-- Fail-closed, like its sibling: no EXCEPTION block, so a failed audit insert
-- rolls back the reply that triggered it.
-- ---------------------------------------------------------------------
create or replace function log_cross_agent_reply()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor         uuid := auth.uid();
  ticket_owner  uuid;
  reply         jsonb;
begin
  -- Branch before touching either record. OLD is NOT ASSIGNED on an INSERT and
  -- NEW is not on a DELETE, and reading the wrong one raises "record is not
  -- assigned yet" -- which would break every reply. Same trap
  -- log_cross_agent_change() opens with a comment about.
  if TG_OP = 'DELETE' then
    reply := to_jsonb(OLD);
  else
    reply := to_jsonb(NEW);
  end if;

  select agent_id into ticket_owner
    from support_tickets
   where id = (reply ->> 'ticket_id')::int;

  -- A rep's own replies on their own ticket are ordinary work. Everything else
  -- -- an admin answering, or a rep somehow reaching another book -- is what
  -- the trail is for.
  if actor is distinct from ticket_owner then
    insert into audit_log (actor_id, action, table_name, row_id)
    values (
      actor,
      case TG_OP when 'DELETE' then 'cross_agent_delete'
                 when 'UPDATE' then 'cross_agent_update'
                 else 'cross_agent_insert' end,
      TG_TABLE_NAME,
      reply ->> 'id'
    );
  end if;

  -- AFTER trigger: the return value is ignored.
  return null;
end;
$$;

-- Not granted to anyone, like its sibling: a trigger function is invoked by the
-- trigger, running as its owner. Postgres grants EXECUTE to PUBLIC on every new
-- function, so these lines are what close it.
revoke all on function log_cross_agent_reply() from public;
revoke all on function log_cross_agent_reply() from anon, authenticated;

create trigger support_ticket_replies_audit_cross_agent
  after insert or update or delete on support_ticket_replies
  for each row execute function log_cross_agent_reply();

-- ---------------------------------------------------------------------
-- 5. Index.
--
-- The policy reaches its check through support_tickets, and the thread is
-- always read by ticket_id, so every read and write filters on this column.
-- ---------------------------------------------------------------------
create index idx_support_ticket_replies_ticket on support_ticket_replies(ticket_id);
