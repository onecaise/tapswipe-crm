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
  -- The rep's identity for the processor's paperwork (20261026120000; phase 2
  -- of docs/design/intake-and-reports.md). `legal_name` is the person's real
  -- legal name (full_name stays the display name, often a nickname);
  -- `llc_legal_name` is the legal name of the rep's LLC. A rep with no LLC has
  -- their own legal name (or sole-proprietor business name) entered here by
  -- the admin -- never a placeholder like "N/A", which would print on the
  -- processor's forms (memo §9 A16).
  --
  -- Nullable: admins and older accounts have none, and both are optional when
  -- an account is created (A20). The gate is at pre-app SUBMIT, which refuses a
  -- rep missing either (phase 4, pre_app_missing_fields() -> 'rep_identity'),
  -- and snapshots both onto the pre-app there.
  --
  -- Written ONLY by set_rep_identity() below: admin-only, audited. profiles has
  -- no UPDATE grant or policy, so no client -- the rep included -- can write
  -- them directly. Read through the ordinary select policy: a rep sees their
  -- own two values, an admin sees everyone's, nobody else sees any.
  --
  -- NEVER IN A POLICY. Not an access boundary; tests/rls/set-rep-identity
  -- greps pg_policies for both names.
  --
  -- The CHECKs restate set_rep_identity()'s rules so the service role cannot
  -- store what the RPC would refuse: trimmed, non-blank, at most 200
  -- characters. Null is "not set yet"; '' is never stored.
  legal_name text
    constraint profiles_legal_name_format check (
      legal_name is null or (
        legal_name = btrim(legal_name, E' \t\n\r\f\x0b')
        and legal_name <> ''
        and length(legal_name) <= 200
      )
    ),
  llc_legal_name text
    constraint profiles_llc_legal_name_format check (
      llc_legal_name is null or (
        llc_legal_name = btrim(llc_legal_name, E' \t\n\r\f\x0b')
        and llc_legal_name <> ''
        and length(llc_legal_name) <= 200
      )
    ),
  -- The rep's split rate (20261028120000; memo §0b.4 of
  -- docs/design/intake-and-reports.md): the rep's share of a merchant's
  -- residual, in percent. Default 50, 0-50, 0.01 steps. The house profile
  -- (agent code 122) is set to 0 by an admin; no rate is hard-coded in a
  -- migration.
  --
  -- Written ONLY by set_rep_split() below: admin-only, audited. NEVER IN A
  -- POLICY. Copied onto a pre-app by submit_pre_app() (pre_apps.split_agent_pct)
  -- and from there onto the merchant by approve_pre_app(); a later change here
  -- changes neither.
  split_rate_pct numeric(5,2) not null default 50
    constraint profiles_split_rate_pct_range check (split_rate_pct between 0 and 50),
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
as $$
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
$$;

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
-- set_rep_identity(user_id uuid, legal_name text, llc_legal_name text)
--
-- The only write path to profiles.legal_name and profiles.llc_legal_name
-- (20261026120000). The set_territory() shape: `security definer`, pinned
-- search_path, is_admin() first (which already requires is_active).
--
-- Sets BOTH columns on every call, so the caller always sends the pair it
-- wants stored. Per value:
--   null          -> clears it (an admin correcting a mistaken entry)
--   text          -> trimmed; blank after trimming is REFUSED (PT400), and so
--                    is anything over 200 characters. Blank is refused rather
--                    than turned into null so that '' from a client can never
--                    be mistaken for "clear"; a caller that means clear sends
--                    null.
-- The 200 cap is REP_IDENTITY_MAX_LENGTH in _shared/admin-users.ts; change the
-- two together (tests/unit/rep-identity.test.ts pins the pair).
--
-- Audited as 'set_rep_identity' on 'profiles', one row per call that changes
-- something, inside the same statement as the update: if the audit insert
-- fails, the update rolls back with it. No exception handler, on purpose.
-- No change -> no audit row (`is not distinct from`, as set_territory).
--
-- Self-target allowed, as set_territory: an admin who carries a book has an
-- identity like anyone else.
-- ---------------------------------------------------------------------
create or replace function set_rep_identity(
  user_id uuid,
  legal_name text,
  llc_legal_name text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  new_legal text;
  new_llc text;
  target profiles;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  new_legal := btrim(set_rep_identity.legal_name, E' \t\n\r\f\x0b');
  new_llc := btrim(set_rep_identity.llc_legal_name, E' \t\n\r\f\x0b');

  if new_legal = '' then
    raise exception 'legal name cannot be blank' using errcode = 'PT400';
  end if;
  if new_llc = '' then
    raise exception 'LLC legal name cannot be blank' using errcode = 'PT400';
  end if;
  if length(new_legal) > 200 then
    raise exception 'legal name must be 200 characters or fewer'
      using errcode = 'PT400';
  end if;
  if length(new_llc) > 200 then
    raise exception 'LLC legal name must be 200 characters or fewer'
      using errcode = 'PT400';
  end if;

  select * into target from profiles where id = set_rep_identity.user_id;
  if not found then
    raise exception 'user not found' using errcode = 'PT404';
  end if;

  if target.legal_name is not distinct from new_legal
     and target.llc_legal_name is not distinct from new_llc then
    return;
  end if;

  update profiles
     set legal_name = new_legal,
         llc_legal_name = new_llc
   where id = set_rep_identity.user_id;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'set_rep_identity', 'profiles',
          set_rep_identity.user_id::text);
end;
$$;

revoke all on function set_rep_identity(uuid, text, text) from public;
grant execute on function set_rep_identity(uuid, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- set_rep_split(user_id uuid, rate numeric) (20261028120000)
--
-- The only write path to profiles.split_rate_pct. The set_rep_identity()
-- shape: security definer, pinned search_path, is_admin() first. Refuses a
-- null rate, one outside 0-50, and one with more than two decimals (numeric
-- (5,2) would otherwise round it silently) -- PT400. Audited as
-- 'set_rep_split' on 'profiles' in the same transaction, no exception handler
-- (fails closed). No change, no audit row.
-- ---------------------------------------------------------------------
create or replace function set_rep_split(user_id uuid, rate numeric)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_rate numeric(5,2);
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  if set_rep_split.rate is null then
    raise exception 'a split rate is required' using errcode = 'PT400';
  end if;
  if set_rep_split.rate < 0 or set_rep_split.rate > 50 then
    raise exception 'the split rate must be between 0 and 50' using errcode = 'PT400';
  end if;
  if set_rep_split.rate <> round(set_rep_split.rate, 2) then
    raise exception 'the split rate has at most two decimal places' using errcode = 'PT400';
  end if;

  select p.split_rate_pct into current_rate
    from profiles p where p.id = set_rep_split.user_id;
  if not found then
    raise exception 'user not found' using errcode = 'PT404';
  end if;

  if current_rate = set_rep_split.rate then
    return;
  end if;

  update profiles
     set split_rate_pct = set_rep_split.rate
   where id = set_rep_split.user_id;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'set_rep_split', 'profiles', set_rep_split.user_id::text);
end;
$$;

revoke all on function set_rep_split(uuid, numeric) from public;
grant execute on function set_rep_split(uuid, numeric) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- PROCESSORS -- the one processor vocabulary (20261023130000; phase 1 of
-- docs/design/intake-and-reports.md).
--
-- The same list everywhere a processor is named: merchants.processor and
-- pre_apps.processor now, rep_payout_batches and rep_payout_rows when the
-- residual import is rebuilt. A TABLE referenced by foreign key rather than a
-- CHECK repeated on each column, because the repeats drift -- three copies of
-- the list is the pattern this repo keeps paying for. Adding a processor is
-- one insert, in a migration.
--
-- `code` is the stored value AND what the screens show (memo A1: code =
-- label). `label` exists so a display name can change later without
-- rewriting every row that names the code; until then the two are equal.
-- No `id serial`: the natural key is what the referencing columns hold, so
-- there is no sequence and no sequence grant.
--
-- Reference data with no owner (the products/brands shape, minus the
-- admin-write policies): every active user reads it, nobody writes it from a
-- client. No insert/update/delete policy and no write grant, so a write is
-- `permission denied`, not a filtered no-op. Never anything for anon.
-- ---------------------------------------------------------------------
create table processors (
  code text primary key
    constraint processors_code_trimmed check (code = btrim(code) and code <> ''),
  label text not null
    constraint processors_label_trimmed check (label = btrim(label) and label <> ''),
  -- The drop-down order. Unique so two processors cannot tie and reorder
  -- between page loads.
  sort_order int not null constraint processors_sort_order_key unique
);

alter table processors enable row level security;

-- is_active_agent() covers every active profile, admins included -- the
-- brands/products wording, kept identical so the two read alike.
create policy "select active or admin" on processors
  for select using (is_active_agent() or is_admin());

-- Spellings exactly as Owen gave them (23 Oct 2026). sort_order in tens so a
-- later insert can land between two without renumbering.
insert into processors (code, label, sort_order) values
  ('TSYS',       'TSYS',       10),
  ('Red Fynn',   'Red Fynn',   20),
  ('PayBright',  'PayBright',  30),
  ('Netevia HQ', 'Netevia HQ', 40),
  ('Square',     'Square',     50);

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
  -- One of processors.code, or NULL for "not set yet" (20261023130000).
  -- Free text until then. Nullable and staying that way: a merchant created
  -- before anyone knows the processor is normal, and the residual import
  -- treats an unset processor as "no mismatch" (memo A6). NO ACTION on delete:
  -- a processor a merchant names cannot be removed from the list.
  processor text constraint merchants_processor_fkey references processors(code),
  split_agent_pct numeric(5,2),
  split_company_pct numeric(5,2),
  -- Which pre-app was approved into this merchant, when one was. The foreign
  -- key is added after pre_apps exists, below. Nullable and staying that way:
  -- merchants are also created by hand, and every row that predates this
  -- column has no pre-app to point at.
  pre_app_id int,
  -- Where the business is (20261013130000). City and state are REQUIRED for
  -- every NEW merchant -- merchants_location_guard below -- and street and
  -- zip are optional. Nullable because every merchant that predates these
  -- columns has no location, and those must stay editable.
  --
  -- `street` rather than `address` (the leads/pre_apps spelling) because the
  -- merchant form asks for exactly that and nothing more -- no suite line, no
  -- country. approve_pre_app() copies pre_apps.physical_address into it.
  street text,
  city text,
  -- Two upper-case letters, enforced by the constraint. The UI offers the
  -- US_STATES list from lib/masks.ts; the database checks only the shape,
  -- the way isState and the wizard split the same job for pre-apps.
  state text,
  zip text,
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

-- MERCHANT LOCATION (20261013130000).
--
-- norm_city() is the one definition of "the same city", in the dup_digits
-- family below and for the same reason: it exists to be indexed, and an
-- expression index is only used when the query spells the expression exactly
-- as the index does. Lower-case, punctuation turned into a space, whitespace
-- collapsed, trimmed; '' becomes NULL. So "St. Louis", "st louis", "ST.LOUIS"
-- and "  St   Louis " are one key, and "Winston-Salem" meets "Winston Salem".
--
-- Punctuation becomes a SPACE rather than vanishing. That is the deliberate
-- choice: deleting it would make "St.Louis" ("stlouis") miss "St. Louis"
-- ("st louis"), which is the commonest way people type the same city twice.
-- The cost is that "O'Fallon" keys as "o fallon" and would miss a hand-typed
-- "OFallon" -- the rarer error of the two.
--
-- NO abbreviation expansion: "St" is not "Saint", "Ft" is not "Fort". That is
-- a vocabulary somebody has to own, and a rule that is wrong for one city is
-- wrong silently. Equality on a mechanical key is something a rep can predict.
--
-- %, _ and * are punctuation to this function, NOT wildcards: nothing that
-- consumes a key uses LIKE, so they become spaces like any other mark.
--
-- Defined here, ahead of dup_digits, because the constraint below calls it.
-- No `set search_path`, same reasoning as the dup_* family (pg_catalog only,
-- and a SET clause blocks inlining). DO NOT `create or replace` it with
-- different behaviour without `reindex index idx_merchants_norm_city` AND
-- re-checking merchants_location_format: Postgres keeps index entries
-- computed by the old definition, and a city search that silently stops
-- matching looks exactly like a city with no accounts.
create or replace function norm_city(input text)
returns text language sql immutable strict parallel safe as $$
  select nullif(
    btrim(regexp_replace(regexp_replace(lower(input), '[[:punct:]]', ' ', 'g'),
                         '\s+', ' ', 'g')),
    '')
$$;

revoke all on function norm_city(text) from public;
grant execute on function norm_city(text) to authenticated, service_role;

-- REQUIRED FOR NEW MERCHANTS ONLY -- and this is the second design, for a
-- reason worth keeping in view.
--
-- The first version of 20261013130000 added a table-wide
-- `check (city and state present) NOT VALID`. NOT VALID only skips the rows
-- that exist when the constraint is added; Postgres still enforces it on
-- EVERY LATER UPDATE of those rows. So on a project full of merchants that
-- predate the columns, an admin could not change a merchant's status or MID
-- without also typing a location -- every existing merchant became
-- read-only. tests/rls/merchant-location.test.ts pins the edits that design
-- refused ("an existing merchant with no location stays editable"); they ran
-- red against it before this replaced it. The test fixtures had hidden it:
-- seed() was taught to give every merchant a location, so no existing test
-- ever updated a location-less row.
--
-- So the rule is split by what it applies to:
--
--   merchants_location_format   (a CHECK, validated, NULL-tolerant)
--       binds every row on every write, and only says what a location
--       looks like WHEN ONE IS PRESENT: a city that normalises to 2+
--       characters and is at most 60 trimmed (the range accounts_in_city()
--       searches, so nothing stored is unfindable), and a state of two
--       upper-case letters. A legacy row with neither passes. Plain, not
--       NOT VALID: every existing row is NULL/NULL, which it accepts.
--
--   merchants_location_guard    (a BEFORE INSERT OR UPDATE trigger)
--       INSERT: a new merchant must have both. This is "required for new
--       data" -- a CHECK cannot tell an insert from an update, which is the
--       whole reason this is a trigger.
--       UPDATE: a merchant that HAS a complete location cannot have it
--       removed. A legacy merchant with none is untouched by this branch, so
--       it stays fully editable; once a location is supplied it sticks.
--       Changing a location to another valid one is always allowed.
--
-- Raised as PT422 with a sentence, which lib/db-errors.ts passes through
-- verbatim, rather than 23514 naming a constraint a rep has never heard of.
--
-- No backfill in a migration: scripts/backfill-merchant-location.sql fills
-- what a linked pre-app can supply, reviewed and run by hand. Admins see the
-- rest at /admin/merchants/missing-location. Review query:
--   select id, agent_id, dba, status from merchants
--    where city is null or state is null order by id;
alter table merchants
  add constraint merchants_location_format check (
    (city is null
      or (char_length(btrim(city)) <= 60
          and coalesce(char_length(norm_city(city)), 0) >= 2))
    and (state is null or state ~ '^[A-Z]{2}$')
  );

create or replace function enforce_merchant_location()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if NEW.city is null or NEW.state is null then
      raise exception 'A new merchant needs a city and a two-letter state.'
        using errcode = 'PT422';
    end if;
  elsif OLD.city is not null and OLD.state is not null
        and (NEW.city is null or NEW.state is null) then
    raise exception 'A merchant''s city and state can be changed but not removed.'
      using errcode = 'PT422';
  end if;
  -- Shape (2..60 characters, a two-letter code) is merchants_location_format's
  -- job, on every row. This trigger only decides WHETHER one is required.
  return NEW;
end;
$$;

-- A trigger function needs no EXECUTE grant to fire, so nobody gets one; the
-- enforce_quote_version() convention.
revoke all on function enforce_merchant_location() from public;
revoke all on function enforce_merchant_location() from anon, authenticated;

create trigger merchants_location_guard
  before insert or update of city, state on merchants
  for each row execute function enforce_merchant_location();

alter table merchants enable row level security;

-- MERCHANTS ARE ADMIN-ONLY TO CHANGE (20261021120000; security fix phase 1,
-- docs/claude/security-fixes.md).
--
-- A rep READS their own book (and adds notes and tasks, which are other
-- tables); only an admin inserts, updates or deletes a merchant. Until this,
-- "insert own" and "update own or admin" let a rep write every column of
-- their own merchant, MID included -- and commit_residual_import_v2 finds the
-- share covering a staged row by the merchant's CURRENT mid. A rep padding
-- the MID while a month was in review made the signer's row match no
-- merchant: it committed unshared, the partner got nothing, the rep restored
-- the MID, and log_cross_agent_change() recorded nothing because the editor
-- owned the row. tests/rls/merchants-admin-only-writes.test.ts runs that
-- attack against the schema before and after.
--
-- The rule is in the POLICIES, and only there can it be: admins and reps are
-- both `authenticated`, so a grant cannot tell them apart, and the admin's
-- merchant form and the missing-location screen need insert and update.
-- The table-wide grant therefore stays as it is.
--
-- Every merchant a rep's work produces is created by approve_pre_app(),
-- `security definer` behind its own is_admin() check, so it is unaffected.
-- The MID itself is also watched by merchants_mid_audit (below, next to the
-- cross-agent trigger), for every caller, admins included.
create policy "select own or admin" on merchants
  for select using ((agent_id = auth.uid() and is_active_agent()) or is_admin());
create policy "admin insert only" on merchants
  for insert with check (is_admin());
create policy "admin update only" on merchants
  for update using (is_admin()) with check (is_admin());
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
  -- Fixed to 'US' (20261028120000; memo A14): only US merchants are
  -- supported, and state is already a two-letter US code. Not editable in the
  -- wizard. Relax this and the state rule together.
  country text not null default 'US' constraint pre_apps_country_us check (country = 'US'),
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
  -- Which identifier the business's tax ID is (memo §0.3; 20261026140000).
  -- Plaintext: it says what the number is, not what it is. The NUMBER lives in
  -- pre_app_tax_secrets, encrypted -- the plaintext ein_number column that
  -- used to sit here was dropped by the same migration. submit_pre_app()
  -- requires a tax-id row whose tax_id_type equals this, so switching the
  -- type after the number was entered means entering the number again.
  ein_type text constraint pre_apps_ein_type_check check (ein_type in ('EIN', 'SSN')),
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

  -- Commission split between the rep and Tapswipe, copied into merchants by
  -- approve_pre_app(). Since 20261028120000 (memo §0b.4) it is a SNAPSHOT:
  -- submit_pre_app() writes the rep's profiles.split_rate_pct and 100 minus
  -- it, and pre_apps_guard_transitions refuses any other write -- a rep, an
  -- admin, or the wizard. A draft carries the defaults. The rep side is at
  -- most 50 (pre_apps_split_agent_pct_range).
  split_agent_pct numeric(5,2) not null default 50
    constraint pre_apps_split_agent_pct_range check (split_agent_pct between 0 and 50),
  split_company_pct numeric(5,2) not null default 50,
  constraint pre_apps_split_sums_to_100
    check (split_agent_pct + split_company_pct = 100),

  -- The rep's legal name and LLC legal name, snapshotted from the pre-app's
  -- rep's profile by submit_pre_app() (20261028120000; memo §7.1). The LLC
  -- column falls back to the legal name (A16). Null on a draft; written by
  -- nothing else (pre_apps_guard_transitions). A later set_rep_identity()
  -- does not change a submitted pre-app.
  rep_legal_name text,
  rep_llc_legal_name text,

  -- The processor this application is for (20261023130000), from the same
  -- list as merchants.processor, and copied onto the merchant by
  -- approve_pre_app(). OPTIONAL: it is not in the mandatory-before-submit list
  -- (docs/design/intake-and-reports.md, A6), so a rep may leave it unset and
  -- an admin set it on the merchant later.
  processor text constraint pre_apps_processor_fkey references processors(code),

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
  -- Fixed to 'US' (20261028120000; memo A14), as pre_apps.country.
  home_country text not null default 'US'
    constraint pre_app_owners_home_country_us check (home_country = 'US'),
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
-- PRE-APP CHILDREN ARE FROZEN WITH THEIR PARENT (20261021130000; security
-- fix phase 2, docs/claude/security-fixes.md).
--
-- pre_apps_guard_transitions (below) has frozen a non-draft pre_apps row for
-- non-admins since 20260806141000. The three child tables above were never
-- covered: their policies ask only whether the PARENT is the rep's, never
-- what state it is in -- a policy cannot see the parent's status without
-- re-querying it on every row, and nobody had. So after submit_pre_app() a
-- rep could rewrite the owners an admin was about to approve (names, DOB,
-- percent owned -- the 51% control rule submit just checked), add an owner
-- with no SSN, or delete one, which cascades their pre_app_owner_secrets row
-- away. tests/rls/pre-app-children-draft-only.test.ts runs that against the
-- schema before and after.
--
-- The rule is the parent's, copied: agents change a draft's children, admins
-- change anyone's. Refused as PT409 with a sentence naming the status. A
-- rep with a declined pre-app calls reopen_pre_app() first, which returns it
-- to draft -- the same path pre_apps itself already requires.
--
--   * INSERT checks the new parent; DELETE the old one; UPDATE BOTH, so an
--     owner cannot be re-parented onto, or off, a non-draft pre-app.
--   * A parent that no longer exists is not a refusal: that is a cascade from
--     a pre_apps delete (admin-only by policy, or the platform owner), and
--     the children must go with it. `security definer` so that "not found"
--     means "deleted" and never "not visible to this caller"; ownership stays
--     the policies' job, and they still run after this trigger.
--   * The state machine's own flag (tapswipe.pre_app_transition) passes it,
--     as it passes pre_apps_guard_transitions: fixtures use it, and a client
--     cannot set it. No RPC writes these tables today.
--   * A service-role connection is NOT exempt (no auth.uid(), so is_admin()
--     is false), exactly as for pre_apps. The secrets Edge Functions write
--     only the *_secrets tables, never these.
-- =====================================================================
create or replace function pre_app_children_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  parent_status text;
begin
  if coalesce(current_setting('tapswipe.pre_app_transition', true), '') = 'on'
     or is_admin() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op in ('UPDATE', 'DELETE') then
    select status into parent_status from pre_apps where id = old.pre_app_id;
    if found and parent_status <> 'draft' then
      raise exception 'the owners, terminal and business profile of a % pre-app can only be changed by an admin',
        parent_status using errcode = 'PT409';
    end if;
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    select status into parent_status from pre_apps where id = new.pre_app_id;
    if found and parent_status <> 'draft' then
      raise exception 'the owners, terminal and business profile of a % pre-app can only be changed by an admin',
        parent_status using errcode = 'PT409';
    end if;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

-- A trigger function needs no EXECUTE grant to fire, so nobody gets one.
revoke all on function pre_app_children_guard() from public;
revoke all on function pre_app_children_guard() from anon, authenticated;

create trigger pre_app_owners_draft_only
  before insert or update or delete on pre_app_owners
  for each row execute function pre_app_children_guard();

create trigger pre_app_terminal_draft_only
  before insert or update or delete on pre_app_terminal
  for each row execute function pre_app_children_guard();

create trigger pre_app_business_profile_draft_only
  before insert or update or delete on pre_app_business_profile
  for each row execute function pre_app_children_guard();

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

-- The FOURTH secrets table (20261026140000; phase 3 of
-- docs/design/intake-and-reports.md): the business's tax ID, an EIN or an SSN
-- according to pre_apps.ein_type. Built exactly as the three above: unique
-- parent reference, cascade from pre_apps, key_version, RLS with zero
-- policies, no grant to anon or authenticated, written and read only by the
-- two secrets Edge Functions (AAD: pre_app_tax_secrets / tax_id_encrypted /
-- pre_app_id). A rep reads back the last four only.
--
-- tax_id_type is plaintext and says which validator accepted the value. It is
-- written by submit-pre-app-secrets, which refuses one that differs from the
-- pre-app's current ein_type. It is NOT the SSN of any owner and is never
-- copied from or to pre_app_owner_secrets, even when the number is the same.
create table pre_app_tax_secrets (
  id serial primary key,
  pre_app_id int references pre_apps(id) on delete cascade not null unique,
  tax_id_type text not null
    constraint pre_app_tax_secrets_tax_id_type_check check (tax_id_type in ('EIN', 'SSN')),
  tax_id_encrypted bytea not null,
  key_version smallint not null default 1
);
alter table pre_app_tax_secrets enable row level security;
-- intentionally zero policies for `authenticated` — service role only
revoke all on pre_app_tax_secrets from public, anon, authenticated;
revoke all on sequence pre_app_tax_secrets_id_seq from public, anon, authenticated;
grant all on pre_app_tax_secrets to service_role;
grant all on sequence pre_app_tax_secrets_id_seq to service_role;

-- ---------------------------------------------------------------------
-- DOCUMENTS — LEGACY, CLOSED. Metadata for per-record uploads (a voided
-- check on a merchant, a licence on a pre-app) whose bytes live in the
-- `documents` bucket.
--
-- CLOSED BY 20261013121000. The CRM no longer accepts merchant paperwork,
-- and /documents is now the company library (BUSINESS DOCUMENTS, below).
-- What closing means, in both layers:
--
--   * Grants: `authenticated` keeps SELECT only. INSERT and DELETE are
--     revoked (UPDATE never existed), and so is USAGE on documents_id_seq.
--     A write is therefore "permission denied" before RLS is consulted --
--     for an admin too.
--   * Policies: the own-row select, insert and delete policies are dropped.
--     One policy remains, `select admin`, so an admin can still see what is
--     left until the purge runs.
--   * Functions: create-upload-url, create-download-url and delete-document
--     are removed from the repo. A rep's only way to reach the bucket was a
--     URL those signed, and the bucket has no storage policies, so with the
--     functions gone there is no client path to it at all. Removing them from
--     the repo does NOT remove them from a hosted project; that is a
--     deliberate `functions delete` per project.
--
-- The TABLE and the BUCKET are deliberately kept: rows and objects already
-- exist, and deleting them is scripts/purge-legacy-documents.mjs's job --
-- through the Storage API, because deleting storage.objects rows in SQL
-- leaves the bytes behind. Everything below describes the table as it was
-- built, and still is: the CHECK, the audit trigger and service_role's
-- grant all remain, and the trigger records each purged row
-- (actor_id null, cross_agent_delete).
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

-- Admin-only read, and nothing else, since 20261013121000. The three own-row
-- policies this table was built with -- "select own or admin", "insert own",
-- "delete own or admin" -- are dropped there. With no INSERT or DELETE grant
-- left either, a policy alone could not reopen a write, and a grant alone
-- would meet no policy; closing both is what makes the refusal hold even if
-- one layer is later loosened by mistake.
create policy "select admin" on documents
  for select using (is_admin());
-- HISTORY, kept because the rest of this block argues from it: the table had
-- no UPDATE policy and no UPDATE grant from the start. A
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
  --
  -- REDEFINED by 20261014140000 (SHARED LINES, after merchant_rep_shares
  -- below): the column is dropped and re-added with three more branches. Its
  -- unshared branch is THIS expression, character for character, and that
  -- migration refuses to commit if any existing row's value moves.
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
  --
  -- REPLACED by 20261016160000 (IMPORT MERGE KEY, below): this constraint is
  -- dropped for the partial unique index rep_payout_rows_import_merge_key,
  -- `(period, agent_id, mid) where line_kind = 'import'`, so import lines keep
  -- exactly this key and adjustment lines may repeat it.
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
--
-- SUPERSEDED IN TWO STEPS further down this file (COMMIT V2, 20261016120000):
-- this function is re-created there with ONE added guard, refusing a batch
-- that contains a shared account, and commit_residual_import_v2 is defined
-- beside it. The body below is the pre-share version; the one there is
-- identical apart from that guard.
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

-- ---------------------------------------------------------------------
-- shared_part(total, part, whole) — the cent rule for a shared account
-- (20261014120000). Design: docs/design/residual-splits.md §4.
--
-- Two reps sharing an account divide the rep side's payout. The account's
-- payout is worked out ONCE, exactly as for a rep working it alone --
-- T = round(R * p / 100, 2), the same expression rep_payout_rows.rep_payout
-- uses -- and this function returns the PARTNER's piece of T:
--
--   partner = shared_part(T, partner_rep_pct, signer_rep_pct + partner_rep_pct)
--   signer  = T - partner
--
-- so signer + partner = T exactly, by construction: the signer's piece is
-- defined as the remainder, and both are whole cents.
--
-- THE RULE: the partner gets the whole cent NEAREST to T * part / whole, and an
-- exact half-cent tie goes TOWARD ZERO -- so on a tie the signer's line absorbs
-- the cent, for a credit and a clawback alike. Each piece is then within half a
-- cent of the exact proportion. The function is odd, shared_part(-x) =
-- -shared_part(x), so a negative month divides as the mirror of a positive
-- one. Zero gives zero; NULL in any argument gives NULL (STRICT), so "not
-- worked out yet" stays not worked out.
--
-- WHY THE PAYOUT IS DIVIDED RATHER THAN EACH LINE RECOMPUTED. Dividing the
-- residual first and letting each line round its own payout breaks the rule:
-- R = $0.02 at 50% split 25+25 gives two $0.01 residual pieces, each
-- round($0.005) = $0.01, so $0.02 paid against a solo $0.01. The same function
-- also divides the residual itself for display (partner_res = shared_part(R,
-- ...), signer_res = R - partner_res), where the sum is likewise exact.
--
-- WHY INTEGER ARITHMETIC. Everything is scaled to whole cents and whole
-- hundredths of a percent, and the rounding is
--   floor((2n + d - 1) / (2d))  with  n = |cents| * part_bp,  d = whole_bp
-- computed with div(), which truncates an exact numeric quotient. That equals
-- ceil(n/d - 1/2): the nearest integer, ties down. Ordinary numeric division
-- would be correct to its working precision too, but "correct to the 16th
-- digit" is an argument; div() on integers needs none. Inputs carrying a
-- fraction of a cent or of a hundredth of a percent are refused (22023) rather
-- than rounded, because rounding them here would be a second rounding rule
-- hidden inside the first.
--
-- ONE COPY, IN SQL. There is no TypeScript twin: the browser only ever
-- displays what Postgres stored, so there is nothing for a second copy to
-- agree with -- the opposite arrangement to the pre-app secrets validators.
--
-- NEVER `create or replace` THIS WITH DIFFERENT BEHAVIOUR. From phase 3 a
-- stored generated column calls it, and Postgres keeps every stored value the
-- old definition computed -- the same trap as the dup_* normalisers and their
-- indexes. A change of rule is a new function plus a deliberate, checked
-- recompute.
--
-- immutable (a generated column requires it) and security INVOKER: it reads
-- no table and needs no privilege, so there is nothing for definer to buy.
-- Privilege lines per the house rule -- Postgres grants EXECUTE to PUBLIC,
-- which includes anon, on every new function.
--
-- tests/rls/shared-part.test.ts checks every cent from -$200.00 to $200.00
-- across eight ratios.
-- ---------------------------------------------------------------------
create or replace function shared_part(total numeric, part numeric, whole numeric)
returns numeric
language plpgsql
immutable
strict
set search_path = public
as $$
declare
  n numeric;  -- |total| in cents, times part in hundredths of a percent
  d numeric;  -- whole in hundredths of a percent
begin
  if whole <= 0 then
    raise exception 'shared_part: whole must be greater than zero'
      using errcode = '22023';
  end if;

  if part < 0 or part > whole then
    raise exception 'shared_part: part must be between 0 and whole'
      using errcode = '22023';
  end if;

  if total <> round(total, 2) or part <> round(part, 2)
     or whole <> round(whole, 2) then
    raise exception 'shared_part: amounts must be whole cents and percentages whole hundredths'
      using errcode = '22023';
  end if;

  n := abs(total) * 100 * (part * 100);
  d := whole * 100;

  -- Nearest whole cent to n/d, an exact half going toward zero. round(..., 2)
  -- only fixes the scale of an already-exact value; it rounds nothing.
  return round(sign(total) * div(2 * n + d - 1, 2 * d) * 0.01, 2);
end;
$$;

revoke all on function shared_part(numeric, numeric, numeric) from public;
grant execute on function shared_part(numeric, numeric, numeric)
  to authenticated, service_role;

-- =====================================================================
-- MERCHANT REP SHARES — two reps sharing one account's residual
-- (20261014130000). Design: docs/design/residual-splits.md §3, §8.
--
-- The owner's rule: on every account the rep side is 50% of the residual and
-- the company keeps 50%. When two reps worked an account and one signed it,
-- an admin divides that 50 between them in any ratio (25+25, 40+10, ...). The
-- company's 50 never changes. A row here says: for this merchant, from month
-- X (until month Y), the rep side is divided signer:partner.
--
-- Nothing reads this table yet. Phase 3 snapshots it onto ledger lines and
-- phase 4 makes the commit apply it; this phase is the table and its guards.
--
-- WHAT IS STORED IS WHAT THE ADMIN TYPED, in rep-percent terms: 40 and 10,
-- not 80% and 20%. Nothing is rescaled, so nothing is rounded at entry; the
-- ratio is applied in whole cents by shared_part() at payout time.
--
-- STRUCTURE IS THE GUARD for the two rules that must never break:
--   * at most two reps   -- two columns, not a junction table;
--   * shares total 50    -- a CHECK on the pair.
-- Neither needs a trigger, and neither can be violated by any writer, the
-- owner included.
--
-- NO OVERLAP per merchant is an exclusion constraint over
-- daterange(effective_from, effective_to) -- '[)' bounds, NULL upper meaning
-- open-ended. It needs btree_gist for the `merchant_id with =` half. The RPCs
-- check overlap first so an admin reads a sentence; the constraint is the
-- backstop that holds for a writer that skips them.
--
-- NO agent_id COLUMN, a documented deviation like rep_payout_batches.
-- imported_by: a share has two reps, and the standard own-row policy would be
-- wrong for either of them. No created_by either -- audit_log records the
-- actor, and every extra profiles FK is one more entry in four teardown lists.
-- That leaves TWO new references to profiles(id), both NO ACTION, taking the
-- schema's count from 23 to 25.
--
-- merchant_id is ON DELETE RESTRICT: a merchant with a share cannot be
-- deleted. A share is a payroll record, and `cascade` would erase it while
-- `set null` would leave a share about nothing.
--
-- THE MONTH RULE, enforced by every RPC below: no boundary -- a start, an end,
-- a cancellation -- may fall at or before the latest month already in the
-- ledger for that merchant's MID. So a share edit can never change a committed
-- figure; a share agreed after a month was committed is corrected with an
-- adjustment pair (design §6), never by back-dating. "Committed for that MID"
-- is any rep_payout_rows row with this merchant_id OR this mid: merchant_id is
-- only the soft link resolved at parse time, and a row whose MID matched no
-- merchant then still counts.
--
-- ROWS ARE IMMUTABLE except effective_to. A different ratio or a different
-- rep is an end plus a new share, which set_merchant_rep_share does in one
-- call -- so the table itself is the history.
--
-- WRITES ONLY THROUGH THE THREE RPCs BELOW. authenticated holds SELECT alone,
-- backed by an admin-only policy; no INSERT, UPDATE or DELETE grant exists, so
-- a direct write fails as "permission denied" rather than being filtered.
--
-- NOT AUDITED BY log_cross_agent_change(): there is no agent_id for it to
-- read, and only admins write, so it would fire on every write. Each RPC
-- writes its own audit_log row instead, failing closed.
-- =====================================================================
create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;

create table merchant_rep_shares (
  id serial primary key,
  merchant_id int not null references merchants(id) on delete restrict,
  -- The signer: the rep the processor's file names under Agent # for this MID.
  primary_agent_id   uuid not null references profiles(id),
  -- The partner.
  secondary_agent_id uuid not null references profiles(id),
  -- Each rep's share of the 50-point rep side, exactly as typed.
  primary_rep_pct   numeric(5,2) not null,
  secondary_rep_pct numeric(5,2) not null,
  -- First payout month the share applies to (1st of the month).
  effective_from date not null,
  -- EXCLUSIVE: the first month it no longer applies. NULL = open-ended.
  effective_to   date,
  created_at timestamptz not null default now(),
  constraint merchant_rep_shares_two_reps
    check (primary_agent_id <> secondary_agent_id),
  constraint merchant_rep_shares_positive
    check (primary_rep_pct > 0 and secondary_rep_pct > 0),
  constraint merchant_rep_shares_total_rep_side
    check (primary_rep_pct + secondary_rep_pct = 50.00),
  constraint merchant_rep_shares_from_first_of_month
    check (extract(day from effective_from) = 1),
  constraint merchant_rep_shares_to_first_of_month
    check (effective_to is null
           or (extract(day from effective_to) = 1 and effective_to > effective_from)),
  constraint merchant_rep_shares_no_overlap
    exclude using gist (merchant_id with =,
                        daterange(effective_from, effective_to) with &&)
);

alter table merchant_rep_shares enable row level security;

-- Admins only. A rep learns about their own share from their own ledger line
-- (phase 3) and from a narrow read function (phase 6) -- never from this table,
-- which names the other rep and the other rep's share.
create policy "admin only select" on merchant_rep_shares
  for select using (is_admin());

grant select on merchant_rep_shares to authenticated;
grant all on merchant_rep_shares to service_role;
-- service_role only, like the rep_payout sequences: authenticated holds no
-- INSERT, and the RPCs run as the owner.
grant usage on merchant_rep_shares_id_seq to service_role;

-- ---------------------------------------------------------------------
-- The three write RPCs. All `security definer` (the table grants no write to
-- authenticated, and audit_log no insert to anyone), each with a hand-written
-- is_admin() guard at the top -- definer bypasses RLS, so a guard deleted here
-- fails open silently.
--
-- Every one takes pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'))
-- before reading anything. The residual commit path takes the SAME lock from
-- phase 4 on, so a share edit and a commit for the same month cannot
-- interleave: without it, each could check the other's state before the other
-- committed, and a share could start at a month that was being committed
-- without it. Two connections are needed to see that race, so PGlite cannot;
-- it is checked by hand against real Postgres, as 20260821171000 was.
--
-- Error codes follow the house shape: PT403 not an admin, PT404 not found,
-- PT409 a conflict with existing state, 22023 a bad argument. Messages are
-- sentences an admin can act on; lib/db-errors.ts passes PT codes through.
-- ---------------------------------------------------------------------

-- set_merchant_rep_share: start a share from a month. If an open share
-- exists on the merchant and started earlier, it is ended at that month in the
-- same transaction -- so "change the ratio from November" is one call, and the
-- table reads as the history of the account.
create or replace function set_merchant_rep_share(
  merchant_id_input        int,
  primary_agent_id_input   uuid,
  secondary_agent_id_input uuid,
  primary_rep_pct_input    numeric,
  secondary_rep_pct_input  numeric,
  effective_from_input     date
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  m          merchants;
  rep        profiles;
  latest     date;
  open_share merchant_rep_shares;
  new_id     int;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  if merchant_id_input is null or primary_agent_id_input is null
     or secondary_agent_id_input is null or primary_rep_pct_input is null
     or secondary_rep_pct_input is null or effective_from_input is null then
    raise exception 'Every field is required to set a shared account.'
      using errcode = '22023';
  end if;

  select * into m from merchants where id = merchant_id_input;
  if not found then
    raise exception 'merchant not found' using errcode = 'PT404';
  end if;

  if m.mid is null or btrim(m.mid) = '' then
    raise exception 'This merchant has no MID, so no residual could ever match a share on it. Add the MID first.'
      using errcode = 'PT409';
  end if;

  if primary_agent_id_input = secondary_agent_id_input then
    raise exception 'The signer and the partner must be two different reps.'
      using errcode = '22023';
  end if;

  -- Both reps must exist and be active. A NEW share naming someone who has
  -- left is almost certainly a mistake (design §9, Q10); an existing share
  -- keeps paying a rep deactivated later, which is a different question.
  for rep in
    select * from profiles
     where id in (primary_agent_id_input, secondary_agent_id_input)
  loop
    if not rep.is_active then
      raise exception '% is deactivated, so a new share cannot name them.', rep.full_name
        using errcode = 'PT409';
    end if;
  end loop;
  if (select count(*) from profiles
       where id in (primary_agent_id_input, secondary_agent_id_input)) <> 2 then
    raise exception 'rep not found' using errcode = 'PT404';
  end if;

  if primary_rep_pct_input <> round(primary_rep_pct_input, 2)
     or secondary_rep_pct_input <> round(secondary_rep_pct_input, 2)
     or primary_rep_pct_input <= 0 or secondary_rep_pct_input <= 0
     or primary_rep_pct_input + secondary_rep_pct_input <> 50 then
    raise exception 'The two shares must each be above 0, in hundredths at most, and add up to the rep side: 50.'
      using errcode = '22023';
  end if;

  if extract(day from effective_from_input) <> 1 then
    raise exception 'A share starts on the first day of a month.'
      using errcode = '22023';
  end if;

  select max(period) into latest
    from rep_payout_rows
   where merchant_id = m.id or mid = m.mid;

  if latest is not null and effective_from_input <= latest then
    raise exception '% is already committed for this MID. A share can only start after it; earlier months are corrected with an adjustment.',
      to_char(latest, 'FMMonth YYYY')
      using errcode = 'PT409';
  end if;

  select * into open_share
    from merchant_rep_shares
   where merchant_id = m.id and effective_to is null;

  if found then
    if open_share.effective_from >= effective_from_input then
      raise exception 'This merchant already has a share starting %. Cancel or end that one first.',
        to_char(open_share.effective_from, 'FMMonth YYYY')
        using errcode = 'PT409';
    end if;

    update merchant_rep_shares
       set effective_to = effective_from_input
     where id = open_share.id;

    insert into audit_log (actor_id, action, table_name, row_id)
    values (auth.uid(), 'end_merchant_rep_share', 'merchant_rep_shares',
            open_share.id::text);
  end if;

  -- Overlap with a share that is already closed but runs past the new start
  -- (one ended in the future). The new share is open-ended, so anything
  -- reaching past effective_from_input collides.
  if exists (
    select 1 from merchant_rep_shares
     where merchant_id = m.id
       and daterange(effective_from, effective_to)
           && daterange(effective_from_input, null)
  ) then
    raise exception 'That month overlaps another share on this merchant.'
      using errcode = 'PT409';
  end if;

  insert into merchant_rep_shares (
    merchant_id, primary_agent_id, secondary_agent_id,
    primary_rep_pct, secondary_rep_pct, effective_from
  )
  values (
    m.id, primary_agent_id_input, secondary_agent_id_input,
    primary_rep_pct_input, secondary_rep_pct_input, effective_from_input
  )
  returning id into new_id;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'set_merchant_rep_share', 'merchant_rep_shares',
          new_id::text);

  return new_id;
end;
$$;

revoke all on function set_merchant_rep_share(int, uuid, uuid, numeric, numeric, date)
  from public;
grant execute on function set_merchant_rep_share(int, uuid, uuid, numeric, numeric, date)
  to authenticated, service_role;

-- end_merchant_rep_share: the share stops applying FROM effective_to_input
-- (exclusive). Also moves an existing end, in either direction, provided both
-- the old and the new boundary are still in uncommitted months -- an end that a
-- committed month already sits on is settled.
create or replace function end_merchant_rep_share(
  share_id_input     int,
  effective_to_input date
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s      merchant_rep_shares;
  m      merchants;
  latest date;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  if share_id_input is null or effective_to_input is null then
    raise exception 'A share and an end month are required.'
      using errcode = '22023';
  end if;

  select * into s from merchant_rep_shares where id = share_id_input;
  if not found then
    raise exception 'share not found' using errcode = 'PT404';
  end if;

  if extract(day from effective_to_input) <> 1 then
    raise exception 'A share ends on the first day of a month.'
      using errcode = '22023';
  end if;

  if effective_to_input <= s.effective_from then
    raise exception 'A share has to end after the month it starts. To remove it entirely, cancel it.'
      using errcode = '22023';
  end if;

  select * into m from merchants where id = s.merchant_id;
  select max(period) into latest
    from rep_payout_rows
   where merchant_id = m.id or mid = m.mid;

  if latest is not null and effective_to_input <= latest then
    raise exception '% is already committed for this MID. A share can only end after it.',
      to_char(latest, 'FMMonth YYYY')
      using errcode = 'PT409';
  end if;

  if latest is not null and s.effective_to is not null and s.effective_to <= latest then
    raise exception 'This share already ended before a committed month, so its end is settled.'
      using errcode = 'PT409';
  end if;

  if exists (
    select 1 from merchant_rep_shares
     where merchant_id = s.merchant_id
       and id <> s.id
       and daterange(effective_from, effective_to)
           && daterange(s.effective_from, effective_to_input)
  ) then
    raise exception 'That end month overlaps another share on this merchant.'
      using errcode = 'PT409';
  end if;

  update merchant_rep_shares
     set effective_to = effective_to_input
   where id = s.id;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'end_merchant_rep_share', 'merchant_rep_shares',
          s.id::text);
end;
$$;

revoke all on function end_merchant_rep_share(int, date) from public;
grant execute on function end_merchant_rep_share(int, date)
  to authenticated, service_role;

-- cancel_merchant_rep_share: deletes a share that was never used -- one with
-- no committed month inside it. Once any month in its range is committed, the
-- share is part of how that month was paid, and the answer is to end it.
-- (Phase 3 adds rep_payout_rows.rep_share_id ON DELETE RESTRICT as the
-- backstop; until then this check is the whole guard, and it is equivalent:
-- a line can only reference a share if its month falls inside it.)
create or replace function cancel_merchant_rep_share(share_id_input int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s      merchant_rep_shares;
  m      merchants;
  latest date;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  select * into s from merchant_rep_shares where id = share_id_input;
  if not found then
    raise exception 'share not found' using errcode = 'PT404';
  end if;

  select * into m from merchants where id = s.merchant_id;
  select max(period) into latest
    from rep_payout_rows
   where merchant_id = m.id or mid = m.mid;

  if latest is not null and s.effective_from <= latest then
    raise exception 'A month in this share is already committed, so it cannot be cancelled. End it instead.'
      using errcode = 'PT409';
  end if;

  delete from merchant_rep_shares where id = s.id;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'cancel_merchant_rep_share', 'merchant_rep_shares',
          s.id::text);
end;
$$;

revoke all on function cancel_merchant_rep_share(int) from public;
grant execute on function cancel_merchant_rep_share(int)
  to authenticated, service_role;

-- =====================================================================
-- SHARED LINES (20261014140000) — rep_payout_rows learns about shared
-- accounts and adjustment lines, and rep_payout is rewritten to pay them.
-- Design: docs/design/residual-splits.md §3.2, §3.3, §4, §5.2.
--
-- A shared account is TWO ledger lines in a month, the signer's and the
-- partner's, so that "a rep's money is the sum of rep_payout over their own
-- rows" stays true for every existing reader and every existing policy. What
-- is divided is the rep side's PAYOUT: the payout one rep alone would receive,
-- T = round(account_residual_income * rep_split_pct / 100, 2), is worked out
-- on each line from the account figure, and shared_part() takes the partner's
-- piece; the signer gets T minus it. The two always sum to T exactly. Each
-- line's residual_income is the matching piece of the account residual, kept
-- so the period's Residual income total stays exact; a CHECK makes every line
-- prove its own piece.
--
-- The share is SNAPSHOTTED onto both lines (primary_rep_pct,
-- secondary_rep_pct) because a generated column cannot read another table --
-- and because a later edit to a share must never re-price a month already
-- paid.
--
-- line_kind and the adjustment columns arrive now, with their branch in the
-- expression, so rep_payout is rewritten ONCE. Nothing writes an adjustment
-- line yet: the merge key stays the ordinary unique (period, agent_id, mid)
-- until phase 5 swaps it for a partial index, because today's
-- commit_residual_import says `on conflict (period, agent_id, mid)` with no
-- WHERE and Postgres would not infer a partial index from that.
--
-- HOW THE COLUMN IS REWRITTEN: drop and re-add, in one transaction, which is
-- the method that works on every Postgres version (ALTER COLUMN ... SET
-- EXPRESSION is 17+). Three things make that safe, all in the migration:
--
--   1. PRECONDITIONS. Dropping a column silently drops any index on it and
--      fails on a view or policy; dropping it also loses a column-level grant.
--      On every database this repo can see, the only dependent of rep_payout
--      is its own generation expression and its ACL is null (all privileges
--      come from table-level grants, which cover a re-added column too). The
--      migration REFUSES to run if that is not true on the database in front
--      of it -- a hosted project with something hand-made on the column must
--      not lose it quietly.
--   2. A COPY of (id, rep_payout) is taken first, and after the rewrite the
--      row count, the total and an md5 over every (id, value) pair must match
--      it exactly, or the migration raises and everything above rolls back --
--      the Supabase CLI applies a migration file as one transaction (verified
--      14 Oct 2026: a failing file leaves neither its objects nor its ledger
--      row). The copy is a temp table, dropped before the end, so no payout
--      data outlives the migration.
--   3. Every new column must be empty (line_kind 'import', the rest NULL) on
--      every existing row, checked in the same block.
--
-- The column moves to the end of the table. Nothing reads it positionally;
-- every reader names it.
--
-- EDITING A SHARED PAIR. Both lines carry the account figure, so the pair is
-- changed together or not at all:
--   * set_shared_residual(share, month, amount) is the one write path for the
--     residual: it sets the account figure on both lines and both pieces, in
--     one statement;
--   * the partner's rep_split_pct always copies the signer's -- an AFTER
--     UPDATE trigger copies it across when the signer's changes;
--   * guard_shared_line() refuses everything else: a hand edit of either
--     residual piece, of the partner's rate, or of any share or adjustment
--     column. It is not a security boundary (UPDATE is already admin-only);
--     it stops an admin typing two pieces that no longer describe one
--     account.
-- The sanctioned paths set the transaction-local flag tapswipe.shared_write,
-- which the guard lets through. set_config is in pg_catalog, which PostgREST
-- does not expose, and no RPC passes caller input to it.
-- =====================================================================

-- 0. Preconditions: refuse rather than silently drop something hand-made.
do $$
declare
  dependents int;
  column_acl aclitem[];
begin
  select count(*) into dependents
    from pg_depend d
    join pg_attribute a
      on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
   where d.refobjid = 'public.rep_payout_rows'::regclass
     and a.attname = 'rep_payout'
     and d.classid <> 'pg_attrdef'::regclass;

  if dependents > 0 then
    raise exception 'rep_payout_rows.rep_payout has % dependent object(s) besides its own expression; dropping the column would drop or break them. Inspect pg_depend before applying 20261014140000.',
      dependents;
  end if;

  select attacl into column_acl
    from pg_attribute
   where attrelid = 'public.rep_payout_rows'::regclass
     and attname = 'rep_payout';

  if column_acl is not null then
    raise exception 'rep_payout_rows.rep_payout carries column-level privileges (%); dropping the column would lose them.',
      column_acl;
  end if;
end $$;

-- 1. The copy every existing payout is checked against.
create temp table rep_payout_rewrite_before on commit drop as
  select id, rep_payout from rep_payout_rows;

-- 2. The new columns. All empty on every existing row: line_kind's default is
-- a constant, so Postgres records it in the catalog rather than rewriting.
alter table rep_payout_rows
  add column line_kind text not null default 'import',
  add column rep_share_id int references merchant_rep_shares(id) on delete restrict,
  add column share_role text,
  add column account_residual_income numeric(14,2),
  add column primary_rep_pct numeric(5,2),
  add column secondary_rep_pct numeric(5,2),
  add column adjustment_amount numeric(14,2),
  add column adjusts_period date,
  add column adjustment_note text;

alter table rep_payout_rows
  add constraint rep_payout_rows_line_kind
    check (line_kind in ('import', 'adjustment')),
  add constraint rep_payout_rows_share_role
    check (share_role in ('primary', 'secondary')),
  -- The share columns come as a set. account_residual_income is the one that
  -- may be NULL on a shared line: "not worked out yet" is as ordinary there as
  -- on any other line.
  add constraint rep_payout_rows_share_columns_together check (
    (rep_share_id is null and share_role is null and primary_rep_pct is null
     and secondary_rep_pct is null and account_residual_income is null)
    or (rep_share_id is not null and share_role is not null
        and primary_rep_pct is not null and secondary_rep_pct is not null)
  ),
  -- The snapshot obeys the share table's own rule.
  add constraint rep_payout_rows_share_snapshot check (
    primary_rep_pct is null
    or (primary_rep_pct > 0 and secondary_rep_pct > 0
        and primary_rep_pct + secondary_rep_pct = 50.00)
  ),
  -- Every shared line proves its own residual piece from the account figure
  -- on the same row. Both NULL is "not worked out yet"; one without the other
  -- is refused.
  add constraint rep_payout_rows_shared_piece check (
    share_role is null
    or (account_residual_income is null and residual_income is null)
    or (account_residual_income is not null and residual_income is not null
        and residual_income = case share_role
          when 'secondary' then
            shared_part(account_residual_income, secondary_rep_pct,
                        primary_rep_pct + secondary_rep_pct)
          else
            account_residual_income
            - shared_part(account_residual_income, secondary_rep_pct,
                          primary_rep_pct + secondary_rep_pct)
        end)
  ),
  -- Adjustment columns only on adjustment lines, and an adjustment is never
  -- also a shared line.
  add constraint rep_payout_rows_adjustment_columns check (
    (line_kind = 'import' and adjustment_amount is null
     and adjusts_period is null and adjustment_note is null)
    or (line_kind = 'adjustment' and adjustment_amount is not null
        and adjusts_period is not null
        and extract(day from adjusts_period) = 1
        and rep_share_id is null)
  );

-- Finds a share's pair in a month (set_shared_residual, the rate copy), and
-- serves the restrict check when a share is deleted. Partial: almost every
-- line is unshared.
create index idx_rep_payout_rows_rep_share
  on rep_payout_rows (rep_share_id, period)
  where rep_share_id is not null;

-- 3. The rewrite. The unshared branch is today's expression, unchanged.
alter table rep_payout_rows drop column rep_payout;

alter table rep_payout_rows
  add column rep_payout numeric(14,2) generated always as (
    case
      when line_kind = 'adjustment' then adjustment_amount
      when share_role is null then
        round(residual_income * rep_split_pct / 100, 2)
      when share_role = 'secondary' then
        shared_part(round(account_residual_income * rep_split_pct / 100, 2),
                    secondary_rep_pct, primary_rep_pct + secondary_rep_pct)
      else
        round(account_residual_income * rep_split_pct / 100, 2)
        - shared_part(round(account_residual_income * rep_split_pct / 100, 2),
                      secondary_rep_pct, primary_rep_pct + secondary_rep_pct)
    end
  ) stored;

-- 4. Nothing moved, to the cent, or nothing commits.
do $$
declare
  before_rows  bigint;
  after_rows   bigint;
  before_total numeric;
  after_total  numeric;
  before_md5   text;
  after_md5    text;
  not_empty    bigint;
begin
  select count(*), sum(rep_payout),
         md5(coalesce(string_agg(id::text || ':' || coalesce(rep_payout::text, 'null'),
                                 ',' order by id), ''))
    into before_rows, before_total, before_md5
    from rep_payout_rewrite_before;

  select count(*), sum(rep_payout),
         md5(coalesce(string_agg(id::text || ':' || coalesce(rep_payout::text, 'null'),
                                 ',' order by id), ''))
    into after_rows, after_total, after_md5
    from rep_payout_rows;

  -- The message names counts and which check failed, never figures: a
  -- migration log is not a place for payout data.
  if before_rows is distinct from after_rows
     or before_total is distinct from after_total
     or before_md5 is distinct from after_md5 then
    raise exception 'rep_payout rewrite changed existing payouts (rows % -> %, total %, per-row checksum %); rolled back',
      before_rows, after_rows,
      case when before_total is not distinct from after_total then 'matches' else 'DIFFERS' end,
      case when before_md5 = after_md5 then 'matches' else 'DIFFERS' end;
  end if;

  select count(*) into not_empty
    from rep_payout_rows
   where line_kind <> 'import'
      or rep_share_id is not null or share_role is not null
      or account_residual_income is not null
      or primary_rep_pct is not null or secondary_rep_pct is not null
      or adjustment_amount is not null or adjusts_period is not null
      or adjustment_note is not null;

  if not_empty > 0 then
    raise exception 'rep_payout rewrite: % existing row(s) came out with a shared or adjustment column set; rolled back',
      not_empty;
  end if;
end $$;

drop table rep_payout_rewrite_before;

-- 5. guard_shared_line(): the pair is changed together or not at all.
create or replace function guard_shared_line()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce(current_setting('tapswipe.shared_write', true), '') = 'on' then
    return new;
  end if;

  if new.line_kind is distinct from old.line_kind
     or new.rep_share_id is distinct from old.rep_share_id
     or new.share_role is distinct from old.share_role
     or new.account_residual_income is distinct from old.account_residual_income
     or new.primary_rep_pct is distinct from old.primary_rep_pct
     or new.secondary_rep_pct is distinct from old.secondary_rep_pct
     or new.adjustment_amount is distinct from old.adjustment_amount
     or new.adjusts_period is distinct from old.adjusts_period
     or new.adjustment_note is distinct from old.adjustment_note then
    raise exception 'Shared-account and adjustment details are set by their own functions, not edited directly.'
      using errcode = 'PT409';
  end if;

  if old.share_role is not null
     and new.residual_income is distinct from old.residual_income then
    raise exception 'This account is shared. Set its total residual on the signer''s line and it will be divided.'
      using errcode = 'PT409';
  end if;

  if old.share_role = 'secondary'
     and new.rep_split_pct is distinct from old.rep_split_pct then
    raise exception 'The partner''s rate always copies the signer''s. Change it on the signer''s line.'
      using errcode = 'PT409';
  end if;

  return new;
end;
$$;

revoke all on function guard_shared_line() from public;

create trigger rep_payout_rows_guard_shared
  before update on rep_payout_rows
  for each row execute function guard_shared_line();

-- 6. copy_signer_rate_to_partner(): the partner's rate is the signer's.
-- Security invoker -- it runs inside an admin's own UPDATE, which the admin
-- update policy already admits for the partner's row too. The flag is put
-- back to what it was, so a caller that set it keeps it.
create or replace function copy_signer_rate_to_partner()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  previous text;
begin
  previous := current_setting('tapswipe.shared_write', true);
  perform set_config('tapswipe.shared_write', 'on', true);

  update rep_payout_rows
     set rep_split_pct = new.rep_split_pct
   where rep_share_id = new.rep_share_id
     and period = new.period
     and share_role = 'secondary'
     and rep_split_pct is distinct from new.rep_split_pct;

  perform set_config('tapswipe.shared_write', coalesce(previous, ''), true);
  return null;
end;
$$;

revoke all on function copy_signer_rate_to_partner() from public;

create trigger rep_payout_rows_copy_signer_rate
  after update of rep_split_pct on rep_payout_rows
  for each row
  when (new.share_role = 'primary'
        and new.rep_split_pct is distinct from old.rep_split_pct)
  execute function copy_signer_rate_to_partner();

-- 7. set_shared_residual(): the one write path for a shared pair's residual.
-- Security definer with a hand-written is_admin() guard; the same advisory
-- lock as the share RPCs. NULL clears both pieces ("not worked out yet").
-- No audit_log row: log_payout_row_change() records each line's old and new
-- residual, attributed to the admin, which is the granularity the residual
-- module already chose.
create or replace function set_shared_residual(
  rep_share_id_input int,
  period_input       date,
  amount_input       numeric
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  primaries   int;
  secondaries int;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  if rep_share_id_input is null or period_input is null then
    raise exception 'A share and a month are required.' using errcode = '22023';
  end if;

  if amount_input is not null and amount_input <> round(amount_input, 2) then
    raise exception 'The account residual must be in whole cents.'
      using errcode = '22023';
  end if;

  perform 1 from rep_payout_rows
   where rep_share_id = rep_share_id_input and period = period_input
   for update;

  select count(*) filter (where share_role = 'primary'),
         count(*) filter (where share_role = 'secondary')
    into primaries, secondaries
    from rep_payout_rows
   where rep_share_id = rep_share_id_input and period = period_input;

  if primaries <> 1 or secondaries <> 1 then
    raise exception 'There is no shared pair for that share in that month.'
      using errcode = 'PT404';
  end if;

  perform set_config('tapswipe.shared_write', 'on', true);

  update rep_payout_rows
     set account_residual_income = amount_input,
         residual_income = case share_role
           when 'secondary' then
             shared_part(amount_input, secondary_rep_pct,
                         primary_rep_pct + secondary_rep_pct)
           else
             amount_input
             - shared_part(amount_input, secondary_rep_pct,
                           primary_rep_pct + secondary_rep_pct)
         end
   where rep_share_id = rep_share_id_input and period = period_input;

  perform set_config('tapswipe.shared_write', '', true);
end;
$$;

revoke all on function set_shared_residual(int, date, numeric) from public;
grant execute on function set_shared_residual(int, date, numeric)
  to authenticated, service_role;

-- =====================================================================
-- IMPORT LINES ONLY, UNTIL PHASE 5 (20261014150000).
--
-- The adjustment branch of rep_payout exists (20261014140000) so the column is
-- rewritten once, but NO ROW MAY BE AN ADJUSTMENT LINE YET. The merge key is
-- still the ordinary unique (period, agent_id, mid), so an adjustment posted
-- on a MID that already has an import line in the same month would collide
-- with it -- or, worse, be silently merged into it by the commit's
-- `on conflict (period, agent_id, mid) do update`, overwriting the file-
-- sourced columns of a line nobody meant to touch. Phase 5 swaps that key for
-- `unique (period, agent_id, mid) where line_kind = 'import'` and DROPS THIS
-- CONSTRAINT IN THE SAME MIGRATION; never one without the other.
--
-- The guard (guard_shared_line) already refuses turning an existing line into
-- an adjustment by UPDATE. This covers INSERT, which the guard does not see --
-- the commit runs as definer and the service role holds every privilege, so a
-- constraint is the one layer every writer meets.
--
-- Validated, not NOT VALID: line_kind arrived in 20261014140000 with the
-- constant default 'import' and that migration checks every existing row is
-- 'import', so there is nothing it could fail on.
--
-- Until then the adjustment branch is exercised against a scratch table built
-- from the migration's own expression text (tests/rls/shared-lines.test.ts).
-- =====================================================================

alter table rep_payout_rows
  add constraint rep_payout_rows_import_lines_only
    check (line_kind = 'import');

-- =====================================================================
-- COMMIT V2 (20261016120000) — the shared-account-aware commit.
-- Phase 4 of docs/design/residual-splits.md, §5.1 and §5.4.
--
-- commit_residual_import_v2(batch_id_input int) returns jsonb
--   {"written": n, "skipped": m}, and n + m is the number of staged rows.
--
-- A NEW FUNCTION BESIDE THE OLD ONE, not a replacement. create or replace
-- cannot change a return type (int -> jsonb), and the old name must keep
-- working for an app version still deployed somewhere. The app switches to
-- v2 in phase 4b; the old function is dropped in phase 9, once the three
-- conditions in design §5.1 hold.
--
-- FOR A BATCH WITH NO SHARED ACCOUNT, v2 IS THE OLD COMMIT. Same guards in the
-- same order and with the same messages, the same `for update` on the batch,
-- the same upsert -- its text is the old statement's plus ONE predicate that
-- keeps shared and skipped rows out of it -- the same staging delete, status
-- flip and row_count, and the same single audit row, deliberately under the
-- same action name: it is the same event, and an audit reader filtering on
-- 'commit_residual_import' must not lose commits made through v2. `written` is
-- the old function's return value. tests/rls/commit-residual-import-v2.test.ts
-- runs one sequence of batches through both and requires identical ledger,
-- history, audit and batch rows.
--
-- WHAT IT ADDS. After the old guards and the batch lock it takes the share
-- lock -- pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares')),
-- the lock every share RPC and set_shared_residual take -- and only then reads
-- merchant_rep_shares. A share edit and a commit therefore cannot interleave:
-- whichever starts second waits, then sees the other's committed state. (A
-- share RPC refuses a boundary at or before a committed month, so a share
-- started while a commit waited on the lock is refused for that month rather
-- than left disagreeing with it.) PGlite is a single connection, so this was
-- checked by hand against real Postgres with two psql sessions.
--
-- Each staged row is then planned, once, into a temp table, before anything
-- is written -- so no row's plan depends on another row's write:
--
--   ordinary  no share covers this MID in this month, OR the file names a
--             rep outside the pair. Through the old upsert, unchanged. (The
--             third-rep case is "share not applied" -- flagged at preview,
--             phase 4b, and imported for the rep the file names.)
--   shared    the file names the SIGNER. Two lines: the signer's, upserted
--             with the file's own columns, and the partner's, inserted.
--   skipped   recorded on the batch, never silently dropped:
--     partner_named    the file names the PARTNER. That key, (month,
--                      partner, MID), belongs to the partner's shared line
--                      whether or not the pair exists yet; importing the row
--                      as an ordinary line would break the pair the first
--                      time the signer's row arrived.
--     line_not_shared  either key of the pair already holds a line that is
--                      not this share's line in that role. The month rule
--                      makes that unreachable through the RPCs (a share can
--                      only start after the MID's last committed month), so
--                      it means a hand-made or old-commit line -- and
--                      building half a pair on it would be worse than
--                      skipping the row.
--
-- "Covers" means: the share on the merchant whose CURRENT merchants.mid is the
-- row's MID, with period in [effective_from, effective_to). Commit is
-- authoritative; a preview is advisory, and a share can change between them.
--
-- THE SHARED LINES, FIRST COMMIT. Signer: merchant name, merchant id, volume,
-- average ticket, total cost and batch from the file; the share snapshot.
-- Partner: the same merchant name and id, NO volume, average ticket or total
-- cost (the account's volume is counted once, on the signer's line), the same
-- snapshot. Residual and rate are NULL on both -- "not worked out yet" -- and
-- are set afterwards by set_shared_residual() and an edit of the signer's
-- rate, which copies itself across. A residual or rate the FILE supplies for
-- a shared line is IGNORED, on first commit and on re-import alike (design
-- Q11; the preview flags it in phase 4b): those figures describe one rep's
-- line and there is no single line here for them to describe.
--
-- If the partner's line has gone missing while the signer's survives (an
-- admin may delete a line), it is re-created from the signer's line -- its
-- account residual, its piece of it, and the signer's rate -- so the pair is
-- whole again rather than permanently half.
--
-- RE-IMPORT NEVER OVERWRITES A DIVIDED LINE (design §5.3, requirement R-1).
-- On conflict only the SIGNER line's file columns are updated (merchant name,
-- merchant id, volume, average ticket, total cost, batch). residual_income,
-- account_residual_income, rep_split_pct and every share column are never
-- written on conflict, on either line, and the partner's insert is `do
-- nothing`. This is the shared counterpart of THE COALESCE above, and like it,
-- its reversal would be quiet for the rate: guard_shared_line() refuses a
-- write to either residual piece, but it ADMITS a change to the signer's rate
-- -- that is the sanctioned edit -- and the rate-copy trigger would then carry
-- a file's figure onto the partner too. The test reverts this rule and
-- watches R-1 go red.
--
-- SKIPPED ROWS are stored on the batch before the staging rows are deleted:
-- rep_payout_batches.skipped_rows, a jsonb array of
--   {row_number, period, mid, agent_number, reason}
-- in sheet-row order -- the memo's four keys plus period, because a batch is
-- not tied to one month and phase 4b lists skips on each period page. Only
-- identifiers already in the admin's own file; no figure, no name. An admin
-- acknowledges them through acknowledge_residual_skips() (phase 4b), which
-- sets skips_acknowledged_at; NULL there with a non-empty array means a skip
-- nobody has reviewed yet. The column is admin-only like the rest of the
-- batch (select policy is_admin()); narrowing the batch UPDATE grant to
-- (status), so an admin's PATCH cannot clear a skip record, is phase 4b's,
-- with the acknowledgement it protects.
--
-- `security definer` for the old function's three reasons (no INSERT policy
-- on the ledger, no DELETE on staging, no INSERT on audit_log at all), with a
-- hand-written is_admin() guard as the first statement and search_path
-- pinned. The temp table is pg_temp-qualified on create and drop, so the drop
-- can never reach a table in public.
-- =====================================================================

alter table rep_payout_batches
  add column skipped_rows jsonb not null default '[]'::jsonb,
  add column skips_acknowledged_at timestamptz;

alter table rep_payout_batches
  add constraint rep_payout_batches_skipped_rows_array
    check (jsonb_typeof(skipped_rows) = 'array');

-- ---------------------------------------------------------------------
-- The old commit, re-created with ONE guard (design §5.1): a batch that
-- contains a row a share covers is refused, so an app still calling this
-- name can never write a shared MID as one ordinary signer line -- the one
-- outcome the shared-account design exists to prevent. The guard takes the
-- same share lock as v2 before it looks, so a share created while this commit
-- runs either waits for it (and is then refused for the committed month) or
-- is seen by it. Everything else is byte-for-byte the previous body, comments
-- included; with no shares it behaves exactly as before, and
-- tests/rls/commit-residual-import.test.ts runs against it unchanged.
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

  -- THE SHARE GUARD (20261016120000), the one addition.
  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  if exists (
    select 1
      from rep_payout_import_rows r
      join merchants m on m.mid = r.mid_raw
      join merchant_rep_shares s
        on s.merchant_id = m.id
       and r.period >= s.effective_from
       and (s.effective_to is null or r.period < s.effective_to)
     where r.batch_id = batch_id_input
  ) then
    raise exception 'This import contains shared accounts. Reload the page to commit it.'
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

-- ---------------------------------------------------------------------
-- commit_residual_import_v2. See the header of this block.
-- ---------------------------------------------------------------------
create or replace function commit_residual_import_v2(batch_id_input int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  batch       rep_payout_batches;
  blocked     int;
  staged      int;
  ordinary    int;
  shared      int;
  skipped     int;
  skip_record jsonb;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  -- The old function's guards, in its order, with its messages.
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

  -- 1. The share lock, before merchant_rep_shares is read.
  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  -- 2. The plan: every staged row, its share (if one covers it), and what
  -- happens to it. Taken before any write.
  drop table if exists pg_temp.residual_commit_plan;

  create temporary table residual_commit_plan on commit drop as
  select r.id as staging_id,
         r.row_number,
         r.period,
         r.mid_raw,
         r.agent_number_raw,
         s.id as share_id,
         s.secondary_agent_id,
         s.primary_rep_pct,
         s.secondary_rep_pct,
         case
           when s.id is null then 'ordinary'
           when r.agent_id = s.secondary_agent_id then 'partner_named'
           when r.agent_id <> s.primary_agent_id then 'ordinary'
           when exists (
             select 1 from rep_payout_rows l
              where l.period = r.period
                and l.mid = r.mid_raw
                and l.agent_id in (s.primary_agent_id, s.secondary_agent_id)
                and (l.rep_share_id is distinct from s.id
                     or l.share_role is distinct from
                        case when l.agent_id = s.primary_agent_id
                             then 'primary' else 'secondary' end)
           ) then 'line_not_shared'
           else 'shared'
         end as plan
    from rep_payout_import_rows r
    left join merchants m on m.mid = r.mid_raw
    left join merchant_rep_shares s
      on s.merchant_id = m.id
     and r.period >= s.effective_from
     and (s.effective_to is null or r.period < s.effective_to)
   where r.batch_id = batch_id_input;

  -- 3. Ordinary rows: the old upsert, with one predicate added.
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
     and r.id in (select p.staging_id from pg_temp.residual_commit_plan p
                   where p.plan = 'ordinary')
  on conflict (period, agent_id, mid) do update set
    merchant_name   = excluded.merchant_name,
    merchant_id     = excluded.merchant_id,
    volume          = excluded.volume,
    average_ticket  = excluded.average_ticket,
    total_cost      = excluded.total_cost,
    -- THE COALESCE. Kept, not cleared, unless the file said otherwise.
    residual_income = coalesce(excluded.residual_income,
                               rep_payout_rows.residual_income),
    rep_split_pct   = coalesce(excluded.rep_split_pct,
                               rep_payout_rows.rep_split_pct),
    batch_id        = excluded.batch_id;

  get diagnostics ordinary = row_count;

  -- 4a. Shared rows, the signer's line. The file's residual and rate are not
  -- read: NULL on insert, and on conflict only the file columns are written.
  insert into rep_payout_rows (
    agent_id, period, mid, merchant_name, merchant_id,
    volume, average_ticket, total_cost,
    residual_income, rep_split_pct, batch_id,
    rep_share_id, share_role, primary_rep_pct, secondary_rep_pct,
    account_residual_income
  )
  select
    r.agent_id, r.period, r.mid_raw, r.merchant_name_raw, r.merchant_id,
    r.volume, r.average_ticket, r.total_cost,
    null, null, batch_id_input,
    p.share_id, 'primary', p.primary_rep_pct, p.secondary_rep_pct,
    null
    from rep_payout_import_rows r
    join pg_temp.residual_commit_plan p on p.staging_id = r.id
   where r.batch_id = batch_id_input
     and p.plan = 'shared'
  on conflict (period, agent_id, mid) do update set
    -- NEVER THE MONEY ON CONFLICT (design §5.3). File columns only.
    merchant_name   = excluded.merchant_name,
    merchant_id     = excluded.merchant_id,
    volume          = excluded.volume,
    average_ticket  = excluded.average_ticket,
    total_cost      = excluded.total_cost,
    batch_id        = excluded.batch_id;

  get diagnostics shared = row_count;

  -- 4b. The partner's line, from the signer's line as it now stands: on a
  -- first commit that carries no figures; if only the partner's line was
  -- missing, it is rebuilt from the signer's account figure and rate.
  insert into rep_payout_rows (
    agent_id, period, mid, merchant_name, merchant_id,
    volume, average_ticket, total_cost,
    residual_income, rep_split_pct, batch_id,
    rep_share_id, share_role, primary_rep_pct, secondary_rep_pct,
    account_residual_income
  )
  select
    p.secondary_agent_id, sl.period, sl.mid, sl.merchant_name, sl.merchant_id,
    null, null, null,
    shared_part(sl.account_residual_income, sl.secondary_rep_pct,
                sl.primary_rep_pct + sl.secondary_rep_pct),
    sl.rep_split_pct, batch_id_input,
    sl.rep_share_id, 'secondary', sl.primary_rep_pct, sl.secondary_rep_pct,
    sl.account_residual_income
    from pg_temp.residual_commit_plan p
    join rep_payout_import_rows r on r.id = p.staging_id
    join rep_payout_rows sl
      on sl.period = p.period
     and sl.agent_id = r.agent_id
     and sl.mid = p.mid_raw
     and sl.rep_share_id = p.share_id
     and sl.share_role = 'primary'
   where p.plan = 'shared'
  on conflict (period, agent_id, mid) do nothing;

  -- 5. What was not applied, kept on the batch.
  select count(*),
         coalesce(jsonb_agg(jsonb_build_object(
                    'row_number',   p.row_number,
                    'period',       to_char(p.period, 'YYYY-MM-DD'),
                    'mid',          p.mid_raw,
                    'agent_number', p.agent_number_raw,
                    'reason',       p.plan)
                  order by p.row_number), '[]'::jsonb)
    into skipped, skip_record
    from pg_temp.residual_commit_plan p
   where p.plan in ('partner_named', 'line_not_shared');

  drop table pg_temp.residual_commit_plan;

  -- 6. As the old function: staging delete, status flip, one audit row.
  delete from rep_payout_import_rows where batch_id = batch_id_input;

  update rep_payout_batches
     set status = 'committed', committed_at = now(), row_count = staged,
         skipped_rows = skip_record
   where id = batch_id_input;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'commit_residual_import', 'rep_payout_batches',
          batch_id_input::text);

  return jsonb_build_object('written', ordinary + shared, 'skipped', skipped);
end;
$$;

revoke all on function commit_residual_import_v2(int) from public;
grant execute on function commit_residual_import_v2(int) to authenticated, service_role;

-- =====================================================================
-- COMMIT V2, THE APP HALF (20261016140000) — preview flags, acknowledging
-- skipped rows, and the batch UPDATE grant narrowed to (status).
-- Phase 4b of docs/design/residual-splits.md, §5.4 and §7.
--
-- PREVIEW FLAGS ON THE STAGING ROW. parse-residual-import now works out, for
-- each resolved row, what commit_residual_import_v2 would do with it about a
-- shared account, and stores the answer beside the blocker:
--
--   preview_flag       share_not_applied  the file names a rep outside the
--                                         pair; the row imports as an
--                                         ordinary line for that rep and the
--                                         share pays nothing on it
--                      partner_named      the file names the PARTNER; v2 will
--                                         skip the row
--                      line_not_shared    the file names the signer but a key
--                                         of the pair already holds a line
--                                         that is not this share's; v2 will
--                                         skip the row
--   preview_note       the sentence the review screen shows, written by the
--                      function because it is the one place holding the
--                      pair's names (the `error` column's arrangement).
--
-- The codes are v2's own plan names, so a flag and the skip it predicts read
-- the same. A FLAG IS NEVER A BLOCKER: a flagged row still counts as ready,
-- and commit recomputes everything from the shares in force at commit (a
-- share can change between parse and commit -- the preview is advisory, the
-- commit authoritative). No CHECK ties a flag to a blocker, because a blocked
-- row is simply never flagged (the function flags only resolved rows).
--
-- The other four flags of design §7 (shared figures ignored, non-standard
-- rate, deactivated partner, looks shared) are deferred to phase 5; the
-- vocabulary is a CHECK so adding them is a deliberate migration.
--
-- acknowledge_residual_skips(batch_id_input int) returns timestamptz.
-- The button under the skipped-rows Callout. Sets skips_acknowledged_at on a
-- COMMITTED batch whose skipped_rows is non-empty, writes one audit_log row
-- (action 'acknowledge_residual_skips', row_id the batch id) and returns the
-- timestamp. Who acknowledged lives in audit_log and nowhere else: a
-- skips_acknowledged_by column would be a twenty-sixth profiles FK and one
-- more entry in every teardown list.
--
-- Refuses, by name, PT409: a batch that is not committed (nothing has been
-- skipped yet), a batch with no skipped rows (there is nothing to review),
-- and a SECOND acknowledgement (the first is the record; a second would move
-- the timestamp and add an audit row claiming a review that changes nothing).
-- PT404 for a missing batch. The batch is read `for update`, so two admins
-- pressing the button at once produce one acknowledgement and one refusal,
-- not two audit rows.
--
-- `security definer` because there is no other way to the column: the
-- UPDATE grant below stops at (status), and audit_log has no INSERT for any
-- client. Hand-written is_admin() guard as the first statement -- before the
-- batch is read, so an agent gets 'admin only' for a real batch and a missing
-- one alike (no id oracle) -- and search_path pinned. The audit insert has no
-- exception block: it FAILS CLOSED, so an acknowledgement cannot be recorded
-- without its trail.
--
-- THE BATCH UPDATE GRANT NARROWS TO (status), in the GRANTS section. `grant select, update on
-- rep_payout_batches` let an admin's session PATCH any column, so the skip
-- record this phase exists to keep visible could be cleared from the
-- browser's console -- skipped_rows set to '[]', or skips_acknowledged_at
-- set without an audit row. The one client writer is abandonResidualBatch()
-- (lib/residual-batches.ts), which writes status alone. Every other writer
-- is the service role (residual-import-file-url: file_key, status;
-- parse-residual-import: row_count) or a definer function (both commits,
-- this one), and a grant reaches none of them. The 20260812143407 lesson
-- again: a column the grant refuses is a loud 42501, where a policy can only
-- filter rows.
--
-- THE OLD COMMIT'S GUARD MESSAGE, reworded. It said "Reload the page to
-- commit it." -- untrue: the only caller that can reach it is an app version
-- that predates v2, and reloading that app calls the same function again.
-- The function is otherwise the 20261016120000 body, unchanged.
-- =====================================================================

alter table rep_payout_import_rows
  add column preview_flag text
    check (preview_flag in ('share_not_applied', 'partner_named', 'line_not_shared')),
  add column preview_note text;

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

  -- THE SHARE GUARD (20261016120000), the one addition. Message reworded in
  -- 20261016140000: only an app version older than v2 reaches this.
  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  if exists (
    select 1
      from rep_payout_import_rows r
      join merchants m on m.mid = r.mid_raw
      join merchant_rep_shares s
        on s.merchant_id = m.id
       and r.period >= s.effective_from
       and (s.effective_to is null or r.period < s.effective_to)
     where r.batch_id = batch_id_input
  ) then
    raise exception 'This import contains shared accounts, which this version of the CRM cannot commit. It needs the current version of the app.'
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

create or replace function acknowledge_residual_skips(batch_id_input int)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  batch rep_payout_batches;
  stamp timestamptz := now();
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  select * into batch from rep_payout_batches where id = batch_id_input for update;
  if not found then
    raise exception 'import not found' using errcode = 'PT404';
  end if;

  if batch.status <> 'committed' then
    raise exception 'this import is %, so nothing has been skipped yet', batch.status
      using errcode = 'PT409';
  end if;

  if jsonb_array_length(batch.skipped_rows) = 0 then
    raise exception 'this import skipped no rows' using errcode = 'PT409';
  end if;

  if batch.skips_acknowledged_at is not null then
    raise exception 'these skipped rows have already been reviewed'
      using errcode = 'PT409';
  end if;

  update rep_payout_batches
     set skips_acknowledged_at = stamp
   where id = batch_id_input;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'acknowledge_residual_skips', 'rep_payout_batches',
          batch_id_input::text);

  return stamp;
end;
$$;

revoke all on function acknowledge_residual_skips(int) from public;
grant execute on function acknowledge_residual_skips(int) to authenticated, service_role;

-- =====================================================================
-- IMPORT MERGE KEY (20261016160000) — the ledger's merge key becomes a
-- partial unique index over IMPORT lines, so adjustment lines can exist.
-- Phase 5 of docs/design/residual-splits.md, §3.2, §5.1 and §6.
--
-- Until now the merge key was the ordinary `unique (period, agent_id, mid)`,
-- and rep_payout_rows_import_lines_only (20261014150000) refused every
-- adjustment line, because an adjustment posted on a MID that already had an
-- import line in the same month would have collided with it -- or been
-- merged into it by a commit's `on conflict ... do update`. This migration
-- does the three things that must happen together, and drops that constraint
-- in the same transaction; never one without the others:
--
--   1. THE KEY. The constraint rep_payout_rows_period_agent_id_mid_key is
--      dropped and replaced by
--        rep_payout_rows_import_merge_key
--          unique (period, agent_id, mid) where line_kind = 'import'
--      Import lines keep exactly the key they had; adjustment lines are
--      outside it and may share a key with an import line or with each other.
--      Plus idx_rep_payout_rows_period_agent on (period, agent_id): the planner
--      cannot use a partial index for a bare `where period = $1` (it does not
--      imply the predicate), and the old constraint's index served every
--      period page.
--   2. EVERY ON CONFLICT NAMES THE PREDICATE. Postgres infers a partial
--      unique index as an arbiter only when the statement says
--      `on conflict (period, agent_id, mid) where line_kind = 'import'`; with
--      no WHERE the statement fails with "no unique or exclusion constraint
--      matching the ON CONFLICT specification". So both commit functions are
--      re-created with that one change to each target (old: 1, v2: 3) --
--      THE COALESCE and "never the money on conflict" are byte-identical --
--      and the inserted rows are import lines by the column default, so the
--      arbiter can only ever be an import line: a re-import never merges into
--      an adjustment, and nothing can merge an adjustment into an import line.
--   3. EVERY "IS THIS MONTH COMMITTED" READ LOOKS AT IMPORT LINES ONLY. An
--      adjustment sits in a month nobody has committed yet (post_share_
--      correction, 20261016161000), so it must not make that month look
--      committed:
--        * v2's plan: `line_not_shared` asks whether a key of the pair already
--          holds a line that is not this share's. An adjustment on the
--          signer's key (rep_share_id NULL) would have answered yes and
--          skipped the signer row of the very month the correction was posted
--          into. It now asks about import lines only.
--        * set_merchant_rep_share, end_merchant_rep_share and
--          cancel_merchant_rep_share refuse a boundary at or before the MID's
--          latest committed month. Counting an adjustment would refuse the
--          share the correction is posted alongside (design §6: "usually
--          called alongside set_merchant_rep_share"), starting in the very
--          month the correction landed in. Each is re-created with
--          `and line_kind = 'import'` on that read and nothing else.
--
-- Plus one constraint the adjustment line needs now that it can exist:
-- rep_payout_rows_adjustment_no_figures. An adjustment line carries its
-- amount in adjustment_amount and NOTHING in residual_income, rep_split_pct,
-- volume, average_ticket, total_cost or batch_id. Its rep_payout is the
-- amount whatever those say, so a residual or rate on it would be counted
-- in the period's Residual income total while paying nothing, and the
-- grant does let an admin's session write those two columns. It also makes
-- PayoutBulkSplit's period-wide update fail loudly on an adjustment rather
-- than quietly stamp a rate on it -- which is why that component now filters
-- to import lines.
--
-- NOTHING MOVED, OR NOTHING COMMITS. The swap rewrites no row, but the claim
-- is checked rather than assumed: (id, rep_payout, period, agent_id, mid) of
-- every line is copied to a temp table first, and at the end of the file the
-- row count, the payout total and an md5 over every row's five values must
-- match the copy exactly, or the migration raises and everything above rolls
-- back. The message names which check failed, never a figure. The copy is
-- dropped before the end. tests/rls/import-merge-key.test.ts breaks it on
-- purpose three ways -- a row deleted, a payout changed, two MIDs swapped
-- (count and total unchanged) -- and requires the migration to refuse each.
--
-- PRECONDITION: the constraint being dropped must be exactly
-- `UNIQUE (period, agent_id, mid)` under its default name. A hosted project
-- whose key was hand-altered refuses rather than losing something quietly.
-- =====================================================================

-- 0. Precondition, then the copy every existing line is checked against.
do $$
declare
  definition text;
begin
  select pg_get_constraintdef(oid) into definition
    from pg_constraint
   where conrelid = 'public.rep_payout_rows'::regclass
     and conname = 'rep_payout_rows_period_agent_id_mid_key';

  if definition is distinct from 'UNIQUE (period, agent_id, mid)' then
    raise exception 'rep_payout_rows_period_agent_id_mid_key is not UNIQUE (period, agent_id, mid) here (found: %). Inspect it before applying 20261016160000.',
      coalesce(definition, 'no such constraint');
  end if;
end $$;

create temp table rep_payout_merge_key_before on commit drop as
  select id, rep_payout, period, agent_id, mid from rep_payout_rows;

-- 1. The key: a partial unique index over import lines, and a plain index for
-- the period reads the old constraint's index served.
alter table rep_payout_rows
  drop constraint rep_payout_rows_period_agent_id_mid_key;

create unique index rep_payout_rows_import_merge_key
  on rep_payout_rows (period, agent_id, mid)
  where line_kind = 'import';

create index idx_rep_payout_rows_period_agent
  on rep_payout_rows (period, agent_id);

-- 2. Adjustment lines may exist now; an adjustment carries no figures.
alter table rep_payout_rows
  drop constraint rep_payout_rows_import_lines_only;

alter table rep_payout_rows
  add constraint rep_payout_rows_adjustment_no_figures check (
    line_kind = 'import'
    or (residual_income is null and rep_split_pct is null
        and volume is null and average_ticket is null
        and total_cost is null and batch_id is null)
  );

-- 3. Both commit functions, with the predicate on every conflict target and
-- v2's line_not_shared reading import lines only. Otherwise the bodies of
-- 20261016140000 (old) and 20261016120000 (v2), unchanged.

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

  -- THE SHARE GUARD (20261016120000), the one addition. Message reworded in
  -- 20261016140000: only an app version older than v2 reaches this.
  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  if exists (
    select 1
      from rep_payout_import_rows r
      join merchants m on m.mid = r.mid_raw
      join merchant_rep_shares s
        on s.merchant_id = m.id
       and r.period >= s.effective_from
       and (s.effective_to is null or r.period < s.effective_to)
     where r.batch_id = batch_id_input
  ) then
    raise exception 'This import contains shared accounts, which this version of the CRM cannot commit. It needs the current version of the app.'
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
  on conflict (period, agent_id, mid) where line_kind = 'import' do update set
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

create or replace function commit_residual_import_v2(batch_id_input int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  batch       rep_payout_batches;
  blocked     int;
  staged      int;
  ordinary    int;
  shared      int;
  skipped     int;
  skip_record jsonb;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  -- The old function's guards, in its order, with its messages.
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

  -- 1. The share lock, before merchant_rep_shares is read.
  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  -- 2. The plan: every staged row, its share (if one covers it), and what
  -- happens to it. Taken before any write.
  drop table if exists pg_temp.residual_commit_plan;

  create temporary table residual_commit_plan on commit drop as
  select r.id as staging_id,
         r.row_number,
         r.period,
         r.mid_raw,
         r.agent_number_raw,
         s.id as share_id,
         s.secondary_agent_id,
         s.primary_rep_pct,
         s.secondary_rep_pct,
         case
           when s.id is null then 'ordinary'
           when r.agent_id = s.secondary_agent_id then 'partner_named'
           when r.agent_id <> s.primary_agent_id then 'ordinary'
           when exists (
             select 1 from rep_payout_rows l
              where l.period = r.period
                and l.mid = r.mid_raw
                and l.line_kind = 'import'
                and l.agent_id in (s.primary_agent_id, s.secondary_agent_id)
                and (l.rep_share_id is distinct from s.id
                     or l.share_role is distinct from
                        case when l.agent_id = s.primary_agent_id
                             then 'primary' else 'secondary' end)
           ) then 'line_not_shared'
           else 'shared'
         end as plan
    from rep_payout_import_rows r
    left join merchants m on m.mid = r.mid_raw
    left join merchant_rep_shares s
      on s.merchant_id = m.id
     and r.period >= s.effective_from
     and (s.effective_to is null or r.period < s.effective_to)
   where r.batch_id = batch_id_input;

  -- 3. Ordinary rows: the old upsert, with one predicate added.
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
     and r.id in (select p.staging_id from pg_temp.residual_commit_plan p
                   where p.plan = 'ordinary')
  on conflict (period, agent_id, mid) where line_kind = 'import' do update set
    merchant_name   = excluded.merchant_name,
    merchant_id     = excluded.merchant_id,
    volume          = excluded.volume,
    average_ticket  = excluded.average_ticket,
    total_cost      = excluded.total_cost,
    -- THE COALESCE. Kept, not cleared, unless the file said otherwise.
    residual_income = coalesce(excluded.residual_income,
                               rep_payout_rows.residual_income),
    rep_split_pct   = coalesce(excluded.rep_split_pct,
                               rep_payout_rows.rep_split_pct),
    batch_id        = excluded.batch_id;

  get diagnostics ordinary = row_count;

  -- 4a. Shared rows, the signer's line. The file's residual and rate are not
  -- read: NULL on insert, and on conflict only the file columns are written.
  insert into rep_payout_rows (
    agent_id, period, mid, merchant_name, merchant_id,
    volume, average_ticket, total_cost,
    residual_income, rep_split_pct, batch_id,
    rep_share_id, share_role, primary_rep_pct, secondary_rep_pct,
    account_residual_income
  )
  select
    r.agent_id, r.period, r.mid_raw, r.merchant_name_raw, r.merchant_id,
    r.volume, r.average_ticket, r.total_cost,
    null, null, batch_id_input,
    p.share_id, 'primary', p.primary_rep_pct, p.secondary_rep_pct,
    null
    from rep_payout_import_rows r
    join pg_temp.residual_commit_plan p on p.staging_id = r.id
   where r.batch_id = batch_id_input
     and p.plan = 'shared'
  on conflict (period, agent_id, mid) where line_kind = 'import' do update set
    -- NEVER THE MONEY ON CONFLICT (design §5.3). File columns only.
    merchant_name   = excluded.merchant_name,
    merchant_id     = excluded.merchant_id,
    volume          = excluded.volume,
    average_ticket  = excluded.average_ticket,
    total_cost      = excluded.total_cost,
    batch_id        = excluded.batch_id;

  get diagnostics shared = row_count;

  -- 4b. The partner's line, from the signer's line as it now stands: on a
  -- first commit that carries no figures; if only the partner's line was
  -- missing, it is rebuilt from the signer's account figure and rate.
  insert into rep_payout_rows (
    agent_id, period, mid, merchant_name, merchant_id,
    volume, average_ticket, total_cost,
    residual_income, rep_split_pct, batch_id,
    rep_share_id, share_role, primary_rep_pct, secondary_rep_pct,
    account_residual_income
  )
  select
    p.secondary_agent_id, sl.period, sl.mid, sl.merchant_name, sl.merchant_id,
    null, null, null,
    shared_part(sl.account_residual_income, sl.secondary_rep_pct,
                sl.primary_rep_pct + sl.secondary_rep_pct),
    sl.rep_split_pct, batch_id_input,
    sl.rep_share_id, 'secondary', sl.primary_rep_pct, sl.secondary_rep_pct,
    sl.account_residual_income
    from pg_temp.residual_commit_plan p
    join rep_payout_import_rows r on r.id = p.staging_id
    join rep_payout_rows sl
      on sl.period = p.period
     and sl.agent_id = r.agent_id
     and sl.mid = p.mid_raw
     and sl.rep_share_id = p.share_id
     and sl.share_role = 'primary'
   where p.plan = 'shared'
  on conflict (period, agent_id, mid) where line_kind = 'import' do nothing;

  -- 5. What was not applied, kept on the batch.
  select count(*),
         coalesce(jsonb_agg(jsonb_build_object(
                    'row_number',   p.row_number,
                    'period',       to_char(p.period, 'YYYY-MM-DD'),
                    'mid',          p.mid_raw,
                    'agent_number', p.agent_number_raw,
                    'reason',       p.plan)
                  order by p.row_number), '[]'::jsonb)
    into skipped, skip_record
    from pg_temp.residual_commit_plan p
   where p.plan in ('partner_named', 'line_not_shared');

  drop table pg_temp.residual_commit_plan;

  -- 6. As the old function: staging delete, status flip, one audit row.
  delete from rep_payout_import_rows where batch_id = batch_id_input;

  update rep_payout_batches
     set status = 'committed', committed_at = now(), row_count = staged,
         skipped_rows = skip_record
   where id = batch_id_input;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'commit_residual_import', 'rep_payout_batches',
          batch_id_input::text);

  return jsonb_build_object('written', ordinary + shared, 'skipped', skipped);
end;
$$;

revoke all on function commit_residual_import_v2(int) from public;
grant execute on function commit_residual_import_v2(int) to authenticated, service_role;

-- 4. The three share RPCs, with their "latest committed month" read
-- restricted to import lines. Otherwise the bodies of 20261014130000,
-- unchanged, comments included.

-- set_merchant_rep_share: start a share from a month. If an open share
-- exists on the merchant and started earlier, it is ended at that month in the
-- same transaction -- so "change the ratio from November" is one call, and the
-- table reads as the history of the account.
create or replace function set_merchant_rep_share(
  merchant_id_input        int,
  primary_agent_id_input   uuid,
  secondary_agent_id_input uuid,
  primary_rep_pct_input    numeric,
  secondary_rep_pct_input  numeric,
  effective_from_input     date
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  m          merchants;
  rep        profiles;
  latest     date;
  open_share merchant_rep_shares;
  new_id     int;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  if merchant_id_input is null or primary_agent_id_input is null
     or secondary_agent_id_input is null or primary_rep_pct_input is null
     or secondary_rep_pct_input is null or effective_from_input is null then
    raise exception 'Every field is required to set a shared account.'
      using errcode = '22023';
  end if;

  select * into m from merchants where id = merchant_id_input;
  if not found then
    raise exception 'merchant not found' using errcode = 'PT404';
  end if;

  if m.mid is null or btrim(m.mid) = '' then
    raise exception 'This merchant has no MID, so no residual could ever match a share on it. Add the MID first.'
      using errcode = 'PT409';
  end if;

  if primary_agent_id_input = secondary_agent_id_input then
    raise exception 'The signer and the partner must be two different reps.'
      using errcode = '22023';
  end if;

  -- Both reps must exist and be active. A NEW share naming someone who has
  -- left is almost certainly a mistake (design §9, Q10); an existing share
  -- keeps paying a rep deactivated later, which is a different question.
  for rep in
    select * from profiles
     where id in (primary_agent_id_input, secondary_agent_id_input)
  loop
    if not rep.is_active then
      raise exception '% is deactivated, so a new share cannot name them.', rep.full_name
        using errcode = 'PT409';
    end if;
  end loop;
  if (select count(*) from profiles
       where id in (primary_agent_id_input, secondary_agent_id_input)) <> 2 then
    raise exception 'rep not found' using errcode = 'PT404';
  end if;

  if primary_rep_pct_input <> round(primary_rep_pct_input, 2)
     or secondary_rep_pct_input <> round(secondary_rep_pct_input, 2)
     or primary_rep_pct_input <= 0 or secondary_rep_pct_input <= 0
     or primary_rep_pct_input + secondary_rep_pct_input <> 50 then
    raise exception 'The two shares must each be above 0, in hundredths at most, and add up to the rep side: 50.'
      using errcode = '22023';
  end if;

  if extract(day from effective_from_input) <> 1 then
    raise exception 'A share starts on the first day of a month.'
      using errcode = '22023';
  end if;

  select max(period) into latest
    from rep_payout_rows
   where (merchant_id = m.id or mid = m.mid)
     and line_kind = 'import';

  if latest is not null and effective_from_input <= latest then
    raise exception '% is already committed for this MID. A share can only start after it; earlier months are corrected with an adjustment.',
      to_char(latest, 'FMMonth YYYY')
      using errcode = 'PT409';
  end if;

  select * into open_share
    from merchant_rep_shares
   where merchant_id = m.id and effective_to is null;

  if found then
    if open_share.effective_from >= effective_from_input then
      raise exception 'This merchant already has a share starting %. Cancel or end that one first.',
        to_char(open_share.effective_from, 'FMMonth YYYY')
        using errcode = 'PT409';
    end if;

    update merchant_rep_shares
       set effective_to = effective_from_input
     where id = open_share.id;

    insert into audit_log (actor_id, action, table_name, row_id)
    values (auth.uid(), 'end_merchant_rep_share', 'merchant_rep_shares',
            open_share.id::text);
  end if;

  -- Overlap with a share that is already closed but runs past the new start
  -- (one ended in the future). The new share is open-ended, so anything
  -- reaching past effective_from_input collides.
  if exists (
    select 1 from merchant_rep_shares
     where merchant_id = m.id
       and daterange(effective_from, effective_to)
           && daterange(effective_from_input, null)
  ) then
    raise exception 'That month overlaps another share on this merchant.'
      using errcode = 'PT409';
  end if;

  insert into merchant_rep_shares (
    merchant_id, primary_agent_id, secondary_agent_id,
    primary_rep_pct, secondary_rep_pct, effective_from
  )
  values (
    m.id, primary_agent_id_input, secondary_agent_id_input,
    primary_rep_pct_input, secondary_rep_pct_input, effective_from_input
  )
  returning id into new_id;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'set_merchant_rep_share', 'merchant_rep_shares',
          new_id::text);

  return new_id;
end;
$$;

revoke all on function set_merchant_rep_share(int, uuid, uuid, numeric, numeric, date)
  from public;
grant execute on function set_merchant_rep_share(int, uuid, uuid, numeric, numeric, date)
  to authenticated, service_role;

-- end_merchant_rep_share: the share stops applying FROM effective_to_input
-- (exclusive). Also moves an existing end, in either direction, provided both
-- the old and the new boundary are still in uncommitted months -- an end that a
-- committed month already sits on is settled.
create or replace function end_merchant_rep_share(
  share_id_input     int,
  effective_to_input date
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s      merchant_rep_shares;
  m      merchants;
  latest date;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  if share_id_input is null or effective_to_input is null then
    raise exception 'A share and an end month are required.'
      using errcode = '22023';
  end if;

  select * into s from merchant_rep_shares where id = share_id_input;
  if not found then
    raise exception 'share not found' using errcode = 'PT404';
  end if;

  if extract(day from effective_to_input) <> 1 then
    raise exception 'A share ends on the first day of a month.'
      using errcode = '22023';
  end if;

  if effective_to_input <= s.effective_from then
    raise exception 'A share has to end after the month it starts. To remove it entirely, cancel it.'
      using errcode = '22023';
  end if;

  select * into m from merchants where id = s.merchant_id;
  select max(period) into latest
    from rep_payout_rows
   where (merchant_id = m.id or mid = m.mid)
     and line_kind = 'import';

  if latest is not null and effective_to_input <= latest then
    raise exception '% is already committed for this MID. A share can only end after it.',
      to_char(latest, 'FMMonth YYYY')
      using errcode = 'PT409';
  end if;

  if latest is not null and s.effective_to is not null and s.effective_to <= latest then
    raise exception 'This share already ended before a committed month, so its end is settled.'
      using errcode = 'PT409';
  end if;

  if exists (
    select 1 from merchant_rep_shares
     where merchant_id = s.merchant_id
       and id <> s.id
       and daterange(effective_from, effective_to)
           && daterange(s.effective_from, effective_to_input)
  ) then
    raise exception 'That end month overlaps another share on this merchant.'
      using errcode = 'PT409';
  end if;

  update merchant_rep_shares
     set effective_to = effective_to_input
   where id = s.id;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'end_merchant_rep_share', 'merchant_rep_shares',
          s.id::text);
end;
$$;

revoke all on function end_merchant_rep_share(int, date) from public;
grant execute on function end_merchant_rep_share(int, date)
  to authenticated, service_role;

-- cancel_merchant_rep_share: deletes a share that was never used -- one with
-- no committed month inside it. Once any month in its range is committed, the
-- share is part of how that month was paid, and the answer is to end it.
-- (Phase 3 adds rep_payout_rows.rep_share_id ON DELETE RESTRICT as the
-- backstop; until then this check is the whole guard, and it is equivalent:
-- a line can only reference a share if its month falls inside it.)
create or replace function cancel_merchant_rep_share(share_id_input int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s      merchant_rep_shares;
  m      merchants;
  latest date;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  select * into s from merchant_rep_shares where id = share_id_input;
  if not found then
    raise exception 'share not found' using errcode = 'PT404';
  end if;

  select * into m from merchants where id = s.merchant_id;
  select max(period) into latest
    from rep_payout_rows
   where (merchant_id = m.id or mid = m.mid)
     and line_kind = 'import';

  if latest is not null and s.effective_from <= latest then
    raise exception 'A month in this share is already committed, so it cannot be cancelled. End it instead.'
      using errcode = 'PT409';
  end if;

  delete from merchant_rep_shares where id = s.id;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'cancel_merchant_rep_share', 'merchant_rep_shares',
          s.id::text);
end;
$$;

revoke all on function cancel_merchant_rep_share(int) from public;
grant execute on function cancel_merchant_rep_share(int)
  to authenticated, service_role;

-- 9. Nothing moved, to the cent and to the key, or nothing commits.
do $$
declare
  before_rows  bigint;
  after_rows   bigint;
  before_total numeric;
  after_total  numeric;
  before_md5   text;
  after_md5    text;
begin
  select count(*), sum(rep_payout),
         md5(coalesce(string_agg(
           id::text || ':' || coalesce(rep_payout::text, 'null') || ':' ||
           period::text || ':' || agent_id::text || ':' || mid,
           ',' order by id), ''))
    into before_rows, before_total, before_md5
    from rep_payout_merge_key_before;

  select count(*), sum(rep_payout),
         md5(coalesce(string_agg(
           id::text || ':' || coalesce(rep_payout::text, 'null') || ':' ||
           period::text || ':' || agent_id::text || ':' || mid,
           ',' order by id), ''))
    into after_rows, after_total, after_md5
    from rep_payout_rows;

  if before_rows is distinct from after_rows
     or before_total is distinct from after_total
     or before_md5 is distinct from after_md5 then
    raise exception 'merge key swap changed existing lines (rows % -> %, total %, per-row checksum %); rolled back',
      before_rows, after_rows,
      case when before_total is not distinct from after_total then 'matches' else 'DIFFERS' end,
      case when before_md5 = after_md5 then 'matches' else 'DIFFERS' end;
  end if;
end $$;

drop table rep_payout_merge_key_before;

-- =====================================================================
-- SHARE CORRECTIONS (20261016161000) — post_share_correction(), the two
-- phase-5 preview flags, and the count of adjustment rows a re-import
-- ignored. Phase 5 of docs/design/residual-splits.md, §6 and §7.
--
-- post_share_correction(merchant_id_input int, original_period_input date,
--                       partner_agent_id_input uuid,
--                       primary_rep_pct_input numeric,
--                       secondary_rep_pct_input numeric,
--                       note_input text) returns jsonb
--   {"posting_period": "YYYY-MM-DD", "amount": x,
--    "partner_line_id": n, "signer_line_id": m}
--
-- A SHARE AGREED AFTER ITS MONTH WAS COMMITTED. The month rule forbids
-- back-dating a share (design §3.5), so the money is moved instead, by an
-- adjustment PAIR posted in an open month. No committed line is edited.
--
--   1. The month being corrected must hold exactly one import line for the
--      merchant's MID -- the rep who was paid it, called the signer here --
--      and it must be an ordinary line (a shared month needs no correction)
--      whose payout is worked out: rep_payout NULL ("not worked out yet")
--      is refused, because there is nothing final to divide.
--   2. x = shared_part(T, secondary, primary + secondary), where T is that
--      line's rep_payout: the partner's part of T under exactly the cent rule
--      the shared lines use (design §4) -- the nearest cent, an exact
--      half-cent tie toward zero, odd in T, so a clawback month is shared in
--      the same ratio.
--   3. Two lines with line_kind 'adjustment', on the same MID, in the
--      POSTING MONTH: the partner's at +x and the signer's at -x, both with
--      adjusts_period = the corrected month and the admin's note.
--
--   THE PAIR NETS TO ZERO, so the company's 50% is untouched; the signer
--   keeps T - x and the partner receives x, across the two months, which is
--   exactly what the shared lines would have paid had the share existed
--   (signer T - x, partner x, summing to T). An x of $0.00 -- a T of zero,
--   or one too small to divide into a whole cent -- is refused: two
--   zero lines would record an agreement while moving nothing.
--
-- THE POSTING MONTH IS COMPUTED, NOT CHOSEN: the month after the latest
-- month holding ANY import line, across every MID. Payouts are paid per
-- month company-wide, so a month with any committed line counts as closed,
-- and an adjustment must never land in one. The caller does not pass it;
-- the function returns it. Posting again before the next month is
-- committed posts into the same month, which is fine: adjustment lines sit
-- outside the merge key (20261016160000). Once that month is committed the
-- adjustment is simply part of how it was paid.
--
-- Refused, by name (PT409 unless shown): a missing merchant or rep (PT404),
-- a merchant with no MID, a deactivated partner (as a new share would be,
-- design Q10), the partner being the signer (22023), no import line that
-- month (PT404), more than one, a shared month, a NULL payout, a zero x,
-- and a SECOND correction of the same MID and month -- a double click must
-- not pay twice, and the first correction is the record. Bad arguments are
-- 22023: any NULL, a blank note, a note over 500 characters, a month not on
-- the 1st, shares not each above 0 in hundredths summing to 50.
--
-- It does NOT create the share. Shares for future months are set the normal
-- way; the two calls are independent, and 20261016160000 made sure the
-- share RPCs do not mistake this function's lines for a committed month.
--
-- `security definer`: the ledger has no INSERT policy or grant, and
-- audit_log no INSERT for any client. Hand-written is_admin() guard as the
-- first statement, search_path pinned, and the share lock --
-- pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares')), which both
-- commits take -- so the "latest committed month" it reads cannot move under
-- it: a commit in flight is waited for, and its month is then closed. One
-- audit_log row, action 'post_share_correction', row_id the partner's line,
-- with no exception block: it FAILS CLOSED. No history row: history records
-- edits of the two typed figures, and an adjustment line has neither.
--
-- What reps see follows from RLS with no new policy: each rep reads their
-- own line of the pair, note included -- so the note is written for them.
--
-- PREVIEW FLAGS, two more (design §7; they widen the CHECK on
-- rep_payout_import_rows.preview_flag, and like the others never block):
--
--   share_not_in_force  a share exists on this MID's merchant but none covers
--                       the row's month (ended, or starts later). v2 imports
--                       the row as an ordinary line, paying the rep the file
--                       names the whole rep side -- silently, without this.
--   looks_shared        no share exists on the MID, and ANOTHER rep is paid
--                       on it within the six months before the row's month
--                       or in that month itself: a committed import line, or
--                       another row of this same file. Advisory and
--                       heuristic. The CRM owner (merchants.agent_id) is
--                       deliberately not a signal: it is often not the payee.
--
-- Precedence on a row, one flag at most: the three share flags first (a
-- share covers the month), then share_not_in_force, then looks_shared.
--
-- rep_payout_batches.adjustment_rows_ignored. The export marks adjustment
-- lines in a `Line` column, and parse-residual-import does NOT stage a row
-- marked `Adjustment`: re-imported, it would become an import line, or be
-- merged into one. The count is kept on the batch (written by the service
-- role; the authenticated UPDATE grant stops at status) so the review screen
-- can say "N adjustment lines ignored" after a reload.
-- =====================================================================

alter table rep_payout_import_rows
  drop constraint rep_payout_import_rows_preview_flag_check;

alter table rep_payout_import_rows
  add constraint rep_payout_import_rows_preview_flag_check check (
    preview_flag in ('share_not_applied', 'partner_named', 'line_not_shared',
                     'share_not_in_force', 'looks_shared')
  );

alter table rep_payout_batches
  add column adjustment_rows_ignored int not null default 0
    check (adjustment_rows_ignored >= 0);

create or replace function post_share_correction(
  merchant_id_input       int,
  original_period_input   date,
  partner_agent_id_input  uuid,
  primary_rep_pct_input   numeric,
  secondary_rep_pct_input numeric,
  note_input              text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  m           merchants;
  partner     profiles;
  signer      rep_payout_rows;
  note        text := btrim(note_input);
  lines       int;
  latest      date;
  posting     date;
  amount      numeric(14,2);
  partner_row int;
  signer_row  int;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  if merchant_id_input is null or original_period_input is null
     or partner_agent_id_input is null or primary_rep_pct_input is null
     or secondary_rep_pct_input is null or note_input is null then
    raise exception 'Every field is required to post a correction.'
      using errcode = '22023';
  end if;

  if note = '' then
    raise exception 'A correction needs a note saying what was agreed. Both reps see it on their statements.'
      using errcode = '22023';
  end if;

  if length(note) > 500 then
    raise exception 'The note can be at most 500 characters.'
      using errcode = '22023';
  end if;

  if extract(day from original_period_input) <> 1 then
    raise exception 'The month being corrected is given as its first day.'
      using errcode = '22023';
  end if;

  if primary_rep_pct_input <> round(primary_rep_pct_input, 2)
     or secondary_rep_pct_input <> round(secondary_rep_pct_input, 2)
     or primary_rep_pct_input <= 0 or secondary_rep_pct_input <= 0
     or primary_rep_pct_input + secondary_rep_pct_input <> 50 then
    raise exception 'The two shares must each be above 0, in hundredths at most, and add up to the rep side: 50.'
      using errcode = '22023';
  end if;

  select * into m from merchants where id = merchant_id_input;
  if not found then
    raise exception 'merchant not found' using errcode = 'PT404';
  end if;

  if m.mid is null or btrim(m.mid) = '' then
    raise exception 'This merchant has no MID, so it has no committed month to correct.'
      using errcode = 'PT409';
  end if;

  select * into partner from profiles where id = partner_agent_id_input;
  if not found then
    raise exception 'rep not found' using errcode = 'PT404';
  end if;

  if not partner.is_active then
    raise exception '% is deactivated, so a correction cannot name them.', partner.full_name
      using errcode = 'PT409';
  end if;

  select count(*) into lines
    from rep_payout_rows
   where period = original_period_input and mid = m.mid
     and line_kind = 'import';

  if lines = 0 then
    raise exception '% has no committed line for MID %, so there is nothing to correct.',
      to_char(original_period_input, 'FMMonth YYYY'), m.mid
      using errcode = 'PT404';
  end if;

  if lines > 1 then
    raise exception '% has % lines for MID %. A correction divides one rep''s month, so that month must have exactly one.',
      to_char(original_period_input, 'FMMonth YYYY'), lines, m.mid
      using errcode = 'PT409';
  end if;

  select * into signer
    from rep_payout_rows
   where period = original_period_input and mid = m.mid
     and line_kind = 'import'
   for update;

  if signer.share_role is not null then
    raise exception '% is already a shared month for MID %, so there is nothing to correct.',
      to_char(original_period_input, 'FMMonth YYYY'), m.mid
      using errcode = 'PT409';
  end if;

  if signer.agent_id = partner_agent_id_input then
    raise exception 'The partner must be a different rep from the one paid for that month.'
      using errcode = '22023';
  end if;

  if signer.rep_payout is null then
    raise exception 'The payout for % is not worked out yet: its residual or rate is blank. Fill it in first.',
      to_char(original_period_input, 'FMMonth YYYY')
      using errcode = 'PT409';
  end if;

  if exists (
    select 1 from rep_payout_rows
     where line_kind = 'adjustment' and mid = m.mid
       and adjusts_period = original_period_input
  ) then
    raise exception 'A correction for MID %, % has already been posted.',
      m.mid, to_char(original_period_input, 'FMMonth YYYY')
      using errcode = 'PT409';
  end if;

  amount := shared_part(signer.rep_payout, secondary_rep_pct_input,
                        primary_rep_pct_input + secondary_rep_pct_input);

  if amount = 0 then
    raise exception 'The partner''s share of that month rounds to $0.00, so there is nothing to move.'
      using errcode = 'PT409';
  end if;

  select max(period) into latest
    from rep_payout_rows
   where line_kind = 'import';

  posting := (latest + interval '1 month')::date;

  insert into rep_payout_rows (
    agent_id, period, mid, merchant_name, merchant_id,
    line_kind, adjustment_amount, adjusts_period, adjustment_note
  )
  values (
    partner_agent_id_input, posting, m.mid, signer.merchant_name, m.id,
    'adjustment', amount, original_period_input, note
  )
  returning id into partner_row;

  insert into rep_payout_rows (
    agent_id, period, mid, merchant_name, merchant_id,
    line_kind, adjustment_amount, adjusts_period, adjustment_note
  )
  values (
    signer.agent_id, posting, m.mid, signer.merchant_name, m.id,
    'adjustment', -amount, original_period_input, note
  )
  returning id into signer_row;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'post_share_correction', 'rep_payout_rows',
          partner_row::text);

  return jsonb_build_object(
    'posting_period', to_char(posting, 'YYYY-MM-DD'),
    'amount', amount,
    'partner_line_id', partner_row,
    'signer_line_id', signer_row
  );
end;
$$;

revoke all on function post_share_correction(int, date, uuid, numeric, numeric, text)
  from public;
grant execute on function post_share_correction(int, date, uuid, numeric, numeric, text)
  to authenticated, service_role;

-- =====================================================================
-- BATCH STATUS TRANSITIONS (20261016170000) — a signed-in user may move a
-- residual import batch from 'review' to 'abandoned', and make no other
-- change to a batch at all.
--
-- The UPDATE grant (20261016140000) stops a client writing any column but
-- status. It cannot say WHICH status: a grant sees columns, never values, and
-- the "admin abandons" policy only asks whether the caller is an admin. So an
-- admin's session could PATCH a committed batch back to 'review' -- after which
-- it can be parsed again (parse-residual-import only refuses a batch that is
-- not in review) and committed a second time, re-importing a month that has
-- already landed -- or straight to 'committed' with nothing imported, which
-- reads as a successful import that never happened, the exact state the
-- commit's `staged = 0` refusal exists to prevent. Or flip an abandoned batch
-- back into review.
--
-- guard_batch_status_transition(), a BEFORE UPDATE trigger, refuses (PT409)
-- every update a SIGNED-IN USER makes to a batch unless it is review ->
-- abandoned. "Signed-in user" is current_user = 'authenticated': the role
-- PostgREST runs every client request as. The legitimate other writers are
-- untouched by construction, because none of them runs as that role:
--   * both commit functions and acknowledge_residual_skips() are security
--     definer, so their statements run as the function owner;
--   * residual-import-file-url and parse-residual-import write through the
--     service role (file_key, status, row_count, adjustment_rows_ignored).
-- A plain BEFORE UPDATE, not `update of status`: the grant means every client
-- update names status today, but "everything else is refused" should not
-- depend on the grant staying that narrow. The trigger is security INVOKER --
-- it needs no privilege, and current_user must be the caller's.
--
-- The one client writer, abandonResidualBatch() (lib/residual-batches.ts),
-- writes review -> abandoned and nothing else; pointed at a batch that is not
-- in review it now gets this sentence rather than a silent rewrite.
-- =====================================================================

create or replace function guard_batch_status_transition()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user = 'authenticated'
     and not (old.status = 'review' and new.status = 'abandoned') then
    raise exception 'Only an import still in review can be changed here, and only to abandoned. This one is %.', old.status
      using errcode = 'PT409';
  end if;
  return new;
end;
$$;

revoke all on function guard_batch_status_transition() from public;

create trigger rep_payout_batches_status_transition
  before update on rep_payout_batches
  for each row execute function guard_batch_status_transition();

-- =====================================================================
-- MY SHARE PARTNERS (20261019120000) — the one way a rep learns who they
-- share an account with. Phase 6 of docs/design/residual-splits.md, §8.
--
-- my_share_partners(merchant_id_input int default null) returns jsonb
--   [{"rep_share_id": n, "partner_name": "...", "own_rep_pct": 40.00,
--     "effective_from": "YYYY-MM-DD", "effective_to": "YYYY-MM-DD" | null}]
--
-- THE RULE (Owen, 14 Oct 2026): each rep on a shared account sees the
-- partner's NAME and their OWN share, never the partner's payout. Neither is
-- reachable any other way: merchant_rep_shares is admin-only by policy, and
-- profiles shows a rep only their own row. So this is `security definer`,
-- which is what lets it see past both -- and it pays for that reach the way
-- accounts_in_city() and check_duplicates() do: a hand-written guard first,
-- search_path pinned, and a return shape decided key by key.
--
-- WHO IT ANSWERS FOR: the caller, and only as a PARTY. A row comes back only
-- where auth.uid() is the share's signer or its partner -- admins included.
-- An admin reads the table directly under its own policy; widening this
-- function for them would make it a second admin read path that nothing
-- needs, and an admin who is not a party gets []. A deactivated caller is
-- refused (PT403) before anything is read: a valid JWT outlives the account.
--
-- WHAT COMES BACK, and nothing else. Five keys, built with jsonb_build_object
-- so anything not named is ABSENT, not null:
--   rep_share_id    the key a ledger line already carries; the caller can read
--                   it on their own line, so it reveals nothing, and without
--                   it a name cannot be put against the right line when a rep
--                   has two shared accounts.
--   partner_name    the OTHER party's full_name.
--   own_rep_pct     the caller's own figure, in rep-percent terms (40, not 80%).
--   effective_from  first month; effective_to the exclusive end, or null.
-- Never: the partner's share, id or rate, any payout, the merchant's id, MID,
-- name or anything else of the merchant's. (The partner's share is arithmetic
-- -- the two total 50 -- and the caller's own ledger line carries the share
-- snapshot; design §8 records that as a display rule, not a secret. This
-- function does not add to it.)
--
-- merchant_id_input FILTERS and is never echoed. The signer's merchant page
-- passes it to say "shared with Bo Lee" on that merchant; the partner cannot
-- open the merchant record (no RLS changes here), and learns nothing from
-- the filter that their own ledger line -- which carries merchant_id -- does
-- not already say.
--
-- NOT AUDITED, like check_duplicates(): a read that names the caller's own
-- business. (accounts_in_city() was in this list until 20261023120000 audited
-- and rate-limited it; it reads OTHER reps' books from a public input.)
-- =====================================================================

create or replace function my_share_partners(merchant_id_input int default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
  result jsonb;
begin
  if caller is null or not is_active_agent() then
    raise exception 'not authorised' using errcode = 'PT403';
  end if;

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'rep_share_id', s.id,
             'partner_name', p.full_name,
             'own_rep_pct', case when s.primary_agent_id = caller
                                 then s.primary_rep_pct
                                 else s.secondary_rep_pct end,
             'effective_from', s.effective_from,
             'effective_to', s.effective_to)
           order by s.effective_from desc, s.id desc),
         '[]'::jsonb)
    into result
    from merchant_rep_shares s
    join profiles p
      on p.id = case when s.primary_agent_id = caller
                     then s.secondary_agent_id
                     else s.primary_agent_id end
   where (s.primary_agent_id = caller or s.secondary_agent_id = caller)
     and (merchant_id_input is null or s.merchant_id = merchant_id_input);

  return result;
end;
$$;

revoke all on function my_share_partners(int) from public;
grant execute on function my_share_partners(int) to authenticated, service_role;

-- =====================================================================
-- SHARE CORRECTION POSTING MONTH (20261019130000) — what the admin is
-- shown before a correction is posted, and the guarantee that it is where
-- the correction lands. Phase 6 of docs/design/residual-splits.md, §6.
--
-- share_correction_posting_period() returns date
--   The month post_share_correction() would post into right now: the month
--   after the latest month holding ANY import line, across every MID (the
--   rule 20261016161000 set and Owen confirmed on 16 Oct 2026). NULL when the
--   ledger holds no import line at all -- and then there is nothing to
--   correct either. Read-only, `stable`, `security definer` with a
--   hand-written is_admin() guard first (an agent asking would get an
--   answer computed from their own rows under invoker, which is a different
--   and wrong month) and search_path pinned. Not audited: it writes nothing.
--
-- THE RULE EXISTS ONCE. post_share_correction() is re-created to CALL this
-- function instead of computing the month itself, so the preview and the
-- post cannot drift apart: there is no second copy of the rule to update.
--
-- post_share_correction(..., expected_posting_period_input date default null)
--   gains one optional argument: the month the admin confirmed. When given
--   and it no longer matches -- a residual import committed a later month
--   between the preview and the click -- the correction is REFUSED (PT409)
--   rather than posted into a month nobody confirmed. NULL keeps the old
--   behaviour, so a caller passing the original six arguments by name is
--   unaffected.
--
-- The six-argument signature is DROPPED, not left beside the new one: with a
-- default on the seventh, a six-argument call would otherwise have two
-- candidates -- an ambiguity Postgres reports at call time, from the
-- browser (the dashboard_counts() and create_quote_version() trap; same
-- answer, same name-resolves-once assertion). Privilege lines are restated
-- for the new signature. Everything else in the body is unchanged,
-- including the second-correction refusal ("A correction for MID %, % has
-- already been posted."), which the merchant page shows verbatim.
-- =====================================================================

create or replace function share_correction_posting_period()
returns date
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  return (select (max(period) + interval '1 month')::date
            from rep_payout_rows
           where line_kind = 'import');
end;
$$;

revoke all on function share_correction_posting_period() from public;
grant execute on function share_correction_posting_period()
  to authenticated, service_role;

drop function post_share_correction(int, date, uuid, numeric, numeric, text);

create or replace function post_share_correction(
  merchant_id_input       int,
  original_period_input   date,
  partner_agent_id_input  uuid,
  primary_rep_pct_input   numeric,
  secondary_rep_pct_input numeric,
  note_input              text,
  expected_posting_period_input date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  m           merchants;
  partner     profiles;
  signer      rep_payout_rows;
  note        text := btrim(note_input);
  lines       int;
  posting     date;
  amount      numeric(14,2);
  partner_row int;
  signer_row  int;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  if merchant_id_input is null or original_period_input is null
     or partner_agent_id_input is null or primary_rep_pct_input is null
     or secondary_rep_pct_input is null or note_input is null then
    raise exception 'Every field is required to post a correction.'
      using errcode = '22023';
  end if;

  if note = '' then
    raise exception 'A correction needs a note saying what was agreed. Both reps see it on their statements.'
      using errcode = '22023';
  end if;

  if length(note) > 500 then
    raise exception 'The note can be at most 500 characters.'
      using errcode = '22023';
  end if;

  if extract(day from original_period_input) <> 1 then
    raise exception 'The month being corrected is given as its first day.'
      using errcode = '22023';
  end if;

  if primary_rep_pct_input <> round(primary_rep_pct_input, 2)
     or secondary_rep_pct_input <> round(secondary_rep_pct_input, 2)
     or primary_rep_pct_input <= 0 or secondary_rep_pct_input <= 0
     or primary_rep_pct_input + secondary_rep_pct_input <> 50 then
    raise exception 'The two shares must each be above 0, in hundredths at most, and add up to the rep side: 50.'
      using errcode = '22023';
  end if;

  select * into m from merchants where id = merchant_id_input;
  if not found then
    raise exception 'merchant not found' using errcode = 'PT404';
  end if;

  if m.mid is null or btrim(m.mid) = '' then
    raise exception 'This merchant has no MID, so it has no committed month to correct.'
      using errcode = 'PT409';
  end if;

  select * into partner from profiles where id = partner_agent_id_input;
  if not found then
    raise exception 'rep not found' using errcode = 'PT404';
  end if;

  if not partner.is_active then
    raise exception '% is deactivated, so a correction cannot name them.', partner.full_name
      using errcode = 'PT409';
  end if;

  select count(*) into lines
    from rep_payout_rows
   where period = original_period_input and mid = m.mid
     and line_kind = 'import';

  if lines = 0 then
    raise exception '% has no committed line for MID %, so there is nothing to correct.',
      to_char(original_period_input, 'FMMonth YYYY'), m.mid
      using errcode = 'PT404';
  end if;

  if lines > 1 then
    raise exception '% has % lines for MID %. A correction divides one rep''s month, so that month must have exactly one.',
      to_char(original_period_input, 'FMMonth YYYY'), lines, m.mid
      using errcode = 'PT409';
  end if;

  select * into signer
    from rep_payout_rows
   where period = original_period_input and mid = m.mid
     and line_kind = 'import'
   for update;

  if signer.share_role is not null then
    raise exception '% is already a shared month for MID %, so there is nothing to correct.',
      to_char(original_period_input, 'FMMonth YYYY'), m.mid
      using errcode = 'PT409';
  end if;

  if signer.agent_id = partner_agent_id_input then
    raise exception 'The partner must be a different rep from the one paid for that month.'
      using errcode = '22023';
  end if;

  if signer.rep_payout is null then
    raise exception 'The payout for % is not worked out yet: its residual or rate is blank. Fill it in first.',
      to_char(original_period_input, 'FMMonth YYYY')
      using errcode = 'PT409';
  end if;

  if exists (
    select 1 from rep_payout_rows
     where line_kind = 'adjustment' and mid = m.mid
       and adjusts_period = original_period_input
  ) then
    raise exception 'A correction for MID %, % has already been posted.',
      m.mid, to_char(original_period_input, 'FMMonth YYYY')
      using errcode = 'PT409';
  end if;

  amount := shared_part(signer.rep_payout, secondary_rep_pct_input,
                        primary_rep_pct_input + secondary_rep_pct_input);

  if amount = 0 then
    raise exception 'The partner''s share of that month rounds to $0.00, so there is nothing to move.'
      using errcode = 'PT409';
  end if;

  -- The one rule for the posting month, shared with the admin's preview.
  posting := share_correction_posting_period();

  -- What the admin confirmed. A commit landing between the preview and this
  -- call would otherwise post into a different month than the one shown.
  if expected_posting_period_input is not null
     and expected_posting_period_input is distinct from posting then
    raise exception 'A month was committed after this correction was reviewed, so it would now post to %, not %. Review it again.',
      to_char(posting, 'FMMonth YYYY'),
      to_char(expected_posting_period_input, 'FMMonth YYYY')
      using errcode = 'PT409';
  end if;

  insert into rep_payout_rows (
    agent_id, period, mid, merchant_name, merchant_id,
    line_kind, adjustment_amount, adjusts_period, adjustment_note
  )
  values (
    partner_agent_id_input, posting, m.mid, signer.merchant_name, m.id,
    'adjustment', amount, original_period_input, note
  )
  returning id into partner_row;

  insert into rep_payout_rows (
    agent_id, period, mid, merchant_name, merchant_id,
    line_kind, adjustment_amount, adjusts_period, adjustment_note
  )
  values (
    signer.agent_id, posting, m.mid, signer.merchant_name, m.id,
    'adjustment', -amount, original_period_input, note
  )
  returning id into signer_row;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'post_share_correction', 'rep_payout_rows',
          partner_row::text);

  return jsonb_build_object(
    'posting_period', to_char(posting, 'YYYY-MM-DD'),
    'amount', amount,
    'partner_line_id', partner_row,
    'signer_line_id', signer_row
  );
end;
$$;

revoke all on function post_share_correction(int, date, uuid, numeric, numeric, text, date)
  from public;
grant execute on function post_share_correction(int, date, uuid, numeric, numeric, text, date)
  to authenticated, service_role;

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
  -- The two optional rep identity columns ("Legal name", "LLC legal name"),
  -- added by 20261026120000. provision-user-batch writes them through
  -- set_rep_identity() after the account exists, never directly.
  legal_name_raw text,
  llc_legal_name_raw text,

  -- Resolved values, null wherever the raw text could not be resolved --
  -- in which case `blocker` says why.
  full_name text,
  email text,
  role text check (role in ('agent', 'admin')),
  agent_number text,
  legal_name text,
  llc_legal_name text,

  -- A code so the UI can group and count; `error` carries the prose for
  -- the row itself.
  --
  -- Eight of these BLOCK the batch. The last two -- email_exists and
  -- agent_number_taken -- deliberately do NOT: those rows are skipped
  -- and the rest of the file still imports. Accounts are independent of
  -- one another, unlike the rows of one period's ledger, so refusing
  -- forty onboardings because three people already have logins is the
  -- wrong trade. The split lives in isBlocking() in
  -- supabase/functions/_shared/user-imports.ts and lib/user-imports.ts.
  blocker text constraint user_import_rows_blocker_check check (blocker in (
    'missing_name', 'invalid_email', 'invalid_role', 'invalid_agent_number',
    'invalid_legal_name', 'invalid_llc_legal_name',
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
-- BUSINESS DOCUMENTS — the company library behind /documents: the
-- policies, agreements, forms and guides every rep needs, published by an
-- admin. Added by 20261013120000, and it REPLACES what /documents used to
-- be.
--
-- Until then /documents was the cross-record index over `documents`: reps
-- uploading a merchant's voided check or driver's licence onto a lead,
-- merchant, pre-app or ticket. The CRM does not accept that paperwork any
-- more, so that path is closed (see DOCUMENTS above and 20261013121000)
-- and the page became this library instead.
--
-- Modelled on marketing_materials, deliberately and closely: same
-- no-agent_id shape, same row-before-upload sequencing (the key is
-- {document_id}/{file_name}), same validated file_key CHECK, same
-- admin-write policies, same "archive, never delete" retirement. Three
-- differences, each decided rather than drifted into:
--
-- 1. NO EVENT TABLE. marketing_material_events exists because "which sell
--    sheet did this rep send THIS LEAD" is a question about a deal. A
--    business document is read for the rep's own reference and is never
--    sent to a merchant on a lead, so there is no deal to file an event
--    against, and a per-rep reading log would be surveillance nobody asked
--    for. Without an event table nothing references a business document,
--    so archiving is no longer forced by an FK -- it is kept because a
--    signed URL already handed out, an audit_log row naming the id, and an
--    admin's mistaken click are all better served by a row that still
--    exists. The UI calls the action "Delete": an archived document is gone
--    from every page.
--
-- 2. AN ARCHIVED DOCUMENT IS HIDDEN BY RLS, not by the query -- the
--    opposite of products and marketing_materials, and on purpose. For
--    those two, archiving is a lifecycle state: a quote line still names
--    the product, a material's history is still read. Here archiving IS
--    deletion as far as anyone outside the admin role is concerned, so a
--    rep calling PostgREST directly must not be able to list what an admin
--    deleted, and business-document-file-url refuses to sign one for
--    anybody. The admin branch still sees every row, which is what the
--    manage page and an engineer's recovery need.
--
-- 3. size_bytes. Shown beside each file so a rep knows a 40 MiB scan is
--    coming before they tap it on a phone. Supplied by the uploading
--    admin's browser and written by the function under the service role --
--    a display hint, not a measurement, and nothing reads it for a
--    decision. The per-bucket file_size_limit is the actual ceiling.
-- =====================================================================
create table business_documents (
  id serial primary key,

  -- The "folder". Free text, like marketing_materials.category and for the
  -- same reason: an admin opening a new kind of document should not need a
  -- migration.
  category text not null,
  title text not null,

  -- Nullable because the row is created BEFORE the upload; see
  -- marketing_materials.file_key, which is the identical sequencing.
  file_key text,
  file_name text,
  mime_type text,
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),

  -- The uploading admin. Not agent_id, for the reason
  -- marketing_materials.uploaded_by is not. The TWENTY-THIRD column
  -- referencing profiles(id), and NO ACTION like twenty-one of the others:
  -- all four teardown lists need it.
  uploaded_by uuid references profiles(id) not null,
  uploaded_at timestamptz default now(),

  -- "Deleted". See note 1 and note 2 above.
  archived_at timestamptz
);

-- file_key must be the key for THIS row's id. Same rule, same shape and same
-- reasoning as marketing_materials_file_key_matches_id: nothing
-- client-supplied reaches the column (the function writes it as service
-- role), so this pins the invariant the signing step depends on.
-- fileKeyMatchesBusinessDocument() in
-- supabase/functions/_shared/business-documents.ts enforces it again in front
-- of Storage. Validated -- a new table has no legacy rows to exempt.
alter table business_documents
  add constraint business_documents_file_key_matches_id
  check (
    file_key is null
    or (
      starts_with(file_key, id::text || '/')
      and split_part(file_key, '/', 2) <> ''
      and split_part(file_key, '/', 3) = ''
    )
  );

alter table business_documents enable row level security;

-- Every active user reads every LIVE document; an admin reads all of them.
-- is_active_agent() is load-bearing exactly as on marketing_materials: a
-- deactivated rep holds a working JWT until it expires.
create policy "select live to active users, all to admin" on business_documents
  for select using ((is_active_agent() and archived_at is null) or is_admin());

-- Admin-only writes. Rename, recategorise and delete (archive) are plain
-- PostgREST updates from the manage page; only the file needs the function.
create policy "admin inserts" on business_documents
  for insert with check (is_admin());
create policy "admin updates" on business_documents
  for update using (is_admin()) with check (is_admin());
-- No DELETE policy, and no DELETE grant below. "Delete" in the UI is
-- archived_at.

-- The rep-facing list is "live documents by category, then title", which is
-- exactly the rows this partial index holds.
create index idx_business_documents_category
  on business_documents(category, title)
  where archived_at is null;

-- NO CROSS-AGENT AUDIT TRIGGER, for marketing_materials' first reason: there
-- is no agent_id, so log_cross_agent_change() would read NULL and log every
-- write. Uploads are audited where they happen, in business-document-file-url
-- (upload_business_document). Renames and deletes are plain admin UPDATEs and
-- are not audited -- the same as archiving a marketing material -- because
-- archived_at keeps the row and its file, so nothing an admin does here is
-- irreversible.

-- =====================================================================
-- BRANDS — the manufacturers the catalog is organised by.
--
-- /admin/products is a grid of brand boxes, and an admin adds a brand
-- BEFORE it has any products ("we are about to carry Material POS"). A
-- brand derived from `select distinct products.brand` cannot exist with
-- zero products, so it needs a table of its own.
--
-- THE FK IS ON THE NAME, NOT ON AN ID, and that is the smallest design
-- that changes no reader. products.brand stays the text column it already
-- was, now `references brands(name) on update cascade on delete
-- restrict`. Everything that reads it -- the store's browse-by-brand
-- filter and search, lib/quotes-data.ts's ordering, the loader's diff --
-- reads the same text it read yesterday, and nothing on a quote snapshots
-- the brand at all, so the printed proposal is untouched. A `brand_id`
-- FK would have been the textbook shape and would have rewritten every
-- one of those readers to join for a label they already hold.
--
--   * RENAME CASCADES. `on update cascade` rewrites products.brand in the
--     same statement, so a rename can never leave products pointing at a
--     name that no longer exists. The referential action runs below RLS,
--     which is right: only an admin can rename a brand in the first place,
--     and an admin may update every product anyway.
--   * DELETE IS REFUSED WHILE ANY PRODUCT NAMES IT, archived ones
--     included. `restrict`, not `set null`: nulling would silently move a
--     brand's products into the store's unbranded "Other" bucket, which is
--     a change to what a rep sees made as a side effect of a click on a
--     different page. An archived product still counts, because it is
--     history a quote line may name.
--
-- A SURROGATE `id` ANYWAY, for the URL and nothing else. The admin page
-- for a brand is /admin/products/<id>, so renaming a brand does not
-- change the address of the page the admin is standing on. Nothing joins
-- on it.
--
-- products.brand STAYS NULLABLE. The reason it was nullable has not
-- changed -- the catalog holds things no manufacturer makes -- and an FK
-- column accepts null. Unbranded products are reached on the admin side
-- through an "Other" box that appears only while such products exist.
--
-- The FOURTH client-readable table with no agent_id, after
-- marketing_materials, products and product_compatibility, and for the
-- same reason: company reference data. The checklist applies with step 1
-- struck out. Unlike products, it HAS a DELETE policy and grant, because
-- a brand nothing references is not history -- the FK is what decides
-- when deleting one would destroy something.
-- =====================================================================
create table brands (
  id serial primary key,

  -- `unique` because a foreign key can only target a unique column.
  -- Trimmed and non-blank for products_brand_not_blank's reason one step
  -- earlier: a padded name is a second box on the grid that looks
  -- identical to the first, and a blank one is a box with no label.
  name text not null unique
    constraint brands_name_trimmed check (name = btrim(name) and name <> ''),

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Case-insensitive uniqueness on top of the exact `unique` above (which
-- the FK needs). "Square" and "square" would otherwise be two boxes, and
-- products filed under each would be split across two store headings
-- that look like a typo.
create unique index idx_brands_name_lower on brands (lower(name));

alter table brands enable row level security;

-- is_active_agent() is the load-bearing half, exactly as on products: a
-- deactivated rep's JWT keeps working until it expires.
create policy "select active or admin" on brands
  for select using (is_active_agent() or is_admin());
create policy "admin inserts" on brands
  for insert with check (is_admin());
create policy "admin updates" on brands
  for update using (is_admin()) with check (is_admin());
-- DELETE exists, unlike on products: whether a delete would destroy
-- anything is the FK's question, and it answers by refusing.
create policy "admin deletes" on brands
  for delete using (is_admin());

create trigger brands_set_updated_at
  before update on brands
  for each row execute function set_updated_at();

-- No cross-agent audit trigger: no agent_id, so log_cross_agent_change()
-- would read NULL and log every write -- the same answer products gives.

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
  --
  -- This is ALSO the store's "device type" filter. A second column for
  -- that would be the same fact twice: "Countertop terminals" is what a
  -- rep filtering by type is choosing, and two columns holding it would
  -- drift the moment an admin filed a product under one and not the
  -- other.
  category text not null,

  -- The manufacturer, and the axis the store browses by. Free text with
  -- no vocabulary, for the reason `category` has none.
  --
  -- NULLABLE, unlike category, and the store has a bucket for the nulls.
  -- Making it NOT NULL reads like the obvious way to keep browse-by-brand
  -- total, and it is worse: the catalog legitimately holds things no
  -- manufacturer makes ("Gateway monthly", "PCI compliance"), so an admin
  -- would have to type something -- and whatever they typed would then
  -- appear in the rep's brand list as if it were a vendor.
  --
  -- '' must never be stored, for sku's reason one step further on: an
  -- empty brand is not a uniqueness collision here, it is a blank heading
  -- in the store's browse list. Both write paths normalise it to null --
  -- normalizeBrand() in lib/products.ts, beside normalizeSku().
  --
  -- A FOREIGN KEY TO brands(name) as of 20261009120000 -- see BRANDS
  -- above for why the name and not an id. A product can only name a brand
  -- that exists, a rename cascades here, and a brand cannot be deleted
  -- while any product (archived included) still names it.
  brand text references brands(name) on update cascade on delete restrict,

  -- Whether this is a thing a rep puts in the cart on its own, or a thing
  -- that hangs off one.
  --
  -- A two-value CHECK rather than free text, which is the opposite call
  -- to `category` and `brand` above -- and the difference is who reads
  -- it. Those two are labels a person reads; this one is read by CODE:
  -- product_compatibility's trigger checks it, the store lists devices
  -- and nests add-ons, and the printed proposal groups by it. A third
  -- value typed by an admin would not be a new kind of label, it would be
  -- a row that every one of those three silently skips.
  --
  -- Defaults to 'device' so the column can be NOT NULL from the first
  -- migration without a backfill decision: a product nobody has marked as
  -- an accessory is a standalone thing, which is the safe reading -- it
  -- stays visible in the store rather than vanishing into an add-on list
  -- under a device it was never linked to.
  kind text not null default 'device'
    check (kind in ('device', 'addon')),

  -- One-off hardware, or a recurring charge. Same closed vocabulary and
  -- the same reason: the proposal totals two columns off this value, and
  -- a third value would land in neither.
  --
  -- NOT a per-quote choice. Whether a gateway is billed monthly is a fact
  -- about the product, so it lives here and is SNAPSHOTTED onto
  -- quote_line_items.product_billing when a quote is written -- exactly
  -- as the price is, and for the same reason: re-deriving it later would
  -- restate what a merchant was shown.
  --
  -- Defaults to 'one_time' because every product predating this column is
  -- hardware.
  billing text not null default 'one_time'
    check (billing in ('one_time', 'monthly')),

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
-- PRODUCT COMPATIBILITY — which add-ons fit which devices.
--
-- The THIRD client-readable table with no agent_id, and it inherits that
-- shape from its parents rather than choosing it: a fact about two
-- catalog rows cannot be owned by a rep. So the checklist in CLAUDE.md
-- applies with its first step struck out -- there is no
-- `agent_id uuid references profiles(id) not null` to add, and the select
-- policy is `is_active_agent() or is_admin()` with nothing to compare an
-- owner against, exactly as products and marketing_materials are.
--
-- NO SURROGATE KEY. The pair IS the key: "this add-on fits that device"
-- is either recorded or it is not, and there is nothing a row id would
-- identify that the pair does not. One consequence worth stating because
-- the checklist's step 4 names it: there is no `_id_seq`, so there is no
-- sequence grant to forget. The usual `grant usage on <t>_id_seq` line is
-- absent here because it would refer to an object that does not exist,
-- not because it was overlooked.
--
-- WHY A JOIN TABLE RATHER THAN A COLUMN. An array of device ids on the
-- add-on, or a `fits` key in products.specs, would both store the same
-- thing -- and neither can be a foreign key. specs in particular is the
-- column whose documented cost is that nothing validates its keys, so a
-- typo'd device id there is a compatibility rule that silently matches
-- nothing. Here the FK means a device id that does not exist cannot be
-- written at all.
--
-- BOTH SIDES ARE `no action`, deliberately, and it never fires. products
-- has no DELETE policy and no DELETE grant -- retirement is archived_at
-- -- so nothing in the app can delete the parent. If a service-role write
-- ever tried, blocking it is the honest answer: a compatibility row whose
-- device is gone is a claim about nothing, and cascading would delete the
-- admin's work without saying so.
-- =====================================================================
create table product_compatibility (
  addon_product_id  int references products(id) not null,
  device_product_id int references products(id) not null,

  -- Ordinary, not NOT VALID: the table is new, so it has no rows that
  -- could fail it. See quotes_at_most_one_link for the opposite case
  -- handled the same way -- NOT VALID is for constraints added over data
  -- that predates them, and reaching for it when the rows can be proven
  -- clean buys nothing and gives up the guarantee.
  constraint product_compatibility_distinct
    check (addon_product_id <> device_product_id),

  primary key (addon_product_id, device_product_id)
);

-- "Which add-ons fit this device" is the store's query, run every time a
-- rep adds a device to the cart. The primary key's index leads with
-- addon_product_id, so it cannot serve a lookup by device.
create index idx_product_compatibility_device
  on product_compatibility(device_product_id, addon_product_id);

alter table product_compatibility enable row level security;

-- Copied from products, down to is_active_agent() being the load-bearing
-- half for the same reason: a deactivated rep holds a working JWT until
-- it expires, and the catalog's shape is as much company information as
-- its prices.
create policy "select active or admin" on product_compatibility
  for select using (is_active_agent() or is_admin());

create policy "admin inserts" on product_compatibility
  for insert with check (is_admin());
create policy "admin updates" on product_compatibility
  for update using (is_admin()) with check (is_admin());
-- DELETE, unlike products. The two tables differ here and the difference
-- is what the row MEANS. Archiving a product preserves history, because
-- quote_line_items snapshots what it said. A compatibility row is not
-- history -- nothing snapshots it, nothing references it, and no quote
-- depends on it -- it is a current-state claim that an admin got wrong or
-- that a vendor has stopped being true. An archived_at here would mean
-- carrying tombstones that every reader has to remember to filter.
create policy "admin deletes" on product_compatibility
  for delete using (is_admin());

-- =====================================================================
-- The kinds, enforced where a CHECK cannot reach.
--
-- A CHECK sees only its own row, and the rule here is about two OTHER
-- rows -- the same reason set_manager()'s one-hop rule lives in a
-- function. So: a trigger.
--
-- WHY IT IS WORTH HAVING AT ALL, given that a wrong row is inert rather
-- than dangerous. The store only ever asks "which add-ons fit this
-- device", keyed on device_product_id, and only devices are offered as
-- cart parents -- so a row written with the two ids the wrong way round
-- matches nothing, ever, and nothing reports it. That is the
-- `dup_digits` failure mode in another costume: an admin links an
-- accessory to a terminal, the store does not offer it, and the catalog
-- looks correct in /admin/products. A refusal at write time turns a
-- silent nothing into a sentence.
--
-- KNOWN LIMIT, stated rather than discovered: this fires on
-- product_compatibility, so it cannot see a product whose `kind` is
-- changed AFTERWARDS. An admin flipping a device to 'addon' leaves its
-- existing rows in exactly the inert state above. Guarding that needs a
-- second trigger on products, and it is deliberately not here -- the
-- failure is a row that does nothing, not a wrong figure on a document,
-- and /admin/products is where a kind is changed and where the
-- consequence belongs. If it turns out to bite, the fix is a trigger on
-- products that refuses the change while rows reference it, not a CHECK.
--
-- security INVOKER, which in this repo is the default that needs no
-- defence -- but note why no definer is wanted: only an admin may write
-- this table, and an admin can read every product, so there is nothing
-- here the caller may not already see. Compare snapshot_quote_line_item()
-- below, which IS definer, and whose reason is that the price on a
-- document must not depend on a policy.
-- =====================================================================
create or replace function enforce_compatibility_kinds()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  addon_kind  text;
  device_kind text;
begin
  select kind into addon_kind  from products where id = NEW.addon_product_id;
  select kind into device_kind from products where id = NEW.device_product_id;

  -- A missing row is left to the foreign key, which reports it precisely.
  -- Raising here too would mean two messages for one cause, and this one
  -- would be the vaguer of them.
  if addon_kind is not null and addon_kind <> 'addon' then
    raise exception 'the add-on side of a compatibility row must be a product of kind addon';
  end if;

  if device_kind is not null and device_kind <> 'device' then
    raise exception 'the device side of a compatibility row must be a product of kind device';
  end if;

  return NEW;
end;
$$;

revoke all on function enforce_compatibility_kinds() from public;
-- Trigger function: revoked and deliberately NOT granted, like
-- enforce_quote_version(), log_cross_agent_change() and set_updated_at().
-- A trigger fires whether or not the querying role holds EXECUTE.

create trigger product_compatibility_enforce_kinds
  before insert or update on product_compatibility
  for each row execute function enforce_compatibility_kinds();

-- No cross-agent audit trigger, for the reason products has none: no
-- agent_id, so log_cross_agent_change() would read NULL and log 100% of
-- writes.

-- =====================================================================
-- WHAT HIDES AN ARCHIVED PRODUCT FROM A REP: THE QUERY, NOT RLS.
--
-- Worth stating outright, because "reps must not be offered retired
-- hardware" sounds like a policy and must not become one.
--
-- The select policy on products and on product_compatibility is
-- `is_active_agent() or is_admin()` with no row filter, and the store's
-- query carries `.is("archived_at", null)` -- which is what
-- app/(app)/leads/[id]/page.tsx and the merchant page already do, plus
-- isQuotable() in lib/products.ts. Three reasons it belongs there:
--
--   1. AN ADMIN MUST STILL SEE EVERYTHING. /admin/products is where a
--      product is un-archived, so a policy hiding archived rows would
--      need a role branch -- which is two policies wearing one name, and
--      the thing that makes a policy hard to reason about.
--
--   2. ARCHIVING IS A LIFECYCLE STATE, NOT AN ACCESS BOUNDARY. This is
--      profiles.territory's lesson: a label that reads like an access
--      rule must not be wired into one, because then changing the label
--      silently changes who can see what. Un-archiving a terminal should
--      put it back in the picker, not re-grant a row.
--
--   3. A QUOTE OUTLIVES THE PRODUCT ON IT. quote_line_items snapshots
--      name, sku, price, billing and kind precisely so a printed
--      proposal survives the catalog moving on -- but product_id is
--      still a live FK, and a policy that hid archived rows would make
--      any future join from a historical line come back empty while
--      looking perfectly correct.
--
-- The consequence to accept: nothing in the DATABASE stops a rep from
-- naming an archived product. That is covered where it matters instead,
-- and twice -- create_quote_version() refuses one by name, and
-- snapshot_quote_line_item() refuses it again at the one layer no caller
-- can skip. A hidden row is a courtesy; a refused write is the boundary.
-- =====================================================================

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

  -- A quote is LINKED to a lead, to a merchant, or to NEITHER -- at most
  -- one of the two (quotes_at_most_one_link below).
  --
  -- As of 20261009150000 a proposal is its own record (/proposals), owned
  -- by a rep, and the link is optional. Until then it was EXACTLY one, and
  -- a quote could only be made from a lead or merchant page. The unlinked
  -- case is a rep pricing hardware for a business that is not in the CRM
  -- yet -- a walk-in, a phone enquiry -- and forcing a lead into existence
  -- first would mean inventing one to hold a price sheet. Who the document
  -- is FOR is then customer_name, below, which every version carries
  -- whether or not it is linked.
  --
  -- Both nullable with a CHECK rather than NOT NULL on either, because
  -- the linked cases are the same document at different points in a
  -- relationship: a rep quotes hardware to win a deal, and quotes more
  -- hardware to the same business two years later when it is a merchant
  -- on the books. One table, one append-only version history, one
  -- printable document.
  --
  -- WHY NOT a polymorphic owner_type + owner_id, which notes, tasks and
  -- documents all use. Those three point at FOUR tables and carry no
  -- foreign key at all, which is a documented cost -- a row can be filed
  -- against an owner the writer cannot see, deleting an owner orphans its
  -- rows, and `owner_type` has to be in every query or ids collide. Here
  -- there are only two targets, so two real foreign keys cost one extra
  -- column and buy back every one of those: the database refuses an id
  -- that does not exist, the cascade is declared, and a query naming
  -- lead_id cannot accidentally match a merchant.
  --
  -- ON DELETE CASCADE on both, like marketing_material_events.lead_id and
  -- for the same reason: a quote is ABOUT its owner, and an orphaned one
  -- is a document no page can place. Deleting either owner is admin-only.
  lead_id     int references leads(id)     on delete cascade,
  merchant_id int references merchants(id) on delete cascade,

  -- WHO THE DOCUMENT IS FOR, snapshotted onto every version.
  --
  -- Linked: COPIED from the lead's or merchant's name by
  -- enforce_quote_version(), whatever the caller sent -- the same
  -- overwrite-don't-trust shape as the price lock, because a name on a
  -- linked proposal that differs from its record is a document addressed
  -- to somebody the CRM does not say it is. (dba, then the legal name,
  -- then "Lead #<id>" / "Merchant #<id>", since leads.dba is nullable.)
  -- Unlinked: TYPED by the rep, and required.
  --
  -- A snapshot rather than a live join for quote_line_items' reason: a
  -- proposal records what a merchant was shown, and "Prepared for" is part
  -- of that. Renaming a lead later does not readdress last month's sheet;
  -- the next version picks up the new name.
  --
  -- NOT NULL and non-blank in BOTH cases. The list page and the printed
  -- sheet both lead with it, and a blank there is a proposal for nobody.
  customer_name text not null
    constraint quotes_customer_name_not_blank check (btrim(customer_name) <> ''),

  -- The REP THE PROPOSAL IS FOR, and one more column referencing profiles(id) -- ON DELETE
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
  --
  -- WHAT agent_id MEANS CHANGED in 20261009150000, and the data did not
  -- have to. It used to be "the owner of the parent lead or merchant" --
  -- the lead page passed lead.agent_id -- because a quote could only be
  -- made from one. Now it is "the rep this proposal is for": a rep makes
  -- proposals for themselves, an admin for any rep. Every existing row was
  -- written with the parent's rep, which IS the rep it was for, so no
  -- backfill. The consequence worth knowing: a proposal's rep and its
  -- linked record's rep can now differ (an admin may file rep A's proposal
  -- against rep B's lead). The proposal is A's; B sees it nowhere.
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
  unique (quote_group_id, version),

  -- AT MOST ONE LINK. num_nonnulls() says the rule in the words the rule
  -- is in, and stays right if a third link kind is ever added. Replaced
  -- quotes_exactly_one_owner (`= 1`) in 20261009150000; loosening `= 1`
  -- to `<= 1` admits a superset of the rows the old one did, so every
  -- existing row passes and the constraint is ORDINARY, not NOT VALID --
  -- NOT VALID is for a constraint added over data that may violate it,
  -- and reaching for it here would give up the guarantee for nothing.
  constraint quotes_at_most_one_link
    check (num_nonnulls(lead_id, merchant_id) <= 1)
);

-- "Every version of this quote, newest first" is served by the unique
-- constraint's own index on (quote_group_id, version). These two exist
-- for the OTHER query -- a detail page's "every quote on this record",
-- which that index cannot help with at all.
--
-- PARTIAL on each owner column, which a plain two-column index could not
-- replace: every merchant quote has a null lead_id and vice versa, so an
-- unpartitioned index would carry a null half for each. Postgres can use
-- a partial index only when the query's WHERE implies the predicate, and
-- both pages do exactly that -- the lead page asks
-- `where lead_id = $1`, which implies `lead_id is not null`.
create index idx_quotes_lead
  on quotes(lead_id, quote_group_id, version desc)
  where lead_id is not null;
create index idx_quotes_merchant
  on quotes(merchant_id, quote_group_id, version desc)
  where merchant_id is not null;
create index idx_quotes_agent_id on quotes(agent_id);

alter table quotes enable row level security;

create policy "select own or admin" on quotes
  for select using ((agent_id = auth.uid() and is_active_agent()) or is_admin());

-- WHO MAY CREATE A PROPOSAL, AND FOR WHOM. Rewritten in 20261009150000,
-- when a proposal stopped being a child of a lead or merchant page.
--
--   1. FOR WHOM: `(agent_id = auth.uid() and is_active_agent()) or
--      is_admin()`. Unchanged in text, changed in meaning -- agent_id is
--      now the rep the proposal is FOR (see the column), so this says a
--      rep creates proposals for themselves only and an admin for anyone.
--
--   2. WHAT IT MAY BE LINKED TO: each link must be a record the CALLER CAN
--      SEE. The `exists` subqueries are deliberately left to RLS this
--      time, where the old policy spelled out `leads.agent_id =
--      auth.uid()`. The rule IS "visible to the caller", so the honest way
--      to write it is to ask the leads and merchants select policies --
--      and if those ever widen (a manager seeing a team's leads), linking
--      widens with them instead of silently disagreeing. A policy subquery
--      runs under the caller's own RLS, so this cannot see a row the
--      caller cannot.
--
--   3. NOT LINKED AT ALL is now allowed, with customer_name required by
--      its own constraint.
--
-- WHAT CHANGED, concretely, from "insert own via own lead or merchant":
--   * an unlinked proposal is admitted (was refused by the policy for a
--     rep and by quotes_exactly_one_owner for an admin);
--   * an ADMIN'S link is now checked too, where the old `is_admin() or
--     ...` skipped it -- a no-op today, since an admin sees every lead and
--     merchant, but it means the rule has no role branch;
--   * nothing a rep could do before is refused now, and nothing a rep was
--     refused is admitted: a rep sees exactly their own leads and
--     merchants, which is what the spelled-out clause said.
--
-- The documents.file_key lesson still applies and is why the clauses
-- exist at all: lead_id and merchant_id are client-supplied, and without
-- an `exists` here a rep could file a proposal against another rep's
-- lead -- not reading anything, but putting a document in front of the
-- admin reviewing somebody else's deal.
--
-- The `is null or` guards keep each branch to its own column, so an
-- unlinked proposal never evaluates an `exists` against null.
create policy "insert own, linked only to what the caller can see" on quotes
  for insert with check (
    (
      (agent_id = auth.uid() and is_active_agent())
      or is_admin()
    )
    and (
      lead_id is null
      or exists (select 1 from leads where leads.id = quotes.lead_id)
    )
    and (
      merchant_id is null
      or exists (select 1 from merchants where merchants.id = quotes.merchant_id)
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

  -- The other two facts a printed proposal needs, snapshotted for
  -- exactly the reason the price and the name are.
  --
  -- `product_billing` decides which of the document's TWO TOTALS a line
  -- lands in. Re-deriving it from products at print time would restate
  -- what a merchant was shown: an admin moving a gateway from one-time to
  -- monthly would silently move a figure between the totals on every
  -- proposal ever printed, and the restated sheet would look exactly like
  -- the original.
  --
  -- `product_kind` is what makes the document's STRUCTURE survive too.
  -- The proposal groups each device with the add-ons under it, and that
  -- grouping is read off (sort_order, product_kind) and nothing else: a
  -- device line opens a group and the addon lines following it belong to
  -- it. The alternative was joining product_compatibility live, which
  -- would mean a saved quote re-grouping itself when an admin unlinks an
  -- accessory -- the one thing the append-only design exists to prevent.
  -- So the structure is derived from two snapshotted facts rather than
  -- from the catalog, and create_quote_version() writes sort_order from
  -- the array's own order to make that true.
  --
  -- Both NOT NULL. Both were backfilled from products in the migration
  -- that added them, which is safe because `products.billing` and
  -- `products.kind` are themselves NOT NULL with defaults, so every row
  -- the FK points at really does have a value to copy.
  --
  -- NO CHECK constraint on either, deliberately, and this is where a
  -- snapshot differs from its source. products.kind and products.billing
  -- each carry a two-value CHECK because they are current state a person
  -- types. These are a record of what was true WHEN THE QUOTE WAS SENT --
  -- so if the vocabulary is ever widened or narrowed, an old row holding
  -- a retired value is correct history, and a constraint would turn the
  -- migration that changed the vocabulary into one that has to rewrite
  -- documents. lib/quotes.ts guards both on read instead, the way the
  -- lead status badge does.
  product_billing text not null,
  product_kind text not null,

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
  group_agent_id    uuid;
  group_lead_id     int;
  group_merchant_id int;
  max_version       int;
  linked_name       text;
begin
  -- One scan for every fact about the group. An empty group yields NULLs
  -- throughout, which is the brand-new-quote case.
  --
  -- min() on the two owner columns rather than a bare reference: they are
  -- not in the GROUP BY, and they are constant across the group precisely
  -- because of the check below -- so any aggregate reads the group's one
  -- value, and min() says "whatever this group holds" without claiming an
  -- ordering means anything.
  select q.agent_id, min(q.lead_id), min(q.merchant_id), max(q.version)
    into group_agent_id, group_lead_id, group_merchant_id, max_version
    from quotes q
   where q.quote_group_id = NEW.quote_group_id
   group by q.agent_id;

  if group_agent_id is not null and group_agent_id <> NEW.agent_id then
    -- Deliberately not naming the owner. "Not yours" and "does not exist"
    -- are already indistinguishable everywhere else here, and an error
    -- message is as good an id oracle as a status code.
    raise exception 'quote group belongs to another agent';
  end if;

  -- A GROUP CANNOT CHANGE WHO IT IS ABOUT, and this cannot be a CHECK for
  -- the reason the agent test above cannot: a CHECK sees one row, and
  -- this is a fact about its siblings.
  --
  -- Reachable without it, and not hypothetically: create_quote_version()
  -- takes a group id and an owner as separate arguments, so a rep passing
  -- their own group id with a different (also their own) merchant_id
  -- would add a "version 2" about another business entirely. Nothing
  -- would be leaked -- both records are theirs -- but the version history
  -- would be a record of two different negotiations, and the print route
  -- filters by owner, so it would render "version 2 of 1" on one page and
  -- "version 1 of 1" on the other. The append-only design is there to
  -- settle what a merchant was shown; a group spanning two merchants
  -- cannot.
  --
  -- `is distinct from` on both, so a NULL on either side compares as a
  -- real difference. Plain `<>` would be NULL -- not false -- for a lead
  -- quote whose group_merchant_id is null, and the `if` would not fire.
  if group_agent_id is not null
     and (group_lead_id     is distinct from NEW.lead_id
       or group_merchant_id is distinct from NEW.merchant_id) then
    raise exception 'quote group belongs to a different lead or merchant';
  end if;

  -- THE CUSTOMER NAME SNAPSHOT (20261009150000). Linked: overwritten from
  -- the record, whatever the caller sent -- the price lock's shape, for
  -- the same reason: the name on a linked document must be the record's.
  -- Definer is what lets this read the record even if the caller cannot;
  -- that is harmless, because the insert policy's WITH CHECK runs AFTER
  -- this BEFORE trigger and refuses the row, so a name computed for an
  -- invisible record is never written or returned. Unlinked: the typed
  -- name, trimmed; quotes_customer_name_not_blank refuses a blank one.
  if NEW.lead_id is not null then
    select coalesce(nullif(btrim(l.dba), ''),
                    nullif(btrim(l.merchant_legal_name), ''),
                    'Lead #' || l.id)
      into linked_name
      from leads l where l.id = NEW.lead_id;
  elsif NEW.merchant_id is not null then
    select coalesce(nullif(btrim(m.dba), ''),
                    nullif(btrim(m.legal_business_name), ''),
                    'Merchant #' || m.id)
      into linked_name
      from merchants m where m.id = NEW.merchant_id;
  end if;
  -- A link to a record that does not exist finds no name and keeps the
  -- typed one; the foreign key then refuses the row.
  NEW.customer_name := coalesce(linked_name, btrim(NEW.customer_name));

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
-- snapshot_quote_line_item() — THE PRICE LOCK.
--
-- A rep cannot put a price on a quote. This is the layer that makes that
-- true, and it is a trigger rather than any of the three more obvious
-- answers, each of which fails for its own reason:
--
--   * HIDING THE FIELD IN THE UI. Not a boundary at all. The grant below
--     is `grant select, insert on quote_line_items to authenticated` and
--     the insert policy only asks whether the parent quote is the
--     caller's -- so a rep's own session can POST a line item straight to
--     PostgREST with any unit_price it likes, on their own quote, and
--     every policy agrees. That is the hole this closes.
--
--   * A COLUMN-LEVEL GRANT, i.e. `grant insert (quote_id, product_id,
--     quantity, sort_order)` and no privilege on unit_price. This is the
--     right instinct -- it is exactly what makes `quotes.status` the only
--     mutable column, and CLAUDE.md's rule is that an immutable column is
--     a grant and not a policy. It does not work HERE, and the reason is
--     specific: create_quote_version() is `security INVOKER`, so it
--     inserts as the caller and would be refused its own snapshot. Making
--     it definer to get around that would trade a narrow problem for the
--     broad one invoker exists to avoid -- the caller's policies would
--     stop scoping every write inside it.
--
--   * REVOKING INSERT ON THE TABLE ENTIRELY. Same objection, same
--     reason: the invoker RPC needs it.
--
-- So: a BEFORE INSERT trigger that OVERWRITES the five snapshot columns
-- from products, whatever the caller supplied. It sits below every
-- caller -- the RPC, a direct PostgREST insert, a psql session -- and
-- there is no path to the table that skips it.
--
-- OVERWRITE RATHER THAN RAISE on a supplied price, which is the one
-- debatable call here. The argument for raising is CLAUDE.md's own: a
-- write the grant refuses is an error a rep can act on, where a write RLS
-- filters is a save that silently did nothing. It does not apply, because
-- nothing legitimate ever supplies a price -- create_quote_version()'s
-- signature has no parameter for one and the browser sends product_id and
-- quantity. A supplied price is therefore always a forged request, and
-- the honest treatment of a column the client does not own is to derive
-- it rather than to negotiate about it. `unit_price` is a DERIVED column
-- that happens not to be generated, because `generated always as` cannot
-- reach another table.
--
-- SECURITY DEFINER, and the reason is not reach. Every active user can
-- already read every product, so this sees nothing a caller could not.
-- It is definer so that the figure on a document cannot be changed by
-- changing a POLICY: an invoker trigger would read products through the
-- caller's own select policy, so narrowing that policy later would stop
-- the lookup finding a row and break the snapshot -- in a function whose
-- whole job is to be the layer nobody can weaken. Compare
-- enforce_compatibility_kinds(), which is invoker precisely because it
-- has no such claim to make.
--
-- IT ALSO RE-REFUSES what create_quote_version() refuses -- a product
-- that is absent, archived or unpriced. Not redundant: the RPC's checks
-- produce the message a rep can act on, and these cover the direct-insert
-- path where the RPC never ran. Without them an archived product would
-- reach `unit_price := null` and surface as a NOT NULL violation naming
-- the column instead of the cause.
-- =====================================================================
create or replace function snapshot_quote_line_item()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  p record;
begin
  select name, sku, list_price, billing, kind, archived_at
    into p
    from products
   where id = NEW.product_id;

  -- Checked rather than left to the foreign key, because a BEFORE trigger
  -- runs ahead of constraint checks: without this the assignments below
  -- would read NULL off an unassigned record and the insert would fail on
  -- `product_name` being null, naming a column rather than the cause.
  if not found then
    raise exception 'a quote line item must name a product that is in the catalog';
  end if;

  if p.archived_at is not null then
    raise exception 'a quote line item cannot name an archived product';
  end if;

  -- null means "not priced yet", never zero. Coalescing here is the exact
  -- failure products.list_price is nullable to prevent: it would put a
  -- free terminal on a document a merchant reads and raise nothing.
  if p.list_price is null then
    raise exception 'a quote line item must name a product that has a list price';
  end if;

  NEW.unit_price      := p.list_price;
  NEW.product_name    := p.name;
  NEW.product_sku     := p.sku;
  NEW.product_billing := p.billing;
  NEW.product_kind    := p.kind;

  return NEW;
end;
$$;

revoke all on function snapshot_quote_line_item() from public;
-- Trigger function: revoked and deliberately NOT granted, like
-- enforce_quote_version(), enforce_compatibility_kinds() and
-- set_updated_at(). A trigger fires whether or not the querying role
-- holds EXECUTE.
revoke all on function snapshot_quote_line_item() from anon, authenticated;

-- INSERT only. There is no UPDATE grant or policy on this table at either
-- layer, so there is no update to intercept -- and adding `or update`
-- here would quietly imply one exists.
create trigger quote_line_items_snapshot
  before insert on quote_line_items
  for each row execute function snapshot_quote_line_item();

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
-- EVERY PREVIOUS SIGNATURE IS DROPPED, NOT LEFT BESIDE THIS ONE -- the
-- 7-argument one in 20261007150000 and the 8-argument one (no customer
-- name) in 20261009150000. `create or replace function` with a different
-- parameter list creates a SECOND function rather than replacing the
-- first, and Postgres reports the resulting ambiguity at CALL time --
-- from the browser, as a failed save -- not in the migration. Exactly the
-- trap dashboard_counts() hit, and the same answer: drop the old
-- signature in the same migration, and assert in a test that the name
-- resolves to exactly one function.
--
-- No argument has a default, deliberately. supabase-js calls this with
-- named parameters so a default would cost nothing to use -- but it would
-- let a caller forget the customer and get a constraint violation instead
-- of a signature that made them say who the proposal is for.
--
-- customer_name_input is IGNORED for a linked proposal: the trigger
-- copies the record's name over it. It is the name for an unlinked one.
create or replace function create_quote_version(
  lead_id_input int,
  merchant_id_input int,
  customer_name_input text,
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
  -- Refused here as well as by the constraints, so the message says what
  -- to do. A constraint's own error names a constraint and a row; these
  -- name the choice the caller failed to make.
  if lead_id_input is not null and merchant_id_input is not null then
    raise exception 'a proposal is linked to at most one of a lead or a merchant';
  end if;

  if lead_id_input is null and merchant_id_input is null
     and btrim(coalesce(customer_name_input, '')) = '' then
    raise exception 'a proposal that is not linked to a lead or merchant needs a customer name';
  end if;

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
    quote_group_id, lead_id, merchant_id, customer_name, agent_id,
    status, title, notes
  )
  values (
    coalesce(quote_group_id_input, gen_random_uuid()),
    lead_id_input,
    merchant_id_input,
    customer_name_input,
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
  --
  -- Written here AND re-derived by snapshot_quote_line_item(), which is
  -- two layers computing the same thing from the same table in the same
  -- transaction, so they cannot disagree. Deliberate, and the same
  -- arrangement documents_file_key_matches_owner has with
  -- fileKeyMatchesOwner(): this copy is the one a reader of the RPC can
  -- see, and the trigger is the one no caller can skip. Either alone is
  -- correct; keeping both means dropping one does not open the hole.
  --
  -- `with ordinality` supplies sort_order from the array's own order, so
  -- the document renders in the order the rep built it rather than in
  -- whatever order the ids happen to sort. That is load-bearing rather
  -- than cosmetic now: the printed proposal reads its device/add-on
  -- GROUPING off (sort_order, product_kind), so the cart's order is what
  -- puts each add-on under the device it was chosen for.
  insert into quote_line_items (
    quote_id, product_id, quantity, unit_price,
    product_name, product_sku, product_billing, product_kind, sort_order
  )
  select
    new_quote_id,
    p.id,
    (elem.value ->> 'quantity')::int,
    p.list_price,
    p.name,
    p.sku,
    p.billing,
    p.kind,
    (elem.ord - 1)::int
  from jsonb_array_elements(line_items_input) with ordinality as elem(value, ord)
  join products p
    on p.id = (elem.value ->> 'product_id')::int
   and p.archived_at is null;

  return new_quote_id;
end;
$$;

revoke all on function create_quote_version(int, int, text, uuid, uuid, text, text, text, jsonb)
  from public;
grant execute on function create_quote_version(int, int, text, uuid, uuid, text, text, text, jsonb)
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

-- accounts_in_city() looks up by exactly this expression and nothing else, so
-- it is a plain btree over the key: equality only, by design (see norm_city).
create index idx_merchants_norm_city on merchants (norm_city(city));

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
-- CHANGED by 20261016160000: that constraint is now the PARTIAL index
-- rep_payout_rows_import_merge_key (where line_kind = 'import'), and the
-- planner cannot use a partial index for a bare `where period = $1`, which
-- does not imply its predicate. So that migration adds
-- idx_rep_payout_rows_period_agent on (period, agent_id), to serve what the
-- old constraint's index served.
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

-- EVERY MID CHANGE IS AUDITED (20261021120000; security fix phase 1).
--
-- Defense in depth behind "admin update only": the MID is the key
-- commit_residual_import_v2 and parse-residual-import find a merchant -- and
-- so its share -- by, so changing it while a month is in review changes who
-- gets paid. log_cross_agent_change() is silent when the editor owns the row,
-- which is exactly the case that hid the original attack; this trigger has no
-- ownership test at all. One `merchant_mid_changed` row per changed merchant,
-- for every caller: an admin, a service-role script (actor NULL, the
-- backfill convention), and anyone a future policy lets in by mistake.
--
-- Only an ACTUAL change: `update of mid` fires whenever mid is in the SET
-- list, so an edit form re-sending the same value would otherwise log noise.
-- The row records who, when and which merchant, not the values -- audit_log
-- has no column for them. Two rows for one merchant inside one review window
-- is the shape of a pad-and-restore.
--
-- FAILS CLOSED, like log_cross_agent_change(): no exception handler, so a
-- change that cannot be audited does not happen. BEFORE rather than AFTER so
-- it runs ahead of the row being written; either way it shares the update's
-- transaction. `security definer` because no caller holds INSERT on audit_log.
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

create trigger merchants_mid_audit
  before update of mid on merchants
  for each row execute function audit_merchant_mid_change();

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

  if tg_op = 'INSERT' then
    if new.status is distinct from 'draft' then
      raise exception
        'a pre-app is created as a draft; status moves only through submit_pre_app(), approve_pre_app(), decline_pre_app() or reopen_pre_app()'
        using errcode = 'PT409';
    end if;

    if new.date_submitted is not null then
      raise exception 'date_submitted is set by submit_pre_app()' using errcode = 'PT409';
    end if;

    -- The split and the rep's names are snapshotted by submit_pre_app()
    -- from the rep's profile (memo §0b.4, §7.1). A draft carries the
    -- defaults; nothing a client sends can pre-load them.
    if new.split_agent_pct is distinct from 50
       or new.split_company_pct is distinct from 50
       or new.rep_legal_name is not null
       or new.rep_llc_legal_name is not null then
      raise exception 'the split and the rep''s legal names are set by submit_pre_app() from the rep''s profile'
        using errcode = 'PT409';
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

  if new.split_agent_pct is distinct from old.split_agent_pct
     or new.split_company_pct is distinct from old.split_company_pct
     or new.rep_legal_name is distinct from old.rep_legal_name
     or new.rep_llc_legal_name is distinct from old.rep_llc_legal_name then
    raise exception 'the split and the rep''s legal names are set by submit_pre_app() from the rep''s profile'
      using errcode = 'PT409';
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
-- ---------------------------------------------------------------------
-- pre_app_missing_fields(pre_app_id_input int) returns jsonb
--
-- [{"code", "step", "label"}, ...] -- every item that blocks submission, in
-- wizard order, empty when the pre-app is submittable. Owner items also carry
-- "owner_id". Codes are stable (lib/pre-app-required.ts lists them, and
-- tests/unit/pre-app-required.test.ts pins that list to this body); labels are
-- written for a rep to read.
--
-- security definer, because it must see the zero-grant secrets tables. It
-- names no *_encrypted column: existence and kind only. The caller guard is
-- byte-for-byte pre_app_secrets_presence()'s, so "not yours" and "does not
-- exist" stay indistinguishable. Codes and labels only, never a value -- the
-- one exception is an owner's own name inside an owner label, which the
-- caller can already read on pre_app_owners.
--
-- No status check: the review step asks for any draft, and submit_pre_app()
-- checks status itself before calling this.
-- ---------------------------------------------------------------------
create or replace function pre_app_missing_fields(pre_app_id_input int)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  ws constant text := E' \t\n\r\f\x0b';
  pa pre_apps;
  rep profiles;
  bp pre_app_business_profile;
  o record;
  items jsonb := '[]'::jsonb;
  owner_count int;
  control_count int;
  tax_type_on_file text;
  who text;
  tax_step text;
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

  -- Business --------------------------------------------------------------
  if coalesce(btrim(pa.dba_name, ws), '') = '' then
    items := items || jsonb_build_object('code', 'dba_name', 'step', 'business',
      'label', 'A DBA name is required.');
  end if;
  if coalesce(btrim(pa.legal_business_name, ws), '') = '' then
    items := items || jsonb_build_object('code', 'legal_business_name', 'step', 'business',
      'label', 'A legal business name is required.');
  end if;
  if coalesce(btrim(pa.contact_phone, ws), '') = '' then
    items := items || jsonb_build_object('code', 'contact_phone', 'step', 'business',
      'label', 'A contact phone is required.');
  end if;
  if coalesce(btrim(pa.physical_address, ws), '') = '' then
    items := items || jsonb_build_object('code', 'physical_address', 'step', 'business',
      'label', 'A business street address is required.');
  end if;
  -- The location rule (20261013132000), moved here: the same test
  -- approve_pre_app() and merchants_location_guard apply, so a pre-app this
  -- accepts is one approval accepts.
  if coalesce(char_length(norm_city(pa.city)) < 2, true)
     or char_length(btrim(pa.city)) > 60 then
    items := items || jsonb_build_object('code', 'city', 'step', 'business',
      'label', 'A business city is required.');
  end if;
  if coalesce(upper(btrim(pa.state)) !~ '^[A-Z]{2}$', true) then
    items := items || jsonb_build_object('code', 'state', 'step', 'business',
      'label', 'A two-letter business state is required.');
  end if;
  if coalesce(btrim(pa.zip, ws), '') !~ '^\d{5}(-\d{4})?$' then
    items := items || jsonb_build_object('code', 'zip', 'step', 'business',
      'label', 'A business ZIP code is required.');
  end if;
  -- Always 'US' while pre_apps_country_us stands; checked anyway so the rule
  -- lives in the one list and survives that CHECK being relaxed.
  if pa.country is distinct from 'US' then
    items := items || jsonb_build_object('code', 'country', 'step', 'business',
      'label', 'The business country must be United States.');
  end if;
  if coalesce(btrim(pa.legal_entity_type, ws), '') = '' then
    items := items || jsonb_build_object('code', 'legal_entity_type', 'step', 'business',
      'label', 'An entity type is required.');
  end if;
  if coalesce(upper(btrim(pa.state_incorporated)) !~ '^[A-Z]{2}$', true) then
    items := items || jsonb_build_object('code', 'state_incorporated', 'step', 'business',
      'label', 'A state of incorporation is required.');
  end if;
  if coalesce(btrim(pa.business_type, ws), '') = '' then
    items := items || jsonb_build_object('code', 'business_type', 'step', 'business',
      'label', 'A business type is required.');
  end if;
  if coalesce(btrim(pa.bank_name, ws), '') = '' then
    items := items || jsonb_build_object('code', 'bank_name', 'step', 'business',
      'label', 'A bank name is required.');
  end if;
  -- Required and above zero (memo A13): a zero estimate is a placeholder.
  if coalesce(pa.est_annual_volume, 0) <= 0 then
    items := items || jsonb_build_object('code', 'est_annual_volume', 'step', 'business',
      'label', 'Estimated annual volume must be more than zero.');
  end if;
  if coalesce(pa.est_monthly_volume, 0) <= 0 then
    items := items || jsonb_build_object('code', 'est_monthly_volume', 'step', 'business',
      'label', 'Estimated monthly volume must be more than zero.');
  end if;
  if coalesce(pa.est_average_ticket, 0) <= 0 then
    items := items || jsonb_build_object('code', 'est_average_ticket', 'step', 'business',
      'label', 'Estimated average ticket must be more than zero.');
  end if;
  if coalesce(pa.est_high_ticket, 0) <= 0 then
    items := items || jsonb_build_object('code', 'est_high_ticket', 'step', 'business',
      'label', 'Estimated high ticket must be more than zero.');
  end if;

  -- Tax ID (the phase 3 rule, 20261026140000). A row in pre_app_tax_secrets
  -- OF THE CHOSEN KIND; only submit-pre-app-secrets writes one, after the
  -- value passed the EIN or SSN validator for that kind. Three labels, one
  -- code. The step is where the fix is: the type on Business, the number on
  -- Sensitive data.
  if not exists (
    select 1 from pre_app_tax_secrets t
     where t.pre_app_id = pa.id and t.tax_id_type = pa.ein_type
  ) then
    select t.tax_id_type into tax_type_on_file
      from pre_app_tax_secrets t where t.pre_app_id = pa.id;
    tax_step := case when pa.ein_type is null then 'business' else 'secrets' end;
    items := items || jsonb_build_object('code', 'tax_id', 'step', tax_step,
      'label', case
        when pa.ein_type is null then
          'Choose an EIN type (EIN or SSN), then enter the tax ID.'
        when tax_type_on_file is not null then
          format('The tax ID on file is an %s, but EIN type says %s. Enter the %s.',
                 tax_type_on_file, pa.ein_type, pa.ein_type)
        else format('The %s (tax ID) has not been entered.', pa.ein_type)
      end);
  end if;

  -- Owners ----------------------------------------------------------------
  select count(*), count(*) filter (where percent_owned >= 51)
    into owner_count, control_count
    from pre_app_owners where pre_app_id = pa.id;

  if owner_count = 0 then
    items := items || jsonb_build_object('code', 'owner_required', 'step', 'owners',
      'label', 'Add at least one owner.');
  elsif control_count = 0 then
    -- A genuine 50/50 partnership cannot be submitted: processors want one
    -- control person. The label has to read as a rule, not a bug.
    items := items || jsonb_build_object('code', 'owner_control', 'step', 'owners',
      'label', 'One owner must hold at least 51% ownership.');
  end if;

  for o in
    select ow.*, row_number() over (order by ow.id) as n
      from pre_app_owners ow
     where ow.pre_app_id = pa.id
     order by ow.id
  loop
    who := format('Owner %s%s', o.n,
      case when coalesce(btrim(o.owner_name, ws), '') = '' then ''
           else format(' (%s)', btrim(o.owner_name, ws)) end);

    items := items || (
      select coalesce(jsonb_agg(jsonb_build_object(
               'code', f.code, 'step', 'owners', 'owner_id', o.id,
               'label', format('%s: %s is required.', who, f.label))
             order by f.ord), '[]'::jsonb)
        from (values
          (1,  'owner_name',               'name',               coalesce(btrim(o.owner_name, ws), '') = ''),
          (2,  'owner_title',              'title',              coalesce(btrim(o.title, ws), '') = ''),
          (3,  'owner_percent_owned',      'percent owned',      coalesce(o.percent_owned, 0) <= 0),
          (4,  'owner_dob',                'date of birth',      o.dob is null),
          (5,  'owner_home_phone',         'home phone',         coalesce(btrim(o.home_phone, ws), '') = ''),
          (6,  'owner_id_type',            'ID type',            coalesce(btrim(o.id_type, ws), '') = ''),
          (7,  'owner_id_number',          'ID number',          coalesce(btrim(o.id_number, ws), '') = ''),
          (8,  'owner_id_state',           'ID state',           coalesce(upper(btrim(o.id_state)) !~ '^[A-Z]{2}$', true)),
          (9,  'owner_id_issue_date',      'ID issue date',      o.id_issue_date is null),
          (10, 'owner_id_expiration_date', 'ID expiration date', o.id_expiration_date is null),
          (11, 'owner_home_address',       'home street address', coalesce(btrim(o.home_address, ws), '') = ''),
          (12, 'owner_home_city',          'home city',          coalesce(btrim(o.home_city, ws), '') = ''),
          (13, 'owner_home_state',         'home state',         coalesce(upper(btrim(o.home_state)) !~ '^[A-Z]{2}$', true)),
          (14, 'owner_home_zip',           'home ZIP code',      coalesce(btrim(o.home_zip, ws), '') !~ '^\d{5}(-\d{4})?$'),
          (15, 'owner_home_country',       'home country (United States)', o.home_country is distinct from 'US'),
          (16, 'owner_length_of_ownership','length of ownership', coalesce(btrim(o.length_of_ownership, ws), '') = '')
        ) as f(ord, code, label, missing)
       where f.missing
    );

    if not exists (select 1 from pre_app_owner_secrets s where s.pre_app_owner_id = o.id) then
      items := items || jsonb_build_object('code', 'owner_ssn', 'step', 'secrets',
        'owner_id', o.id, 'label', format('%s: no SSN on file.', who));
    end if;
  end loop;

  -- Card mix: two independent pairs, each checked only when filled. moto and
  -- internet are informational and never summed.
  select * into bp from pre_app_business_profile where pre_app_id = pa.id;
  if found then
    if (bp.card_swiped_pct is not null or bp.card_keyed_pct is not null)
       and coalesce(bp.card_swiped_pct, 0) + coalesce(bp.card_keyed_pct, 0) <> 100 then
      items := items || jsonb_build_object('code', 'card_swiped_keyed_total', 'step', 'profile',
        'label', 'Swiped and keyed percentages must total 100.');
    end if;
    if (bp.card_present_pct is not null or bp.card_not_present_pct is not null)
       and coalesce(bp.card_present_pct, 0) + coalesce(bp.card_not_present_pct, 0) <> 100 then
      items := items || jsonb_build_object('code', 'card_present_total', 'step', 'profile',
        'label', 'Card-present and card-not-present percentages must total 100.');
    end if;
  end if;

  -- Banking: existence only. The RP password is deliberately not required.
  if not exists (select 1 from pre_app_banking_secrets where pre_app_id = pa.id) then
    items := items || jsonb_build_object('code', 'banking', 'step', 'secrets',
      'label', 'Banking details (routing and account number) have not been entered.');
  end if;

  -- Rep identity (memo §0.6, §7.1): the pre-app's rep, NOT the caller, so an
  -- admin submitting on a rep's behalf is held to the same rule. The profile
  -- CHECKs forbid blank, so null is the whole test.
  select * into rep from profiles where id = pa.agent_id;
  if rep.legal_name is null or rep.llc_legal_name is null then
    items := items || jsonb_build_object('code', 'rep_identity', 'step', 'review',
      'label', 'The rep''s legal name and LLC legal name are not on their profile yet. An admin adds them in Manage Users.');
  end if;

  return items;
end;
$$;

revoke all on function pre_app_missing_fields(int) from public;
grant execute on function pre_app_missing_fields(int) to authenticated, service_role;

-- Since 20261028120000 every completeness rule lives in
-- pre_app_missing_fields() above; this refuses with the whole list (PT422,
-- the labels in the message, the codes in DETAIL) and then snapshots the
-- rep's identity and split rate onto the pre-app.
create or replace function submit_pre_app(pre_app_id_input int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  pa       pre_apps;
  rep      profiles;
  missing  jsonb;
  n        int;
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

  missing := pre_app_missing_fields(pa.id);
  n := jsonb_array_length(missing);
  if n > 0 then
    raise exception '%',
      format('This pre-app cannot be submitted yet. %s missing: %s',
             case when n = 1 then 'One thing is' else n || ' things are' end,
             (select string_agg(m ->> 'label', ' ' order by ord)
                from jsonb_array_elements(missing) with ordinality as e(m, ord)))
      using errcode = 'PT422',
            detail = (select jsonb_agg(m ->> 'code' order by ord)
                        from jsonb_array_elements(missing) with ordinality as e(m, ord))::text;
  end if;

  -- The snapshot (memo §7.1, §0b.4). From the pre-app's rep, not the caller.
  -- rep_identity above guarantees both names are set; the coalesce is the A16
  -- rule written down where it applies (no LLC: the rep's own legal name),
  -- not a path the check above leaves open.
  select * into rep from profiles where id = pa.agent_id;

  perform set_config('tapswipe.pre_app_transition', 'on', true);
  update pre_apps
     set status = 'submitted',
         date_submitted = current_date,
         decline_reason = null,
         rep_legal_name = rep.legal_name,
         rep_llc_legal_name = coalesce(rep.llc_legal_name, rep.legal_name),
         split_agent_pct = rep.split_rate_pct,
         split_company_pct = 100 - rep.split_rate_pct
   where id = pa.id;
  perform set_config('tapswipe.pre_app_transition', '', true);

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
  --
  -- LOCATION (20261013130000). The business address is carried across --
  -- physical_address into street, city, state upper-cased, zip -- because
  -- merchants_location_guard refuses a new merchant without one. A pre-app
  -- submitted before 20261013132000 may lack a city or state (submission did
  -- not require them until then), and such a pre-app CANNOT be approved: it is
  -- refused here by name, before any write, rather than left to fail on the
  -- constraint with a message that names a constraint instead of a fix. The
  -- fix is to reopen it and have the rep fill the address in.
  if coalesce(char_length(norm_city(pa.city)) < 2, true)
     or char_length(btrim(pa.city)) > 60
     or coalesce(upper(btrim(pa.state)) !~ '^[A-Z]{2}$', true) then
    raise exception 'pre-app % needs a city and a two-letter state before it can be approved',
      pre_app_id_input using errcode = 'PT409';
  end if;

  -- PROCESSOR (20261023130000). Copied as-is, NULL included: the FK on both
  -- columns means a value the pre-app holds is one the merchant accepts, so
  -- nothing here can fail on it.
  insert into merchants (agent_id, dba, legal_business_name, status,
                         split_agent_pct, split_company_pct, pre_app_id,
                         street, city, state, zip, processor)
  values (pa.agent_id, pa.dba_name, pa.legal_business_name, 'active',
          pa.split_agent_pct, pa.split_company_pct, pa.id,
          nullif(btrim(pa.physical_address), ''), btrim(pa.city),
          upper(btrim(pa.state)), nullif(btrim(pa.zip), ''), pa.processor)
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
-- tax_id_on_file / tax_id_type_on_file (20261026140000): whether a tax-id row
-- OF THE PRE-APP'S CURRENT ein_type exists -- what submit_pre_app() counts --
-- and which kind the stored row is, so the wizard can say "the tax ID on file
-- is an EIN, but EIN type says SSN" instead of a bare "not on file". The kind
-- is plaintext metadata, never the number. Adding columns changes the return
-- type, so the migration drops and recreates the function and its grants.
create or replace function pre_app_secrets_presence(pre_app_id_input int)
returns table (
  banking_on_file boolean,
  owners_missing_ssn int,
  tax_id_on_file boolean,
  tax_id_type_on_file text
)
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
      ),
      exists (
        select 1 from pre_app_tax_secrets t
         where t.pre_app_id = pa.id and t.tax_id_type = pa.ein_type
      ),
      (select t.tax_id_type from pre_app_tax_secrets t where t.pre_app_id = pa.id);
end;
$$;

revoke all on function pre_app_secrets_presence(int) from public;
grant execute on function pre_app_secrets_presence(int) to authenticated, service_role;

-- =====================================================================
-- PRE-APP SECRET REVEAL — Tier 2 (20261028140000; phase 5 of
-- docs/design/intake-and-reports.md, §1.E and A24). The audit row and the
-- rate limit behind an admin's per-field "Show".
--
-- Since this migration read-pre-app-secrets answers EVERY default read --
-- rep and admin alike -- with last four (presence only for the RP password).
-- A full value leaves the Edge Function only on a request naming ONE field
-- (`reveal`), only for an admin, and only after this function has returned.
-- So the trail separates a glance (read_pre_app_secrets:last4) from a look.
--
-- Why SQL and not an insert from the Edge Function: the count and the insert
-- must be one atomic step per admin (pg_advisory_xact_lock), exactly as
-- accounts_in_city() counts a rep's searches, and audit_log has no insert
-- policy for anyone to borrow.
--
--   * is_admin() first: a rep, a deactivated admin and anon are refused before
--     anything is counted or written.
--   * One audit_log row per reveal: actor_id the admin, row_id the pre-app,
--     created_at the time, and the field in the action --
--       read_pre_app_secrets:reveal:<field>
--       read_pre_app_secrets:reveal:owner_ssn:<pre_app_owner_id>
--     No exception handler (fails closed): no row, no value.
--   * 30 reveals per admin per rolling hour (PT429 on the 31st, with a
--     showable message). Default reads do not count.
--   * It names no *_secrets table and decrypts nothing -- the key lives only
--     in the Edge Function -- so an admin calling it directly can only write an
--     audit row against themselves.
-- =====================================================================
create function record_pre_app_secret_reveal(
  pre_app_id_input int,
  field_input text,
  pre_app_owner_id_input int default null
)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  recent_reveals int;
  oldest_reveal timestamptz;
  wait_minutes int;
begin
  if not is_admin() then
    raise exception 'Only an admin can reveal a full value.' using errcode = 'PT403';
  end if;

  if field_input is null
     or field_input not in ('owner_ssn', 'aba_routing', 'account_number', 'rp_password', 'tax_id') then
    raise exception 'Unknown secret field.' using errcode = '22023';
  end if;
  if (field_input = 'owner_ssn') <> (pre_app_owner_id_input is not null) then
    raise exception 'An owner is named for an owner SSN, and only for one.' using errcode = '22023';
  end if;

  if not exists (select 1 from pre_apps where id = pre_app_id_input) then
    raise exception 'pre-app not found' using errcode = 'PT404';
  end if;
  if pre_app_owner_id_input is not null and not exists (
    select 1 from pre_app_owners
     where id = pre_app_owner_id_input and pre_app_id = pre_app_id_input
  ) then
    raise exception 'pre-app not found' using errcode = 'PT404';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('reveal_pre_app_secret:' || auth.uid()::text, 0));
  select count(*), min(a.created_at)
    into recent_reveals, oldest_reveal
    from audit_log a
   where a.actor_id = auth.uid()
     and a.action like 'read_pre_app_secrets:reveal:%'
     and a.created_at > now() - interval '1 hour';
  if recent_reveals >= 30 then
    wait_minutes := greatest(1, ceil(extract(epoch from
                      (oldest_reveal + interval '1 hour' - now())) / 60)::int);
    raise exception 'You have reached the limit of 30 reveals an hour. Try again in % minute%.',
      wait_minutes, case when wait_minutes = 1 then '' else 's' end
      using errcode = 'PT429';
  end if;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (
    auth.uid(),
    'read_pre_app_secrets:reveal:' || field_input
      || coalesce(':' || pre_app_owner_id_input::text, ''),
    'pre_apps',
    pre_app_id_input::text
  );
end;
$$;

revoke all on function record_pre_app_secret_reveal(int, text, int) from public;
grant execute on function record_pre_app_secret_reveal(int, text, int) to authenticated, service_role;

-- The rate limit's count: one admin's reveal rows in the last hour.
create index audit_log_secret_reveal_idx on audit_log (actor_id, created_at)
  where action like 'read_pre_app_secrets:reveal:%';

-- =====================================================================
-- IMPORT SCHEMA (20261030120000) — the database half of the residual
-- import redesign: processor and month on a batch, one committed batch per
-- (processor, month), the paid-month table, the confirmed-negative-volume
-- marker, and the merge key with the processor in it. Phase 6 of
-- docs/design/intake-and-reports.md (§1.F-G, §2.1-2.4, §3.2, §8.1, §8.4).
--
-- DATABASE ONLY, AND THE CURRENT IMPORT KEEPS WORKING. No parser, upload
-- page or commit logic changes here (phases 7 and 8). The one Edge Function
-- that creates batches, residual-import-file-url, still sends neither a
-- processor nor a month, so both new batch columns are NULLABLE in this
-- phase and every rule below is written to hold for a batch that has them
-- and to leave a batch that does not exactly as it was:
--
--   rep_payout_batches
--     processor  text references processors(code)       (memo §1.B)
--     period     date, the 1st of a month                 (memo §2.2)
--       Set together or not at all
--       (rep_payout_batches_processor_period_together), so a batch can never
--       carry a processor with no month -- the one shape that would slip past
--       the one-committed rule below. The period must be the 1st
--       (rep_payout_batches_period_first_of_month) and inside the import
--       window, checked by guard_payout_batch_period() (memo A11): not after
--       the current month, and not more than 24 months before it -- the
--       month exactly 24 back is accepted, 25 back is refused. "Current
--       month" is the month of now() in UTC, pinned so the answer does not
--       depend on a session's TimeZone. A TRIGGER, not a CHECK, because the
--       window moves: a CHECK reading the clock would pass on insert and then
--       refuse the same row on a dump/restore two years later. The trigger
--       checks the period only when it is written (INSERT, or an UPDATE that
--       changes it), so an old batch stays valid as it ages.
--     replaces_batch_id, replaced_by_batch_id  int references
--       rep_payout_batches(id)                            (memo §2.2, §3.2)
--       The two ends of a replace. Neither may point at its own row, a
--       batch that replaces another must carry a processor and month (a
--       replace is per processor-month), and replaced_by_batch_id is set
--       EXACTLY when status = 'replaced' (rep_payout_batches_replaced_by_
--       when_replaced). Nothing writes them yet: phase 9 builds the replace.
--     status gains 'replaced'. A replaced batch is no longer 'committed', so
--       it drops out of the rule below and its successor can commit. The
--       client rule is unchanged: guard_batch_status_transition() still
--       admits only review -> abandoned from a signed-in session, so a
--       client can never set 'replaced'; only a definer function can (phase
--       9). Transitions among definer writers ('committed' -> 'replaced'
--       only, 'replaced' terminal) are phase 9's to enforce.
--
--   rep_payout_batches_one_committed_per_month
--     unique (processor, period) where status = 'committed'
--     A second committed batch for the same processor and month is
--     impossible, whoever writes it. Review and abandoned batches are not
--     limited (an admin may upload a corrected file while the first is in
--     review), and nor are replaced ones. A batch with NO processor -- every
--     batch today -- is outside it (NULLs are distinct in this index on
--     purpose: those batches have no month to be unique on).
--
--   rep_payout_import_rows (staging)
--     warnings text[] not null default '{}', each element one of the three
--       confirmable warning types (memo §2.4): processor_mismatch,
--       inactive_merchant, bad_numbers.
--     blocker vocabulary WIDENED with the six new codes (unknown_mid,
--       duplicate_mid, mid_in_other_batch, wrong_income_type,
--       missing_figure, unreadable_number). The five old codes stay, because
--       the parser that writes them is still the deployed one; phase 7
--       removes them with it.
--
--   rep_payout_rows (the ledger)
--     processor text references processors(code). A snapshot of the
--       batch's processor on import lines. NULL on every line written before
--       a batch carries one, and on adjustment lines.
--     volume_confirmed_negative boolean not null default false. The marker
--       for a line whose negative volume an admin confirmed (memo §2.4,
--       bad_numbers). rep_payout_rows_volume_check, which was
--       `volume >= 0`, becomes `volume_confirmed_negative = coalesce(volume
--       < 0, false)`: a negative volume is allowed ONLY on a marked line,
--       and the marker is allowed only on a line whose volume IS negative, so
--       the column says exactly which lines entered that way. Zero volume,
--       and a NULL one, stay allowed unmarked. No client can set the marker:
--       authenticated holds UPDATE on residual_income and rep_split_pct
--       only. The writer is commit v3 (phase 8), for a row whose
--       bad_numbers warning was confirmed.
--     THE MERGE KEY GAINS THE PROCESSOR. rep_payout_rows_import_merge_key,
--       which was `(period, agent_id, mid) where line_kind = 'import'`,
--       becomes `(period, processor, agent_id, mid) NULLS NOT DISTINCT
--       where line_kind = 'import'` (memo §2.1). The predicate is KEPT, and
--       every ON CONFLICT still names it. NULLS NOT DISTINCT is what keeps
--       today's import working unchanged: every line today has a NULL
--       processor, and with the default (NULLs distinct) two NULL-processor
--       lines on one key would no longer collide, so a re-import would
--       duplicate a month instead of merging into it.
--
--   Both commit functions are re-created with that one change -- the
--   conflict target names the processor, the insert writes batch.processor,
--   and v2's partner line copies its signer line's processor -- and nothing
--   else. THE COALESCE MERGE RULE IS UNTOUCHED in
--   both: `coalesce(excluded.residual_income, rep_payout_rows.residual_
--   income)` and the same for rep_split_pct, in commit_residual_import()
--   and in v2's step 3 (ordinary rows). Phase 8 retires it in v3 (which
--   never merges: a second import of a processor-month is a replace) and
--   drops v2; phase 13 drops commit_residual_import() and the rule's
--   CLAUDE.md text with it.
--
--   payout_period_closures -- "Mark paid" (memo §3.2, A8). One row per
--     (period, processor) that an admin has marked paid. Columns exactly as
--     the memo specifies: period, processor, closed_at. NO closed_by: who
--     marked it is the audit_log row the trigger below writes (actor_id =
--     auth.uid()), which keeps the profiles foreign-key count at 25 (decided
--     30 Oct 2026, following the memo). The typed confirmation is a UI step
--     (phase 9) and is stored nowhere.
--     * Admin SELECT through RLS; SELECT is the only grant, to
--       authenticated and service_role. No client write of any kind: the
--       writers are phase 9's close_payout_period() (an insert) and
--       reopen_payout_period() (a delete, its written reason kept on a
--       payout_period_reopenings row that phase 9 adds), both security
--       definer, so neither needs a grant.
--     * A closure is never edited. guard_payout_period_closure() refuses
--       every UPDATE (close is an insert, reopen is a delete) and a closure
--       for a month after the current one.
--     * EVERY VERB IS AUDITED HERE, at the table, by
--       log_payout_period_closure(): AFTER INSERT writes
--       'close_payout_period', AFTER DELETE writes 'reopen_payout_period',
--       table_name 'payout_period_closures', row_id '<period>/<processor>'
--       (for example '2026-07-01/TSYS'). It fails closed (no EXCEPTION
--       block), so a closure cannot land or go without its audit row. Phase
--       9's two functions therefore write no audit row of their own for the
--       closure itself (a second one would double the trail); the reopen's
--       reason goes on its reopenings row. UPDATE is refused, so it needs no
--       audit; TRUNCATE fires no row trigger and is not a client verb (the
--       reset script's own marker row covers it).
--
-- WHAT THIS DOES NOT DO, and which phase does:
--   * A batch's processor and month are not yet REQUIRED (phase 7 sets them
--     at upload; the phase that makes them NOT NULL must first refuse, by
--     id, any committed batch that has none).
--   * Nothing yet checks a staged row's period against its batch's period
--     (phase 8: v3 takes the month from the batch).
--   * A NULL-processor import line and a processor-tagged one are different
--     keys now, so a legacy month re-imported under a processor would sit
--     beside the old lines rather than merge. No path writes a processor-
--     tagged line until phase 7; its mid_in_other_batch blocker (memo §2.4)
--     must count a NULL-processor line as "another processor's".
--
-- REFUSES TO RUN over rows it cannot carry, naming them, and otherwise
-- changes no existing row. What it checks first:
--   1. no ledger line has a negative volume. Impossible under the old
--      CHECK, so this only fires on a project where that CHECK was altered
--      by hand; such a line would need a confirmation nobody gave, so it is
--      named (by id) rather than silently marked.
--   2. the four definitions it replaces are exactly the ones it expects
--      (merge key, volume CHECK, status CHECK, blocker CHECK), so a project
--      whose definitions were hand-altered stops rather than losing
--      something quietly.
-- Not "the tables must be empty": the hermetic suites seed rows and replay
-- later migrations over them (the phase 1 lesson), and every row they seed
-- is one this migration carries unchanged.
-- =====================================================================

-- 0. What this migration cannot carry, named; then the definitions it
-- replaces, checked.
do $$
declare
  bad text;
  definition text;
begin
  select string_agg(id::text, ', ' order by id) into bad
    from rep_payout_rows where volume < 0;
  if bad is not null then
    raise exception 'import schema migration refuses to run: rep_payout_rows line(s) % have a negative volume that no admin confirmed. Correct or remove them deliberately, then re-run.', bad;
  end if;

  select indexdef into definition from pg_indexes
   where schemaname = 'public' and indexname = 'rep_payout_rows_import_merge_key';
  if definition is distinct from
     'CREATE UNIQUE INDEX rep_payout_rows_import_merge_key ON public.rep_payout_rows USING btree (period, agent_id, mid) WHERE (line_kind = ''import''::text)' then
    raise exception 'rep_payout_rows_import_merge_key is not the (period, agent_id, mid) import key here (found: %). Inspect it before applying 20261030120000.',
      coalesce(definition, 'no such index');
  end if;

  select pg_get_constraintdef(oid) into definition from pg_constraint
   where conrelid = 'public.rep_payout_rows'::regclass and conname = 'rep_payout_rows_volume_check';
  if definition is distinct from 'CHECK ((volume >= (0)::numeric))' then
    raise exception 'rep_payout_rows_volume_check is not CHECK (volume >= 0) here (found: %). Inspect it before applying 20261030120000.',
      coalesce(definition, 'no such constraint');
  end if;

  select pg_get_constraintdef(oid) into definition from pg_constraint
   where conrelid = 'public.rep_payout_batches'::regclass and conname = 'rep_payout_batches_status_check';
  if definition is distinct from
     'CHECK ((status = ANY (ARRAY[''review''::text, ''committed''::text, ''abandoned''::text])))' then
    raise exception 'rep_payout_batches_status_check is not (review, committed, abandoned) here (found: %). Inspect it before applying 20261030120000.',
      coalesce(definition, 'no such constraint');
  end if;

  select pg_get_constraintdef(oid) into definition from pg_constraint
   where conrelid = 'public.rep_payout_import_rows'::regclass and conname = 'rep_payout_import_rows_blocker_check';
  if definition is distinct from
     'CHECK ((blocker = ANY (ARRAY[''unknown_agent''::text, ''unparseable_period''::text, ''bad_number''::text, ''missing_mid''::text, ''duplicate_in_file''::text])))' then
    raise exception 'rep_payout_import_rows_blocker_check is not the five-code vocabulary here (found: %). Inspect it before applying 20261030120000.',
      coalesce(definition, 'no such constraint');
  end if;
end $$;

-- 1. Batches: processor, month, the replace pair, status 'replaced'.
alter table rep_payout_batches
  add column processor text
    constraint rep_payout_batches_processor_fkey references processors(code),
  add column period date
    constraint rep_payout_batches_period_first_of_month
      check (extract(day from period) = 1),
  add column replaces_batch_id int
    constraint rep_payout_batches_replaces_batch_id_fkey
      references rep_payout_batches(id),
  add column replaced_by_batch_id int
    constraint rep_payout_batches_replaced_by_batch_id_fkey
      references rep_payout_batches(id);

alter table rep_payout_batches
  add constraint rep_payout_batches_processor_period_together
    check ((processor is null) = (period is null)),
  add constraint rep_payout_batches_replace_pair_not_self
    check (replaces_batch_id <> id and replaced_by_batch_id <> id),
  add constraint rep_payout_batches_replace_needs_month
    check (replaces_batch_id is null or processor is not null),
  add constraint rep_payout_batches_replaced_by_when_replaced
    check ((status = 'replaced') = (replaced_by_batch_id is not null));

alter table rep_payout_batches drop constraint rep_payout_batches_status_check;
alter table rep_payout_batches
  add constraint rep_payout_batches_status_check
    check (status in ('review', 'committed', 'abandoned', 'replaced'));

create unique index rep_payout_batches_one_committed_per_month
  on rep_payout_batches (processor, period)
  where status = 'committed';

-- The import window (memo A11). Invoker: it reads nothing but the clock.
create or replace function guard_payout_batch_period()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  this_month date := date_trunc('month', now() at time zone 'UTC')::date;
begin
  if new.period is not null
     and (tg_op = 'INSERT' or new.period is distinct from old.period) then
    if new.period > this_month then
      raise exception 'The import month % is in the future. Choose the month the residuals are for.',
        to_char(new.period, 'FMMonth YYYY')
        using errcode = 'PT400';
    end if;
    if new.period < (this_month - interval '24 months')::date then
      raise exception 'The import month % is more than 24 months ago. Post an adjustment for a month that old instead.',
        to_char(new.period, 'FMMonth YYYY')
        using errcode = 'PT400';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function guard_payout_batch_period() from public;

create trigger rep_payout_batches_period_window
  before insert or update of period on rep_payout_batches
  for each row execute function guard_payout_batch_period();

-- 2. Staging: the warnings, and the new blocker codes beside the old ones.
alter table rep_payout_import_rows
  add column warnings text[] not null default '{}'
    constraint rep_payout_import_rows_warnings_vocabulary
      check (warnings <@ array['processor_mismatch', 'inactive_merchant',
                               'bad_numbers']::text[]);

alter table rep_payout_import_rows drop constraint rep_payout_import_rows_blocker_check;
alter table rep_payout_import_rows
  add constraint rep_payout_import_rows_blocker_check check (blocker in (
    -- the deployed parser's codes; phase 7 removes them with it
    'unknown_agent', 'unparseable_period', 'bad_number',
    'missing_mid', 'duplicate_in_file',
    -- memo §2.4
    'unknown_mid', 'duplicate_mid', 'mid_in_other_batch',
    'wrong_income_type', 'missing_figure', 'unreadable_number'
  ));

-- 3. The ledger: the processor snapshot, the marker, the volume rule, the key.
alter table rep_payout_rows
  add column processor text
    constraint rep_payout_rows_processor_fkey references processors(code),
  add column volume_confirmed_negative boolean not null default false;

alter table rep_payout_rows drop constraint rep_payout_rows_volume_check;
alter table rep_payout_rows
  add constraint rep_payout_rows_volume_check
    check (volume_confirmed_negative = coalesce(volume < 0, false));

drop index rep_payout_rows_import_merge_key;
create unique index rep_payout_rows_import_merge_key
  on rep_payout_rows (period, processor, agent_id, mid) nulls not distinct
  where line_kind = 'import';

-- 4. Both commit functions: the processor on every insert and in every
-- conflict target, v2's partner line taking its signer line's. Otherwise the bodies of 20261016160000, unchanged -- THE COALESCE
-- included.


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

  -- THE SHARE GUARD (20261016120000), the one addition. Message reworded in
  -- 20261016140000: only an app version older than v2 reaches this.
  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  if exists (
    select 1
      from rep_payout_import_rows r
      join merchants m on m.mid = r.mid_raw
      join merchant_rep_shares s
        on s.merchant_id = m.id
       and r.period >= s.effective_from
       and (s.effective_to is null or r.period < s.effective_to)
     where r.batch_id = batch_id_input
  ) then
    raise exception 'This import contains shared accounts, which this version of the CRM cannot commit. It needs the current version of the app.'
      using errcode = 'PT409';
  end if;

  insert into rep_payout_rows (
    agent_id, period, mid, merchant_name, merchant_id,
    volume, average_ticket, total_cost,
    residual_income, rep_split_pct, batch_id, processor
  )
  select
    r.agent_id, r.period, r.mid_raw, r.merchant_name_raw, r.merchant_id,
    r.volume, r.average_ticket, r.total_cost,
    r.residual_income, r.rep_split_pct, batch_id_input, batch.processor
    from rep_payout_import_rows r
   where r.batch_id = batch_id_input
  on conflict (period, processor, agent_id, mid) where line_kind = 'import' do update set
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

create or replace function commit_residual_import_v2(batch_id_input int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  batch       rep_payout_batches;
  blocked     int;
  staged      int;
  ordinary    int;
  shared      int;
  skipped     int;
  skip_record jsonb;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  -- The old function's guards, in its order, with its messages.
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

  -- 1. The share lock, before merchant_rep_shares is read.
  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  -- 2. The plan: every staged row, its share (if one covers it), and what
  -- happens to it. Taken before any write.
  drop table if exists pg_temp.residual_commit_plan;

  create temporary table residual_commit_plan on commit drop as
  select r.id as staging_id,
         r.row_number,
         r.period,
         r.mid_raw,
         r.agent_number_raw,
         s.id as share_id,
         s.secondary_agent_id,
         s.primary_rep_pct,
         s.secondary_rep_pct,
         case
           when s.id is null then 'ordinary'
           when r.agent_id = s.secondary_agent_id then 'partner_named'
           when r.agent_id <> s.primary_agent_id then 'ordinary'
           when exists (
             select 1 from rep_payout_rows l
              where l.period = r.period
                and l.mid = r.mid_raw
                and l.line_kind = 'import'
                and l.agent_id in (s.primary_agent_id, s.secondary_agent_id)
                and (l.rep_share_id is distinct from s.id
                     or l.share_role is distinct from
                        case when l.agent_id = s.primary_agent_id
                             then 'primary' else 'secondary' end)
           ) then 'line_not_shared'
           else 'shared'
         end as plan
    from rep_payout_import_rows r
    left join merchants m on m.mid = r.mid_raw
    left join merchant_rep_shares s
      on s.merchant_id = m.id
     and r.period >= s.effective_from
     and (s.effective_to is null or r.period < s.effective_to)
   where r.batch_id = batch_id_input;

  -- 3. Ordinary rows: the old upsert, with one predicate added.
  insert into rep_payout_rows (
    agent_id, period, mid, merchant_name, merchant_id,
    volume, average_ticket, total_cost,
    residual_income, rep_split_pct, batch_id, processor
  )
  select
    r.agent_id, r.period, r.mid_raw, r.merchant_name_raw, r.merchant_id,
    r.volume, r.average_ticket, r.total_cost,
    r.residual_income, r.rep_split_pct, batch_id_input, batch.processor
    from rep_payout_import_rows r
   where r.batch_id = batch_id_input
     and r.id in (select p.staging_id from pg_temp.residual_commit_plan p
                   where p.plan = 'ordinary')
  on conflict (period, processor, agent_id, mid) where line_kind = 'import' do update set
    merchant_name   = excluded.merchant_name,
    merchant_id     = excluded.merchant_id,
    volume          = excluded.volume,
    average_ticket  = excluded.average_ticket,
    total_cost      = excluded.total_cost,
    -- THE COALESCE. Kept, not cleared, unless the file said otherwise.
    residual_income = coalesce(excluded.residual_income,
                               rep_payout_rows.residual_income),
    rep_split_pct   = coalesce(excluded.rep_split_pct,
                               rep_payout_rows.rep_split_pct),
    batch_id        = excluded.batch_id;

  get diagnostics ordinary = row_count;

  -- 4a. Shared rows, the signer's line. The file's residual and rate are not
  -- read: NULL on insert, and on conflict only the file columns are written.
  insert into rep_payout_rows (
    agent_id, period, mid, merchant_name, merchant_id,
    volume, average_ticket, total_cost,
    residual_income, rep_split_pct, batch_id,
    rep_share_id, share_role, primary_rep_pct, secondary_rep_pct,
    account_residual_income, processor
  )
  select
    r.agent_id, r.period, r.mid_raw, r.merchant_name_raw, r.merchant_id,
    r.volume, r.average_ticket, r.total_cost,
    null, null, batch_id_input,
    p.share_id, 'primary', p.primary_rep_pct, p.secondary_rep_pct,
    null, batch.processor
    from rep_payout_import_rows r
    join pg_temp.residual_commit_plan p on p.staging_id = r.id
   where r.batch_id = batch_id_input
     and p.plan = 'shared'
  on conflict (period, processor, agent_id, mid) where line_kind = 'import' do update set
    -- NEVER THE MONEY ON CONFLICT (design §5.3). File columns only.
    merchant_name   = excluded.merchant_name,
    merchant_id     = excluded.merchant_id,
    volume          = excluded.volume,
    average_ticket  = excluded.average_ticket,
    total_cost      = excluded.total_cost,
    batch_id        = excluded.batch_id;

  get diagnostics shared = row_count;

  -- 4b. The partner's line, from the signer's line as it now stands: on a
  -- first commit that carries no figures; if only the partner's line was
  -- missing, it is rebuilt from the signer's account figure and rate.
  insert into rep_payout_rows (
    agent_id, period, mid, merchant_name, merchant_id,
    volume, average_ticket, total_cost,
    residual_income, rep_split_pct, batch_id,
    rep_share_id, share_role, primary_rep_pct, secondary_rep_pct,
    account_residual_income, processor
  )
  select
    p.secondary_agent_id, sl.period, sl.mid, sl.merchant_name, sl.merchant_id,
    null, null, null,
    shared_part(sl.account_residual_income, sl.secondary_rep_pct,
                sl.primary_rep_pct + sl.secondary_rep_pct),
    sl.rep_split_pct, batch_id_input,
    sl.rep_share_id, 'secondary', sl.primary_rep_pct, sl.secondary_rep_pct,
    sl.account_residual_income, sl.processor
    from pg_temp.residual_commit_plan p
    join rep_payout_import_rows r on r.id = p.staging_id
    join rep_payout_rows sl
      on sl.period = p.period
     and sl.agent_id = r.agent_id
     and sl.mid = p.mid_raw
     and sl.rep_share_id = p.share_id
     and sl.share_role = 'primary'
   where p.plan = 'shared'
  on conflict (period, processor, agent_id, mid) where line_kind = 'import' do nothing;

  -- 5. What was not applied, kept on the batch.
  select count(*),
         coalesce(jsonb_agg(jsonb_build_object(
                    'row_number',   p.row_number,
                    'period',       to_char(p.period, 'YYYY-MM-DD'),
                    'mid',          p.mid_raw,
                    'agent_number', p.agent_number_raw,
                    'reason',       p.plan)
                  order by p.row_number), '[]'::jsonb)
    into skipped, skip_record
    from pg_temp.residual_commit_plan p
   where p.plan in ('partner_named', 'line_not_shared');

  drop table pg_temp.residual_commit_plan;

  -- 6. As the old function: staging delete, status flip, one audit row.
  delete from rep_payout_import_rows where batch_id = batch_id_input;

  update rep_payout_batches
     set status = 'committed', committed_at = now(), row_count = staged,
         skipped_rows = skip_record
   where id = batch_id_input;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'commit_residual_import', 'rep_payout_batches',
          batch_id_input::text);

  return jsonb_build_object('written', ordinary + shared, 'skipped', skipped);
end;
$$;

revoke all on function commit_residual_import_v2(int) from public;
grant execute on function commit_residual_import_v2(int) to authenticated, service_role;


-- 5. payout_period_closures: Mark paid, per processor and month.
create table payout_period_closures (
  period date not null
    constraint payout_period_closures_period_first_of_month
      check (extract(day from period) = 1),
  processor text not null
    constraint payout_period_closures_processor_fkey references processors(code),
  closed_at timestamptz not null default now(),
  primary key (period, processor)
);

-- The four-step checklist with step 1 struck out (a closure belongs to no
-- rep) and step 3 one policy: there is no client write for a policy to admit.
alter table payout_period_closures enable row level security;

create policy "admin only select" on payout_period_closures
  for select using (is_admin());

-- SELECT only, and `revoke all` first, for the reason processors gives
-- (20261023130000: the local stack's default ACL hands service_role
-- TRUNCATE/REFERENCES/TRIGGER/MAINTAIN on every new table). No sequence: the
-- key is natural. Never anything for anon.
revoke all on payout_period_closures from anon, authenticated, service_role;
grant select on payout_period_closures to authenticated;
grant select on payout_period_closures to service_role;

-- A closure is inserted (close) or deleted (reopen), never edited, and never
-- for a month that has not begun.
create or replace function guard_payout_period_closure()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'A paid month is not edited. Reopen it (with a reason) instead.'
      using errcode = 'PT409';
  end if;
  if new.period > date_trunc('month', now() at time zone 'UTC')::date then
    raise exception 'The month % has not begun, so it cannot be marked paid.',
      to_char(new.period, 'FMMonth YYYY')
      using errcode = 'PT400';
  end if;
  return new;
end;
$$;

revoke all on function guard_payout_period_closure() from public;

create trigger payout_period_closures_guard
  before insert or update on payout_period_closures
  for each row execute function guard_payout_period_closure();

-- Every verb audited at the table. Definer, because audit_log has no insert
-- policy and authenticated holds SELECT on it only. Fails closed: no
-- EXCEPTION block, so the audit insert failing undoes the close or reopen.
create or replace function log_payout_period_closure()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  closure payout_period_closures;
begin
  if tg_op = 'DELETE' then
    closure := old;
  else
    closure := new;
  end if;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(),
          case tg_op when 'INSERT' then 'close_payout_period'
                     else 'reopen_payout_period' end,
          'payout_period_closures',
          to_char(closure.period, 'YYYY-MM-DD') || '/' || closure.processor);

  return null;
end;
$$;

revoke all on function log_payout_period_closure() from public;

create trigger payout_period_closures_audit
  after insert or delete on payout_period_closures
  for each row execute function log_payout_period_closure();

-- =====================================================================
-- IMPORT PARSER (20261030140000) — the database half of phase 7 of
-- docs/design/intake-and-reports.md (§1.G, §2.2, §2.4): the six-column
-- processor file, the payee found by MID, the new refusals and warnings,
-- and processor and month REQUIRED on every new batch.
--
--   rep_payout_batches
--     PROCESSOR AND MONTH ARE REQUIRED ON NEW BATCHES. Phase 6 left both
--       nullable because the upload did not send them; residual-import-
--       file-url now always does. Not a NOT NULL, because review and
--       abandoned batches started before this migration have neither, and
--       there is no honest value to give them (memo §1.B wants not null;
--       the conservative reading is "every batch from now on"):
--       * require_payout_batch_month() (BEFORE INSERT OR UPDATE) refuses an
--         INSERT without a processor and month (PT400), an UPDATE that
--         clears them, and an UPDATE to 'committed' of a batch that has
--         none (PT409, "abandon it and upload the file again").
--       * rep_payout_batches_month_when_committed: CHECK (status not in
--         ('committed', 'replaced') or processor is not null) -- the
--         structural backstop, VALIDATED, because the migration first
--         refuses any committed batch that lacks them (below). With
--         rep_payout_batches_processor_period_together, processor implies
--         period.
--       A legacy review batch is therefore left exactly as it is: it can
--       still be abandoned (the one client transition), but it can be
--       neither committed (the trigger and the CHECK) nor read again
--       (parse-residual-import refuses a batch with no processor, 409).
--       A legacy abandoned batch is inert and stays so.
--
--   rep_payout_import_rows (staging)
--     processor_raw, income_type_raw text: the file's Processor and Income
--       Type cells, kept raw for the review screen (memo §2.2).
--     blockers text[] not null default '{}': EVERY refusal a row trips, so
--       the review screen lists every unknown MID, every repeat and every
--       wrong Income Type even when one row trips several. `blocker` stays
--       the single code v2 (and v3) test with `blocker is not null`: the
--       first of `blockers` by the parser's precedence.
--       * rep_payout_import_rows_blockers_vocabulary: each element one of
--         the seven codes below.
--       * rep_payout_import_rows_blockers_need_blocker: a row with any
--         element in `blockers` has a `blocker`, so a writer cannot list a
--         refusal and leave the row committable.
--       * rep_payout_import_rows_blocker_in_blockers: when both are set,
--         `blocker` is one of `blockers`.
--     blocker vocabulary NARROWED to the memo's seven (§2.4):
--       missing_mid, unknown_mid, duplicate_mid, mid_in_other_batch,
--       wrong_income_type, missing_figure, unreadable_number. The four
--       retired codes (unknown_agent, unparseable_period, bad_number,
--       duplicate_in_file) went with the Agent # parser.
--     preview_flag gains 'payee_changed' (memo A10): informational, never
--       a blocker -- "last month this MID paid Ann Ito; this month it pays
--       Bo Lee, the merchant's current owner". 'looks_shared' is no longer
--       written and stays allowed only so a staged row from before this
--       migration still satisfies the CHECK.
--
-- WHAT THIS DOES NOT DO: the commit is still v2, which neither reads
-- `warnings` nor checks a staged row's period against the batch's; v3
-- (phase 8) recomputes and enforces both. The replace (phase 9) is not
-- built: the upload refuses a second file for a committed processor-month.
--
-- REFUSES TO RUN over rows it cannot carry, naming them, and otherwise
-- changes no existing row:
--   1. a committed (or replaced) batch with no processor and month, by id:
--      it would be outside the one-committed rule and the replace for
--      good, and only a person can say which processor and month it was;
--   2. a staged row carrying a retired blocker code, by batch id: no code
--      can describe it any more. Abandon the batch, delete its staged rows,
--      and upload the file again.
-- Not "the tables must be empty" (the phase 1 lesson).
-- =====================================================================

-- 0. What this migration cannot carry, named.
do $$
declare
  bad text;
begin
  select string_agg(id::text, ', ' order by id) into bad
    from rep_payout_batches
   where status in ('committed', 'replaced') and processor is null;
  if bad is not null then
    raise exception 'import parser migration refuses to run: committed rep_payout_batches % have no processor and month. Set both on each (processor, period) by hand, or remove the batch deliberately, then re-run.', bad;
  end if;

  select string_agg(distinct batch_id::text, ', ') into bad
    from rep_payout_import_rows
   where blocker in ('unknown_agent', 'unparseable_period', 'bad_number',
                     'duplicate_in_file');
  if bad is not null then
    raise exception 'import parser migration refuses to run: staged rows in rep_payout_batches % carry a retired blocker code. Abandon those batches, delete their staged rows, and upload the files again, then re-run.', bad;
  end if;
end $$;

-- 1. Batches: processor and month required from now on.
alter table rep_payout_batches
  add constraint rep_payout_batches_month_when_committed
    check (status not in ('committed', 'replaced') or processor is not null);

-- Invoker: it reads only the row being written.
create or replace function require_payout_batch_month()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.processor is null or new.period is null then
      raise exception 'A residual import needs its processor and month. Choose both when uploading the file.'
        using errcode = 'PT400';
    end if;
    return new;
  end if;

  if old.processor is not null and new.processor is null then
    raise exception 'An import''s processor and month cannot be cleared.'
      using errcode = 'PT400';
  end if;
  if new.status = 'committed' and new.processor is null then
    raise exception 'This import was started before the processor and month were chosen at upload, so it cannot be committed. Abandon it and upload the file again.'
      using errcode = 'PT409';
  end if;
  return new;
end;
$$;

revoke all on function require_payout_batch_month() from public;

create trigger rep_payout_batches_require_month
  before insert or update on rep_payout_batches
  for each row execute function require_payout_batch_month();

-- 2. Staging: the raw cells, every refusal per row, the narrowed codes.
alter table rep_payout_import_rows
  add column processor_raw text,
  add column income_type_raw text,
  add column blockers text[] not null default '{}'
    constraint rep_payout_import_rows_blockers_vocabulary
      check (blockers <@ array['missing_mid', 'unknown_mid', 'duplicate_mid',
                               'mid_in_other_batch', 'wrong_income_type',
                               'missing_figure', 'unreadable_number']::text[]);

alter table rep_payout_import_rows
  add constraint rep_payout_import_rows_blockers_need_blocker
    check (cardinality(blockers) = 0 or blocker is not null),
  add constraint rep_payout_import_rows_blocker_in_blockers
    check (blocker is null or cardinality(blockers) = 0
           or blocker = any(blockers));

alter table rep_payout_import_rows drop constraint rep_payout_import_rows_blocker_check;
alter table rep_payout_import_rows
  add constraint rep_payout_import_rows_blocker_check check (blocker in (
    'missing_mid', 'unknown_mid', 'duplicate_mid', 'mid_in_other_batch',
    'wrong_income_type', 'missing_figure', 'unreadable_number'
  ));

alter table rep_payout_import_rows
  drop constraint rep_payout_import_rows_preview_flag_check;
alter table rep_payout_import_rows
  add constraint rep_payout_import_rows_preview_flag_check check (
    preview_flag in ('share_not_applied', 'partner_named', 'line_not_shared',
                     'share_not_in_force', 'looks_shared', 'payee_changed')
  );

-- =====================================================================
-- COMMIT V3 (20261030160000) — the residual commit under the owner rule,
-- with the merchant's rate. Phase 8 of docs/design/intake-and-reports.md
-- (§1.C, §2.3-2.5, §0b.4, A21, A22, A25, A26, A28).
--
-- commit_residual_import_v3(batch_id_input int, confirmed_input text[])
--   returns jsonb {written, rows, shared, overrides, replaced_lines}
--   `security definer`, search_path public, pg_temp, is_admin() FIRST. The
--   only commit the app calls. commit_residual_import_v2 is DROPPED here (no
--   hosted project ever had it); commit_residual_import(int) stays, untouched,
--   until phase 13 drops it with the app that called it.
--
--   ONE TRANSACTION, in this order:
--   1. Locks. The batch row FOR UPDATE (two commits of one batch: the second
--      waits, then sees 'committed' and refuses); an advisory lock on the
--      batch's processor-month, so two DIFFERENT batches for one
--      processor-month cannot both pass the "nothing committed yet" check
--      (the unique index rep_payout_batches_one_committed_per_month is the
--      backstop); the share lock every share RPC takes; and FOR SHARE on
--      every merchant the file names, so no owner, MID or rate can change
--      under the commit.
--   2. Guards. Status 'review'; a processor and month; no other committed
--      batch for that processor-month (PT409, naming it: a second file is a
--      replace, phase 9); at least one staged row; no blocked row.
--   3. RE-DERIVED FROM THE DATABASE, never trusted from staging. Each refuses
--      PT409 and lists what it found:
--        a staged row read for another month than the batch's;
--        a blank MID; a MID on two rows; a MID that is no merchant;
--        an Income Type other than Residuals (case and surrounding space
--          ignored, the parser's rule);
--        a missing Volume or Residual;
--        THE OWNER CHANGED: a staged merchant_id or agent_id that is not the
--          merchant's current one. REFUSED, never re-paid: "A merchant's MID
--          or owner changed after this file was read. Read it again." (memo
--          §2.3 step 2; closes the security follow-up "Block a staged
--          residual row whose merchant's MID changed");
--        a merchant with no split rate (set it with set_merchant_split);
--        an import line already in the ledger for that MID and month,
--          whatever its processor -- NO MERGE (below);
--        a share covering the month whose signer is not the merchant's
--          owner, or whose two shares do not total the merchant's rate
--          (backstops for rows that predate the guards below).
--   4. THE WARNINGS ARE RECOMPUTED (the parser's rule, _shared/residuals.ts
--      rowWarnings, which this mirrors and the live suite pins):
--        processor_mismatch  the file's Processor cell is not the batch's
--                            (case and runs of whitespace ignored; a blank
--                            cell differs), or the merchant HAS a processor
--                            and it is not the batch's. No processor on the
--                            merchant is not a mismatch (A6).
--        inactive_merchant   merchants.status = 'inactive' (not 'other', A26).
--        bad_numbers         volume <= 0, or residual > volume. A negative
--                            residual on a positive volume is a clawback,
--                            not a warning (A25).
--      Any type present that is not in confirmed_input refuses PT409, naming
--      it with its rows; DETAIL carries the codes. One yes covers every row
--      of its type (memo §0b.3). confirmed_input must hold only those three
--      codes (22023 otherwise); NULL means none. What was confirmed is kept
--      on the batch: confirmed_warnings = {"bad_numbers": [4, 7], ...}, the
--      types present and the sheet rows each covered.
--   5. THE LINES, PLAIN INSERTS, NEVER A MERGE. No ON CONFLICT anywhere in
--      v3: the coalesce(excluded, existing) merge rule is retired on this
--      path, because a processor-month is committed once and changes only
--      by replace (phase 9, until paid) or by an adjustment line (after).
--      Every line takes period and processor from the BATCH, merchant_id,
--      mid and merchant_name (dba) from the MERCHANT, residual_income and
--      volume from the file, and rep_split_pct = merchants.split_agent_pct,
--      the merchant's own snapshot rate (memo §0b.4). The money is then
--      rep_payout's existing expression: rep amount T =
--      round(R * rate / 100, 2), company R - T. A rate of 0 (the house)
--      still writes its line, rep_payout 0.00, so volume and net show.
--        * unshared: one line, the owner's.
--        * shared (a share covers the batch month): the signer's line
--          (volume, account_residual_income = R, residual piece R - p) and
--          the partner's (no volume, piece p = shared_part(R, b, a + b)),
--          both carrying the share snapshot. The two shares total the
--          merchant's rate, so the partner's payout is shared_part(T, b, s)
--          and the signer's T minus it: the existing cent rule, the signer
--          absorbing the odd cent. Nothing is left blank for an admin.
--      volume_confirmed_negative is set exactly where volume < 0. Such a
--      line can only get here through a confirmed bad_numbers (step 4), so
--      the marker means "an admin confirmed this negative volume", and the
--      ledger CHECK (volume_confirmed_negative = coalesce(volume < 0,
--      false)) holds.
--   6. OVERRIDES PLUG IN HERE (phase 10): override lines for the month are
--      written after the import lines, from the same merchant rows, and
--      counted in `overrides`. Nothing else in v3 has to move: an override
--      is its own pair of lines, never a change to T.
--   7. Staging deleted; the batch set committed with committed_at (when),
--      row_count = staged rows, skipped_rows = '[]' (v3 skips nothing: a row
--      is committed or the import is refused) and confirmed_warnings. ONE
--      audit_log row, 'commit_residual_import' on rep_payout_batches,
--      actor auth.uid() (who). Fails closed.
--
-- MERCHANT RATE. merchants_split_zero_to_fifty: the agent rate is NULL with
--   the company half NULL, or between 0 and 50 with the company half exactly
--   100 minus it (memo §0b.4, §0c.2; deferred from phase 4). Validated: the
--   migration first refuses, by id, any merchant outside it.
--   set_merchant_split(merchant_id_input int, rate_input numeric) is the
--   ONLY write path to the two split columns, the set_rep_split shape:
--   security definer, search_path public, pg_temp, is_admin() first,
--   0-50 in hundredths, the share lock, REFUSED while the merchant has a
--   live share (below), audited 'set_merchant_split' (merchants, id), no
--   exception handler. A same-value call is a no-op with no audit row.
--   guard_merchant_split_and_owner() (BEFORE UPDATE OF agent_id,
--   split_agent_pct, split_company_pct) refuses any other change to the two
--   columns, an admin's included (transaction-local flag
--   tapswipe.merchant_split_write, set only by set_merchant_split). INSERT
--   is not guarded: approve_pre_app() snapshots the pre-app's rate, and a
--   merchant an admin creates by hand starts with none, which v3 refuses
--   until set_merchant_split gives it one.
--
-- SHARES UNDER THE OWNER RULE (memo §2.5, A22, A28).
--   * merchant_rep_shares_total_rep_side becomes `<= 50.00` (it was
--     `= 50.00`); the real rule, the two shares total the MERCHANT'S rate,
--     reads merchants and so lives in set_merchant_rep_share(), and holds
--     over time because set_merchant_split refuses while a share is live.
--     rep_payout_rows_share_snapshot is relaxed the same way.
--   * set_merchant_rep_share() also refuses a signer who is not the
--     merchant's current owner, a merchant with no rate, and a merchant at
--     rate 0 (A28: nothing to divide).
--   * guard_merchant_split_and_owner() refuses moving a merchant
--     (agent_id) while it has a live share: PT409 "This merchant has a
--     shared-account split. End it before moving the merchant."
--   A share is LIVE when it could still pay a month: open-ended, or ending
--   after the latest month that has an import line for the merchant (any
--   month, if none has) -- merchant_has_live_share(). Corrections
--   (post_share_correction) and adjustment lines are untouched.
--
-- REFUSES TO RUN, naming them, over: merchants whose rate is outside
-- 0-50 or whose company half does not match; and definitions it replaces
-- that are not the ones it expects (the two share CHECKs). Not "the tables
-- must be empty".
-- =====================================================================

-- 0. What this migration cannot carry, named; then the definitions it
-- replaces, checked.
do $$
declare
  bad text;
  definition text;
begin
  select string_agg(id::text, ', ' order by id) into bad
    from merchants
   where not ((split_agent_pct is null and split_company_pct is null)
              or (split_agent_pct between 0 and 50
                  and split_company_pct = 100 - split_agent_pct));
  if bad is not null then
    raise exception 'commit v3 migration refuses to run: merchants % have a split rate outside 0-50, or a company half that is not 100 minus it. Set each one deliberately (the rate is money owed), then re-run.', bad;
  end if;

  select pg_get_constraintdef(oid) into definition from pg_constraint
   where conrelid = 'public.merchant_rep_shares'::regclass
     and conname = 'merchant_rep_shares_total_rep_side';
  if definition is distinct from 'CHECK (((primary_rep_pct + secondary_rep_pct) = 50.00))' then
    raise exception 'merchant_rep_shares_total_rep_side is not the "= 50.00" CHECK here (found: %). Inspect it before applying 20261030160000.',
      coalesce(definition, 'no such constraint');
  end if;

  select pg_get_constraintdef(oid) into definition from pg_constraint
   where conrelid = 'public.rep_payout_rows'::regclass
     and conname = 'rep_payout_rows_share_snapshot';
  if definition is distinct from 'CHECK (((primary_rep_pct IS NULL) OR ((primary_rep_pct > (0)::numeric) AND (secondary_rep_pct > (0)::numeric) AND ((primary_rep_pct + secondary_rep_pct) = 50.00))))' then
    raise exception 'rep_payout_rows_share_snapshot is not the "= 50.00" CHECK here (found: %). Inspect it before applying 20261030160000.',
      coalesce(definition, 'no such constraint');
  end if;
end $$;

-- 1. The merchant's rate: 0 to 50, the company half matching.
alter table merchants
  add constraint merchants_split_zero_to_fifty check (
    (split_agent_pct is null and split_company_pct is null)
    or (split_agent_pct between 0 and 50
        and split_company_pct = 100 - split_agent_pct)
  );

-- 2. The two shares total at most 50; set_merchant_rep_share() holds them
-- to the merchant's rate.
alter table merchant_rep_shares drop constraint merchant_rep_shares_total_rep_side;
alter table merchant_rep_shares
  add constraint merchant_rep_shares_total_rep_side
    check (primary_rep_pct + secondary_rep_pct <= 50.00);

alter table rep_payout_rows drop constraint rep_payout_rows_share_snapshot;
alter table rep_payout_rows
  add constraint rep_payout_rows_share_snapshot check (
    primary_rep_pct is null
    or (primary_rep_pct > 0 and secondary_rep_pct > 0
        and primary_rep_pct + secondary_rep_pct <= 50.00)
  );

-- 3. What a commit confirmed, kept on its batch.
alter table rep_payout_batches
  add column confirmed_warnings jsonb
    constraint rep_payout_batches_confirmed_warnings_shape
      check (confirmed_warnings is null
             or (jsonb_typeof(confirmed_warnings) = 'object'
                 and status in ('committed', 'replaced')));

-- 4. A live share: one that could still pay a month. Invoker, and no client
-- may call it; its callers are definer functions and a definer trigger.
create or replace function merchant_has_live_share(merchant_id_input int)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from merchant_rep_shares s
      join merchants m on m.id = s.merchant_id
     where s.merchant_id = merchant_id_input
       and (s.effective_to is null
            or s.effective_to > coalesce(
                 (select max(l.period) from rep_payout_rows l
                   where (l.merchant_id = m.id or l.mid = m.mid)
                     and l.line_kind = 'import'),
                 '-infinity'::date))
  );
$$;

revoke all on function merchant_has_live_share(int) from public;
revoke all on function merchant_has_live_share(int) from anon, authenticated;

-- 5. The merchant's rate and owner are not edited directly. Definer, so it
-- reads merchant_rep_shares whoever is writing; it writes nothing.
create or replace function guard_merchant_split_and_owner()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (new.split_agent_pct is distinct from old.split_agent_pct
      or new.split_company_pct is distinct from old.split_company_pct)
     and coalesce(current_setting('tapswipe.merchant_split_write', true), '') <> 'on' then
    raise exception 'A merchant''s split rate is changed only with its Split control (set_merchant_split), which records who changed it.'
      using errcode = 'PT409';
  end if;

  if new.agent_id is distinct from old.agent_id
     and merchant_has_live_share(old.id) then
    raise exception 'This merchant has a shared-account split. End it before moving the merchant.'
      using errcode = 'PT409';
  end if;

  return new;
end;
$$;

revoke all on function guard_merchant_split_and_owner() from public;
revoke all on function guard_merchant_split_and_owner() from anon, authenticated;

create trigger merchants_guard_split_and_owner
  before update of agent_id, split_agent_pct, split_company_pct on merchants
  for each row execute function guard_merchant_split_and_owner();

-- 6. set_merchant_split: the one write path to the merchant's rate.
create or replace function set_merchant_split(merchant_id_input int, rate_input numeric)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  m merchants;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  if rate_input is null then
    raise exception 'a split rate is required' using errcode = 'PT400';
  end if;
  if rate_input < 0 or rate_input > 50 then
    raise exception 'the split rate must be between 0 and 50' using errcode = 'PT400';
  end if;
  if rate_input <> round(rate_input, 2) then
    raise exception 'the split rate has at most two decimal places' using errcode = 'PT400';
  end if;

  -- The share lock: a share set and a rate change cannot interleave, so the
  -- two shares keep totalling the rate.
  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  select * into m from merchants where id = merchant_id_input for update;
  if not found then
    raise exception 'merchant not found' using errcode = 'PT404';
  end if;

  if m.split_agent_pct = rate_input then
    return;
  end if;

  if merchant_has_live_share(m.id) then
    raise exception 'This merchant has a shared-account split, which divides its current rate. End the share before changing the rate.'
      using errcode = 'PT409';
  end if;

  perform set_config('tapswipe.merchant_split_write', 'on', true);
  update merchants
     set split_agent_pct = rate_input,
         split_company_pct = 100 - rate_input
   where id = m.id;
  perform set_config('tapswipe.merchant_split_write', '', true);

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'set_merchant_split', 'merchants', m.id::text);
end;
$$;

revoke all on function set_merchant_split(int, numeric) from public;
revoke all on function set_merchant_split(int, numeric) from anon;
grant execute on function set_merchant_split(int, numeric) to authenticated, service_role;

-- 7. set_merchant_rep_share: the signer is the owner, and the two shares
-- total the merchant's rate. Otherwise the body of 20261016160000.
create or replace function set_merchant_rep_share(
  merchant_id_input        int,
  primary_agent_id_input   uuid,
  secondary_agent_id_input uuid,
  primary_rep_pct_input    numeric,
  secondary_rep_pct_input  numeric,
  effective_from_input     date
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  m          merchants;
  rep        profiles;
  owner_name text;
  latest     date;
  open_share merchant_rep_shares;
  new_id     int;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  if merchant_id_input is null or primary_agent_id_input is null
     or secondary_agent_id_input is null or primary_rep_pct_input is null
     or secondary_rep_pct_input is null or effective_from_input is null then
    raise exception 'Every field is required to set a shared account.'
      using errcode = '22023';
  end if;

  select * into m from merchants where id = merchant_id_input;
  if not found then
    raise exception 'merchant not found' using errcode = 'PT404';
  end if;

  if m.mid is null or btrim(m.mid) = '' then
    raise exception 'This merchant has no MID, so no residual could ever match a share on it. Add the MID first.'
      using errcode = 'PT409';
  end if;

  if primary_agent_id_input = secondary_agent_id_input then
    raise exception 'The signer and the partner must be two different reps.'
      using errcode = '22023';
  end if;

  -- Both reps must exist and be active. A NEW share naming someone who has
  -- left is almost certainly a mistake (design §9, Q10); an existing share
  -- keeps paying a rep deactivated later, which is a different question.
  for rep in
    select * from profiles
     where id in (primary_agent_id_input, secondary_agent_id_input)
  loop
    if not rep.is_active then
      raise exception '% is deactivated, so a new share cannot name them.', rep.full_name
        using errcode = 'PT409';
    end if;
  end loop;
  if (select count(*) from profiles
       where id in (primary_agent_id_input, secondary_agent_id_input)) <> 2 then
    raise exception 'rep not found' using errcode = 'PT404';
  end if;

  -- The owner rule (memo §2.5, A22): residuals are paid to the merchant's
  -- owner, so the owner is the only possible signer.
  if primary_agent_id_input <> m.agent_id then
    select full_name into owner_name from profiles where id = m.agent_id;
    raise exception 'The signer of a shared account is the merchant''s owner, %. Name them as the signer, or move the merchant first.',
      coalesce(owner_name, 'its owner')
      using errcode = 'PT409';
  end if;

  if m.split_agent_pct is null then
    raise exception 'This merchant has no split rate yet. Set its rate before sharing it.'
      using errcode = 'PT409';
  end if;

  if m.split_agent_pct = 0 then
    raise exception 'This merchant''s rate is 0, so there is no rep side to share.'
      using errcode = 'PT409';
  end if;

  if primary_rep_pct_input <> round(primary_rep_pct_input, 2)
     or secondary_rep_pct_input <> round(secondary_rep_pct_input, 2)
     or primary_rep_pct_input <= 0 or secondary_rep_pct_input <= 0
     or primary_rep_pct_input + secondary_rep_pct_input <> m.split_agent_pct then
    raise exception 'The two shares must each be above 0, in hundredths at most, and add up to this merchant''s rate: %.',
      trim_scale(m.split_agent_pct)
      using errcode = '22023';
  end if;

  if extract(day from effective_from_input) <> 1 then
    raise exception 'A share starts on the first day of a month.'
      using errcode = '22023';
  end if;

  select max(period) into latest
    from rep_payout_rows
   where (merchant_id = m.id or mid = m.mid)
     and line_kind = 'import';

  if latest is not null and effective_from_input <= latest then
    raise exception '% is already committed for this MID. A share can only start after it; earlier months are corrected with an adjustment.',
      to_char(latest, 'FMMonth YYYY')
      using errcode = 'PT409';
  end if;

  select * into open_share
    from merchant_rep_shares
   where merchant_id = m.id and effective_to is null;

  if found then
    if open_share.effective_from >= effective_from_input then
      raise exception 'This merchant already has a share starting %. Cancel or end that one first.',
        to_char(open_share.effective_from, 'FMMonth YYYY')
        using errcode = 'PT409';
    end if;

    update merchant_rep_shares
       set effective_to = effective_from_input
     where id = open_share.id;

    insert into audit_log (actor_id, action, table_name, row_id)
    values (auth.uid(), 'end_merchant_rep_share', 'merchant_rep_shares',
            open_share.id::text);
  end if;

  -- Overlap with a share that is already closed but runs past the new start
  -- (one ended in the future). The new share is open-ended, so anything
  -- reaching past effective_from_input collides.
  if exists (
    select 1 from merchant_rep_shares
     where merchant_id = m.id
       and daterange(effective_from, effective_to)
           && daterange(effective_from_input, null)
  ) then
    raise exception 'That month overlaps another share on this merchant.'
      using errcode = 'PT409';
  end if;

  insert into merchant_rep_shares (
    merchant_id, primary_agent_id, secondary_agent_id,
    primary_rep_pct, secondary_rep_pct, effective_from
  )
  values (
    m.id, primary_agent_id_input, secondary_agent_id_input,
    primary_rep_pct_input, secondary_rep_pct_input, effective_from_input
  )
  returning id into new_id;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'set_merchant_rep_share', 'merchant_rep_shares',
          new_id::text);

  return new_id;
end;
$$;

revoke all on function set_merchant_rep_share(int, uuid, uuid, numeric, numeric, date)
  from public;
grant execute on function set_merchant_rep_share(int, uuid, uuid, numeric, numeric, date)
  to authenticated, service_role;

-- 8. v2 goes; v3 is the commit.
drop function commit_residual_import_v2(int);

create or replace function commit_residual_import_v3(
  batch_id_input  int,
  confirmed_input text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  batch       rep_payout_batches;
  confirmed   text[] := coalesce(confirmed_input, '{}');
  other       rep_payout_batches;
  staged      int;
  blocked     int;
  problem     text;
  unconfirmed text[];
  covered     jsonb;
  unshared    int;
  signers     int;
  partners    int;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  if exists (select 1 from unnest(confirmed) as c(code)
              where c.code is null
                 or c.code not in ('processor_mismatch', 'inactive_merchant',
                                   'bad_numbers')) then
    raise exception 'Only processor_mismatch, inactive_merchant and bad_numbers can be confirmed.'
      using errcode = '22023';
  end if;

  -- 1-2. Locks and guards.
  select * into batch from rep_payout_batches where id = batch_id_input for update;
  if not found then
    raise exception 'import not found' using errcode = 'PT404';
  end if;

  if batch.status <> 'review' then
    raise exception 'this import is already %', batch.status
      using errcode = 'PT409';
  end if;

  if batch.processor is null or batch.period is null then
    raise exception 'This import was started before the processor and month were chosen at upload, so it cannot be committed. Abandon it and upload the file again.'
      using errcode = 'PT409';
  end if;

  -- One committed batch per processor-month, without a race between two
  -- different batches for the same pair.
  perform pg_advisory_xact_lock(hashtext(
    'tapswipe.residual_month:' || batch.processor || '/' || batch.period::text));

  select * into other
    from rep_payout_batches
   where processor = batch.processor and period = batch.period
     and status = 'committed' and id <> batch.id;
  if found then
    raise exception '% for % is already committed (import #%). A second file for that month replaces it, which is not available yet.',
      batch.processor, to_char(batch.period, 'FMMonth YYYY'), other.id
      using errcode = 'PT409';
  end if;

  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  select count(*) into staged
    from rep_payout_import_rows where batch_id = batch_id_input;

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

  -- No owner, MID or rate of a merchant in this file changes until commit.
  perform 1 from merchants m
   where m.mid in (select r.mid_raw from rep_payout_import_rows r
                    where r.batch_id = batch_id_input)
   for share;

  -- 3. Re-derived from the database.
  select string_agg(r.row_number::text, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
   where r.batch_id = batch_id_input and r.period is distinct from batch.period;
  if problem is not null then
    raise exception 'Rows % were read for a different month than this import''s (%). Read the file again.',
      problem, to_char(batch.period, 'FMMonth YYYY')
      using errcode = 'PT409';
  end if;

  select string_agg(r.row_number::text, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
   where r.batch_id = batch_id_input
     and (r.mid_raw is null or btrim(r.mid_raw) = '');
  if problem is not null then
    raise exception 'Rows % have no MID. Fix the file and upload it again.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(d.mid_raw || ' (rows ' || d.row_list || ')', '; ' order by d.mid_raw)
    into problem
    from (select r.mid_raw,
                 string_agg(r.row_number::text, ', ' order by r.row_number) as row_list
            from rep_payout_import_rows r
           where r.batch_id = batch_id_input
           group by r.mid_raw
          having count(*) > 1) d;
  if problem is not null then
    raise exception 'A MID appears on more than one row: %. Fix the file and upload it again.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(r.mid_raw, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
   where r.batch_id = batch_id_input
     and not exists (select 1 from merchants m where m.mid = r.mid_raw);
  if problem is not null then
    raise exception 'MIDs % are not merchants in the CRM. Add them (or correct their MID), then read the file again.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(r.row_number::text, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
   where r.batch_id = batch_id_input
     and lower(regexp_replace(coalesce(r.income_type_raw, ''),
                              '^[\s﻿]+|[\s﻿]+$', '', 'g')) <> 'residuals';
  if problem is not null then
    raise exception 'Rows % have an Income Type other than Residuals. Fix the file and upload it again.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(r.row_number::text, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
   where r.batch_id = batch_id_input
     and (r.volume is null or r.residual_income is null);
  if problem is not null then
    raise exception 'Rows % have no Volume or no Residual. Fix the file and upload it again.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(r.mid_raw, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
    join merchants m on m.mid = r.mid_raw
   where r.batch_id = batch_id_input
     and (r.merchant_id is distinct from m.id
          or r.agent_id is distinct from m.agent_id);
  if problem is not null then
    raise exception 'A merchant''s MID or owner changed after this file was read (MIDs %). Read it again.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(r.mid_raw, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
    join merchants m on m.mid = r.mid_raw
   where r.batch_id = batch_id_input and m.split_agent_pct is null;
  if problem is not null then
    raise exception 'MIDs % belong to merchants with no split rate. Set each merchant''s rate, then commit.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(distinct r.mid_raw, ', ') into problem
    from rep_payout_import_rows r
    join rep_payout_rows l
      on l.mid = r.mid_raw and l.period = batch.period and l.line_kind = 'import'
   where r.batch_id = batch_id_input;
  if problem is not null then
    raise exception 'MIDs % already have a line for %. A committed month is never merged into: read the file again.',
      problem, to_char(batch.period, 'FMMonth YYYY')
      using errcode = 'PT409';
  end if;

  select string_agg(r.mid_raw, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
    join merchants m on m.mid = r.mid_raw
    join merchant_rep_shares s
      on s.merchant_id = m.id
     and batch.period >= s.effective_from
     and (s.effective_to is null or batch.period < s.effective_to)
   where r.batch_id = batch_id_input
     and (s.primary_agent_id <> m.agent_id
          or s.primary_rep_pct + s.secondary_rep_pct <> m.split_agent_pct);
  if problem is not null then
    raise exception 'MIDs % have a shared-account split whose signer is not the merchant''s owner, or whose shares do not total the merchant''s rate. End the share and set it again, then commit.', problem
      using errcode = 'PT409';
  end if;

  -- 4. The warnings, recomputed: the parser's rowWarnings().
  with flagged as (
    select r.row_number, w.code
      from rep_payout_import_rows r
      join merchants m on m.mid = r.mid_raw
      cross join lateral (values
        ('processor_mismatch',
         r.processor_raw is null
         or lower(btrim(regexp_replace(r.processor_raw, '[\s﻿]+', ' ', 'g')))
            <> lower(btrim(regexp_replace(batch.processor, '[\s﻿]+', ' ', 'g')))
         or (m.processor is not null and m.processor <> batch.processor)),
        ('inactive_merchant', m.status = 'inactive'),
        ('bad_numbers', r.volume <= 0 or r.residual_income > r.volume)
      ) as w(code, hit)
     where r.batch_id = batch_id_input and w.hit
  )
  select jsonb_object_agg(f.code, f.row_list),
         array_agg(f.code order by f.code)
           filter (where not (f.code = any(confirmed)))
    into covered, unconfirmed
    from (select code, jsonb_agg(row_number order by row_number) as row_list
            from flagged group by code) f;

  if cardinality(unconfirmed) > 0 then
    select string_agg(replace(u.code, '_', ' ') || ' (rows '
                      || (select string_agg(x.value, ', ')
                            from jsonb_array_elements_text(covered -> u.code) as x(value))
                      || ')', '; ' order by u.code)
      into problem
      from unnest(unconfirmed) as u(code);
    raise exception 'These warnings were not confirmed: %. Confirm them on the review screen, or fix the data and read the file again.', problem
      using errcode = 'PT409',
            detail = array_to_string(unconfirmed, ',');
  end if;

  -- 5. The lines. Plain inserts, never a merge.
  -- Unshared: the owner's one line at the merchant's rate.
  insert into rep_payout_rows (
    agent_id, period, processor, mid, merchant_name, merchant_id,
    volume, average_ticket, total_cost, volume_confirmed_negative,
    residual_income, rep_split_pct, batch_id
  )
  select
    m.agent_id, batch.period, batch.processor, m.mid,
    coalesce(m.dba, r.merchant_name_raw), m.id,
    r.volume, r.average_ticket, r.total_cost, r.volume < 0,
    r.residual_income, m.split_agent_pct, batch_id_input
    from rep_payout_import_rows r
    join merchants m on m.mid = r.mid_raw
   where r.batch_id = batch_id_input
     and not exists (
       select 1 from merchant_rep_shares s
        where s.merchant_id = m.id
          and batch.period >= s.effective_from
          and (s.effective_to is null or batch.period < s.effective_to));

  get diagnostics unshared = row_count;

  -- Shared, the signer's line: the volume, and the account residual less the
  -- partner's piece.
  insert into rep_payout_rows (
    agent_id, period, processor, mid, merchant_name, merchant_id,
    volume, average_ticket, total_cost, volume_confirmed_negative,
    residual_income, rep_split_pct, batch_id,
    rep_share_id, share_role, primary_rep_pct, secondary_rep_pct,
    account_residual_income
  )
  select
    m.agent_id, batch.period, batch.processor, m.mid,
    coalesce(m.dba, r.merchant_name_raw), m.id,
    r.volume, r.average_ticket, r.total_cost, r.volume < 0,
    r.residual_income
      - shared_part(r.residual_income, s.secondary_rep_pct,
                    s.primary_rep_pct + s.secondary_rep_pct),
    m.split_agent_pct, batch_id_input,
    s.id, 'primary', s.primary_rep_pct, s.secondary_rep_pct,
    r.residual_income
    from rep_payout_import_rows r
    join merchants m on m.mid = r.mid_raw
    join merchant_rep_shares s
      on s.merchant_id = m.id
     and batch.period >= s.effective_from
     and (s.effective_to is null or batch.period < s.effective_to)
   where r.batch_id = batch_id_input;

  get diagnostics signers = row_count;

  -- Shared, the partner's line: no volume (it is counted once, on the
  -- signer's line), the partner's piece of the residual.
  insert into rep_payout_rows (
    agent_id, period, processor, mid, merchant_name, merchant_id,
    volume, average_ticket, total_cost,
    residual_income, rep_split_pct, batch_id,
    rep_share_id, share_role, primary_rep_pct, secondary_rep_pct,
    account_residual_income
  )
  select
    s.secondary_agent_id, batch.period, batch.processor, m.mid,
    coalesce(m.dba, r.merchant_name_raw), m.id,
    null, null, null,
    shared_part(r.residual_income, s.secondary_rep_pct,
                s.primary_rep_pct + s.secondary_rep_pct),
    m.split_agent_pct, batch_id_input,
    s.id, 'secondary', s.primary_rep_pct, s.secondary_rep_pct,
    r.residual_income
    from rep_payout_import_rows r
    join merchants m on m.mid = r.mid_raw
    join merchant_rep_shares s
      on s.merchant_id = m.id
     and batch.period >= s.effective_from
     and (s.effective_to is null or batch.period < s.effective_to)
   where r.batch_id = batch_id_input;

  get diagnostics partners = row_count;

  -- 6. PHASE 10: override lines go here, from the same rows, counted in
  -- `overrides` below.

  -- 7. Close the batch, and the audit row.
  delete from rep_payout_import_rows where batch_id = batch_id_input;

  update rep_payout_batches
     set status = 'committed', committed_at = now(), row_count = staged,
         skipped_rows = '[]'::jsonb,
         confirmed_warnings = coalesce(covered, '{}'::jsonb)
   where id = batch_id_input;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'commit_residual_import', 'rep_payout_batches',
          batch_id_input::text);

  return jsonb_build_object(
    'written', unshared + signers + partners,
    'rows', staged,
    'shared', signers,
    'overrides', 0,
    'replaced_lines', 0
  );
end;
$$;

-- PUBLIC (which includes anon) gets EXECUTE on every new function and nothing
-- declarative revokes it. A rep holds EXECUTE through authenticated and is
-- refused by the is_admin() guard.
revoke all on function commit_residual_import_v3(int, text[]) from public;
revoke all on function commit_residual_import_v3(int, text[]) from anon;
grant execute on function commit_residual_import_v3(int, text[]) to authenticated, service_role;

-- =====================================================================
-- MERCHANT DEFAULT RATE (20261030180000) — a merchant created without a
-- split rate takes its owner's CURRENT profile rate, as a snapshot (memo
-- A31, §0b.4).
--
-- Until now a merchant an admin created by hand (the merchant form) had no
-- rate at all, and commit_residual_import_v3 refused its MID until someone
-- remembered set_merchant_split. Approval never had the gap: submit_pre_app()
-- snapshots the rep's rate onto the pre-app and approve_pre_app() copies it.
-- This gives the hand-made merchant the same rule at the moment it is made.
--
-- default_merchant_split(), BEFORE INSERT on merchants:
--   * only when BOTH split columns arrive NULL. A rate the insert carries
--     (approve_pre_app's snapshot) is kept as it is; a half-filled pair is
--     left for merchants_split_zero_to_fifty to refuse.
--   * split_agent_pct := the owner's profiles.split_rate_pct,
--     split_company_pct := 100 minus it. The house profile (rate 0) gives
--     0 / 100: the company keeps all of it, and v3 still writes its line.
--   * NO RATE IS INVENTED. An owner with no profile row, or no rate on it,
--     refuses the insert (PT409, a sentence for the form). split_rate_pct is
--     NOT NULL today, so this is the backstop for an owner that does not
--     exist (agent_id NULL or unknown -- the trigger runs before the NOT NULL
--     and foreign-key checks) and for any future change to that column.
--   * A SNAPSHOT. Nothing ties the merchant to the profile afterwards:
--     set_rep_split changes the rep's rate for merchants created later, and
--     set_merchant_split (audited, refused while a share is live) is the one
--     way to change this merchant's.
--   * INSERT only. UPDATE stays guard_merchant_split_and_owner()'s: moving a
--     merchant to another rep does NOT re-rate it (the rate is the merchant's
--     snapshot, not the owner's).
--   * Security DEFINER, deliberately, though it only reads. A BEFORE
--     trigger runs before RLS's WITH CHECK, so an invoker copy, run for a
--     rep inserting a merchant into another rep's book, could not see that
--     profile and would refuse with "the owner has no split rate" -- a
--     false sentence about someone else's profile -- where the "admin
--     insert only" policy must be what refuses. As definer it reads the
--     true rate and the policy decides, exactly as before. It reads one
--     column of one row and writes only NEW; no client may call it.
--   * No backfill. Merchants that already have no rate keep none, and v3
--     keeps refusing their MIDs until set_merchant_split gives them one: a
--     rate given now would not be the one in force when they were made.
-- =====================================================================

create or replace function default_merchant_split()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  rate numeric(5,2);
begin
  if new.split_agent_pct is not null or new.split_company_pct is not null then
    return new;
  end if;

  select p.split_rate_pct into rate from profiles p where p.id = new.agent_id;

  if rate is null then
    raise exception 'This merchant''s owner has no split rate on their profile, so the merchant has none to take. Set the rep''s rate in Manage Users, then create the merchant.'
      using errcode = 'PT409';
  end if;

  new.split_agent_pct := rate;
  new.split_company_pct := 100 - rate;
  return new;
end;
$$;

revoke all on function default_merchant_split() from public;
revoke all on function default_merchant_split() from anon, authenticated;

create trigger merchants_default_split
  before insert on merchants
  for each row execute function default_merchant_split();

-- =====================================================================
-- REPLACE, PAID, ADJUSTMENTS (20261030190000) — phase 9 of
-- docs/design/intake-and-reports.md (§3.2-3.4, §0.5, A8, A23).
--
-- A committed processor-month now changes in exactly three ways, each an
-- audited admin-only `security definer` function with is_admin() first,
-- search_path public, pg_temp and its own revoke/grant lines:
--   * REPLACE (commit_residual_import_v3 on a batch that replaces another),
--     until the month is marked paid;
--   * DELETE (delete_payout_period), until the month is marked paid;
--   * an ADJUSTMENT line (post_payout_adjustment), once it is paid.
-- And a paid month changes state only by Mark paid / Reopen.
--
-- Every function that touches one processor-month takes the same advisory
-- lock v3 takes, hashtext('tapswipe.residual_month:<processor>/<period>'),
-- before reading anything about that month, and the share lock after it
-- (the order v3 uses), so a close, a reopen, a delete, a replace and an
-- adjustment on one month are serialised and none decides on a stale read.
--
-- 1. AUDIT DETAIL. audit_log gains `detail text` (NULL, at most 1000
--    characters), written only where a reason or count is the point of the
--    entry: the Reopen reason and the period delete's line count. Nothing
--    else changes on audit_log: still no INSERT policy, authenticated still
--    holds SELECT only. This replaces the memo's payout_period_reopenings
--    table (§3.2), whose only reason to exist was that audit_log had no
--    detail column: the reason now sits on the one audit row of the reopen,
--    so there is one home for it, not two.
--
-- 2. MARK PAID AND REOPEN (A8), on payout_period_closures (20261030120000),
--    whose triggers stay the only audit: these functions write NO audit row
--    of their own, so each action leaves exactly one.
--    close_payout_period(period_input date, processor_input text,
--                        confirmation_input text) returns timestamptz
--      THE TYPED CONFIRMATION is checked here, not in the browser: the admin
--      types the processor and month exactly as the page shows them, for
--      example "TSYS July 2026" (case and runs of space ignored). Anything
--      else is PT400. Refused: not the 1st (22023), an unknown processor
--      (PT404), nothing committed for that processor-month (PT409: there is
--      nothing to have paid), already marked paid (PT409, saying when), and
--      a month that has not begun (the closure guard, PT400).
--    reopen_payout_period(period_input date, processor_input text,
--                         reason_input text) returns void
--      A written reason of 10 to 500 characters after trimming (22023), and
--      the month must be marked paid (PT404). The reason reaches the audit
--      row through a TRANSACTION-LOCAL setting, tapswipe.reopen_reason, set
--      just before the DELETE and cleared just after it.
--    log_payout_period_closure() is re-created to carry it: the DELETE's
--    audit row gets detail = the reason, and a DELETE with no reason set is
--    REFUSED (PT409), so no path removes a closure without one. INSERT is
--    audited as before (detail NULL). Still no exception handler: if the
--    audit insert fails, the close or reopen does not happen.
--
-- 3. REPLACE (memo §3.2), inside commit_residual_import_v3 -- the same
--    function, the same read-review-confirm path, the same money: a batch
--    whose replaces_batch_id is set is committed AS a replacement. One
--    function, so a replace cannot drift from a first commit. Before
--    anything is written, under the batch lock, the processor-month lock
--    and the share lock:
--      * the batch it replaces must still be THE committed batch for the
--        same processor and month (FOR UPDATE; PT409 otherwise -- a second
--        replace of one batch, or a replace of a deleted one, is refused
--        here, never applied twice);
--      * the month must not be marked paid (PT409: "… is marked paid and
--        cannot be replaced. Reopen it … or post an adjustment");
--      * no adjustment line may adjust that month on a MID the old batch
--        paid, or under its processor (PT409, naming the MIDs): a share
--        correction or adjustment was worked out from the old figures;
--      * every refusal and warning of a first commit, re-derived as before,
--        except that the no-merge check ignores the old batch's own lines.
--    Then: the old batch's lines are deleted (batch_id = old, which is its
--    import lines AND the shared signer/partner lines derived from them --
--    never an adjustment, never another processor's line); the old batch
--    becomes 'replaced' with replaced_by_batch_id = the new one; the new
--    lines are written exactly as a first commit writes them; and beside
--    the commit's own audit row a 'replace_residual_import' row names the
--    old batch. replaced_lines in the result counts the lines removed. The
--    old file stays in the residual-imports bucket: nothing here touches
--    Storage. PHASE 10 HOOK: override lines will carry the batch_id too, so
--    the delete above removes the old ones, and v3 step 6 (the marked spot
--    below) writes the new ones -- replace rebuilds overrides with no
--    change here.
--    A second file for a committed month that is NOT a replacement is still
--    refused, now saying to upload it again and answer Yes to replace.
--
-- 4. BATCH STATUS. 'deleted' joins the vocabulary (a committed month whose
--    lines delete_payout_period removed; the slot is free again). The two
--    CHECKs that list the committed states (month_when_committed,
--    confirmed_warnings_shape) admit it too. guard_batch_status_transition()
--    keeps its client rule exactly (a signed-in user: review -> abandoned
--    only) and gains rules for EVERY writer, definer functions and the
--    service role included: 'replaced' only from 'committed', 'deleted'
--    only from 'committed', and a replaced or deleted batch is final --
--    no update of any kind.
--
-- 5. PERIOD DELETE (memo §3.4). delete_payout_period(period_input date,
--    processor_input text) returns jsonb {deleted, batch_id}. Deletes the
--    IMPORT lines of that processor-month (a NULL processor means the
--    lines committed before processors were recorded) and nothing else:
--    adjustment lines stay, they are corrections already made. Refused: a
--    month marked paid (PT409), an adjustment adjusting that month on one of
--    its MIDs or under its processor (PT409, naming them), and nothing to
--    delete (PT404). The month's committed batch becomes 'deleted'. ONE
--    audit row, 'delete_payout_period' on rep_payout_rows, row_id
--    '<period>/<processor>' ('…/none' for the old lines), detail the line
--    count and the batch; no exception handler, so a failed audit write
--    undoes the delete. rep_payout_row_history rows outlive the lines (no
--    foreign key), as before. FIXES A DEFECT: the old client DELETE wrote no
--    audit row, though 20260817102000 and this file said it did.
--    The client path is closed: DELETE is revoked on rep_payout_rows from
--    authenticated and the "admin only delete" policy is dropped.
--
-- 6. GENERAL ADJUSTMENT (memo §3.3, A23). post_payout_adjustment(
--      agent_id_input uuid, mid_input text, adjusts_period_input date,
--      processor_input text, amount_input numeric, note_input text)
--    returns jsonb {line_id, posting_period, amount}.
--    The way to fix a PAID month (memo §0.5: replace before paid, an
--    adjustment after), so it is REFUSED for a processor-month that is not
--    marked paid (PT409: replace it instead). One line_kind 'adjustment'
--    line for the payee: adjustment_amount = the amount (non-zero, cents),
--    adjusts_period = the paid month, processor = the paid month's
--    processor, mid = a merchant's MID (the ledger requires one; merchant
--    id and name come from the merchant), note = the reason (1 to 500
--    characters; the rep reads it on their statement). Posted in the same
--    open month post_share_correction uses -- the month after the latest
--    month with any import line, share_correction_posting_period()'s rule --
--    and never in the paid month. The payee must exist (PT404) and be active
--    (PT409, as a share correction's partner must be). Audited
--    'post_payout_adjustment' (rep_payout_rows, the line), failing closed.
--    RECONCILED with what exists: post_share_correction() is KEPT unchanged
--    (a different job -- it moves a share of one month between two reps and
--    nets to zero); the two share the posting-month rule and the ledger's
--    adjustment shape; neither replaces the other, and replace and delete
--    refuse a month that either kind adjusts.
--
-- REFUSES TO RUN, naming what it found, over definitions it rewrites that
-- are not the ones it expects: the batch status CHECK, the two committed-
-- state CHECKs, and the client delete policy. No row of any table is one
-- this migration cannot carry: every constraint it changes is widened, and
-- the new guard rules bind future updates only.
-- =====================================================================

-- 0. The definitions this migration rewrites, checked.
do $$
declare
  definition text;
begin
  select pg_get_constraintdef(oid) into definition from pg_constraint
   where conrelid = 'public.rep_payout_batches'::regclass
     and conname = 'rep_payout_batches_status_check';
  if definition is distinct from 'CHECK ((status = ANY (ARRAY[''review''::text, ''committed''::text, ''abandoned''::text, ''replaced''::text])))' then
    raise exception 'rep_payout_batches_status_check is not (review, committed, abandoned, replaced) here (found: %). Inspect it before applying 20261030190000.',
      coalesce(definition, 'no such constraint');
  end if;

  select pg_get_constraintdef(oid) into definition from pg_constraint
   where conrelid = 'public.rep_payout_batches'::regclass
     and conname = 'rep_payout_batches_month_when_committed';
  if definition is distinct from 'CHECK (((status <> ALL (ARRAY[''committed''::text, ''replaced''::text])) OR (processor IS NOT NULL)))' then
    raise exception 'rep_payout_batches_month_when_committed is not the phase 7 CHECK here (found: %). Inspect it before applying 20261030190000.',
      coalesce(definition, 'no such constraint');
  end if;

  select pg_get_constraintdef(oid) into definition from pg_constraint
   where conrelid = 'public.rep_payout_batches'::regclass
     and conname = 'rep_payout_batches_confirmed_warnings_shape';
  if definition is distinct from 'CHECK (((confirmed_warnings IS NULL) OR ((jsonb_typeof(confirmed_warnings) = ''object''::text) AND (status = ANY (ARRAY[''committed''::text, ''replaced''::text])))))' then
    raise exception 'rep_payout_batches_confirmed_warnings_shape is not the phase 8 CHECK here (found: %). Inspect it before applying 20261030190000.',
      coalesce(definition, 'no such constraint');
  end if;

  if not exists (select 1 from pg_policy
                  where polrelid = 'public.rep_payout_rows'::regclass
                    and polname = 'admin only delete') then
    raise exception 'rep_payout_rows has no "admin only delete" policy here. Inspect its policies before applying 20261030190000.';
  end if;
end $$;

-- 1. Audit detail.
alter table audit_log
  add column detail text
    constraint audit_log_detail_length check (length(detail) <= 1000);

-- 2. Batch status: 'deleted', and the committed-state CHECKs admit it.
alter table rep_payout_batches drop constraint rep_payout_batches_status_check;
alter table rep_payout_batches
  add constraint rep_payout_batches_status_check
    check (status in ('review', 'committed', 'abandoned', 'replaced', 'deleted'));

alter table rep_payout_batches drop constraint rep_payout_batches_month_when_committed;
alter table rep_payout_batches
  add constraint rep_payout_batches_month_when_committed
    check (status not in ('committed', 'replaced', 'deleted') or processor is not null);

alter table rep_payout_batches drop constraint rep_payout_batches_confirmed_warnings_shape;
alter table rep_payout_batches
  add constraint rep_payout_batches_confirmed_warnings_shape
    check (confirmed_warnings is null
           or (jsonb_typeof(confirmed_warnings) = 'object'
               and status in ('committed', 'replaced', 'deleted')));

-- The client rule unchanged; the replaced/deleted rules for every writer.
create or replace function guard_batch_status_transition()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user = 'authenticated'
     and not (old.status = 'review' and new.status = 'abandoned') then
    raise exception 'Only an import still in review can be changed here, and only to abandoned. This one is %.', old.status
      using errcode = 'PT409';
  end if;

  if old.status in ('replaced', 'deleted') then
    raise exception 'Import #% was %. That is final: nothing about it changes.', old.id, old.status
      using errcode = 'PT409';
  end if;

  if new.status in ('replaced', 'deleted') and new.status <> old.status
     and old.status <> 'committed' then
    raise exception 'Only a committed import can become %; import #% is %.', new.status, old.id, old.status
      using errcode = 'PT409';
  end if;

  return new;
end;
$$;

revoke all on function guard_batch_status_transition() from public;

-- 3. The closure audit carries the Reopen reason, and a reopen needs one.
create or replace function log_payout_period_closure()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  closure payout_period_closures;
  reason  text;
begin
  if tg_op = 'DELETE' then
    closure := old;
    reason := nullif(btrim(coalesce(current_setting('tapswipe.reopen_reason', true), '')), '');
    if reason is null then
      raise exception 'A paid month is reopened only with a written reason (reopen_payout_period).'
        using errcode = 'PT409';
    end if;
  else
    closure := new;
  end if;

  insert into audit_log (actor_id, action, table_name, row_id, detail)
  values (auth.uid(),
          case tg_op when 'INSERT' then 'close_payout_period'
                     else 'reopen_payout_period' end,
          'payout_period_closures',
          to_char(closure.period, 'YYYY-MM-DD') || '/' || closure.processor,
          reason);

  return null;
end;
$$;

revoke all on function log_payout_period_closure() from public;

-- 4. Mark paid.
create or replace function close_payout_period(
  period_input       date,
  processor_input    text,
  confirmation_input text
)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  label     text;
  typed     text;
  existing  payout_period_closures;
  closed_at timestamptz;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  if period_input is null or processor_input is null then
    raise exception 'Choose the processor and month to mark paid.' using errcode = '22023';
  end if;
  if extract(day from period_input) <> 1 then
    raise exception 'A month is given as its first day.' using errcode = '22023';
  end if;
  if not exists (select 1 from processors where code = processor_input) then
    raise exception '"%" is not a processor in the CRM.', processor_input using errcode = 'PT404';
  end if;

  perform pg_advisory_xact_lock(hashtext(
    'tapswipe.residual_month:' || processor_input || '/' || period_input::text));

  label := processor_input || ' ' || to_char(period_input, 'FMMonth YYYY');
  typed := lower(regexp_replace(btrim(coalesce(confirmation_input, '')), '\s+', ' ', 'g'));
  if typed <> lower(label) then
    raise exception 'To mark it paid, type % exactly.', label using errcode = 'PT400';
  end if;

  if not exists (select 1 from rep_payout_batches
                  where processor = processor_input and period = period_input
                    and status = 'committed') then
    raise exception 'Nothing is committed for %, so there is nothing to mark paid.', label
      using errcode = 'PT409';
  end if;

  select * into existing from payout_period_closures
   where period = period_input and processor = processor_input;
  if found then
    raise exception '% was already marked paid on %.', label,
      to_char(existing.closed_at at time zone 'UTC', 'FMMonth FMDD, YYYY')
      using errcode = 'PT409';
  end if;

  -- The table's own trigger writes the audit row (close_payout_period).
  insert into payout_period_closures (period, processor)
  values (period_input, processor_input)
  returning payout_period_closures.closed_at into closed_at;

  return closed_at;
end;
$$;

revoke all on function close_payout_period(date, text, text) from public;
revoke all on function close_payout_period(date, text, text) from anon;
grant execute on function close_payout_period(date, text, text) to authenticated, service_role;

-- 5. Reopen.
create or replace function reopen_payout_period(
  period_input    date,
  processor_input text,
  reason_input    text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  reason text := btrim(coalesce(reason_input, ''));
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  if period_input is null or processor_input is null then
    raise exception 'Choose the processor and month to reopen.' using errcode = '22023';
  end if;
  if length(reason) < 10 then
    raise exception 'Say why this paid month is being reopened, in at least 10 characters. The reason is kept in the audit log.'
      using errcode = '22023';
  end if;
  if length(reason) > 500 then
    raise exception 'The reason can be at most 500 characters.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext(
    'tapswipe.residual_month:' || processor_input || '/' || period_input::text));

  if not exists (select 1 from payout_period_closures
                  where period = period_input and processor = processor_input) then
    raise exception '% % is not marked paid, so there is nothing to reopen.',
      processor_input, to_char(period_input, 'FMMonth YYYY')
      using errcode = 'PT404';
  end if;

  -- The reason reaches the closure's own audit row (log_payout_period_closure)
  -- through this transaction-local setting; that row is the only one written.
  perform set_config('tapswipe.reopen_reason', reason, true);
  delete from payout_period_closures
   where period = period_input and processor = processor_input;
  perform set_config('tapswipe.reopen_reason', '', true);
end;
$$;

revoke all on function reopen_payout_period(date, text, text) from public;
revoke all on function reopen_payout_period(date, text, text) from anon;
grant execute on function reopen_payout_period(date, text, text) to authenticated, service_role;

-- 6. The period delete: one audited step; the client path closed.
create or replace function delete_payout_period(
  period_input    date,
  processor_input text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  label   text;
  problem text;
  batch   rep_payout_batches;
  deleted int;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  if period_input is null then
    raise exception 'Choose the month to delete.' using errcode = '22023';
  end if;
  if extract(day from period_input) <> 1 then
    raise exception 'A month is given as its first day.' using errcode = '22023';
  end if;

  label := coalesce(processor_input, 'Lines with no processor') || ' for '
           || to_char(period_input, 'FMMonth YYYY');

  perform pg_advisory_xact_lock(hashtext(
    'tapswipe.residual_month:' || coalesce(processor_input, '') || '/' || period_input::text));
  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  if processor_input is not null and exists (
    select 1 from payout_period_closures
     where period = period_input and processor = processor_input
  ) then
    raise exception '% is marked paid and cannot be deleted. Reopen it (with a reason) first, or post an adjustment instead.', label
      using errcode = 'PT409';
  end if;

  select string_agg(distinct a.mid, ', ') into problem
    from rep_payout_rows a
   where a.line_kind = 'adjustment' and a.adjusts_period = period_input
     and ((processor_input is not null and a.processor = processor_input)
          or a.mid in (select l.mid from rep_payout_rows l
                        where l.period = period_input and l.line_kind = 'import'
                          and l.processor is not distinct from processor_input));
  if problem is not null then
    raise exception 'Adjustments already correct % (MIDs %). They were worked out from these lines, so the month cannot be deleted under them.', label, problem
      using errcode = 'PT409';
  end if;

  delete from rep_payout_rows
   where period = period_input and line_kind = 'import'
     and processor is not distinct from processor_input;
  get diagnostics deleted = row_count;

  if deleted = 0 then
    raise exception '% has no lines to delete.', label using errcode = 'PT404';
  end if;

  if processor_input is not null then
    select * into batch from rep_payout_batches
     where processor = processor_input and period = period_input and status = 'committed'
     for update;
    if found then
      update rep_payout_batches set status = 'deleted' where id = batch.id;
    end if;
  end if;

  insert into audit_log (actor_id, action, table_name, row_id, detail)
  values (auth.uid(), 'delete_payout_period', 'rep_payout_rows',
          to_char(period_input, 'YYYY-MM-DD') || '/' || coalesce(processor_input, 'none'),
          deleted || ' lines' || coalesce('; import #' || batch.id, ''));

  return jsonb_build_object('deleted', deleted, 'batch_id', batch.id);
end;
$$;

revoke all on function delete_payout_period(date, text) from public;
revoke all on function delete_payout_period(date, text) from anon;
grant execute on function delete_payout_period(date, text) to authenticated, service_role;

revoke delete on rep_payout_rows from authenticated;
drop policy "admin only delete" on rep_payout_rows;

-- 7. The general adjustment, for a paid month.
create or replace function post_payout_adjustment(
  agent_id_input       uuid,
  mid_input            text,
  adjusts_period_input date,
  processor_input      text,
  amount_input         numeric,
  note_input           text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  note    text := btrim(coalesce(note_input, ''));
  label   text;
  payee   profiles;
  m       merchants;
  posting date;
  line_id int;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  if agent_id_input is null or mid_input is null or btrim(mid_input) = ''
     or adjusts_period_input is null or processor_input is null
     or amount_input is null then
    raise exception 'Every field is required to post an adjustment.' using errcode = '22023';
  end if;
  if note = '' then
    raise exception 'An adjustment needs a reason. The rep reads it on their statement.'
      using errcode = '22023';
  end if;
  if length(note) > 500 then
    raise exception 'The reason can be at most 500 characters.' using errcode = '22023';
  end if;
  if extract(day from adjusts_period_input) <> 1 then
    raise exception 'The month being adjusted is given as its first day.' using errcode = '22023';
  end if;
  if amount_input = 0 or amount_input <> round(amount_input, 2) then
    raise exception 'The amount is in whole cents and not zero: positive pays the rep, negative takes back.'
      using errcode = '22023';
  end if;
  if abs(amount_input) >= 1000000000000 then
    raise exception 'The amount is too large.' using errcode = '22023';
  end if;

  label := processor_input || ' ' || to_char(adjusts_period_input, 'FMMonth YYYY');

  perform pg_advisory_xact_lock(hashtext(
    'tapswipe.residual_month:' || processor_input || '/' || adjusts_period_input::text));
  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  if not exists (select 1 from payout_period_closures
                  where period = adjusts_period_input and processor = processor_input) then
    raise exception '% is not marked paid. Until it is, a correction is a replace: upload the corrected file for that month.', label
      using errcode = 'PT409';
  end if;

  select * into payee from profiles where id = agent_id_input;
  if not found then
    raise exception 'rep not found' using errcode = 'PT404';
  end if;
  if not payee.is_active then
    raise exception '% is deactivated, so an adjustment cannot name them.', payee.full_name
      using errcode = 'PT409';
  end if;

  select * into m from merchants where mid = btrim(mid_input);
  if not found then
    raise exception 'MID % is not a merchant in the CRM.', btrim(mid_input) using errcode = 'PT404';
  end if;

  select (max(period) + interval '1 month')::date into posting
    from rep_payout_rows where line_kind = 'import';

  insert into rep_payout_rows (
    agent_id, period, processor, mid, merchant_name, merchant_id,
    line_kind, adjustment_amount, adjusts_period, adjustment_note
  )
  values (
    agent_id_input, posting, processor_input, m.mid, m.dba, m.id,
    'adjustment', amount_input, adjusts_period_input, note
  )
  returning id into line_id;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'post_payout_adjustment', 'rep_payout_rows', line_id::text);

  return jsonb_build_object(
    'line_id', line_id,
    'posting_period', to_char(posting, 'YYYY-MM-DD'),
    'amount', amount_input
  );
end;
$$;

revoke all on function post_payout_adjustment(uuid, text, date, text, numeric, text) from public;
revoke all on function post_payout_adjustment(uuid, text, date, text, numeric, text) from anon;
grant execute on function post_payout_adjustment(uuid, text, date, text, numeric, text)
  to authenticated, service_role;

-- 8. v3, with the replace. Otherwise the body of 20261030160000.
create or replace function commit_residual_import_v3(
  batch_id_input  int,
  confirmed_input text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  batch       rep_payout_batches;
  confirmed   text[] := coalesce(confirmed_input, '{}');
  other       rep_payout_batches;
  replaced    rep_payout_batches;
  staged      int;
  blocked     int;
  problem     text;
  unconfirmed text[];
  covered     jsonb;
  unshared    int;
  signers     int;
  partners    int;
  removed     int := 0;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  if exists (select 1 from unnest(confirmed) as c(code)
              where c.code is null
                 or c.code not in ('processor_mismatch', 'inactive_merchant',
                                   'bad_numbers')) then
    raise exception 'Only processor_mismatch, inactive_merchant and bad_numbers can be confirmed.'
      using errcode = '22023';
  end if;

  -- 1-2. Locks and guards.
  select * into batch from rep_payout_batches where id = batch_id_input for update;
  if not found then
    raise exception 'import not found' using errcode = 'PT404';
  end if;

  if batch.status <> 'review' then
    raise exception 'this import is already %', batch.status
      using errcode = 'PT409';
  end if;

  if batch.processor is null or batch.period is null then
    raise exception 'This import was started before the processor and month were chosen at upload, so it cannot be committed. Abandon it and upload the file again.'
      using errcode = 'PT409';
  end if;

  -- One committed batch per processor-month, without a race between two
  -- different batches for the same pair.
  perform pg_advisory_xact_lock(hashtext(
    'tapswipe.residual_month:' || batch.processor || '/' || batch.period::text));

  -- A replacement: the batch it replaces must still be the committed one for
  -- this processor-month, and the month must not be marked paid.
  if batch.replaces_batch_id is not null then
    select * into replaced
      from rep_payout_batches where id = batch.replaces_batch_id for update;
    if not found or replaced.status <> 'committed'
       or replaced.processor is distinct from batch.processor
       or replaced.period is distinct from batch.period then
      raise exception 'This file was uploaded to replace import #%, which is no longer the committed import for % for %. Abandon it and upload the file again.',
        batch.replaces_batch_id, batch.processor, to_char(batch.period, 'FMMonth YYYY')
        using errcode = 'PT409';
    end if;

    if exists (select 1 from payout_period_closures
                where period = batch.period and processor = batch.processor) then
      raise exception '% for % is marked paid and cannot be replaced. Reopen it (with a reason), or post an adjustment instead.',
        batch.processor, to_char(batch.period, 'FMMonth YYYY')
        using errcode = 'PT409';
    end if;
  end if;

  select * into other
    from rep_payout_batches
   where processor = batch.processor and period = batch.period
     and status = 'committed' and id <> batch.id
     and id is distinct from batch.replaces_batch_id;
  if found then
    raise exception '% for % is already committed (import #%). A second file for that month replaces it: upload it again and answer Yes to replace.',
      batch.processor, to_char(batch.period, 'FMMonth YYYY'), other.id
      using errcode = 'PT409';
  end if;

  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  -- A replacement may not pull the month out from under an adjustment that
  -- was worked out from the figures it replaces.
  if batch.replaces_batch_id is not null then
    select string_agg(distinct a.mid, ', ') into problem
      from rep_payout_rows a
     where a.line_kind = 'adjustment' and a.adjusts_period = batch.period
       and (a.processor = batch.processor
            or a.mid in (select l.mid from rep_payout_rows l
                          where l.batch_id = replaced.id));
    if problem is not null then
      raise exception 'Adjustments already correct % for % (MIDs %). They were worked out from the committed figures, so the month cannot be replaced under them.',
        batch.processor, to_char(batch.period, 'FMMonth YYYY'), problem
        using errcode = 'PT409';
    end if;
  end if;

  select count(*) into staged
    from rep_payout_import_rows where batch_id = batch_id_input;

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

  -- No owner, MID or rate of a merchant in this file changes until commit.
  perform 1 from merchants m
   where m.mid in (select r.mid_raw from rep_payout_import_rows r
                    where r.batch_id = batch_id_input)
   for share;

  -- 3. Re-derived from the database.
  select string_agg(r.row_number::text, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
   where r.batch_id = batch_id_input and r.period is distinct from batch.period;
  if problem is not null then
    raise exception 'Rows % were read for a different month than this import''s (%). Read the file again.',
      problem, to_char(batch.period, 'FMMonth YYYY')
      using errcode = 'PT409';
  end if;

  select string_agg(r.row_number::text, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
   where r.batch_id = batch_id_input
     and (r.mid_raw is null or btrim(r.mid_raw) = '');
  if problem is not null then
    raise exception 'Rows % have no MID. Fix the file and upload it again.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(d.mid_raw || ' (rows ' || d.row_list || ')', '; ' order by d.mid_raw)
    into problem
    from (select r.mid_raw,
                 string_agg(r.row_number::text, ', ' order by r.row_number) as row_list
            from rep_payout_import_rows r
           where r.batch_id = batch_id_input
           group by r.mid_raw
          having count(*) > 1) d;
  if problem is not null then
    raise exception 'A MID appears on more than one row: %. Fix the file and upload it again.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(r.mid_raw, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
   where r.batch_id = batch_id_input
     and not exists (select 1 from merchants m where m.mid = r.mid_raw);
  if problem is not null then
    raise exception 'MIDs % are not merchants in the CRM. Add them (or correct their MID), then read the file again.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(r.row_number::text, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
   where r.batch_id = batch_id_input
     and lower(regexp_replace(coalesce(r.income_type_raw, ''),
                              '^[\s﻿]+|[\s﻿]+$', '', 'g')) <> 'residuals';
  if problem is not null then
    raise exception 'Rows % have an Income Type other than Residuals. Fix the file and upload it again.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(r.row_number::text, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
   where r.batch_id = batch_id_input
     and (r.volume is null or r.residual_income is null);
  if problem is not null then
    raise exception 'Rows % have no Volume or no Residual. Fix the file and upload it again.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(r.mid_raw, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
    join merchants m on m.mid = r.mid_raw
   where r.batch_id = batch_id_input
     and (r.merchant_id is distinct from m.id
          or r.agent_id is distinct from m.agent_id);
  if problem is not null then
    raise exception 'A merchant''s MID or owner changed after this file was read (MIDs %). Read it again.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(r.mid_raw, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
    join merchants m on m.mid = r.mid_raw
   where r.batch_id = batch_id_input and m.split_agent_pct is null;
  if problem is not null then
    raise exception 'MIDs % belong to merchants with no split rate. Set each merchant''s rate, then commit.', problem
      using errcode = 'PT409';
  end if;

  -- No merge. On a replacement, the lines of the batch being replaced are
  -- about to go, so they are not "already there".
  select string_agg(distinct r.mid_raw, ', ') into problem
    from rep_payout_import_rows r
    join rep_payout_rows l
      on l.mid = r.mid_raw and l.period = batch.period and l.line_kind = 'import'
   where r.batch_id = batch_id_input
     and (batch.replaces_batch_id is null
          or l.batch_id is distinct from batch.replaces_batch_id);
  if problem is not null then
    raise exception 'MIDs % already have a line for %. A committed month is never merged into: read the file again.',
      problem, to_char(batch.period, 'FMMonth YYYY')
      using errcode = 'PT409';
  end if;

  select string_agg(r.mid_raw, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
    join merchants m on m.mid = r.mid_raw
    join merchant_rep_shares s
      on s.merchant_id = m.id
     and batch.period >= s.effective_from
     and (s.effective_to is null or batch.period < s.effective_to)
   where r.batch_id = batch_id_input
     and (s.primary_agent_id <> m.agent_id
          or s.primary_rep_pct + s.secondary_rep_pct <> m.split_agent_pct);
  if problem is not null then
    raise exception 'MIDs % have a shared-account split whose signer is not the merchant''s owner, or whose shares do not total the merchant''s rate. End the share and set it again, then commit.', problem
      using errcode = 'PT409';
  end if;

  -- 4. The warnings, recomputed: the parser's rowWarnings().
  with flagged as (
    select r.row_number, w.code
      from rep_payout_import_rows r
      join merchants m on m.mid = r.mid_raw
      cross join lateral (values
        ('processor_mismatch',
         r.processor_raw is null
         or lower(btrim(regexp_replace(r.processor_raw, '[\s﻿]+', ' ', 'g')))
            <> lower(btrim(regexp_replace(batch.processor, '[\s﻿]+', ' ', 'g')))
         or (m.processor is not null and m.processor <> batch.processor)),
        ('inactive_merchant', m.status = 'inactive'),
        ('bad_numbers', r.volume <= 0 or r.residual_income > r.volume)
      ) as w(code, hit)
     where r.batch_id = batch_id_input and w.hit
  )
  select jsonb_object_agg(f.code, f.row_list),
         array_agg(f.code order by f.code)
           filter (where not (f.code = any(confirmed)))
    into covered, unconfirmed
    from (select code, jsonb_agg(row_number order by row_number) as row_list
            from flagged group by code) f;

  if cardinality(unconfirmed) > 0 then
    select string_agg(replace(u.code, '_', ' ') || ' (rows '
                      || (select string_agg(x.value, ', ')
                            from jsonb_array_elements_text(covered -> u.code) as x(value))
                      || ')', '; ' order by u.code)
      into problem
      from unnest(unconfirmed) as u(code);
    raise exception 'These warnings were not confirmed: %. Confirm them on the review screen, or fix the data and read the file again.', problem
      using errcode = 'PT409',
            detail = array_to_string(unconfirmed, ',');
  end if;

  -- 5. The replace, then the lines. Every refusal is behind us: from here
  -- on, the commit writes.
  if batch.replaces_batch_id is not null then
    -- The old batch's lines: its import lines and the shared lines derived
    -- from them. Adjustments carry no batch and stay. (Phase 10: override
    -- lines carry the batch too, so they go here and step 6 rebuilds them.)
    delete from rep_payout_rows where batch_id = replaced.id;
    get diagnostics removed = row_count;

    update rep_payout_batches
       set status = 'replaced', replaced_by_batch_id = batch_id_input
     where id = replaced.id;
  end if;

  -- Plain inserts, never a merge.
  -- Unshared: the owner's one line at the merchant's rate.
  insert into rep_payout_rows (
    agent_id, period, processor, mid, merchant_name, merchant_id,
    volume, average_ticket, total_cost, volume_confirmed_negative,
    residual_income, rep_split_pct, batch_id
  )
  select
    m.agent_id, batch.period, batch.processor, m.mid,
    coalesce(m.dba, r.merchant_name_raw), m.id,
    r.volume, r.average_ticket, r.total_cost, r.volume < 0,
    r.residual_income, m.split_agent_pct, batch_id_input
    from rep_payout_import_rows r
    join merchants m on m.mid = r.mid_raw
   where r.batch_id = batch_id_input
     and not exists (
       select 1 from merchant_rep_shares s
        where s.merchant_id = m.id
          and batch.period >= s.effective_from
          and (s.effective_to is null or batch.period < s.effective_to));

  get diagnostics unshared = row_count;

  -- Shared, the signer's line: the volume, and the account residual less the
  -- partner's piece.
  insert into rep_payout_rows (
    agent_id, period, processor, mid, merchant_name, merchant_id,
    volume, average_ticket, total_cost, volume_confirmed_negative,
    residual_income, rep_split_pct, batch_id,
    rep_share_id, share_role, primary_rep_pct, secondary_rep_pct,
    account_residual_income
  )
  select
    m.agent_id, batch.period, batch.processor, m.mid,
    coalesce(m.dba, r.merchant_name_raw), m.id,
    r.volume, r.average_ticket, r.total_cost, r.volume < 0,
    r.residual_income
      - shared_part(r.residual_income, s.secondary_rep_pct,
                    s.primary_rep_pct + s.secondary_rep_pct),
    m.split_agent_pct, batch_id_input,
    s.id, 'primary', s.primary_rep_pct, s.secondary_rep_pct,
    r.residual_income
    from rep_payout_import_rows r
    join merchants m on m.mid = r.mid_raw
    join merchant_rep_shares s
      on s.merchant_id = m.id
     and batch.period >= s.effective_from
     and (s.effective_to is null or batch.period < s.effective_to)
   where r.batch_id = batch_id_input;

  get diagnostics signers = row_count;

  -- Shared, the partner's line: no volume (it is counted once, on the
  -- signer's line), the partner's piece of the residual.
  insert into rep_payout_rows (
    agent_id, period, processor, mid, merchant_name, merchant_id,
    volume, average_ticket, total_cost,
    residual_income, rep_split_pct, batch_id,
    rep_share_id, share_role, primary_rep_pct, secondary_rep_pct,
    account_residual_income
  )
  select
    s.secondary_agent_id, batch.period, batch.processor, m.mid,
    coalesce(m.dba, r.merchant_name_raw), m.id,
    null, null, null,
    shared_part(r.residual_income, s.secondary_rep_pct,
                s.primary_rep_pct + s.secondary_rep_pct),
    m.split_agent_pct, batch_id_input,
    s.id, 'secondary', s.primary_rep_pct, s.secondary_rep_pct,
    r.residual_income
    from rep_payout_import_rows r
    join merchants m on m.mid = r.mid_raw
    join merchant_rep_shares s
      on s.merchant_id = m.id
     and batch.period >= s.effective_from
     and (s.effective_to is null or batch.period < s.effective_to)
   where r.batch_id = batch_id_input;

  get diagnostics partners = row_count;

  -- 6. PHASE 10: override lines go here, from the same rows, counted in
  -- `overrides` below. On a replacement this is what rebuilds them.

  -- 7. Close the batch, and the audit rows.
  delete from rep_payout_import_rows where batch_id = batch_id_input;

  update rep_payout_batches
     set status = 'committed', committed_at = now(), row_count = staged,
         skipped_rows = '[]'::jsonb,
         confirmed_warnings = coalesce(covered, '{}'::jsonb)
   where id = batch_id_input;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'commit_residual_import', 'rep_payout_batches',
          batch_id_input::text);

  if batch.replaces_batch_id is not null then
    insert into audit_log (actor_id, action, table_name, row_id)
    values (auth.uid(), 'replace_residual_import', 'rep_payout_batches',
            replaced.id::text);
  end if;

  return jsonb_build_object(
    'written', unshared + signers + partners,
    'rows', staged,
    'shared', signers,
    'overrides', 0,
    'replaced_lines', removed
  );
end;
$$;

-- PUBLIC (which includes anon) gets EXECUTE on every new function and nothing
-- declarative revokes it. Re-stated: create or replace keeps the existing ACL,
-- but these lines are what the grants test reads.
revoke all on function commit_residual_import_v3(int, text[]) from public;
revoke all on function commit_residual_import_v3(int, text[]) from anon;
grant execute on function commit_residual_import_v3(int, text[]) to authenticated, service_role;

-- =====================================================================
-- MERCHANT OVERRIDES (20261102120000) — phase 10 of
-- docs/design/intake-and-reports.md (§4, §0.1, §0b.5, A4a-A4f, A25, A29).
--
-- AN OVERRIDE is a percent o of the merchant's FULL residual R, taken out of
-- the rep side and paid to a named person (the owner's manager by default,
-- otherwise any named active person; never the rep, nor either party of a
-- shared account). 0 < o <= the merchant's rate s, in hundredths. The
-- company's share, R - T with T = round(R * s / 100, 2), never moves:
--   R = $100, s = 50, o = 10:  rep side T = 50.00, of which the rep keeps
--   40.00 and the recipient gets 10.00; the company keeps 50.00.
--
-- 1. merchant_overrides (id, merchant_id, recipient_id, override_pct,
--    effective_from, effective_to, created_at) -- the shape of
--    merchant_rep_shares:
--      * override_pct CHECK > 0 and <= 50, the OUTER bound only (no rate is
--        above 50). The real cap, <= the merchant's split_agent_pct, reads
--        merchants, so set_merchant_override() enforces it, set_merchant_split
--        refuses a rate below a live override (A29), and commit v3 re-checks
--        it per row. Move the three together.
--      * months: effective_from the 1st, effective_to EXCLUSIVE (the 1st,
--        after the start) or NULL for open-ended; AT MOST ONE OVERRIDE PER
--        MERCHANT PER MONTH (A4e) is an exclusion constraint.
--      * recipient_id references profiles: the TWENTY-SIXTH profiles FK, NO
--        ACTION. merchant_id is ON DELETE RESTRICT (a payroll record).
--      * no agent_id, no created_by: the actor is in audit_log.
--      * RLS on, one policy (select is_admin()). authenticated holds SELECT
--        only; service_role SELECT and DELETE (the teardowns); nobody holds
--        INSERT or UPDATE, so a client write is "permission denied". The
--        three functions below are the only write path, each audited.
--      * Set only once the merchant exists (A4b): an override lives on the
--        merchant, which exists from approval; a merchant whose pre-app is
--        neither submitted nor approved is refused.
--
-- 2. THE FUNCTIONS. security definer, search_path public, pg_temp,
--    is_admin() FIRST, the share lock (so overrides, shares, rates and
--    commits serialise), an audit row in the same transaction with no
--    exception handler, their own revoke/grant lines. PT403 not an admin,
--    PT404 not found, PT409 a conflict with existing state, 22023 a bad
--    argument.
--    set_merchant_override(merchant_id_input int, recipient_id_input uuid,
--                          override_pct_input numeric,
--                          effective_from_input date) returns int
--      Every argument required (the form prefills the owner's manager; the
--      function never guesses). Refuses: no merchant; a pre-app not
--      submitted or approved; no MID; a percent not in hundredths, <= 0 or
--      > 50; a merchant with no rate, or at 0 (nothing to come out of); a
--      percent above the merchant's rate; not the 1st; a recipient who does
--      not exist, is deactivated, is the owner, or is a party to a share on
--      the merchant overlapping the override; a start at or before the
--      latest month committed for the MID (an override for a committed month
--      is an adjustment). An open override that started earlier is ENDED at
--      the new start in the same call ("change it from November" is one
--      call; the table is the history). Audited 'set_merchant_override'
--      (and 'end_merchant_override' for the one it ends).
--    end_merchant_override(override_id_input int, effective_to_input date)
--      The override stops applying from that month (exclusive). Neither the
--      new end nor an existing one may be at or before the latest committed
--      month. Audited 'end_merchant_override'.
--    cancel_merchant_override(override_id_input int)
--      Deletes an override no ledger line references and no committed month
--      falls inside. Audited 'cancel_merchant_override'.
--    THE MONTH RULE, as for shares: no boundary at or before the latest month
--    committed for the MID. So an override in force for a committed month can
--    never change afterwards, and a REPLACE of that month (commit v3 on a
--    replacing batch) reads the same override the original commit read. The
--    lines themselves are snapshots: override_amount is stored, never
--    recomputed, so editing an override later changes no committed month.
--
-- 3. THE RULES THAT HOLD OVER TIME, kept where the change would happen:
--      * set_merchant_split refuses a rate below a LIVE override's percent
--        (A29), naming it;
--      * guard_merchant_split_and_owner refuses moving a merchant while it
--        has a live override, as for a live share (whose rep side would it
--        come out of?). That also stops the recipient becoming the owner;
--      * set_merchant_rep_share refuses naming as signer or partner the
--        recipient of an override overlapping the share.
--    LIVE, as for shares: open-ended, or ending after the latest month with
--    an import line for the merchant (any month, if none has) --
--    merchant_has_live_override(). No client may call it.
--
-- 4. THE LEDGER. rep_payout_rows gains override_id (references
--    merchant_overrides, ON DELETE RESTRICT), override_role ('debit' |
--    'credit') and override_amount (signed). line_kind gains 'override'.
--    rep_payout gains `when line_kind = 'override' then override_amount`,
--    rewritten by DROP AND RE-ADD under the 20261014140000 precautions: it
--    refuses to run if anything but its own expression depends on the column
--    or the column carries privileges, and every existing payout is compared
--    (count, total, per-row md5) before and after, or nothing commits.
--    CHECKs: the three override columns are set together, on override lines
--    only; an override line carries a batch and a processor, no share
--    columns, and (rep_payout_rows_adjustment_no_figures, rewritten) no
--    residual, rate, volume, average ticket or total cost; an adjustment
--    still carries no batch (rewritten rep_payout_rows_adjustment_columns
--    and _no_figures say "not an adjustment" where they said "import").
--    rep_payout_rows_override_line_key: one line per (batch, override, role,
--    rep). A CHECK cannot see the other line of a pair, so "the debits and
--    the credit net to zero" is the commit's, pinned by the tests.
--    No client writes any of it: authenticated holds UPDATE on
--    residual_income and rep_split_pct only, and the no-figures CHECK refuses
--    either on an override line.
--
-- 5. COMMIT V3 STEP 6, the override lines. For every file row whose merchant
--    has an override in force for the batch month:
--      X   = round(R * o / 100, 2)          the override, half away from zero
--                                            (Postgres round, rep_payout's own
--                                            rounding); X has R's sign, and
--                                            |X| <= |T| because o <= s.
--      unshared: the owner's debit  -X; the recipient's credit +X.
--      shared (signer a, partner b, a + b = s):
--        x_p = shared_part(X, b, s)          the partner's piece of the
--        x_s = X - x_p                       deduction, by the cent rule (the
--                                            signer absorbs the odd cent, as
--                                            in the payout itself)
--        the signer's debit -x_s, the partner's -x_p, the credit +X.
--    ORDER OF ROUNDING: X once, from R (never from T); then x_p from X; x_s by
--    subtraction. So debits + credit = 0 exactly, and signer net + partner net
--    + recipient = T exactly: the company's R - T never moves. o = s nets the
--    rep side to exactly zero (X = T, x_p = the partner's payout). A negative
--    R (a clawback, A25) imports with no warning and every figure reverses
--    in proportion: the recipient gives back their cut. X = 0 (R = 0, or a
--    residual too small to carry a cent) still writes the lines, at 0.00, so
--    every month an override was in force shows it.
--    The lines carry the batch's batch_id, period and processor, and the
--    merchant's mid, merchant_id and dba as merchant_name -- the snapshot a
--    recipient reads as plain text. A REPLACE deletes them with the old
--    batch's lines (batch_id) and step 6 writes them again from the override
--    in force at replace time, which the month rule makes the same one.
--    BACKSTOPS, refused before anything is written (PT409, naming the MIDs
--    and override ids): an override above the merchant's rate now; one paid
--    to the owner or to a party of a covering share; one whose recipient is
--    deactivated (the conservative choice: end it, or reactivate them).
--    The result's `overrides` is the number of file rows an override applied
--    to (one credit line each).
--
-- 6. VISIBILITY (A4c). A rep reads their own debit lines (RLS, agent_id) and
--    learns who receives the override from my_override_recipients():
--    security definer, search_path pinned, is_active_agent() FIRST (PT403),
--    built with jsonb_build_object so only override_id, recipient_name and
--    override_pct exist, and only for overrides the CALLER holds a debit line
--    for. The recipient reads their own credit line: merchant_name is plain
--    text on it, and nothing here reaches merchants -- no merchants policy is
--    widened, so the recipient's read of the merchant row is still nothing.
--    The recipient learns neither the percent nor the rep from this phase.
--
-- 7. delete_payout_period deletes the month's override lines with its import
--    lines (one processor-month, the same lock and refusals); otherwise the
--    body of 20261030190000.
--
-- REFUSES TO RUN, naming what it found, over definitions it rewrites that
-- are not the ones it expects (line_kind, the two adjustment CHECKs) and over
-- a rep_payout column it cannot safely drop. Not "the table must be empty":
-- every existing line is an import or an adjustment line with the new columns
-- NULL, which every new CHECK admits, and the rewrite proves no payout moved.
-- =====================================================================

-- 0. The definitions this migration rewrites, checked.
do $$
declare
  definition text;
  dependents int;
  column_acl aclitem[];
begin
  select pg_get_constraintdef(oid) into definition from pg_constraint
   where conrelid = 'public.rep_payout_rows'::regclass
     and conname = 'rep_payout_rows_line_kind';
  if definition is distinct from 'CHECK ((line_kind = ANY (ARRAY[''import''::text, ''adjustment''::text])))' then
    raise exception 'rep_payout_rows_line_kind is not (import, adjustment) here (found: %). Inspect it before applying 20261102120000.',
      coalesce(definition, 'no such constraint');
  end if;

  select pg_get_constraintdef(oid) into definition from pg_constraint
   where conrelid = 'public.rep_payout_rows'::regclass
     and conname = 'rep_payout_rows_adjustment_columns';
  if definition is distinct from 'CHECK ((((line_kind = ''import''::text) AND (adjustment_amount IS NULL) AND (adjusts_period IS NULL) AND (adjustment_note IS NULL)) OR ((line_kind = ''adjustment''::text) AND (adjustment_amount IS NOT NULL) AND (adjusts_period IS NOT NULL) AND (EXTRACT(day FROM adjusts_period) = (1)::numeric) AND (rep_share_id IS NULL))))' then
    raise exception 'rep_payout_rows_adjustment_columns is not the 20261014140000 CHECK here (found: %). Inspect it before applying 20261102120000.',
      coalesce(definition, 'no such constraint');
  end if;

  select pg_get_constraintdef(oid) into definition from pg_constraint
   where conrelid = 'public.rep_payout_rows'::regclass
     and conname = 'rep_payout_rows_adjustment_no_figures';
  if definition is distinct from 'CHECK (((line_kind = ''import''::text) OR ((residual_income IS NULL) AND (rep_split_pct IS NULL) AND (volume IS NULL) AND (average_ticket IS NULL) AND (total_cost IS NULL) AND (batch_id IS NULL))))' then
    raise exception 'rep_payout_rows_adjustment_no_figures is not the 20261016160000 CHECK here (found: %). Inspect it before applying 20261102120000.',
      coalesce(definition, 'no such constraint');
  end if;

  select count(*) into dependents
    from pg_depend d
    join pg_attribute a
      on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
   where d.refobjid = 'public.rep_payout_rows'::regclass
     and a.attname = 'rep_payout'
     and d.classid <> 'pg_attrdef'::regclass;
  if dependents > 0 then
    raise exception 'rep_payout_rows.rep_payout has % dependent object(s) besides its own expression; dropping the column would drop or break them. Inspect pg_depend before applying 20261102120000.',
      dependents;
  end if;

  select attacl into column_acl
    from pg_attribute
   where attrelid = 'public.rep_payout_rows'::regclass
     and attname = 'rep_payout';
  if column_acl is not null then
    raise exception 'rep_payout_rows.rep_payout carries column-level privileges (%); dropping the column would lose them.',
      column_acl;
  end if;
end $$;

-- 1. The table.
create table merchant_overrides (
  id serial primary key,
  merchant_id  int  not null references merchants(id) on delete restrict,
  -- The 26th reference to profiles(id), NO ACTION.
  recipient_id uuid not null references profiles(id),
  -- % of the FULL residual, taken from the rep side. <= 50 because no split
  -- rate exceeds 50 (the profiles, pre_apps and merchants CHECKs). The real
  -- cap, <= the merchant's split_agent_pct, is set_merchant_override()'s,
  -- set_merchant_split()'s (A29) and commit v3's. Move together.
  override_pct numeric(5,2) not null,
  -- First payout month it applies to (1st of the month).
  effective_from date not null,
  -- EXCLUSIVE: the first month it no longer applies. NULL = open-ended.
  effective_to   date,
  created_at timestamptz not null default now(),
  constraint merchant_overrides_pct_range
    check (override_pct > 0 and override_pct <= 50),
  constraint merchant_overrides_from_first_of_month
    check (extract(day from effective_from) = 1),
  constraint merchant_overrides_to_first_of_month
    check (effective_to is null
           or (extract(day from effective_to) = 1 and effective_to > effective_from)),
  -- At most one override per merchant per month (A4e).
  constraint merchant_overrides_no_overlap
    exclude using gist (merchant_id with =,
                        daterange(effective_from, effective_to) with &&)
);

-- Step 2 of the four, written although ensure_rls would do it here: the
-- event trigger is skipped where the migration role lacks superuser.
alter table merchant_overrides enable row level security;

create policy "admin only select" on merchant_overrides
  for select using (is_admin());

-- Nothing is granted by default (20260805210000), and nothing more than
-- this is wanted: revoke first so the grants below are the whole of it.
revoke all on merchant_overrides from public, anon, authenticated, service_role;
revoke all on sequence merchant_overrides_id_seq from public, anon, authenticated, service_role;
grant select on merchant_overrides to authenticated;
-- The teardowns read and delete as the service role; nothing inserts or
-- updates outside the definer functions below.
grant select, delete on merchant_overrides to service_role;

create index idx_merchant_overrides_recipient on merchant_overrides (recipient_id);

-- 2. The ledger: the override columns.
create temp table rep_payout_override_before on commit drop as
  select id, rep_payout from rep_payout_rows;

alter table rep_payout_rows
  add column override_id int
    constraint rep_payout_rows_override_id_fkey
      references merchant_overrides(id) on delete restrict,
  add column override_role text
    constraint rep_payout_rows_override_role
      check (override_role in ('debit', 'credit')),
  add column override_amount numeric(14,2);

alter table rep_payout_rows drop constraint rep_payout_rows_line_kind;
alter table rep_payout_rows
  add constraint rep_payout_rows_line_kind
    check (line_kind in ('import', 'adjustment', 'override'));

alter table rep_payout_rows drop constraint rep_payout_rows_adjustment_columns;
alter table rep_payout_rows
  add constraint rep_payout_rows_adjustment_columns check (
    (line_kind <> 'adjustment' and adjustment_amount is null
     and adjusts_period is null and adjustment_note is null)
    or (line_kind = 'adjustment' and adjustment_amount is not null
        and adjusts_period is not null
        and extract(day from adjusts_period) = 1
        and rep_share_id is null)
  );

-- Neither an adjustment nor an override carries a figure; an adjustment has
-- no batch, an override line always has one.
alter table rep_payout_rows drop constraint rep_payout_rows_adjustment_no_figures;
alter table rep_payout_rows
  add constraint rep_payout_rows_adjustment_no_figures check (
    line_kind = 'import'
    or (residual_income is null and rep_split_pct is null
        and volume is null and average_ticket is null
        and total_cost is null
        and (batch_id is null) = (line_kind = 'adjustment'))
  );

alter table rep_payout_rows
  add constraint rep_payout_rows_override_columns check (
    (line_kind <> 'override' and override_id is null
     and override_role is null and override_amount is null)
    or (line_kind = 'override' and override_id is not null
        and override_role is not null and override_amount is not null
        and processor is not null and rep_share_id is null)
  );

create unique index rep_payout_rows_override_line_key
  on rep_payout_rows (batch_id, override_id, override_role, agent_id)
  where line_kind = 'override';

create index idx_rep_payout_rows_override
  on rep_payout_rows (override_id)
  where override_id is not null;

-- 3. rep_payout: the override branch. Every other branch unchanged.
alter table rep_payout_rows drop column rep_payout;

alter table rep_payout_rows
  add column rep_payout numeric(14,2) generated always as (
    case
      when line_kind = 'adjustment' then adjustment_amount
      when line_kind = 'override' then override_amount
      when share_role is null then
        round(residual_income * rep_split_pct / 100, 2)
      when share_role = 'secondary' then
        shared_part(round(account_residual_income * rep_split_pct / 100, 2),
                    secondary_rep_pct, primary_rep_pct + secondary_rep_pct)
      else
        round(account_residual_income * rep_split_pct / 100, 2)
        - shared_part(round(account_residual_income * rep_split_pct / 100, 2),
                      secondary_rep_pct, primary_rep_pct + secondary_rep_pct)
    end
  ) stored;

-- Nothing moved, to the cent, or nothing commits.
do $$
declare
  before_rows  bigint;
  after_rows   bigint;
  before_total numeric;
  after_total  numeric;
  before_md5   text;
  after_md5    text;
begin
  select count(*), sum(rep_payout),
         md5(coalesce(string_agg(id::text || ':' || coalesce(rep_payout::text, 'null'),
                                 ',' order by id), ''))
    into before_rows, before_total, before_md5
    from rep_payout_override_before;

  select count(*), sum(rep_payout),
         md5(coalesce(string_agg(id::text || ':' || coalesce(rep_payout::text, 'null'),
                                 ',' order by id), ''))
    into after_rows, after_total, after_md5
    from rep_payout_rows;

  -- Counts and which check failed, never figures: a migration log is not a
  -- place for payout data.
  if before_rows is distinct from after_rows
     or before_total is distinct from after_total
     or before_md5 is distinct from after_md5 then
    raise exception 'rep_payout rewrite changed existing payouts (rows % -> %, total %, per-row checksum %); rolled back',
      before_rows, after_rows,
      case when before_total is not distinct from after_total then 'matches' else 'DIFFERS' end,
      case when before_md5 = after_md5 then 'matches' else 'DIFFERS' end;
  end if;
end $$;

drop table rep_payout_override_before;

-- 4. A live override: one that could still pay a month. Invoker, and no
-- client may call it; its callers are definer functions and a definer trigger.
create or replace function merchant_has_live_override(merchant_id_input int)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from merchant_overrides o
      join merchants m on m.id = o.merchant_id
     where o.merchant_id = merchant_id_input
       and (o.effective_to is null
            or o.effective_to > coalesce(
                 (select max(l.period) from rep_payout_rows l
                   where (l.merchant_id = m.id or l.mid = m.mid)
                     and l.line_kind = 'import'),
                 '-infinity'::date))
  );
$$;

revoke all on function merchant_has_live_override(int) from public;
revoke all on function merchant_has_live_override(int) from anon, authenticated;

-- 5. Moving a merchant is refused while it has a live override, as while it
-- has a live share. Otherwise the body of 20261030160000.
create or replace function guard_merchant_split_and_owner()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (new.split_agent_pct is distinct from old.split_agent_pct
      or new.split_company_pct is distinct from old.split_company_pct)
     and coalesce(current_setting('tapswipe.merchant_split_write', true), '') <> 'on' then
    raise exception 'A merchant''s split rate is changed only with its Split control (set_merchant_split), which records who changed it.'
      using errcode = 'PT409';
  end if;

  if new.agent_id is distinct from old.agent_id
     and merchant_has_live_share(old.id) then
    raise exception 'This merchant has a shared-account split. End it before moving the merchant.'
      using errcode = 'PT409';
  end if;

  if new.agent_id is distinct from old.agent_id
     and merchant_has_live_override(old.id) then
    raise exception 'This merchant has an override, which comes out of its owner''s side. End it before moving the merchant.'
      using errcode = 'PT409';
  end if;

  return new;
end;
$$;

revoke all on function guard_merchant_split_and_owner() from public;
revoke all on function guard_merchant_split_and_owner() from anon, authenticated;

-- 6. set_merchant_split refuses a rate below a live override (A29).
-- Otherwise the body of 20261030160000.
create or replace function set_merchant_split(merchant_id_input int, rate_input numeric)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  m        merchants;
  above    merchant_overrides;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  if rate_input is null then
    raise exception 'a split rate is required' using errcode = 'PT400';
  end if;
  if rate_input < 0 or rate_input > 50 then
    raise exception 'the split rate must be between 0 and 50' using errcode = 'PT400';
  end if;
  if rate_input <> round(rate_input, 2) then
    raise exception 'the split rate has at most two decimal places' using errcode = 'PT400';
  end if;

  -- The share lock: a share set and a rate change cannot interleave, so the
  -- two shares keep totalling the rate.
  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  select * into m from merchants where id = merchant_id_input for update;
  if not found then
    raise exception 'merchant not found' using errcode = 'PT404';
  end if;

  if m.split_agent_pct = rate_input then
    return;
  end if;

  if merchant_has_live_share(m.id) then
    raise exception 'This merchant has a shared-account split, which divides its current rate. End the share before changing the rate.'
      using errcode = 'PT409';
  end if;

  -- A29: an override comes out of the rate, so the rate cannot go below a
  -- live one's percent.
  select o.* into above
    from merchant_overrides o
   where o.merchant_id = m.id
     and o.override_pct > rate_input
     and (o.effective_to is null
          or o.effective_to > coalesce(
               (select max(l.period) from rep_payout_rows l
                 where (l.merchant_id = m.id or l.mid = m.mid)
                   and l.line_kind = 'import'),
               '-infinity'::date))
   order by o.effective_from
   limit 1;
  if found then
    raise exception 'This merchant has an override of %, which comes out of its rate. End or change the override before setting the rate below it.',
      trim_scale(above.override_pct) || '%'
      using errcode = 'PT409';
  end if;

  perform set_config('tapswipe.merchant_split_write', 'on', true);
  update merchants
     set split_agent_pct = rate_input,
         split_company_pct = 100 - rate_input
   where id = m.id;
  perform set_config('tapswipe.merchant_split_write', '', true);

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'set_merchant_split', 'merchants', m.id::text);
end;
$$;

revoke all on function set_merchant_split(int, numeric) from public;
revoke all on function set_merchant_split(int, numeric) from anon;
grant execute on function set_merchant_split(int, numeric) to authenticated, service_role;

-- 7. set_merchant_rep_share refuses naming an override's recipient as a
-- party. Otherwise the body of 20261030160000 (search_path kept as it was).
create or replace function set_merchant_rep_share(
  merchant_id_input        int,
  primary_agent_id_input   uuid,
  secondary_agent_id_input uuid,
  primary_rep_pct_input    numeric,
  secondary_rep_pct_input  numeric,
  effective_from_input     date
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  m          merchants;
  rep        profiles;
  owner_name text;
  latest     date;
  open_share merchant_rep_shares;
  new_id     int;
  recipient  text;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  if merchant_id_input is null or primary_agent_id_input is null
     or secondary_agent_id_input is null or primary_rep_pct_input is null
     or secondary_rep_pct_input is null or effective_from_input is null then
    raise exception 'Every field is required to set a shared account.'
      using errcode = '22023';
  end if;

  select * into m from merchants where id = merchant_id_input;
  if not found then
    raise exception 'merchant not found' using errcode = 'PT404';
  end if;

  if m.mid is null or btrim(m.mid) = '' then
    raise exception 'This merchant has no MID, so no residual could ever match a share on it. Add the MID first.'
      using errcode = 'PT409';
  end if;

  if primary_agent_id_input = secondary_agent_id_input then
    raise exception 'The signer and the partner must be two different reps.'
      using errcode = '22023';
  end if;

  -- Both reps must exist and be active. A NEW share naming someone who has
  -- left is almost certainly a mistake (design §9, Q10); an existing share
  -- keeps paying a rep deactivated later, which is a different question.
  for rep in
    select * from profiles
     where id in (primary_agent_id_input, secondary_agent_id_input)
  loop
    if not rep.is_active then
      raise exception '% is deactivated, so a new share cannot name them.', rep.full_name
        using errcode = 'PT409';
    end if;
  end loop;
  if (select count(*) from profiles
       where id in (primary_agent_id_input, secondary_agent_id_input)) <> 2 then
    raise exception 'rep not found' using errcode = 'PT404';
  end if;

  -- The owner rule (memo §2.5, A22): residuals are paid to the merchant's
  -- owner, so the owner is the only possible signer.
  if primary_agent_id_input <> m.agent_id then
    select full_name into owner_name from profiles where id = m.agent_id;
    raise exception 'The signer of a shared account is the merchant''s owner, %. Name them as the signer, or move the merchant first.',
      coalesce(owner_name, 'its owner')
      using errcode = 'PT409';
  end if;

  -- An override is paid out of the parties' side, so its recipient cannot
  -- be one of them (memo §4.1; 20261102120000).
  select p.full_name into recipient
    from merchant_overrides o
    join profiles p on p.id = o.recipient_id
   where o.merchant_id = m.id
     and o.recipient_id in (primary_agent_id_input, secondary_agent_id_input)
     and daterange(o.effective_from, o.effective_to)
         && daterange(effective_from_input, null)
   limit 1;
  if recipient is not null then
    raise exception '% receives this merchant''s override, so they cannot also be a party to its shared account. End the override first.',
      recipient
      using errcode = 'PT409';
  end if;

  if m.split_agent_pct is null then
    raise exception 'This merchant has no split rate yet. Set its rate before sharing it.'
      using errcode = 'PT409';
  end if;

  if m.split_agent_pct = 0 then
    raise exception 'This merchant''s rate is 0, so there is no rep side to share.'
      using errcode = 'PT409';
  end if;

  if primary_rep_pct_input <> round(primary_rep_pct_input, 2)
     or secondary_rep_pct_input <> round(secondary_rep_pct_input, 2)
     or primary_rep_pct_input <= 0 or secondary_rep_pct_input <= 0
     or primary_rep_pct_input + secondary_rep_pct_input <> m.split_agent_pct then
    raise exception 'The two shares must each be above 0, in hundredths at most, and add up to this merchant''s rate: %.',
      trim_scale(m.split_agent_pct)
      using errcode = '22023';
  end if;

  if extract(day from effective_from_input) <> 1 then
    raise exception 'A share starts on the first day of a month.'
      using errcode = '22023';
  end if;

  select max(period) into latest
    from rep_payout_rows
   where (merchant_id = m.id or mid = m.mid)
     and line_kind = 'import';

  if latest is not null and effective_from_input <= latest then
    raise exception '% is already committed for this MID. A share can only start after it; earlier months are corrected with an adjustment.',
      to_char(latest, 'FMMonth YYYY')
      using errcode = 'PT409';
  end if;

  select * into open_share
    from merchant_rep_shares
   where merchant_id = m.id and effective_to is null;

  if found then
    if open_share.effective_from >= effective_from_input then
      raise exception 'This merchant already has a share starting %. Cancel or end that one first.',
        to_char(open_share.effective_from, 'FMMonth YYYY')
        using errcode = 'PT409';
    end if;

    update merchant_rep_shares
       set effective_to = effective_from_input
     where id = open_share.id;

    insert into audit_log (actor_id, action, table_name, row_id)
    values (auth.uid(), 'end_merchant_rep_share', 'merchant_rep_shares',
            open_share.id::text);
  end if;

  -- Overlap with a share that is already closed but runs past the new start
  -- (one ended in the future). The new share is open-ended, so anything
  -- reaching past effective_from_input collides.
  if exists (
    select 1 from merchant_rep_shares
     where merchant_id = m.id
       and daterange(effective_from, effective_to)
           && daterange(effective_from_input, null)
  ) then
    raise exception 'That month overlaps another share on this merchant.'
      using errcode = 'PT409';
  end if;

  insert into merchant_rep_shares (
    merchant_id, primary_agent_id, secondary_agent_id,
    primary_rep_pct, secondary_rep_pct, effective_from
  )
  values (
    m.id, primary_agent_id_input, secondary_agent_id_input,
    primary_rep_pct_input, secondary_rep_pct_input, effective_from_input
  )
  returning id into new_id;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'set_merchant_rep_share', 'merchant_rep_shares',
          new_id::text);

  return new_id;
end;
$$;

revoke all on function set_merchant_rep_share(int, uuid, uuid, numeric, numeric, date)
  from public;
revoke all on function set_merchant_rep_share(int, uuid, uuid, numeric, numeric, date)
  from anon;
grant execute on function set_merchant_rep_share(int, uuid, uuid, numeric, numeric, date)
  to authenticated, service_role;

-- 8. set_merchant_override.
create or replace function set_merchant_override(
  merchant_id_input    int,
  recipient_id_input   uuid,
  override_pct_input   numeric,
  effective_from_input date
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  m          merchants;
  recipient  profiles;
  pre_status text;
  latest     date;
  open_one   merchant_overrides;
  new_id     int;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  if merchant_id_input is null or recipient_id_input is null
     or override_pct_input is null or effective_from_input is null then
    raise exception 'Every field is required to set an override: who receives it, the percent and the first month.'
      using errcode = '22023';
  end if;

  select * into m from merchants where id = merchant_id_input for update;
  if not found then
    raise exception 'merchant not found' using errcode = 'PT404';
  end if;

  -- A4b: set only once the pre-app is submitted. A merchant exists from
  -- approval; this refuses one whose pre-app says otherwise. A merchant an
  -- admin made by hand has no pre-app and is allowed.
  if m.pre_app_id is not null then
    select status into pre_status from pre_apps where id = m.pre_app_id;
    if pre_status is distinct from 'submitted' and pre_status is distinct from 'approved' then
      raise exception 'This merchant''s pre-app has not been submitted, so it cannot carry an override yet.'
        using errcode = 'PT409';
    end if;
  end if;

  if m.mid is null or btrim(m.mid) = '' then
    raise exception 'This merchant has no MID, so no residual could ever carry an override. Add the MID first.'
      using errcode = 'PT409';
  end if;

  if override_pct_input <> round(override_pct_input, 2)
     or override_pct_input <= 0 or override_pct_input > 50 then
    raise exception 'An override is a percent of the full residual, above 0 and in hundredths at most, like 10 or 2.5.'
      using errcode = '22023';
  end if;

  if m.split_agent_pct is null then
    raise exception 'This merchant has no split rate yet. Set its rate before giving it an override.'
      using errcode = 'PT409';
  end if;

  if m.split_agent_pct = 0 then
    raise exception 'This merchant''s rate is 0, so there is no rep side for an override to come out of.'
      using errcode = 'PT409';
  end if;

  -- The cap (memo §0b.5): the override comes out of the rep side, which is
  -- the merchant's rate -- not always 50.
  if override_pct_input > m.split_agent_pct then
    raise exception 'An override comes out of the rep side, so it cannot be more than this merchant''s rate: %.',
      trim_scale(m.split_agent_pct)
      using errcode = '22023';
  end if;

  if extract(day from effective_from_input) <> 1 then
    raise exception 'An override starts on the first day of a month.'
      using errcode = '22023';
  end if;

  select * into recipient from profiles where id = recipient_id_input;
  if not found then
    raise exception 'recipient not found' using errcode = 'PT404';
  end if;

  if not recipient.is_active then
    raise exception '% is deactivated, so a new override cannot name them.', recipient.full_name
      using errcode = 'PT409';
  end if;

  if recipient.id = m.agent_id then
    raise exception 'The override is paid out of the owner''s side, so the owner cannot also receive it. Name their manager or another person.'
      using errcode = '22023';
  end if;

  if exists (
    select 1 from merchant_rep_shares s
     where s.merchant_id = m.id
       and recipient.id in (s.primary_agent_id, s.secondary_agent_id)
       and daterange(s.effective_from, s.effective_to)
           && daterange(effective_from_input, null)
  ) then
    raise exception '% is a party to this merchant''s shared account, so they cannot also receive its override.',
      recipient.full_name
      using errcode = 'PT409';
  end if;

  select max(period) into latest
    from rep_payout_rows
   where (merchant_id = m.id or mid = m.mid)
     and line_kind = 'import';

  if latest is not null and effective_from_input <= latest then
    raise exception '% is already committed for this MID. An override can only start after it; a committed month is corrected with an adjustment.',
      to_char(latest, 'FMMonth YYYY')
      using errcode = 'PT409';
  end if;

  select * into open_one
    from merchant_overrides
   where merchant_id = m.id and effective_to is null;

  if found then
    if open_one.effective_from >= effective_from_input then
      raise exception 'This merchant already has an override starting %. Cancel or end that one first.',
        to_char(open_one.effective_from, 'FMMonth YYYY')
        using errcode = 'PT409';
    end if;

    update merchant_overrides
       set effective_to = effective_from_input
     where id = open_one.id;

    insert into audit_log (actor_id, action, table_name, row_id)
    values (auth.uid(), 'end_merchant_override', 'merchant_overrides',
            open_one.id::text);
  end if;

  if exists (
    select 1 from merchant_overrides
     where merchant_id = m.id
       and daterange(effective_from, effective_to)
           && daterange(effective_from_input, null)
  ) then
    raise exception 'That month overlaps another override on this merchant.'
      using errcode = 'PT409';
  end if;

  insert into merchant_overrides (
    merchant_id, recipient_id, override_pct, effective_from
  )
  values (
    m.id, recipient.id, override_pct_input, effective_from_input
  )
  returning id into new_id;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'set_merchant_override', 'merchant_overrides',
          new_id::text);

  return new_id;
end;
$$;

revoke all on function set_merchant_override(int, uuid, numeric, date) from public;
revoke all on function set_merchant_override(int, uuid, numeric, date) from anon;
grant execute on function set_merchant_override(int, uuid, numeric, date)
  to authenticated, service_role;

-- 9. end_merchant_override.
create or replace function end_merchant_override(
  override_id_input  int,
  effective_to_input date
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  o      merchant_overrides;
  m      merchants;
  latest date;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  if override_id_input is null or effective_to_input is null then
    raise exception 'An override and an end month are required.'
      using errcode = '22023';
  end if;

  select * into o from merchant_overrides where id = override_id_input;
  if not found then
    raise exception 'override not found' using errcode = 'PT404';
  end if;

  if extract(day from effective_to_input) <> 1 then
    raise exception 'An override ends on the first day of a month.'
      using errcode = '22023';
  end if;

  if effective_to_input <= o.effective_from then
    raise exception 'An override has to end after the month it starts. To remove it entirely, cancel it.'
      using errcode = '22023';
  end if;

  select * into m from merchants where id = o.merchant_id;
  select max(period) into latest
    from rep_payout_rows
   where (merchant_id = m.id or mid = m.mid)
     and line_kind = 'import';

  if latest is not null and effective_to_input <= latest then
    raise exception '% is already committed for this MID. An override can only end after it.',
      to_char(latest, 'FMMonth YYYY')
      using errcode = 'PT409';
  end if;

  if latest is not null and o.effective_to is not null and o.effective_to <= latest then
    raise exception 'This override already ended before a committed month, so its end is settled.'
      using errcode = 'PT409';
  end if;

  if exists (
    select 1 from merchant_overrides
     where merchant_id = o.merchant_id
       and id <> o.id
       and daterange(effective_from, effective_to)
           && daterange(o.effective_from, effective_to_input)
  ) then
    raise exception 'That end month overlaps another override on this merchant.'
      using errcode = 'PT409';
  end if;

  update merchant_overrides
     set effective_to = effective_to_input
   where id = o.id;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'end_merchant_override', 'merchant_overrides',
          o.id::text);
end;
$$;

revoke all on function end_merchant_override(int, date) from public;
revoke all on function end_merchant_override(int, date) from anon;
grant execute on function end_merchant_override(int, date)
  to authenticated, service_role;

-- 10. cancel_merchant_override: one that never paid a month.
create or replace function cancel_merchant_override(override_id_input int)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  o      merchant_overrides;
  m      merchants;
  latest date;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  select * into o from merchant_overrides where id = override_id_input;
  if not found then
    raise exception 'override not found' using errcode = 'PT404';
  end if;

  select * into m from merchants where id = o.merchant_id;
  select max(period) into latest
    from rep_payout_rows
   where (merchant_id = m.id or mid = m.mid)
     and line_kind = 'import';

  if exists (select 1 from rep_payout_rows where override_id = o.id)
     or (latest is not null and o.effective_from <= latest) then
    raise exception 'This override has applied to a committed month, so it cannot be cancelled. End it instead.'
      using errcode = 'PT409';
  end if;

  delete from merchant_overrides where id = o.id;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'cancel_merchant_override', 'merchant_overrides',
          o.id::text);
end;
$$;

revoke all on function cancel_merchant_override(int) from public;
revoke all on function cancel_merchant_override(int) from anon;
grant execute on function cancel_merchant_override(int)
  to authenticated, service_role;

-- 11. my_override_recipients: who receives the overrides on the caller's
-- own lines. Party-only, admins included (an admin reads the table).
create or replace function my_override_recipients()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  caller uuid := auth.uid();
  result jsonb;
begin
  if caller is null or not is_active_agent() then
    raise exception 'not authorised' using errcode = 'PT403';
  end if;

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'override_id', o.id,
             'recipient_name', p.full_name,
             'override_pct', o.override_pct)
           order by o.id),
         '[]'::jsonb)
    into result
    from merchant_overrides o
    join profiles p on p.id = o.recipient_id
   where exists (select 1 from rep_payout_rows l
                  where l.override_id = o.id
                    and l.agent_id = caller
                    and l.override_role = 'debit');

  return result;
end;
$$;

revoke all on function my_override_recipients() from public;
revoke all on function my_override_recipients() from anon;
grant execute on function my_override_recipients() to authenticated, service_role;

-- 12. The period delete takes the month's override lines with its import
-- lines. Otherwise the body of 20261030190000.
create or replace function delete_payout_period(
  period_input    date,
  processor_input text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  label   text;
  problem text;
  batch   rep_payout_batches;
  deleted int;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  if period_input is null then
    raise exception 'Choose the month to delete.' using errcode = '22023';
  end if;
  if extract(day from period_input) <> 1 then
    raise exception 'A month is given as its first day.' using errcode = '22023';
  end if;

  label := coalesce(processor_input, 'Lines with no processor') || ' for '
           || to_char(period_input, 'FMMonth YYYY');

  perform pg_advisory_xact_lock(hashtext(
    'tapswipe.residual_month:' || coalesce(processor_input, '') || '/' || period_input::text));
  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  if processor_input is not null and exists (
    select 1 from payout_period_closures
     where period = period_input and processor = processor_input
  ) then
    raise exception '% is marked paid and cannot be deleted. Reopen it (with a reason) first, or post an adjustment instead.', label
      using errcode = 'PT409';
  end if;

  select string_agg(distinct a.mid, ', ') into problem
    from rep_payout_rows a
   where a.line_kind = 'adjustment' and a.adjusts_period = period_input
     and ((processor_input is not null and a.processor = processor_input)
          or a.mid in (select l.mid from rep_payout_rows l
                        where l.period = period_input and l.line_kind = 'import'
                          and l.processor is not distinct from processor_input));
  if problem is not null then
    raise exception 'Adjustments already correct % (MIDs %). They were worked out from these lines, so the month cannot be deleted under them.', label, problem
      using errcode = 'PT409';
  end if;

  -- The import lines and the override lines worked out from them.
  delete from rep_payout_rows
   where period = period_input and line_kind in ('import', 'override')
     and processor is not distinct from processor_input;
  get diagnostics deleted = row_count;

  if deleted = 0 then
    raise exception '% has no lines to delete.', label using errcode = 'PT404';
  end if;

  if processor_input is not null then
    select * into batch from rep_payout_batches
     where processor = processor_input and period = period_input and status = 'committed'
     for update;
    if found then
      update rep_payout_batches set status = 'deleted' where id = batch.id;
    end if;
  end if;

  insert into audit_log (actor_id, action, table_name, row_id, detail)
  values (auth.uid(), 'delete_payout_period', 'rep_payout_rows',
          to_char(period_input, 'YYYY-MM-DD') || '/' || coalesce(processor_input, 'none'),
          deleted || ' lines' || coalesce('; import #' || batch.id, ''));

  return jsonb_build_object('deleted', deleted, 'batch_id', batch.id);
end;
$$;

revoke all on function delete_payout_period(date, text) from public;
revoke all on function delete_payout_period(date, text) from anon;
grant execute on function delete_payout_period(date, text) to authenticated, service_role;

-- 13. v3 with step 6. Otherwise the body of 20261030190000.
create or replace function commit_residual_import_v3(
  batch_id_input  int,
  confirmed_input text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  batch       rep_payout_batches;
  confirmed   text[] := coalesce(confirmed_input, '{}');
  other       rep_payout_batches;
  replaced    rep_payout_batches;
  staged      int;
  blocked     int;
  problem     text;
  unconfirmed text[];
  covered     jsonb;
  unshared    int;
  signers     int;
  partners    int;
  overrides   int := 0;
  removed     int := 0;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  if exists (select 1 from unnest(confirmed) as c(code)
              where c.code is null
                 or c.code not in ('processor_mismatch', 'inactive_merchant',
                                   'bad_numbers')) then
    raise exception 'Only processor_mismatch, inactive_merchant and bad_numbers can be confirmed.'
      using errcode = '22023';
  end if;

  -- 1-2. Locks and guards.
  select * into batch from rep_payout_batches where id = batch_id_input for update;
  if not found then
    raise exception 'import not found' using errcode = 'PT404';
  end if;

  if batch.status <> 'review' then
    raise exception 'this import is already %', batch.status
      using errcode = 'PT409';
  end if;

  if batch.processor is null or batch.period is null then
    raise exception 'This import was started before the processor and month were chosen at upload, so it cannot be committed. Abandon it and upload the file again.'
      using errcode = 'PT409';
  end if;

  -- One committed batch per processor-month, without a race between two
  -- different batches for the same pair.
  perform pg_advisory_xact_lock(hashtext(
    'tapswipe.residual_month:' || batch.processor || '/' || batch.period::text));

  -- A replacement: the batch it replaces must still be the committed one for
  -- this processor-month, and the month must not be marked paid.
  if batch.replaces_batch_id is not null then
    select * into replaced
      from rep_payout_batches where id = batch.replaces_batch_id for update;
    if not found or replaced.status <> 'committed'
       or replaced.processor is distinct from batch.processor
       or replaced.period is distinct from batch.period then
      raise exception 'This file was uploaded to replace import #%, which is no longer the committed import for % for %. Abandon it and upload the file again.',
        batch.replaces_batch_id, batch.processor, to_char(batch.period, 'FMMonth YYYY')
        using errcode = 'PT409';
    end if;

    if exists (select 1 from payout_period_closures
                where period = batch.period and processor = batch.processor) then
      raise exception '% for % is marked paid and cannot be replaced. Reopen it (with a reason), or post an adjustment instead.',
        batch.processor, to_char(batch.period, 'FMMonth YYYY')
        using errcode = 'PT409';
    end if;
  end if;

  select * into other
    from rep_payout_batches
   where processor = batch.processor and period = batch.period
     and status = 'committed' and id <> batch.id
     and id is distinct from batch.replaces_batch_id;
  if found then
    raise exception '% for % is already committed (import #%). A second file for that month replaces it: upload it again and answer Yes to replace.',
      batch.processor, to_char(batch.period, 'FMMonth YYYY'), other.id
      using errcode = 'PT409';
  end if;

  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  -- A replacement may not pull the month out from under an adjustment that
  -- was worked out from the figures it replaces.
  if batch.replaces_batch_id is not null then
    select string_agg(distinct a.mid, ', ') into problem
      from rep_payout_rows a
     where a.line_kind = 'adjustment' and a.adjusts_period = batch.period
       and (a.processor = batch.processor
            or a.mid in (select l.mid from rep_payout_rows l
                          where l.batch_id = replaced.id));
    if problem is not null then
      raise exception 'Adjustments already correct % for % (MIDs %). They were worked out from the committed figures, so the month cannot be replaced under them.',
        batch.processor, to_char(batch.period, 'FMMonth YYYY'), problem
        using errcode = 'PT409';
    end if;
  end if;

  select count(*) into staged
    from rep_payout_import_rows where batch_id = batch_id_input;

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

  -- No owner, MID or rate of a merchant in this file changes until commit.
  perform 1 from merchants m
   where m.mid in (select r.mid_raw from rep_payout_import_rows r
                    where r.batch_id = batch_id_input)
   for share;

  -- 3. Re-derived from the database.
  select string_agg(r.row_number::text, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
   where r.batch_id = batch_id_input and r.period is distinct from batch.period;
  if problem is not null then
    raise exception 'Rows % were read for a different month than this import''s (%). Read the file again.',
      problem, to_char(batch.period, 'FMMonth YYYY')
      using errcode = 'PT409';
  end if;

  select string_agg(r.row_number::text, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
   where r.batch_id = batch_id_input
     and (r.mid_raw is null or btrim(r.mid_raw) = '');
  if problem is not null then
    raise exception 'Rows % have no MID. Fix the file and upload it again.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(d.mid_raw || ' (rows ' || d.row_list || ')', '; ' order by d.mid_raw)
    into problem
    from (select r.mid_raw,
                 string_agg(r.row_number::text, ', ' order by r.row_number) as row_list
            from rep_payout_import_rows r
           where r.batch_id = batch_id_input
           group by r.mid_raw
          having count(*) > 1) d;
  if problem is not null then
    raise exception 'A MID appears on more than one row: %. Fix the file and upload it again.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(r.mid_raw, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
   where r.batch_id = batch_id_input
     and not exists (select 1 from merchants m where m.mid = r.mid_raw);
  if problem is not null then
    raise exception 'MIDs % are not merchants in the CRM. Add them (or correct their MID), then read the file again.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(r.row_number::text, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
   where r.batch_id = batch_id_input
     and lower(regexp_replace(coalesce(r.income_type_raw, ''),
                              '^[\s﻿]+|[\s﻿]+$', '', 'g')) <> 'residuals';
  if problem is not null then
    raise exception 'Rows % have an Income Type other than Residuals. Fix the file and upload it again.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(r.row_number::text, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
   where r.batch_id = batch_id_input
     and (r.volume is null or r.residual_income is null);
  if problem is not null then
    raise exception 'Rows % have no Volume or no Residual. Fix the file and upload it again.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(r.mid_raw, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
    join merchants m on m.mid = r.mid_raw
   where r.batch_id = batch_id_input
     and (r.merchant_id is distinct from m.id
          or r.agent_id is distinct from m.agent_id);
  if problem is not null then
    raise exception 'A merchant''s MID or owner changed after this file was read (MIDs %). Read it again.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(r.mid_raw, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
    join merchants m on m.mid = r.mid_raw
   where r.batch_id = batch_id_input and m.split_agent_pct is null;
  if problem is not null then
    raise exception 'MIDs % belong to merchants with no split rate. Set each merchant''s rate, then commit.', problem
      using errcode = 'PT409';
  end if;

  -- No merge. On a replacement, the lines of the batch being replaced are
  -- about to go, so they are not "already there".
  select string_agg(distinct r.mid_raw, ', ') into problem
    from rep_payout_import_rows r
    join rep_payout_rows l
      on l.mid = r.mid_raw and l.period = batch.period and l.line_kind = 'import'
   where r.batch_id = batch_id_input
     and (batch.replaces_batch_id is null
          or l.batch_id is distinct from batch.replaces_batch_id);
  if problem is not null then
    raise exception 'MIDs % already have a line for %. A committed month is never merged into: read the file again.',
      problem, to_char(batch.period, 'FMMonth YYYY')
      using errcode = 'PT409';
  end if;

  select string_agg(r.mid_raw, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
    join merchants m on m.mid = r.mid_raw
    join merchant_rep_shares s
      on s.merchant_id = m.id
     and batch.period >= s.effective_from
     and (s.effective_to is null or batch.period < s.effective_to)
   where r.batch_id = batch_id_input
     and (s.primary_agent_id <> m.agent_id
          or s.primary_rep_pct + s.secondary_rep_pct <> m.split_agent_pct);
  if problem is not null then
    raise exception 'MIDs % have a shared-account split whose signer is not the merchant''s owner, or whose shares do not total the merchant''s rate. End the share and set it again, then commit.', problem
      using errcode = 'PT409';
  end if;

  -- Overrides in force for the month (phase 10). The functions that set
  -- them hold these rules; a rate, an owner, a share or a person can change
  -- after that, so the commit checks them again.
  select string_agg(r.mid_raw || ' (override #' || o.id || ')', ', ' order by r.row_number)
    into problem
    from rep_payout_import_rows r
    join merchants m on m.mid = r.mid_raw
    join merchant_overrides o
      on o.merchant_id = m.id
     and batch.period >= o.effective_from
     and (o.effective_to is null or batch.period < o.effective_to)
   where r.batch_id = batch_id_input
     and o.override_pct > m.split_agent_pct;
  if problem is not null then
    raise exception 'MIDs % have an override above the merchant''s rate. An override comes out of the rep side: end or change it, then commit.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(r.mid_raw || ' (override #' || o.id || ')', ', ' order by r.row_number)
    into problem
    from rep_payout_import_rows r
    join merchants m on m.mid = r.mid_raw
    join merchant_overrides o
      on o.merchant_id = m.id
     and batch.period >= o.effective_from
     and (o.effective_to is null or batch.period < o.effective_to)
   where r.batch_id = batch_id_input
     and (o.recipient_id = m.agent_id
          or exists (select 1 from merchant_rep_shares s
                      where s.merchant_id = m.id
                        and batch.period >= s.effective_from
                        and (s.effective_to is null or batch.period < s.effective_to)
                        and o.recipient_id in (s.primary_agent_id, s.secondary_agent_id)));
  if problem is not null then
    raise exception 'MIDs % have an override paid to the merchant''s owner or to a party of its shared account. End the override and set it again, then commit.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(r.mid_raw || ' (override #' || o.id || ' to ' || p.full_name || ')', ', '
                    order by r.row_number)
    into problem
    from rep_payout_import_rows r
    join merchants m on m.mid = r.mid_raw
    join merchant_overrides o
      on o.merchant_id = m.id
     and batch.period >= o.effective_from
     and (o.effective_to is null or batch.period < o.effective_to)
    join profiles p on p.id = o.recipient_id
   where r.batch_id = batch_id_input
     and not p.is_active;
  if problem is not null then
    raise exception 'Overrides on MIDs % pay someone who is deactivated. End each override (or reactivate the person), then commit.', problem
      using errcode = 'PT409';
  end if;

  -- 4. The warnings, recomputed: the parser's rowWarnings().
  with flagged as (
    select r.row_number, w.code
      from rep_payout_import_rows r
      join merchants m on m.mid = r.mid_raw
      cross join lateral (values
        ('processor_mismatch',
         r.processor_raw is null
         or lower(btrim(regexp_replace(r.processor_raw, '[\s﻿]+', ' ', 'g')))
            <> lower(btrim(regexp_replace(batch.processor, '[\s﻿]+', ' ', 'g')))
         or (m.processor is not null and m.processor <> batch.processor)),
        ('inactive_merchant', m.status = 'inactive'),
        ('bad_numbers', r.volume <= 0 or r.residual_income > r.volume)
      ) as w(code, hit)
     where r.batch_id = batch_id_input and w.hit
  )
  select jsonb_object_agg(f.code, f.row_list),
         array_agg(f.code order by f.code)
           filter (where not (f.code = any(confirmed)))
    into covered, unconfirmed
    from (select code, jsonb_agg(row_number order by row_number) as row_list
            from flagged group by code) f;

  if cardinality(unconfirmed) > 0 then
    select string_agg(replace(u.code, '_', ' ') || ' (rows '
                      || (select string_agg(x.value, ', ')
                            from jsonb_array_elements_text(covered -> u.code) as x(value))
                      || ')', '; ' order by u.code)
      into problem
      from unnest(unconfirmed) as u(code);
    raise exception 'These warnings were not confirmed: %. Confirm them on the review screen, or fix the data and read the file again.', problem
      using errcode = 'PT409',
            detail = array_to_string(unconfirmed, ',');
  end if;

  -- 5. The replace, then the lines. Every refusal is behind us: from here
  -- on, the commit writes.
  if batch.replaces_batch_id is not null then
    -- The old batch's lines: its import lines, the shared lines derived from
    -- them, and its override lines, which step 6 writes again. Adjustments
    -- carry no batch and stay.
    delete from rep_payout_rows where batch_id = replaced.id;
    get diagnostics removed = row_count;

    update rep_payout_batches
       set status = 'replaced', replaced_by_batch_id = batch_id_input
     where id = replaced.id;
  end if;

  -- Plain inserts, never a merge.
  -- Unshared: the owner's one line at the merchant's rate.
  insert into rep_payout_rows (
    agent_id, period, processor, mid, merchant_name, merchant_id,
    volume, average_ticket, total_cost, volume_confirmed_negative,
    residual_income, rep_split_pct, batch_id
  )
  select
    m.agent_id, batch.period, batch.processor, m.mid,
    coalesce(m.dba, r.merchant_name_raw), m.id,
    r.volume, r.average_ticket, r.total_cost, r.volume < 0,
    r.residual_income, m.split_agent_pct, batch_id_input
    from rep_payout_import_rows r
    join merchants m on m.mid = r.mid_raw
   where r.batch_id = batch_id_input
     and not exists (
       select 1 from merchant_rep_shares s
        where s.merchant_id = m.id
          and batch.period >= s.effective_from
          and (s.effective_to is null or batch.period < s.effective_to));

  get diagnostics unshared = row_count;

  -- Shared, the signer's line: the volume, and the account residual less the
  -- partner's piece.
  insert into rep_payout_rows (
    agent_id, period, processor, mid, merchant_name, merchant_id,
    volume, average_ticket, total_cost, volume_confirmed_negative,
    residual_income, rep_split_pct, batch_id,
    rep_share_id, share_role, primary_rep_pct, secondary_rep_pct,
    account_residual_income
  )
  select
    m.agent_id, batch.period, batch.processor, m.mid,
    coalesce(m.dba, r.merchant_name_raw), m.id,
    r.volume, r.average_ticket, r.total_cost, r.volume < 0,
    r.residual_income
      - shared_part(r.residual_income, s.secondary_rep_pct,
                    s.primary_rep_pct + s.secondary_rep_pct),
    m.split_agent_pct, batch_id_input,
    s.id, 'primary', s.primary_rep_pct, s.secondary_rep_pct,
    r.residual_income
    from rep_payout_import_rows r
    join merchants m on m.mid = r.mid_raw
    join merchant_rep_shares s
      on s.merchant_id = m.id
     and batch.period >= s.effective_from
     and (s.effective_to is null or batch.period < s.effective_to)
   where r.batch_id = batch_id_input;

  get diagnostics signers = row_count;

  -- Shared, the partner's line: no volume (it is counted once, on the
  -- signer's line), the partner's piece of the residual.
  insert into rep_payout_rows (
    agent_id, period, processor, mid, merchant_name, merchant_id,
    volume, average_ticket, total_cost,
    residual_income, rep_split_pct, batch_id,
    rep_share_id, share_role, primary_rep_pct, secondary_rep_pct,
    account_residual_income
  )
  select
    s.secondary_agent_id, batch.period, batch.processor, m.mid,
    coalesce(m.dba, r.merchant_name_raw), m.id,
    null, null, null,
    shared_part(r.residual_income, s.secondary_rep_pct,
                s.primary_rep_pct + s.secondary_rep_pct),
    m.split_agent_pct, batch_id_input,
    s.id, 'secondary', s.primary_rep_pct, s.secondary_rep_pct,
    r.residual_income
    from rep_payout_import_rows r
    join merchants m on m.mid = r.mid_raw
    join merchant_rep_shares s
      on s.merchant_id = m.id
     and batch.period >= s.effective_from
     and (s.effective_to is null or batch.period < s.effective_to)
   where r.batch_id = batch_id_input;

  get diagnostics partners = row_count;

  -- 6. The override lines (phase 10). X = round(R * o / 100, 2), once, from
  -- the account residual; on a shared account the partner's piece of the
  -- deduction is shared_part(X, b, a + b) and the signer's the rest (the
  -- payout's own cent rule). Debits -piece, the credit +X: they net to zero,
  -- and the reps' nets plus the credit are exactly T. On a replacement this
  -- is what rebuilds them.
  with applied as (
    select m.id as merchant_id, m.agent_id as owner_id, m.mid,
           coalesce(m.dba, r.merchant_name_raw) as merchant_name,
           o.id as override_id, o.recipient_id,
           round(r.residual_income * o.override_pct / 100, 2) as x,
           s.secondary_agent_id, s.primary_rep_pct, s.secondary_rep_pct
      from rep_payout_import_rows r
      join merchants m on m.mid = r.mid_raw
      join merchant_overrides o
        on o.merchant_id = m.id
       and batch.period >= o.effective_from
       and (o.effective_to is null or batch.period < o.effective_to)
      left join merchant_rep_shares s
        on s.merchant_id = m.id
       and batch.period >= s.effective_from
       and (s.effective_to is null or batch.period < s.effective_to)
     where r.batch_id = batch_id_input
  ),
  pieces as (
    select a.*,
           case when a.secondary_agent_id is null then 0
                else shared_part(a.x, a.secondary_rep_pct,
                                 a.primary_rep_pct + a.secondary_rep_pct)
           end as partner_piece
      from applied a
  ),
  lines as (
    select owner_id as agent_id, merchant_id, mid, merchant_name, override_id,
           'debit' as role, -(x - partner_piece) as amount
      from pieces
    union all
    select secondary_agent_id, merchant_id, mid, merchant_name, override_id,
           'debit', -partner_piece
      from pieces
     where secondary_agent_id is not null
    union all
    select recipient_id, merchant_id, mid, merchant_name, override_id,
           'credit', x
      from pieces
  )
  insert into rep_payout_rows (
    agent_id, period, processor, mid, merchant_name, merchant_id,
    batch_id, line_kind, override_id, override_role, override_amount
  )
  select
    l.agent_id, batch.period, batch.processor, l.mid, l.merchant_name, l.merchant_id,
    batch_id_input, 'override', l.override_id, l.role, l.amount
    from lines l;

  select count(*) into overrides
    from rep_payout_rows
   where batch_id = batch_id_input and line_kind = 'override'
     and override_role = 'credit';

  -- 7. Close the batch, and the audit rows.
  delete from rep_payout_import_rows where batch_id = batch_id_input;

  update rep_payout_batches
     set status = 'committed', committed_at = now(), row_count = staged,
         skipped_rows = '[]'::jsonb,
         confirmed_warnings = coalesce(covered, '{}'::jsonb)
   where id = batch_id_input;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'commit_residual_import', 'rep_payout_batches',
          batch_id_input::text);

  if batch.replaces_batch_id is not null then
    insert into audit_log (actor_id, action, table_name, row_id)
    values (auth.uid(), 'replace_residual_import', 'rep_payout_batches',
            replaced.id::text);
  end if;

  return jsonb_build_object(
    'written', unshared + signers + partners,
    'rows', staged,
    'shared', signers,
    'overrides', overrides,
    'replaced_lines', removed
  );
end;
$$;

-- PUBLIC (which includes anon) gets EXECUTE on every new function and nothing
-- declarative revokes it. Re-stated: create or replace keeps the existing ACL,
-- but these lines are what the grants test reads.
revoke all on function commit_residual_import_v3(int, text[]) from public;
revoke all on function commit_residual_import_v3(int, text[]) from anon;
grant execute on function commit_residual_import_v3(int, text[]) to authenticated, service_role;

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

-- =====================================================================
-- REPORTS (20261102160000) — phase 12 of docs/design/intake-and-reports.md
-- (§7.2, §4.5, §0b.7, §0c.1, A4d, A17, A18).
--
-- Two read functions behind /admin/reports. Both read ONLY the committed
-- ledger: rep_payout_rows lines whose batch is `committed` (an import or an
-- override line), plus adjustment lines (which carry no batch). A line whose
-- batch is in review, abandoned, replaced or deleted is never counted, and
-- neither is an import or override line with no batch at all. They sum the
-- ledger's own generated rep_payout; there is no second copy of the payout
-- arithmetic here, so a report cannot disagree with a statement.
--
-- SECURITY INVOKER (§7.2; tests assert prosecdef = false), so RLS scopes every
-- row they read, and is_admin() first: a rep is refused (PT403) rather than
-- shown their own rows. Every table read is admin-SELECT or own-or-admin, so
-- the refusal is a second boundary, not the only one. search_path pinned.
-- Each has its own revoke/grant lines; anon has no EXECUTE.
--
-- Months are first-of-month dates, from <= to (22023 otherwise). A processor
-- of NULL means every processor. Under a processor, an adjustment counts only
-- when it carries that processor: a share correction carries none, so it shows
-- under "all processors" only.
--
-- 1. rep_payout_summary(from, to, processor) — Report 1, Owen's columns
--    (§0b.7), one row per rep per month (row_kind 'rep'), a total per month
--    ('month') and a grand total ('total'), by GROUPING SETS:
--      sales_volume       sum(volume) on import lines; a shared account's
--                         volume is on the signer's line only (A18)
--      net_residual       sum(residual_income) on import lines (a shared line
--                         holds the rep's piece)
--      agent_split        sum(rep_payout) on import lines + the rep's override
--                         DEBITS (negative): what they keep of their own
--                         merchants (§4.5). Each line used its merchant's rate
--                         at commit (rep_split_pct); profiles.split_rate_pct is
--                         never read.
--      deductions         sum(rep_payout) on adjustment lines posted in the
--                         month. INFORMATION ONLY, NOT in the total (§0c.1).
--      overrides_received sum(override_amount) on the rep's CREDIT lines (A4d)
--      total_commission   agent_split + overrides_received (§0b.7). So
--                         total_commission + deductions = sum(rep_payout) over
--                         every line the rep has in the month: the statement.
--    agent_code is profiles.agent_number; legal_name is the LLC legal name,
--    or the rep's own legal name when there is none (A17); full_name as is.
--    The house profile (rate 0) appears with its volume and net and a zero
--    split.
--
-- 2. merchant_processor_summary(from, to, processor) — Report 2, one row per
--    MID per processor per month ('merchant'), a subtotal per processor-month
--    ('processor') and a grand total ('total'). Import lines only:
--      volume         sum(volume): the signer's line only on a shared account
--      residual       the ACCOUNT residual: residual_income on an unshared
--                     line, account_residual_income on the signer's line; the
--                     partner's piece is not added again
--      rep_side       sum(rep_payout) over the merchant's import lines (both
--                     halves of a share): the merchant's rate of the residual,
--                     before any override (an override moves money inside
--                     the rep side, never out of the company's share)
--      company_share  residual - rep_side (all of it for a house merchant)
--    The owner is the payee of the unshared or signer line (the owner at
--    commit, never re-read from merchants); merchant_name is the line's
--    snapshot, the name the statement prints.
--
-- So, for any month: sum of Report 1's (agent_split + overrides_received)
-- + Report 2's company_share = the file residuals of the committed batches.
-- Tested over many random cases through the real commit
-- (tests/rls/reports.test.ts).
--
-- REFUSES TO RUN if a ledger or batch column the bodies read is missing
-- (plpgsql is not checked until it is called). Reads and writes no row.
-- =====================================================================

-- 0. What the two bodies read, checked.
do $$
declare
  missing text;
begin
  select string_agg(format('%s.%s', t, c), ', ' order by t, c) into missing
    from (values
      ('rep_payout_rows', 'line_kind'), ('rep_payout_rows', 'processor'),
      ('rep_payout_rows', 'batch_id'), ('rep_payout_rows', 'rep_payout'),
      ('rep_payout_rows', 'share_role'), ('rep_payout_rows', 'account_residual_income'),
      ('rep_payout_rows', 'override_role'), ('rep_payout_rows', 'override_amount'),
      ('rep_payout_batches', 'status'), ('profiles', 'llc_legal_name'),
      ('profiles', 'legal_name'), ('profiles', 'agent_number')
    ) as needed(t, c)
   where not exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = needed.t
                        and column_name = needed.c);
  if missing is not null then
    raise exception 'The reports read columns that are not here: %. Inspect the schema before applying 20261102160000.', missing;
  end if;
end $$;

-- 1. Report 1.
create function rep_payout_summary(
  period_from_input date,
  period_to_input date,
  processor_input text default null
)
returns table (
  row_kind text,
  period date,
  agent_id uuid,
  agent_code text,
  legal_name text,
  full_name text,
  sales_volume numeric,
  net_residual numeric,
  agent_split numeric,
  deductions numeric,
  overrides_received numeric,
  total_commission numeric
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  if not is_admin() then
    raise exception 'Reports are for admins.' using errcode = 'PT403';
  end if;
  if period_from_input is null or period_to_input is null
     or period_from_input <> date_trunc('month', period_from_input)::date
     or period_to_input <> date_trunc('month', period_to_input)::date
     or period_to_input < period_from_input then
    raise exception 'Choose a first and last month, the first no later than the last.'
      using errcode = '22023';
  end if;

  return query
  with lines as (
    select l.period, l.agent_id, l.line_kind, l.override_role,
           l.volume, l.residual_income, l.rep_payout, l.override_amount
      from rep_payout_rows l
      left join rep_payout_batches b on b.id = l.batch_id
     where l.period between period_from_input and period_to_input
       and (processor_input is null or l.processor = processor_input)
       and (l.line_kind = 'adjustment' or b.status = 'committed')
  ),
  agg as (
    select grouping(l.period, l.agent_id) as g, l.period, l.agent_id,
           coalesce(sum(l.volume) filter (where l.line_kind = 'import'), 0) as vol,
           coalesce(sum(l.residual_income) filter (where l.line_kind = 'import'), 0) as net,
           coalesce(sum(l.rep_payout) filter (where l.line_kind = 'import'), 0)
             + coalesce(sum(l.override_amount)
                          filter (where l.line_kind = 'override' and l.override_role = 'debit'), 0)
             as split,
           coalesce(sum(l.rep_payout) filter (where l.line_kind = 'adjustment'), 0) as deduct,
           coalesce(sum(l.override_amount)
                      filter (where l.line_kind = 'override' and l.override_role = 'credit'), 0)
             as received
      from lines l
     group by grouping sets ((l.period, l.agent_id), (l.period), ())
  )
  select case a.g when 0 then 'rep' when 1 then 'month' else 'total' end,
         a.period, a.agent_id, p.agent_number,
         coalesce(p.llc_legal_name, p.legal_name), p.full_name,
         round(a.vol, 2), round(a.net, 2), round(a.split, 2), round(a.deduct, 2),
         round(a.received, 2), round(a.split + a.received, 2)
    from agg a
    left join profiles p on p.id = a.agent_id
   -- An empty selection still answers with its grand total row (zeros), so
   -- skip it: no lines is no rows.
   where exists (select 1 from lines)
   order by a.period nulls last, a.g, p.agent_number nulls last, p.full_name, a.agent_id;
end;
$$;

revoke all on function rep_payout_summary(date, date, text) from public;
revoke all on function rep_payout_summary(date, date, text) from anon;
grant execute on function rep_payout_summary(date, date, text) to authenticated, service_role;

-- 2. Report 2.
create function merchant_processor_summary(
  period_from_input date,
  period_to_input date,
  processor_input text default null
)
returns table (
  row_kind text,
  period date,
  processor text,
  merchant_id int,
  mid text,
  merchant_name text,
  owner_id uuid,
  owner_code text,
  owner_name text,
  volume numeric,
  residual numeric,
  rep_side numeric,
  company_share numeric
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  if not is_admin() then
    raise exception 'Reports are for admins.' using errcode = 'PT403';
  end if;
  if period_from_input is null or period_to_input is null
     or period_from_input <> date_trunc('month', period_from_input)::date
     or period_to_input <> date_trunc('month', period_to_input)::date
     or period_to_input < period_from_input then
    raise exception 'Choose a first and last month, the first no later than the last.'
      using errcode = '22023';
  end if;

  return query
  with lines as (
    select l.period, l.processor, l.mid, l.merchant_id, l.merchant_name, l.agent_id,
           l.share_role, l.volume, l.residual_income, l.account_residual_income,
           l.rep_payout
      from rep_payout_rows l
      join rep_payout_batches b on b.id = l.batch_id
     where l.period between period_from_input and period_to_input
       and (processor_input is null or l.processor = processor_input)
       and l.line_kind = 'import'
       and b.status = 'committed'
  ),
  agg as (
    select grouping(l.period, l.processor, l.mid) as g, l.period, l.processor, l.mid,
           max(l.merchant_id) as merchant_id,
           max(l.merchant_name) filter (where l.share_role is distinct from 'secondary')
             as merchant_name,
           (array_agg(l.agent_id) filter (where l.share_role is distinct from 'secondary'))[1]
             as owner_id,
           coalesce(sum(l.volume), 0) as vol,
           coalesce(sum(case when l.share_role is null then l.residual_income
                             when l.share_role = 'primary' then l.account_residual_income
                        end), 0) as res,
           coalesce(sum(l.rep_payout), 0) as rep
      from lines l
     group by grouping sets ((l.period, l.processor, l.mid), (l.period, l.processor), ())
  )
  select case a.g when 0 then 'merchant' when 1 then 'processor' else 'total' end,
         a.period, a.processor,
         case when a.g = 0 then a.merchant_id end, a.mid,
         case when a.g = 0 then a.merchant_name end,
         case when a.g = 0 then a.owner_id end,
         case when a.g = 0 then p.agent_number end,
         case when a.g = 0 then p.full_name end,
         round(a.vol, 2), round(a.res, 2), round(a.rep, 2), round(a.res - a.rep, 2)
    from agg a
    left join profiles p on p.id = a.owner_id and a.g = 0
   where exists (select 1 from lines)
   order by a.period nulls last, a.processor nulls last, a.g, a.merchant_name, a.mid;
end;
$$;

revoke all on function merchant_processor_summary(date, date, text) from public;
revoke all on function merchant_processor_summary(date, date, text) from anon;
grant execute on function merchant_processor_summary(date, date, text) to authenticated, service_role;

-- =====================================================================
-- ZERO VOLUME IS NOT A BAD NUMBER (20261104120000) — a correction to the
-- bad_numbers warning of docs/design/intake-and-reports.md (§0.4, §0b.3,
-- §2.4).
--
-- bad_numbers was `volume <= 0 or residual > volume`. It is now
--
--     volume < 0  or  (volume > 0 and residual > volume)
--
-- so a ZERO-VOLUME line imports with no warning, whatever its residual:
-- negative (a chargeback or closing fee on a closed merchant), zero, or
-- positive (a monthly fee on a merchant with no sales). Those lines are on
-- most real files, and the confirmation is one yes per warning TYPE per
-- import (§0b.3): with them in it, the admin answered yes every month, and
-- that one yes also passed the rows the warning exists for -- a negative
-- volume, or a residual above a positive volume (the columns swapped).
-- `residual > volume` says nothing at volume 0, where any fee exceeds it.
--
-- Unchanged: a negative volume is still confirmable only through
-- bad_numbers, and v3 still marks exactly those lines volume_confirmed_
-- negative (rep_payout_rows_volume_check, 20261030120000). Volume > 0 with a
-- negative residual is still silent (A25), and so is volume > 0 with zero.
--
-- The rule lives twice and the two move together: rowWarnings() in
-- supabase/functions/_shared/residuals.ts (the preview) and step 4 below
-- (the commit), pinned by the live parse-then-commit test.
--
-- commit_residual_import_v3 is re-created whole: the body of 20261102120000
-- with ONLY the bad_numbers line of step 4 changed. REFUSES TO RUN, naming
-- what it found, if the deployed function does not carry the old rule
-- exactly once (so it is not the body this was copied from).
-- =====================================================================

-- 0. The function this replaces is the one it was copied from.
do $$
declare
  body text := pg_get_functiondef('public.commit_residual_import_v3(int, text[])'::regprocedure);
  old  text := '(''bad_numbers'', r.volume <= 0 or r.residual_income > r.volume)';
begin
  if (length(body) - length(replace(body, old, ''))) / length(old) <> 1 then
    raise exception 'commit_residual_import_v3 does not carry the 20261102120000 bad_numbers rule exactly once here. Inspect pg_get_functiondef before applying 20261104120000.';
  end if;
end $$;

-- 1. v3, step 4's bad_numbers line changed. Otherwise the body of 20261102120000.
create or replace function commit_residual_import_v3(
  batch_id_input  int,
  confirmed_input text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  batch       rep_payout_batches;
  confirmed   text[] := coalesce(confirmed_input, '{}');
  other       rep_payout_batches;
  replaced    rep_payout_batches;
  staged      int;
  blocked     int;
  problem     text;
  unconfirmed text[];
  covered     jsonb;
  unshared    int;
  signers     int;
  partners    int;
  overrides   int := 0;
  removed     int := 0;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  if exists (select 1 from unnest(confirmed) as c(code)
              where c.code is null
                 or c.code not in ('processor_mismatch', 'inactive_merchant',
                                   'bad_numbers')) then
    raise exception 'Only processor_mismatch, inactive_merchant and bad_numbers can be confirmed.'
      using errcode = '22023';
  end if;

  -- 1-2. Locks and guards.
  select * into batch from rep_payout_batches where id = batch_id_input for update;
  if not found then
    raise exception 'import not found' using errcode = 'PT404';
  end if;

  if batch.status <> 'review' then
    raise exception 'this import is already %', batch.status
      using errcode = 'PT409';
  end if;

  if batch.processor is null or batch.period is null then
    raise exception 'This import was started before the processor and month were chosen at upload, so it cannot be committed. Abandon it and upload the file again.'
      using errcode = 'PT409';
  end if;

  -- One committed batch per processor-month, without a race between two
  -- different batches for the same pair.
  perform pg_advisory_xact_lock(hashtext(
    'tapswipe.residual_month:' || batch.processor || '/' || batch.period::text));

  -- A replacement: the batch it replaces must still be the committed one for
  -- this processor-month, and the month must not be marked paid.
  if batch.replaces_batch_id is not null then
    select * into replaced
      from rep_payout_batches where id = batch.replaces_batch_id for update;
    if not found or replaced.status <> 'committed'
       or replaced.processor is distinct from batch.processor
       or replaced.period is distinct from batch.period then
      raise exception 'This file was uploaded to replace import #%, which is no longer the committed import for % for %. Abandon it and upload the file again.',
        batch.replaces_batch_id, batch.processor, to_char(batch.period, 'FMMonth YYYY')
        using errcode = 'PT409';
    end if;

    if exists (select 1 from payout_period_closures
                where period = batch.period and processor = batch.processor) then
      raise exception '% for % is marked paid and cannot be replaced. Reopen it (with a reason), or post an adjustment instead.',
        batch.processor, to_char(batch.period, 'FMMonth YYYY')
        using errcode = 'PT409';
    end if;
  end if;

  select * into other
    from rep_payout_batches
   where processor = batch.processor and period = batch.period
     and status = 'committed' and id <> batch.id
     and id is distinct from batch.replaces_batch_id;
  if found then
    raise exception '% for % is already committed (import #%). A second file for that month replaces it: upload it again and answer Yes to replace.',
      batch.processor, to_char(batch.period, 'FMMonth YYYY'), other.id
      using errcode = 'PT409';
  end if;

  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  -- A replacement may not pull the month out from under an adjustment that
  -- was worked out from the figures it replaces.
  if batch.replaces_batch_id is not null then
    select string_agg(distinct a.mid, ', ') into problem
      from rep_payout_rows a
     where a.line_kind = 'adjustment' and a.adjusts_period = batch.period
       and (a.processor = batch.processor
            or a.mid in (select l.mid from rep_payout_rows l
                          where l.batch_id = replaced.id));
    if problem is not null then
      raise exception 'Adjustments already correct % for % (MIDs %). They were worked out from the committed figures, so the month cannot be replaced under them.',
        batch.processor, to_char(batch.period, 'FMMonth YYYY'), problem
        using errcode = 'PT409';
    end if;
  end if;

  select count(*) into staged
    from rep_payout_import_rows where batch_id = batch_id_input;

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

  -- No owner, MID or rate of a merchant in this file changes until commit.
  perform 1 from merchants m
   where m.mid in (select r.mid_raw from rep_payout_import_rows r
                    where r.batch_id = batch_id_input)
   for share;

  -- 3. Re-derived from the database.
  select string_agg(r.row_number::text, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
   where r.batch_id = batch_id_input and r.period is distinct from batch.period;
  if problem is not null then
    raise exception 'Rows % were read for a different month than this import''s (%). Read the file again.',
      problem, to_char(batch.period, 'FMMonth YYYY')
      using errcode = 'PT409';
  end if;

  select string_agg(r.row_number::text, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
   where r.batch_id = batch_id_input
     and (r.mid_raw is null or btrim(r.mid_raw) = '');
  if problem is not null then
    raise exception 'Rows % have no MID. Fix the file and upload it again.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(d.mid_raw || ' (rows ' || d.row_list || ')', '; ' order by d.mid_raw)
    into problem
    from (select r.mid_raw,
                 string_agg(r.row_number::text, ', ' order by r.row_number) as row_list
            from rep_payout_import_rows r
           where r.batch_id = batch_id_input
           group by r.mid_raw
          having count(*) > 1) d;
  if problem is not null then
    raise exception 'A MID appears on more than one row: %. Fix the file and upload it again.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(r.mid_raw, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
   where r.batch_id = batch_id_input
     and not exists (select 1 from merchants m where m.mid = r.mid_raw);
  if problem is not null then
    raise exception 'MIDs % are not merchants in the CRM. Add them (or correct their MID), then read the file again.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(r.row_number::text, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
   where r.batch_id = batch_id_input
     and lower(regexp_replace(coalesce(r.income_type_raw, ''),
                              '^[\s﻿]+|[\s﻿]+$', '', 'g')) <> 'residuals';
  if problem is not null then
    raise exception 'Rows % have an Income Type other than Residuals. Fix the file and upload it again.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(r.row_number::text, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
   where r.batch_id = batch_id_input
     and (r.volume is null or r.residual_income is null);
  if problem is not null then
    raise exception 'Rows % have no Volume or no Residual. Fix the file and upload it again.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(r.mid_raw, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
    join merchants m on m.mid = r.mid_raw
   where r.batch_id = batch_id_input
     and (r.merchant_id is distinct from m.id
          or r.agent_id is distinct from m.agent_id);
  if problem is not null then
    raise exception 'A merchant''s MID or owner changed after this file was read (MIDs %). Read it again.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(r.mid_raw, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
    join merchants m on m.mid = r.mid_raw
   where r.batch_id = batch_id_input and m.split_agent_pct is null;
  if problem is not null then
    raise exception 'MIDs % belong to merchants with no split rate. Set each merchant''s rate, then commit.', problem
      using errcode = 'PT409';
  end if;

  -- No merge. On a replacement, the lines of the batch being replaced are
  -- about to go, so they are not "already there".
  select string_agg(distinct r.mid_raw, ', ') into problem
    from rep_payout_import_rows r
    join rep_payout_rows l
      on l.mid = r.mid_raw and l.period = batch.period and l.line_kind = 'import'
   where r.batch_id = batch_id_input
     and (batch.replaces_batch_id is null
          or l.batch_id is distinct from batch.replaces_batch_id);
  if problem is not null then
    raise exception 'MIDs % already have a line for %. A committed month is never merged into: read the file again.',
      problem, to_char(batch.period, 'FMMonth YYYY')
      using errcode = 'PT409';
  end if;

  select string_agg(r.mid_raw, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
    join merchants m on m.mid = r.mid_raw
    join merchant_rep_shares s
      on s.merchant_id = m.id
     and batch.period >= s.effective_from
     and (s.effective_to is null or batch.period < s.effective_to)
   where r.batch_id = batch_id_input
     and (s.primary_agent_id <> m.agent_id
          or s.primary_rep_pct + s.secondary_rep_pct <> m.split_agent_pct);
  if problem is not null then
    raise exception 'MIDs % have a shared-account split whose signer is not the merchant''s owner, or whose shares do not total the merchant''s rate. End the share and set it again, then commit.', problem
      using errcode = 'PT409';
  end if;

  -- Overrides in force for the month (phase 10). The functions that set
  -- them hold these rules; a rate, an owner, a share or a person can change
  -- after that, so the commit checks them again.
  select string_agg(r.mid_raw || ' (override #' || o.id || ')', ', ' order by r.row_number)
    into problem
    from rep_payout_import_rows r
    join merchants m on m.mid = r.mid_raw
    join merchant_overrides o
      on o.merchant_id = m.id
     and batch.period >= o.effective_from
     and (o.effective_to is null or batch.period < o.effective_to)
   where r.batch_id = batch_id_input
     and o.override_pct > m.split_agent_pct;
  if problem is not null then
    raise exception 'MIDs % have an override above the merchant''s rate. An override comes out of the rep side: end or change it, then commit.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(r.mid_raw || ' (override #' || o.id || ')', ', ' order by r.row_number)
    into problem
    from rep_payout_import_rows r
    join merchants m on m.mid = r.mid_raw
    join merchant_overrides o
      on o.merchant_id = m.id
     and batch.period >= o.effective_from
     and (o.effective_to is null or batch.period < o.effective_to)
   where r.batch_id = batch_id_input
     and (o.recipient_id = m.agent_id
          or exists (select 1 from merchant_rep_shares s
                      where s.merchant_id = m.id
                        and batch.period >= s.effective_from
                        and (s.effective_to is null or batch.period < s.effective_to)
                        and o.recipient_id in (s.primary_agent_id, s.secondary_agent_id)));
  if problem is not null then
    raise exception 'MIDs % have an override paid to the merchant''s owner or to a party of its shared account. End the override and set it again, then commit.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(r.mid_raw || ' (override #' || o.id || ' to ' || p.full_name || ')', ', '
                    order by r.row_number)
    into problem
    from rep_payout_import_rows r
    join merchants m on m.mid = r.mid_raw
    join merchant_overrides o
      on o.merchant_id = m.id
     and batch.period >= o.effective_from
     and (o.effective_to is null or batch.period < o.effective_to)
    join profiles p on p.id = o.recipient_id
   where r.batch_id = batch_id_input
     and not p.is_active;
  if problem is not null then
    raise exception 'Overrides on MIDs % pay someone who is deactivated. End each override (or reactivate the person), then commit.', problem
      using errcode = 'PT409';
  end if;

  -- 4. The warnings, recomputed: the parser's rowWarnings().
  with flagged as (
    select r.row_number, w.code
      from rep_payout_import_rows r
      join merchants m on m.mid = r.mid_raw
      cross join lateral (values
        ('processor_mismatch',
         r.processor_raw is null
         or lower(btrim(regexp_replace(r.processor_raw, '[\s﻿]+', ' ', 'g')))
            <> lower(btrim(regexp_replace(batch.processor, '[\s﻿]+', ' ', 'g')))
         or (m.processor is not null and m.processor <> batch.processor)),
        ('inactive_merchant', m.status = 'inactive'),
        ('bad_numbers', r.volume < 0 or (r.volume > 0 and r.residual_income > r.volume))
      ) as w(code, hit)
     where r.batch_id = batch_id_input and w.hit
  )
  select jsonb_object_agg(f.code, f.row_list),
         array_agg(f.code order by f.code)
           filter (where not (f.code = any(confirmed)))
    into covered, unconfirmed
    from (select code, jsonb_agg(row_number order by row_number) as row_list
            from flagged group by code) f;

  if cardinality(unconfirmed) > 0 then
    select string_agg(replace(u.code, '_', ' ') || ' (rows '
                      || (select string_agg(x.value, ', ')
                            from jsonb_array_elements_text(covered -> u.code) as x(value))
                      || ')', '; ' order by u.code)
      into problem
      from unnest(unconfirmed) as u(code);
    raise exception 'These warnings were not confirmed: %. Confirm them on the review screen, or fix the data and read the file again.', problem
      using errcode = 'PT409',
            detail = array_to_string(unconfirmed, ',');
  end if;

  -- 5. The replace, then the lines. Every refusal is behind us: from here
  -- on, the commit writes.
  if batch.replaces_batch_id is not null then
    -- The old batch's lines: its import lines, the shared lines derived from
    -- them, and its override lines, which step 6 writes again. Adjustments
    -- carry no batch and stay.
    delete from rep_payout_rows where batch_id = replaced.id;
    get diagnostics removed = row_count;

    update rep_payout_batches
       set status = 'replaced', replaced_by_batch_id = batch_id_input
     where id = replaced.id;
  end if;

  -- Plain inserts, never a merge.
  -- Unshared: the owner's one line at the merchant's rate.
  insert into rep_payout_rows (
    agent_id, period, processor, mid, merchant_name, merchant_id,
    volume, average_ticket, total_cost, volume_confirmed_negative,
    residual_income, rep_split_pct, batch_id
  )
  select
    m.agent_id, batch.period, batch.processor, m.mid,
    coalesce(m.dba, r.merchant_name_raw), m.id,
    r.volume, r.average_ticket, r.total_cost, r.volume < 0,
    r.residual_income, m.split_agent_pct, batch_id_input
    from rep_payout_import_rows r
    join merchants m on m.mid = r.mid_raw
   where r.batch_id = batch_id_input
     and not exists (
       select 1 from merchant_rep_shares s
        where s.merchant_id = m.id
          and batch.period >= s.effective_from
          and (s.effective_to is null or batch.period < s.effective_to));

  get diagnostics unshared = row_count;

  -- Shared, the signer's line: the volume, and the account residual less the
  -- partner's piece.
  insert into rep_payout_rows (
    agent_id, period, processor, mid, merchant_name, merchant_id,
    volume, average_ticket, total_cost, volume_confirmed_negative,
    residual_income, rep_split_pct, batch_id,
    rep_share_id, share_role, primary_rep_pct, secondary_rep_pct,
    account_residual_income
  )
  select
    m.agent_id, batch.period, batch.processor, m.mid,
    coalesce(m.dba, r.merchant_name_raw), m.id,
    r.volume, r.average_ticket, r.total_cost, r.volume < 0,
    r.residual_income
      - shared_part(r.residual_income, s.secondary_rep_pct,
                    s.primary_rep_pct + s.secondary_rep_pct),
    m.split_agent_pct, batch_id_input,
    s.id, 'primary', s.primary_rep_pct, s.secondary_rep_pct,
    r.residual_income
    from rep_payout_import_rows r
    join merchants m on m.mid = r.mid_raw
    join merchant_rep_shares s
      on s.merchant_id = m.id
     and batch.period >= s.effective_from
     and (s.effective_to is null or batch.period < s.effective_to)
   where r.batch_id = batch_id_input;

  get diagnostics signers = row_count;

  -- Shared, the partner's line: no volume (it is counted once, on the
  -- signer's line), the partner's piece of the residual.
  insert into rep_payout_rows (
    agent_id, period, processor, mid, merchant_name, merchant_id,
    volume, average_ticket, total_cost,
    residual_income, rep_split_pct, batch_id,
    rep_share_id, share_role, primary_rep_pct, secondary_rep_pct,
    account_residual_income
  )
  select
    s.secondary_agent_id, batch.period, batch.processor, m.mid,
    coalesce(m.dba, r.merchant_name_raw), m.id,
    null, null, null,
    shared_part(r.residual_income, s.secondary_rep_pct,
                s.primary_rep_pct + s.secondary_rep_pct),
    m.split_agent_pct, batch_id_input,
    s.id, 'secondary', s.primary_rep_pct, s.secondary_rep_pct,
    r.residual_income
    from rep_payout_import_rows r
    join merchants m on m.mid = r.mid_raw
    join merchant_rep_shares s
      on s.merchant_id = m.id
     and batch.period >= s.effective_from
     and (s.effective_to is null or batch.period < s.effective_to)
   where r.batch_id = batch_id_input;

  get diagnostics partners = row_count;

  -- 6. The override lines (phase 10). X = round(R * o / 100, 2), once, from
  -- the account residual; on a shared account the partner's piece of the
  -- deduction is shared_part(X, b, a + b) and the signer's the rest (the
  -- payout's own cent rule). Debits -piece, the credit +X: they net to zero,
  -- and the reps' nets plus the credit are exactly T. On a replacement this
  -- is what rebuilds them.
  with applied as (
    select m.id as merchant_id, m.agent_id as owner_id, m.mid,
           coalesce(m.dba, r.merchant_name_raw) as merchant_name,
           o.id as override_id, o.recipient_id,
           round(r.residual_income * o.override_pct / 100, 2) as x,
           s.secondary_agent_id, s.primary_rep_pct, s.secondary_rep_pct
      from rep_payout_import_rows r
      join merchants m on m.mid = r.mid_raw
      join merchant_overrides o
        on o.merchant_id = m.id
       and batch.period >= o.effective_from
       and (o.effective_to is null or batch.period < o.effective_to)
      left join merchant_rep_shares s
        on s.merchant_id = m.id
       and batch.period >= s.effective_from
       and (s.effective_to is null or batch.period < s.effective_to)
     where r.batch_id = batch_id_input
  ),
  pieces as (
    select a.*,
           case when a.secondary_agent_id is null then 0
                else shared_part(a.x, a.secondary_rep_pct,
                                 a.primary_rep_pct + a.secondary_rep_pct)
           end as partner_piece
      from applied a
  ),
  lines as (
    select owner_id as agent_id, merchant_id, mid, merchant_name, override_id,
           'debit' as role, -(x - partner_piece) as amount
      from pieces
    union all
    select secondary_agent_id, merchant_id, mid, merchant_name, override_id,
           'debit', -partner_piece
      from pieces
     where secondary_agent_id is not null
    union all
    select recipient_id, merchant_id, mid, merchant_name, override_id,
           'credit', x
      from pieces
  )
  insert into rep_payout_rows (
    agent_id, period, processor, mid, merchant_name, merchant_id,
    batch_id, line_kind, override_id, override_role, override_amount
  )
  select
    l.agent_id, batch.period, batch.processor, l.mid, l.merchant_name, l.merchant_id,
    batch_id_input, 'override', l.override_id, l.role, l.amount
    from lines l;

  select count(*) into overrides
    from rep_payout_rows
   where batch_id = batch_id_input and line_kind = 'override'
     and override_role = 'credit';

  -- 7. Close the batch, and the audit rows.
  delete from rep_payout_import_rows where batch_id = batch_id_input;

  update rep_payout_batches
     set status = 'committed', committed_at = now(), row_count = staged,
         skipped_rows = '[]'::jsonb,
         confirmed_warnings = coalesce(covered, '{}'::jsonb)
   where id = batch_id_input;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'commit_residual_import', 'rep_payout_batches',
          batch_id_input::text);

  if batch.replaces_batch_id is not null then
    insert into audit_log (actor_id, action, table_name, row_id)
    values (auth.uid(), 'replace_residual_import', 'rep_payout_batches',
            replaced.id::text);
  end if;

  return jsonb_build_object(
    'written', unshared + signers + partners,
    'rows', staged,
    'shared', signers,
    'overrides', overrides,
    'replaced_lines', removed
  );
end;
$$;

-- PUBLIC (which includes anon) gets EXECUTE on every new function and nothing
-- declarative revokes it. Re-stated: create or replace keeps the existing ACL,
-- but these lines are what the grants test reads.
revoke all on function commit_residual_import_v3(int, text[]) from public;
revoke all on function commit_residual_import_v3(int, text[]) from anon;
grant execute on function commit_residual_import_v3(int, text[]) to authenticated, service_role;

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
as $$
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
$$;

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
-- accounts_in_city(city, state) -- "do we already have accounts in this
-- city?" (20261013131000)
--
-- check_duplicates()'s design, applied to a different question. The answer
-- that matters is the one RLS hides -- the accounts in OTHER reps' books --
-- so this is `security definer` and reaches across every book on purpose, and
-- it pays for that reach the same two ways:
--
--   1. a hand-written guard, is_active_agent(), which covers admins too and
--      refuses a deactivated account whose JWT is still inside its hour; and
--   2. a deliberately narrow return shape. A non-admin gets FOUR fields per
--      account -- dba, legal_business_name, city, state -- and nothing else:
--      no id, no owning rep, no status, no street, no zip, no contact detail.
--      Built with jsonb_build_object per row, so "nothing else" means the keys
--      are ABSENT, not present-and-null; a fixed `returns table` would have to
--      carry the admin columns as nulls, which is the column list announcing
--      what exists. Applied to the caller's OWN merchants as well: the rep has
--      /merchants for those, and one shape for every non-admin row means no
--      row's shape says whose it is.
--   An admin, who can already read every merchant, also gets merchant_id (for
--   the link), agent_id and agent_name, status, street and zip.
--
-- MATCHING IS EQUALITY ON norm_city() AND NOTHING ELSE: no LIKE, no ILIKE, no
-- trigram, no prefix. That is the boundary, not a simplification. A fuzzy or
-- prefix match turns "find accounts in a city" into "list every account whose
-- city starts with S", which is a cross-book enumeration with extra steps. %,
-- _ and * reach norm_city() as punctuation and become spaces. There is also no
-- "list the cities" function and there must not be one for non-admins: the
-- caller has to already know the city they are asking about.
--
-- INPUT RULES, each a 22023 (invalid_parameter_value, a 400 through
-- PostgREST) with a message the UI can show as-is:
--   city   required; at most 60 characters trimmed; at least 2 characters
--          once normalised. The same range merchants_location_format puts on
--          stored cities, so nothing stored is unfindable.
--   state  optional exact filter; trimmed and upper-cased, then must be two
--          letters. Blank means no filter.
-- A city with no accounts is NOT an error: {"results": [], "has_more": false}.
--
-- STATUS RULE. merchants.status is 'active' | 'inactive' | 'other' -- there is
-- no 'closed' or 'cancelled'. 'inactive' is the closed state here (an account
-- that no longer processes), so it is the one excluded; 'active' and 'other'
-- are returned. Written as an exclusion rather than an allow-list on purpose:
-- the question is "is this city already covered", and an unknown future
-- status should show up in the answer rather than silently vanish from it.
--
-- CAP: 100 accounts, ordered by state, dba, id, plus `has_more` when there
-- were more. Fetches 101 to know, and never says how many more.
--
-- AUDITED AND RATE-LIMITED (20261023120000, security review phase 5). It was
-- first written unaudited, like check_duplicates(). The review's point: the
-- input is a public city name, so a rep can loop over a list of US cities and
-- rebuild the company's merchant list (DBA, legal name, city, state; up to
-- 100 per city) with nothing recorded. Two controls, both inside this
-- function, where a client cannot skip them:
--
--   AUDIT. Every call that returns an answer writes one audit_log row:
--   actor_id = the caller, action = 'accounts_in_city:<cities queried>',
--   table_name = 'merchants', row_id null. The qualifier after the colon is
--   the number of cities in the call -- always 1, because the function takes
--   one city -- in the templated-verb form read_pre_app_secrets:<mode> already
--   uses, since audit_log has no detail column. The city asked about and the
--   results are NOT recorded. Admins are audited too. The insert has no
--   exception handler: no audit row, no answer. A call refused for any reason
--   (inactive caller, bad input, over the limit) raises, which rolls the whole
--   call back, so it leaves no row -- and returns nothing.
--
--   CAP. One city per call, by signature. The cap Owen set is 5 per call; a
--   one-city function is inside it, and a multi-city variant would have to
--   revisit this.
--
--   RATE LIMIT. A non-admin gets 30 calls per rolling hour. The counter is the
--   audit rows themselves -- the caller's 'accounts_in_city:%' rows newer than
--   now() - 1 hour -- so it is durable, survives restarts, needs no new table,
--   and cannot be reset by a client (authenticated holds SELECT only on
--   audit_log and no policy lets a rep read, let alone delete, a row). A
--   pg_advisory_xact_lock keyed on the caller serialises one rep's concurrent
--   calls, so two at 29 cannot both pass. The 31st call raises PT429 (HTTP
--   429 through PostgREST) with a sentence the UI shows verbatim, saying how
--   many minutes until the oldest call in the window ages out. Admins are
--   exempt from the limit, not from the audit.
--   audit_log_city_search_idx (partial, on actor_id and created_at) keeps the
--   count an index range scan.
--
-- No longer `stable`: it writes. supabase-js calls RPCs with POST, which
-- PostgREST runs read-write; a GET call would now be refused.
--
-- The parameters are named `city` and `state` because that is the RPC's
-- public argument list; they collide with the merchants columns, so every
-- column reference below is qualified with `m.` and every parameter reference
-- with the function name.
-- =====================================================================
create or replace function accounts_in_city(city text, state text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  raw_city  text := btrim(coalesce(accounts_in_city.city, ''));
  state_key text := nullif(upper(btrim(coalesce(accounts_in_city.state, ''))), '');
  city_key  text;
  caller_is_admin boolean;
  recent_calls int;
  oldest_call timestamptz;
  wait_minutes int;
  result_rows jsonb;
  more boolean;
begin
  if not is_active_agent() then
    raise exception 'not authorised' using errcode = 'PT403';
  end if;

  if raw_city = '' then
    raise exception 'Enter a city.' using errcode = '22023';
  end if;
  if char_length(raw_city) > 60 then
    raise exception 'A city name is at most 60 characters.' using errcode = '22023';
  end if;
  city_key := norm_city(raw_city);
  if city_key is null or char_length(city_key) < 2 then
    raise exception 'Enter at least 2 letters of the city name.' using errcode = '22023';
  end if;
  if state_key is not null and state_key !~ '^[A-Z]{2}$' then
    raise exception 'State must be a two-letter code.' using errcode = '22023';
  end if;

  caller_is_admin := is_admin();

  if not caller_is_admin then
    perform pg_advisory_xact_lock(hashtextextended('accounts_in_city:' || auth.uid()::text, 0));
    select count(*), min(a.created_at)
      into recent_calls, oldest_call
      from audit_log a
     where a.actor_id = auth.uid()
       and a.action like 'accounts_in_city:%'
       and a.created_at > now() - interval '1 hour';
    if recent_calls >= 30 then
      wait_minutes := greatest(1, ceil(extract(epoch from
                        (oldest_call + interval '1 hour' - now())) / 60)::int);
      raise exception 'You have reached the limit of 30 city searches an hour. Try again in % minute%.',
        wait_minutes, case when wait_minutes = 1 then '' else 's' end
        using errcode = 'PT429';
    end if;
  end if;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'accounts_in_city:1', 'merchants', null);

  select coalesce(jsonb_agg(r.row_json order by r.rn) filter (where r.rn <= 100),
                  '[]'::jsonb),
         count(*) > 100
    into result_rows, more
    from (
      select row_number() over (order by m.state, lower(m.dba), m.id) as rn,
             case when caller_is_admin then
               jsonb_build_object(
                 'merchant_id', m.id,
                 'dba', m.dba,
                 'legal_business_name', m.legal_business_name,
                 'city', m.city,
                 'state', m.state,
                 'street', m.street,
                 'zip', m.zip,
                 'status', m.status,
                 'agent_id', m.agent_id,
                 'agent_name', p.full_name)
             else
               jsonb_build_object(
                 'dba', m.dba,
                 'legal_business_name', m.legal_business_name,
                 'city', m.city,
                 'state', m.state)
             end as row_json
        from merchants m
        left join profiles p on p.id = m.agent_id
       where norm_city(m.city) = city_key
         and (state_key is null or m.state = state_key)
         and m.status <> 'inactive'
       order by rn
       limit 101
    ) r;

  return jsonb_build_object('results', result_rows, 'has_more', more);
end;
$$;

revoke all on function accounts_in_city(text, text) from public;
grant execute on function accounts_in_city(text, text) to authenticated, service_role;

-- The rate limit's count: one rep's city-search rows in the last hour.
create index audit_log_city_search_idx on audit_log (actor_id, created_at)
  where action like 'accounts_in_city:%';


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
-- The *_secrets tables -- three here, four since pre_app_tax_secrets
-- (20261026140000), which revokes and grants its own -- get NO grant for
-- `authenticated`. Their
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

-- documents: SELECT only, since 20261013121000 closed the legacy upload path.
-- It was `select, insert, delete` (never UPDATE: nothing edited a document row
-- in place). The one remaining policy admits an admin, so a rep's SELECT
-- returns zero rows rather than an error -- the same shape as audit_log.
grant select on documents to authenticated;

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
--
-- UPDATE ON TWO COLUMNS, as of 20261014160000 (phase 3b of
-- docs/design/residual-splits.md), the quotes.status arrangement. Those two
-- are the only columns any client path writes: the inline cell sends one of
-- them, the bulk split sends rep_split_pct, and the partner-rate copy trigger
-- (security invoker, so it runs with the admin's privileges) writes
-- rep_split_pct. Everything else -- the file-sourced columns, the share and
-- adjustment columns, batch_id -- is written only by the definer commit, by
-- set_shared_residual (definer), by FK actions (which run as the table
-- owner) or by the service role, none of which this grant reaches. The share
-- and adjustment columns were already refused by guard_shared_line(); the
-- grant refuses them FIRST, with `permission denied`, and refuses an admin's
-- hand edit of merchant_name, mid or volume as well, which no trigger did.
-- RLS cannot express a column restriction; only a grant can.
--
-- Two statements for the same reason as quotes below: `grant select, update
-- (a, b), delete` would read as if the column list applied to all three.
grant select, delete on rep_payout_rows to authenticated;
grant update (residual_income, rep_split_pct) on rep_payout_rows to authenticated;

-- rep_payout_batches: SELECT to list them, UPDATE to abandon one. No INSERT (the
-- Storage key contains the batch id, so residual-import-file-url creates the row
-- server-side before the upload exists) and no DELETE (a batch is the record that
-- an import happened).
--
-- UPDATE ON (status) ONLY, as of 20261016140000 (phase 4b of
-- docs/design/residual-splits.md). Abandon writes status and nothing else; every
-- other column is written by the service role or a definer function. Table-wide,
-- an admin's session could PATCH skipped_rows to '[]' or set
-- skips_acknowledged_at with no audit row -- clearing the skip record the
-- acknowledgement exists to keep honest. Two statements, as for rep_payout_rows.
-- WHICH status change that UPDATE may make is a trigger's job, not a grant's
-- (a grant cannot see values): guard_batch_status_transition(), 20261016170000,
-- admits a signed-in user's review -> abandoned and nothing else.
grant select on rep_payout_batches to authenticated;
grant update (status) on rep_payout_batches to authenticated;

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

-- business_documents: the marketing_materials arrangement exactly. SELECT is
-- every active rep's browse, INSERT and UPDATE are held by `authenticated` and
-- admitted by policy for nobody but an admin, and DELETE is absent from both
-- layers -- the UI's "Delete" is an UPDATE of archived_at.
grant select, insert, update on business_documents to authenticated;

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

-- brands: all four verbs, admitted for nobody but an admin except SELECT. The
-- DELETE that products withholds is granted here because the FK, not the
-- grant, is what decides whether a delete would destroy anything: a brand no
-- product names is not history, and one that is named is refused by
-- `on delete restrict`.
grant select, insert, update, delete on brands to authenticated;

-- processors: SELECT and nothing else, for both roles. The list changes only
-- by migration, so no client verb is backed by any policy and none is
-- granted -- a write is `permission denied`, not a filtered no-op. The
-- service role gets SELECT for the residual import functions that will
-- validate a chosen processor (phase 6-7 of docs/design/intake-and-reports.md);
-- no Edge Function writes it. No sequence: the key is the code. Revoked to
-- nothing first: on the local stack the default ACL for role postgres still
-- gives service_role TRUNCATE/REFERENCES/TRIGGER/MAINTAIN on every new table.
revoke all on processors from anon, authenticated, service_role;
grant select on processors to authenticated;
grant select on processors to service_role;

-- product_compatibility: products' three verbs plus DELETE, which products
-- deliberately withholds. The difference is not an inconsistency -- see the
-- policy's own note. A product is archived because quote lines name it; a
-- compatibility row is a current-state claim nothing snapshots, so an admin
-- unlinking an accessory a vendor stopped supporting should remove the row
-- rather than leave a tombstone every reader must filter.
--
-- No sequence grant, and that is not a missed line from the checklist: the
-- primary key is the (addon, device) PAIR, so the table has no `_id_seq` for a
-- grant to refer to.
grant select, insert, update, delete on product_compatibility to authenticated;

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
  -- documents_id_seq is NOT here any more: 20261013121000 revoked it along
  -- with INSERT on documents, since nothing `authenticated` does consumes it.
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
  -- An admin's INSERT into business_documents through PostgREST is admitted
  -- by policy, so the sequence is granted for marketing_materials' reason.
  -- The function's own inserts run as service_role.
  business_documents_id_seq,
  -- All three catalog/quote sequences, for the same reason as the two above
  -- and none of the rep_payout ones: every insert to these tables is made by
  -- `authenticated` through PostgREST or through create_quote_version(), which
  -- is security INVOKER and so consumes nextval() as the caller rather than as
  -- the owner. An invoker RPC is exactly the case where forgetting a sequence
  -- grant produces `permission denied for sequence` from inside a function
  -- whose own EXECUTE grant looks correct.
  products_id_seq,
  -- An admin adding a brand is an ordinary PostgREST insert as
  -- `authenticated`, so nextval() is reached on the ordinary path.
  brands_id_seq,
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
-- SUPABASE STORAGE — four private buckets, all created by migrations:
-- `documents`, `residual-imports` and `marketing` by 20261009170000 (9 Oct
-- 2026), and `business-documents` by 20261013120500 (13 Oct 2026). None of
-- them gets storage policies referencing these tables — all
-- upload/download access goes through Edge Functions that authorize the
-- caller first and only then mint a short-lived signed URL with the
-- service-role client.
--
--   documents         LEGACY, CLOSED. No function signs into it any more:
--                     create-upload-url, create-download-url and
--                     delete-document were removed with 20261013121000, so
--                     the bucket is reachable only by the service role
--                     (scripts/purge-legacy-documents.mjs). Kept, not
--                     dropped, until that purge has been run deliberately.
--                     Keys were {agent_id}/{owner_type}/{owner_id}/{uuid}.
--
--   business-documents business-document-file-url. Keys:
--                     {document_id}/{file_name}. The company library behind
--                     /documents. Same two-direction shape as `marketing`:
--                     UPLOAD is admin-only, DOWNLOAD is open to every active
--                     signed-in user, and an archived ("deleted") document
--                     is signed for nobody.
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
--                     which made it the first bucket whose two directions
--                     have different answers — a rep reads the library, an
--                     admin stocks it. `business-documents` copies that.
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
-- WHY A MIGRATION, after a month of creating them out-of-band. Until
-- 20261009170000 no bucket was in any migration: the hosted ones were made
-- by hand in the dashboard and the local ones by test helpers and seed
-- scripts. `marketing` was added after the hosted buckets were made, nobody
-- made it on dev, and nothing noticed -- every upload there failed with
-- "Could not create upload URL: The related resource does not exist" (the
-- message a missing bucket produces), while the test helpers, which created
-- the bucket themselves, stayed green. A bucket the code depends on is
-- schema, so it is created where the schema is.
--
-- `on conflict (id) do nothing`, NOT do update: a hosted bucket that
-- already exists keeps whatever it was configured with, so pushing this can
-- never change a live bucket's privacy or limit. It only fills in a missing
-- one.
--
-- THE GUARD IS FOR THE HERMETIC SUITE ONLY. `npm test` applies every
-- migration to PGlite over a minimal auth shim with no `storage` schema, so
-- an unguarded insert would fail all of it. On a real Supabase stack the
-- storage schema exists before migrations run (verified locally: after a
-- `supabase db reset` the three buckets exist), so the early return is
-- never taken there.
--
-- NO POLICY ON storage.objects, deliberately: every access is a signed URL
-- minted by a service-role Edge Function after it has authorized the
-- caller. A "reps read, admins write" storage policy would let a client skip
-- that function -- its audit row, its archived-material check, and the
-- marketing bucket's inline-type allow-list.
--
do $$
begin
  if to_regclass('storage.buckets') is null then
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit)
  values
    ('documents',        'documents',        false, 52428800),
    ('residual-imports', 'residual-imports', false, 52428800),
    ('marketing',        'marketing',        false, 52428800)
  on conflict (id) do nothing;
end
$$;

-- The fourth bucket, in its own migration (20261013120500) because the one
-- above is already applied everywhere and an applied migration is never
-- edited. Same guard, same `on conflict (id) do nothing`, same limit, same
-- absence of storage policies -- tests/unit/storage-buckets-migration.test.ts
-- pins each of those properties on both files.
do $$
begin
  if to_regclass('storage.buckets') is null then
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit)
  values
    ('business-documents', 'business-documents', false, 52428800)
  on conflict (id) do nothing;
end
$$;

--
-- SET A PER-BUCKET file_size_limit ON ALL FOUR. This is not optional and it is
-- not what config.toml's `[storage] file_size_limit` does. Measured on the
-- local stack with that set to "50MiB": a 120 MiB PUT through
-- uploadToSignedUrl was accepted, and so was a 120 MiB service-role
-- upload. Both buckets came back from listBuckets() with
-- file_size_limit = null, which is what was actually in force -- no
-- ceiling at all, at any layer, so one rep with a video file could fill
-- the project's storage quota. `documents` is provisioned at
-- MAX_DOCUMENT_BYTES (lib/documents.ts, 50 MiB = 52428800 bytes), which the
-- migration above sets on any bucket it creates. Because it never updates an
-- EXISTING bucket, a hosted bucket made by hand before the limit existed
-- still needs it set from the dashboard or via storage.updateBucket; the test
-- helpers and seed-dev-local.mjs re-assert it locally on every run. lib/documents.ts also refuses an over-size file client-side, which
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
