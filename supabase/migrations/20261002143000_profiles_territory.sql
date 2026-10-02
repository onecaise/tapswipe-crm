-- profiles.territory -- a sales region label for grouping and reporting, and
-- the RPC that is the only way to write it.
--
-- Matches docs/tapswipe_crm_schema.sql, updated first.
--
-- FREE TEXT, NOT A CHECK VOCABULARY. Territories are reference data an admin
-- extends as the company opens a region, which is the same reasoning
-- support_tickets.category, sub_category and priority stay free text: a
-- constrained vocabulary would mean a migration every time someone opens an
-- office, and the thing being constrained is a label nothing computes on. No
-- policy reads it, no query groups by it in SQL, no import resolves through it.
-- Contrast agent_number, which looks like the same shape of column and is not:
-- that one is a join key against a processor's file, so it carries a uniqueness
-- rule and a length cap matched to a second system. This carries neither. One
-- rep per agent number; any number of reps per territory.
--
-- NOT AN ACCESS BOUNDARY, and this is the line to hold. RLS scopes every
-- agent_id table by `agent_id = auth.uid()` and nothing anywhere reads
-- territory to decide what a caller may see. "Agents see their whole territory"
-- is a different and much larger feature: it would rewrite the own-row half of
-- every policy on all seven owner tables, turn a per-row equality check into a
-- join against profiles, and need an answer for a rep whose territory changes
-- while holding live deals. If that is ever wanted it is its own migration with
-- its own policy tests. Adding territory to a policy as a convenience, without
-- that work, silently widens every rep's book.
--
-- Nullable, for the reason agent_number is: every profile that predates this
-- column has none and there is nothing anywhere to backfill from. Inventing a
-- territory would be inventing the answer to a reporting question nobody asked.

alter table profiles
  add column if not exists territory text;

-- No index. Nothing looks a rep up BY territory -- Manage Users reads every
-- profile anyway, and any grouping happens over a handful of rows in the
-- application. agent_number has one only because the residuals import resolves
-- through it, which is exactly the use this column does not have.

-- ---------------------------------------------------------------------
-- set_territory(target_user_id uuid, new_territory text)
--
-- Tier 2, the same shape as set_agent_number in 20260817101500 and
-- set_user_role in 20260811094500. It exists for a structural reason rather
-- than as a matter of taste: profiles has no UPDATE policy at all (the 11 Aug
-- security audit removed the admin one), and audit_log has no INSERT policy for
-- `authenticated`, so a plain client write could neither reach the column nor
-- log itself. A `security definer` RPC with a hand-written is_admin() guard is
-- the ONLY way a new profiles column becomes settable. Do not answer this with
-- a policy -- the missing UPDATE policy is the design.
--
-- Audited despite being a label. Not because territory decides anything, but
-- because the write path is admin-only and every admin action on another
-- person's profile leaves a trail. log_cross_agent_change() does that for the
-- seven owner tables and profiles is not one of them, so each of these RPCs
-- writes its own row. `security definer` bundles the update and the audit
-- insert into one statement so they cannot come apart.
--
-- Blank clears, normalised to null rather than stored -- the same rule
-- set_agent_number follows, arrived at differently. There, '' would collide in
-- the partial unique index; here there is no index to collide in, but
-- "unassigned" having two representations that render identically and compare
-- unequal is its own bug, and `where territory is null` is how any report will
-- ask the question.
--
-- 64 characters, and no duplicate check. Nothing resolves through this column,
-- so there is no ambiguity to prevent and no second system whose limit has to
-- be matched -- unlike isAgentNumber() in _shared/admin-users.ts, which this
-- deliberately has no twin of. The cap exists only so a pasted paragraph fails
-- as a readable message rather than becoming a table cell nobody can read.
--
-- NOT guarded against a self-target. An admin who also carries a book has a
-- territory like anyone else and setting their own removes no privilege. The
-- same reasoning set_agent_number gives, and the opposite of set_user_role,
-- whose self-guard is what makes zero-active-admins unreachable.
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

  -- Distinct verbs rather than one action, for the reason set_user_role gives:
  -- audit_log has no detail column, so the direction lives in `action` or is
  -- lost.
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

-- Postgres grants EXECUTE to PUBLIC (which includes anon) on every new
-- function, and there is no declarative backstop for it -- `alter default
-- privileges ... revoke execute on functions from public` is a verified no-op
-- here, which is why tests/rls/grants.test.ts pins the gap instead. Without
-- these two lines this RPC is callable unauthenticated from the moment it
-- exists, and it writes profiles.
revoke all on function set_territory(uuid, text) from public;
grant execute on function set_territory(uuid, text) to authenticated, service_role;

-- No grant change to profiles, and no policy change. The select policy is
-- untouched, so an agent still sees only their own row and an admin sees all --
-- the same boundary that already governs full_name, email, role and
-- agent_number. The column carries no new privilege. Same reasoning as
-- 20260817101500_agent_number.sql and 20260813171344_profiles_email.sql.
