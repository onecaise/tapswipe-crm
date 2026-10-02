-- profiles.manager_id -- who a rep reports to, and the RPC that is the only
-- way to write it.
--
-- Matches docs/tapswipe_crm_schema.sql, updated first.
--
-- NOT A THIRD ROLE, and that is the first thing to be clear about, because
-- "add managers" sounds like a role and is not one here. `role` stays
-- ('agent','admin'). Every policy in this schema is a binary is_admin() check
-- -- around forty of them, plus the hand-written guard at the top of every
-- `security definer` RPC -- so a third role means either a third branch in all
-- of them or a manages() helper called alongside is_admin() everywhere, which
-- is a rewrite of the access-control design rather than a feature. This column
-- is the cheap half of what people actually want from that: it records the
-- reporting structure without granting anybody anything.
--
-- NOT AN ACCESS BOUNDARY, the same line 20261002143000_profiles_territory.sql
-- holds for territory and for the same reason. No policy reads manager_id and
-- none may start to. What this makes possible is FILTERING, by an admin who
-- already sees every row -- `agent_id in (select id from profiles where
-- manager_id = $1)` in a dashboard query -- and nothing about what a rep, or a
-- manager, can see of their own accord changes. "A manager sees their reps'
-- books" is a different and much larger feature: it rewrites the own-row half
-- of the policies on all seven owner tables, turns a per-row equality into a
-- join against profiles, and needs an answer for a rep whose manager changes
-- mid-deal. tests/rls/set-manager.test.ts greps pg_policies for the word and
-- asserts zero hits, because the existing policy tests would not notice -- all
-- their fixtures share one manager (none), exactly as they share one territory.

-- `on delete set null`, and this is the NINETEENTH reference to profiles(id)
-- and the ONE deliberate exception to the NO ACTION pattern the other eighteen
-- share.
--
-- Those eighteen are NO ACTION because each carries evidence -- an audit row,
-- a ledger row, a record a rep owns -- and silently dropping the pointer would
-- drop the meaning with it, so the delete is made to FAIL until a person
-- decides what happens to the evidence. (That is the trap the three teardown
-- lists exist for; see CLAUDE.md.) This column is not evidence. It is a
-- current fact about who reports to whom, and a manager leaving should not
-- block deleting their profile the way an unresolved payout row correctly
-- does. The honest post-condition of that deletion is "these reps now report
-- to nobody", which is precisely what `set null` writes.
--
-- Chosen rather than inherited, and pinned as a choice:
-- tests/rls/user-imports.test.ts counts nineteen AND names this column as the
-- single non-default one, so a twentieth arriving with its own ON DELETE still
-- reds a test instead of quietly joining an exception list.
alter table profiles
  add column if not exists manager_id uuid
    references profiles(id) on delete set null;

-- No index. profiles is small, Manage Users reads all of it anyway, and
-- nothing resolves a rep THROUGH this column the way the residuals import
-- resolves one through agent_number -- the reasoning territory gives.

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

-- Postgres grants EXECUTE to PUBLIC (which includes anon) on every new
-- function, and there is no declarative backstop for it -- `alter default
-- privileges ... revoke execute on functions from public` is a verified no-op
-- here, which is why tests/rls/grants.test.ts pins the gap instead. Without
-- these two lines this RPC is callable unauthenticated from the moment it
-- exists, and it writes profiles.
revoke all on function set_manager(uuid, uuid) from public;
grant execute on function set_manager(uuid, uuid) to authenticated, service_role;

-- No grant change to profiles and no policy change. The select policy is
-- untouched, so an agent still sees only their own row -- which means a rep
-- can read who their own manager is and nothing else, the same boundary that
-- already governs role, agent_number and territory. The column carries no new
-- privilege in either direction.
