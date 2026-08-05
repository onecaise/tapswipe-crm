-- =====================================================================
-- Gate own-row access on active status; add profiles self-service RPC.
--
-- Brings the database in line with docs/tapswipe_crm_schema.sql and §5 of
-- docs/tapswipe_crm_master_plan.md. Three changes:
--
--   1. is_active_agent() — new security definer helper. Before this,
--      is_admin() checked is_active but every other policy's own-row
--      branch was a bare `agent_id = auth.uid()`, so a deactivated agent
--      who was still logged in (or who logged back in before their
--      auth.users row was banned) kept full read/write access to their
--      own merchants, leads, pre-apps, documents, tickets, notes and
--      tasks. Every own-row branch below is now gated on it.
--
--   2. profiles update policy gains the `with check` clause it was
--      missing, so a row can't be mutated past the policy on the way out.
--
--   3. update_own_full_name() — profiles deliberately has no self-update
--      policy (that would let an agent try to set their own role to
--      'admin'), so self-service edits go through this narrow RPC, which
--      only ever touches full_name no matter what is passed in.
--
-- 33 policies across 12 tables are dropped and recreated — Postgres has
-- no `create or replace policy`. Migrations run in a single transaction,
-- so there is no window where a table sits unprotected.
--
-- Deliberately NOT changed:
--   * profiles select — own-row branch stays a bare `id = auth.uid()`.
--     A deactivated user reading their own name/role is harmless, and
--     gating it would break the deactivated-user UI.
--   * the three *_secrets tables — still zero policies. Never add one.
--   * audit_log — admin-only select, no own-row branch to gate.
--   * `admin delete only` policies — is_admin() already checks is_active.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. is_active_agent()
-- ---------------------------------------------------------------------
-- security definer for the same reason as is_admin(): a policy on
-- profiles that queried profiles directly would recurse.
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

-- ---------------------------------------------------------------------
-- 2. profiles — add the missing `with check`
-- ---------------------------------------------------------------------
drop policy if exists "admin manages profiles" on profiles;
create policy "admin manages profiles" on profiles
  for update using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------------------
-- 3. update_own_full_name()
-- ---------------------------------------------------------------------
-- security definer because there is no self-update policy on profiles
-- for this to ride on. Three things keep it safe: the is_active_agent()
-- guard fails closed before any write, `where id = auth.uid()` means the
-- caller cannot name a target row, and full_name is the only column in
-- the set list regardless of input. The guard matters because this is
-- the one write path to profiles that does not pass through RLS.
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

-- =====================================================================
-- 4. Own-row policy branches, gated on is_active_agent()
-- =====================================================================

-- --- MERCHANTS -------------------------------------------------------
drop policy if exists "select own or admin" on merchants;
create policy "select own or admin" on merchants
  for select using ((agent_id = auth.uid() and is_active_agent()) or is_admin());
drop policy if exists "insert own" on merchants;
create policy "insert own" on merchants
  for insert with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());
drop policy if exists "update own or admin" on merchants;
create policy "update own or admin" on merchants
  for update using ((agent_id = auth.uid() and is_active_agent()) or is_admin())
  with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());

-- --- LEADS -----------------------------------------------------------
drop policy if exists "select own or admin" on leads;
create policy "select own or admin" on leads
  for select using ((agent_id = auth.uid() and is_active_agent()) or is_admin());
drop policy if exists "insert own" on leads;
create policy "insert own" on leads
  for insert with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());
drop policy if exists "update own or admin" on leads;
create policy "update own or admin" on leads
  for update using ((agent_id = auth.uid() and is_active_agent()) or is_admin())
  with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());

-- --- GHOST SHEETS ----------------------------------------------------
drop policy if exists "select own or admin" on ghost_sheets;
create policy "select own or admin" on ghost_sheets
  for select using ((agent_id = auth.uid() and is_active_agent()) or is_admin());
drop policy if exists "insert own" on ghost_sheets;
create policy "insert own" on ghost_sheets
  for insert with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());
drop policy if exists "update own or admin" on ghost_sheets;
create policy "update own or admin" on ghost_sheets
  for update using ((agent_id = auth.uid() and is_active_agent()) or is_admin())
  with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());

