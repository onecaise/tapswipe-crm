-- Rep Payouts / Residuals: the per-merchant monthly ledger and its import
-- staging area. Spec: RESIDUALS_SPEC.md.
--
-- Matches docs/tapswipe_crm_schema.sql, updated first.
--
-- Four tables, and the split between them is the design:
--
--   rep_payout_batches      one uploaded file
--   rep_payout_import_rows  its cells, as parsed, until they are clean
--   rep_payout_rows         the ledger -- clean, typed, committed
--   rep_payout_row_history  every change to the two money figures
--
-- A separate staging table rather than a `status` column on the ledger, because
-- nothing lands in rep_payout_rows until every row of the batch resolves and a
-- batch can wait days while someone creates a rep. With one table and a status
-- flag, every read, total, export and payout summary would have to remember
-- `where status = 'committed'` -- and the one that forgot would show draft
-- figures as real payouts. Here the ledger has no draft state to filter out,
-- because drafts are not in it.
--
-- What the processor supplies and what it does not: the monthly XLSX carries
-- Period, Agent #, MID, Merchant name, Volume, Average ticket, Total cost. The
-- two numbers that decide what a rep is owed -- residual income and the rep's
-- split -- are worked out by hand afterwards. They are nullable, and null means
-- "not worked out yet" rather than zero. Everything downstream has to keep that
-- distinction: a period with blank figures is normal, not broken.

-- ---------------------------------------------------------------------
-- 1. BATCHES — one row per uploaded file
-- ---------------------------------------------------------------------
create table rep_payout_batches (
  id serial primary key,
  -- The importing admin, and NOT called agent_id, deliberately.
  --
  -- Every other table in this schema follows the rule that a new table carries
  -- `agent_id uuid references profiles(id) not null` so the standard policy
  -- expression scopes it. A batch belongs to no rep -- it belongs to the file.
  -- Naming this agent_id would make
  -- `(agent_id = auth.uid() and is_active_agent()) or is_admin()` accidentally
  -- MEANINGFUL here, and wrong: a rep would read a batch whenever an admin's
  -- uuid happened to match theirs. The rule exists to stop a rep-owned table
  -- from being unscoped, and this table has no rep to scope to.
  imported_by uuid references profiles(id) not null,
  -- Key in the `residual-imports` bucket, not `documents`. See the storage note
  -- at the end of docs/tapswipe_crm_schema.sql for why it needed its own.
  file_key text not null,
  file_name text not null,
  -- 'abandoned' exists because a batch may wait indefinitely: an unrecognised
  -- agent number can take a day to sort out. Without it the import page
  -- accumulates stale 'review' rows with no way to say "not this one".
  status text not null default 'review'
    check (status in ('review', 'committed', 'abandoned')),
  row_count int not null default 0,
  uploaded_at timestamptz default now(),
  committed_at timestamptz
);

alter table rep_payout_batches enable row level security;

-- Admin-only, and only the two verbs a client performs: the import page lists
-- batches, and "Abandon batch" is a status update.
--
-- No INSERT policy -- residual-import-file-url creates the row under the service
-- role, because the Storage key contains the batch id and so the row must exist
-- before the upload does. No DELETE policy -- a batch is the record that an
-- import happened, and deleting one throws away the provenance the retained file
-- exists to provide.
create policy "admin only select" on rep_payout_batches
  for select using (is_admin());
create policy "admin abandons" on rep_payout_batches
  for update using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------------------
-- 2. IMPORT ROWS — staging
--
-- Every cell is kept twice: once as the text the file actually contained (*_raw)
-- and once as the resolved, typed value. The review screen needs both, because
-- "Q3 2026" is only explicable next to the cell it came from, and an admin
-- comparing the screen against the spreadsheet is comparing raw text.
--
-- The raw copy is also why offering a re-parse is safe: nothing here has been
-- interpreted destructively, so parsing again after an agent number is created
-- reaches the same conclusions plus one.
-- ---------------------------------------------------------------------
create table rep_payout_import_rows (
  id serial primary key,
  batch_id int references rep_payout_batches(id) on delete cascade not null,
  -- 1-based spreadsheet row, so an error can name where to look. Not the array
  -- index: an admin fixing the file counts rows in Excel, where the header is
  -- row 1.
  row_number int not null,
  period_raw text,
  agent_number_raw text,
  mid_raw text,
  merchant_name_raw text,
  volume_raw text,
  average_ticket_raw text,
  total_cost_raw text,
  -- Absent from a fresh processor file; present when a round-trip export is fed
  -- back in to bulk-fill the figures. That asymmetry is the whole reason the
  -- commit step distinguishes "the file said nothing" from "the file said zero".
  residual_income_raw text,
  rep_split_raw text,
  -- Resolved values, null wherever the raw text could not be resolved -- in
  -- which case `blocker` says why.
  period date,
  agent_id uuid references profiles(id),
  merchant_id int references merchants(id) on delete set null,
  volume numeric(14,2),
  average_ticket numeric(14,2),
  total_cost numeric(14,2),
  residual_income numeric(14,2),
  rep_split_pct numeric(5,2),
  -- A code so the UI can group and count, plus prose for the row itself. Only
  -- 'unknown_agent' is fixable from the review screen; the rest are file
  -- problems and the fix is a corrected upload.
  blocker text check (blocker in (
    'unknown_agent', 'unparseable_period', 'bad_number',
    'missing_mid', 'duplicate_in_file'
  )),
  error text
);

