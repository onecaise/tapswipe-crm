-- Close the INSERT half of the pre-app status guard.
-- docs/tapswipe_crm_schema.sql is the spec and was updated first; this brings
-- the migrations in line with it.
--
-- The hole: pre_apps_guard_transitions has been BEFORE UPDATE since
-- 20260806141000, so `status` was unwritable after the fact and wide open on
-- the way in. The insert policy reads agent_id and nothing else, the CHECK
-- admits all four statuses as legal INITIAL values, and 20260805200000 grants
-- insert at table level with no column list -- so any active rep could
--
--   POST /rest/v1/pre_apps  {"agent_id": "<self>", "status": "approved", ...}
--
-- and reach a terminal state with no is_admin() check, no merchants row and no
-- audit row (pre_apps_audit_cross_agent logs only when the actor differs from
-- the row's agent_id, and on your own insert it does not).
--
-- status = 'submitted' was worse: it lands a fabricated row in the admin queue
-- having skipped every completeness rule in submit_pre_app(), and
-- approve_pre_app() re-checks only `status = 'submitted'` -- so an admin
-- approving in good faith would create a real merchant, carrying the rep's own
-- split_agent_pct, from an application with no owner and no banking details.
--
-- No data fix accompanies this. The guard rejects new bad rows; it cannot know
-- whether an existing non-draft pre-app got there legitimately, and on every
-- known database these rows came from the RPCs. If you suspect otherwise, the
-- query is a non-draft pre_apps row with no matching audit_log entry:
--
--   select p.id, p.status from pre_apps p
--    where p.status <> 'draft'
--      and not exists (select 1 from audit_log a
--                       where a.table_name = 'pre_apps' and a.row_id = p.id::text);
--
-- (submit_pre_app writes no audit row, so a 'submitted' row is expected to
-- come back from that query -- it is a starting point, not a verdict.)

-- 1. The guard learns INSERT ------------------------------------------
-- Body is otherwise byte-identical to 20260806141000's. The flag check stays
-- first so the documented escape hatch covers both verbs; test fixtures that
-- legitimately need a non-draft row set it around their own insert.
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

-- 2. Re-point the trigger at both verbs --------------------------------
-- Replacing the existing trigger rather than adding a second one: the function
-- already branches on tg_op, and a separate insert-only trigger would let
-- someone drop half the guard while the other half went on looking like full
-- coverage -- which is the shape of the bug this closes.
--
-- `create or replace function` above does not touch the trigger's event list,
-- so this drop is required, not tidiness.
drop trigger if exists pre_apps_guard_transitions on pre_apps;

create trigger pre_apps_guard_transitions
  before insert or update on pre_apps
  for each row execute function pre_apps_guard_transitions();

-- No grant changes. 20260811143000 already revoked execute on this function
-- from authenticated, and a trigger function does not need it -- the trigger
-- fires as the table owner regardless of who ran the statement.
