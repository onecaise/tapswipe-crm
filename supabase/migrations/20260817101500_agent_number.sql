-- profiles.agent_number, so a processor's residual report can name a rep.
--
-- Residuals arrive monthly as an XLSX whose "Agent #" column is the only thing
-- in the file that identifies who earned a merchant's residual. That file has
-- never heard of a uuid, and this database has never heard of an agent number:
-- a repo-wide grep for agent_number / rep_code / employee_id / agent_code before
-- this migration returned nothing at all. The only rep identifiers were the uuid
-- PK, full_name and email, none of which appear in a processor's export.
--
-- So this column is the join, and RESIDUALS_SPEC.md is what it is for.
--
-- Text rather than int, deliberately: processor codes are not arithmetic.
-- Leading zeros are significant ('0471' is a different rep from '471'), some
-- carry letters, and nothing anywhere adds or orders them numerically.
--
-- Nullable, and staying that way. Every existing profile has no number and there
-- is nothing to backfill from -- a migration that invented agent numbers would
-- be inventing the key that decides who gets paid. Admins fill them in from
-- Manage Users, or from the import review screen when an unrecognised number
-- turns up.
--
-- Matches docs/tapswipe_crm_schema.sql, updated first.

alter table profiles
  add column if not exists agent_number text;

-- One rep per agent number, but many reps with none.
--
-- Partial rather than a plain `unique` constraint. Postgres does not treat NULLs
-- as equal, so a plain unique would in fact permit the many-nulls half too --
-- this is not fixing that, it is stating the intent and declining to index the
-- nulls that every row currently carries.
--
-- Load-bearing for the import: resolution is a lookup of one agent number
-- expecting at most one rep. Two reps sharing a number makes it ambiguous which
-- of them a merchant's residual belongs to, and the importer would have no
-- honest answer -- so the database refuses to reach that state rather than
-- leaving the ambiguity for application code to notice.
create unique index if not exists profiles_agent_number_key
  on profiles (agent_number) where agent_number is not null;

-- ---------------------------------------------------------------------
-- set_agent_number(target_user_id uuid, new_agent_number text)
--
-- Tier 2, the same shape as set_user_role in 20260811094500_manage_users.sql and
-- for the same two reasons: profiles has no UPDATE policy at all (the 11 Aug
-- security audit removed it), and audit_log has no INSERT policy for
-- `authenticated`, so a plain client write could not log itself.
--
-- Worth auditing even though the column reads like a label: it is a commission
-- key. Which rep an agent number points at decides who gets paid for a
-- merchant's residual. `security definer` bundles the write and its audit row
-- into one statement so they cannot come apart.
--
-- Deliberately NOT guarded against a self-target, unlike set_user_role. An admin
-- who also carries a book has an agent number like anyone else, and setting
-- their own removes no privilege and loses them no screen. That guard exists to
-- make zero-active-admins unreachable; there is no equivalent trap here.
--
-- Blank clears. '' is normalised to null rather than stored, because '' is a
-- value the unique index enforces -- the second rep cleared that way would
-- collide with the first, and the error would name a constraint nobody typed.
--
-- The duplicate check is for the message, not the guarantee. The unique index
-- above is the authority and closes the race; this exists so an admin reads
-- "already assigned to another rep" rather than a raw index violation, on a
-- screen where they can see every rep and so can act on it.
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
  -- create-user applies to this same column on the way in. Both sides trim and
  -- cap at 32; keep them in step or one path accepts what the other rejects.
  if normalised is not null and length(normalised) > 32 then
    raise exception 'agent number must be 32 characters or fewer'
      using errcode = 'PT400';
  end if;

  select * into target from profiles where id = target_user_id;
  if not found then
    raise exception 'user not found' using errcode = 'PT404';
  end if;

  -- `is not distinct from` rather than `=`, so clearing an already-empty number
  -- is the no-op it looks like rather than falling through to an audit row
  -- claiming something changed.
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

  -- Distinct verbs rather than one action, for the reason set_user_role gives:
  -- audit_log has no detail column, so the direction lives in `action` or is
  -- lost.
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

-- Postgres grants EXECUTE to PUBLIC (which includes anon) on every new function,
-- and there is no declarative backstop for it -- see tests/rls/grants.test.ts.
-- Without these two lines this RPC is callable unauthenticated from the moment
-- it exists, and it writes profiles.
revoke all on function set_agent_number(uuid, text) from public;
grant execute on function set_agent_number(uuid, text) to authenticated, service_role;

-- No grant change to profiles, and no policy change. The select policy is
-- untouched, so an agent still sees only their own row and an admin sees all --
-- the same boundary that already governs full_name, email and role. The column
-- carries no new privilege. Same reasoning as 20260813171344_profiles_email.sql.
--
-- No plain index either: the unique index above already serves the one lookup
-- that exists (agent_number -> profile, during import), and Manage Users reads
-- every profile anyway.
