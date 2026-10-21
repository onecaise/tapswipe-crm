-- Pre-app children are frozen with their parent: a rep changes the owners,
-- terminal and business profile of a DRAFT only. Security fix phase 2;
-- docs/claude/security-fixes.md.
--
-- Matches docs/tapswipe_crm_schema.sql, updated first ("PRE-APP CHILDREN ARE
-- FROZEN WITH THEIR PARENT", after the three child tables).
--
-- The finding, reproduced by tests/rls/pre-app-children-draft-only.test.ts
-- against the schema before this file: the child policies check that the
-- parent pre-app is the rep's, never its status. After submit_pre_app() a rep
-- could rewrite owners on a submitted or approved application, add one, or
-- delete one -- which cascades the stored SSN row away.
-- pre_apps_guard_transitions already freezes the parent row itself; this
-- applies the same rule ("agents edit drafts, admins edit anything") to its
-- children. No policy or grant changes.

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

  -- A parent that is not found is a cascade from a pre_apps delete; the
  -- children go with it. Ownership is the policies' job, after this.
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

drop trigger if exists pre_app_owners_draft_only on pre_app_owners;
create trigger pre_app_owners_draft_only
  before insert or update or delete on pre_app_owners
  for each row execute function pre_app_children_guard();

drop trigger if exists pre_app_terminal_draft_only on pre_app_terminal;
create trigger pre_app_terminal_draft_only
  before insert or update or delete on pre_app_terminal
  for each row execute function pre_app_children_guard();

drop trigger if exists pre_app_business_profile_draft_only on pre_app_business_profile;
create trigger pre_app_business_profile_draft_only
  before insert or update or delete on pre_app_business_profile
  for each row execute function pre_app_children_guard();
