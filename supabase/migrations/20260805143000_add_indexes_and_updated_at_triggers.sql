-- =====================================================================
-- Indexes on every RLS filter column, plus updated_at maintenance.
--
-- Mirrors the index/trigger DDL in docs/tapswipe_crm_schema.sql, per §14.8
-- of docs/tapswipe_crm_master_plan.md: "Every RLS policy filters on
-- agent_id — that means every single query against every table implicitly
-- filters on it too. Add a plain btree index on every agent_id column now,
-- while tables are empty; it costs nothing today and prevents a real
-- slowdown later as data grows."
--
-- Three groups:
--   1. agent_id on all eight tables that carry it. Every policy's own-row
--      branch filters on this column, so every query does.
--   2. The columns list pages actually filter on — merchants.status
--      (the /merchants status filter), pre_apps.status, and
--      leads.next_followup_date.
--   3. pre_app_id on the three pre_apps child tables. Their policies reach
--      the access check through `exists (select 1 from pre_apps where
--      pre_apps.id = pre_app_id ...)`, which filters on this column on
--      every read and write.
--
-- Then set_updated_at(), because merchants/leads/pre_apps all declare
-- `updated_at timestamptz default now()` but nothing advanced it — the
-- column held the creation time forever, so anything showing "last
-- updated" was quietly wrong.
--
-- Written as a new timestamped migration rather than an edit to
-- 20260804201300_initial_schema.sql (§14.1). That one is already recorded
-- as applied on the linked project; Supabase tracks migrations by version,
-- so editing it would never re-run and the DDL would silently never reach
-- production while still showing up in local resets and the test harness.
-- =====================================================================

-- ---------------------------------------------------------------------
-- agent_id — every RLS policy filters on it
-- ---------------------------------------------------------------------
create index idx_merchants_agent_id on merchants(agent_id);
create index idx_leads_agent_id on leads(agent_id);
create index idx_ghost_sheets_agent_id on ghost_sheets(agent_id);
create index idx_pre_apps_agent_id on pre_apps(agent_id);
create index idx_documents_agent_id on documents(agent_id);
create index idx_support_tickets_agent_id on support_tickets(agent_id);
create index idx_notes_agent_id on notes(agent_id);
create index idx_tasks_agent_id on tasks(agent_id);

-- ---------------------------------------------------------------------
-- list-page filter columns
-- ---------------------------------------------------------------------
create index idx_merchants_status on merchants(status);
create index idx_pre_apps_status on pre_apps(status);
create index idx_leads_next_followup_date on leads(next_followup_date);

-- ---------------------------------------------------------------------
-- pre_apps child tables — policies filter on pre_app_id via exists()
-- ---------------------------------------------------------------------
create index idx_pre_app_owners_pre_app_id on pre_app_owners(pre_app_id);
create index idx_pre_app_terminal_pre_app_id on pre_app_terminal(pre_app_id);
create index idx_pre_app_business_profile_pre_app_id on pre_app_business_profile(pre_app_id);

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
