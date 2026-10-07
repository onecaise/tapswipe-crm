-- =====================================================================
-- Tapswipe Internal CRM — final schema for a fresh Supabase project
-- Modeled on the ISO Hub feature set: Dashboard, Merchants, Pre-Apps,
-- Leads, Ghost Sheets, Support Tickets, Document Center, My Submissions.
--
-- Access rule, everywhere: role = 'admin' sees every row; everyone else
-- (role = 'agent') sees only rows where agent_id = auth.uid().
-- Enforced via Postgres Row Level Security using Supabase's auth.uid().
-- =====================================================================

-- ---------------------------------------------------------------------
-- PROFILES (extends Supabase's built-in auth.users 1-to-1)
-- ---------------------------------------------------------------------
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  -- The sign-in address, copied here by create-user.
  --
  -- A denormalised copy of auth.users.email, which is the authority. It exists
  -- because the Manage Users page had no way to show one: auth.users is not
  -- reachable from the Data API at all, so listing emails would otherwise mean
  -- a whole new admin Edge Function, and without them two reps with the same
  -- full_name are indistinguishable in the only screen that manages accounts.
  --
  -- Safe to denormalise only because nothing in this app changes an email after
  -- creation -- there is no email-change flow, and GoTrue's would bypass this
  -- column. If one is ever added, it has to write here too, and this comment is
  -- the reason why. Nullable because rows created before this column exists
  -- have no value to backfill from within a migration that cannot see
  -- auth.users at plan time (the migration does backfill it; the column stays
  -- nullable so a future service-role insert that omits it fails visibly on
  -- the page rather than at the database).
  email text,
  role text not null default 'agent' check (role in ('agent', 'admin')),
  is_active boolean not null default true,
  -- Set by create-user and admin-reset-password, cleared by
  -- clear_must_change_password() once the rep sets their own. This is what makes
  -- §8's "forced to set a real password on first login" real rather than a
  -- convention: the (app) route-group layout redirects to /auth/update-password
  -- while it is true, so an admin-known temporary password cannot survive as a
  -- working credential.
  --
  -- A column rather than auth.users.app_metadata because requireUser() already
  -- loads this row on every request, so reading it costs nothing, and because a
  -- column is assertable in the hermetic test suite where app_metadata is not.
  must_change_password boolean not null default false,
  -- The rep's identifier in a processor's residual report, as it appears in the
  -- "Agent #" column of the monthly XLSX. This is the only join between that
  -- file and this database: the spreadsheet has never heard of a uuid.
  --
  -- Nullable, and staying that way. Every profile that predates this column has
  -- no number, and there is nothing to backfill from -- a migration that invents
  -- agent numbers would be inventing the key that decides who gets paid. An
  -- admin fills them in from Manage Users, or on the import review screen when
  -- an unrecognised number turns up (RESIDUALS_SPEC §8.3).
  --
  -- Text, not int. Processor codes are not arithmetic: leading zeros are
  -- significant ('0471' is not 471), and some carry letters. Nothing adds or
  -- compares them numerically.
  --
  -- Uniqueness is a partial index rather than a column constraint -- see below.
  agent_number text,
  -- The rep's sales territory, as a label for grouping and reporting. Free
  -- text, and deliberately NOT a check-constrained vocabulary: this is
  -- reference data an admin extends as the company opens a region, the same
  -- reasoning support_tickets.category / sub_category / priority stay free
  -- text. Nothing computes on it -- no policy reads it, no query groups by it
  -- in SQL, no import resolves through it -- so a vocabulary would buy nothing
  -- but a migration every time someone opens an office.
  --
  -- Contrast agent_number directly above, which looks like the same shape of
  -- thing and is not: that one is a join key with a uniqueness rule and a
  -- length cap because a processor's file is matched against it. This is a
  -- label. One rep per agent number; any number of reps per territory.
  --
  -- NOT AN ACCESS BOUNDARY, and this is the line to hold. RLS scopes every
  -- agent_id table by `agent_id = auth.uid()`, and nothing anywhere reads
  -- territory to decide what a caller may see. "Agents see their whole
  -- territory" is a different and much larger feature -- it would rewrite the
  -- own-row half of every policy on all seven owner tables, turn a per-row
  -- check into a join against profiles, and need an answer for a rep whose
  -- territory changes while holding live deals. If that is ever wanted, it is
  -- its own migration with its own policy tests. Adding territory to a policy
  -- as a convenience, without that work, silently widens every rep's book.
  --
  -- Nullable, for the reason agent_number is: every profile predating the
  -- column has none and there is nothing to backfill from. Blank is normalised
  -- to null by set_territory() rather than stored, so "not assigned" has one
  -- representation instead of two that render identically and compare unequal.
  territory text,
  -- The rep this rep reports to. A nullable self-reference, exactly one hop
  -- deep, and NOT a role.
  --
  -- The NINETEENTH reference to profiles(id), and the ONE deliberate exception
  -- to the NO ACTION pattern the other eighteen share. Those are NO ACTION
  -- because what they carry is evidence -- an audit row, a ledger row, a record
  -- a rep owns -- and dropping the pointer silently would drop the meaning with
  -- it, so the delete is made to fail until a person decides what happens to
  -- the evidence. This column is not evidence. It is a current fact about who
  -- reports to whom, and a manager leaving the company should not block
  -- deleting their profile the way an unresolved payout row correctly does. The
  -- honest post-condition is "these reps now report to nobody", which is what
  -- `on delete set null` writes. Chosen rather than inherited:
  -- tests/rls/user-imports.test.ts counts nineteen AND names this column as the
  -- single exception, so a twentieth arriving with a non-default ON DELETE
  -- still goes red.
  --
  -- NOT A THIRD ROLE, and this is the line to hold. `role` stays
  -- ('agent','admin'). Every policy in this file is a binary is_admin() check
  -- -- around forty of them, plus the hand-written guard at the top of every
  -- `security definer` RPC -- so a third role would need either a third branch
  -- in all of them or a manages() helper called alongside is_admin()
  -- everywhere. That is a rewrite of the access-control design, not a column,
  -- and this column is deliberately the cheap half: it records the structure
  -- without granting anything.
  --
  -- NOT AN ACCESS BOUNDARY either -- the same line territory holds directly
  -- above, for the same reason and with the same consequence if it is crossed.
  -- Nothing reads manager_id to decide what a caller may see. What it makes
  -- possible is FILTERING by an admin who already sees every row
  -- (`agent_id in (select id from profiles where manager_id = $1)` in a
  -- dashboard query); it changes nothing about what a rep, or a manager, can
  -- see of their own accord. "A manager sees their reps' books" is the larger
  -- feature territory's note describes, with the same cost: it rewrites the
  -- own-row half of all seven owner tables. tests/rls/set-manager.test.ts greps
  -- pg_policies for the word and asserts zero hits.
  --
  -- EXACTLY ONE HOP, enforced by set_manager() in both directions: a rep who
  -- already has a manager cannot be made one, and a rep who is already
  -- somebody's manager cannot be given one. Together those rule out chains and
  -- cycles by construction, which is what keeps "does X manage Y" a single
  -- equality instead of a recursive CTE. The rule lives in the RPC rather than
  -- in a CHECK because a CHECK constraint cannot see another row.
  --
  -- No index, for the reason territory has none: profiles is small, Manage
  -- Users reads all of it anyway, and nothing resolves a rep THROUGH this
  -- column the way the residuals import resolves one through agent_number.
  manager_id uuid references profiles(id) on delete set null,
  -- When this user last opened the notifications panel behind the topbar bell.
  -- Everything the bell reports is derived from this one comparison: a support
  -- ticket or ghost sheet with created_at greater than this is "new to me".
  --
  -- A column on profiles rather than a notifications table, for the reason
  -- must_change_password gives above: requireUser() already loads this row on
  -- every request, so reading it is free, and a table would need its own RLS,
  -- its own four policies and its own grants to hold one timestamp per user.
  -- There is also nothing to store per item -- no notification rows are ever
  -- created, so none can go stale, be missed, or need cleaning up. The two
  -- source tables already carry the timestamps, and this is the watermark.
  --
  -- NULLABLE, and null is a real state meaning "has never opened it". Read it
  -- as coalesce(last_viewed_notifications_at, created_at) -- the profile's own
  -- creation date -- so a rep who has never opened the panel sees what arrived
  -- since their account existed rather than the entire history of the company.
  -- Defaulting the column to now() instead would have been wrong in the other
  -- direction: every existing profile would be marked as having just read
  -- everything, silently swallowing whatever was genuinely new at deploy time.
  --
  -- Advanced ONLY by mark_notifications_viewed() below. It is never written by
  -- a client, because profiles has no update policy at all.
  last_viewed_notifications_at timestamptz,
  created_at timestamptz default now()
);

-- One rep per agent number, but many reps with none.
--
-- A plain `unique` would in fact allow multiple NULLs too (Postgres does not
-- treat NULLs as equal), so this is not correcting a mistake -- it is stating
-- the intent, and not indexing the nulls that every existing row carries.
--
-- Load-bearing for the residuals import: the whole resolution step is a lookup
-- of one agent number expecting at most one rep. Two reps sharing a number
-- would make it ambiguous which of them a merchant's residual belongs to, and
-- the import would have no honest answer.
create unique index if not exists profiles_agent_number_key
  on profiles (agent_number) where agent_number is not null;

-- Role-check helper used in every policy below. security definer avoids
-- recursive RLS lookups (a policy on profiles querying profiles itself).
create or replace function is_admin()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and role = 'admin' and is_active
  );
$$;

-- Deactivation must actually block a user's OWN-ROW access, not just their
-- ability to pass is_admin(). Without this, a deactivated agent who is
-- still logged in (or who logs back in before their auth.users row is
-- separately banned) can still read/write their own merchants, leads, etc.
-- Every "own row" branch of every policy below is gated on this, not just
-- on agent_id matching.
create or replace function is_active_agent()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and is_active
  );
$$;

alter table profiles enable row level security;

create policy "read own profile or admin reads all" on profiles
  for select using (id = auth.uid() or is_admin());

-- SELECT is the ONLY policy on profiles. There is deliberately no insert,
-- update or delete policy for `authenticated` — the same treatment the three
-- *_secrets tables get, and for the same reason: this is the table that decides
-- who is an admin, so it has no client write path at all.
--
-- profiles are inserted by the create-user Edge Function (service role), never
-- directly by a client. Deletes never happen at all (§8: deactivation, never
-- deletion).
--
-- On the missing UPDATE policy specifically. There used to be an
-- "admin manages profiles" policy here, `for update using (is_admin()) with
-- check (is_admin())`. It was removed by the 11 Aug security audit, because an
-- admin could use it to PATCH /rest/v1/profiles directly and thereby walk past
-- every guard inside set_user_role() below — the role vocabulary, the
-- no-self-demotion block that makes zero-active-admins unreachable, the
-- last-active-admin check — while writing no audit_log row at all, since
-- audit_log has no INSERT policy and a plain client write cannot log itself. It
-- also allowed setting is_active = false without the banned_until ban that
-- deactivate-user writes first, producing exactly the shown-inactive-but-usable
-- state that ordering exists to prevent.
--
-- Agents never had an own-row update policy either, for the narrower version of
-- the same reason: it would let them try to set their own role to 'admin'.
--
-- Every write to profiles is therefore a `security definer` RPC
-- (update_own_full_name, clear_must_change_password, set_user_role) or a
-- service-role Edge Function (create-user, deactivate-user,
-- admin-reset-password) — each of which either touches one column of the
-- caller's own row, or writes an audit_log row as part of the same statement.
--
-- FORWARD CONSTRAINT: a future "admin edits a rep's name" feature needs a new
-- narrow RPC, not a policy. Re-adding an UPDATE policy here re-opens all of the
-- above. Pinned by tests/rls/manage-users.test.ts, which asserts pg_policies
-- holds no UPDATE policy on this table.