-- --- PRE-APPS --------------------------------------------------------
drop policy if exists "select own or admin" on pre_apps;
create policy "select own or admin" on pre_apps
  for select using ((agent_id = auth.uid() and is_active_agent()) or is_admin());
drop policy if exists "insert own" on pre_apps;
create policy "insert own" on pre_apps
  for insert with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());
drop policy if exists "update own or admin" on pre_apps;
create policy "update own or admin" on pre_apps
  for update using ((agent_id = auth.uid() and is_active_agent()) or is_admin())
  with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());

-- --- PRE-APP OWNERS --------------------------------------------------
-- Child tables have no agent_id; they reach the check through the
-- parent. is_active_agent() wraps the exists() rather than joining into
-- it, since the activity check is about the caller, not the parent row.
drop policy if exists "select via parent pre_app" on pre_app_owners;
create policy "select via parent pre_app" on pre_app_owners
  for select using (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  );
drop policy if exists "insert via parent pre_app" on pre_app_owners;
create policy "insert via parent pre_app" on pre_app_owners
  for insert with check (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  );
drop policy if exists "update via parent pre_app" on pre_app_owners;
create policy "update via parent pre_app" on pre_app_owners
  for update using (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  );

-- --- PRE-APP TERMINAL ------------------------------------------------
drop policy if exists "select via parent pre_app" on pre_app_terminal;
create policy "select via parent pre_app" on pre_app_terminal
  for select using (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  );
drop policy if exists "insert via parent pre_app" on pre_app_terminal;
create policy "insert via parent pre_app" on pre_app_terminal
  for insert with check (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  );
drop policy if exists "update via parent pre_app" on pre_app_terminal;
create policy "update via parent pre_app" on pre_app_terminal
  for update using (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  );

-- --- PRE-APP BUSINESS PROFILE ----------------------------------------
drop policy if exists "select via parent pre_app" on pre_app_business_profile;
create policy "select via parent pre_app" on pre_app_business_profile
  for select using (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  );
drop policy if exists "insert via parent pre_app" on pre_app_business_profile;
create policy "insert via parent pre_app" on pre_app_business_profile
  for insert with check (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  );
drop policy if exists "update via parent pre_app" on pre_app_business_profile;
create policy "update via parent pre_app" on pre_app_business_profile
  for update using (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  );

-- --- DOCUMENTS -------------------------------------------------------
-- Note the delete policy is gated too: documents is the one table where
-- an own-row delete exists (reps remove their own uploads), so a
-- deactivated agent could otherwise still destroy document metadata.
drop policy if exists "select own or admin" on documents;
create policy "select own or admin" on documents
  for select using ((agent_id = auth.uid() and is_active_agent()) or is_admin());
drop policy if exists "insert own" on documents;
create policy "insert own" on documents
  for insert with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());
drop policy if exists "delete own or admin" on documents;
create policy "delete own or admin" on documents
  for delete using ((agent_id = auth.uid() and is_active_agent()) or is_admin());

-- --- SUPPORT TICKETS -------------------------------------------------
drop policy if exists "select own or admin" on support_tickets;
create policy "select own or admin" on support_tickets
  for select using ((agent_id = auth.uid() and is_active_agent()) or is_admin());
drop policy if exists "insert own" on support_tickets;
create policy "insert own" on support_tickets
  for insert with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());
drop policy if exists "update own or admin" on support_tickets;
create policy "update own or admin" on support_tickets
  for update using ((agent_id = auth.uid() and is_active_agent()) or is_admin())
  with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());

-- --- NOTES -----------------------------------------------------------
drop policy if exists "select own or admin" on notes;
create policy "select own or admin" on notes
  for select using ((agent_id = auth.uid() and is_active_agent()) or is_admin());
drop policy if exists "insert own" on notes;
create policy "insert own" on notes
  for insert with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());

-- --- TASKS -----------------------------------------------------------
drop policy if exists "select own or admin" on tasks;
create policy "select own or admin" on tasks
  for select using ((agent_id = auth.uid() and is_active_agent()) or is_admin());
drop policy if exists "insert own" on tasks;
create policy "insert own" on tasks
  for insert with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());
drop policy if exists "update own or admin" on tasks;
create policy "update own or admin" on tasks
  for update using ((agent_id = auth.uid() and is_active_agent()) or is_admin())
  with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());
