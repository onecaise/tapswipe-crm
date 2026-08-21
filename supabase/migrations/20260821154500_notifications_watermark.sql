-- The topbar bell: a per-user watermark, and the one narrow RPC that moves it.
--
-- Mirrors docs/tapswipe_crm_schema.sql, which is the spec.
--
-- components/app-topbar.tsx has carried a presentational bell since it was
-- written, with an `unreadCount` prop that had no caller and a comment saying
-- "there is no notifications table yet". This migration is the answer to that,
-- and the answer is that there still is no notifications table -- there is one
-- timestamp per user, and everything the bell shows is derived from comparing it
-- to created_at on tables that already exist.

-- ---------------------------------------------------------------------
-- 1. The watermark column.
--
-- On profiles rather than in a table of its own, for the reason
-- must_change_password gives: requireUser() already loads this row on every
-- request, so reading it costs nothing, while a side table would need RLS, four
-- policies and its own grants to hold a single timestamp per user.
--
-- The deeper reason is that there is nothing per-item to store. No notification
-- rows are created, so none can be orphaned when a ticket is deleted, none can
-- drift out of step with the record they describe, and none need a cleanup job.
-- Dismissing an item in the panel is therefore client-only state by
-- construction rather than by omission -- there is no server-side row it could
-- delete even if it wanted to.
--
-- Nullable, with no default, and both halves matter:
--
--   * NULL is a real state meaning "has never opened the panel". Callers read
--     coalesce(last_viewed_notifications_at, created_at), so a new rep sees what
--     has arrived since their account existed rather than every ticket ever
--     filed. That rule lives in mark_notifications_viewed() so it cannot be
--     applied inconsistently.
--   * `default now()` would have been wrong in the opposite direction: every
--     existing profile would be stamped as having just read everything, so
--     whatever was genuinely new at deploy time would be swallowed silently.
--     Backfilling to created_at would be wrong too -- for an account opened a
--     year ago it means a first click that dumps a year of history.
-- ---------------------------------------------------------------------
alter table profiles add column if not exists last_viewed_notifications_at timestamptz;

-- ---------------------------------------------------------------------
-- 2. mark_notifications_viewed()
--
-- The third instance of the pattern established by update_own_full_name and
-- clear_must_change_password (20260805103000): one column, the caller's own
-- row, `security definer` purely because profiles has no UPDATE policy for
-- anyone. It takes no arguments, so there is no way to name another user's row
-- -- the ownership check is structural rather than written out.
--
-- It RETURNS THE PREVIOUS VALUE, which is why this is an RPC rather than a
-- select followed by an update from the client. Opening the panel has to do two
-- things that must not come apart: report what is new, and record that it has
-- been seen. Split across two client round trips, a ticket created between them
-- is marked read without ever being displayed -- once, silently, and
-- unreproducibly. Returning the old watermark makes it read-and-advance in one
-- statement, and guarantees the same value is never handed out twice.
--
-- Gated on is_active_agent(), which despite its name means "any active user",
-- admins included (see 20260805103000). Matching update_own_full_name. A
-- deactivated user is bounced by requireUser() and has no readable rows anyway,
-- so the gate costs nothing -- it is here so this cannot become the one write a
-- deactivated session can still land.
--
-- No audit_log row, unlike set_user_role() or set_agent_number(). Those record
-- one person changing something another person can see. A private read receipt
-- is not that, and a row per bell click would bury the trail that matters.
-- ---------------------------------------------------------------------
create or replace function mark_notifications_viewed()
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  previous timestamptz;
begin
  if not is_active_agent() then
    raise exception 'account is deactivated';
  end if;

  -- Read BEFORE the write, deliberately. `returning` on an UPDATE yields the
  -- NEW row, so returning the column from the update below would hand back
  -- now() and the panel would always render empty. Two statements inside one
  -- plpgsql body are still one transaction, so this costs nothing in atomicity.
  select coalesce(last_viewed_notifications_at, created_at)
    into previous
    from profiles
   where id = auth.uid();

  -- No `for update` above. Two concurrent clicks from the same user both
  -- advance the watermark to a now() a millisecond apart, and each panel shows
  -- the items its own call returned. There is no state to corrupt here, only a
  -- receipt to overwrite with a near-identical one.
  update profiles
     set last_viewed_notifications_at = now()
   where id = auth.uid();

  return previous;
end;
$$;

-- Postgres grants EXECUTE to PUBLIC (which includes anon) on every new
-- function, and there is no declarative backstop for it -- see the grants note
-- in docs/tapswipe_crm_schema.sql. Without these two lines this is callable
-- unauthenticated, where auth.uid() is null: is_active_agent() would be false
-- and it would raise, so the damage is nil, but the surface must stay
-- greppable and tests/rls/grants.test.ts pins it.
revoke all on function mark_notifications_viewed() from public;
grant execute on function mark_notifications_viewed() to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 3. What is deliberately NOT here.
--
-- No read function. The panel's contents are two ordinary Tier 1 selects
-- (`support_tickets` and `ghost_sheets`, filtered on created_at) issued through
-- the caller's own client, merged in TypeScript. RLS is therefore the entire
-- authorization story: an agent's bell shows their own new rows, an admin's
-- shows the company's, with no role branch anywhere in the query.
--
-- That is the same choice search_crm made and for the same reason. A
-- notifications feed is exactly the shape of thing that becomes a disclosure
-- bug, and a `security definer` reader -- even one added later just to join
-- agent names onto the list -- would silently widen every rep's bell to every
-- rep's records. Leaving it as plain selects means there is no function whose
-- prosecdef could be flipped.
--
-- No grants either: both tables already grant select to `authenticated`
-- (20260811143000), and no new table exists to grant.
-- ---------------------------------------------------------------------