create or replace function update_own_full_name(new_full_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_active_agent() then
    raise exception 'account is deactivated';
  end if;
  update profiles set full_name = new_full_name where id = auth.uid();
end;
$$;

-- Clears the forced-password-change flag for the caller's own row, and nothing
-- else. Same shape and same reasoning as update_own_full_name above: there is no
-- self-update policy on profiles, so this is the only way a rep can retire their
-- own temporary password, and it can only ever touch this one column.
--
-- Deliberately NOT gated on is_active_agent(). A deactivated user cannot reach
-- this anyway (they cannot log in), and a gate here would mean a rep whose
-- account was switched off mid-password-change is left with the flag stuck on.
create or replace function clear_must_change_password()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update profiles set must_change_password = false where id = auth.uid();
end;
$$;

-- ---------------------------------------------------------------------
-- MARK NOTIFICATIONS VIEWED — advances the caller's own watermark, and
-- returns the value it replaced.
--
-- Third instance of the same narrow pattern as update_own_full_name and
-- clear_must_change_password: one column, the caller's own row, `security
-- definer` only because profiles has no update policy for anyone. It cannot
-- name another user's row -- there is no parameter to name one with.
--
-- RETURNS THE PREVIOUS VALUE, and that is the whole point of it being an RPC
-- rather than two statements. Opening the panel has to do two things that must
-- not come apart: report what is new, and record that it has been seen. Doing
-- them as a separate read and write leaves a window in which a ticket created
-- between them is marked as read without ever being shown -- silently, and
-- exactly once, so nobody could reproduce it. Returning the old watermark makes
-- the read-and-advance atomic: the caller lists items created after the value
-- it got back, and that value can never be handed out twice.
--
-- coalesce(..., created_at) is applied here rather than left to the caller, so
-- the "never opened it" rule lives in one place. It is also why this returns a
-- non-null timestamptz.
--
-- Gated on is_active_agent() -- which despite the name means "any active user",
-- admins included -- matching update_own_full_name. A deactivated user has no
-- readable rows for the panel to show and is bounced by requireUser() long
-- before this, so the gate costs nothing; it is here so the function cannot
-- become the one write a deactivated session can still land.
--
-- No audit_log row. The other definer functions here write one when they change
-- something another person can see; a private read receipt is not that, and
-- one row per bell click would bury the trail that matters.
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
  -- NEW row, so returning the column directly from the update below would hand
  -- back now() and the panel would always render empty. Two statements in one
  -- plpgsql body are still atomic -- the function is a single transaction -- so
  -- this buys correctness without giving up the read-and-advance guarantee.
  select coalesce(last_viewed_notifications_at, created_at)
    into previous
    from profiles
   where id = auth.uid();

  -- `for update` is not needed above: two concurrent bell clicks from the same
  -- user would both advance the watermark to a now() a millisecond apart, and
  -- the loser's items are shown in the panel it already returned. There is no
  -- state to corrupt, only a receipt to overwrite with a near-identical one.
  update profiles
     set last_viewed_notifications_at = now()
   where id = auth.uid();

  return previous;
end;
$$;

-- ---------------------------------------------------------------------
-- SET USER ROLE — Tier 2, promoting or demoting from the Manage Users
-- screen.
--
-- An Edge Function would work but is the wrong tier: this needs no
-- service-role key and no Auth Admin API, only a server-side admin check
-- and an audit row, which is precisely §9's Tier 2. `security definer` is
-- required because audit_log has no INSERT policy for `authenticated`;
-- bundling both writes here means the role change and its audit row cannot
-- come apart.
--
-- This is now the ONLY way a role can change. It used to be one of two: the
-- "admin manages profiles" UPDATE policy allowed the same change from the
-- client with no trail, which made `security definer` here look like
-- redundancy over the policy rather than what it actually is. That policy is
-- gone (see the profiles block above), so every guard below is unavoidable
-- rather than merely preferable.
--
-- Three guards beyond is_admin(), in order:
--
--   1. The role vocabulary, so this cannot write a value the CHECK
--      constraint would then have to catch.
--   2. No self-demotion. An admin demoting themselves loses the screen
--      they are standing on, mid-session, with no way back. This is the
--      load-bearing guard: it is what makes zero active admins
--      unreachable, and zero active admins is the only unrecoverable
--      state in the whole user-management surface -- nobody could create
--      users, promote anyone, or reach /admin/users, and recovery is a
--      hand-written SQL statement in the dashboard, the manual bootstrap
--      §8 says should apply to admin #1 only.
--   3. No demoting the last active admin.
--
-- Guard 3 is UNREACHABLE as written, and that is worth stating plainly
-- rather than leaving as a puzzle for the next reader. is_admin() means
-- the caller is an active admin, and guard 2 means the caller is not the
-- target, so an active admin other than the target always exists. It is
-- kept as depth for the plausible future edit that relaxes guard 2 once a
-- second admin exists, at which point guard 3 becomes the check that
-- stops the last one going. No test claims to exercise it, because any
-- such test would really be exercising guard 2.
-- ---------------------------------------------------------------------
create or replace function set_user_role(target_user_id uuid, new_role text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target profiles;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  if new_role not in ('agent', 'admin') then
    raise exception 'role must be agent or admin' using errcode = 'PT400';
  end if;

  if target_user_id = auth.uid() then
    raise exception 'you cannot change your own role' using errcode = 'PT409';
  end if;

  select * into target from profiles where id = target_user_id;
  if not found then
    raise exception 'user not found' using errcode = 'PT404';
  end if;

  -- Nothing to do, and nothing worth an audit row that says a role changed
  -- when it did not.
  if target.role = new_role then
    return;
  end if;

  if new_role = 'agent' then
    if not exists (
      select 1 from profiles
       where role = 'admin' and is_active and id <> target_user_id
    ) then
      raise exception 'cannot demote the last active admin'
        using errcode = 'PT409';
    end if;
  end if;

  update profiles set role = new_role where id = target_user_id;

  -- Distinct verbs rather than one 'set_user_role' plus a detail column,
  -- because audit_log has no detail column and the direction is the whole
  -- point of the entry.
  insert into audit_log (actor_id, action, table_name, row_id)
  values (
    auth.uid(),
    case when new_role = 'admin'
         then 'promote_user_to_admin'
         else 'demote_user_to_agent' end,
    'profiles',
    target_user_id::text
  );
end;
$$;

-- ---------------------------------------------------------------------
-- SET AGENT NUMBER — Tier 2, the same shape as set_user_role above and
-- for the same two reasons: profiles has no UPDATE policy at all, and
-- audit_log has no INSERT policy for `authenticated`.
--
-- This is a commission key. Which rep an agent number points at decides
-- who gets paid for a merchant's residual, so a change here is worth a
-- trail even though the column looks like an innocuous label -- and
-- bundling the write with its audit row means the two cannot come apart.
--
-- Deliberately NOT guarded against a self-target, unlike set_user_role.
-- An admin who also carries a book has an agent number like anyone else,
-- and setting their own is an ordinary act that removes no privilege and
-- loses them no screen. The guard there exists to make zero-active-admins
-- unreachable; there is no equivalent trap here.
--
-- Passing null (or blank, or whitespace) clears the number. Empty string
-- is normalised to null rather than stored, because '' is a value the
-- unique index would enforce: the second rep cleared that way would
-- collide with the first and the error would name a constraint nobody
-- typed.
--
-- The duplicate check below is for the message, not the guarantee. The
-- partial unique index on profiles is the authority and closes the race;
-- this exists so an admin reads "already assigned to another rep" rather
-- than a raw index violation on a screen where they cannot see the other
-- rep's row.
-- ---------------------------------------------------------------------
create or replace function set_agent_number(
  target_user_id uuid,
  new_agent_number text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  normalised text;
  target profiles;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  normalised := nullif(btrim(coalesce(new_agent_number, '')), '');

  -- Matches isAgentNumber() in supabase/functions/_shared/admin-users.ts, which
  -- create-user applies to the same column. Both sides trim and cap at 32; keep
  -- them in step.
  if normalised is not null and length(normalised) > 32 then
    raise exception 'agent number must be 32 characters or fewer'
      using errcode = 'PT400';
  end if;

  select * into target from profiles where id = target_user_id;
  if not found then
    raise exception 'user not found' using errcode = 'PT404';
  end if;

  -- `is not distinct from` rather than `=`, so clearing an already-empty number
  -- is the no-op it looks like instead of falling through to write an audit row
  -- saying something changed.
  if target.agent_number is not distinct from normalised then
    return;
  end if;

  if normalised is not null and exists (
    select 1 from profiles
     where agent_number = normalised and id <> target_user_id
  ) then
    raise exception 'agent number % is already assigned to another rep',
      normalised using errcode = 'PT409';
  end if;

  update profiles set agent_number = normalised where id = target_user_id;

  -- Distinct verbs, for the reason set_user_role gives: audit_log has no detail
  -- column, so "which direction" has to live in `action` or be lost.
  insert into audit_log (actor_id, action, table_name, row_id)
  values (
    auth.uid(),
    case when normalised is null
         then 'clear_agent_number'
         else 'set_agent_number' end,
    'profiles',
    target_user_id::text
  );
end;
$$;

-- ---------------------------------------------------------------------
-- set_territory(target_user_id uuid, new_territory text)
--
-- The same shape as set_agent_number above, and it exists for the same
-- structural reason rather than as a matter of taste: profiles has no
-- UPDATE policy at all, so there is no client write path to this column
-- even for an admin. A `security definer` RPC with a hand-written
-- is_admin() guard is the ONLY way a new profiles column becomes
-- settable, and that is the pattern to copy -- not a policy.
--
-- Audited despite being a label. Not because territory decides anything
-- (it decides nothing -- see the column comment), but because the write
-- path is admin-only and every admin action on another person's profile
-- leaves a trail. log_cross_agent_change() does that for the seven owner
-- tables; profiles is not one of them, so each of these RPCs writes its
-- own row. `security definer` bundles the update and the audit insert
-- into one statement so they cannot come apart.
--
-- Blank clears, normalised to null rather than stored. No unique index
-- forces this the way it does for agent_number -- many reps share a
-- territory -- but "unassigned" having two representations that render
-- identically and compare unequal is its own bug, and `where territory
-- is null` is how any report will ask the question.
--
-- No duplicate check and no length cap beyond the 64 below: nothing
-- resolves through this column, so there is no ambiguity to prevent and
-- no second system whose limit has to be matched. The cap is only so a
-- pasted paragraph fails as a readable message rather than becoming a
-- table cell nobody can read.
--
-- NOT guarded against a self-target. An admin who also carries a book has
-- a territory like anyone else, and setting their own removes no
-- privilege -- the same reasoning set_agent_number gives, and the
-- opposite of set_user_role, whose self-guard is what makes
-- zero-active-admins unreachable.
-- ---------------------------------------------------------------------
create or replace function set_territory(
  target_user_id uuid,
  new_territory text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  normalised text;
  target profiles;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  normalised := nullif(btrim(coalesce(new_territory, '')), '');

  if normalised is not null and length(normalised) > 64 then
    raise exception 'territory must be 64 characters or fewer'
      using errcode = 'PT400';
  end if;

  select * into target from profiles where id = target_user_id;
  if not found then
    raise exception 'user not found' using errcode = 'PT404';
  end if;

  -- `is not distinct from` rather than `=`, so clearing an already-empty
  -- territory is the no-op it looks like rather than falling through to an
  -- audit row claiming something changed.
  if target.territory is not distinct from normalised then
    return;
  end if;

  update profiles set territory = normalised where id = target_user_id;

  -- Distinct verbs rather than one action, for the reason set_user_role and
  -- set_agent_number both give: audit_log has no detail column, so the
  -- direction lives in `action` or is lost.
  insert into audit_log (actor_id, action, table_name, row_id)
  values (
    auth.uid(),
    case when normalised is null
         then 'clear_territory'
         else 'set_territory' end,
    'profiles',
    target_user_id::text
  );
end;
$$;

-- ---------------------------------------------------------------------
-- set_manager(profile_id uuid, manager_id_input uuid)
--
-- The same shape as set_territory and set_agent_number above, and it exists
-- for the same structural reason: profiles has no UPDATE policy and no UPDATE
-- grant for `authenticated`, so a `security definer` RPC with a hand-written
-- is_admin() guard is the only way a column there becomes settable. Do not
-- answer this with a policy -- the missing UPDATE policy is the design.
--
-- Null clears. There is no separate "unassign" verb and no tombstone: a rep
-- reporting to nobody is the default state, not an error state.
--
-- FOUR guards beyond is_admin(), and the last two are the whole reason this
-- is an RPC rather than a column an admin could PATCH:
--
--   1. The target profile exists. Without it a typo'd uuid is a silent no-op
--      that reports success.
--   2. No self-management. Nothing breaks if a rep manages themselves -- it is
--      a one-row cycle the queries would simply never terminate on -- but it
--      is never a true statement about an org chart, and permitting it means
--      "who reports to A" has to filter A out of its own answer forever.
--   3. The proposed manager has no manager of their own.
--   4. The target is not already somebody's manager.
--
-- Three and four are the same rule read in its two directions, and BOTH are
-- needed to get what either alone suggests. Guard 3 alone blocks building a
-- chain downward (giving B a manager when B already reports to A); it does
-- nothing about building the same chain upward -- set_manager(A, C) with A
-- already managing B would leave C -> A -> B, two hops, with guard 3 happy
-- because C reports to nobody. Guard 4 closes that direction. With both, the
-- graph can only ever be one layer of managers over a flat set of reps, and
-- cycles of any length are unreachable: a two-cycle needs the second call to
-- pass guard 3 against a row that already has a manager, and anything longer
-- needs a chain that cannot be built.
--
-- That flatness is a deliberate limit rather than a simplification to fix
-- later. A chain makes "is X somebody's manager" a recursive query and makes
-- every reporting filter a transitive closure, which is a real amount of
-- machinery for something nothing here needs -- the use is an admin narrowing
-- a dashboard to one manager's reps.
--
-- Audited, for the reason set_territory is: profiles is not one of the seven
-- tables log_cross_agent_change() covers, so each of these RPCs writes its own
-- row, and `security definer` bundles the update and the audit insert into one
-- statement so they cannot come apart. Distinct verbs, because audit_log has
-- no detail column and the direction lives in `action` or is lost.
--
-- NOT guarded against the admin targeting themselves. The same reasoning
-- set_territory and set_agent_number give and the opposite of set_user_role:
-- an admin who also carries a book reports to somebody like anyone else, and
-- naming a manager removes no privilege from them. (Guard 2 still applies --
-- they cannot report to themselves, but nobody can.)
-- ---------------------------------------------------------------------
create or replace function set_manager(
  profile_id uuid,
  manager_id_input uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $
declare
  target profiles;
  proposed profiles;
  manages_someone boolean;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  select * into target from profiles where id = profile_id;
  if not found then
    raise exception 'user not found' using errcode = 'PT404';
  end if;

  if manager_id_input is not null then
    if manager_id_input = profile_id then
      raise exception 'a user cannot manage themselves' using errcode = 'PT400';
    end if;

    -- Existence and guard 3 in one read: a manager who is not in profiles is
    -- `not found` here rather than a foreign-key violation at the update, so
    -- the caller gets 'manager not found' instead of a constraint name.
    select * into proposed from profiles where id = manager_id_input;
    if not found then
      raise exception 'manager not found' using errcode = 'PT404';
    end if;

    if proposed.manager_id is not null then
      raise exception 'manager reporting lines are one level deep'
        using errcode = 'PT400';
    end if;

    -- Guard 4, the same rule from the other end. Checked even when the target
    -- already has this exact manager, because the short-circuit below runs
    -- after it: a row that somehow holds a manager AND manages someone is a
    -- state this function must never confirm as acceptable.
    select exists (select 1 from profiles where manager_id = profile_id)
      into manages_someone;
    if manages_someone then
      raise exception 'manager reporting lines are one level deep'
        using errcode = 'PT400';
    end if;
  end if;

  -- `is not distinct from` rather than `=`, so clearing a manager nobody had
  -- is the no-op it looks like rather than an audit row claiming a change.
  if target.manager_id is not distinct from manager_id_input then
    return;
  end if;

  update profiles set manager_id = manager_id_input where id = profile_id;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (
    auth.uid(),
    case when manager_id_input is null
         then 'clear_manager'
         else 'set_manager' end,
    'profiles',
    profile_id::text
  );
end;
$;

revoke all on function clear_must_change_password() from public;
grant execute on function clear_must_change_password() to authenticated, service_role;
revoke all on function set_user_role(uuid, text) from public;
grant execute on function set_user_role(uuid, text) to authenticated, service_role;
revoke all on function set_agent_number(uuid, text) from public;
grant execute on function set_agent_number(uuid, text) to authenticated, service_role;
revoke all on function set_territory(uuid, text) from public;
grant execute on function set_territory(uuid, text) to authenticated, service_role;
revoke all on function set_manager(uuid, uuid) from public;
grant execute on function set_manager(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- MERCHANTS
-- ---------------------------------------------------------------------
create table merchants (
  id serial primary key,
  agent_id uuid references profiles(id) not null,
  mid text unique,
  dba text not null,
  legal_business_name text,
  status text not null default 'active' check (status in ('active', 'inactive', 'other')),
  processor text,
  split_agent_pct numeric(5,2),
  split_company_pct numeric(5,2),
  -- Which pre-app was approved into this merchant, when one was. The foreign
  -- key is added after pre_apps exists, below. Nullable and staying that way:
  -- merchants are also created by hand, and every row that predates this
  -- column has no pre-app to point at.
  pre_app_id int,
  date_added date default current_date,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  -- The same rule pre_apps carries, arrived at the other way round. pre_apps
  -- has enforced it since the beginning and the wizard derives the company
  -- half from the agent half, so an approved merchant is always consistent.
  -- A hand-edited one was not: the merchant form takes both numbers as free
  -- input, and 60/45 saved without complaint.
  --
  -- Declared `not valid` deliberately. Existing rows are not checked, because
  -- nobody can say from here whether a 60/45 row is a typo or a deal someone
  -- actually struck, and a migration that rewrites commission figures on its
  -- own authority is worse than one that leaves them alone. Every insert and
  -- every update from here on is checked. Run
  --   select id, dba, split_agent_pct, split_company_pct from merchants
  --    where coalesce(split_agent_pct, 0) + coalesce(split_company_pct, 0) <> 100
  --      and (split_agent_pct is not null or split_company_pct is not null);
  -- to list what predates it, then `validate constraint` once they are settled.
  --
  -- Both-null stays legal: a merchant whose split is simply not recorded yet
  -- is an ordinary state, and NULL + NULL would otherwise be forced to 100.
  constraint merchants_split_totals_100 check (
    (split_agent_pct is null and split_company_pct is null)
    or coalesce(split_agent_pct, 0) + coalesce(split_company_pct, 0) = 100
  ) not valid
);

alter table merchants enable row level security;

create policy "select own or admin" on merchants
  for select using ((agent_id = auth.uid() and is_active_agent()) or is_admin());
create policy "insert own" on merchants
  for insert with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());
create policy "update own or admin" on merchants
  for update using ((agent_id = auth.uid() and is_active_agent()) or is_admin())
  with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());
create policy "admin delete only" on merchants
  for delete using (is_admin());

-- ---------------------------------------------------------------------
-- LEADS
-- ---------------------------------------------------------------------
create table leads (
  id serial primary key,
  agent_id uuid references profiles(id) not null,
  lead_source text,
  merchant_legal_name text,
  dba text,
  contact_name text,
  contact_phone text,
  business_phone text,
  mobile_phone text,
  contact_email text,
  address text,
  city text,
  state text,
  country text,
  zip text,
  next_followup_date date,
  probability_to_close text,
  preferred_communication_method text,
  industry_vertical text,
  website text,
  -- A real vocabulary as of 20261002, replacing bare `text default 'open'`.
  --
  -- The old comment here argued that a vocabulary living only in TypeScript was
  -- free to drift from the column's contents, and that was true — so the answer
  -- is to put the vocabulary in the column, not to keep the column shapeless.
  -- Both other filtered statuses (merchants, pre_apps) are constrained; this
  -- was the holdout, and what it actually bought was a column holding 'open',
  -- NULL, and whatever each rep typed into a free-text <input>.
  --
  -- NOT NULL is load-bearing, exactly as it is on pre_apps.status and
  -- support_tickets.status: a CHECK evaluates to NULL for a NULL input, and a
  -- CHECK that evaluates to NULL PASSES. Without `not null`, `set status = null`
  -- is accepted and defeats both the vocabulary and every filter built on it.
  -- The two clauses are one mechanism, not a constraint plus a nicety.
  --
  -- Seven values, and no 'won'. A lead's win is derived — an approved pre_app
  -- or a merchant pointing back at it — never hand-set, which is the same
  -- reasoning dashboard_counts() already uses for active_leads: a status column
  -- a rep edits and a funnel position the records themselves prove are
  -- different facts, and storing the second as the first lets them disagree.
  -- 'application_sent' is as far as this column goes; what happens to that
  -- application is pre_apps.status's business.
  --
  -- 'nurturing' is not a failure and not a stage — it is a lead parked on a
  -- long timer, which is why it sits outside the otherwise forward order.
  --
  -- The vocabulary itself is the named CHECK below rather than a column
  -- constraint here, because there are two rules on the same column pair and
  -- both carry a review query worth keeping next to them.
  status text not null default 'new',
  -- Required when, and only when, status = 'lost'. Same shape as
  -- pre_apps.decline_reason: a terminal state that owes the next person reading
  -- the record an explanation, enforced by the database rather than by whichever
  -- form happened to write the row.
  --
  -- btrim'd in the CHECK because '' is a value — a column that is `not null`
  -- when lost but accepts a single space enforces nothing anyone cares about.
  lost_reason text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Both constraints are named rather than inline so a test can match on the name
-- and say which rule it caught, instead of matching a generic /check|violates/.
--
-- BOTH SHIP `not valid`, for the reason merchants_split_totals_100 does: they
-- bind every insert and update from here on and leave existing rows alone.
-- `leads.status` was a free-text <input> for its whole life, so real rows hold
-- 'open', NULL, and arbitrary rep-typed strings. NULL and 'open' map to 'new'
-- with no judgement required and the migration rewrites those; anything else is
-- a human's words about a specific deal, and a migration that guesses at them
-- loses information no backup brings back. List what is left with
--   select id, agent_id, dba, status from leads
--    where status not in ('new', 'contacted', 'qualified', 'proposal_sent',
--                         'application_sent', 'nurturing', 'lost')
--    order by status, id;
-- fix those rows THROUGH THE APP (so the cross-agent audit trigger sees them
-- and so the rep who typed the value is the one choosing its replacement),
-- then `alter table leads validate constraint leads_status_vocabulary;` in a
-- follow-up migration.
--
-- leads_lost_reason_required is `not valid` for a narrower reason: nothing
-- stopped a rep typing the literal word 'lost' into the old free-text column,
-- and those rows have no lost_reason because the column did not exist. They
-- surface in the same review query. Its own check is
--   select id, agent_id, dba from leads
--    where status = 'lost' and (lost_reason is null or btrim(lost_reason) = '');
alter table leads
  add constraint leads_status_vocabulary check (status in (
    'new', 'contacted', 'qualified', 'proposal_sent', 'application_sent',
    'nurturing', 'lost'
  )) not valid,
  add constraint leads_lost_reason_required check (
    status <> 'lost' or (lost_reason is not null and btrim(lost_reason) <> '')
  ) not valid;

-- NOTE ON TRANSITIONS: leads deliberately has NO state-machine trigger, unlike
-- pre_apps (pre_apps_guard_transitions). Sales moves backwards as a matter of
-- course — qualified back to contacted when a champion leaves — and no lead
-- stage has a consequence the way a pre-app approval does, which creates a
-- merchant. A guard here would stop a rep undoing a mis-click and nothing else.
--
-- The trail is already covered: leads is one of the seven tables carrying
-- log_cross_agent_change(), so an admin moving someone else's lead is audited.
-- Do not add a second trigger for it.

alter table leads enable row level security;

create policy "select own or admin" on leads
  for select using ((agent_id = auth.uid() and is_active_agent()) or is_admin());
create policy "insert own" on leads
  for insert with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());
create policy "update own or admin" on leads
  for update using ((agent_id = auth.uid() and is_active_agent()) or is_admin())
  with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());
create policy "admin delete only" on leads
  for delete using (is_admin());

-- ---------------------------------------------------------------------
-- GHOST SHEETS
-- ---------------------------------------------------------------------
create table ghost_sheets (
  id serial primary key,
  agent_id uuid references profiles(id) not null,
  -- on delete set null so deleting a lead doesn't require first unpicking every
  -- ghost sheet that points at it. Without it the FK defaults to NO ACTION and
  -- an admin simply cannot delete a converted lead. Note lead_id is the
  -- authoritative record of conversion state, so a sheet whose lead is deleted
  -- correctly reverts to unconverted.
  lead_id int references leads(id) on delete set null,
  dba text,
  contact_name text,
  contact_phone text,
  notes text,
  status text default 'open',
  created_at timestamptz default now()
);

alter table ghost_sheets enable row level security;

create policy "select own or admin" on ghost_sheets
  for select using ((agent_id = auth.uid() and is_active_agent()) or is_admin());
create policy "insert own" on ghost_sheets
  for insert with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());
create policy "update own or admin" on ghost_sheets
  for update using ((agent_id = auth.uid() and is_active_agent()) or is_admin())
  with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());
create policy "admin delete only" on ghost_sheets
  for delete using (is_admin());

-- ---------------------------------------------------------------------
-- PRE-APPS — parent record. Non-sensitive fields only; billing_type and
-- bank_name live here (harmless on their own), routing/account numbers
-- do not (see pre_app_banking_secrets below).
-- ---------------------------------------------------------------------
create table pre_apps (
  id serial primary key,
  agent_id uuid references profiles(id) not null,
  -- `on delete set null` for the same reason as ghost_sheets.lead_id: this
  -- records provenance, not a dependency. Without it an admin cannot delete a
  -- lead any pre-app points at. Never CASCADE here -- deleting a lead must not
  -- delete a merchant application.
  lead_id int references leads(id) on delete set null,
  -- `not null` is load-bearing, not tidiness: a CHECK that evaluates to NULL
  -- passes, so without it `set status = null` is accepted and defeats the
  -- whole state machine (and every status filter) silently.
  status text not null default 'draft' check (status in ('draft', 'submitted', 'approved', 'declined')),
  date_submitted date,
  -- Set by decline_pre_app() so the rep knows what to fix. Cleared by the
  -- next successful submit_pre_app().
  decline_reason text,

  -- business info
  dba_name text not null,
  legal_business_name text not null,
  contact_name text,
  contact_phone text,
  physical_address text,
  city text,
  state text,
  country text,
  zip text,
  phone_number text,
  fax_number text,
  email_address text,
  website text,

  -- business type
  state_incorporated text,
  legal_entity_type text,
  business_type text,
  sub_business_type text,
  business_start_date date,
  ein_type text,
  ein_number text,
  goods_sold text,

  -- banking (non-sensitive half — see pre_app_banking_secrets for the rest)
  billing_type text check (billing_type in ('gross', 'net')),
  bank_name text,

  -- Sales volume, as estimated by the merchant at application time.
  --
  -- All four are optional and all are independent. No cross-field rule is
  -- enforced: not high >= average, not monthly * 12 = annual. These are rough
  -- numbers a merchant gives in conversation, and a form that rejected an
  -- inconsistent set would refuse honestly-filled applications. Underwriting
  -- reconciles them; this table records what was said. Same stance as the
  -- moto_pct / internet_pct pair on pre_app_business_profile, which is captured
  -- and deliberately never summed against anything.
  --
  -- One monthly figure, not one per card brand. A merchant estimating at
  -- application time knows roughly what they turn over; asking them to split it
  -- across Visa, Mastercard, Discover and Amex invites four guesses where one
  -- was wanted, and the brand mix is the processor's to report afterwards.
  --
  -- `est_` prefixed because rep_payout_rows.average_ticket already exists and
  -- means something different: the ACTUAL figure for a merchant in a period,
  -- read off the processor's monthly residual report. An estimate given at
  -- application time and a measurement taken afterwards must not read alike,
  -- and `average_ticket` on its own does not say which it is.
  --
  -- numeric(14,2) matches those columns, so an estimate and an actual can be
  -- compared without a cast. Non-negative because a negative here is a typo and
  -- nothing else -- unlike total_cost and residual_income over there, which are
  -- deliberately signed because clawbacks make a negative month real.
  est_annual_volume  numeric(14,2) check (est_annual_volume  >= 0),
  est_monthly_volume numeric(14,2) check (est_monthly_volume >= 0),
  est_average_ticket numeric(14,2) check (est_average_ticket >= 0),
  est_high_ticket    numeric(14,2) check (est_high_ticket    >= 0),

  -- Commission split between the rep and Tapswipe, recorded by the rep who
  -- knows the deal terms and copied into merchants by approve_pre_app(). The
  -- standard deal is 50/50; it is 100/0 when the CEO is the one on the sale.
  -- Without these columns approve_pre_app leaves merchants.split_*_pct NULL
  -- and an admin has to retype terms the pre-app already captured.
  split_agent_pct numeric(5,2) not null default 50,
  split_company_pct numeric(5,2) not null default 50,
  constraint pre_apps_split_sums_to_100
    check (split_agent_pct + split_company_pct = 100),

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table pre_apps enable row level security;

create policy "select own or admin" on pre_apps
  for select using ((agent_id = auth.uid() and is_active_agent()) or is_admin());
create policy "insert own" on pre_apps
  for insert with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());
create policy "update own or admin" on pre_apps
  for update using ((agent_id = auth.uid() and is_active_agent()) or is_admin())
  with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());
create policy "admin delete only" on pre_apps
  for delete using (is_admin());

-- merchants.pre_app_id, deferred to here because merchants is declared before
-- pre_apps and a forward reference will not create. `on delete set null` for
-- the same reason ghost_sheets.lead_id uses it: pre_apps has an admin-only
-- DELETE policy, and without an action that delete fails against any merchant
-- approved from the row. The merchant is the durable record and outlives its
-- application; losing the provenance pointer is the correct trade.
alter table merchants
  add constraint merchants_pre_app_id_fkey
  foreign key (pre_app_id) references pre_apps(id) on delete set null;

create index idx_merchants_pre_app_id on merchants(pre_app_id);

-- ---------------------------------------------------------------------
-- PRE-APP OWNERS — non-sensitive ownership fields (name, address, %
-- owned, ID type/number, DOB). Normal RLS: reps fill this in directly.
-- SSN lives separately in pre_app_owner_secrets, below.
-- ---------------------------------------------------------------------
create table pre_app_owners (
  id serial primary key,
  -- `on delete cascade` here and on every pre-app child: pre_apps has an
  -- admin-only DELETE policy, but without a referential action that delete
  -- fails with a foreign-key violation, and an admin cannot clear the
  -- children first (pre_app_owner_secrets is not granted to anyone). The
  -- cascade runs as the constraint owner and so bypasses RLS, which is what
  -- makes deleting an owner who has an SSN on file work at all.
  pre_app_id int references pre_apps(id) on delete cascade not null,
  owner_name text,
  title text,
  id_type text,
  id_number text,
  id_issue_date date,
  id_expiration_date date,
  id_state text,
  dob date,
  home_phone text,
  percent_owned numeric(5,2),
  length_of_ownership text,
  home_address text,
  home_city text,
  home_state text,
  home_country text,
  home_zip text
);

alter table pre_app_owners enable row level security;

create policy "select via parent pre_app" on pre_app_owners
  for select using (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  );
create policy "insert via parent pre_app" on pre_app_owners
  for insert with check (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  );
-- The `with check` is spelled out rather than left to Postgres reusing the
-- USING expression. Same effect, but the parent tables state it explicitly
-- and a reader should not have to know that rule to see that re-parenting a
-- row to someone else's pre-app is blocked.
create policy "update via parent pre_app" on pre_app_owners
  for update using (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  )
  with check (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  );
-- Unlike most tables, delete is NOT admin-only here. A rep filling in the
-- form has to be able to remove an owner row they added by mistake, the same
-- exception `documents` makes for a rep's own uploads. Without this policy
-- the wizard's "Remove owner" cannot work at all.
create policy "delete via parent pre_app" on pre_app_owners
  for delete using (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  );

-- ---------------------------------------------------------------------
-- PRE-APP TERMINAL — non-sensitive terminal/POS setup questions.
-- rp_password lives separately in pre_app_terminal_secrets, below.
-- ---------------------------------------------------------------------
create table pre_app_terminal (
  id serial primary key,
  -- `unique` because this is one section of one form, not a collection. It is
  -- what lets the wizard autosave with upsert(onConflict: 'pre_app_id')
  -- instead of insert-or-update guesswork, and it is the only thing stopping
  -- a debounced save from quietly leaving two terminal rows behind.
  pre_app_id int references pre_apps(id) on delete cascade not null unique,
  batch_out_time time,
  terminal_type text,
  auto_batch boolean,
  communication_method text,
  dial_9_outside boolean,
  reprogram_terminal boolean,
  equipment_purchase boolean,
  equipment_rental boolean,
  next_day_funding boolean,
  tip_edit boolean,
  ebt boolean,
  fns_number text,
  tax_calculation boolean,
  tax_rate numeric(5,3),
  refund_policy text,
  print_refund_on_footer boolean,
  software_pos_integration boolean,
  software_name_version text,
  pricing_provided text,
  statement_analysis text,
  receipt_header_message text,
  receipt_footer_message text,
  mp_ap_name text,
  rp_name text
);

alter table pre_app_terminal enable row level security;

create policy "select via parent pre_app" on pre_app_terminal
  for select using (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  );
create policy "insert via parent pre_app" on pre_app_terminal
  for insert with check (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  );
create policy "update via parent pre_app" on pre_app_terminal
  for update using (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  )
  with check (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  );
create policy "delete via parent pre_app" on pre_app_terminal
  for delete using (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  );

-- ---------------------------------------------------------------------
-- PRE-APP BUSINESS PROFILE — card-mix percentages, notes. Not sensitive.
-- ---------------------------------------------------------------------
create table pre_app_business_profile (
  id serial primary key,
  -- unique for the same reason as pre_app_terminal.pre_app_id above.
  pre_app_id int references pre_apps(id) on delete cascade not null unique,
  card_swiped_pct numeric(5,2),
  card_keyed_pct numeric(5,2),
  card_present_pct numeric(5,2),
  card_not_present_pct numeric(5,2),
  moto_pct numeric(5,2),
  internet_pct numeric(5,2),
  test_product_type text,
  notes text
);

alter table pre_app_business_profile enable row level security;

create policy "select via parent pre_app" on pre_app_business_profile
  for select using (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  );
create policy "insert via parent pre_app" on pre_app_business_profile
  for insert with check (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  );
create policy "update via parent pre_app" on pre_app_business_profile
  for update using (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  )
  with check (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  );
create policy "delete via parent pre_app" on pre_app_business_profile
  for delete using (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  );

-- =====================================================================
-- SENSITIVE FIELD TABLES — SSN, routing/account number, terminal
-- password. RLS is enabled with NO policies for the authenticated role,
-- so direct client access is denied entirely, both read and write. The
-- only way in is a Supabase Edge Function using the service-role key
-- (which bypasses RLS by design) — that function holds the AES
-- encryption key as a secret and does the encrypt/decrypt itself. This
-- is true for the rep's *initial submission* of this data too: the
-- browser sends it to the Edge Function directly, never to these
-- tables via supabase-js.
-- =====================================================================

-- `unique` on the parent reference of all three: one row is the current
-- value. Without it, correcting a mistyped account number appends a second
-- ciphertext row and nothing in the schema says which one is live — the read
-- function would have to guess (and "order by id desc" is a convention a
-- future caller will forget). With it, submit-pre-app-secrets upserts and a
-- correction replaces.
--
-- `on delete cascade` so removing an owner or deleting a pre-app takes its
-- ciphertext with it. Note this is also the only way that delete can succeed:
-- these tables are granted to nobody, so no client can clear them first.

-- `key_version` on all three: the stored value is a bare
-- 12-byte IV || ciphertext || 16-byte GCM tag with no version field, so
-- nothing in the ciphertext says which key or algorithm produced it. Rotating
-- PRE_APP_SECRETS_KEY, or moving off AES-256-GCM, would otherwise leave every
-- row undecodable with no way to tell old from new. It cannot be backfilled
-- once real ciphertext exists, so it goes in before any is written.
--
-- Values travel over PostgREST as the `\x`-hex text form, NEVER base64:
-- bytea_in accepts a base64 string as the escape format and silently stores
-- its literal ASCII, so a base64 bug here is undetectable data destruction.

create table pre_app_owner_secrets (
  id serial primary key,
  pre_app_owner_id int references pre_app_owners(id) on delete cascade not null unique,
  ssn_encrypted bytea not null,
  key_version smallint not null default 1
);
alter table pre_app_owner_secrets enable row level security;
-- intentionally zero policies for `authenticated` — service role only

create table pre_app_banking_secrets (
  id serial primary key,
  pre_app_id int references pre_apps(id) on delete cascade not null unique,
  aba_routing_encrypted bytea not null,
  account_number_encrypted bytea not null,
  key_version smallint not null default 1
);
alter table pre_app_banking_secrets enable row level security;
-- intentionally zero policies for `authenticated` — service role only

create table pre_app_terminal_secrets (
  id serial primary key,
  pre_app_id int references pre_apps(id) on delete cascade not null unique,
  rp_password_encrypted bytea not null,
  key_version smallint not null default 1
);
alter table pre_app_terminal_secrets enable row level security;
-- intentionally zero policies for `authenticated` — service role only

-- ---------------------------------------------------------------------
-- DOCUMENTS — metadata only; file bytes live in Supabase Storage.
-- Not itself highly sensitive (a doc_type label + a storage key), so
-- normal RLS applies here; the actual signed URLs are still minted only
-- by the create-upload-url / create-download-url Edge Functions.
-- ---------------------------------------------------------------------
create table documents (
  id serial primary key,
  agent_id uuid references profiles(id) not null,
  owner_type text not null check (owner_type in ('pre_app', 'merchant', 'support_ticket', 'lead')),
  owner_id int not null,
  doc_type text not null,
  file_key text not null,
  file_name text,
  mime_type text,
  uploaded_at timestamptz default now()
);

-- file_key must be the storage key for THIS row's agent/owner/owner_id, not an
-- arbitrary string. The row is written by the browser (create-upload-url signs,
-- the client inserts), so without this every one of those four columns is
-- attacker-controlled, and only agent_id is checked -- by the insert policy,
-- against auth.uid().
--
-- That gap was a live cross-agent read, demonstrated against the running stack
-- before this constraint existed. Agent B inserts a documents row with
-- agent_id = B (so RLS is satisfied) and file_key = an object belonging to
-- agent A. create-download-url then resolves the row through B's own client,
-- sees a row B is entitled to, and signs the key it finds on it with the
-- service role. B downloads A's file. Nothing in the policies objects, because
-- the policies only ever look at agent_id -- the leak is that file_key was
-- never tied to it.
--
-- The same forgery on owner_id planted a row on another rep's merchant, where an
-- admin reading that merchant's page would see it as that rep's document. One
-- constraint closes both, because the key encodes all three.
--
-- starts_with() rather than LIKE: no pattern metacharacters to get wrong, and
-- owner_type contains an underscore ('pre_app', 'support_ticket'), which LIKE
-- would treat as a wildcard. It is immutable, so it is legal in a CHECK.
--
-- The two split_part() conjuncts make it a whole-key check rather than a prefix
-- one. Without them '<agent>/merchant/7/' passes (a directory, which signs a URL
-- that can never resolve) and so does '<agent>/merchant/7/a/b' (a nested key
-- create-upload-url would never mint). Neither crosses a trust boundary, so
-- they are here for the cheaper reason: fileKeyMatchesOwner() in
-- supabase/functions/_shared/documents.ts enforces the same rule in front of
-- Storage, and two layers that agree exactly are worth more than two that agree
-- approximately. split_part returns '' for a field that isn't there, which is
-- what makes "no fifth segment" expressible. The uuid itself is only required to
-- be non-empty -- it is random, and there is nothing to compare it to.
--
-- NOT VALID on purpose, and as a separate ALTER because CREATE TABLE has no
-- NOT VALID. Rows predating this were written by hand-rolled fixtures and dev
-- seeds with keys like 'k/3', and a validating constraint would make
-- `supabase db push` fail against whichever environment still has one.
-- documents has no UPDATE policy and no UPDATE grant, so a row can never be
-- edited into violating it -- which means NOT VALID still covers everything the
-- app is able to create.
--
-- Belt and braces: create-download-url re-derives the expected prefix and
-- refuses to sign a row that does not match, so a legacy row exempted here is
-- still not a usable read primitive.
alter table documents
  add constraint documents_file_key_matches_owner
  check (
    starts_with(
      file_key,
      agent_id::text || '/' || owner_type || '/' || owner_id::text || '/'
    )
    and split_part(file_key, '/', 4) <> ''
    and split_part(file_key, '/', 5) = ''
  ) not valid;

alter table documents enable row level security;

create policy "select own or admin" on documents
  for select using ((agent_id = auth.uid() and is_active_agent()) or is_admin());
create policy "insert own" on documents
  for insert with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());
create policy "delete own or admin" on documents
  for delete using ((agent_id = auth.uid() and is_active_agent()) or is_admin());
-- No UPDATE policy, and no UPDATE grant either (see the grants block). A
-- document is replaced by uploading a new one and deleting the old, so nothing
-- edits this row in place. The grant is revoked as well as the policy left out
-- because a policy-only omission fails the quiet way: the privilege check would
-- pass, RLS would filter the statement to zero rows, and a future edit
-- affordance would report a save that did nothing — the same trap `notes`
-- carried until 20260812143407 closed it there too. With the grant gone the
-- answer is "permission denied", at the layer where the decision actually
-- lives.
--
-- The delete policy is the standing exception to admin-only deletes: reps
-- remove their own uploads. That is also why documents needs the cross-agent
-- audit trigger despite its access being audited in the Edge Functions — see
-- the trigger block below.

-- ---------------------------------------------------------------------
-- SUPPORT TICKETS
-- ---------------------------------------------------------------------
create table support_tickets (
  id serial primary key,
  agent_id uuid references profiles(id) not null,
  merchant_id int references merchants(id),
  category text,
  sub_category text,
  priority text,
  serial_number_imei text,
  subject text not null,
  message text,
  -- Constrained, and NOT NULL, because the list page filters on it. Every
  -- filtered status here is now constrained — merchants, pre_apps, leads and
  -- this one. leads was the holdout until 20261002 and the argument for leaving
  -- it bare (a vocabulary living only in TypeScript drifts from the column) was
  -- answered by putting the vocabulary in the column instead. NOT NULL for the
  -- same reason pre_apps.status is: a CHECK that evaluates to NULL passes, so a
  -- nullable status silently defeats both the check and every filter built on
  -- it.
  --
  -- Three values, not four: 'pending' covers waiting on the merchant, the
  -- processor or a hardware RMA, and a separate 'resolved' before 'closed'
  -- would need a rule about who moves it between the two.
  status text not null default 'open' check (status in ('open', 'pending', 'closed')),
  -- category, sub_category, priority and serial_number_imei stay free text on
  -- purpose. They are reference data an admin will want to extend without a
  -- migration, and the form offers a native <datalist> of suggestions the same
  -- way documents-panel.tsx does for doc_type -- suggestions, not a constraint.
  created_at timestamptz default now()
);

alter table support_tickets enable row level security;

create policy "select own or admin" on support_tickets
  for select using ((agent_id = auth.uid() and is_active_agent()) or is_admin());
create policy "insert own" on support_tickets
  for insert with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());
create policy "update own or admin" on support_tickets
  for update using ((agent_id = auth.uid() and is_active_agent()) or is_admin())
  with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());
create policy "admin delete only" on support_tickets
  for delete using (is_admin());

-- ---------------------------------------------------------------------
-- CLOSING A TICKET IS ONE-WAY.
--
-- Closing needs no new access: the "update own or admin" policy above already
-- carries it, so the owning rep closes their own ticket and an admin closes
-- anyone's. That is the whole authorization story, and there is deliberately no
-- close_support_ticket() RPC -- nothing in a close touches something the caller
-- may not already touch, there is no side effect to keep on one path (contrast
-- approve_pre_app creating a merchant), and an admin closing someone else's
-- ticket is already audited by log_cross_agent_change().
--
-- What the policy cannot express is FINALITY. Reopening is refused, and neither
-- of the two declarative places can say so:
--
--   * RLS sees only the row as it will be. A policy's USING clause reads the
--     existing row but cannot compare it to NEW, so "was closed, is now open"
--     is not a statement it can make.
--   * A CHECK constraint sees one row in isolation. 'open' is a legal value on
--     its own -- what is illegal is arriving there FROM 'closed'.
--
-- So it is a BEFORE UPDATE trigger, for the same reason
-- pre_apps_guard_transitions() is one. That function is the near neighbour and
-- the differences are deliberate: it funnels status through four RPCs and blocks
-- every direct write, because a pre-app transition has consequences (a merchant
-- row, a decline reason, a submission date). This one blocks exactly one
-- transition and leaves open <-> pending alone, because a ticket moving between
-- "working it" and "waiting on someone" is ordinary traffic that happens several
-- times in a ticket's life.
--
-- `new.status <> 'closed'` rather than `new.status is distinct from old.status`:
-- the edit form PATCHes every field it renders, so saving a priority change on a
-- closed ticket sends status = 'closed' again. A guard that fired on any UPDATE
-- touching a closed row would make closed tickets wholly immutable, which is a
-- different (and unasked-for) decision -- and it would fail as an unexplainable
-- error on a form that never showed a status control.
--
-- The escape hatch for a mistaken close is the admin-only DELETE above, and it
-- is a poor one: it takes the reply thread with it (support_ticket_replies
-- cascades) and the follow-up is a new ticket. That is the accepted cost of
-- finality. If reopening is ever wanted, the honest change is a reopen path with
-- its own is_admin() guard and an audit_log row -- not loosening this trigger,
-- which would leave the transition unrecorded.
--
-- NOT security definer, and it does not need to be: it reads OLD and NEW, which
-- are handed to it, and calls nothing. `set search_path = public` regardless, so
-- a temp-table shadow cannot redirect anything it does resolve.
-- ---------------------------------------------------------------------
create or replace function support_tickets_guard_close()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.status = 'closed' and new.status <> 'closed' then
    raise exception 'a closed ticket cannot be reopened'
      using errcode = 'PT409';
  end if;

  return new;
end;
$$;

-- Privilege lines even for a trigger function: Postgres grants EXECUTE to
-- PUBLIC on every new function and PUBLIC includes anon. A trigger function is
-- harmless to call directly (it raises outside a trigger context), but the rule
-- in the grants block holds with no exceptions so the surface stays greppable.
revoke all on function support_tickets_guard_close() from public;
grant execute on function support_tickets_guard_close() to authenticated, service_role;

create trigger support_tickets_guard_close
  before update on support_tickets
  for each row execute function support_tickets_guard_close();

-- ---------------------------------------------------------------------
-- SUPPORT TICKET REPLIES — the conversation on a ticket.
--
-- A child of support_tickets rather than a use of `notes`, and the reason is
-- the policy rather than the shape. notes is scoped own-or-admin, so an admin's
-- reply on a rep's ticket would be invisible to the rep -- the one person who
-- has to read it. Replies are scoped through the PARENT instead: whoever can
-- see the ticket sees its replies, which is what makes this a conversation and
-- not two private monologues. (notes.owner_type also has no 'support_ticket'
-- member, and this is why it is not being given one.)
--
-- APPEND-ONLY, like notes and for the same reason: a reply is a record of what
-- was said, and the correction for a wrong one is another reply. No update
-- policy, and -- per the rule in the grants block -- no update grant either.
--
-- author_id is not an ownership column. It records who spoke; visibility comes
-- from the parent. That is why the insert policy pins it to auth.uid() rather
-- than trusting the client: without that conjunct a rep could post a reply
-- under the admin's name on their own ticket.
-- ---------------------------------------------------------------------
create table support_ticket_replies (
  id serial primary key,
  -- on delete cascade for the reason every pre-app child carries it: the
  -- parent's admin-only DELETE would otherwise fail on this FK.
  ticket_id int references support_tickets(id) on delete cascade not null,
  author_id uuid references profiles(id) not null,
  body text not null,
  created_at timestamptz default now()
);

alter table support_ticket_replies enable row level security;

-- Same shape as the pre_app children: is_admin() first and unqualified, and
-- is_active_agent() OUTSIDE the exists(), ANDed with it -- the activity check
-- is about the caller, not about the parent row.
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
-- NOTES & TASKS — generic, attach to any of lead / pre_app / merchant /
-- ghost_sheet via owner_type + owner_id.
--
-- owner_id carries NO foreign key, and cannot: it points into one of four
-- different tables depending on owner_type, which one column cannot
-- reference. Two consequences the database therefore cannot enforce, and
-- application code owns:
--
--   1. A row can be written against an owner_id that does not exist, or
--      that the writer cannot see -- the policies here check only
--      notes.agent_id / tasks.agent_id, never whether the *owner* is the
--      caller's. The damage is bounded (the author and admins are the only
--      readers, so a misfiled note is invisible to the owner's real owner
--      rather than leaked to them) but it is real. Insert paths pass
--      owner_type/owner_id from a server-rendered page that has already
--      loaded that parent row under RLS, never from client input.
--   2. Deleting an owner leaves its notes and tasks behind. There is no
--      cascade to hang them on, so they are orphans, invisible to every
--      page because no page asks for that owner_id any more.
-- ---------------------------------------------------------------------
create table notes (
  id serial primary key,
  agent_id uuid references profiles(id) not null,
  owner_type text not null check (owner_type in ('lead', 'pre_app', 'merchant', 'ghost_sheet')),
  owner_id int not null,
  body text not null,
  created_at timestamptz default now()
);

alter table notes enable row level security;

-- Notes are APPEND-ONLY by design: there is deliberately no update policy, so
-- a note can be written, and removed by an admin, but never silently rewritten.
-- A correction is a second note, which keeps the trail readable in order and
-- means a quoted note cannot have changed since it was quoted. This is the one
-- Tier 1 table without an update policy, so it reads like an omission -- it
-- isn't. The UPDATE grant is withheld as well (see the grants block), so the UI
-- must not offer an edit affordance and no longer can: the answer is
-- "permission denied for table notes" rather than a save that silently did
-- nothing.
create policy "select own or admin" on notes
  for select using ((agent_id = auth.uid() and is_active_agent()) or is_admin());
create policy "insert own" on notes
  for insert with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());
create policy "admin delete only" on notes
  for delete using (is_admin());

create table tasks (
  id serial primary key,
  agent_id uuid references profiles(id) not null,
  owner_type text not null check (owner_type in ('lead', 'pre_app', 'merchant', 'ghost_sheet')),
  owner_id int not null,
  title text not null,
  due_date date,
  completed boolean default false,
  created_at timestamptz default now()
);

alter table tasks enable row level security;

create policy "select own or admin" on tasks
  for select using ((agent_id = auth.uid() and is_active_agent()) or is_admin());
create policy "insert own" on tasks
  for insert with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());
-- Tasks DO get an update policy, unlike notes: `completed` is a checkbox whose
-- whole purpose is to be toggled back and forth, and due_date moves when a
-- callback slips.
create policy "update own or admin" on tasks
  for update using ((agent_id = auth.uid() and is_active_agent()) or is_admin())
  with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());
create policy "admin delete only" on tasks
  for delete using (is_admin());

-- ---------------------------------------------------------------------
-- BUG REPORTS — the floating report bubble, on every CRM page.
--
-- Ordinary Tier 1 shape: agent_id is the reporter, and the standard
-- own-or-admin policy scopes it. Naming the column agent_id rather than
-- reporter_id is deliberate and buys two things -- the policies are the same
-- ones as everywhere else, and log_cross_agent_change() works unchanged, so an
-- admin clearing a rep's report is audited with no new trigger function.
--
-- CLEARED BY STATUS, NOT BY DELETE. Checking a report off the admin list sets
-- status and stamps resolved_at / resolved_by; the list filters status = 'open'.
-- The same reasoning as deactivating a user instead of deleting them (§8): a
-- report is a description of something that went wrong, and it is worth more
-- after it has been dismissed than before -- when the same bug is reported
-- again, or when someone asks whether it was ever looked at. There is
-- deliberately NO delete policy and no delete grant.
--
-- The cost, stated so it is not discovered: the table only grows, and every
-- query that means "the queue" has to say `status = 'open'`. A list that
-- forgets the filter shows dismissed reports as live work rather than failing,
-- which is the quiet kind of wrong. lib/bug-reports.ts owns that filter in one
-- place for that reason.
--
-- `page` is free text, not a check constraint. It holds a route path, and
-- routes change with every feature -- a constraint would mean a migration each
-- time one is added, and a report filed against a path that no longer exists is
-- still worth reading.
-- ---------------------------------------------------------------------
create table bug_reports (
  id serial primary key,
  agent_id uuid references profiles(id) not null,
  page text not null,
  description text not null,
  -- Two ways to close, because they mean different things: 'resolved' is fixed,
  -- 'dismissed' is not-a-bug or won't-fix. Both leave the queue; only the first
  -- claims anything was done. NOT NULL for the reason support_tickets.status is:
  -- a CHECK that evaluates to NULL passes, so a nullable status silently defeats
  -- both the check and every filter built on it.
  status text not null default 'open'
    check (status in ('open', 'resolved', 'dismissed')),
  resolved_at timestamptz,
  resolved_by uuid references profiles(id),
  created_at timestamptz default now()
);

alter table bug_reports enable row level security;

create policy "select own or admin" on bug_reports
  for select using ((agent_id = auth.uid() and is_active_agent()) or is_admin());
-- Pinned to the caller rather than the usual own-or-admin shape: a bug report
-- is a first-hand account, so filing one under someone else's name is not a
-- thing an admin should be able to do either. is_active_agent() checks
-- is_active without checking role, so an active admin reporting their own bug
-- satisfies this too.
create policy "insert own" on bug_reports
  for insert with check (agent_id = auth.uid() and is_active_agent());
-- Admin-only, and this is the clear-from-the-list action. A rep cannot edit a
-- report after filing it -- including their own -- for the same reason notes are
-- append-only: the value is in what it said at the time.
create policy "admin resolves" on bug_reports
  for update using (is_admin()) with check (is_admin());
-- No delete policy, on purpose. See the header.

-- ---------------------------------------------------------------------
-- AUDIT LOG — who touched what, when. Populated from Edge Functions for
-- admin actions and sensitive-data access; optionally from triggers for
-- everything else.
-- ---------------------------------------------------------------------
create table audit_log (
  id serial primary key,
  actor_id uuid references profiles(id),
  action text not null,
  table_name text,
  row_id text,
  created_at timestamptz default now()
);

alter table audit_log enable row level security;

create policy "admin reads audit log" on audit_log
  for select using (is_admin());
-- writes come only from service-role Edge Functions / triggers, not clients

-- =====================================================================
-- REP PAYOUTS / RESIDUALS — the per-merchant monthly residual ledger,
-- plus the staging area an import waits in. Spec: RESIDUALS_SPEC.md.
--
-- Four tables, and the split between them is the design:
--
--   rep_payout_batches      one uploaded file
--   rep_payout_import_rows  its cells, as parsed, until they are clean
--   rep_payout_rows         the ledger -- clean, typed, committed
--   rep_payout_row_history  every change to the two money figures
--
-- Why a separate staging table rather than a `status` column on the
-- ledger: nothing lands in rep_payout_rows until every row of the batch
-- resolves, and a batch can wait days while someone creates a rep. With
-- one table and a status flag, every read, total, export and payout
-- summary would have to remember `where status = 'committed'` -- and the
-- one that forgot would show draft figures as real payouts. Here the
-- ledger has no draft state to filter out, because drafts are not in it.
--
-- What the processor supplies and what it does not. The monthly XLSX has
-- seven columns: Period, Agent #, MID, Merchant name, Volume, Average
-- ticket, Total cost. The two numbers that decide what a rep is owed --
-- residual income and the rep's split -- are worked out by hand and typed
-- in afterwards. So they are nullable, and null means "not worked out
-- yet" rather than zero. Everything downstream has to keep that
-- distinction: a period with blank figures is normal, not broken.
-- =====================================================================
create table rep_payout_batches (
  id serial primary key,
  -- The importing admin, and NOT called agent_id, deliberately.
  --
  -- Every other table here follows the rule that a new table carries
  -- `agent_id uuid references profiles(id) not null` so that the standard policy
  -- expression scopes it. A batch belongs to no rep at all -- it belongs to the
  -- file. Naming this column agent_id would make
  -- `(agent_id = auth.uid() and is_active_agent()) or is_admin()` accidentally
  -- MEANINGFUL here, and wrong: a rep would read a batch whenever an admin's uuid
  -- happened to match theirs. The rule exists to stop a rep-owned table from
  -- being unscoped, and this table has no rep to scope to.
  imported_by uuid references profiles(id) not null,
  -- Key in the `residual-imports` bucket, not the `documents` one. See the
  -- storage note at the end of this file for why it needed its own bucket.
  file_key text not null,
  file_name text not null,
  -- 'abandoned' exists because a batch is allowed to wait indefinitely: an
  -- unrecognised agent number can take a day to sort out. Without it the import
  -- page would accumulate stale 'review' rows with no way to say "not this one".
  status text not null default 'review'
    check (status in ('review', 'committed', 'abandoned')),
  row_count int not null default 0,
  uploaded_at timestamptz default now(),
  committed_at timestamptz
);

alter table rep_payout_batches enable row level security;

-- Admin-only, and only the two verbs a client actually performs: the import page
-- lists batches, and "Abandon batch" is a status update. There is deliberately
-- no INSERT policy -- batches are created by residual-import-file-url under the
-- service role, because the Storage key contains the batch id and so the row has
-- to exist before the upload does -- and no DELETE policy, because a batch is the
-- record that an import happened. Deleting one would throw away the provenance
-- the retained file exists to provide.
create policy "admin only select" on rep_payout_batches
  for select using (is_admin());
create policy "admin abandons" on rep_payout_batches
  for update using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------------------
-- REP PAYOUT IMPORT ROWS — staging.
--
-- Every cell is kept twice: once as the text the file actually contained
-- (*_raw) and once as the resolved, typed value. The review screen needs
-- both, because "Q3 2026" is only explicable next to the cell it came
-- from, and an admin comparing the screen to the spreadsheet is comparing
-- against the raw text.
--
-- The raw copy is also the reason a re-parse is safe to offer: nothing
-- here has been interpreted destructively, so parsing again after an
-- agent number is created reaches the same conclusions plus one.
-- ---------------------------------------------------------------------
create table rep_payout_import_rows (
  id serial primary key,
  batch_id int references rep_payout_batches(id) on delete cascade not null,
  -- 1-based spreadsheet row, so an error can name where to look. Not the array
  -- index: an admin fixing the file counts rows in Excel, where the header is
  -- row 1.
  row_number int not null,
  period_raw text,
  agent_number_raw text,
  mid_raw text,
  merchant_name_raw text,
  volume_raw text,
  average_ticket_raw text,
  total_cost_raw text,
  -- Absent from a fresh processor file; present when a round-trip export is fed
  -- back in to bulk-fill the figures. That asymmetry is the whole reason the
  -- commit step distinguishes "the file said nothing" from "the file said zero".
  residual_income_raw text,
  rep_split_raw text,
  -- Resolved values. Null wherever the raw text could not be resolved, in which
  -- case `blocker` says why.
  period date,
  agent_id uuid references profiles(id),
  merchant_id int references merchants(id) on delete set null,
  volume numeric(14,2),
  average_ticket numeric(14,2),
  total_cost numeric(14,2),
  residual_income numeric(14,2),
  rep_split_pct numeric(5,2),
  -- A code, so the UI can group and count, plus prose for the row itself. Only
  -- 'unknown_agent' is fixable from the review screen; the rest are file problems
  -- and the fix is a corrected upload.
  blocker text check (blocker in (
    'unknown_agent', 'unparseable_period', 'bad_number',
    'missing_mid', 'duplicate_in_file'
  )),
  error text
);

alter table rep_payout_import_rows enable row level security;

-- SELECT only. Every write comes from parse-residual-import or
-- commit-residual-import under the service role; the review screen reads, and the
-- one fixable blocker is fixed by re-parsing rather than by editing a staging
-- row. Granting the other verbs would be dead weight of exactly the kind the
-- GRANTS section warns about -- privilege check passes, RLS filters to nothing,
-- caller sees a save that did nothing.
create policy "admin only select" on rep_payout_import_rows
  for select using (is_admin());

-- ---------------------------------------------------------------------
-- REP PAYOUT ROWS — the ledger.
-- ---------------------------------------------------------------------
create table rep_payout_rows (
  id serial primary key,
  agent_id uuid references profiles(id) not null,
  -- Always the first of the month. The file says "Jul-26" or "07/2026" or an
  -- Excel serial; the parser normalises all of them, and an unparseable value
  -- blocks its row rather than guessing. Storing a date rather than the label
  -- means periods sort correctly and one period has exactly one spelling.
  period date not null,
  -- From the file, and authoritative. NOT a foreign key to merchants: a residual
  -- report legitimately contains merchants nobody has entered into the CRM, and
  -- blocking payroll over a data-entry gap is the wrong trade.
  mid text not null,
  merchant_name text,
  -- The soft link, resolved by MID lookup at import. Null when no merchant
  -- matched, which is an ordinary state and not an error. `set null` on delete so
  -- that deleting a merchant cannot wedge on an FK from the ledger.
  merchant_id int references merchants(id) on delete set null,
  -- Volume and average ticket must be non-negative: a negative there is a parse
  -- error, not a business fact.
  volume numeric(14,2) check (volume >= 0),
  average_ticket numeric(14,2) check (average_ticket >= 0),
  -- Cost and residual income are signed on purpose. Clawbacks and adjustments
  -- are real, a negative month happens, and a CHECK that rejected one would turn
  -- valid processor data into a blocked row nobody could explain.
  total_cost numeric(14,2),
  residual_income numeric(14,2),
  rep_split_pct numeric(5,2)
    check (rep_split_pct >= 0 and rep_split_pct <= 100),
  -- Derived, stored, and never independently editable -- which is the point. A
  -- third money column an admin could type into would eventually disagree with
  -- the two it is computed from, and there would be no way to tell which was
  -- right. Null when either input is null, which reads correctly as "not worked
  -- out yet" rather than as a payout of zero.
  rep_payout numeric(14,2) generated always as
    (round(residual_income * rep_split_pct / 100, 2)) stored,
  -- Provenance of the last write, not an ownership link. `set null` on delete so
  -- an old batch can be tidied away without taking ledger rows with it.
  batch_id int references rep_payout_batches(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  -- The merge key. A second upload for a period upserts on this, so re-importing
  -- a corrected file updates rows rather than duplicating them.
  --
  -- Keyed on agent_id rather than on the agent number the file carried:
  -- profiles.agent_number is unique so the two are equivalent today, but keying
  -- on the uuid means reassigning a number later does not orphan history.
  unique (period, agent_id, mid)
);

alter table rep_payout_rows enable row level security;

-- The one table in this group with the usual own-or-admin read: a rep sees their
-- own residuals. Everything that writes is admin-only, because the figures are
-- entered by whoever runs payouts, not by the rep being paid.
create policy "select own or admin" on rep_payout_rows
  for select using ((agent_id = auth.uid() and is_active_agent()) or is_admin());
-- Inline editing of the two money fields, and the per-agent bulk split.
create policy "admin only update" on rep_payout_rows
  for update using (is_admin()) with check (is_admin());
-- Whole-period delete, the escape hatch for an import that was simply wrong.
-- Individual rows are not deletable by design -- a wrong merchant line is a
-- correction, made by editing, which the history table then records.
create policy "admin only delete" on rep_payout_rows
  for delete using (is_admin());
-- No INSERT policy. Rows are created only by commit-residual-import under the
-- service role, the same arrangement profiles and audit_log have: a ledger of
-- what a processor reported should not be writable a row at a time from a
-- browser.

-- ---------------------------------------------------------------------
-- REP PAYOUT ROW HISTORY — old value, new value, who, when, for the two
-- figures a human types.
--
-- Corrections overwrite in place rather than appending superseding rows.
-- The alternative was considered and rejected: with immutable versions,
-- every read, export, total and payout summary would need a
-- latest-per-key filter, and the one that got it wrong would be a wrong
-- payout. This keeps the ledger simple to read and puts the trail beside
-- it.
--
-- Deliberately NOT reached by log_cross_agent_change(). On this table
-- every write is by definition an admin acting on a rep's row, so that
-- trigger would fire on 100% of writes -- forty audit_log rows for one
-- import -- and would still not record what the figure changed FROM,
-- because audit_log has no detail column. Same principle that excludes
-- documents from it: audit where the event is.
-- ---------------------------------------------------------------------
create table rep_payout_row_history (
  id serial primary key,
  -- NO foreign key, deliberately. The whole point is that this outlives its
  -- subject: deleting a period must not erase the record that its figures were
  -- edited, and `on delete cascade` would do exactly that while
  -- `on delete restrict` would make the period undeletable. Same
  -- no-FK-on-purpose shape as notes.owner_id and documents.owner_id.
  row_id int not null,
  -- Denormalised so a history row still says what it is about after the ledger
  -- row is gone. Without these, a surviving history row would be a value change
  -- attached to an integer that no longer resolves to anything.
  period date not null,
  agent_id uuid references profiles(id) not null,
  mid text not null,
  field text not null check (field in ('residual_income', 'rep_split_pct')),
  old_value numeric(14,2),
  new_value numeric(14,2),
  -- Nullable, for a genuine service-role write — exactly as audit_log.actor_id
  -- is. Nothing currently performs one: a commit goes through
  -- commit_residual_import(), which is `security definer` but still sees the
  -- caller's JWT claims, so auth.uid() is the committing admin and a round-trip
  -- import that fills in figures is attributed to them rather than to nobody.
  --
  -- Plain `references profiles(id)` with no ON DELETE, matching audit_log. That
  -- makes a user un-deletable while their history rows exist, which production
  -- never does (deactivation, never deletion) -- but a live test must clear these
  -- rows before deleting its users, or teardown fails on the FK.
  changed_by uuid references profiles(id),
  changed_at timestamptz default now()
);

alter table rep_payout_row_history enable row level security;

-- Admin-only, and SELECT-only. A rep reads their own figures; the edit history
-- behind them is a payroll-administration record, not a rep-facing one. No
-- insert, update or delete policy at all -- the trigger below is `security
-- definer` and so bypasses both RLS and grants, which is what lets this table
-- have no client write path whatsoever.
create policy "admin only select" on rep_payout_row_history
  for select using (is_admin());

-- ---------------------------------------------------------------------
-- log_payout_row_change() — writes the history rows above.
--
-- `security definer` for the same reason log_cross_agent_change() is:
-- rep_payout_row_history has no INSERT policy, so a security invoker
-- trigger would have its insert refused by RLS and would fail the
-- caller's UPDATE outright.
--
-- FAILS CLOSED, intentionally. AFTER ROW, no EXCEPTION block, so a
-- failure to record the change rolls back the change itself. Same trade
-- log_cross_agent_change() makes and for the same reason: nothing has
-- been handed over yet, so refusing the edit is both possible and
-- correct. An unrecorded change to a commission figure is worse than a
-- failed one, because the failure is visible and the gap is not.
--
-- One row per changed field, not one per statement, so "what changed"
-- needs no parsing. `is distinct from` rather than <> so that a change
-- to or from NULL -- which is most of the first edits, since both columns
-- arrive empty -- is recorded rather than skipped.
--
-- Only the two hand-entered columns are watched. The file-sourced columns
-- change on every re-import by design, and recording those would bury the
-- entries that matter under the ones that don't -- the same argument that
-- keeps a rep's own edits out of the cross-agent trail.
-- ---------------------------------------------------------------------
create or replace function log_payout_row_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.residual_income is distinct from old.residual_income then
    insert into rep_payout_row_history
      (row_id, period, agent_id, mid, field, old_value, new_value, changed_by)
    values (old.id, old.period, old.agent_id, old.mid, 'residual_income',
            old.residual_income, new.residual_income, auth.uid());
  end if;

  if new.rep_split_pct is distinct from old.rep_split_pct then
    insert into rep_payout_row_history
      (row_id, period, agent_id, mid, field, old_value, new_value, changed_by)
    values (old.id, old.period, old.agent_id, old.mid, 'rep_split_pct',
            old.rep_split_pct, new.rep_split_pct, auth.uid());
  end if;

  -- AFTER trigger: the return value is ignored.
  return null;
end;
$$;

revoke all on function log_payout_row_change() from public;
-- Deliberately NOT granted to authenticated: a trigger fires whether or not the
-- querying role holds EXECUTE. Same treatment as set_updated_at() and
-- log_cross_agent_change().

create trigger rep_payout_rows_log_changes
  after update on rep_payout_rows
  for each row execute function log_payout_row_change();

-- rep_payout_rows also carries updated_at, so it gets a set_updated_at trigger
-- too -- attached in the updated_at section below, with the other three, rather
-- than here: that function is defined further down this file.

-- ---------------------------------------------------------------------
-- commit_residual_import(batch_id_input int) — Tier 3.
--
-- Moves a reviewed batch's staging rows into the ledger. `security
-- definer` for three things the caller genuinely may not do:
-- rep_payout_rows has no INSERT policy, rep_payout_import_rows has no
-- DELETE policy, and audit_log has no INSERT policy at all.
--
-- The same shape as approve_pre_app, which this closely resembles: it
-- creates rows from a staged record, flips the parent's status, writes
-- audit_log, and guards itself with an explicit is_admin() because
-- `definer` bypasses RLS. Keep that guard if you edit this.
--
-- WHY THIS IS AN RPC AND NOT AN EDGE FUNCTION. It was specified as one,
-- and four things make SQL the better place:
--
--   1. Atomicity. supabase-js has no client-side transaction, so a
--      function would insert the ledger rows, then delete the staging
--      rows, then flip the status as three round trips -- with a real
--      window where a period is half-imported. Here it all lands or none
--      of it does, which for a commission import is not a nicety.
--   2. No pagination. PostgREST caps a response ([api] max_rows), so a
--      function would have to page through staging rows and would
--      silently import a prefix if anyone forgot. `insert ... select` has
--      no such limit.
--   3. The audit row fails closed for free. Inside the transaction a
--      failed audit_log insert rolls the import back, so the
--      best-effort/auditWriteFailed asymmetry submit-pre-app-secrets
--      needs simply does not arise -- nothing is written until commit.
--   4. auth.uid() survives `security definer` (it changes current_user,
--      not the session's JWT claims), so the history rows the upsert
--      triggers are attributed to the committing admin rather than to
--      nobody.
--
-- THE COALESCE IS THE WHOLE MERGE RULE. On conflict, file-sourced columns
-- are overwritten and the two hand-entered ones are
-- `coalesce(excluded.<col>, rep_payout_rows.<col>)` -- written only where
-- the file actually supplied a value. That is what lets a corrected
-- processor file be re-imported without wiping a month of typed-in
-- residuals, and lets this app's own round-trip export fill them in in
-- bulk. Reversing those two arguments would silently clear every figure
-- on every re-import, and nothing else here would notice.
-- ---------------------------------------------------------------------
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

-- =====================================================================
-- USER IMPORTS — bulk rep onboarding from a CSV.
--
-- Two tables, deliberately shaped like the residual import above:
--
--   user_import_batches  one submitted file
--   user_import_rows     its rows, as parsed, plus what happened to each
--
-- THE ONE STRUCTURAL DIFFERENCE FROM RESIDUALS IS THE WHOLE DESIGN, and
-- it is worth understanding before changing anything here.
--
-- commit_residual_import is a security definer RPC that moves staging
-- rows into the ledger in ONE TRANSACTION and DELETES them on success.
-- That is possible because everything it touches is in Postgres.
--
-- Creating an account is not. Each one is a GoTrue write (auth.users)
-- plus a Postgres write (profiles), in two different systems, with no
-- transaction spanning them -- so forty accounts is eighty operations
-- that can be interrupted at any point, and there is no "commit" that
-- either happens or does not.
--
-- So these staging rows are NOT deleted when the import completes. They
-- SURVIVE, each carrying its own outcome, and that makes the table the
-- progress ledger as well as the staging area. `outcome is null` is the
-- work list, which is the entire mechanism behind batch-level resume: a
-- run interrupted halfway is restarted by simply asking for the rows
-- that have no outcome yet. Do not "tidy up" by deleting committed
-- rows -- that would throw away the only record of what each row did,
-- and make a half-finished batch indistinguishable from a fresh one.
--
-- WHY THE FILE IS TEXT IN A COLUMN AND NOT AN OBJECT IN A BUCKET. A
-- residual report is a binary XLSX that can be megabytes, so it needed
-- Storage. A rep list is a few kilobytes of text, and a third private
-- bucket is not free: no migration can create one, `db reset` silently
-- drops them, and e2e/fixtures/seed.ts already fails to recreate
-- `residual-imports`. Keeping the submitted text on the batch row keeps
-- the provenance without adding a third thing to that gap, and it is
-- also what a re-read re-parses.
-- =====================================================================
create table user_import_batches (
  id serial primary key,
  -- The importing admin, and NOT called agent_id -- the same reasoning
  -- rep_payout_batches.imported_by records. A batch belongs to no rep,
  -- so naming this agent_id would make the standard own-or-admin policy
  -- expression accidentally MEANINGFUL here, and wrong: a rep would read
  -- a batch whenever an admin's uuid happened to match theirs.
  --
  -- NOTE: this is the EIGHTEENTH column in the schema referencing
  -- profiles(id), and like all seventeen before it, it is ON DELETE NO
  -- ACTION. Any leftover row blocks deleting a user, so the teardown
  -- list in scripts/seed-local-users.mjs has to know about it.
  imported_by uuid references profiles(id) not null,
  file_name text not null,
  -- The exact text submitted, kept verbatim. Provenance, and what the
  -- review screen's re-read parses again.
  source_text text not null,
  -- 'provisioning' exists because account creation is not atomic and a
  -- run can be interrupted: it marks a batch whose accounts are being
  -- created, so the UI can offer to resume rather than to start over.
  -- 'abandoned' is the escape hatch for a file that was simply wrong.
  status text not null default 'review'
    check (status in ('review', 'provisioning', 'committed', 'abandoned')),
  row_count int not null default 0,
  uploaded_at timestamptz default now(),
  committed_at timestamptz
);

alter table user_import_batches enable row level security;

-- Admin-only, and only the two verbs a client performs: the import page
-- lists batches, and "Abandon" is a status update. No INSERT policy --
-- stage-user-import creates the row under the service role. No DELETE --
-- a batch is the record that an import happened.
create policy "admin only select" on user_import_batches
  for select using (is_admin());
create policy "admin abandons" on user_import_batches
  for update using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------------------
-- USER IMPORT ROWS — staging, and then the per-row record of what
-- happened.
--
-- Every cell is kept twice: once as the text the file contained (*_raw)
-- and once as the resolved value. The review screen needs both, because
-- an admin comparing the screen against the file is comparing raw text,
-- and because it makes offering a re-read safe -- nothing has been
-- interpreted destructively.
-- ---------------------------------------------------------------------
create table user_import_rows (
  id serial primary key,
  batch_id int references user_import_batches(id) on delete cascade not null,
  -- 1-based file row, so an error can name where to look. Not the array
  -- index: an admin fixing the file counts rows in a spreadsheet, where
  -- the header is row 1.
  row_number int not null,

  full_name_raw text,
  email_raw text,
  role_raw text,
  agent_number_raw text,

  -- Resolved values, null wherever the raw text could not be resolved --
  -- in which case `blocker` says why.
  full_name text,
  email text,
  role text check (role in ('agent', 'admin')),
  agent_number text,

  -- A code so the UI can group and count; `error` carries the prose for
  -- the row itself.
  --
  -- Six of these BLOCK the batch. The last two -- email_exists and
  -- agent_number_taken -- deliberately do NOT: those rows are skipped
  -- and the rest of the file still imports. Accounts are independent of
  -- one another, unlike the rows of one period's ledger, so refusing
  -- forty onboardings because three people already have logins is the
  -- wrong trade. The split lives in isBlocking() in
  -- supabase/functions/_shared/user-imports.ts and lib/user-imports.ts.
  blocker text check (blocker in (
    'missing_name', 'invalid_email', 'invalid_role', 'invalid_agent_number',
    'duplicate_email_in_file', 'duplicate_agent_number_in_file',
    'email_exists', 'agent_number_taken'
  )),
  error text,

  -- What provisioning did with this row. Null means "not attempted yet",
  -- which is what makes this column the work list -- see the note above.
  outcome text check (outcome in
    ('created', 'resumed', 'skipped_duplicate', 'failed')),
  -- For 'failed', the Edge Function's own message. Never the generic
  -- "Edge Function returned a non-2xx status code", which would make a
  -- deactivated caller, a validation refusal and a real fault identical.
  outcome_detail text,

  -- The account this row produced. Deliberately NO foreign key, matching
  -- rep_payout_row_history.row_id: this record must outlive its subject,
  -- and an import row is provenance. A FK would also add a nineteenth
  -- door to the user-deletion problem for no benefit.
  user_id uuid,

  -- Set when provisioning left an auth.users row with no profiles row.
  -- No foreign key, and here it is IMPOSSIBLE rather than merely
  -- unwanted: an orphaned auth user is BY DEFINITION one with no
  -- profiles row, so a reference to profiles(id) could never be
  -- satisfied. Surfaced on the review screen, because that account can
  -- log in, lands on /auth/error?error=no-profile, and cannot self-heal.
  orphaned_auth_user uuid,

  provisioned_at timestamptz
);

alter table user_import_rows enable row level security;

-- SELECT only. Every write comes from stage-user-import or
-- provision-user-batch under the service role; the review screen reads,
-- and a blocked row is fixed by correcting the file and re-reading rather
-- than by editing a staging row. Granting the other verbs would be dead
-- weight of exactly the kind the grants block warns about -- privilege
-- check passes, RLS filters to nothing, caller sees a save that did
-- nothing.
create policy "admin only select" on user_import_rows
  for select using (is_admin());

-- Grants. Required, not optional: without these every one of these tables
-- answers every request with "permission denied", perfect policies and
-- all. The rule is that a verb is granted only where a policy backs it.
grant select, update on user_import_batches to authenticated;
grant select on user_import_rows to authenticated;

grant all on user_import_batches to service_role;
grant all on user_import_rows to service_role;

grant usage on
  user_import_batches_id_seq,
  user_import_rows_id_seq
to service_role;
-- And deliberately NOT to authenticated, for the reason audit_log_id_seq
-- is not: nothing `authenticated` can do consumes them, since neither
-- table grants it INSERT.

-- Staging is always read one batch at a time. The partial index is the
-- provisioning loop's hot query -- it asks for this batch's unprocessed
-- rows on every chunk.
create index idx_user_import_rows_batch on user_import_rows(batch_id);
create index idx_user_import_rows_pending
  on user_import_rows(batch_id) where outcome is null;

-- The cross-agent audit trigger is deliberately NOT attached to either
-- table, for both of the reasons the rep_payout_* tables record: neither
-- carries an agent_id at all, so log_cross_agent_change() would read NULL
-- and log everything (the support_ticket_replies trap), and nobody but an
-- admin can write them anyway. The trail is split by granularity instead:
-- audit_log gets one create_user or resume_create_user row per account
-- from provisionUser, plus one commit_user_import row per finished batch.

-- =====================================================================
-- MARKETING MATERIALS — the company's sell sheets, rate cards and
-- one-pagers, plus a per-lead record of what a rep actually did with
-- them.
--
-- WHY THIS IS NOT A NEW documents.owner_type. The same question
-- residual-imports answered, and the same answer, for a different
-- reason. `documents` is a table of REP-OWNED uploads: every row has an
-- agent_id, every policy compares it to auth.uid(), and the storage key
-- resolves a PARENT RECORD's owner (resolveParentAgentId). A marketing
-- material has no owning rep and no parent record -- it is a company
-- asset every rep reads and only an admin writes. Modelling it as a
-- document would mean either an agent_id that lies about who it belongs
-- to, or filing it under whichever admin uploaded it, which is a fact
-- about who clicked rather than about the asset.
--
-- It also needs something `documents` has no column for and no reason to
-- grow one: an engagement trail. "Which sell sheet did this rep send
-- this lead, and when" is the question the feature exists to answer, and
-- it is a different shape from "which files hang off this record".
--
-- So: two tables. One is reference data with no ownership at all; the
-- other is an append-only log that carries the ownership.
-- =====================================================================
create table marketing_materials (
  id serial primary key,
  -- NO agent_id, deliberately, and this is the one client-readable table
  -- in the schema where that is true. Every other table here is scoped by
  -- `agent_id = auth.uid()`; this one is company reference data, so its
  -- SELECT policy is "any active signed-in user" and there is nothing
  -- per-rep to compare. Adding an agent_id later would not be a widening
  -- of this table, it would be a different table.
  --
  -- The consequence to keep in mind: nothing about a material is private,
  -- so nothing private may be uploaded as one. That is a documented
  -- operating rule rather than something a policy can enforce, because
  -- the whole point is that every rep can read it.

  -- The "folder". Free text with no vocabulary, for the same reason
  -- support_tickets.category and profiles.territory are: this is
  -- reference data an admin extends when marketing produces a new kind of
  -- collateral, and a CHECK would mean a migration every time. The browse
  -- UI groups by whatever distinct values exist.
  category text not null,
  title text not null,

  -- Nullable, and that is load-bearing rather than lax. The row is created
  -- BEFORE the upload, because the storage key is {material_id}/{file_name}
  -- and the id has to exist first -- the same sequencing rep_payout_batches
  -- uses and for the same reason. A row with a null file_key is an upload
  -- that was started and never finished; the admin list shows it as
  -- incomplete rather than offering a download that would 404.
  file_key text,
  file_name text,
  mime_type text,

  -- The uploading admin. NOT called agent_id, exactly as
  -- rep_payout_batches.imported_by and user_import_batches.imported_by are
  -- not: naming it agent_id would make the standard own-or-admin policy
  -- expression accidentally MEANINGFUL here and wrong, handing a rep write
  -- access whenever an admin's uuid happened to match theirs.
  --
  -- NOTE: this is the TWENTIETH column in the schema referencing
  -- profiles(id), and like nineteen of the twenty-one it is ON DELETE NO
  -- ACTION. Any leftover row blocks deleting a user, so all four teardown
  -- lists have to know about it.
  uploaded_by uuid references profiles(id) not null,
  uploaded_at timestamptz default now(),

  -- Retirement is a timestamp, not a delete, and the reason is the events
  -- table below. A material's whole purpose is to be referenced by an
  -- engagement log; deleting one would either cascade that log away
  -- (destroying the record the feature exists to keep) or be blocked by
  -- the FK forever. Archiving drops it out of the rep-facing browse list
  -- while every event that names it stays readable. Same argument
  -- bug_reports makes for having no DELETE at all.
  --
  -- There is therefore NO delete path, in policy or in grant. If a file
  -- ever genuinely must be destroyed -- a wrong upload, a legal demand --
  -- that belongs in an Edge Function that removes the storage object too,
  -- the way delete-document does, and it will have to decide what happens
  -- to the events first. Leaving a client-side DELETE here would let
  -- someone make that decision by accident.
  archived_at timestamptz
);

-- file_key must be the key for THIS row's id. Nothing client-supplied
-- reaches this column today -- marketing-material-file-url creates the row
-- and writes the key under the service role, and `authenticated` holds no
-- grant on it -- which makes this narrower than
-- documents_file_key_matches_owner and worth having for a different
-- reason. That constraint closes a demonstrated cross-agent read; this one
-- pins an invariant the download path depends on, so a future "let an
-- admin re-point a file" shortcut cannot quietly make {material_id}/ mean
-- nothing.
--
-- Null passes, because the pre-upload row must be insertable. That is
-- spelled out as `file_key is null or ...` rather than left to a CHECK's
-- three-valued logic, so the next reader does not have to rediscover that
-- a NULL result passes.
--
-- Exactly two segments, neither empty -- so a traversal segment, a
-- trailing slash, or extra depth is rejected rather than half-understood.
-- fileKeyMatchesMaterial() in
-- supabase/functions/_shared/marketing-materials.ts enforces the same rule
-- in front of Storage; two layers that agree exactly are worth more than
-- two that agree approximately.
alter table marketing_materials
  add constraint marketing_materials_file_key_matches_id
  check (
    file_key is null
    or (
      starts_with(file_key, id::text || '/')
      and split_part(file_key, '/', 2) <> ''
      and split_part(file_key, '/', 3) = ''
    )
  );

alter table marketing_materials enable row level security;

-- SELECT for every active signed-in user, admin or rep. This is the only
-- select policy in the schema with no agent_id comparison in it, and the
-- `is_active_agent() or is_admin()` shape is doing real work rather than
-- being decoration: a deactivated rep holds a working JWT until it
-- expires, and without the active check they would keep reading the
-- company's current rate cards after being let go.
create policy "select active or admin" on marketing_materials
  for select using (is_active_agent() or is_admin());

-- Writes are admin-only. INSERT and UPDATE are policies rather than being
-- left to the Edge Function's service_role (which bypasses both RLS and
-- grants) because the admin UI edits title, category and archived_at
-- through PostgREST directly -- only the file itself needs the function.
create policy "admin inserts" on marketing_materials
  for insert with check (is_admin());
create policy "admin updates" on marketing_materials
  for update using (is_admin()) with check (is_admin());
-- No DELETE policy and no DELETE grant. See archived_at above.

-- ---------------------------------------------------------------------
-- MARKETING MATERIAL EVENTS — append-only engagement log.
--
-- One row per thing a rep did with a material: viewed it, downloaded it,
-- printed it, or emailed it to a lead. This is the table the feature is
-- actually for; marketing_materials is just the thing it points at.
--
-- APPEND-ONLY, like notes and support_ticket_replies: SELECT and INSERT
-- grants, no UPDATE or DELETE in either policy or grant. A log that can be
-- rewritten is not a log, and this one answers "what did we send them" in
-- front of a merchant who says they were never told something.
-- ---------------------------------------------------------------------
create table marketing_material_events (
  id serial primary key,
  material_id int references marketing_materials(id) not null,

  -- Nullable on purpose. A rep browsing the library and opening a rate
  -- card to read it has done something worth logging, and there is no lead
  -- in that act. Per-lead history is `where lead_id = $1`; the library's
  -- own usage is `where lead_id is null`. Making this NOT NULL would have
  -- forced the library page either to log nothing or to invent a lead, and
  -- both lose information.
  --
  -- ON DELETE CASCADE, unlike material_id: a deleted lead takes its
  -- engagement history with it, because the history is *about* that lead
  -- and orphaned rows would leave a count no page can explain. A material
  -- is not deletable at all (see archived_at), so the two sides of this
  -- table have deliberately different answers.
  lead_id int references leads(id) on delete cascade,

  -- The acting rep. This is the TWENTY-FIRST column referencing
  -- profiles(id), also ON DELETE NO ACTION -- it is evidence, and evidence
  -- must block a delete until a person decides what happens to it.
  agent_id uuid references profiles(id) not null,

  event_type text not null
    check (event_type in ('viewed', 'downloaded', 'printed', 'emailed')),
  occurred_at timestamptz default now()
);

alter table marketing_material_events enable row level security;

-- The standard own-or-admin read.
create policy "select own or admin" on marketing_material_events
  for select using ((agent_id = auth.uid() and is_active_agent()) or is_admin());

-- The insert policy carries the documents lesson, and that is why it is
-- not the usual one-liner.
--
-- agent_id is checked against auth.uid() the way every other table does
-- it. But lead_id is ALSO client-supplied and no other clause reads it,
-- which is exactly the shape that made documents.file_key a live
-- cross-agent read: a column the client chooses and no policy looks at is
-- unvalidated, whatever the rest of the row proves. Without the `exists`
-- below a rep could post events against another rep's lead_id -- not
-- reading anything, but writing fabricated engagement history into a book
-- that is not theirs, visible to the admin who reviews it.
--
-- The subquery spells out `leads.agent_id = auth.uid()` rather than
-- leaning on RLS to filter it, matching the pre_apps child tables above.
-- Same effect; a reader should not have to know that policies nest to see
-- that the check is real.
create policy "insert own via own lead" on marketing_material_events
  for insert with check (
    (
      (agent_id = auth.uid() and is_active_agent())
      or is_admin()
    )
    and (
      lead_id is null
      or is_admin()
      or exists (
        select 1 from leads
         where leads.id = lead_id and leads.agent_id = auth.uid()
      )
    )
  );
-- No UPDATE or DELETE policy, and no grant for either. Append-only.

-- Every read of this table is "events for this material" or "events for
-- this lead", and the second is what the lead page runs on every load.
create index idx_marketing_material_events_lead
  on marketing_material_events(lead_id, occurred_at desc)
  where lead_id is not null;
create index idx_marketing_material_events_material
  on marketing_material_events(material_id, occurred_at desc);

-- Browsing is "what is in this category, newest first", and an archived
-- material is never in a rep's list -- so the index is partial on exactly
-- the rows the rep-facing query reads.
create index idx_marketing_materials_category
  on marketing_materials(category, title)
  where archived_at is null;

-- The cross-agent audit trigger is NOT attached to either table, and each
-- has its own reason.
--
-- marketing_materials has no agent_id at all, so log_cross_agent_change()
-- would read NULL and log every write -- the support_ticket_replies trap
-- the rep_payout_* tables record. Admin action on it is audited where it
-- happens instead: marketing-material-file-url writes an audit_log row per
-- upload, the same way create-upload-url does.
--
-- marketing_material_events DOES carry an agent_id and the trigger would
-- work on it, which is the more interesting omission: it is already an
-- audit trail. Attaching a second one would write an audit_log row every
-- time an admin's own browsing logged an event -- recording that an admin
-- looked at something, in a table whose entire content is a record of who
-- looked at what. The trail is not improved by being kept twice.

-- =====================================================================
-- PRODUCT CATALOG — the hardware and POS lineup a quote is built from.
--
-- The SECOND client-readable table with no agent_id, and it is the same
-- shape of thing as marketing_materials for the same reason: company
-- reference data. Every active rep reads all of it, only an admin writes
-- it, and there is nothing per-rep to compare a row against. The select
-- policy is `is_active_agent() or is_admin()` with no ownership clause,
-- exactly as the library's is.
--
-- WHAT IS DELIBERATELY NOT HERE, so the next person does not read the
-- omissions as oversights:
--
-- 1. NO profiles REFERENCE. marketing_materials carries uploaded_by
--    because a material has an upload lifecycle -- file_key is nullable,
--    an unfinished upload is a real state, and "which admin do I ask
--    about this one" is a question that page answers. A product is a
--    handful of fields an admin types, edited in place, so a created_by
--    would record who first typed it and go stale the moment anybody
--    changed the price -- answering a question nobody asks while adding
--    one more column to clear before a user can be deleted. The four
--    teardown lists are already the most-forgotten thing in this repo;
--    this table does not join them.
--
-- 2. NO VERSION HISTORY, unlike quotes below. The two tables look like
--    they should agree and must not. A quote is a document handed to a
--    merchant, so what it said when it was sent has to survive being
--    edited -- which is why quote_line_items snapshots the price rather
--    than joining this table live. Once that snapshot exists, the catalog
--    is free to be a plain mutable current-state table, because no quote
--    depends on its history. Giving both tables a history would mean two
--    mechanisms answering the same question in different ways.
--
-- 3. NO BULK IMPORT. Rows are entered one at a time through
--    /admin/products. A column-mapping and blocker pipeline of the
--    rep_payout_import_rows / user_import_rows kind is a follow-up, and
--    deliberately so: both of those encode rules read off a real file,
--    and the hardware pricing sheet this one would parse does not exist
--    yet. Guessing its columns now would mean writing a parser to be
--    rewritten, plus a staging table whose shape is a guess.
-- =====================================================================
create table products (
  id serial primary key,

  name text not null,

  -- The manufacturer's model or part number. Nullable because software
  -- and service line items ("Gateway monthly", "PCI compliance") have no
  -- model number, and a blank must never be stored: the partial unique
  -- index below treats the empty string as a value, so two products
  -- cleared that way would collide. profiles.agent_number set this
  -- precedent and the normalise-to-null rule is the same one.
  sku text,

  -- The "folder", free text with no vocabulary -- matching
  -- marketing_materials.category, support_tickets.category and
  -- profiles.territory. Reference data an admin extends when the lineup
  -- grows a new kind of thing, where a CHECK would mean a migration
  -- every time a vendor ships a product category.
  category text not null,

  -- NULLABLE, and null means "not priced yet" or "call for pricing" --
  -- never zero. The same distinction rep_payout_rows.rep_payout draws,
  -- and for the same reason: a quote line that silently takes 0.00 off a
  -- missing list price is a figure a rep hands to a merchant.
  --
  -- Unsigned, unlike rep_payout_rows.total_cost: a clawback is a real
  -- negative residual, but a negative list price is a typo.
  list_price numeric(12,2) check (list_price is null or list_price >= 0),

  description text,

  -- The deliberately loose column, and the reason it exists NOW rather
  -- than when it is needed: the real hardware/POS lineup and the
  -- integration details are not finalised, so the fields each product
  -- type turns out to need are unknown. Whatever they are -- connectivity,
  -- processor compatibility, dimensions, bundled software -- they go in
  -- here without a migration.
  --
  -- The CHECK is not decoration. jsonb accepts `4`, `null` and `[1,2]` as
  -- perfectly valid documents, and every reader here does key lookups --
  -- so a scalar stored by a careless write turns every `specs ->> 'x'`
  -- into a silent NULL rather than an error. Pinning it to an object
  -- means the one shape the code assumes is the one shape the column
  -- holds.
  --
  -- Known cost, stated so it is a choice rather than a discovery: nothing
  -- validates the KEYS. A typo'd key is a fact about the product that no
  -- query finds and no constraint catches. That is the trade a catch-all
  -- column is -- the alternative was guessing the columns -- and the way
  -- out when the lineup settles is to promote the keys that turned out to
  -- matter into real columns, not to add more checks here.
  specs jsonb not null default '{}'::jsonb
    check (jsonb_typeof(specs) = 'object'),

  -- Retirement is a timestamp, not a delete, for the reason
  -- marketing_materials.archived_at is one and more sharply: a product
  -- exists to be referenced by quote_line_items, and quotes are evidence
  -- of what a merchant was offered. Deleting a discontinued terminal
  -- would either cascade historical quote lines away or be blocked by the
  -- FK forever. Archiving drops it out of the picker while every quote
  -- naming it stays whole.
  archived_at timestamptz,

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Partial, `where sku is not null`, exactly like profiles.agent_number's:
-- most rows have one and must not collide, and the ones that legitimately
-- have none must not collide with each other. A plain unique index would
-- allow only a single unpriced service line in the whole catalog, because
-- NULLs are distinct but there is only one empty string.
create unique index idx_products_sku on products(sku) where sku is not null;

-- Browsing is "what is in this category", and an archived product is
-- never in the picker -- so this is partial on exactly the rows that
-- query reads, the same shape as idx_marketing_materials_category.
create index idx_products_category on products(category, name)
  where archived_at is null;

alter table products enable row level security;

-- No agent_id comparison, like marketing_materials. is_active_agent() is
-- the load-bearing half: a deactivated rep holds a working JWT until it
-- expires, and without it they keep reading the company's current pricing
-- after being let go.
create policy "select active or admin" on products
  for select using (is_active_agent() or is_admin());

create policy "admin inserts" on products
  for insert with check (is_admin());
create policy "admin updates" on products
  for update using (is_admin()) with check (is_admin());
-- No DELETE policy, and no DELETE grant. See archived_at.

create trigger products_set_updated_at
  before update on products
  for each row execute function set_updated_at();

-- No cross-agent audit trigger: no agent_id, so log_cross_agent_change()
-- would read NULL and log every write -- the support_ticket_replies trap,
-- and the same answer marketing_materials gives.

-- =====================================================================
-- QUOTES — what a rep offered a lead, and what it said when they sent it.
--
-- APPEND-ONLY ON EDIT. This is the whole design and everything below
-- follows from it. A quote is not edited in place: each edit INSERTS a
-- new row sharing the previous one's quote_group_id with version + 1, and
-- the old row stays exactly as it was. The reasoning is the one notes
-- carries, one step further along: a note is append-only because it is a
-- record of what somebody said, and a quote is append-only because it is
-- a record of what a merchant was shown. "We never quoted that" is an
-- argument a CRM should be able to settle.
--
-- THE CURRENT VERSION IS THE HIGHEST version IN THE GROUP. Stated once
-- here because it is a rule the database does not evaluate on anybody's
-- behalf and every reader needs: there is no is_current flag to keep in
-- step, no partial unique index to maintain, and no window where two rows
-- could both claim to be current. What the database DOES enforce is that
-- the rule is well-defined -- unique (quote_group_id, version) means a
-- group can never hold two rows at the same version, so "the highest" is
-- always exactly one row. lib/quotes.ts `currentVersion()` is the single
-- implementation on the browser side.
--
-- WHY A GROUP ID RATHER THAN A SELF-REFERENCE to the first version: a
-- parent pointer makes "every version of this quote" a recursive CTE and
-- makes the chain breakable in the middle. A flat group id makes it
-- `where quote_group_id = $1 order by version`, which is an index scan
-- and cannot be malformed. The same reasoning that keeps
-- profiles.manager_id one hop deep.
-- =====================================================================
create table quotes (
  id serial primary key,

  -- Every version of one quote shares this. Defaulted rather than
  -- required, so creating a brand-new quote is an insert that does not
  -- mention it; an edit passes the existing group's id and the trigger
  -- below does the rest.
  quote_group_id uuid not null default gen_random_uuid(),

  -- ASSIGNED BY enforce_quote_version(), never by the client, and the
  -- client's value is overwritten rather than validated. See that
  -- function: two browser tabs that both read "the latest is v2" would
  -- otherwise both write v3, and the unique constraint would turn one
  -- rep's ordinary second edit into an error they cannot act on.
  version int not null default 1 check (version >= 1),

  -- ON DELETE CASCADE, like marketing_material_events.lead_id and for the
  -- same reason: a quote is ABOUT the lead, and an orphaned one is a
  -- document no page can place. Deleting a lead is admin-only.
  lead_id int references leads(id) on delete cascade not null,

  -- The owning rep, and one more column referencing profiles(id) -- ON DELETE
  -- NO ACTION, like every one of them but profiles.manager_id, so all four
  -- teardown lists need an entry for it.
  --
  -- ONE entry, though, not two, and the contrast with the marketing pair is
  -- the part worth knowing. There, events must be cleared by material and THEN
  -- by actor, because marketing_material_events.material_id is NO ACTION -- so
  -- a delete by uploaded_by alone fails on somebody else's row. Here
  -- quote_line_items.quote_id is ON DELETE CASCADE, so deleting a rep's quotes
  -- takes their lines with it and quote_line_items needs no entry at all. A
  -- line cannot belong to anyone but its quote's owner, which is exactly what
  -- was not true of a marketing event.
  agent_id uuid references profiles(id) not null,

  -- A vocabulary, unlike every other `category`-shaped text column here,
  -- because these are not labels an admin invents -- they are the states a
  -- quote moves through, and `statusIntent` in lib/quotes.ts colours each
  -- one. leads.status is the cautionary precedent: it shipped unconstrained
  -- and had to be given a NOT VALID vocabulary later, over rows that
  -- already held rep-typed strings. This table is new, so the constraint is
  -- ordinary and binds every row from the first one.
  status text not null default 'draft'
    check (status in ('draft', 'sent', 'accepted', 'declined', 'expired')),

  -- What the rep calls it. Nullable: an untitled draft is a legitimate
  -- state, and the UI falls back to the lead's name.
  title text,

  -- Rep-facing terms and conditions, carried forward into each new
  -- version with the line items.
  notes text,

  created_at timestamptz default now(),

  -- The constraint that makes "highest version" well-defined. Also the
  -- concurrency backstop behind enforce_quote_version(): the trigger reads
  -- the current max and adds one, and two transactions doing that at the
  -- same instant both compute the same number -- at which point this
  -- rejects the loser rather than letting the group fork into two rows
  -- that each think they are current.
  unique (quote_group_id, version)
);

-- "Every version of this quote, newest first" is served by the unique
-- constraint's own index on (quote_group_id, version). This one exists
-- for the OTHER query -- the lead page's "every quote on this lead",
-- which that index cannot help with at all.
create index idx_quotes_lead on quotes(lead_id, quote_group_id, version desc);
create index idx_quotes_agent_id on quotes(agent_id);

alter table quotes enable row level security;

create policy "select own or admin" on quotes
  for select using ((agent_id = auth.uid() and is_active_agent()) or is_admin());

-- The lead_id `exists` is the documents.file_key lesson in its third
-- form, and it is here for exactly the reason the marketing events policy
-- carries one. lead_id is client-supplied and no other clause in this
-- policy reads it -- the shape that made documents.file_key a live
-- cross-agent read. Without it a rep could file quotes against another
-- rep's lead: not reading anything, but putting a document the merchant
-- never saw in front of the admin reviewing that deal.
--
-- The subquery states `leads.agent_id = auth.uid()` rather than leaning on
-- RLS to filter it, matching the pre_apps child tables: same effect, and a
-- reader does not have to know policies nest to see the check is real.
create policy "insert own via own lead" on quotes
  for insert with check (
    (
      (agent_id = auth.uid() and is_active_agent())
      or is_admin()
    )
    and (
      is_admin()
      or exists (
        select 1 from leads
         where leads.id = lead_id and leads.agent_id = auth.uid()
      )
    )
  );

-- AN UPDATE POLICY ON AN APPEND-ONLY TABLE looks like a contradiction and
-- is not. It exists for exactly one column: `status`. WHICH column is
-- enforced by the GRANT, not by this policy -- `grant update (status)`
-- below is a column-level privilege, so an attempt to update anything
-- else fails with `permission denied for column`, loudly, at a layer no
-- policy can be widened past. That is the same reasoning that revoked the
-- notes UPDATE grant in 20260812143407: a write the grant refuses is an
-- error, where a write RLS filters is a save that silently did nothing.
--
-- Why status is mutable at all, when the line items are not: the two are
-- different kinds of fact. Changing what is ON a quote changes what the
-- merchant was offered, and that must produce a new version. Recording
-- that the merchant ACCEPTED it does not change what they were offered --
-- and forcing a new version for it would mean inventing a v4 nobody
-- wrote, identical to v3 but for one word, which makes the history less
-- true rather than more.
--
-- A superseded version keeps whatever status it had when it was
-- superseded, which is correct and readable: "v1 sent, v2 draft" says a
-- rep sent one and is revising it.
create policy "update own or admin" on quotes
  for update using ((agent_id = auth.uid() and is_active_agent()) or is_admin())
  with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());

-- No DELETE policy and no DELETE grant, for either table. A quote is
-- evidence of what a merchant was offered; there is no archived_at here
-- either, because a superseded version is not retired -- it is history,
-- and the group's highest version is what anybody is shown.

create table quote_line_items (
  id serial primary key,

  -- CASCADE so the chain from leads holds all the way down. A line item
  -- belonging to no quote is not a lesser record, it is an unreadable one.
  quote_id int references quotes(id) on delete cascade not null,

  -- NO ACTION, like every other reference to the catalog: a product is
  -- archived rather than deleted precisely so this reference stays whole.
  product_id int references products(id) not null,

  quantity int not null check (quantity > 0),

  -- THE SNAPSHOT, and the reason this table exists rather than the quote
  -- joining products live. Catalog prices change after a quote is sent;
  -- re-deriving a total from today's list price would silently restate
  -- what a merchant was offered last month, and the restatement would look
  -- exactly like the original.
  --
  -- `check >= 0` for the reason products.list_price is unsigned: a
  -- negative line is a typo, not a clawback.
  unit_price numeric(12,2) not null check (unit_price >= 0),

  -- The rest of the snapshot, and these are not padding. The price
  -- argument above is true word for word of the name and the model number:
  -- a product renamed "Clover Flex (discontinued)" would retroactively
  -- rewrite every quote that ever offered a Clover Flex. Copied at quote
  -- time so a historical version renders as it was sent, and `not null`
  -- because every product has a name -- a blank line on a document handed
  -- to a merchant is worse than a stale one.
  product_name text not null,
  product_sku text,

  -- STORED GENERATED, like rep_payout_rows.rep_payout, and for the same
  -- reason: a total computed in the browser and written as data is a
  -- figure that can disagree with its own inputs. Both operands are
  -- `not null`, so unlike rep_payout this is never null.
  line_total numeric(12,2)
    generated always as (round(quantity * unit_price, 2)) stored,

  -- Display order within the quote, so a document does not reshuffle
  -- itself between renders because two lines were inserted in the same
  -- millisecond. Not unique: a duplicate rank is a cosmetic tie, and a
  -- constraint that rejects a quote over it would be worse than the tie.
  --
  -- NOT called `position`. That is a Postgres keyword (the `position(x in
  -- y)` function), legal as a column name but needing quoting in enough
  -- places that it is a standing invitation to a syntax error in whatever
  -- query someone writes next.
  sort_order int not null default 0
);

-- Every read of this table is "the lines on these quotes".
create index idx_quote_line_items_quote
  on quote_line_items(quote_id, sort_order, id);

alter table quote_line_items enable row level security;

-- NO agent_id, so ownership is reached through the parent, exactly as the
-- pre_apps child tables do it -- and note is_active_agent() wraps the
-- `exists` rather than sitting inside it, which is the form those three
-- established.
create policy "select via own quote" on quote_line_items
  for select using (
    (
      is_active_agent()
      and exists (
        select 1 from quotes
         where quotes.id = quote_id and quotes.agent_id = auth.uid()
      )
    )
    or is_admin()
  );

create policy "insert via own quote" on quote_line_items
  for insert with check (
    (
      is_active_agent()
      and exists (
        select 1 from quotes
         where quotes.id = quote_id and quotes.agent_id = auth.uid()
      )
    )
    or is_admin()
  );

-- No UPDATE and no DELETE, in policy or in grant -- stricter than the
-- quotes table above, which allows the one status column. A line item
-- belongs to a version, and a version is what it said when it was sent.
-- Changing one is the edit that is supposed to produce a new version, so
-- allowing it here would route around the entire design.
--
-- The practical consequence, and it is a UI requirement rather than an
-- inconvenience: a quote is assembled in browser state and written once,
-- through create_quote_version(). There is no add-a-line-then-remove-it
-- against the database, so nothing needs a verb that does not exist.

-- =====================================================================
-- enforce_quote_version() — assigns the version number, and refuses a
-- write into another rep's quote group.
--
-- `security definer`, and it owes you a reason, because the default here
-- is invoker (see the note above convert_ghost_sheet_to_lead). The reason
-- is that BOTH of its jobs are about rows the caller cannot see:
--
--   * The group's current max version. An invoker function reading
--     `max(version)` through RLS sees only the caller's own rows -- which
--     is fine until an ADMIN edits a rep's quote, at which point the admin
--     sees everything and the rep sees their own, and the two compute
--     different next versions for the same group.
--
--   * Whether the group belongs to somebody else. This cannot be
--     expressed in the insert policy at all: an `exists` subquery there
--     is itself filtered by the select policy, so a foreign group reads
--     as an ABSENT group and the forged insert is admitted as a brand-new
--     quote. The check has to see past RLS to mean anything, which is the
--     stated criterion for reaching for `definer` -- and it pays for it
--     the way the others do, by refusing rather than returning data.
--
-- Assigning rather than validating is the other half. A client that
-- computes its own version number is racing every other tab the rep has
-- open; the unique constraint would catch the collision, but it would
-- surface as a constraint violation on an ordinary second edit. Computing
-- it here means the only way to lose is a genuine simultaneous write,
-- which is what the constraint is actually for.
-- =====================================================================
create or replace function enforce_quote_version()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  group_agent_id uuid;
  max_version int;
begin
  -- One scan for both facts. An empty group yields NULLs in both, which
  -- is the brand-new-quote case.
  select q.agent_id, max(q.version)
    into group_agent_id, max_version
    from quotes q
   where q.quote_group_id = NEW.quote_group_id
   group by q.agent_id;

  if group_agent_id is not null and group_agent_id <> NEW.agent_id then
    -- Deliberately not naming the owner. "Not yours" and "does not exist"
    -- are already indistinguishable everywhere else here, and an error
    -- message is as good an id oracle as a status code.
    raise exception 'quote group belongs to another agent';
  end if;

  NEW.version := coalesce(max_version, 0) + 1;
  return NEW;
end;
$$;

revoke all on function enforce_quote_version() from public;
revoke all on function enforce_quote_version() from anon, authenticated;
-- Trigger function: revoked and deliberately NOT granted, like
-- log_cross_agent_change() and set_updated_at(). A trigger fires whether
-- or not the querying role holds EXECUTE.

create trigger quotes_enforce_version
  before insert on quotes
  for each row execute function enforce_quote_version();

-- =====================================================================
-- create_quote_version() — writes a quote and its line items in ONE
-- transaction.
--
-- SECURITY INVOKER, like convert_ghost_sheet_to_lead and for the same
-- reason: every insert inside it is scoped by the caller's own policies,
-- so a rep gets their own lead checked by the `exists` in the insert
-- policy and an admin gets the admin branch, with no role test in this
-- body and no agent_id filter here to fall out of step with the policy.
-- The only thing it adds is atomicity.
--
-- Which is the whole point. supabase-js has no client-side transaction,
-- so the browser alternative is "insert the quote, then insert its lines"
-- -- two round trips with a real window in between, and a failure there
-- leaves a quote with no line items. On a table where the lines ARE the
-- document, that is not a lesser version of the record: it is a $0.00
-- quote against a lead, indistinguishable from one a rep meant to send.
-- marketing_materials tolerates the equivalent window because a row with
-- no file is recognisable as unfinished and re-uploadable; an empty quote
-- is neither.
--
-- `agent_id_input` rather than auth.uid(): an admin building a quote on a
-- rep's behalf must not move it into their own book, which is the same
-- call convert_ghost_sheet_to_lead makes when it takes agent_id from the
-- sheet. A rep passing anybody else's id is refused by the insert policy,
-- not by code here.
-- =====================================================================
create or replace function create_quote_version(
  lead_id_input int,
  agent_id_input uuid,
  quote_group_id_input uuid,
  status_input text,
  title_input text,
  notes_input text,
  line_items_input jsonb
)
returns int
language plpgsql
set search_path = public
as $$
declare
  new_quote_id int;
begin
  -- A quote with no lines is the state this function exists to make
  -- unreachable, so it is refused here rather than written and reported.
  if line_items_input is null
     or jsonb_typeof(line_items_input) <> 'array'
     or jsonb_array_length(line_items_input) = 0 then
    raise exception 'a quote needs at least one line item';
  end if;

  -- Three refusals, each with its own message, rather than one count
  -- comparison at the end. A count tells the rep that SOMETHING in their
  -- quote is wrong; these tell them which thing, and the three causes
  -- need three different actions (pick a different product, ask an admin
  -- to price it, fix the quantity).

  if exists (
    select 1 from jsonb_array_elements(line_items_input) as elem
     where not exists (
       select 1 from products p
        where p.id = (elem.value ->> 'product_id')::int
          and p.archived_at is null
     )
  ) then
    raise exception 'every line item must name a product that is in the catalog';
  end if;

  -- A null list_price means "not priced yet", never zero -- so an unpriced
  -- product cannot go on a document a merchant reads. Coalescing it to
  -- 0.00 here is the exact failure products.list_price is nullable to
  -- prevent: it would put a free terminal on a quote and raise nothing.
  if exists (
    select 1 from jsonb_array_elements(line_items_input) as elem
      join products p on p.id = (elem.value ->> 'product_id')::int
     where p.list_price is null
  ) then
    raise exception 'every line item must name a product that has a list price';
  end if;

  -- Caught here so the message names the quantity. The column's own
  -- `check (quantity > 0)` and `not null` would both reject these too,
  -- but as a constraint violation naming neither the line nor the fix.
  if exists (
    select 1 from jsonb_array_elements(line_items_input) as elem
     where coalesce((elem.value ->> 'quantity')::int, 0) <= 0
  ) then
    raise exception 'every line item needs a quantity of at least 1';
  end if;

  -- version is omitted: quotes_enforce_version assigns it, and a value
  -- passed here would be overwritten anyway.
  --
  -- coalesce on the group id so a brand-new quote can pass NULL and take
  -- the column default rather than needing the caller to generate a uuid.
  insert into quotes (
    quote_group_id, lead_id, agent_id, status, title, notes
  )
  values (
    coalesce(quote_group_id_input, gen_random_uuid()),
    lead_id_input,
    agent_id_input,
    coalesce(status_input, 'draft'),
    nullif(btrim(coalesce(title_input, '')), ''),
    nullif(btrim(coalesce(notes_input, '')), '')
  )
  returning id into new_quote_id;

  -- THE SNAPSHOT IS TAKEN HERE, from products, rather than trusted from
  -- the caller. The browser sends product_id and quantity and nothing
  -- else that reaches a column; name, sku and unit_price are read off the
  -- catalog inside the same transaction that writes the quote.
  --
  -- That split is the point. A client-supplied unit_price would be the
  -- documents.file_key shape one more time -- a figure no policy reads,
  -- on a document handed to a merchant -- and it would also make the
  -- snapshot a claim about the catalog rather than a copy of it. The
  -- three guards above have already established that every product_id
  -- resolves to a live, priced row, so this join cannot drop a line.
  --
  -- `with ordinality` supplies sort_order from the array's own order, so
  -- the document renders in the order the rep built it rather than in
  -- whatever order the ids happen to sort.
  insert into quote_line_items (
    quote_id, product_id, quantity, unit_price,
    product_name, product_sku, sort_order
  )
  select
    new_quote_id,
    p.id,
    (elem.value ->> 'quantity')::int,
    p.list_price,
    p.name,
    p.sku,
    (elem.ord - 1)::int
  from jsonb_array_elements(line_items_input) with ordinality as elem(value, ord)
  join products p
    on p.id = (elem.value ->> 'product_id')::int
   and p.archived_at is null;

  return new_quote_id;
end;
$$;

revoke all on function create_quote_version(int, uuid, uuid, text, text, text, jsonb)
  from public;
grant execute on function create_quote_version(int, uuid, uuid, text, text, text, jsonb)
  to authenticated, service_role;


-- =====================================================================
-- DUPLICATE-DETECTION NORMALISERS — pure, immutable, and indexed.
--
-- These exist so check_duplicates() can be served by indexes. An expression
-- index is only used when the query's expression matches the index's
-- EXACTLY, so spelling regexp_replace(contact_phone, '\D', '', 'g') by hand
-- in both places is a standing invitation to a silent sequential scan the
-- day one copy gains a space. A named function makes the two undesyncable.
--
-- IMMUTABLE is required for an expression index and is true here: each calls
-- only pg_catalog functions on its argument. STRICT so null in is null out,
-- and each maps '' to NULL — '' is a value, and left alone it matches every
-- other blank field in the table, which is the quickest way a duplicate
-- check becomes a false-positive generator.
--
-- No `set search_path` on these three, unlike every definer function here.
-- They are not definer, they call only pg_catalog (always implicitly first
-- in the path and not shadowable), and a SET clause blocks inlining — which
-- matters for an expression evaluated per row during index maintenance.
--
-- NEVER `create or replace` one of these with different behaviour without
-- reindexing everything that uses it. Postgres accepts the replacement and
-- leaves existing index entries computed by the OLD definition, so rows that
-- really are duplicates silently stop matching — and a duplicate check
-- returning nothing looks exactly like no duplicates.
-- =====================================================================
create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;
grant usage on schema extensions to authenticated, service_role;

create or replace function dup_digits(input text)
returns text language sql immutable strict parallel safe as $$
  select nullif(regexp_replace(input, '\D', '', 'g'), '')
$$;

create or replace function dup_email(input text)
returns text language sql immutable strict parallel safe as $$
  select nullif(lower(btrim(input)), '')
$$;

-- Host only. "https://www.acme.com/pricing?x=1" and "acme.com" are the same
-- business, and a rep typing either must not look like two different ones.
create or replace function dup_host(input text)
returns text language sql immutable strict parallel safe as $$
  select nullif(
    regexp_replace(
      split_part(
        split_part(
          regexp_replace(lower(btrim(input)), '^[a-z][a-z0-9+.-]*://', ''),
          '/', 1),
        '?', 1),
      '^www\.', ''),
    '')
$$;

revoke all on function dup_digits(text) from public;
revoke all on function dup_email(text) from public;
revoke all on function dup_host(text) from public;
grant execute on function dup_digits(text) to authenticated, service_role;
grant execute on function dup_email(text) to authenticated, service_role;
grant execute on function dup_host(text) to authenticated, service_role;

-- =====================================================================
-- INDEXES — every RLS policy filters on agent_id, so every query does too
-- (§14.8). Added while the tables are empty, where it costs nothing.
-- =====================================================================
create index idx_merchants_agent_id on merchants(agent_id);
create index idx_leads_agent_id on leads(agent_id);
create index idx_ghost_sheets_agent_id on ghost_sheets(agent_id);
create index idx_pre_apps_agent_id on pre_apps(agent_id);
create index idx_documents_agent_id on documents(agent_id);
create index idx_support_tickets_agent_id on support_tickets(agent_id);
create index idx_notes_agent_id on notes(agent_id);
create index idx_tasks_agent_id on tasks(agent_id);
create index idx_bug_reports_agent_id on bug_reports(agent_id);
create index idx_rep_payout_rows_agent_id on rep_payout_rows(agent_id);

-- columns the list pages actually filter on
create index idx_merchants_status on merchants(status);
create index idx_pre_apps_status on pre_apps(status);
create index idx_support_tickets_status on support_tickets(status);
-- The admin queue is `where status = 'open'`, and cleared reports accumulate
-- behind it forever -- that is the cost of clearing by status rather than by
-- delete, and this is what keeps paying it cheap.
create index idx_bug_reports_status on bug_reports(status);
-- The pipeline view filters on this, alongside the follow-up window below.
-- Both are secondary filters over the same already-agent-scoped set, so each
-- gets its own index rather than a composite: the pair is never the predicate.
create index idx_leads_status on leads(status);
create index idx_leads_next_followup_date on leads(next_followup_date);

-- Duplicate detection. Without these, check_duplicates() is a sequential scan
-- of leads, ghost_sheets AND merchants on every lead create — three full
-- tables on the action a rep performs most. Each one is the expression the
-- function actually queries by, which is what makes it usable at all.
--
-- Btree for the exact tier, GIN/trgm for the fuzzy tier. The three phone
-- indexes are separate rather than composite because the predicate is three
-- independent `= any(...)` tests ORed together: the planner serves that with
-- a BitmapOr over the three, and a composite would serve none of them.
create index idx_leads_dup_email         on leads (dup_email(contact_email));
create index idx_leads_dup_contact_phone on leads (dup_digits(contact_phone));
create index idx_leads_dup_business_phone on leads (dup_digits(business_phone));
create index idx_leads_dup_mobile_phone  on leads (dup_digits(mobile_phone));
create index idx_leads_dup_host          on leads (dup_host(website));
create index idx_leads_dup_zip           on leads (dup_digits(zip));
create index idx_leads_dba_trgm        on leads using gin (dba extensions.gin_trgm_ops);
create index idx_leads_legal_name_trgm on leads using gin (merchant_legal_name extensions.gin_trgm_ops);
create index idx_leads_address_trgm    on leads using gin (address extensions.gin_trgm_ops);

create index idx_ghost_sheets_dup_contact_phone
  on ghost_sheets (dup_digits(contact_phone));
create index idx_ghost_sheets_dba_trgm
  on ghost_sheets using gin (dba extensions.gin_trgm_ops);

create index idx_merchants_dba_trgm
  on merchants using gin (dba extensions.gin_trgm_ops);
create index idx_merchants_legal_name_trgm
  on merchants using gin (legal_business_name extensions.gin_trgm_ops);

-- The polymorphic owner pair. documents, notes and tasks are all read the same
-- way -- `where owner_type = $1 and owner_id = $2` -- by the panels on every
-- lead / pre-app / merchant / ghost-sheet detail page, which is three such
-- queries per page render. agent_id alone does not serve those: a rep's whole
-- book shares one agent_id, so that index selects everything they own and the
-- owner pair is then filtered out row by row.
--
-- owner_type leads because it is the equality column with the smaller domain
-- and both are always supplied together; the composite serves the pair. No
-- index on owner_id alone: nothing queries a note by owner_id without also
-- naming its type, and owner_id values collide across types by construction
-- (merchant 7 and lead 7 both exist).
create index idx_documents_owner on documents(owner_type, owner_id);
create index idx_notes_owner on notes(owner_type, owner_id);
create index idx_tasks_owner on tasks(owner_type, owner_id);

-- The payout tables. Note what is deliberately NOT here: an index on
-- rep_payout_rows(period), even though every page filters on it. The
-- `unique (period, agent_id, mid)` constraint already creates a btree index with
-- period as its LEADING column, so it serves `where period = $1` and
-- `where period = $1 and agent_id = $2` on its own. A second index on period
-- would be dead weight on every write. agent_id does need its own (above),
-- because it is not the leading column of that constraint and a rep's own read
-- filters on it alone.
--
-- Staging is always read one batch at a time -- the review screen is
-- `where batch_id = $1` -- and history is always read for one ledger row.
create index idx_rep_payout_import_rows_batch on rep_payout_import_rows(batch_id);
create index idx_rep_payout_row_history_row on rep_payout_row_history(row_id);

-- child tables reach their access check through
-- `exists (select 1 from pre_apps where pre_apps.id = pre_app_id ...)`,
-- so they filter on pre_app_id on every read and write
create index idx_pre_app_owners_pre_app_id on pre_app_owners(pre_app_id);
-- Same reasoning, different parent: support_ticket_replies reaches its check
-- through support_tickets, and the thread is always read by ticket_id.
create index idx_support_ticket_replies_ticket on support_ticket_replies(ticket_id);
-- pre_app_terminal, pre_app_business_profile and the three *_secrets tables
-- need no index here: their `unique (pre_app_id)` / `unique (pre_app_owner_id)`
-- constraint already creates a unique btree index on exactly that column,
-- which serves these lookups. A second plain index would be dead weight on
-- every write. (This is why the earlier idx_pre_app_terminal_pre_app_id and
-- idx_pre_app_business_profile_pre_app_id are dropped when the constraints
-- are added.)

-- ---------------------------------------------------------------------
-- updated_at trigger — plain function, no security definer: it only
-- ever touches the row already being written, under the caller's own
-- RLS-checked UPDATE. Applied only where the column actually exists.
-- ---------------------------------------------------------------------
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger merchants_set_updated_at
  before update on merchants
  for each row execute function set_updated_at();

create trigger leads_set_updated_at
  before update on leads
  for each row execute function set_updated_at();

create trigger pre_apps_set_updated_at
  before update on pre_apps
  for each row execute function set_updated_at();

create trigger rep_payout_rows_set_updated_at
  before update on rep_payout_rows
  for each row execute function set_updated_at();

-- =====================================================================
-- CROSS-AGENT AUDIT TRIGGER — the trail for admin action on other
-- people's records.
--
-- The gap this closes: §10 promises audit logging of admin actions, but
-- an admin editing or deleting any rep's merchant/lead/pre-app does it
-- with plain supabase-js. RLS permits it via is_admin() and nothing was
-- recorded, so the largest privileged surface in the app was the only
-- unlogged one. Deletes are admin-only across the board and were
-- equally silent.
--
-- Only cross-agent mutations are logged. A rep editing their own lead is
-- ordinary work, and recording it would bury the entries that matter
-- under thousands that don't -- the same reasoning that keeps
-- pre_app_secrets_presence out of the trail.
--
-- `security definer` is mandatory here, not stylistic. audit_log has no
-- INSERT policy for `authenticated`, so a security invoker trigger would
-- have its insert refused by RLS and would fail the caller's UPDATE
-- outright. Running as the owner is also what makes this compose with
-- audit_log's SELECT-only grant above.
--
-- auth.uid() still returns the real caller inside a definer function:
-- definer changes current_user, not the session's JWT claims. The same
-- property submit_pre_app() relies on, documented there.
--
-- AFTER, not BEFORE: the trail should record what actually happened, and
-- on pre_apps the BEFORE guard trigger may still reject the write.
--
-- Reads OLD through to_jsonb rather than OLD.agent_id. All eight tables
-- carry both columns today, so direct access would work -- but attached
-- to a table without agent_id it would raise and break the caller's
-- write, where this yields NULL and merely over-logs. The safer failure
-- for one function bolted onto eight tables, and the reason `documents`
-- needed no variant of its own when it was added: id and agent_id are
-- read by name out of the jsonb, so the polymorphic owner_type/owner_id
-- pair it also carries is simply not looked at.
--
-- 'cross_agent_*' rather than 'admin_*' because the condition actually
-- tested is "the actor is not this row's owner". Under RLS that means an
-- admin, but it also catches a service-role connection, which has no
-- auth.uid() at all and so is caught by `is distinct from` -- logging
-- privileged server writes is a feature. Naming those rows admin_* would
-- assert a role nothing here verified.
--
-- Note the expected duplication: approve_pre_app and decline_pre_app
-- write their own audit row AND update a rep's pre_apps, so those events
-- produce two rows at different granularities. Additive detail, not a
-- bug.
--
-- INSERT is covered too, against NEW.agent_id -- an admin creating a
-- record in a rep's name (the `insert own` policy permits an admin any
-- agent_id) is a privileged act with no other trace.
--
-- FAIL CLOSED, AND THAT IS INTENTIONAL. This is an AFTER ROW trigger, so
-- it runs inside the same transaction as the statement that fired it, and
-- it carries no EXCEPTION block. If the audit_log insert fails for any
-- reason, the error propagates and **the triggering INSERT/UPDATE/DELETE
-- is rolled back with it.** A write to these eight tables therefore
-- cannot succeed while its audit row silently does not.
--
-- That is the trade we want, and it is the opposite of the choice
-- rls_auto_enable() makes (which swallows per-table failures via
-- EXCEPTION WHEN OTHERS) and of submit-pre-app-secrets (which cannot fail
-- closed, because its ciphertext is already written by the time it
-- audits). Here nothing has been committed yet, so refusing the write is
-- both possible and correct: an unlogged admin edit is worse than a
-- failed one, because the failure is visible and the gap is not.
--
-- The realistic failure is audit_log.actor_id's foreign key to
-- profiles(id): a JWT whose sub has no profiles row would violate it. RLS
-- makes that unreachable in practice (such a caller fails both
-- is_active_agent() and is_admin(), so no policy admits their write), but
-- the rollback is asserted in tests/rls/audit-trigger.test.ts rather than
-- assumed.
-- =====================================================================
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
  -- INSERT is handled first and in its own branch because OLD is NOT ASSIGNED
  -- for an insert. Reading it here -- even inside a CASE that should not
  -- evaluate -- risks "record old is not assigned yet", which would break every
  -- insert on all seven tables. Nothing below this block touches OLD until
  -- TG_OP has ruled INSERT out.
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
    -- Reassignment is checked before ownership, and separately from it. An admin
    -- moving a record they THEMSELVES own into another rep's book has
    -- actor = OLD.agent_id, so the ownership test below would skip it -- yet
    -- moving a record between books is precisely the privileged act a trail
    -- exists for.
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
-- Deliberately NOT granted to authenticated: a trigger fires whether or not
-- the querying role holds EXECUTE. Same treatment as set_updated_at().

-- All eight tables that carry agent_id and are written through Tier 1.
create trigger merchants_audit_cross_agent
  after insert or update or delete on merchants
  for each row execute function log_cross_agent_change();

create trigger leads_audit_cross_agent
  after insert or update or delete on leads
  for each row execute function log_cross_agent_change();

create trigger ghost_sheets_audit_cross_agent
  after insert or update or delete on ghost_sheets
  for each row execute function log_cross_agent_change();

create trigger pre_apps_audit_cross_agent
  after insert or update or delete on pre_apps
  for each row execute function log_cross_agent_change();

create trigger support_tickets_audit_cross_agent
  after insert or update or delete on support_tickets
  for each row execute function log_cross_agent_change();

-- notes has no UPDATE policy (append-only by design), so the update arm never
-- fires there. Listed anyway rather than special-cased: if that policy is ever
-- added, the trail should not have to be remembered separately.
create trigger notes_audit_cross_agent
  after insert or update or delete on notes
  for each row execute function log_cross_agent_change();

create trigger tasks_audit_cross_agent
  after insert or update or delete on tasks
  for each row execute function log_cross_agent_change();

-- documents is the eighth, and was the last one added -- it was excluded at
-- first on the grounds that its access is audited inside create-upload-url and
-- create-download-url, where the event worth recording is the signed-URL mint
-- rather than the metadata row. That reasoning is right about reads and still
-- holds; the two functions keep writing upload_document / download_document.
--
-- It does not cover DELETE, which is what the 11 Aug audit found. documents is
-- the one table whose delete policy is own-row-or-admin rather than admin-only,
-- and a delete mints no URL -- so neither function ran, no trigger fired, and
-- the row vanished with its Storage object orphaned and nothing written down.
-- Three audit mechanisms and documents DELETE fell through all three.
--
-- Expect duplication on upload, as with approve_pre_app: an admin uploading for
-- a rep now produces both upload_document:<owner_type> and cross_agent_insert.
-- One event, two granularities. Assert on `action`, never on row counts.
--
-- The update arm is unreachable here -- documents has no UPDATE policy and no
-- UPDATE grant -- and is attached anyway for the reason notes carries above.
create trigger documents_audit_cross_agent
  after insert or update or delete on documents
  for each row execute function log_cross_agent_change();

-- bug_reports is the ninth, and needs no variant: its reporter column is named
-- agent_id precisely so the generic function reads it. Clearing a report is an
-- UPDATE by an admin on a rep's row, which is exactly what cross_agent_update
-- records -- so who dismissed what is in the trail without any extra work, and
-- resolved_by on the row is the readable copy of the same fact.
create trigger bug_reports_audit_cross_agent
  after insert or update or delete on bug_reports
  for each row execute function log_cross_agent_change();

-- quotes is the tenth, and the decision is worth stating rather than
-- inferring, because the table it most resembles structurally
-- (rep_payout_rows) is the one that is deliberately excluded.
--
-- It gets the trigger. It carries agent_id, it is written through Tier 1 by
-- reps on their own leads, and the ordinary case is therefore actor =
-- agent_id, which logs nothing. An ADMIN building or revising a quote on a
-- rep's lead is exactly the privileged act the trail exists for -- and under
-- the append-only design that lands as a cross_agent_insert naming the new
-- version, which is the right granularity: the version added is named, and
-- the one it supersedes is still there to compare against.
--
-- The rep_payout_rows exclusion does not transfer. Those tables are left out
-- because nobody but an admin can write them at all, so `actor is distinct
-- from row_agent_id` is true for EVERY write and one forty-row import would
-- produce forty audit rows. Here the common writer is the owning rep, so this
-- trigger is quiet by default and only speaks when something unusual happened.
--
-- Note the status UPDATE arm is reachable here, unlike the one on notes or
-- documents: `grant update (status)` is a real privilege a rep holds, so an
-- admin marking a rep's quote accepted writes a cross_agent_update. That is
-- wanted -- it is a change to a commercial record on somebody else's deal.
create trigger quotes_audit_cross_agent
  after insert or update or delete on quotes
  for each row execute function log_cross_agent_change();

-- quote_line_items does NOT get it, for two reasons that each stand alone.
--
-- It has no agent_id, so the function would read NULL out of to_jsonb(NEW)
-- and log every write -- the support_ticket_replies trap. That table answered
-- the same problem with a sibling function resolving the parent's owner, and
-- this one deliberately does not, because of the second reason:
--
-- Even with a working variant it would be pure duplication at a worse
-- granularity. One admin edit is one quote row plus N line rows, so the trail
-- would carry N+1 entries describing a single act, N of them naming a table
-- nobody looks up by id. The parent row already records the event, and
-- `assert on action, never on row counts` would stop being advice and start
-- being the only way to read the table.
--
-- And the hole that forced documents into this list after it was first
-- excluded does not exist here. documents was added because its DELETE fell
-- through all three audit mechanisms: it is the one table whose delete policy
-- is own-row-or-admin, and a delete mints no signed URL, so nothing fired.
-- quote_line_items has no UPDATE and no DELETE in either layer, so there is no
-- verb that could go unrecorded.

-- The rep_payout tables are the deliberate exclusion, and the reasoning is the
-- same shape as the one that kept documents out at first -- audit where the event
-- is -- but it reaches a different conclusion, so it is worth stating rather than
-- inferring.
--
-- rep_payout_rows carries agent_id and would work with this function unchanged.
-- The problem is that it would fire on EVERY write. This is a table an admin
-- maintains on a rep's behalf by definition: nobody but an admin can write it at
-- all (no INSERT policy, admin-only UPDATE and DELETE), so `actor is distinct
-- from row_agent_id` is true for all of them. One forty-row import would write
-- forty cross_agent_insert rows, a period delete another forty, and every typed
-- figure one more -- burying the entries that matter under the ones that don't,
-- which is the exact failure the "only cross-agent mutations" rule above exists
-- to avoid.
--
-- And it would still not record what a figure changed FROM, because audit_log has
-- no detail column. So the trail is split by granularity instead: one audit_log
-- row per committed batch and per deleted period (written by the Edge Function
-- and by the delete path, where the event is), and rep_payout_row_history for the
-- value changes, where before-and-after actually fits.
--
-- rep_payout_batches, rep_payout_import_rows and rep_payout_row_history are
-- excluded for the simpler reason: none of them has an agent_id column, so this
-- function would read NULL, find every actor `distinct from` it, and log
-- everything -- the same trap support_ticket_replies needed its own function to
-- avoid.

-- ---------------------------------------------------------------------
-- support_ticket_replies gets its OWN function, not the one above.
--
-- log_cross_agent_change() reads `agent_id` by name out of to_jsonb(NEW/OLD).
-- This table has no such column -- author_id records who spoke, and ownership
-- lives on the parent ticket -- so the read yields NULL, `actor is distinct
-- from null` is true for every caller, and every reply including a rep's own
-- would log a cross_agent_insert. That is precisely the noise the "a rep
-- editing their own lead is ordinary work" rule exists to avoid.
--
-- Skipping the trigger entirely was the other option, and it is wrong here:
-- an admin replying on a rep's ticket is exactly the class of event this
-- mechanism exists to record, and no write to support_tickets accompanies it,
-- so the parent's trigger does not fire either.
--
-- security definer for the same reason its sibling is: audit_log has no insert
-- policy, so a caller-run function could not write the row.
--
-- Fail-closed, deliberately: no EXCEPTION block, so a failed audit insert rolls
-- back the reply that triggered it. A reply cannot be posted while its trail
-- quietly is not.
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
  -- assigned yet" -- which would break every reply. This is the same trap
  -- log_cross_agent_change() opens with a comment about.
  if TG_OP = 'DELETE' then
    reply := to_jsonb(OLD);
  else
    reply := to_jsonb(NEW);
  end if;

  select agent_id into ticket_owner
    from support_tickets
   where id = (reply ->> 'ticket_id')::int;

  -- The rep's own replies on their own ticket are ordinary work. Everything
  -- else -- an admin answering, or a rep somehow reaching another book -- is
  -- what the trail is for.
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
-- function, so this line is what closes it.
revoke all on function log_cross_agent_reply() from public;
revoke all on function log_cross_agent_reply() from anon, authenticated;

create trigger support_ticket_replies_audit_cross_agent
  after insert or update or delete on support_ticket_replies
  for each row execute function log_cross_agent_reply();

-- =====================================================================
-- PRE-APP STATUS GUARD — fires on INSERT and on UPDATE, and needs both.
--
-- Why this exists: the pre_apps update policy is
-- `(agent_id = auth.uid() and is_active_agent()) or is_admin()` and says
-- nothing about WHICH COLUMNS may change. Without this trigger an agent can
-- PATCH `status = 'approved'` straight through PostgREST, skipping
-- approve_pre_app entirely -- its is_admin() guard is meaningless if the
-- column is directly writable -- and can raise split_agent_pct after
-- submitting but before approval, which approve_pre_app then copies into
-- merchants. RLS cannot express "status unchanged": a `with check`
-- expression sees only NEW, never OLD. A row trigger can.
--
-- The INSERT half was added second, and the gap it closes is worth recording
-- because the paragraph above described it exactly one verb over and nobody
-- noticed. While this trigger was BEFORE UPDATE only, `status` was unwritable
-- after the fact but perfectly writable on the way in: the insert policy reads
-- agent_id and nothing else, the CHECK admits all four statuses as legal
-- INITIAL values, and the grant is table-level with no column list. So any
-- active rep could POST /rest/v1/pre_apps with status = 'approved' and land in
-- a terminal state directly -- no is_admin() check, no merchants row, and no
-- audit trail either, because pre_apps_audit_cross_agent logs only when the
-- actor differs from the row's agent_id and on your own insert it does not.
--
-- status = 'submitted' was the worse one. It puts a fabricated row in the
-- admin's queue looking submitted while skipping every completeness rule in
-- submit_pre_app() -- owners, the 51% control person, an SSN per owner --
-- and approve_pre_app() re-checks only `status = 'submitted'`, so an admin
-- approving in good faith would build a real merchant, carrying the rep's own
-- split_agent_pct, from an application with no owner and no banking details.
--
-- Hence: a pre-app is born a draft, for everyone, and the four RPCs stay the
-- only route to any other status. date_submitted is pinned on INSERT for the
-- same reason it is pinned on UPDATE -- it is submit_pre_app()'s to set, and a
-- fabricated submission date is a fabricated receipt.
--
-- How the trigger tells an RPC's own write from a client's: a session-local
-- flag, NOT the caller's role. `security definer` changes current_user, not
-- the session's JWT claims, so auth.uid() inside submit_pre_app still
-- returns the caller and is_admin() still evaluates against the caller's
-- profile. approve_pre_app's caller is an admin by its own guard, but
-- submit_pre_app's caller is normally the agent submitting their own draft --
-- so a role test would let approval through and block submission, which is
-- the worst possible split.
--
-- Deliberately no is_admin() early return. With one, an admin could PATCH
-- status to 'approved' directly and reach the approved state with no
-- merchants row and no audit_log entry: a data-integrity hole, not just an
-- authorization one. Status moves only through an RPC, for everyone.
-- is_admin() appears here solely to relax the separate rule that non-draft
-- rows are frozen.
--
-- NOTE FOR EDGE FUNCTION AUTHORS: this fires for the table OWNER too, so a
-- service-role connection is not exempt — and because such a connection has
-- no auth.uid(), is_admin() is false there as well. Privileged server code
-- therefore cannot INSERT a non-draft pre-app, cannot UPDATE pre_apps.status,
-- and cannot touch a non-draft pre-app at all; it has to call these RPCs.
-- That is intended: it keeps the audit_log write and the merchant creation on
-- the only path that exists. If some future function genuinely needs to bypass
-- it, set the transition flag around its own write rather than weakening the
-- trigger.
--
-- Test fixtures are the standing example of a legitimate bypass, and they are
-- the reason the flag is checked before the INSERT branch and not only before
-- the UPDATE one: tests/helpers/db.ts seeds a submitted pre-app, and the two
-- column-constraint tests in tests/rls/pre-apps.test.ts have to reach NOT NULL
-- and the CHECK rather than being intercepted here. All three set the flag
-- around their own insert. A client cannot -- see the note in the body.
-- =====================================================================
create or replace function pre_apps_guard_transitions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Set by the four state-machine RPCs immediately before their own UPDATE
  -- and cleared immediately after. Named under `tapswipe.` rather than
  -- `request.` on purpose: PostgREST populates the request.* namespace from
  -- client-controlled headers. A client cannot set this one -- set_config
  -- lives in pg_catalog, so it is not reachable as /rpc/set_config either.
  if coalesce(current_setting('tapswipe.pre_app_transition', true), '') = 'on' then
    return new;
  end if;

  -- INSERT has no OLD, so this branch has to return before the comparisons
  -- below rather than falling through them -- `new.status is distinct from
  -- old.status` against a NULL OLD record would raise, and on a BEFORE INSERT
  -- trigger that is a confusing way to be right by accident.
  --
  -- `is distinct from` rather than `<>` because a BEFORE trigger runs ahead of
  -- the column constraints: an explicit `status = null` arrives here still
  -- null, before NOT NULL has had a chance to reject it.
  if tg_op = 'INSERT' then
    if new.status is distinct from 'draft' then
      raise exception
        'a pre-app is created as a draft; status moves only through submit_pre_app(), approve_pre_app(), decline_pre_app() or reopen_pre_app()'
        using errcode = 'PT409';
    end if;

    if new.date_submitted is not null then
      raise exception 'date_submitted is set by submit_pre_app()' using errcode = 'PT409';
    end if;

    return new;
  end if;

  if new.status is distinct from old.status then
    raise exception
      'status changes only through submit_pre_app(), approve_pre_app(), decline_pre_app() or reopen_pre_app()'
      using errcode = 'PT409';
  end if;

  if new.date_submitted is distinct from old.date_submitted then
    raise exception 'date_submitted is set by submit_pre_app()' using errcode = 'PT409';
  end if;

  -- Decision: agents edit drafts, admins edit anything. Enforced here rather
  -- than in RLS because the policy cannot see OLD.status.
  if old.status <> 'draft' and not is_admin() then
    raise exception 'a % pre-app can only be edited by an admin', old.status
      using errcode = 'PT409';
  end if;

  return new;
end;
$$;

-- One trigger for both verbs rather than two: the function already branches on
-- tg_op, and a second trigger name would let someone drop half the guard while
-- the other half went on looking like full coverage -- which is the shape of
-- the bug this closes.
create trigger pre_apps_guard_transitions
  before insert or update on pre_apps
  for each row execute function pre_apps_guard_transitions();

-- =====================================================================
-- PRE-APP SUBMISSION — Tier 2. draft -> submitted, with the completeness
-- rules enforced server-side rather than trusted from the browser.
--
-- security definer, which needs justifying against the standing rule that
-- the three *_secrets tables are never granted and never given a policy.
-- This does not break that rule: the rule is about role GRANTs and RLS
-- policies, and neither is added. A definer function runs as the owner and
-- so bypasses both by a third mechanism -- the same one approve_pre_app
-- already uses to write merchants. It is still a door through the double
-- lock, so it is constrained three ways:
--
--   1. It only ever asks `exists (select 1 ...)`. No *_encrypted column is
--      named anywhere in the body, so no ciphertext can leave even though
--      it holds the privilege to read one. A test asserts that from
--      pg_get_functiondef, so the property is pinned rather than promised.
--   2. The existence check sits behind the ownership check, so it is no
--      oracle: by the time it runs the caller has been proven to own the row.
--   3. set search_path = public, so a temp-table shadow cannot redirect a read.
--
-- Because RLS does not scope reads inside a definer function, the ownership
-- check is written out by hand -- and "no such pre-app" and "not yours"
-- raise the IDENTICAL message. That is the SQL form of the 404-not-403 rule
-- the Edge Functions follow. PTxyz SQLSTATEs are PostgREST's mapping to HTTP
-- status codes, so the browser sees 404/409/422 rather than a flat 400.
-- =====================================================================
create or replace function submit_pre_app(pre_app_id_input int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  pa            pre_apps;
  bp            pre_app_business_profile;
  owner_count   int;
  control_count int;
begin
  select * into pa from pre_apps where id = pre_app_id_input;
  if not found then
    raise exception 'pre-app not found' using errcode = 'PT404';
  end if;

  if is_admin() then
    null;                       -- an admin may submit on a rep's behalf
  elsif pa.agent_id = auth.uid() then
    -- Telling the OWNER their account is off discloses nothing, and beats
    -- leaving them with an unexplained "not found".
    if not is_active_agent() then
      raise exception 'account is deactivated' using errcode = 'PT403';
    end if;
  else
    -- Byte-for-byte identical to the not-found branch above.
    raise exception 'pre-app not found' using errcode = 'PT404';
  end if;

  if pa.status <> 'draft' then
    raise exception 'pre-app is not a draft (status: %)', pa.status using errcode = 'PT409';
  end if;

  if coalesce(btrim(pa.dba_name), '') = '' then
    raise exception 'a DBA name is required' using errcode = 'PT422';
  end if;
  if coalesce(btrim(pa.legal_business_name), '') = '' then
    raise exception 'a legal business name is required' using errcode = 'PT422';
  end if;

  select count(*), count(*) filter (where percent_owned >= 51)
    into owner_count, control_count
    from pre_app_owners where pre_app_id = pa.id;

  if owner_count = 0 then
    raise exception 'at least one owner is required' using errcode = 'PT422';
  end if;
  -- Product consequence worth stating plainly: a genuine 50/50 two-owner
  -- partnership cannot be submitted. That is the rule (processors want one
  -- control person), it will come up, and the message has to read as a rule
  -- rather than a bug.
  if control_count = 0 then
    raise exception 'one owner must hold at least 51%% ownership' using errcode = 'PT422';
  end if;

  if exists (
    select 1 from pre_app_owners o
     where o.pre_app_id = pa.id
       and not exists (select 1 from pre_app_owner_secrets s where s.pre_app_owner_id = o.id)
  ) then
    raise exception 'every owner must have an SSN on file' using errcode = 'PT422';
  end if;

  -- Card mix: TWO INDEPENDENT PAIRS, nothing else. swiped+keyed is one 100%
  -- split of how the card is read; present+not-present is a second. moto and
  -- internet are informational and deliberately NOT summed against
  -- card_not_present_pct. Each pair is checked only when at least one of its
  -- columns is filled, so a half-completed profile still submits. The
  -- wizard's client-side blocker list must implement exactly these two.
  select * into bp from pre_app_business_profile where pre_app_id = pa.id;
  if found then
    if (bp.card_swiped_pct is not null or bp.card_keyed_pct is not null)
       and coalesce(bp.card_swiped_pct, 0) + coalesce(bp.card_keyed_pct, 0) <> 100 then
      raise exception 'swiped and keyed percentages must total 100' using errcode = 'PT422';
    end if;
    if (bp.card_present_pct is not null or bp.card_not_present_pct is not null)
       and coalesce(bp.card_present_pct, 0) + coalesce(bp.card_not_present_pct, 0) <> 100 then
      raise exception 'card-present and card-not-present percentages must total 100'
        using errcode = 'PT422';
    end if;
  end if;

  -- Existence only -- see the header. No *_encrypted column is named here.
  -- Terminal secrets are deliberately NOT required: whether an RP password is
  -- ever mandatory is an open question, and requiring one would block
  -- submissions for deals that have no terminal.
  if not exists (select 1 from pre_app_banking_secrets where pre_app_id = pa.id) then
    raise exception 'banking details have not been submitted' using errcode = 'PT422';
  end if;

  perform set_config('tapswipe.pre_app_transition', 'on', true);
  update pre_apps
     set status = 'submitted',
         date_submitted = current_date,
         decline_reason = null
   where id = pa.id;
  perform set_config('tapswipe.pre_app_transition', '', true);

  -- auth.uid() is available here: this is an ordinary authenticated PostgREST
  -- request, definer or not. Contrast the Edge Functions, where a service-role
  -- connection has no auth.uid() and actor_id must be passed in explicitly.
  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'submit_pre_app', 'pre_apps', pa.id::text);

  return pa.id;
end;
$$;

-- =====================================================================
-- PRE-APP APPROVAL — Tier 2. security definer because it writes to
-- merchants regardless of the caller's own row restrictions; guards that
-- power with an explicit is_admin() check up front rather than relying on
-- grants alone.
--
-- Five things this corrects against the original version:
--   1. No status gate -- it would approve a draft that was never submitted,
--      and approve the same pre-app twice, creating a second merchant each
--      time.
--   2. Silent no-op on a bad id -- `insert ... select ... where id = $1`
--      matched nothing, new_merchant_id stayed NULL, the UPDATE matched
--      nothing, and it returned NULL after writing an audit_log row claiming
--      an approval that never happened.
--   3. No `set search_path`, the standard definer hardening every other
--      function here already carries.
--   4. The split columns were not copied, so every approved merchant landed
--      on NULL/NULL.
--   5. audit_log recorded the pre-app id, which the caller already supplied,
--      and not the merchant id -- the one fact nobody could recover later.
-- =====================================================================
create or replace function approve_pre_app(pre_app_id_input int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  pa pre_apps;
  new_merchant_id int;
begin
  if not is_admin() then
    raise exception 'only admins can approve pre-apps' using errcode = 'PT403';
  end if;

  select * into pa from pre_apps where id = pre_app_id_input;
  if not found then
    -- The caller is a verified admin who can already see every row, so there
    -- is nothing to withhold and this names the id. The opposite of
    -- submit_pre_app's deliberately vague 404, for the opposite reason.
    raise exception 'pre-app % not found', pre_app_id_input using errcode = 'PT404';
  end if;

  if pa.status = 'approved' then
    raise exception 'pre-app % is already approved', pre_app_id_input using errcode = 'PT409';
  end if;
  if pa.status <> 'submitted' then
    raise exception 'pre-app % must be submitted before approval (status: %)',
      pre_app_id_input, pa.status using errcode = 'PT409';
  end if;

  -- agent_id comes from the pre-app, never auth.uid(): an admin approving on
  -- a rep's behalf must not move the merchant into their own book. Same
  -- reasoning as convert_ghost_sheet_to_lead.
  --
  -- pre_app_id records which application this came from. Note what it is not:
  -- a live link. Every other column here is a COPY taken at approval, and
  -- nothing syncs afterwards, so an admin editing an approved pre-app changes
  -- the application and not the merchant. That is deliberate -- the merchant is
  -- the record of what was agreed -- and the pointer exists so the divergence
  -- is at least visible from both ends rather than silent.
  insert into merchants (agent_id, dba, legal_business_name, status,
                         split_agent_pct, split_company_pct, pre_app_id)
  values (pa.agent_id, pa.dba_name, pa.legal_business_name, 'active',
          pa.split_agent_pct, pa.split_company_pct, pa.id)
  returning id into new_merchant_id;

  perform set_config('tapswipe.pre_app_transition', 'on', true);
  update pre_apps set status = 'approved' where id = pa.id;
  perform set_config('tapswipe.pre_app_transition', '', true);

  -- Two rows, so the trail links both directions. audit_log has no detail
  -- column and adding one is a bigger change than this needs.
  insert into audit_log (actor_id, action, table_name, row_id) values
    (auth.uid(), 'approve_pre_app', 'pre_apps',  pa.id::text),
    (auth.uid(), 'approve_pre_app', 'merchants', new_merchant_id::text);

  return new_merchant_id;
end;
$$;

-- =====================================================================
-- PRE-APP DECLINE / REOPEN — Tier 2. A reason is required: a rep told only
-- "declined" has nothing to act on and will just ask an admin directly.
-- =====================================================================
create or replace function decline_pre_app(pre_app_id_input int, reason_input text)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  pa pre_apps;
begin
  if not is_admin() then
    raise exception 'only admins can decline pre-apps' using errcode = 'PT403';
  end if;

  if coalesce(btrim(reason_input), '') = '' then
    raise exception 'a decline reason is required' using errcode = 'PT422';
  end if;

  select * into pa from pre_apps where id = pre_app_id_input;
  if not found then
    raise exception 'pre-app % not found', pre_app_id_input using errcode = 'PT404';
  end if;
  if pa.status <> 'submitted' then
    raise exception 'only a submitted pre-app can be declined (status: %)', pa.status
      using errcode = 'PT409';
  end if;

  perform set_config('tapswipe.pre_app_transition', 'on', true);
  update pre_apps
     set status = 'declined', decline_reason = btrim(reason_input)
   where id = pa.id;
  perform set_config('tapswipe.pre_app_transition', '', true);

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'decline_pre_app', 'pre_apps', pa.id::text);

  return pa.id;
end;
$$;

-- Reopen is available to the OWNING REP as well as an admin: the point of
-- recording a decline reason is that the rep can fix it themselves. The
-- reason survives the reopen so it stays on screen while they work, and
-- submit_pre_app clears it on the next successful submission.
create or replace function reopen_pre_app(pre_app_id_input int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  pa pre_apps;
begin
  select * into pa from pre_apps where id = pre_app_id_input;
  if not found then
    raise exception 'pre-app not found' using errcode = 'PT404';
  end if;

  if is_admin() then
    null;
  elsif pa.agent_id = auth.uid() then
    if not is_active_agent() then
      raise exception 'account is deactivated' using errcode = 'PT403';
    end if;
  else
    raise exception 'pre-app not found' using errcode = 'PT404';
  end if;

  if pa.status <> 'declined' then
    raise exception 'only a declined pre-app can be reopened (status: %)', pa.status
      using errcode = 'PT409';
  end if;

  perform set_config('tapswipe.pre_app_transition', 'on', true);
  update pre_apps set status = 'draft' where id = pa.id;
  perform set_config('tapswipe.pre_app_transition', '', true);

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'reopen_pre_app', 'pre_apps', pa.id::text);

  return pa.id;
end;
$$;

-- =====================================================================
-- PRE-APP SECRETS PRESENCE — Tier 2. Two booleans the wizard's review step
-- needs and cannot get any other way: does banking ciphertext exist, and how
-- many owners still have no SSN.
--
-- Why this exists rather than reusing read-pre-app-secrets: that function
-- DECRYPTS. Calling it to learn a boolean makes an admin's browser receive
-- full plaintext it never asked to see, and writes an audit_log row claiming
-- a full read that no human performed -- so merely opening the review tab
-- would pollute the one trail that is supposed to mean "somebody looked at an
-- SSN". Presence is not disclosure, so it gets its own door.
--
-- security definer for the same reason submit_pre_app is, and constrained the
-- same three ways: it only ever asks `exists`/`count`, so no *_encrypted
-- column is named anywhere in the body and no ciphertext can leave; the
-- checks sit behind the ownership check, so it is no oracle; and
-- set search_path = public stops a temp-table shadow redirecting a read. A
-- test asserts the no-ciphertext property from pg_get_functiondef.
--
-- Deliberately NO audit_log write. It reveals only what the rep is already
-- being asked to supply, and logging every render of a form step would bury
-- the reads that matter.
-- =====================================================================
create or replace function pre_app_secrets_presence(pre_app_id_input int)
returns table (banking_on_file boolean, owners_missing_ssn int)
language plpgsql
security definer
set search_path = public
as $$
declare
  pa pre_apps;
begin
  select * into pa from pre_apps where id = pre_app_id_input;
  if not found then
    raise exception 'pre-app not found' using errcode = 'PT404';
  end if;

  -- Byte-for-byte the guard submit_pre_app uses, for the same reason: "not
  -- yours" and "doesn't exist" must be indistinguishable.
  if is_admin() then
    null;
  elsif pa.agent_id = auth.uid() then
    if not is_active_agent() then
      raise exception 'account is deactivated' using errcode = 'PT403';
    end if;
  else
    raise exception 'pre-app not found' using errcode = 'PT404';
  end if;

  return query
    select
      exists (
        select 1 from pre_app_banking_secrets b where b.pre_app_id = pa.id
      ),
      (
        select count(*)::int
          from pre_app_owners o
         where o.pre_app_id = pa.id
           and not exists (
             select 1 from pre_app_owner_secrets s
              where s.pre_app_owner_id = o.id
           )
      );
end;
$$;

revoke all on function pre_app_secrets_presence(int) from public;
grant execute on function pre_app_secrets_presence(int) to authenticated, service_role;

-- =====================================================================
-- GHOST SHEET CONVERSION — Tier 2. Plain function, NOT security definer:
-- the caller owns both rows, so letting their own RLS scope the reads and
-- writes is safer than re-implementing the ownership check by hand. One
-- transaction, so a half-converted sheet is unreachable.
-- =====================================================================
create or replace function convert_ghost_sheet_to_lead(ghost_sheet_id_input int)
returns int
language plpgsql
as $$
declare
  sheet ghost_sheets;
  new_lead_id int;
begin
  -- RLS applies (security invoker), so this finds nothing unless the caller
  -- owns the sheet or is an admin — no hand-written ownership check needed.
  -- "not found" therefore covers both a nonexistent sheet and someone
  -- else's, which is the same non-disclosure the detail pages rely on.
  select * into sheet from ghost_sheets where id = ghost_sheet_id_input;
  if not found then
    raise exception 'ghost sheet not found';
  end if;
  if sheet.lead_id is not null then
    raise exception 'ghost sheet already converted';
  end if;

  -- agent_id comes from the sheet, not auth.uid(): an admin converting on a
  -- rep's behalf must not move the lead into their own book.
  --
  -- 'Ghost sheet' rather than 'ghost_sheet'. lead_source is free text a rep
  -- types ("Referral", "Cold call", "Web form") and it renders raw on the lead
  -- page, so the machine-shaped value stood out as the one entry nobody wrote.
  --
  -- 'new', not 'open'. 'open' was never in a vocabulary because there was no
  -- vocabulary; as of 20261002 there is, and leads_status_vocabulary is NOT
  -- VALID rather than disabled — it binds every insert from here on, including
  -- this one. A converted sheet is the most new a lead can be.
  insert into leads (agent_id, dba, contact_name, contact_phone, lead_source, status)
  values (sheet.agent_id, sheet.dba, sheet.contact_name, sheet.contact_phone,
          'Ghost sheet', 'new')
  returning id into new_lead_id;

  -- leads has no notes column, so the sheet's notes become a row in the
  -- polymorphic notes table. Guarded because notes.body is `not null`.
  if sheet.notes is not null and btrim(sheet.notes) <> '' then
    insert into notes (agent_id, owner_type, owner_id, body)
    values (sheet.agent_id, 'lead', new_lead_id, sheet.notes);
  end if;

  update ghost_sheets
     set lead_id = new_lead_id, status = 'converted'
   where id = ghost_sheet_id_input;

  return new_lead_id;
end;
$$;

-- =====================================================================
-- DASHBOARD COUNTS — Tier 2. Plain function, NOT security definer, for
-- the same reason convert_ghost_sheet_to_lead is: the caller's own RLS
-- does the scoping. Every count below is therefore automatically "mine"
-- for an agent and "everyone's" for an admin, with no role branch in the
-- function and no agent_id filter to keep in step with the policies.
--
-- This is the whole argument for not marking it `security definer`. A
-- definer version would run as the owner, bypass RLS, and have to
-- re-implement `(agent_id = auth.uid() and is_active_agent()) or
-- is_admin()` five times by hand — five more places for the access rule
-- to drift, in a function whose entire output is numbers an agent should
-- not be able to learn about other people's books.
--
-- One round trip rather than five head:true selects from the browser,
-- which also makes the set of numbers a single atomic snapshot.
--
-- On "active":
--
--   active_merchants  merchants.status = 'active'. A real constrained
--                     vocabulary, so this one means what it says.
--   active_leads      leads with no pre-app pointing at them. Still NOT a
--                     status filter, and deliberately unchanged by the
--                     20261002 vocabulary: leads.status is now constrained,
--                     but it is a stage a rep sets by hand and this count
--                     is a funnel position the records themselves prove.
--                     pre_apps.lead_id is a real column with a real
--                     meaning, and it makes the dashboard read as a
--                     funnel — a deal counted under Pre-Apps is no longer
--                     counted under Leads, so the four figures sum to
--                     distinct work rather than double-counting. Reading
--                     `status <> 'lost'` instead would let a rep who never
--                     updates a stage inflate the number, and would
--                     double-count every lead already under Pre-Apps.
--                     This is the same argument as "there is no 'won'
--                     value" on leads.status: a derived fact stays derived.
--
-- ghost_sheets and pre_apps are deliberately unfiltered totals.
--
-- ---------------------------------------------------------------------
-- THE FILTERS (added 20261007) AND WHY THEY DO NOT NEED A DEFINER
--
-- Six optional parameters, every one defaulting to null, so a bare
-- dashboard_counts() is byte-for-byte the function above and every
-- existing caller keeps working untouched.
--
-- All of them are EXTRA WHERE CLAUSES ON TOP OF RLS, never instead of
-- it. That is the whole security argument and it is worth stating
-- plainly, because "filter by another rep's id" sounds like exactly the
-- thing a definer would be reached for: an agent who passes
-- agent_id_input = <someone else> gets `agent_id = other` ANDed with the
-- policy's `agent_id = auth.uid()`, which is unsatisfiable, so the answer
-- is zero rather than a disclosure. A definer version would have to
-- re-derive the policy by hand before it could apply any of this, which
-- is six more places for the access rule to drift in a function whose
-- entire output is numbers about other people's books.
--
-- The manager and territory filters resolve THROUGH profiles, and that
-- subselect is itself RLS-scoped: the profiles select policy is own-row
-- plus admin, so for an agent it can only ever return their own row. A
-- rep filtering by a manager they do not report to therefore gets zero,
-- by the same mechanism and with no extra check.
--
-- NONE OF THIS IS AN ACCESS CHANGE. manager_id and territory stay the
-- reporting labels their column comments describe -- no policy reads
-- either, and a manager does not gain a wider book by being named here.
-- What this adds is filtering FOR AN ADMIN WHO ALREADY SEES EVERY ROW,
-- which is precisely the use the manager_id comment anticipates.
--
--   agent_id_input    one rep.
--   manager_id_input  every rep reporting to that manager. One hop, which
--                     is an equality rather than a recursive CTE because
--                     set_manager() makes chains unreachable.
--   territory_input   every rep carrying that label. Many reps per
--                     territory, so this is a set like the manager one.
--   from/to_date      created_at window, applied to all five tables.
--                     to_date is INCLUSIVE of its whole day --
--                     `< to_date + 1`, not `<= to_date`, because
--                     created_at is a timestamptz and anything created
--                     after midnight on the last day would otherwise
--                     vanish from the range a person believes they asked
--                     for.
--   status_input      leads.status, and ONLY leads: a pipeline stage is
--                     meaningless for a merchant or a ticket.
--
-- The three agent filters are applied together as one set, via
-- scoped_agents, and only when at least one of them is given. The
-- `by_agent` guard is not an optimisation: without it the UNFILTERED
-- counts would start depending on the profiles select policy, so a future
-- change there would silently move every figure on the dashboard.
--
-- status_input gets its OWN output column rather than narrowing
-- active_leads, and that is the important one. active_leads means "a lead
-- no pre-app points at yet" -- a funnel position the records prove. A
-- stage is something a rep types. Folding the stage filter into that
-- column would make one output mean two different things depending on a
-- parameter, and would read as near-zero for 'application_sent' (those
-- leads are exactly the ones a pre-app points at) while looking perfectly
-- healthy. leads_at_stage is null when no stage was asked for, which is a
-- different fact from zero and is rendered as a different thing.
-- =====================================================================
drop function if exists dashboard_counts();

create or replace function dashboard_counts(
  agent_id_input uuid default null,
  manager_id_input uuid default null,
  territory_input text default null,
  status_input text default null,
  from_date_input date default null,
  to_date_input date default null
)
returns table (
  active_merchants bigint,
  active_leads bigint,
  ghost_sheets_total bigint,
  pre_apps_total bigint,
  open_tickets bigint,
  leads_at_stage bigint
)
language sql
stable
-- Output names are prefixed/suffixed away from the table names on purpose.
-- `returns table` makes each one a parameter that is in scope inside the body,
-- so an output called `ghost_sheets` would collide with the relation of the
-- same name. Every reference below is schema- or alias-qualified for the same
-- reason. The parameters carry _input for the same reason.
as $
  with filters as (
    select (agent_id_input is not null
         or manager_id_input is not null
         or territory_input is not null) as by_agent
  ),
  scoped_agents as (
    -- RLS applies to this read like any other. For an admin it is every
    -- matching rep; for an agent it is at most their own row, which is what
    -- makes "filter by somebody else" return nothing instead of something.
    select p.id
      from public.profiles p, filters f
     where f.by_agent
       and (agent_id_input is null or p.id = agent_id_input)
       and (manager_id_input is null or p.manager_id = manager_id_input)
       and (territory_input is null or p.territory = territory_input)
  )
  select
    (select count(*)
       from public.merchants m, filters f
      where m.status = 'active'
        and (not f.by_agent or m.agent_id in (select id from scoped_agents))
        and (from_date_input is null or m.created_at >= from_date_input)
        and (to_date_input is null or m.created_at < to_date_input + 1)),
    (select count(*)
       from public.leads l, filters f
      where not exists (
            select 1 from public.pre_apps p where p.lead_id = l.id
          )
        and (not f.by_agent or l.agent_id in (select id from scoped_agents))
        and (from_date_input is null or l.created_at >= from_date_input)
        and (to_date_input is null or l.created_at < to_date_input + 1)),
    (select count(*)
       from public.ghost_sheets g, filters f
      where (not f.by_agent or g.agent_id in (select id from scoped_agents))
        and (from_date_input is null or g.created_at >= from_date_input)
        and (to_date_input is null or g.created_at < to_date_input + 1)),
    (select count(*)
       from public.pre_apps a, filters f
      where (not f.by_agent or a.agent_id in (select id from scoped_agents))
        and (from_date_input is null or a.created_at >= from_date_input)
        and (to_date_input is null or a.created_at < to_date_input + 1)),
    (select count(*)
       from public.support_tickets t, filters f
      where t.status = 'open'
        and (not f.by_agent or t.agent_id in (select id from scoped_agents))
        and (from_date_input is null or t.created_at >= from_date_input)
        and (to_date_input is null or t.created_at < to_date_input + 1)),
    -- Null, not zero, when no stage was asked for. Zero would read as "no
    -- leads at that stage" on a dashboard that was never asked about one.
    case when status_input is null then null else (
      select count(*)
        from public.leads ls, filters f
       where ls.status = status_input
         and (not f.by_agent or ls.agent_id in (select id from scoped_agents))
         and (from_date_input is null or ls.created_at >= from_date_input)
         and (to_date_input is null or ls.created_at < to_date_input + 1)
    ) end;
$;

-- The signature changed, so these have to name the new one: the privileges on
-- the dropped zero-argument function went with it, and a function with no
-- explicit grants is callable by PUBLIC -- which includes anon.
revoke all on function dashboard_counts(uuid, uuid, text, text, date, date) from public;
grant execute on function dashboard_counts(uuid, uuid, text, text, date, date)
  to authenticated, service_role;

-- =====================================================================
-- GLOBAL SEARCH — Tier 2. Plain function, NOT security definer, and here
-- that is a security property rather than a convenience: a search box is
-- exactly the shape of thing that turns into a disclosure bug. Running as
-- the invoker means an agent's query is filtered by the same select
-- policies their list pages use, so the box cannot surface a record the
-- rest of the app would hide. A definer version would search everything
-- and rely on a hand-written filter being right five times over.
--
-- Returns a flat (kind, record_id, title, subtitle) shape rather than one
-- column per table, so the caller renders a single list. `record_id` is
-- named away from `id` because `returns table` puts these names in scope
-- inside the body.
--
-- Two guards on the input:
--   - Under MIN_TERM characters returns nothing, so an empty or one-key
--     query doesn't select every row the caller can see.
--   - The LIKE metacharacters are escaped, so typing '%' searches for a
--     percent sign instead of matching everything. Not a privilege issue
--     — RLS still applies — but "_" silently matching any character makes
--     search results look broken.
--
-- limit_input is per record kind, not overall, so one noisy table cannot
-- crowd the others out of the list.
-- =====================================================================
create or replace function search_crm(query_input text, limit_input int default 5)
returns table (
  kind text,
  record_id int,
  title text,
  subtitle text
)
language sql
stable
as $$
  with term as (
    select
      '%' ||
      -- Backslash first: escaping it after adding the others would escape the
      -- backslashes this very expression introduces.
      replace(replace(replace(btrim(query_input), '\', '\\'), '%', '\%'), '_', '\_')
      || '%' as pattern,
      length(btrim(coalesce(query_input, ''))) as term_length
  ),
  hits as (
    select * from (
      select 1 as rank, 'lead'::text as kind, l.id as record_id,
             coalesce(l.dba, l.contact_name, 'Lead #' || l.id) as title,
             l.contact_name as subtitle
        from public.leads l, term t
       where t.term_length >= 2
         and (l.dba ilike t.pattern
           or l.contact_name ilike t.pattern
           or l.contact_phone ilike t.pattern
           or l.contact_email ilike t.pattern
           or l.merchant_legal_name ilike t.pattern)
       order by l.dba
       limit limit_input
    ) lead_hits
    union all
    select * from (
      select 2 as rank, 'pre_app'::text as kind, p.id as record_id,
             p.dba_name as title,
             coalesce(p.legal_business_name, p.contact_name) as subtitle
        from public.pre_apps p, term t
       where t.term_length >= 2
         and (p.dba_name ilike t.pattern
           or p.legal_business_name ilike t.pattern
           or p.contact_name ilike t.pattern
           or p.email_address ilike t.pattern)
       order by p.dba_name
       limit limit_input
    ) pre_app_hits
    union all
    select * from (
      select 3 as rank, 'merchant'::text as kind, m.id as record_id,
             m.dba as title,
             coalesce(m.legal_business_name, m.mid) as subtitle
        from public.merchants m, term t
       where t.term_length >= 2
         and (m.dba ilike t.pattern
           or m.legal_business_name ilike t.pattern
           or m.mid ilike t.pattern)
       order by m.dba
       limit limit_input
    ) merchant_hits
    union all
    select * from (
      select 4 as rank, 'ghost_sheet'::text as kind, g.id as record_id,
             coalesce(g.dba, g.contact_name, 'Ghost sheet #' || g.id) as title,
             g.contact_name as subtitle
        from public.ghost_sheets g, term t
       where t.term_length >= 2
         and (g.dba ilike t.pattern
           or g.contact_name ilike t.pattern
           or g.contact_phone ilike t.pattern)
       order by g.dba
       limit limit_input
    ) ghost_sheet_hits
    union all
    select * from (
      select 5 as rank, 'support_ticket'::text as kind, s.id as record_id,
             s.subject as title,
             coalesce(s.category, s.serial_number_imei) as subtitle
        from public.support_tickets s, term t
       where t.term_length >= 2
         and (s.subject ilike t.pattern
           or s.serial_number_imei ilike t.pattern
           or s.category ilike t.pattern)
       order by s.subject
       limit limit_input
    ) support_ticket_hits
  )
  select h.kind, h.record_id, h.title, h.subtitle
    from hits h
   order by h.rank, h.title;
$$;

revoke all on function search_crm(text, int) from public;
grant execute on function search_crm(text, int) to authenticated, service_role;

-- =====================================================================
-- DUPLICATE DETECTION — Tier 2, and the MIRROR of search_crm above.
--
-- search_crm is `security invoker` so a search box physically cannot
-- return a record the rest of the app hides. check_duplicates cannot be:
-- the duplicates that matter MOST are the ones RLS hides — two reps
-- working the same merchant is the expensive mistake, and a rep cannot by
-- definition see the other rep's row. So it is `security definer`, and it
-- pays for that reach two ways: a hand-written guard, because RLS is doing
-- none of the work; and a return shape that, for any record the caller
-- could not already see, carries the fact of a match and the field it
-- matched on and NOTHING else — no id, no name, no contact detail, no
-- owning rep. Handing those back would be exactly the disclosure
-- search_crm's invoker choice exists to prevent, through another door.
--
-- Same argument as pre_app_secrets_presence: presence is not disclosure,
-- so it gets its own door. That one answers "does ciphertext exist"
-- without decrypting; this one answers "does a duplicate exist" without
-- identifying it.
--
-- IT ONLY EVER WARNS. A hard block on a cross-book duplicate is
-- unrecoverable from the UI by construction — the rep cannot see the
-- offending record, so they cannot resolve or dismiss it, and the only
-- move left is to make the check miss. The workaround reps find is typing
-- the phone number wrong, destroying the most reliable field the check
-- depends on. Never make this a constraint.
--
-- VISIBILITY RULE: a row is shown in full when the caller could already
-- see it under RLS — `agent_id = auth.uid()` or is_admin() — and redacted
-- otherwise, uniformly across all three tables including merchants. The
-- invariant is "never disclose what RLS would hide", not "merchants are
-- special": redacting a rep's OWN merchant would protect nothing (they can
-- already select it) and tell them to contact an admin about a record in
-- their own list.
-- =====================================================================
create or replace function check_duplicates(
  contact_email_input  text default null,
  contact_phone_input  text default null,
  business_phone_input text default null,
  mobile_phone_input   text default null,
  website_input        text default null,
  dba_input            text default null,
  legal_name_input     text default null,
  address_input        text default null,
  city_input           text default null,
  state_input          text default null,
  zip_input            text default null,
  exclude_lead_id      int  default null,
  name_threshold       real default 0.4
)
returns table (
  visibility    text,
  record_type   text,
  record_id     int,
  title         text,
  subtitle      text,
  matched_field text,
  strength      text
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  caller          uuid := auth.uid();
  caller_is_admin boolean;
  email_key text := dup_email(contact_email_input);
  host_key  text := dup_host(website_input);
  dba_key   text := nullif(btrim(coalesce(dba_input, '')), '');
  legal_key text := nullif(btrim(coalesce(legal_name_input, '')), '');
  addr_key  text := nullif(btrim(coalesce(address_input, '')), '');
  zip_key   text := dup_digits(zip_input);
  city_key  text := nullif(lower(btrim(coalesce(city_input, ''))), '');
  state_key text := nullif(lower(btrim(coalesce(state_input, ''))), '');
  phone_keys text[];
begin
  -- The hand-written guard that pays for `security definer`. RLS is doing none
  -- of the work below, so this is the only thing standing between a caller and
  -- a cross-book read. is_active_agent() tests `is_active` rather than role, so
  -- it covers admins too and refuses a deactivated account whose JWT is still
  -- within its hour.
  if not is_active_agent() then
    raise exception 'not authorised' using errcode = 'PT403';
  end if;

  caller_is_admin := is_admin();

  -- Seven digits, not one. See the note above: a short fragment matches a large
  -- slice of the book and teaches reps to dismiss the warning unread.
  phone_keys := array(
    select d from unnest(array[
      dup_digits(contact_phone_input),
      dup_digits(business_phone_input),
      dup_digits(mobile_phone_input)
    ]) as d
    where d is not null and length(d) >= 7
  );
  if cardinality(phone_keys) = 0 then
    phone_keys := null;
  end if;

  if name_threshold is null or name_threshold <= 0 or name_threshold > 1 then
    name_threshold := 0.4;
  end if;
  -- Transaction-local, so it cannot leak into anything else the caller does.
  perform set_config('pg_trgm.similarity_threshold', name_threshold::text, true);

  return query
  with hits as (
    -- ---- leads: exact tier ----
    select 'lead'::text as record_type, l.id as record_id, l.agent_id,
           coalesce(l.dba, l.contact_name, 'Lead #' || l.id) as title,
           l.contact_name as subtitle,
           'contact_email'::text as matched_field, 'exact'::text as strength
      from leads l
     where email_key is not null
       and (exclude_lead_id is null or l.id <> exclude_lead_id)
       and dup_email(l.contact_email) = email_key

    union all
    select 'lead', l.id, l.agent_id,
           coalesce(l.dba, l.contact_name, 'Lead #' || l.id), l.contact_name,
           'phone', 'exact'
      from leads l
     where phone_keys is not null
       and (exclude_lead_id is null or l.id <> exclude_lead_id)
       and (dup_digits(l.contact_phone)  = any(phone_keys)
         or dup_digits(l.business_phone) = any(phone_keys)
         or dup_digits(l.mobile_phone)   = any(phone_keys))

    union all
    select 'lead', l.id, l.agent_id,
           coalesce(l.dba, l.contact_name, 'Lead #' || l.id), l.contact_name,
           'website', 'exact'
      from leads l
     where host_key is not null
       and (exclude_lead_id is null or l.id <> exclude_lead_id)
       and dup_host(l.website) = host_key

    -- ---- leads: fuzzy tier ----
    union all
    select 'lead', l.id, l.agent_id,
           coalesce(l.dba, l.contact_name, 'Lead #' || l.id), l.contact_name,
           'name', 'fuzzy'
      from leads l
     where (dba_key is not null or legal_key is not null)
       and (exclude_lead_id is null or l.id <> exclude_lead_id)
       and ((dba_key   is not null and (l.dba % dba_key   or l.merchant_legal_name % dba_key))
         or (legal_key is not null and (l.dba % legal_key or l.merchant_legal_name % legal_key)))
       and greatest(
             coalesce(similarity(l.dba, dba_key), 0),
             coalesce(similarity(l.merchant_legal_name, dba_key), 0),
             coalesce(similarity(l.dba, legal_key), 0),
             coalesce(similarity(l.merchant_legal_name, legal_key), 0)
           ) >= name_threshold

    union all
    -- An address alone means nothing -- "100 Main St" exists in every town in
    -- the country. Scoped by zip, falling back to city+state when no zip was
    -- given, so this can only fire on somewhere actually nearby.
    select 'lead', l.id, l.agent_id,
           coalesce(l.dba, l.contact_name, 'Lead #' || l.id), l.contact_name,
           'address', 'fuzzy'
      from leads l
     where addr_key is not null
       and (exclude_lead_id is null or l.id <> exclude_lead_id)
       and (
             (zip_key is not null and dup_digits(l.zip) = zip_key)
          or (zip_key is null and city_key is not null and state_key is not null
              and lower(btrim(l.city)) = city_key
              and lower(btrim(l.state)) = state_key)
           )
       and l.address % addr_key
       and similarity(l.address, addr_key) >= name_threshold

    -- ---- ghost sheets ----
    union all
    select 'ghost_sheet', g.id, g.agent_id,
           coalesce(g.dba, g.contact_name, 'Ghost sheet #' || g.id), g.contact_name,
           'phone', 'exact'
      from ghost_sheets g
     where phone_keys is not null
       and dup_digits(g.contact_phone) = any(phone_keys)

    union all
    select 'ghost_sheet', g.id, g.agent_id,
           coalesce(g.dba, g.contact_name, 'Ghost sheet #' || g.id), g.contact_name,
           'name', 'fuzzy'
      from ghost_sheets g
     where (dba_key is not null or legal_key is not null)
       and ((dba_key is not null and g.dba % dba_key)
         or (legal_key is not null and g.dba % legal_key))
       and greatest(
             coalesce(similarity(g.dba, dba_key), 0),
             coalesce(similarity(g.dba, legal_key), 0)
           ) >= name_threshold

    -- ---- merchants ----
    -- The costliest miss: a rep starting to work an account the company
    -- already has. No contact columns exist here, so name is the whole
    -- surface and nothing from merchants is ever `exact`.
    union all
    select 'merchant', m.id, m.agent_id,
           coalesce(m.dba, m.legal_business_name, 'Merchant #' || m.id),
           m.legal_business_name,
           'name', 'fuzzy'
      from merchants m
     where (dba_key is not null or legal_key is not null)
       and ((dba_key   is not null and (m.dba % dba_key   or m.legal_business_name % dba_key))
         or (legal_key is not null and (m.dba % legal_key or m.legal_business_name % legal_key)))
       and greatest(
             coalesce(similarity(m.dba, dba_key), 0),
             coalesce(similarity(m.legal_business_name, dba_key), 0),
             coalesce(similarity(m.dba, legal_key), 0),
             coalesce(similarity(m.legal_business_name, legal_key), 0)
           ) >= name_threshold
  ),
  classified as (
    select case when caller_is_admin or h.agent_id = caller then 'own' else 'redacted' end as vis,
           h.record_type, h.record_id, h.title, h.subtitle, h.matched_field, h.strength
      from hits h
  )
  -- Own rows: one per record, naming its strongest reason. `distinct on`
  -- rather than one row per matched field, so a lead that matches on both
  -- phone and name appears once in the list the rep is shown.
  select c.vis, c.record_type, c.record_id, c.title, c.subtitle,
         c.matched_field, c.strength
    from (
      select distinct on (c2.record_type, c2.record_id) c2.*
        from classified c2
       where c2.vis = 'own'
       order by c2.record_type, c2.record_id,
                case c2.strength when 'exact' then 0 else 1 end,
                c2.matched_field
    ) c

  union all

  -- Redacted rows: AGGREGATED, and that is a disclosure control rather than
  -- tidiness. One row per record would make the row COUNT a report on how many
  -- records exist in books the caller cannot see -- a weaker leak than a name,
  -- but the same kind, and free to avoid. Grouping to
  -- (record_type, matched_field, strength) answers "a match exists, on this
  -- field" and nothing further. record_id, title and subtitle are NULL here by
  -- construction, not by the caller's good manners.
  select 'redacted', c.record_type, null::int, null::text, null::text,
         c.matched_field, c.strength
    from classified c
   where c.vis = 'redacted'
   group by c.record_type, c.matched_field, c.strength

  order by 7, 2, 6;  -- exact before fuzzy, then record type, then field
end;
$$;

-- Postgres grants EXECUTE to PUBLIC on every new function and PUBLIC includes
-- anon, and this one is `security definer` over every rep's book -- an anon
-- EXECUTE would be a cross-book read with nothing but the publishable key.
revoke all on function check_duplicates(
  text, text, text, text, text, text, text, text, text, text, text, int, real
) from public;
grant execute on function check_duplicates(
  text, text, text, text, text, text, text, text, text, text, text, int, real
) to authenticated, service_role;


-- =====================================================================
-- DATA API GRANTS — required, not optional.
--
-- RLS decides which ROWS a caller sees. Grants decide whether the caller
-- may touch the table at all, and the two are independent: a table with
-- perfect policies and no grant answers every request with "permission
-- denied for table X". That is the state this schema was in until this
-- section existed, and it is not a local-only quirk — Supabase's current
-- cloud default is that tables, views, sequences and functions created
-- in `public` by `postgres` (i.e. everything a migration creates) are
-- NOT auto-exposed to the Data API roles. The legacy auto-expose
-- behaviour is deprecated and the `auto_expose_new_tables` escape hatch
-- is removed on 2026-10-30, so relying on it is not an option.
--
-- Three roles, three different answers:
--
--   anon          nothing. This is an admin-provisioned CRM with sign-up
--                 off; there is no public data. Login goes through
--                 /auth/v1, not PostgREST, so anon never needs a table.
--   authenticated the 13 non-secret tables, one verb at a time: a verb is
--                 granted only where a policy backs it, so the two layers
--                 agree table-for-table. RLS is still the enforcement
--                 layer and is what the tests assert — the grant is the
--                 second lock, and it is what makes an unbacked write
--                 fail loudly instead of quietly. Four tables are
--                 therefore narrower than the standard four verbs; see
--                 the rule restated above the list below.
--   service_role  everything, including the secrets tables. It bypasses
--                 RLS by design; this is the grant the Edge Functions
--                 run on.
--
-- The three *_secrets tables get NO grant for `authenticated`. Their
-- zero-policy RLS already denies everything, so this is the second lock
-- on the same door: if someone later adds a policy to one of them (§ the
-- standing "never add a policy to these tables" rule), the missing grant
-- still holds the line.
--
-- Tables are listed one by one rather than via `all tables in schema
-- public`. A new table then starts with no access and fails loudly on
-- first use, which forces the author back to this list — the same reason
-- the four-policy pattern is spelled out per table rather than automated.
--
-- HISTORY for the existing project (ref vdjtosofrimipklbdjbi). Probing it on
-- 2026-08-05 found it predated the always-revoked default and carried
-- Supabase's legacy blanket grants: `anon` and `authenticated` both held
-- select/insert/update/delete on all 16 tables INCLUDING the three *_secrets
-- tables, plus execute on every function. Nothing leaked (RLS returns zero
-- rows for anon, the secrets tables have no policies, and the definer RPCs
-- guard themselves), but RLS was the only lock on the secrets tables rather
-- than the second one.
--
-- RESOLVED as of 2026-08-06: `supabase migration list --linked` shows all
-- migrations applied to that project, including the REVOKE section below, so
-- its grant surface now matches this file. Re-check with `migration list`
-- rather than assuming, and remember the rule that motivated the caveat: a
-- claim about production has to be verified against production.
-- =====================================================================
grant usage on schema public to anon, authenticated, service_role;

-- A plain `grant` only ADDS. On a project created before Supabase's
-- always-revoked default, every table in `public` already carried a legacy
-- blanket grant to `authenticated`, so layering the intended verbs on top left
-- the extras in place -- and `ALL` includes TRUNCATE, which **RLS does not
-- filter**. The audit found exactly that on both the local stack and the linked
-- project. So the model has to be stated subtractively first; see the
-- revoke-from-authenticated block further down.
--
-- The rule this list follows: a verb is granted only where a policy backs it.
-- A grant with no matching policy is dead weight that fails the quiet way --
-- the privilege check passes, RLS filters the statement to zero rows, and the
-- caller sees a save that did nothing. Four tables are therefore narrower than
-- the rest, and each exception is stated where the table is defined. As of
-- 20260812143407 the rule holds with no exceptions left: every verb below is
-- backed by a policy, and every policy has its verb.
grant select, insert, update, delete on
  merchants,
  leads,
  ghost_sheets,
  pre_apps,
  pre_app_owners,
  pre_app_terminal,
  pre_app_business_profile,
  support_tickets,
  tasks
to authenticated;

-- documents: no UPDATE. Nothing edits a document row in place; it is replaced
-- by a new upload plus a delete.
grant select, insert, delete on documents to authenticated;

-- notes: no UPDATE either, for a different reason -- append-only by design, so
-- that a note can be added and removed but never silently rewritten. Same
-- shape, same argument as documents: the missing policy already denied the
-- write, and revoking the grant is what makes it deny loudly.
grant select, insert, delete on notes to authenticated;

-- support_ticket_replies: append-only, so the same three verbs as notes. The
-- table was created this way rather than narrowed later, which is the point of
-- stating the rule above -- a new table gets the verbs its policies back, and
-- no more.
grant select, insert, delete on support_ticket_replies to authenticated;

-- bug_reports: no DELETE, and that is the whole design rather than an omission
-- -- a report is cleared by setting status, so the row survives for review. The
-- UPDATE here is backed by the admin-only "admin resolves" policy, so a rep
-- holds the privilege but no policy admits their write.
grant select, insert, update on bug_reports to authenticated;

-- rep_payout_rows: no INSERT. Rows are created only by commit-residual-import
-- under the service role, so an INSERT grant here would be backed by no policy at
-- all. UPDATE is the inline editing of the two money figures and the per-agent
-- bulk split; DELETE is the whole-period escape hatch. Both are admin-only by
-- policy, so a rep holds the privileges and no policy admits their write.
grant select, update, delete on rep_payout_rows to authenticated;

-- rep_payout_batches: SELECT to list them, UPDATE to abandon one. No INSERT (the
-- Storage key contains the batch id, so residual-import-file-url creates the row
-- server-side before the upload exists) and no DELETE (a batch is the record that
-- an import happened).
grant select, update on rep_payout_batches to authenticated;

-- rep_payout_import_rows and rep_payout_row_history: SELECT only. Every write to
-- either comes from a service-role Edge Function or from the
-- log_payout_row_change trigger, which is `security definer` and so bypasses both
-- RLS and grants. The history table is admin-read for a reason worth stating: a
-- rep reads their own figures, but the edit trail behind them is a payroll
-- record, not a rep-facing one.
grant select on rep_payout_import_rows to authenticated;
grant select on rep_payout_row_history to authenticated;

-- marketing_materials: no DELETE, and no INSERT or UPDATE for a rep either --
-- but all three verbs are reachable by an admin, because RLS is what separates
-- them and a grant cannot. SELECT is the rep-facing browse; INSERT and UPDATE
-- are backed by the two admin-only policies, so a rep holds the privilege and
-- no policy admits their write (the same arrangement bug_reports and
-- rep_payout_rows already have). DELETE is absent from both layers: a material
-- is archived, never removed, so the events that name it stay readable.
grant select, insert, update on marketing_materials to authenticated;

-- marketing_material_events: append-only, so the same two verbs as notes and
-- support_ticket_replies minus the delete those two allow. There is no way to
-- edit or remove an engagement record from a client at all -- that is the
-- property the table exists for, and leaving the grants off is what makes the
-- answer "permission denied" rather than a filtered statement reporting a save
-- that did nothing.
grant select, insert on marketing_material_events to authenticated;

-- products: the same three verbs as marketing_materials, and for the same
-- reason -- SELECT is every active rep's browse, INSERT and UPDATE are held by
-- `authenticated` but admitted for nobody but an admin, because separating
-- those is RLS's job and a grant cannot express it. No DELETE in either layer:
-- a product is archived so the quote lines that name it stay whole.
grant select, insert, update on products to authenticated;

-- quotes: SELECT and INSERT in full, and UPDATE ON ONE COLUMN.
--
-- The column list is the entire append-only mechanism, and it is here rather
-- than in a policy because a policy cannot say it. RLS decides which ROWS an
-- UPDATE may touch; only a column-level grant decides which COLUMNS. So
-- `status` moves (draft -> sent -> accepted), and an attempt on title, notes,
-- version, lead_id or agent_id fails with `permission denied for column`,
-- loudly, before RLS is consulted at all. That is the 20260812143407 lesson
-- applied one column at a time: a write the grant refuses is an error a rep
-- can act on, where a write RLS filters is a save that silently did nothing.
--
-- Spelled as its own statement rather than folded into the line above: a
-- table-level `grant update` and a column-level one are different privileges,
-- and `grant select, insert, update (status)` would read as if the restriction
-- applied to all three.
grant select, insert on quotes to authenticated;
grant update (status) on quotes to authenticated;

-- quote_line_items: SELECT and INSERT only -- stricter than quotes above,
-- which has the one mutable column. A line item is what the quote said when it
-- was sent; changing one is the edit that is supposed to produce a new
-- version, so there is no verb for it at either layer.
grant select, insert on quote_line_items to authenticated;

-- profiles: SELECT only, matching its single SELECT policy. Every write is a
-- security definer RPC or a service-role Edge Function, both of which bypass
-- grants entirely, so nothing legitimate loses access here. The INSERT/UPDATE/
-- DELETE grants this table used to carry were backed by no policy at all after
-- "admin manages profiles" was dropped -- three dead grants on the table that
-- decides who is an admin.
grant select on profiles to authenticated;

-- audit_log is SELECT-only, and deliberately not in the list above.
--
-- It is the tamper-evidence table: everything else in this schema can be
-- reconstructed or corrected, but a forged or erased audit row destroys the one
-- record of who did what. Until now its INSERT/UPDATE/DELETE grants were held
-- back by nothing but the absence of a policy for those verbs -- one permissive
-- policy, or one `disable row level security`, and any signed-in rep could
-- rewrite the trail.
--
-- Nothing legitimate loses access. Every writer is either a `security definer`
-- function (which runs as the owner and bypasses both RLS and grants -- see
-- log_cross_agent_change and the pre-app RPCs) or a service-role Edge Function.
grant select on audit_log to authenticated;

-- USAGE only, not SELECT: nextval() is all a serial insert needs, and
-- SELECT on a sequence would hand out last_value — a free row count of
-- every other agent's book.
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
  support_ticket_replies_id_seq,
  notes_id_seq,
  tasks_id_seq,
  bug_reports_id_seq,
  -- Both marketing sequences, for different callers. An admin's INSERT into
  -- marketing_materials goes through PostgREST (the "New material" form writes
  -- the row, then the Edge Function attaches the file), and every rep's INSERT
  -- into marketing_material_events goes through it on every view, download,
  -- print and email. Unlike the four rep_payout sequences, these are consumed
  -- by `authenticated` and so must be granted -- the test that pins the
  -- rep_payout omission would otherwise read as a rule to copy rather than a
  -- consequence of those tables having no INSERT grant.
  marketing_materials_id_seq,
  marketing_material_events_id_seq,
  -- All three catalog/quote sequences, for the same reason as the two above
  -- and none of the rep_payout ones: every insert to these tables is made by
  -- `authenticated` through PostgREST or through create_quote_version(), which
  -- is security INVOKER and so consumes nextval() as the caller rather than as
  -- the owner. An invoker RPC is exactly the case where forgetting a sequence
  -- grant produces `permission denied for sequence` from inside a function
  -- whose own EXECUTE grant looks correct.
  products_id_seq,
  quotes_id_seq,
  quote_line_items_id_seq
to authenticated;
-- The four rep_payout sequences are deliberately absent, for the same reason
-- audit_log_id_seq is: nothing `authenticated` can do consumes them. None of the
-- four tables grants INSERT to authenticated -- every row is created by a
-- service-role Edge Function or a security definer trigger, both of which run as
-- a role that already holds it. Granting USAGE anyway would leave nextval()
-- reachable through any security invoker RPC, burning ids and putting gaps in a
-- ledger of what a processor reported.
-- audit_log_id_seq is deliberately absent, to match audit_log's SELECT-only
-- grant above. Nothing `authenticated` can do consumes it: every audit_log
-- insert comes from a security definer function (running as the owner) or a
-- service-role Edge Function, neither of which needs this grant. What it left
-- reachable was small but pointed the wrong way -- nextval() through any
-- security invoker RPC burns ids and puts gaps in the sequence of the one
-- table whose job is tamper evidence.

-- service_role bypasses RLS and is the only role that may reach the
-- secrets tables — via the submit-pre-app-secrets / read-pre-app-secrets
-- Edge Functions, which hold the encryption key.
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- Functions. Postgres grants EXECUTE to PUBLIC on creation, which would
-- leave these callable by anon; revoked first so the grants below are the
-- whole list. is_admin() and is_active_agent() must be executable by
-- `authenticated` because the policies call them during RLS evaluation,
-- which runs as the querying role.
revoke all on function is_admin() from public;
revoke all on function is_active_agent() from public;
revoke all on function update_own_full_name(text) from public;
revoke all on function approve_pre_app(int) from public;
revoke all on function submit_pre_app(int) from public;
revoke all on function decline_pre_app(int, text) from public;
revoke all on function reopen_pre_app(int) from public;
revoke all on function convert_ghost_sheet_to_lead(int) from public;
-- Trigger function: revoked and deliberately NOT granted below. A trigger
-- fires regardless of whether the querying role holds EXECUTE on it, so a
-- grant would widen the surface for no benefit.
revoke all on function pre_apps_guard_transitions() from public;
-- Trigger function: revoked, and deliberately NOT granted. A trigger fires
-- regardless of whether the querying role holds EXECUTE on its function, so a
-- grant would widen the surface for no benefit. (This one was missed when the
-- grants block was first written and shipped executable by anon.)
revoke all on function set_updated_at() from public;

grant execute on function is_admin() to authenticated, service_role;
grant execute on function is_active_agent() to authenticated, service_role;
grant execute on function update_own_full_name(text) to authenticated, service_role;
grant execute on function approve_pre_app(int) to authenticated, service_role;
grant execute on function submit_pre_app(int) to authenticated, service_role;
grant execute on function decline_pre_app(int, text) to authenticated, service_role;
grant execute on function reopen_pre_app(int) to authenticated, service_role;
grant execute on function convert_ghost_sheet_to_lead(int) to authenticated, service_role;

-- =====================================================================
-- REVOKE LEGACY PLATFORM GRANTS — converges an older project onto the
-- model above, and closes the door behind it.
--
-- The GRANTS section only adds privileges, so on a project created before
-- the always-revoked default it sits on top of Supabase's legacy blanket
-- grants rather than replacing them. Two problems with that, and they
-- need different fixes:
--
--   Existing objects — plain `revoke`. Strips anon back to nothing, and
--   takes `authenticated` off the three *_secrets tables so the missing
--   grant is once again the second lock behind their zero-policy RLS.
--
--   FUTURE objects — `alter default privileges`. This is the part that
--   plain revokes cannot reach, and the reason the legacy grants exist on
--   every table in the first place: they were never granted per table.
--   Confirmed by reading the linked project's pg_default_acl on
--   2026-08-05 — grantor `postgres`, schema `public`, objtype `r`:
--   {postgres=arwdDxtm, anon=arwdDxtm, authenticated=arwdDxtm,
--   service_role=arwdDxtm}, plus anon=rwU on sequences and anon=X on
--   functions. Supabase's older project init ran the equivalent of
--
--     alter default privileges in schema public
--       grant all on tables to anon, authenticated, service_role;
--
--   so every table a migration creates is auto-granted at CREATE time, in
--   perpetuity. The per-object `GRANT ALL ON TABLE ... TO "anon"` lines a
--   schema dump shows are that default materialising at CREATE time, not a
--   separate mechanism. Revoking today and adding a table tomorrow would silently
--   re-open it. Removing the default-privilege entries is what makes "a
--   new table starts with no access and fails loudly" true rather than
--   aspirational.
--
-- This works for TABLES and not for FUNCTIONS, which was measured rather
-- than assumed. On Postgres 17 and on PGlite, a function created by
-- `postgres` in `public` comes out with `proacl = NULL` — the built-in
-- default, PUBLIC included — regardless of what pg_default_acl holds;
-- `alter default privileges ... revoke execute on functions from public`
-- is a verified no-op here. So there is no declarative backstop for
-- functions: every new RPC must carry its own
--
--   revoke all on function <sig> from public;
--   grant execute on function <sig> to authenticated, service_role;
--
-- in the migration that creates it, as the GRANTS section does for the
-- five that exist. tests/rls/grants.test.ts pins this so the gap is not
-- rediscovered the hard way.
--
-- Deliberately NOT touched:
--   * anon keeps USAGE on schema public. It has no table, sequence or
--     function privileges left, so it can reach nothing; keeping schema
--     usage only preserves the error shape the app already sees, rather
--     than turning an empty result into a schema-level failure on any
--     unauthenticated query that slips through.
--   * service_role's default privileges. It bypasses RLS and is the tier
--     the Edge Functions run on, so it keeps inheriting new tables. Note
--     the consequence: a table created on a project WITHOUT those legacy
--     defaults (a fresh one, or the local stack) is not reachable by
--     service_role until granted, so new-table migrations should grant it
--     explicitly rather than rely on inheritance.
--   * `for role supabase_admin`, whose defaults DO grant a full arwdDxtm
--     on tables to anon and authenticated on the local stack. Naming it
--     is fatal, not merely unnecessary: `postgres` is not a superuser and
--     not a member of that role, so the statement fails with `permission
--     denied to change default privileges` and aborts the migration
--     (tried). It is also the wrong target — that entry governs objects
--     created BY supabase_admin, i.e. the platform's, not ours. Default
--     privileges key on the CREATING role, and everything this repo adds
--     is created by `postgres` via db push or the SQL editor.
-- =====================================================================
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all functions in schema public from anon;

-- The same treatment for `authenticated`, and it was missing for a long time.
--
-- The blanket revoke above names only `anon`, and `alter default privileges`
-- (below) binds FUTURE objects only -- so the 13 tables that already existed
-- kept their legacy `GRANT ALL` to `authenticated`. The audit confirmed it on
-- the local stack and on the linked project: `GRANT ALL ON TABLE ... TO
-- "authenticated"` everywhere, where this document said
-- `select, insert, update, delete`.
--
-- What `ALL` adds beyond those four verbs:
--
--   TRUNCATE   -- and **RLS does not apply to TRUNCATE**. Every row-level
--                protection in this schema is silent on it.
--   REFERENCES -- allows pointing a foreign key at the table.
--   TRIGGER    -- allows attaching a trigger to it.
--
-- Not reachable through the API today: PostgREST issues only
-- SELECT/INSERT/UPDATE/DELETE, and no `security invoker` RPC here contains a
-- TRUNCATE, so exploiting it needs a direct Postgres connection as a role that
-- has no password. It is removed because "unreachable" is a property of today's
-- surface, not a guarantee, and because a grant that contradicts the documented
-- model is exactly the drift the whole grants-versus-RLS section exists to
-- prevent.
--
-- Order matters: revoke first, then the explicit grants above are what remains.
-- Sequences go back to USAGE alone -- the legacy grant included UPDATE, i.e.
-- setval(), which would let a client reset an id sequence into collisions.
revoke all on all tables in schema public from authenticated;
revoke all on all sequences in schema public from authenticated;

-- Trigger functions hold no grant at all: a trigger fires whether or not the
-- querying role holds EXECUTE, so a grant widens the surface for nothing. The
-- linked project had `set_updated_at()` granted to `authenticated` from the same
-- legacy default -- harmless in practice, since Postgres refuses a direct call
-- to a function returning `trigger`, but it is not supposed to be there.
revoke all on function set_updated_at() from authenticated;
revoke all on function pre_apps_guard_transitions() from authenticated;
revoke all on function log_cross_agent_change() from authenticated;

revoke all on
  pre_app_owner_secrets,
  pre_app_banking_secrets,
  pre_app_terminal_secrets
from anon, authenticated;

revoke all on
  pre_app_owner_secrets_id_seq,
  pre_app_banking_secrets_id_seq,
  pre_app_terminal_secrets_id_seq
from anon, authenticated;

alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on functions from anon, authenticated;

-- =====================================================================
-- `ensure_rls` / `rls_auto_enable()` — the RLS backstop. ADOPTED into the
-- migrations on 2026-08-11 by 20260811150000. Until then it existed on the
-- hosted project and nowhere else, and that divergence — not the missing
-- convenience — is what this section used to warn about and what adopting
-- it removes.
--
-- PROVENANCE. Read off ref vdjtosofrimipklbdjbi on 2026-08-05:
--
--   evtname     | evtevent        | enabled | owner    | tags
--   ensure_rls  | ddl_command_end | O       | postgres | CREATE TABLE,
--                                                        CREATE TABLE AS,
--                                                        SELECT INTO
--
-- It calls public.rls_auto_enable() — security definer, search_path
-- pg_catalog — which walks pg_event_trigger_ddl_commands(), and for each
-- new table or partitioned table in `public` runs
--
--   alter table if exists <table> enable row level security
--
-- wrapped in an exception handler that swallows failures to a RAISE LOG.
-- So every new table gets RLS switched on for free, and quietly does not
-- if the attempt fails.
--
-- It arrived without a migration behind it: absent from every commit on
-- every ref, from the Supabase CLI package, and from every other
-- environment. The style — RAISE LOG lines, defensive pg_toast%/pg_temp%
-- filters, a blanket EXCEPTION WHEN OTHERS, `set search_path to
-- 'pg_catalog'` — matches nothing else in this repo, so it was installed
-- out-of-band through the Dashboard SQL editor or a Supabase advisor
-- action. Who and when is answerable only from the Dashboard's SQL editor
-- history or the org audit log.
--
-- It is owned by `postgres`, whereas the platform's own event triggers are
-- owned by `supabase_admin` — so it was almost certainly not shipped by
-- Supabase, and nobody should assume it is maintained, upgraded or
-- restored for us. That is not an argument for leaving it alone; it is the
-- argument for owning it deliberately, which is what the migration does.
--
-- WHY IT WAS ADOPTED, rather than dropped or left where it was.
--
-- Dropping it would have deleted a backstop that demonstrably works, from
-- the one environment holding real data, purely to buy consistency.
--
-- Leaving it alone kept the part that actually hurts. A migration that
-- forgets `alter table ... enable row level security` produced two
-- DIFFERENT bugs depending on where it ran. On the hosted project the
-- table came up RLS-enabled with no policies, which denies everyone and
-- reads as a broken feature. Everywhere else the same table was wide open,
-- which is a data leak. Same SQL, opposite failure — and the environment
-- where it looked fine was the one nobody tests against. That is worse
-- than the net not existing at all, and it is the divergence CLAUDE.md
-- warns about under "Do not rely on ensure_rls".
--
-- Adopting it keeps the backstop AND closes the divergence. The local
-- stack, the PGlite suite and any fresh project built from these
-- migrations now behave the way production already did, so a forgotten
-- `enable row level security` fails the same way everywhere — and the net
-- can be ASSERTED instead of described. tests/rls/grants.test.ts,
-- "auto-enables RLS on a table a future migration forgets", is that
-- assertion: it creates a table that never asks for RLS and requires
-- relrowsecurity to come back true.
--
-- The adoption is a no-op on the hosted project by construction. The
-- function below is reproduced verbatim from it — re-verified against
-- `supabase db dump --linked` on 2026-08-11, identical modulo pg_dump's
-- quoting and case — and the event trigger is created only when absent.
--
-- WHERE IT NOW EXISTS:
--   * The hosted project (ref vdjtosofrimipklbdjbi), unchanged, since
--     2026-08-05 or earlier.
--   * The local CLI stack, from 20260811150000. Its event triggers are now
--     ensure_rls, issue_graphql_placeholder, issue_pg_cron_access,
--     issue_pg_graphql_access, issue_pg_net_access, pgrst_ddl_watch and
--     pgrst_drop_watch — verified 2026-08-11. (Before adoption this list
--     was the same six minus ensure_rls, which is what the old version of
--     this note recorded.)
--   * The PGlite suite (tests/helpers/db.ts), which applies the same
--     migrations over its three-role auth shim. PGlite does run event
--     triggers — the test named above is the proof, and it passes.
--   * Any fresh project built from this file or from supabase/migrations/,
--     because the DDL below is now part of both.
--
-- WHERE IT STILL DOES NOT EXIST, and must not be assumed:
--   * Any clone made with `supabase db dump`. The CLI's dump script does
--     not emit `CREATE EVENT TRIGGER` at all — verified against the
--     2026-08-11 linked dump, which carries the rls_auto_enable() function
--     and zero occurrences of `CREATE EVENT TRIGGER`. A dump-based restore
--     therefore arrives with the function defined and nothing calling it,
--     which is the worst shape available: it LOOKS present in the schema.
--     Re-run 20260811150000, or create the trigger by hand, after any
--     restore of that kind.
--
-- THE RULE IS UNCHANGED AND UNCONDITIONAL. Every new table still spells
-- out `alter table ... enable row level security` and its four policies in
-- the migration that creates it. What changed is only the standing of the
-- net: it is a deliberate, version-controlled backstop now rather than one
-- that happened to be there. It is still a net and not a policy — it
-- enables RLS and adds no policies, so a table it catches denies everyone.
-- Belt and braces, in that order.
-- =====================================================================

-- security definer is required: it runs ALTER TABLE on tables it does not
-- own. search_path is pinned to pg_catalog so a temp-table shadow cannot
-- redirect any of the catalog lookups.
create or replace function public.rls_auto_enable()
returns event_trigger
language plpgsql
security definer
set search_path to 'pg_catalog'
as $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;

-- An event-trigger function is never called directly — Postgres refuses a
-- call to anything returning `event_trigger` — so no role needs EXECUTE.
-- The hosted project had it granted to `authenticated` from the same
-- legacy default that produced the M1 table-grant finding: harmless, and
-- removed here for tidiness.
revoke all on function public.rls_auto_enable() from public;
revoke all on function public.rls_auto_enable() from anon, authenticated;

-- The event trigger is guarded three ways, because this is the half that
-- may legitimately fail:
--
--   1. It ALREADY EXISTS on the hosted project, so a bare CREATE would
--      abort the push. pg_event_trigger is checked first.
--   2. CREATE EVENT TRIGGER normally requires superuser. `postgres` can
--      create one on the local stack despite not being a superuser
--      (verified), but the hosted migration role may refuse it, so
--      insufficient_privilege degrades to a NOTICE rather than blocking an
--      otherwise good migration — production already has the trigger,
--      which is the whole reason the adoption is safe.
--   3. Anything else is re-raised, so a genuine mistake here is not
--      swallowed the way the function's own handler swallows per-table
--      failures.
--
-- Deliberately last in this file. Built top-to-bottom, every table above
-- has already declared its own RLS, so arming the trigger here changes
-- nothing retroactively — it is armed for what comes next.
do $$
begin
  if exists (select 1 from pg_event_trigger where evtname = 'ensure_rls') then
    raise notice 'ensure_rls already exists — leaving it alone';
  else
    create event trigger ensure_rls
      on ddl_command_end
      execute function public.rls_auto_enable();
    raise notice 'ensure_rls created';
  end if;
exception
  when insufficient_privilege then
    raise notice
      'ensure_rls not created: the migration role lacks superuser. The function is in place; create the trigger from the dashboard if this environment needs it.';
end;
$$;

-- =====================================================================
-- NOTE ON SUPABASE STORAGE (not SQL — set up in the dashboard/CLI)
-- Create THREE private buckets: `documents`, `residual-imports` and
-- `marketing`. None of them
-- gets public storage policies referencing these tables — all
-- upload/download access goes through Edge Functions that authorize the
-- caller first and only then mint a short-lived signed URL with the
-- service-role client.
--
--   documents         create-upload-url / create-download-url, which check
--                     the `documents` table's agent_id (or is_admin()).
--                     Keys: {agent_id}/{owner_type}/{owner_id}/{uuid}.
--
--   residual-imports  residual-import-file-url, admin-only. Keys:
--                     {batch_id}/{file_name}. Holds the raw XLSX behind
--                     every rep_payout_batches row, so a committed period
--                     can always be traced back to the file it came from.
--
--   marketing         marketing-material-file-url. Keys:
--                     {material_id}/{file_name}. Holds the company's sell
--                     sheets and rate cards. UPLOAD is admin-only;
--                     DOWNLOAD is open to every active signed-in user,
--                     which makes it the only one of the three buckets
--                     whose two directions have different answers — a rep
--                     reads the library, an admin stocks it.
--
-- Why a second bucket rather than a new `documents.owner_type`: that
-- table's access model resolves a PARENT RECORD's agent_id
-- (resolveParentAgentId), and a residual import file has no owning rep --
-- it spans every rep in the report. Widening owner_type would have meant
-- either a rep-owned table holding rows that belong to no rep, or filing
-- the file under the importing admin, which is a fact about who clicked
-- rather than about the data. Two buckets, two access stories, neither
-- bent to fit the other. `marketing` is a third for the same kind of
-- reason and a different one: a material has no owning rep AND no parent
-- record at all, so there is nothing for the documents key shape to
-- resolve.
--
-- NO bucket is in any migration, so a freshly started local stack has none
-- of them and every signing call 404s until they exist -- and `npx supabase
-- db reset` drops all three, which is the version that actually bites.
-- tests/live/helpers/stack.ts creates all three as part of provisioning.
--
-- SET A PER-BUCKET file_size_limit ON ALL THREE. This is not optional and it is
-- not what config.toml's `[storage] file_size_limit` does. Measured on the
-- local stack with that set to "50MiB": a 120 MiB PUT through
-- uploadToSignedUrl was accepted, and so was a 120 MiB service-role
-- upload. Both buckets came back from listBuckets() with
-- file_size_limit = null, which is what was actually in force -- no
-- ceiling at all, at any layer, so one rep with a video file could fill
-- the project's storage quota. `documents` is provisioned at
-- MAX_DOCUMENT_BYTES (lib/documents.ts, 50 MiB) by
-- tests/live/helpers/stack.ts, e2e/fixtures/seed.ts and
-- seed-dev-local.mjs; `marketing` is provisioned at the same ceiling by
-- the first two. The hosted buckets need the same set from the dashboard,
-- or via storage.updateBucket, because no migration can carry it. lib/documents.ts also refuses an over-size file client-side, which
-- is what produces a readable message instead of a 413 from Storage --
-- but a client-side check is a courtesy, not the boundary.
-- =====================================================================

-- =====================================================================
-- NOTES ON AUTH CONFIG (not SQL — set in supabase/config.toml and the
-- create-user / deactivate-user Edge Functions)
--
-- 1. This is an admin-provisioned CRM, not a self-service product. Public
--    sign-up must be OFF: set `enable_signup = false` under [auth] in
--    config.toml, and the /auth/sign-up route/page from the starter
--    template must be removed or replaced (not left live) — otherwise
--    anyone can create an auth.users row with no matching profiles row,
--    log in, and land on an app that's empty for them with no way to
--    self-heal (profiles has no insert policy for authenticated, by
--    design). The only way a profiles row should ever be created is the
--    create-user Edge Function, run by an existing admin.
--
-- 2. Role lookups happen per-request via is_admin()/is_active_agent()
--    rather than a custom JWT claim (a Supabase Auth "custom access
--    token hook"). This is a deliberate choice, not an oversight: a role
--    baked into the JWT can go stale until the token refreshes — e.g. a
--    just-deactivated agent's existing JWT would still claim they're
--    active. A live per-request check always reflects the current value
--    in profiles. Revisit only if this ever becomes a measurable
--    performance problem, which is unlikely at this scale.
--
-- 3. deactivate-user must do two things, not one: set profiles.is_active
--    = false (which the policies above now actually enforce for
--    "own-row" access, not just admin checks) AND ban the corresponding
--    auth.users row via the Supabase Auth Admin API, so a session/JWT
--    issued before deactivation can't keep working until it happens to
--    expire. Flipping is_active alone is not sufficient on its own.
-- =====================================================================
