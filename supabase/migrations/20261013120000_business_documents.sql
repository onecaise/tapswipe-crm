-- Business documents: the company library behind /documents.
--
-- Matches docs/tapswipe_crm_schema.sql (BUSINESS DOCUMENTS), which was updated
-- first and carries the full reasoning. In short: modelled on
-- marketing_materials -- no agent_id, admin-only writes, every active user
-- reads, the row is created before the upload because the storage key is
-- {document_id}/{file_name}, and "delete" is archived_at. Three deliberate
-- differences from marketing: no event table (nothing here is sent to a
-- merchant on a lead), an archived row is hidden from reps by RLS rather than
-- by the query (archiving IS deletion here, not a lifecycle state), and a
-- size_bytes display column.
--
-- The bucket is created by 20261013120500, a separate file shaped like
-- 20261009170000. The old per-record upload path is closed by 20261013121000.

create table business_documents (
  id serial primary key,

  -- Free text, like marketing_materials.category: a new kind of document
  -- should not need a migration.
  category text not null,
  title text not null,

  -- Nullable because the row exists before its upload. A null is an upload
  -- that started and never finished; the manage page says so.
  file_key text,
  file_name text,
  mime_type text,

  -- A display hint from the uploading admin's browser, written by the function
  -- as service role. Nothing decides anything from it; the bucket's
  -- file_size_limit is the real ceiling.
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),

  -- The TWENTY-THIRD column referencing profiles(id), NO ACTION like twenty-one
  -- of the others. All four teardown lists clear it.
  uploaded_by uuid references profiles(id) not null,
  uploaded_at timestamptz default now(),

  -- The UI's "Delete". The row and its object stay, so a mistaken delete is an
  -- engineer's UPDATE away from undone.
  archived_at timestamptz
);

-- file_key must be the key for THIS row's id: marketing_materials'
-- constraint, verbatim in shape. Validated, because the table is new.
alter table business_documents
  add constraint business_documents_file_key_matches_id
  check (
    file_key is null
    or (
      starts_with(file_key, id::text || '/')
      and split_part(file_key, '/', 2) <> ''
      and split_part(file_key, '/', 3) = ''
    )
  );

alter table business_documents enable row level security;

-- An active user reads every LIVE document; an admin reads every row.
--
-- archived_at is IN the policy here, unlike marketing_materials and products,
-- where hiding archived rows is the query's job. For those two an archived row
-- is still history somebody reads; here archived means deleted, so a rep
-- calling PostgREST directly must not be able to list what an admin removed.
create policy "select live to active users, all to admin" on business_documents
  for select using ((is_active_agent() and archived_at is null) or is_admin());

create policy "admin inserts" on business_documents
  for insert with check (is_admin());
create policy "admin updates" on business_documents
  for update using (is_admin()) with check (is_admin());
-- No DELETE policy, and no DELETE grant below.

create index idx_business_documents_category
  on business_documents(category, title)
  where archived_at is null;

-- Grants. RLS decides which rows; these decide whether the table is reachable.
-- INSERT and UPDATE are granted although only an admin may use them -- that
-- split is RLS's job, the marketing_materials arrangement. No DELETE anywhere.
grant select, insert, update on business_documents to authenticated;

-- USAGE, never SELECT: nextval() is all an insert needs, and SELECT on a
-- sequence hands out last_value.
grant usage on business_documents_id_seq to authenticated;

-- business-document-file-url writes file_key (no grant admits it for
-- `authenticated`) and the audit row as service_role.
grant all on business_documents to service_role;
grant usage on business_documents_id_seq to service_role;

-- Never anon.
revoke all on business_documents from anon;
revoke all on business_documents_id_seq from anon;

-- No log_cross_agent_change() trigger: there is no agent_id for it to read,
-- so it would log every write (the support_ticket_replies trap). Uploads are
-- audited in business-document-file-url.
