-- User imports: bulk rep onboarding from a CSV.
--
-- Matches docs/tapswipe_crm_schema.sql, updated first.
--
-- Two tables, deliberately shaped like the residual import in
-- 20260817102000_rep_payouts.sql:
--
--   user_import_batches  one submitted file
--   user_import_rows     its rows, as parsed, plus what happened to each
--
-- THE ONE STRUCTURAL DIFFERENCE FROM RESIDUALS IS THE WHOLE DESIGN.
--
-- commit_residual_import is a security definer RPC that moves staging rows into
-- the ledger in ONE TRANSACTION and DELETES them on success. That is possible
-- because everything it touches is in Postgres.
--
-- Creating an account is not. Each one is a GoTrue write (auth.users) plus a
-- Postgres write (profiles), in two different systems with no transaction
-- spanning them -- so forty accounts is eighty operations that can be
-- interrupted at any point, and there is no "commit" that either happens or
-- does not.
--
-- So these staging rows are NOT deleted when the import completes. They SURVIVE,
-- each carrying its own outcome, which makes this table the progress ledger as
-- well as the staging area. `outcome is null` is the work list, and that single
-- fact is the entire mechanism behind batch-level resume: a run interrupted
-- halfway restarts by asking for the rows with no outcome yet. Do not "tidy up"
-- by deleting committed rows -- that throws away the only record of what each
-- row did, and makes a half-finished batch indistinguishable from a fresh one.
--
-- WHY THE FILE IS TEXT IN A COLUMN AND NOT AN OBJECT IN A BUCKET. A residual
-- report is a binary XLSX that can be megabytes, so it needed Storage. A rep
-- list is a few kilobytes of text, and a third private bucket is not free: no
-- migration can create one, `db reset` silently drops them, and
-- e2e/fixtures/seed.ts already fails to recreate `residual-imports`. Keeping the
-- submitted text on the batch row keeps the provenance without adding a third
-- thing to that gap, and it is what a re-read parses again.

-- ---------------------------------------------------------------------
-- 1. BATCHES — one row per submitted file
-- ---------------------------------------------------------------------
create table user_import_batches (
  id serial primary key,
  -- The importing admin, and NOT called agent_id -- the same reasoning
  -- rep_payout_batches.imported_by records. A batch belongs to no rep, so
  -- naming this agent_id would make the standard own-or-admin policy expression
  -- accidentally MEANINGFUL here, and wrong: a rep would read a batch whenever
  -- an admin's uuid happened to match theirs.
  --
  -- NOTE: the EIGHTEENTH column in this schema referencing profiles(id), and
  -- like all seventeen before it, ON DELETE NO ACTION. Any leftover row blocks
  -- deleting a user, so scripts/seed-local-users.mjs's teardown list has to know
  -- about it -- updated in the same commit as this migration, because a list
  -- that is one table behind is exactly how that trap gets walked into again.
  imported_by uuid references profiles(id) not null,
  file_name text not null,
  -- The exact text submitted, kept verbatim. Provenance, and what a re-read
  -- parses again.
  source_text text not null,
  -- 'provisioning' exists because account creation is not atomic and a run can
  -- be interrupted: it marks a batch whose accounts are being created, so the UI
  -- can offer to resume rather than to start over. 'abandoned' is the escape
  -- hatch for a file that was simply wrong.
  status text not null default 'review'
    check (status in ('review', 'provisioning', 'committed', 'abandoned')),
  row_count int not null default 0,
  uploaded_at timestamptz default now(),
  committed_at timestamptz
);

alter table user_import_batches enable row level security;

-- Admin-only, and only the two verbs a client performs: the import page lists
-- batches, and "Abandon" is a status update.
--
-- No INSERT policy -- stage-user-import creates the row under the service role.
-- No DELETE policy -- a batch is the record that an import happened, and its
-- rows are the record of what each one did.
create policy "admin only select" on user_import_batches
  for select using (is_admin());
create policy "admin abandons" on user_import_batches
  for update using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------------------
