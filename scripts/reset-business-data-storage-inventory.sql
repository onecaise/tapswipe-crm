-- Storage inventory for the business-data reset — READ-ONLY, SUPABASE SQL EDITOR.
--
-- Lists every object in every bucket, so the files can be deleted BY HAND in
-- the dashboard (Storage -> bucket -> select -> Delete). Not by SQL: deleting
-- storage.objects rows removes the metadata and leaves the bytes in the
-- underlying store, invisible and still there (storage.objects carries a
-- protect_objects_delete trigger for the same reason).
--
-- scripts/reset-business-data.sql never touches Storage, so after it commits
-- every file listed here is an orphan with no row pointing at it. Run this
-- after the reset, delete what it lists, then run it again: it should return
-- no rows. The buckets themselves stay; only their contents go.
--
-- Columns: bucket, object path, size in bytes, upload time. No file content.

select o.bucket_id                       as bucket,
       o.name                            as object_path,
       (o.metadata ->> 'size')::bigint   as size_bytes,
       o.created_at
  from storage.objects o
 order by o.bucket_id, o.name;