alter table rep_payout_import_rows enable row level security;

-- SELECT only. Every write comes from parse-residual-import or
-- commit-residual-import under the service role; the review screen reads, and
-- the one fixable blocker is fixed by re-parsing rather than by editing a
-- staging row. Granting the other verbs would be dead weight of exactly the kind
-- 20260805200000's grants block warns about -- privilege check passes, RLS
-- filters to nothing, caller sees a save that did nothing.
create policy "admin only select" on rep_payout_import_rows
  for select using (is_admin());

-- ---------------------------------------------------------------------
-- 3. THE LEDGER
-- ---------------------------------------------------------------------
create table rep_payout_rows (
  id serial primary key,
  agent_id uuid references profiles(id) not null,
  -- Always the first of the month. The file says "Jul-26" or "07/2026" or an
  -- Excel serial; the parser normalises all of them and an unparseable value
  -- blocks its row rather than guessing. A date rather than the label means
  -- periods sort correctly and one period has exactly one spelling.
  period date not null,
  -- From the file, and authoritative. NOT a foreign key to merchants: a residual
  -- report legitimately contains merchants nobody has entered into the CRM, and
  -- blocking payroll over a data-entry gap is the wrong trade.
  mid text not null,
  merchant_name text,
  -- The soft link, resolved by MID lookup at import. Null when nothing matched,
  -- which is an ordinary state and not an error. `set null` on delete so that
  -- deleting a merchant cannot wedge on an FK from the ledger.
  merchant_id int references merchants(id) on delete set null,
  -- Volume and average ticket must be non-negative: a negative there is a parse
  -- error, not a business fact.
  volume numeric(14,2) check (volume >= 0),
  average_ticket numeric(14,2) check (average_ticket >= 0),
  -- Cost and residual income are signed on purpose. Clawbacks and adjustments
  -- are real, a negative month happens, and a CHECK that rejected one would turn
  -- valid processor data into a blocked row nobody could explain.
  total_cost numeric(14,2),
  residual_income numeric(14,2),
  rep_split_pct numeric(5,2)
    check (rep_split_pct >= 0 and rep_split_pct <= 100),
  -- Derived, stored, and never independently editable -- which is the point. A
  -- third money column an admin could type into would eventually disagree with
  -- the two it is computed from, and nothing would say which was right. Null
  -- when either input is null, which reads correctly as "not worked out yet"
  -- rather than as a payout of zero.
  rep_payout numeric(14,2) generated always as
    (round(residual_income * rep_split_pct / 100, 2)) stored,
  -- Provenance of the last write, not an ownership link. `set null` on delete so
  -- an old batch can be tidied away without taking ledger rows with it.
  batch_id int references rep_payout_batches(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  -- The merge key. A second upload for a period upserts on this, so re-importing
  -- a corrected file updates rows rather than duplicating them.
  --
  -- Keyed on agent_id rather than the agent number the file carried:
  -- profiles.agent_number is unique so the two are equivalent today, but keying
  -- on the uuid means reassigning a number later does not orphan history.
  unique (period, agent_id, mid)
);

alter table rep_payout_rows enable row level security;

-- The one table in this group with the usual own-or-admin read: a rep sees their
-- own residuals. Everything that writes is admin-only, because the figures are
-- entered by whoever runs payouts, not by the rep being paid.
create policy "select own or admin" on rep_payout_rows
  for select using ((agent_id = auth.uid() and is_active_agent()) or is_admin());
-- Inline editing of the two money fields, and the per-agent bulk split.
create policy "admin only update" on rep_payout_rows
  for update using (is_admin()) with check (is_admin());
-- Whole-period delete, the escape hatch for an import that was simply wrong.
-- Individual rows are not deletable by design -- a wrong merchant line is a
-- correction, made by editing, which the history table then records.
create policy "admin only delete" on rep_payout_rows
  for delete using (is_admin());
-- No INSERT policy. Rows are created only by commit-residual-import under the
-- service role, the same arrangement profiles and audit_log have: a ledger of
-- what a processor reported should not be writable a row at a time from a
-- browser.

-- ---------------------------------------------------------------------
-- 4. HISTORY — old value, new value, who, when, for the two figures a
-- human types.
--
-- Corrections overwrite in place rather than appending superseding rows. The
-- alternative was considered and rejected: with immutable versions, every read,
-- export, total and payout summary would need a latest-per-key filter, and the
-- one that got it wrong would be a wrong payout. This keeps the ledger simple to
-- read and puts the trail beside it.
-- ---------------------------------------------------------------------
create table rep_payout_row_history (
  id serial primary key,
  -- NO foreign key, deliberately. The point is that this outlives its subject:
  -- deleting a period must not erase the record that its figures were edited,
  -- and `on delete cascade` would do exactly that while `on delete restrict`
  -- would make the period undeletable. Same no-FK-on-purpose shape as
  -- notes.owner_id and documents.owner_id.
  row_id int not null,
  -- Denormalised so a history row still says what it is about after the ledger
  -- row is gone. Without these, a surviving row would be a value change attached
  -- to an integer that no longer resolves to anything.
  period date not null,
  agent_id uuid references profiles(id) not null,
  mid text not null,
  field text not null check (field in ('residual_income', 'rep_split_pct')),
  old_value numeric(14,2),
  new_value numeric(14,2),
  -- Null for a service-role write, exactly as audit_log.actor_id is: the commit
  -- step runs with no auth.uid(), so a round-trip import that fills in figures is
  -- recorded as a server write rather than attributed to nobody in particular.
  --
  -- Plain `references profiles(id)` with no ON DELETE, matching audit_log. That
  -- makes a user un-deletable while their history rows exist, which production
  -- never does (deactivation, never deletion) -- but a live test must clear these
  -- rows before deleting its users, or teardown fails on the FK.
  changed_by uuid references profiles(id),
  changed_at timestamptz default now()
);

alter table rep_payout_row_history enable row level security;

-- Admin-only, and SELECT-only. A rep reads their own figures; the edit history
-- behind them is a payroll-administration record, not a rep-facing one. No
-- insert, update or delete policy at all -- the trigger below is `security
-- definer` and so bypasses both RLS and grants, which is what lets this table
-- have no client write path whatsoever.
create policy "admin only select" on rep_payout_row_history
  for select using (is_admin());

-- ---------------------------------------------------------------------
-- 5. log_payout_row_change() — writes the history rows above.
--
-- `security definer` for the same reason log_cross_agent_change() is:
-- rep_payout_row_history has no INSERT policy, so a security invoker trigger
-- would have its insert refused by RLS and would fail the caller's UPDATE
-- outright.
--
-- FAILS CLOSED, intentionally. AFTER ROW, no EXCEPTION block, so a failure to
-- record the change rolls back the change itself. Same trade
-- log_cross_agent_change() makes and for the same reason: nothing has been handed
-- over yet, so refusing the edit is both possible and correct. An unrecorded
-- change to a commission figure is worse than a failed one, because the failure
-- is visible and the gap is not. Pinned in
-- tests/rls/payout-history-trigger.test.ts -- do not "fix" it with an EXCEPTION
-- block.
--
-- One row per changed field, not one per statement, so "what changed" needs no
-- parsing. `is distinct from` rather than <> so that a change to or from NULL --
-- which is most first edits, since both columns arrive empty -- is recorded
-- rather than skipped.
--
-- Only the two hand-entered columns are watched. The file-sourced columns change
-- on every re-import by design, and recording those would bury the entries that
-- matter under the ones that don't -- the same argument that keeps a rep's own
-- edits out of the cross-agent trail.
-- ---------------------------------------------------------------------
create or replace function log_payout_row_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.residual_income is distinct from old.residual_income then
    insert into rep_payout_row_history
      (row_id, period, agent_id, mid, field, old_value, new_value, changed_by)
    values (old.id, old.period, old.agent_id, old.mid, 'residual_income',
            old.residual_income, new.residual_income, auth.uid());
  end if;

  if new.rep_split_pct is distinct from old.rep_split_pct then
    insert into rep_payout_row_history
      (row_id, period, agent_id, mid, field, old_value, new_value, changed_by)
    values (old.id, old.period, old.agent_id, old.mid, 'rep_split_pct',
            old.rep_split_pct, new.rep_split_pct, auth.uid());
  end if;

  -- AFTER trigger: the return value is ignored.
  return null;
end;
$$;

revoke all on function log_payout_row_change() from public;
-- Deliberately NOT granted to authenticated: a trigger fires whether or not the
-- querying role holds EXECUTE. Same treatment as set_updated_at() and
-- log_cross_agent_change().

create trigger rep_payout_rows_log_changes
  after update on rep_payout_rows
  for each row execute function log_payout_row_change();

create trigger rep_payout_rows_set_updated_at
  before update on rep_payout_rows
  for each row execute function set_updated_at();

-- The cross-agent audit trigger is deliberately NOT attached to any of these
-- four. On rep_payout_rows it would fire on every write -- nobody but an admin
-- can write the table at all, so `actor is distinct from row_agent_id` is true
-- for all of them, and one forty-row import would write forty
-- cross_agent_insert rows. It would also still not record what a figure changed
-- FROM, because audit_log has no detail column. The trail is split by
-- granularity instead: audit_log per committed batch and per deleted period,
-- history per value change. The other three tables have no agent_id at all, so
-- that function would read NULL and log everything -- the trap
-- support_ticket_replies needed its own function to avoid.

-- ---------------------------------------------------------------------
-- 6. INDEXES
--
-- Note what is deliberately absent: an index on rep_payout_rows(period), even
-- though every page filters on it. The `unique (period, agent_id, mid)`
-- constraint already creates a btree index with period as its LEADING column, so
-- it serves `where period = $1` and `where period = $1 and agent_id = $2` on its
-- own; a second index would be dead weight on every write. agent_id does need
-- its own, because it is not that constraint's leading column and a rep's own
-- read filters on it alone.
-- ---------------------------------------------------------------------
create index idx_rep_payout_rows_agent_id on rep_payout_rows(agent_id);
-- Staging is always read one batch at a time; history always for one ledger row.
create index idx_rep_payout_import_rows_batch on rep_payout_import_rows(batch_id);
create index idx_rep_payout_row_history_row on rep_payout_row_history(row_id);

-- ---------------------------------------------------------------------
-- 7. GRANTS — required, not optional.
--
-- 20260805210000 removed the default privileges that used to auto-grant new
-- tables, precisely so this step cannot be skipped by accident. Without these
-- lines every one of these tables answers every request with
-- "permission denied for table ...", perfect policies and all.
--
-- The rule: a verb is granted only where a policy backs it.
-- ---------------------------------------------------------------------

-- No INSERT: rows are created only by commit-residual-import under the service
-- role. UPDATE is the inline editing of the two money figures and the per-agent
-- bulk split; DELETE is the whole-period escape hatch. Both admin-only by
-- policy, so a rep holds the privilege and no policy admits their write.
grant select, update, delete on rep_payout_rows to authenticated;

-- SELECT to list them, UPDATE to abandon one. No INSERT, no DELETE -- see the
-- policy comments above.
grant select, update on rep_payout_batches to authenticated;

-- SELECT only on both. Every write comes from a service-role Edge Function or
-- from log_payout_row_change(), which is security definer and so bypasses both
-- RLS and grants.
grant select on rep_payout_import_rows to authenticated;
grant select on rep_payout_row_history to authenticated;

-- service_role explicitly, per table. The `grant all on all tables in schema
-- public to service_role` in 20260805200000 applied to the tables that existed
-- then -- it is not a standing rule, and these four postdate it.
grant all on rep_payout_batches to service_role;
grant all on rep_payout_import_rows to service_role;
grant all on rep_payout_rows to service_role;
grant all on rep_payout_row_history to service_role;

grant usage on
  rep_payout_batches_id_seq,
  rep_payout_import_rows_id_seq,
  rep_payout_rows_id_seq,
  rep_payout_row_history_id_seq
to service_role;
-- And deliberately NOT to authenticated, for the reason audit_log_id_seq is not:
-- nothing `authenticated` can do consumes them, since none of the four tables
-- grants it INSERT. Granting USAGE anyway would leave nextval() reachable through
-- any security invoker RPC, burning ids and putting gaps in a ledger of what a
-- processor reported.
