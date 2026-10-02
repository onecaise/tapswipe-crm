-- Marketing material library: company-owned collateral every rep can read, and
-- an append-only record of what each rep did with it on each lead.
--
-- Matches docs/tapswipe_crm_schema.sql, which was updated first.
--
-- Two tables with deliberately opposite shapes. marketing_materials is the only
-- client-readable table in the schema with NO agent_id: it is reference data,
-- so its select policy is "any active signed-in user" and there is nothing
-- per-rep to compare. marketing_material_events is the usual own-or-admin
-- table, and is where all the ownership lives.
--
-- Why not a new documents.owner_type, which is the obvious cheaper move:
-- `documents` is a table of rep-owned uploads whose storage key resolves a
-- PARENT RECORD's agent_id (resolveParentAgentId). A marketing material has no
-- owning rep and no parent record, so that key shape has nothing to resolve,
-- and an agent_id on the row would be a fact about which admin clicked upload
-- rather than about the asset. Same question residual-imports answered, same
-- answer. See the storage note at the foot of the schema doc.

-- ---------------------------------------------------------------------
-- 1. MARKETING MATERIALS
-- ---------------------------------------------------------------------
create table marketing_materials (
  id serial primary key,

  -- The "folder". Free text with no vocabulary, matching
  -- support_tickets.category and profiles.territory: reference data an admin
  -- extends when marketing produces a new kind of collateral, where a CHECK
  -- would mean a migration every time.
  category text not null,
  title text not null,

  -- Nullable because the row is created BEFORE the upload -- the storage key is
  -- {material_id}/{file_name}, so the id has to exist before the key can be
  -- built. Exactly the sequencing rep_payout_batches uses. A null here is an
  -- upload that was started and never finished.
  file_key text,
  file_name text,
  mime_type text,

  -- The uploading admin. NOT called agent_id, for the reason
  -- rep_payout_batches.imported_by and user_import_batches.imported_by are not:
  -- that name would make the standard own-or-admin policy expression
  -- accidentally meaningful here and wrong.
  --
  -- The TWENTIETH column referencing profiles(id), ON DELETE NO ACTION like
  -- nineteen of the twenty-one. All four teardown lists need it.
  uploaded_by uuid references profiles(id) not null,
  uploaded_at timestamptz default now(),

  -- Retirement is a timestamp, not a delete. A material exists to be referenced
  -- by the events table below; deleting one would either cascade that log away
  -- or be blocked by the FK forever. Archiving drops it out of the rep-facing
  -- list while every event naming it stays readable.
  archived_at timestamptz
);

-- file_key must be the key for THIS row's id.
--
-- Narrower than documents_file_key_matches_owner, and here for a different
-- reason. That constraint closes a demonstrated cross-agent read, because the
-- documents row is written by the browser. Nothing client-supplied reaches this
-- column -- marketing-material-file-url writes it under the service role, and
-- `authenticated` gets no grant that could -- so this pins an invariant the
-- download path depends on rather than closing a hole.
--
-- Not NOT VALID, unlike the documents one: this table is new, so there are no
-- pre-existing rows to exempt and nothing for `db push` to trip over.
--
-- `file_key is null or ...` is spelled out rather than left to a CHECK's
-- three-valued logic. A NULL result passes either way; saying so means the next
-- reader does not have to rediscover that to see the pre-upload row is legal.
alter table marketing_materials
  add constraint marketing_materials_file_key_matches_id
  check (
    file_key is null
    or (
      starts_with(file_key, id::text || '/')
      and split_part(file_key, '/', 2) <> ''
      and split_part(file_key, '/', 3) = ''
    )
  );

alter table marketing_materials enable row level security;

-- The only select policy in the schema with no agent_id comparison in it. The
-- is_active_agent() half is not decoration: a deactivated rep holds a working
-- JWT until it expires, and without it they would keep reading the company's
-- current rate cards after being let go.
create policy "select active or admin" on marketing_materials
  for select using (is_active_agent() or is_admin());

-- Admin-only writes. Policies rather than leaving it all to the Edge Function's
-- service_role, because the admin UI edits title, category and archived_at
-- through PostgREST directly -- only the file needs the function.
create policy "admin inserts" on marketing_materials
  for insert with check (is_admin());
create policy "admin updates" on marketing_materials
  for update using (is_admin()) with check (is_admin());
-- No DELETE policy, and no DELETE grant below. See archived_at.

-- ---------------------------------------------------------------------
-- 2. MARKETING MATERIAL EVENTS
-- ---------------------------------------------------------------------
create table marketing_material_events (
  id serial primary key,
  material_id int references marketing_materials(id) not null,

  -- Nullable: a rep opening a rate card to read it has done something worth
  -- logging and there is no lead in that act. Per-lead history is
  -- `where lead_id = $1`; the library's own usage is `where lead_id is null`.
  --
  -- ON DELETE CASCADE, unlike material_id, because the history is *about* the
  -- lead -- orphaned rows would leave a count no page can explain. A material
  -- is not deletable at all, so the two sides answer differently on purpose.
  lead_id int references leads(id) on delete cascade,

  -- The acting rep. TWENTY-FIRST reference to profiles(id), NO ACTION: this is
  -- evidence, and evidence blocks a delete until a person decides about it.
  agent_id uuid references profiles(id) not null,

  event_type text not null
    check (event_type in ('viewed', 'downloaded', 'printed', 'emailed')),
  occurred_at timestamptz default now()
);

