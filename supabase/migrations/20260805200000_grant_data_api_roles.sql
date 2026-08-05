-- =====================================================================
-- Expose the schema to the Data API roles.
--
-- Matches the DATA API GRANTS section of docs/tapswipe_crm_schema.sql.
--
-- Why this exists: RLS decides which ROWS a caller sees; grants decide
-- whether the caller may touch the table at all. Nothing in the three
-- earlier migrations granted anything, so every table in `public` was
-- reachable only by `postgres`. Through PostgREST — which is how the
-- Next app AND every Edge Function talk to the database — the result was
-- `permission denied for table profiles` for anon, authenticated and
-- service_role alike. Perfect policies on an unreachable table.
--
-- This was not caught earlier for two reasons, both now fixed:
--
--   1. The old Supabase behaviour auto-exposed new entities created in
--      `public` by `postgres`. That is deprecated; the current cloud
--      default is always-revoked, and the `auto_expose_new_tables`
--      escape hatch in config.toml is removed on 2026-10-30. A fresh
--      project gets no grants.
--   2. tests/helpers/db.ts applied its own grant block before running
--      the RLS suite, on the assumption that "Supabase grants these as
--      part of project setup, so the migrations don't". That block was
--      papering over this gap and has been removed, so the RLS tests now
--      exercise the grants below.
--
-- Role by role: anon gets nothing (sign-up is off, there is no public
-- data, and login goes through /auth/v1 rather than PostgREST);
-- authenticated gets broad table grants and lets RLS do the enforcing;
-- service_role gets everything, since it bypasses RLS by design and is
-- what the Edge Functions run on.
-- =====================================================================

grant usage on schema public to anon, authenticated, service_role;

-- Deliberately broader than the policies. RLS is the enforcement layer
-- and is what tests/rls asserts; a grant list shaped to match each
-- table's policy set would be an untested second copy of the rules, free
-- to drift out of step. Where a table has no policy for a command
-- (documents has no UPDATE policy, audit_log has no INSERT policy), RLS
-- denies it regardless of the grant.
--
-- Listed one table at a time rather than `all tables in schema public`:
-- a table added later starts with no access and fails loudly on first
-- use, which forces the author back to this list.
grant select, insert, update, delete on
  profiles,
  merchants,
  leads,
  ghost_sheets,
  pre_apps,
  pre_app_owners,
  pre_app_terminal,
  pre_app_business_profile,
  documents,
  support_tickets,
  notes,
  tasks,
  audit_log
to authenticated;

-- The three *_secrets tables are absent from that list on purpose. Their
-- zero-policy RLS already denies `authenticated` everything; withholding
-- the grant is the second lock on the same door, so that if a policy is
-- ever mistakenly added to one of them the table still isn't reachable.

-- USAGE without SELECT: nextval() is all a serial insert needs, while
-- SELECT on a sequence would expose last_value — a free row count of
-- every other agent's book, straight past RLS.
grant usage on
  merchants_id_seq,
  leads_id_seq,
  ghost_sheets_id_seq,
  pre_apps_id_seq,
  pre_app_owners_id_seq,
  pre_app_terminal_id_seq,
  pre_app_business_profile_id_seq,
  documents_id_seq,
  support_tickets_id_seq,
  notes_id_seq,
  tasks_id_seq,
  audit_log_id_seq
to authenticated;

grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- Functions. Postgres grants EXECUTE to PUBLIC at creation time, which
-- would leave every RPC callable by anon; revoked first so the grants
-- below are the complete list. is_admin() and is_active_agent() must be
-- executable by `authenticated` because the policies call them during
-- RLS evaluation, which runs as the querying role — without it every
-- policy check errors instead of returning false.
revoke all on function is_admin() from public;
revoke all on function is_active_agent() from public;
revoke all on function update_own_full_name(text) from public;
revoke all on function approve_pre_app(int) from public;
revoke all on function convert_ghost_sheet_to_lead(int) from public;

grant execute on function is_admin() to authenticated, service_role;
grant execute on function is_active_agent() to authenticated, service_role;
grant execute on function update_own_full_name(text) to authenticated, service_role;
grant execute on function approve_pre_app(int) to authenticated, service_role;
grant execute on function convert_ghost_sheet_to_lead(int) to authenticated, service_role;
