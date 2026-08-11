-- Manage Users: the forced-password-change flag and the two RPCs behind the
-- admin screen.
--
-- Mirrors docs/tapswipe_crm_schema.sql, which is the spec.
--
-- The three Edge Functions (create-user, deactivate-user,
-- admin-reset-password) need no schema of their own: they write profiles and
-- audit_log with the service role, which bypasses RLS. What does need schema is
-- the half that must work without the service-role key -- a rep clearing their
-- own flag, and an admin changing someone's role.

-- ---------------------------------------------------------------------
-- profiles.must_change_password
--
-- Makes §8's "forced to set a real password on first login" enforceable rather
-- than a convention. Set by create-user and admin-reset-password, cleared by
-- clear_must_change_password() below; the (app) route-group layout redirects to
-- /auth/update-password while it is true, so a temporary password an admin knows
-- cannot survive as a working credential.
--
-- A column rather than auth.users.app_metadata: requireUser() already loads this
-- row on every request so reading it is free, and a column is assertable in the
-- hermetic PGlite suite where app_metadata is not.
--
-- Existing rows default to false. Backfilling true would lock every current user
-- out of the app and into the password form on their next request, including the
-- bootstrap admin.
-- ---------------------------------------------------------------------
alter table profiles
  add column if not exists must_change_password boolean not null default false;

-- ---------------------------------------------------------------------
-- clear_must_change_password()
--
-- The only way a rep can retire their own temporary password, since profiles has
-- no self-update policy. Touches one column on one row, whatever the caller
-- does. Same shape and reasoning as update_own_full_name().
--
-- Deliberately NOT gated on is_active_agent(): a deactivated user cannot reach
-- it anyway (they cannot log in), and a gate would leave anyone switched off
-- mid-password-change with the flag stuck on.
-- ---------------------------------------------------------------------
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
-- set_user_role(target_user_id uuid, new_role text)
--
-- Tier 2, not an Edge Function: no service-role key and no Auth Admin API are
-- involved, only a server-side admin check and an audit row.
--
-- `security definer` despite the "admin manages profiles" UPDATE policy already
-- existing, because audit_log has no INSERT policy for `authenticated`. Without
-- it an admin could change a role from the client and leave no trail; bundling
-- both writes here means the change and its audit row cannot come apart.
--
-- Guards beyond is_admin(), in order: the role vocabulary; no self-demotion; and
-- no demoting the last active admin.
--
-- The self-demotion guard is the load-bearing one. It is what makes zero active
-- admins unreachable, and zero active admins is the only unrecoverable state
-- here: nobody could create users or reach /admin/users, and recovery would be
-- hand-written SQL in the dashboard.
--
-- The last-active-admin check below is therefore UNREACHABLE as written, and
-- that is worth stating rather than leaving as a puzzle. is_admin() means the
-- caller is an active admin; the self-guard means the caller is not the target;
-- so an active admin other than the target always exists and the `exists` test
-- always passes. It is kept as depth, for the plausible future edit that relaxes
-- self-demotion once a second admin exists — at which point this becomes the
-- check that stops the last one going. Do not write a test claiming to exercise
-- it: any such test actually exercises the self-guard.
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

  -- No-op rather than an audit row claiming a role changed when it did not.
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

  -- Distinct verbs rather than one action plus a detail column: audit_log has no
  -- detail column, and the direction is the whole point of the entry.
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

-- Postgres grants EXECUTE to PUBLIC (which includes anon) on every new function,
-- and there is no declarative backstop for it -- see tests/rls/grants.test.ts.
-- Without these lines both RPCs are callable unauthenticated.
revoke all on function clear_must_change_password() from public;
grant execute on function clear_must_change_password() to authenticated, service_role;
revoke all on function set_user_role(uuid, text) from public;
grant execute on function set_user_role(uuid, text) to authenticated, service_role;
