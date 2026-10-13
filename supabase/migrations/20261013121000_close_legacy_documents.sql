-- Close the legacy per-record documents path, in BOTH layers.
--
-- Spec: docs/tapswipe_crm_schema.sql (DOCUMENTS), updated first.
--
-- The CRM no longer accepts merchant paperwork (voided checks, driver's
-- licences), and /documents is now the company library (20261013120000). The
-- UI change alone would leave the old path open to anyone calling PostgREST or
-- the functions directly, so it is closed here and by removing
-- create-upload-url, create-download-url and delete-document from the repo.
--
-- Grants and policies are both narrowed, and neither is redundant. Revoking
-- the grant makes a write fail loudly ("permission denied") before RLS is
-- consulted -- for an admin too. Dropping the policies means a grant restored
-- by mistake later still meets no policy that admits the write. Each layer
-- alone would hold today; both together keep holding when one is loosened.
--
-- The TABLE and the BUCKET are kept on purpose. Rows and objects exist on
-- hosted projects, and removing them is scripts/purge-legacy-documents.mjs's
-- job, through the Storage API -- deleting storage.objects rows in SQL leaves
-- the bytes behind. The CHECK, the indexes, the audit trigger and
-- service_role's grant all stay; the trigger is what records each purged row.

-- ---------------------------------------------------------------------
-- 1. GRANTS: SELECT only for `authenticated`.
-- ---------------------------------------------------------------------
-- UPDATE was revoked by 20260811173000 already; restated so this file says
-- everything `authenticated` is losing in one place.
revoke insert, update, delete on documents from authenticated;

-- Nothing `authenticated` does consumes the sequence any more.
revoke usage on documents_id_seq from authenticated;

-- ---------------------------------------------------------------------
-- 2. POLICIES: admin-only read, nothing else.
-- ---------------------------------------------------------------------
drop policy if exists "select own or admin" on documents;
drop policy if exists "insert own" on documents;
drop policy if exists "delete own or admin" on documents;

-- An admin can still see what remains until the purge runs. A rep's SELECT
-- succeeds (the grant is kept) and returns zero rows, the audit_log shape:
-- a rep's page that still queried this table would render empty rather than
-- crash, and no rep page does any more.
create policy "select admin" on documents
  for select using (is_admin());
