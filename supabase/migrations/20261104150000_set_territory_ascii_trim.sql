-- set_territory() trims every ASCII whitespace character, as set_rep_identity()
-- does, not only spaces. Carried over from phase 2 of
-- docs/design/intake-and-reports.md (found there, not fixed).
--
-- Matches docs/tapswipe_crm_schema.sql, updated first; the block below is
-- copied from it verbatim.
--
-- =====================================================================
-- SET_TERRITORY TRIMS ASCII WHITESPACE (20261104150000) — phase 13 of
-- docs/design/intake-and-reports.md, carried over from phase 2.
--
-- set_territory() normalised with plain btrim(x), which strips spaces only, so
-- "\tSoutheast" was stored with its tab: a value that renders like
-- "Southeast", compares unequal to it, and splits one territory into two in
-- any grouping. It now trims E' \t\n\r\f\x0b' -- space, tab, newline,
-- carriage return, form feed and vertical tab -- the set set_rep_identity()
-- (20261026120000) and the profiles_legal_name_format CHECK use. A value that
-- is only those characters clears the territory, as a blank one always did.
--
-- Re-created whole from 20261002143000 with ONLY the normalising line
-- changed (security definer, search_path, guards, audit verbs and grants as
-- they were). REFUSES TO RUN unless the deployed function carries the old
-- line exactly once.
--
-- No row guard and no backfill: the migration writes no row. A territory
-- already stored with a tab or newline at either end (none is expected; the
-- Manage Users cell sends what was typed) stays as it is until an admin sets
-- it again, which now trims it. This query lists any:
--   select id, territory from profiles
--    where territory <> btrim(territory, E' \t\n\r\f\x0b');
-- =====================================================================

-- 0. The function this replaces is the one it was copied from.
do $$
declare
  body text := pg_get_functiondef('public.set_territory(uuid, text)'::regprocedure);
  old  text := 'normalised := nullif(btrim(coalesce(new_territory, '''')), '''');';
begin
  if (length(body) - length(replace(body, old, ''))) / length(old) <> 1 then
    raise exception 'set_territory does not carry the 20261002143000 normalising line exactly once here. Inspect pg_get_functiondef before applying 20261104150000.';
  end if;
end $$;

-- 1. set_territory, the normalising line changed. Otherwise the body of
-- 20261002143000.
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

  normalised := nullif(btrim(coalesce(new_territory, ''), E' \t\n\r\f\x0b'), '');

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
