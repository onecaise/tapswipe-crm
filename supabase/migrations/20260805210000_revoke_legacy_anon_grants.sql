-- =====================================================================
-- Revoke the legacy platform grants, and close the door behind them.
--
-- Matches the REVOKE LEGACY PLATFORM GRANTS section of
-- docs/tapswipe_crm_schema.sql.
--
-- 20260805200000 only ADDED privileges, so on a project created before
-- Supabase's always-revoked default it layered the intended model on top
-- of the legacy blanket grants instead of replacing them. Probed on the
-- linked project (ref vdjtosofrimipklbdjbi) on 2026-08-05: `anon` gets a
-- 200 with zero rows on all 16 tables — the three *_secrets tables
-- included — and can still execute is_admin(), which the previous
-- migration had revoked from PUBLIC. So `anon` holds its own explicit
-- grant, and a revoke aimed at PUBLIC never touched it. A schema dump
-- confirms it object by object (`GRANT ALL ON TABLE "public"."merchants"
-- TO "anon"`, and the same for pre_app_owner_secrets); those per-object
-- grants are the default privileges in §3 below, materialised at CREATE
-- time and re-rendered by pg_dump as explicit statements. One mechanism,
-- not two.
--
-- Nothing leaks in that state: RLS filters every row, the secrets tables
-- have no policies at all, the insert policies fail on both branches for
-- anon, and the security definer RPCs guard themselves. What is missing is
-- depth — on that project RLS is the ONLY lock on the SSN and bank-account
-- ciphertext, where this schema claims two.
--
-- Two mechanisms, because a revoke alone is not enough:
--
--   1. Existing objects: plain `revoke`.
--
--   2. Future objects: `alter default privileges`. The legacy grants were
--      never written per table. Read off the linked project's pg_default_acl
--      on 2026-08-05:
--
--        grantor  | objtype | schema | acl
--        postgres | r       | public | {postgres=arwdDxtm/postgres,
--                                       anon=arwdDxtm/postgres,
--                                       authenticated=arwdDxtm/postgres,
--                                       service_role=arwdDxtm/postgres}
--        postgres | S       | public | {...anon=rwU...}
--        postgres | f       | public | {...anon=X...}
--
--      i.e. the old project init ran the equivalent of
--
--        alter default privileges in schema public
--          grant all on tables to anon, authenticated, service_role;
--
--      so every table a migration creates is auto-granted at CREATE time,
--      forever. Revoking today and adding a table tomorrow would silently
--      re-open it, which is exactly the drift this is meant to stop.
--      Removing the default-privilege entries is what makes the promise in
--      20260805200000 — "a table added later starts with no access and
--      fails loudly on first use" — actually true for TABLES.
--
-- It does NOT close the equivalent hole for FUNCTIONS, and that limit was
-- measured rather than assumed. On Postgres 17 (the local stack) and on
-- PGlite, a function created by `postgres` in `public` comes out with
-- `proacl = NULL` — the built-in default, which includes EXECUTE to PUBLIC
-- — no matter what pg_default_acl holds for that role and schema. An
-- `alter default privileges ... revoke execute on functions from public`
-- was tried and is a verified no-op here (the entry it would write,
-- `{postgres=X/postgres}`, was already present and still had no effect).
-- So every new function must carry its own `revoke all on function ...
-- from public` in the migration that creates it, the way 20260805200000
-- does for the five that exist. There is no declarative backstop; see the
-- test in tests/rls/grants.test.ts that pins this.
--
-- Every statement below removes a privilege. Nothing is granted, no object
-- is created, altered or dropped, and no row is touched.
--
-- Safe to run on a project that never had the legacy grants (a fresh one,
-- or the local stack): revoking a privilege that was never held and
-- removing a default-privilege entry that does not exist are both no-ops,
-- which is why this is one migration rather than a manual dashboard fix.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Existing objects — anon back to nothing
-- ---------------------------------------------------------------------
-- USAGE on schema public is deliberately left in place. With no table,
-- sequence or function privileges anon can reach nothing anyway, and
-- keeping schema usage preserves the error shape the app already sees
-- rather than turning an empty result into a schema-level failure on any
-- unauthenticated query that slips past the proxy redirect.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all functions in schema public from anon;

-- ---------------------------------------------------------------------
-- 2. The three secrets tables — authenticated must not reach them either
-- ---------------------------------------------------------------------
-- Their RLS has zero policies and always will (see the standing rule in
-- the schema doc), so this grant was never load-bearing. Removing it
-- restores the second lock: if a policy is ever added to one of these
-- tables by mistake, the table still is not reachable.
revoke all on
  pre_app_owner_secrets,
  pre_app_banking_secrets,
  pre_app_terminal_secrets
from anon, authenticated;

revoke all on
  pre_app_owner_secrets_id_seq,
  pre_app_banking_secrets_id_seq,
  pre_app_terminal_secrets_id_seq
from anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Future objects — stop the automatic re-grant
-- ---------------------------------------------------------------------
-- `for role postgres` because default privileges are keyed on the role that
-- CREATES the object, and `postgres` is the role both `supabase db push`
-- and the dashboard SQL editor connect as. Every table this repo will ever
-- add arrives that way, so this is the entry that governs them.
--
-- `supabase_admin` is deliberately absent even though the local stack shows
-- its defaults granting a full `arwdDxtm` on tables to anon and
-- authenticated. Two reasons, the first fatal: `postgres` is not a
-- superuser and not a member of `supabase_admin`, so naming it here fails
-- with `ERROR: permission denied to change default privileges` and takes
-- the whole migration down with it (tried, on the local stack). Second, it
-- would be the wrong target anyway — that entry only applies to objects
-- created BY supabase_admin, which are the platform's, not ours. If a
-- table ever appears with grants nobody wrote, check its owner before
-- assuming this migration failed.
--
-- service_role's defaults are deliberately NOT revoked: it bypasses RLS
-- and is the tier the Edge Functions run on. Consequence worth knowing —
-- on a project without the legacy defaults (fresh, or local), a new table
-- is NOT reachable by service_role either, so a migration that adds a
-- table should grant both authenticated and service_role explicitly
-- rather than rely on inheritance.
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on functions from anon, authenticated;