-- 2. IMPORT ROWS — staging, and then the per-row record of what happened.
--
-- Every cell is kept twice: once as the text the file contained (*_raw) and once
-- as the resolved value. The review screen needs both, because an admin
-- comparing the screen against the file is comparing raw text, and because it is
-- what makes offering a re-read safe -- nothing has been interpreted
-- destructively.
-- ---------------------------------------------------------------------
create table user_import_rows (
  id serial primary key,
  batch_id int references user_import_batches(id) on delete cascade not null,
  -- 1-based file row, so an error can name where to look. Not the array index:
  -- an admin fixing the file counts rows in a spreadsheet, where the header is
  -- row 1.
  row_number int not null,

  full_name_raw text,
  email_raw text,
  role_raw text,
  agent_number_raw text,

  -- Resolved values, null wherever the raw text could not be resolved -- in
  -- which case `blocker` says why.
  full_name text,
  email text,
  role text check (role in ('agent', 'admin')),
  agent_number text,

  -- A code so the UI can group and count; `error` carries the prose.
  --
  -- Six of these BLOCK the batch. The last two -- email_exists and
  -- agent_number_taken -- deliberately do NOT: those rows are skipped and the
  -- rest of the file still imports. Accounts are independent of one another,
  -- unlike the rows of one period's ledger, so refusing forty onboardings
  -- because three people already have logins is the wrong trade. The split lives
  -- in isBlocking(), in supabase/functions/_shared/user-imports.ts.
  blocker text check (blocker in (
    'missing_name', 'invalid_email', 'invalid_role', 'invalid_agent_number',
    'duplicate_email_in_file', 'duplicate_agent_number_in_file',
    'email_exists', 'agent_number_taken'
  )),
  error text,

  -- What provisioning did with this row. Null means "not attempted yet", which
  -- is what makes this column the work list -- see the header note.
  outcome text check (outcome in
    ('created', 'resumed', 'skipped_duplicate', 'failed')),
  -- For 'failed', the function's own message. Never the generic "Edge Function
  -- returned a non-2xx status code", which would make a deactivated caller, a
  -- validation refusal and a real fault read identically.
  outcome_detail text,

  -- The account this row produced. Deliberately NO foreign key, matching
  -- rep_payout_row_history.row_id: this record must outlive its subject, and an
  -- import row is provenance. A FK would also add a nineteenth door to the
  -- user-deletion problem for no benefit.
  user_id uuid,

  -- Set when provisioning left an auth.users row with no profiles row. No
  -- foreign key, and here it is IMPOSSIBLE rather than merely unwanted: an
  -- orphaned auth user is BY DEFINITION one with no profiles row, so a reference
  -- to profiles(id) could never be satisfied. Surfaced on the review screen,
  -- because that account can log in, lands on /auth/error?error=no-profile, and
  -- cannot self-heal.
  orphaned_auth_user uuid,

  provisioned_at timestamptz
);

alter table user_import_rows enable row level security;

-- SELECT only. Every write comes from stage-user-import or provision-user-batch
-- under the service role; the review screen reads, and a blocked row is fixed by
-- correcting the file and re-reading rather than by editing a staging row.
-- Granting the other verbs would be dead weight of exactly the kind
-- 20260805200000's grants block warns about -- privilege check passes, RLS
-- filters to nothing, caller sees a save that did nothing.
create policy "admin only select" on user_import_rows
  for select using (is_admin());

-- ---------------------------------------------------------------------
-- 3. INDEXES
-- ---------------------------------------------------------------------
-- Staging is always read one batch at a time.
create index idx_user_import_rows_batch on user_import_rows(batch_id);
-- The provisioning loop's hot query: this batch's unprocessed rows, asked for
-- on every chunk.
create index idx_user_import_rows_pending
  on user_import_rows(batch_id) where outcome is null;

-- ---------------------------------------------------------------------
-- 4. GRANTS — required, not optional.
--
-- 20260805210000 removed the default privileges that used to auto-grant new
-- tables, precisely so this step cannot be skipped by accident. Without these
-- lines both tables answer every request with "permission denied for table ...",
-- perfect policies and all.
--
-- The rule: a verb is granted only where a policy backs it.
-- ---------------------------------------------------------------------

-- SELECT to list them, UPDATE to abandon one. No INSERT, no DELETE.
grant select, update on user_import_batches to authenticated;

-- SELECT only. Every write is service-role.
grant select on user_import_rows to authenticated;

-- service_role explicitly, per table. The `grant all on all tables in schema
-- public to service_role` in 20260805200000 applied to the tables that existed
-- then -- it is not a standing rule, and these two postdate it.
grant all on user_import_batches to service_role;
grant all on user_import_rows to service_role;

grant usage on
  user_import_batches_id_seq,
  user_import_rows_id_seq
to service_role;
-- And deliberately NOT to authenticated, for the reason audit_log_id_seq is not:
-- nothing `authenticated` can do consumes them, since neither table grants it
-- INSERT. Granting USAGE anyway would leave nextval() reachable through any
-- security invoker RPC, burning ids for no reason.

-- No trigger. The cross-agent audit trigger is deliberately NOT attached to
-- either table, for both of the reasons the rep_payout_* tables record: neither
-- carries an agent_id at all, so log_cross_agent_change() would read NULL and
-- log everything (the trap support_ticket_replies needed its own function to
-- avoid), and nobody but an admin can write them anyway. The trail is split by
-- granularity instead -- audit_log gets one create_user or resume_create_user
-- row per account from provisionUser, plus one commit_user_import row per
-- finished batch.