alter table marketing_material_events enable row level security;

create policy "select own or admin" on marketing_material_events
  for select using ((agent_id = auth.uid() and is_active_agent()) or is_admin());

-- This insert policy carries the documents lesson, which is why it is not the
-- usual one-liner.
--
-- agent_id is compared to auth.uid() as everywhere else. But lead_id is ALSO
-- client-supplied and nothing else in the policy reads it -- precisely the
-- shape that made documents.file_key a live cross-agent read. Without the
-- `exists` a rep could post events against another rep's lead_id: not reading
-- anything, but writing fabricated engagement history into a book that is not
-- theirs, which the admin reviewing that lead would then see.
--
-- The subquery states `leads.agent_id = auth.uid()` rather than leaning on RLS
-- to filter it, matching the pre_apps child tables. Same effect, and a reader
-- does not have to know that policies nest to see the check is real.
create policy "insert own via own lead" on marketing_material_events
  for insert with check (
    (
      (agent_id = auth.uid() and is_active_agent())
      or is_admin()
    )
    and (
      lead_id is null
      or is_admin()
      or exists (
        select 1 from leads
         where leads.id = lead_id and leads.agent_id = auth.uid()
      )
    )
  );
-- No UPDATE or DELETE policy, and no grant for either. Append-only.

-- ---------------------------------------------------------------------
-- 3. INDEXES
-- ---------------------------------------------------------------------
-- "Events for this lead" is what the lead page runs on every load.
create index idx_marketing_material_events_lead
  on marketing_material_events(lead_id, occurred_at desc)
  where lead_id is not null;
create index idx_marketing_material_events_material
  on marketing_material_events(material_id, occurred_at desc);

-- Browsing is "what is in this category", and an archived material is never in
-- a rep's list -- so this is partial on exactly the rows that query reads.
create index idx_marketing_materials_category
  on marketing_materials(category, title)
  where archived_at is null;

-- ---------------------------------------------------------------------
-- 4. GRANTS
--
-- RLS decides which rows; grants decide whether the table is reachable at all.
-- A table with perfect policies and no grant answers every request with
-- `permission denied`, and 20260805210000 removed the default privileges that
-- used to paper over this.
--
-- The rule the existing grant block follows: a verb is granted only where a
-- policy backs it.
-- ---------------------------------------------------------------------

-- INSERT and UPDATE are granted even though only an admin may use them --
-- that separation is RLS's job, not a grant's, and it is the same arrangement
-- bug_reports and rep_payout_rows already have. No DELETE in either layer.
grant select, insert, update on marketing_materials to authenticated;

-- Append-only: the two verbs notes and support_ticket_replies have, minus the
-- delete those two allow. Leaving UPDATE and DELETE off is what makes the
-- answer "permission denied" rather than a statement RLS filters to zero rows
-- while reporting a save that did nothing.
grant select, insert on marketing_material_events to authenticated;

-- USAGE only, never SELECT: nextval() is all a serial insert needs, and SELECT
-- on a sequence hands out last_value -- a free row count.
--
-- Both are granted, unlike the four rep_payout sequences: an admin's INSERT
-- into marketing_materials goes through PostgREST, and every rep's INSERT into
-- marketing_material_events does too, on every view, download, print and email.
grant usage on
  marketing_materials_id_seq,
  marketing_material_events_id_seq
to authenticated;

-- Both Edge Functions reach these tables as service_role: the upload function
-- writes file_key (which `authenticated` cannot), and the download function
-- reads a material regardless of who is asking.
grant all on marketing_materials to service_role;
grant all on marketing_material_events to service_role;
grant usage on marketing_materials_id_seq to service_role;
grant usage on marketing_material_events_id_seq to service_role;

-- Never anon. 20260805210000 revoked the default privileges precisely so this
-- is a decision rather than an accident; stated here so a reader does not have
-- to go and check.
revoke all on marketing_materials from anon;
revoke all on marketing_material_events from anon;
revoke all on marketing_materials_id_seq from anon;
revoke all on marketing_material_events_id_seq from anon;

-- ---------------------------------------------------------------------
-- 5. NO CROSS-AGENT AUDIT TRIGGER, on either table
--
-- marketing_materials has no agent_id, so log_cross_agent_change() would read
-- NULL and log every write -- the support_ticket_replies trap the rep_payout_*
-- tables record. Admin action is audited where it happens instead:
-- marketing-material-file-url writes an audit_log row per upload, the way
-- create-upload-url does.
--
-- marketing_material_events DOES carry an agent_id and the trigger would work,
-- which makes it the more interesting omission: the table is already an audit
-- trail. A second one would write an audit_log row every time an admin's own
-- browsing logged an event -- recording that an admin looked at something, in a
-- table whose entire content is a record of who looked at what.
-- ---------------------------------------------------------------------
