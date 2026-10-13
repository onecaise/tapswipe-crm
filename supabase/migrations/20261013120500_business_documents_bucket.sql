-- =====================================================================
-- The fourth private storage bucket: `business-documents`, behind the
-- company library at /documents.
--
-- Spec: docs/tapswipe_crm_schema.sql (SUPABASE STORAGE), updated first.
--
-- Its own migration rather than a fourth row in 20261009170000, because that
-- one is applied everywhere and an applied migration is never edited. Same
-- shape exactly, and pinned by tests/unit/storage-buckets-migration.test.ts:
--
--   * Idempotent: `on conflict (id) do nothing` fills in a missing bucket and
--     never touches an existing one, so this cannot change a live bucket's
--     privacy or limit.
--   * Guarded for the PGlite suite only, which has no storage schema. On a
--     real Supabase stack storage.buckets exists before migrations run.
--   * No policy on storage.objects: all access is a signed URL minted by
--     business-document-file-url after it has authorized the caller.
-- =====================================================================
do $$
begin
  if to_regclass('storage.buckets') is null then
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit)
  values
    ('business-documents', 'business-documents', false, 52428800)
  on conflict (id) do nothing;
end
$$;
