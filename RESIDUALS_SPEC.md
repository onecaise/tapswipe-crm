# Rep Payouts / Residuals — Specification

Status: **built, as of 2026-08-21.** All six commits in §11 have landed. Every decision in §3
was settled by interview on 2026-08-17 and is recorded here as a decision, not a suggestion.

Three places where what shipped deviates from what is written below, each deliberate and each
documented at the point it applies:

1. **Committing is a `security definer` RPC, not an eighth Edge Function** (§7.3). supabase-js
   has no client-side transaction, so the function version had a real window where a period
   was half-imported. It also sidesteps PostgREST's row cap, gets a fail-closed audit row for
   free, and keeps `auth.uid()` so history rows name the committing admin.
2. **The export has no total row** (§7.4). A total has no MID, so re-importing the file this
   feature produces would block that row and refuse the batch — which contradicted decision
   12, the round trip that is the whole point of the export.
3. **`rep_payout_batches` and `rep_payout_import_rows` are granted fewer verbs than §5.2
   first said** — select+update and select-only respectively, because nothing client-side
   writes them. A grant no policy backs fails the quiet way.

One thing verified beyond what §12 asked for, and one thing still unverified. The migrations
were applied to real Postgres 17 (not only PGlite) and the generated column, partial unique
index and grant surface were read back from the catalog there. Nobody has signed into the
app and looked at the pages: they are covered by `build`, the test suites and a direct
function probe, not by eye.

Scope: importing a processor's period residual spreadsheet, holding it as a per-merchant
ledger, letting an admin fill in the two figures the processor does not supply, and getting
it back out as either a full XLSX or a per-agent payout summary. Out of scope: paying
anybody (no ACH, no payment status), commission schedules or tiers, and My Submissions.

## 1. Why

Residuals arrive monthly as an XLSX from the processor with seven columns — Period,
Agent #, MID, Merchant name, Volume, Average ticket, Total cost. The two numbers that
decide what a rep is actually owed, Residual income and Rep split, are not in that file;
they are worked out by hand. Today the whole cycle lives in a spreadsheet outside the CRM,
which means the CRM knows who a rep's merchants are but not what any of them earned, reps
cannot see their own residuals at all, and there is no record of who changed a commission
figure or when.

## 2. Findings that shaped this spec

Established by reading the code, not assumed:

1. **There is no agent-number identifier anywhere.** `profiles` is
   `id uuid, full_name, email, role, is_active, must_change_password, created_at`. A repo-wide
   grep for `agent_number`, `rep_code`, `employee_id`, `agent_code`, `rep_number` returns
   nothing. The only rep identifiers are the uuid PK, `full_name` and `email`.
2. **`profiles` has a SELECT policy and nothing else.** The admin UPDATE policy from the
   initial migration was deliberately dropped; every write goes through a `security definer`
   RPC (`set_user_role`, `update_own_full_name`, …) or the service role in an Edge Function.
   A new admin-editable `profiles` column therefore needs an RPC, not a policy.
3. **`merchants.mid` already exists** — `mid text unique`, nullable, since the initial
   migration. So a MID lookup is a unique-index hit, and `merchant-form.tsx:292` already
   maps its unique violation to a message that does not confirm the row exists.
4. **No file has ever been parsed.** No XLSX, CSV or PDF library is in `package.json` or
   `node_modules`. Uploads are opaque bytes: `documents` stores metadata, Storage stores the
   file, and nothing server-side ever reads it.
5. **No money column exists.** Every `numeric` in every migration is a percentage —
   `numeric(5,2)`, plus one `numeric(5,3)` tax rate. `lib/format.ts` has no currency
   formatter.
6. **`documents` does not fit an import file.** `owner_type` is
   `check in ('pre_app','merchant','support_ticket','lead')`, and both signed-URL functions
   resolve a *parent record's* `agent_id` via `resolveParentAgentId()`. A residual file has
   no owning rep.
7. **`log_cross_agent_change()` fires whenever `auth.uid()` is not the row's `agent_id`,**
   on seven tables, as an AFTER ROW trigger with no EXCEPTION block. On a table where every
   write is an admin acting on a rep's row it would fire on 100% of writes.
8. **`audit_log` has no detail column** — `actor_id, action, table_name, row_id, created_at`
   only. Existing code encodes the verb into `action` (`promote_user_to_admin` vs
   `demote_user_to_agent`) precisely because there is nowhere to put a before/after.
9. **`ConfirmPair` is inline, not modal,** and `new-user-form.tsx:15` records why the
   create-user surface is a page rather than a dialog: "a dialog that can be dismissed is
   the wrong container" for something that must not be lost.
10. **`useAutosave` is form-shaped**, built around one react-hook-form instance per wizard
    step with a hook-owned set of pending RHF paths. It is not a per-cell mechanism.
11. **RLS filters, it does not error.** `profile-step.tsx` checks `count === 0` on an upsert
    because a write the policy hides reports success having changed nothing.

## 3. Decisions

Referenced by number later in this document.

1. **Agent # resolves through a new `profiles.agent_number text unique`.** One number per
   rep. Not a mapping table: a rep holding several processor codes is a real possibility but
   not a current one, and the unique column is the thing that can be shown on Manage Users
   and typed on the create-user form.
2. **`agent_number` is optional.** Every existing rep has none, so requiring it would make
   the column unfillable without a migration that invents values. Nullable, unique, so many
   reps can have none and no two can share one.
3. **Admin sets `agent_number` via a new `security definer` RPC**, `set_agent_number`,
   guarded by `is_admin()` and writing `audit_log` — exactly the `set_user_role` shape, for
   exactly the reason in finding 2. `create-user` also accepts it as an optional field.
4. **MID is a soft link that never blocks.** The payout row stores `mid` and `merchant_name`
   as text from the file (authoritative), plus a nullable `merchant_id` resolved by MID
   lookup at import. A residual report legitimately contains merchants nobody entered into
   the CRM; blocking on that would stop payroll over a data-entry gap.
5. **Period is normalized to a date** — the first day of the month, stored as
   `period date not null`. Sorts correctly, displays as "July 2026", and gives one
   unambiguous merge key. An unparseable Period blocks its row (decision 7).
6. **The merge key is `(period, agent_id, mid)`, unique.** Not
   `(period, agent_number, mid)`: `agent_number` is unique on `profiles`, so the two are
   equivalent today, and keying on the uuid means reassigning an agent number later does not
   orphan history.
7. **Import is staged, and nothing lands until the batch is clean.** The file parses into
   `rep_payout_import_rows`; a review screen lists blockers; commit is refused while any
   row has one. A batch waits indefinitely, so an admin can leave, create a rep, and come
   back.
8. **A staging table, not a status column.** `rep_payout_rows` contains only clean, typed,
   resolved, committed data — no `status` column to forget in a `where` clause. The one
   query that forgot it would show draft figures as real payouts.
9. **An unknown Agent # can be resolved two ways from the review screen:** assign the
   number to an existing rep (via `set_agent_number`), or create a new rep with the number
   pre-filled. Both are needed — on day one *every* rep is unknown, because the column is
   new (finding 1).
10. **A deactivated rep resolves normally, with a warning.** Money owed and ability to log
    in are separate questions. The review screen says the agent is deactivated; commit is
    allowed. Consequence stated on screen: that rep cannot see the rows, because the own-row
    select branch requires `is_active_agent()`.
11. **A second upload merges, preserving hand-entered values.** Upsert on the decision-6
    key: file-sourced columns are overwritten from the file, `residual_income` and
    `rep_split_pct` are left alone unless the file itself supplies them (decision 12). Rows
    absent from the new file are left in place, not deleted.
12. **The XLSX export is round-trippable.** Nine columns: the seven import headers plus
    `Residual income` and `Rep split`. Re-importing that file merges by the same key and
    *does* write the two money columns where they carry a value, leaving them alone where
    blank. This is the bulk-entry path — fill a whole period in Excel instead of typing 40
    rows.
13. **Rep split is a percentage; the payout is derived.** `residual_income numeric(14,2)`
    and `rep_split_pct numeric(5,2)` are typed in; `rep_payout` is a **stored generated
    column**, `round(residual_income * rep_split_pct / 100, 2)`. Never independently
    editable, so the three figures cannot disagree. Null when either input is null, which is
    the correct reading of "not worked out yet".
14. **No pre-fill from `merchants.split_agent_pct`.** The merchant split and the residual
    split are not guaranteed to be the same number, and a silently pre-filled commission
    figure that is subtly wrong is worse than a blank one. Bulk-set (decision 15) covers the
    ergonomics instead.
15. **Split is edited inline per row, with a per-agent bulk set.** Each agent's group on the
    period page gets "set split for all N rows", behind `ConfirmPair`. Per-row truth stays
    visible; the common case is one action.
16. **Corrections overwrite in place, with field-level history.** `rep_payout_rows` is the
    current truth; `rep_payout_row_history` records old → new → who → when for
    `residual_income` and `rep_split_pct` on every change, written by a `security definer`
    AFTER UPDATE trigger. Immutable superseding rows were rejected: every read, export,
    total and summary would need a latest-per-key filter, and the one that got it wrong
    would be a wrong payout.
17. **`log_cross_agent_change()` is NOT attached to these tables.** On `rep_payout_rows`
    every write is by definition an admin acting on a rep's row, so the trigger would fire
    on every row of every import — 40 audit rows for one event — and say less than the
    batch-level entry plus the history table. `documents` is excluded from that trigger for
    the same kind of reason: audit where the event is. Instead: one `audit_log` row per
    committed batch, per-period delete audited, and `rep_payout_row_history` for figures.
18. **The history table survives a period delete**, so `row_id` carries no FK — the
    `notes`/`tasks`/`documents` `owner_id` precedent — and `period`, `agent_id` and `mid` are
    denormalized onto it so a history row is still readable after its row is gone.
19. **Reps read their own rows now.** Select is `(agent_id = auth.uid() and
    is_active_agent()) or is_admin()`; insert, update and delete are `is_admin()`.
20. **One role-aware route tree at `/payouts`,** not a separate `/admin/payouts`. An admin
    sees every rep plus import/export/delete; a rep sees their own rows, read-only. Same
    mechanism every other list page uses; two near-identical tables was the alternative.
21. **The import file lives in a new private bucket, `residual-imports`.** Keys are
    `{batch_id}/{filename}`. `documents` and both its signed-URL functions stay untouched
    (finding 6), and the two access stories stay separate.
22. **Parsing happens in an Edge Function, over the stored file.** The browser uploads the
    XLSX, then a function downloads and parses it. One authoritative parser; the original
    file is retained as provenance for every batch and can be re-downloaded.
23. **XLSX *writing* also happens in an Edge Function.** SheetJS then exists in exactly one
    place (Deno) rather than in both the browser bundle and the function. This is the direct
    lesson of the `pre-app-validation.ts` / `_shared/pre-app-secrets.ts` pair, which the
    codebase keeps duplicated only because a shared file could not survive
    `functions deploy`; here nothing forces the duplication, so it is avoided.
24. **`export-residuals` reads through the caller-scoped client,** so RLS scopes the export
    and a rep exporting gets only their own rows. The function is therefore not admin-gated.
25. **The payout summary is a print-optimized page, not a generated PDF.** One agent, one
    period. Zero new dependencies, renders in the app's own design tokens, and adjusts in
    minutes as the layout settles from real use. Server-side PDF generation is a documented
    follow-up (§13), not a gap.
26. **Individual rows are not deletable; a whole period is.** A missing or wrong merchant
    line is a correction, made by editing (decision 16). A period delete is the escape hatch
    for an import that was simply wrong — admin only, behind `ConfirmPair`, audited, and the
    history rows survive it (decision 18).
27. **A file may contain more than one period.** Rows carry their own period, so this is
    free; the review screen groups by period. The batch has no `period` column.
28. **Money is signed except volume.** `volume` and `average_ticket` are `check >= 0` — a
    negative there is a parse error, not a business fact. `total_cost` and `residual_income`
    take any sign, because clawbacks and adjustments are real and a constraint that rejects
    them turns valid data into an unexplainable blocked row. `rep_split_pct` is `check 0..100`.
29. **Money columns are `numeric(14,2)`.** Not integer cents: the values come from a
    spreadsheet as decimals, `numeric` is exact, and every other numeric in the schema is
    already `numeric(p,s)`.

## 4. Rules this work must not break

- **`docs/tapswipe_crm_schema.sql` changes first**, then migrations match it. Not the other
  way round.
- **Four things per new table**: `agent_id uuid references profiles(id) not null` (see the
  deviation in §5.2), `enable row level security`, the policies, and **explicit grants** plus
  `grant usage on <t>_id_seq`. A verb is granted only where a policy backs it.
- **Every new function gets** `revoke all on function <sig> from public;` and
  `grant execute on function <sig> to authenticated, service_role;` in the same migration.
  There is no declarative backstop.
- **Never grant `anon` anything.**
- **`security definer` is the exception.** Used here only for `set_agent_number` (writes
  `profiles`, writes `audit_log`) and the history trigger (writes a table with no insert
  grant). Both get an explicit `is_admin()`/ownership check and `set search_path`.
- **Edge Function order is fixed**: `withSupabase({ auth: "user" })` →
  `callerIsActive(ctx.supabase)` → authorization through the **caller-scoped** client →
  only then `ctx.supabaseAdmin`, and only for the privileged step.
- **404, never 403**, when a record is not the caller's.
- **All functions are `verify_jwt = false`** and must authenticate themselves. New ones must
  be added to `supabase/config.toml` or they will not deploy or serve.
- **`warmFunctions([...])` in every live test's `beforeAll`**, before any status assertion.
- **A live test that writes `audit_log` must delete those rows before deleting its users.**
- **No Tailwind colour literals.** `formatMoney` output is text; the only new colour need is
  a negative-figure treatment, which uses the existing `destructive` token — and does **not**
  use a status colour (§8.4).
- **No dark-mode work.** The app is pinned light.
- **Read `node_modules/next/dist/docs/` before writing route code.** This is Next 16;
  `cacheComponents: true` means every dynamic read sits inside `<Suspense>`.

## 5. Schema changes

Two migrations. Both mirror `docs/tapswipe_crm_schema.sql`, updated first.

### 5.1 `<ts>_agent_number.sql`

```sql
alter table profiles add column if not exists agent_number text;
create unique index if not exists profiles_agent_number_key
  on profiles (agent_number) where agent_number is not null;
```

Partial unique index rather than a table constraint, so that many reps can have no number
while no two share one. (A plain `unique` would also permit multiple nulls in Postgres; the
partial index states the intent and does not index the nulls.)

`set_agent_number(target_user_id uuid, new_agent_number text)` — `security definer`,
`set search_path`, explicit `is_admin()` guard at the top, raises on a number already held
by a different rep, accepts `null` to clear, and writes `audit_log` with `action` encoding
the direction (`set_agent_number` / `clear_agent_number`) because there is no detail column
(finding 8). Privilege lines in the same migration.

No grant change to `profiles`: the select policy is unchanged, so an agent still sees only
their own row and an admin sees all — the same boundary that already governs `full_name`,
`email` and `role`. Same reasoning as `20260813171344_profiles_email.sql`.

### 5.2 `<ts>_rep_payouts.sql`

Four tables.

**`rep_payout_batches`** — one row per uploaded file.

```
id serial pk
imported_by uuid references profiles(id) not null
file_key text not null            -- key in the residual-imports bucket
file_name text not null
status text not null default 'review'
  check (status in ('review', 'committed', 'abandoned'))
row_count int not null default 0
uploaded_at timestamptz default now()
committed_at timestamptz
```

**Deliberate deviation from the four-things rule:** the ownership column is `imported_by`,
not `agent_id`. A batch belongs to no rep. Naming the importing admin `agent_id` would make
the standard policy expression `(agent_id = auth.uid() and is_active_agent()) or is_admin()`
accidentally *meaningful* — and wrong, since it would let a rep read a batch merely because
an admin's uuid happened to match. The rule exists to stop a rep-owned table from being
unscoped; this table has no rep.

Policies: select and update `is_admin()` — the import page lists batches, and "Abandon
batch" is a status update. **No insert or delete policy**: batches are created by
`residual-import-file-url` under the service role, and are never deleted (a batch is the
record that an import happened, which is the point of keeping the file). Grants therefore
`select, update` to `authenticated`, `all` to `service_role`, and `usage` on the sequence to
`service_role` only.

**`rep_payout_import_rows`** — staging. Every cell kept as text exactly as parsed, alongside
its resolved value, so the review screen can show what the file said next to what it means.

```
id serial pk
batch_id int references rep_payout_batches(id) on delete cascade not null
row_number int not null                 -- 1-based sheet row, for error messages
period_raw, agent_number_raw, mid_raw, merchant_name_raw,
volume_raw, average_ticket_raw, total_cost_raw,
residual_income_raw, rep_split_raw      -- all text
period date
agent_id uuid references profiles(id)
merchant_id int references merchants(id) on delete set null
volume, average_ticket, total_cost, residual_income  numeric(14,2)
rep_split_pct numeric(5,2)
blocker text check (blocker in
  ('unknown_agent', 'unparseable_period', 'bad_number', 'missing_mid', 'duplicate_in_file'))
error text                              -- human-readable, null when clean
```

**Select policy only, `is_admin()`.** Every write to this table comes from
`parse-residual-import` or `commit-residual-import` under the service role — the review
screen only reads it, and the one fixable blocker is fixed by re-parsing rather than by
editing a staging row (§8.3). Granting insert/update/delete to `authenticated` would be dead
weight of exactly the kind the grants section warns about: the privilege check passes, RLS
filters the statement to nothing, and the caller sees a save that did nothing. So `select` to
`authenticated`, `all` to `service_role`, `usage` on the sequence to `service_role` only.

`on delete cascade` from the batch is right here and only here: staging rows have no meaning
without their batch.

**`rep_payout_rows`** — the ledger. Clean, typed, committed, no status column (decision 8).

```
id serial pk
agent_id uuid references profiles(id) not null
period date not null
mid text not null
merchant_name text
merchant_id int references merchants(id) on delete set null
volume numeric(14,2) check (volume >= 0)
average_ticket numeric(14,2) check (average_ticket >= 0)
total_cost numeric(14,2)
residual_income numeric(14,2)
rep_split_pct numeric(5,2) check (rep_split_pct >= 0 and rep_split_pct <= 100)
rep_payout numeric(14,2) generated always as
  (round(residual_income * rep_split_pct / 100, 2)) stored
batch_id int references rep_payout_batches(id) on delete set null   -- last write's provenance
created_at, updated_at timestamptz default now()
unique (period, agent_id, mid)
```

`merchant_id` and `batch_id` are `on delete set null` so that deleting a merchant, or an old
batch, does not wedge on an FK. Indexes on `(period)` and `(agent_id, period)`. A
`set_updated_at()` trigger, matching every other table.

Policies: select `(agent_id = auth.uid() and is_active_agent()) or is_admin()`; update and
delete `is_admin()`; **no insert policy** — rows are created only by
`commit-residual-import` under the service role, the same arrangement as `profiles` and
`audit_log`.

Grants: `select, update, delete` to `authenticated` (a verb only where a policy backs it —
no insert, because nothing client-side inserts), `all` to `service_role`, and
`usage on rep_payout_rows_id_seq` to `service_role` only.

**`rep_payout_row_history`** — field-level trail, outliving its subject (decision 18).

```
id serial pk
row_id int not null                     -- NO FK, deliberately: survives a period delete
period date not null                    -- denormalized so history reads without its row
agent_id uuid references profiles(id) not null
mid text not null
field text not null check (field in ('residual_income', 'rep_split_pct'))
old_value numeric(14,2)
new_value numeric(14,2)
changed_by uuid references profiles(id)
changed_at timestamptz default now()
```

Written by `log_payout_row_change()` — `security definer`, `set search_path`, AFTER UPDATE ON
`rep_payout_rows`, one row per changed field, `changed_by = auth.uid()`. **Fails closed**: no
EXCEPTION block, so a history-write failure rolls back the edit, matching
`log_cross_agent_change()`'s reasoning — nothing has been handed over yet, so refusing the
write is the safe answer.

Policies: select `is_admin()` only — a rep reads their figures, not the edit history behind
them. No insert, update or delete policy at all. Grants: `select` to `authenticated`, `all`
to `service_role`, `usage on rep_payout_row_history_id_seq` to `service_role`.

`changed_by` mirrors `audit_log.actor_id` exactly — a plain `references profiles(id)` with no
`ON DELETE`. Consequence for tests, same as the one CLAUDE.md documents: a live test must
delete its history rows before deleting its users.

### 5.3 Storage — out of band, not SQL

One new private bucket, `residual-imports`. No storage policies: signed URLs from
`residual-import-file-url` are the only way in or out, exactly as with `documents`.

It must be created in three places or the symptom is a 404 from every signing call:
the local stack, `tests/live/helpers/stack.ts` provisioning, and the hosted project. Record
it in the `NOTE ON SUPABASE STORAGE` section of the schema doc alongside `documents`.

## 6. Parsing contract

Lives server-side only, in `supabase/functions/_shared/residuals.ts` — pure functions over
already-extracted cell values, dependency-free so it needs no import map, same arrangement as
`_shared/documents.ts` and `_shared/admin-users.ts`. **There is no browser copy**, because
parsing is server-side (decision 22), so the two-sided-validator hazard that
`_shared/pre-app-secrets.ts` documents does not arise here. Do not create one.

**Headers** are matched case-insensitively on trimmed text, against the nine canonical names:
`Period`, `Agent #`, `MID`, `Merchant name`, `Volume`, `Average ticket`, `Total cost`,
`Residual income`, `Rep split`. The last two are optional (a fresh processor file will not
have them; a round-trip export will). A missing required header fails the whole parse with a
message naming the header — a batch-level error, not a per-row blocker, because a file with
the wrong shape has no rows worth reviewing.

**Period** accepts `YYYY-MM`, `YYYY-MM-DD`, `MM/YYYY`, `M/YYYY`, `Mon-YY`, `Mon YYYY`,
`Month YYYY`, and an Excel serial date, and normalizes each to the first of that month. Two
traps: a two-digit year is interpreted as 20xx, and a bare month name with no year is
**not** accepted (guessing the year on a commission record is not a guess worth making).
Anything else → blocker `unparseable_period`.

**Numbers** tolerate what Excel emits: thousands separators, a leading `$`, a trailing `%`
on Rep split, whitespace, and `(123.45)` for a negative. Empty or `-` is null, not zero —
"not supplied" and "zero dollars" must not collapse. Anything else → blocker `bad_number`.
Rounding to 2dp happens once, here, before insert; the generated column rounds again on the
product only.

**Blockers**, in the order checked per row: `missing_mid` (a MID is the row's identity and
cannot be inferred), `unparseable_period`, `unknown_agent` (no `profiles` row with that
`agent_number`), `bad_number`, then `duplicate_in_file` (a second row with the same
`(period, agent_number, mid)` — the merge key cannot resolve two).

A deactivated rep is **not** a blocker (decision 10). It is a warning computed on the review
screen from `profiles.is_active`, not a stored column.

## 7. Edge Functions

Four new, all `verify_jwt = false`, all registered in `supabase/config.toml`, all following
the fixed order in §4. SheetJS is imported through each function's own `deno.json` import
map; `_shared/residuals.ts` stays library-free.

### 7.1 `residual-import-file-url` — two modes, admin only

- `{ file_name }` → creates a `rep_payout_batches` row (`status: 'review'`), builds the key
  `{batch_id}/{sanitized_file_name}`, mints a signed **upload** URL, returns
  `{ batch_id, path, token }`.
- `{ batch_id }` → mints a signed **download** URL for that batch's stored file.

The batch row is created *before* the upload, because the key contains the batch id. A batch
whose file never arrives is a harmless empty `review` row with `row_count = 0`; the import
page shows it as abandonable.

### 7.2 `parse-residual-import` — admin only

`{ batch_id }` → downloads the file with `ctx.supabaseAdmin.storage`, parses it, writes
`rep_payout_import_rows`, resolves `agent_id` by `agent_number` and `merchant_id` by `mid`,
sets `row_count`, and returns the review payload: totals, and blockers grouped by
`agent_number_raw` with a few example merchant names per group (the hint in the resolve UI).

Idempotent: re-parsing deletes the batch's existing staging rows first, so a re-parse after
resolving an agent number is a normal action rather than a duplicate.

Resolution reads through `ctx.supabaseAdmin` — deliberately, and it is the one place in this
module that does so before authorization is complete in the usual sense. Justification:
authorization is already settled (the caller is a verified active admin, checked through the
caller-scoped client), and an admin may read every `profiles` and `merchants` row anyway, so
the admin client buys only the ability to resolve without 40 round trips. It must not be
used to *decide* anything.

### 7.3 Committing is a `security definer` RPC, not an Edge Function

**Revised 2026-08-17, before implementation.** This was specified as
`commit-residual-import`, an eighth Edge Function. It is instead
`commit_residual_import(batch_id_input int)`, a `security definer` plpgsql RPC — the same
shape and for the same reasons as `approve_pre_app`, which this closely resembles (creates
rows the caller may not insert, flips a parent's status, writes `audit_log`, guards itself
with an explicit `is_admin()`).

Four reasons, in order of weight:

1. **Atomicity, which the Edge Function could not have.** supabase-js has no client-side
   transaction, so the function would have had to insert the ledger rows, then delete the
   staging rows, then flip the batch status as three separate round trips — with a real
   window where a period is half-imported. In SQL it is one statement sequence in one
   transaction: it all lands or none of it does. For a commission import that is not a
   nicety.
2. **No pagination to get wrong.** PostgREST caps a response (`[api] max_rows`), so the
   function would have had to page through staging rows and silently import a prefix if
   anyone forgot. `insert … select` has no such limit.
3. **The audit row can fail closed.** Inside the transaction, a failed `audit_log` insert
   rolls the whole import back — so the `auditWriteFailed` asymmetry this spec previously
   described simply does not arise. `submit-pre-app-secrets` has to be best-effort because
   its ciphertext is already written when it audits; nothing is written here until commit.
4. **`auth.uid()` survives `security definer`**, so the history rows the upsert triggers are
   attributed to the admin who committed, rather than to nobody. That is strictly better
   provenance than a service-role write would have given.

What it does:

1. `is_admin()` or `raise` — the guard is hand-written, because `definer` bypasses RLS.
2. Refuses unless the batch is `review`, and refuses if any staging row has a `blocker` or
   if there are no staging rows at all. Distinct error codes, so the UI can say which.
3. Upserts staging rows into `rep_payout_rows` on `(period, agent_id, mid)`. File-sourced
   columns always written; `residual_income` and `rep_split_pct` via
   `coalesce(excluded.<col>, rep_payout_rows.<col>)` — **written only when the file supplied
   a value** (decision 12), so a fresh processor file never clears a hand-entered figure and
   a round-trip export fills them in.
4. Deletes the batch's staging rows, sets `status = 'committed'` and `committed_at`.
5. Writes one `audit_log` row: `action = 'commit_residual_import'`, `table_name =
   'rep_payout_batches'`, `row_id = batch_id`.

Consequence for §5.2: the note on `rep_payout_row_history.changed_by` saying the commit step
runs with no `auth.uid()` is **wrong under this design** and is corrected — a commit is
attributed to the committing admin. `changed_by` stays nullable for a genuine service-role
write, which nothing currently performs.

### 7.4 `export-residuals` — any active caller

`{ period?, agent_id? }` → reads `rep_payout_rows` **through `ctx.supabase`** (decision 24),
builds the workbook, returns
`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` bytes with a
`Content-Disposition` filename.

**No total row — corrected 2026-08-17, and this was a real conflict in this spec.** §7.4
originally said "plus a derived `Rep payout` column and a total row". A total row is
incompatible with decision 12: it has no MID, so re-importing the file the feature produces
would block that row with `missing_mid` and refuse the whole batch. The round trip is the
point of this export, so the total goes. The page already shows the totals; a spreadsheet
that will not re-import is worse than one without a footer.

Columns: the nine canonical headers (which is what makes it re-importable), plus **`Agent`**
(the rep's name) and **`Rep payout`** (derived). Those two extras are safe precisely because
`mapHeaders` ignores headers it does not recognise, and `Rep payout` is generated so there is
nothing to write it back to. `Agent` does not collide with `Agent #`: the normaliser reduces
those to `agent` and `agent#`.

**Paginated with `.range()`.** PostgREST caps a response at `[api] max_rows` (1000 here), so
a single select would silently export a prefix. That is the same hazard that made committing
an RPC (§7.3) rather than a function; here the read genuinely has to go through PostgREST,
because RLS scoping *is* the authorization, so it pages instead.

RLS is the whole authorization story: an admin gets everything in scope, a rep gets their own
rows, a deactivated caller gets nothing (and is rejected earlier by `callerIsActive`). No
role branch in the function, for the same reason `search_crm` is `security invoker` — an
export is exactly the shape of thing that becomes a disclosure bug.

Note the asymmetry: the export's `Rep payout` and `Agent` columns are written, but on
re-import both are ignored. `Rep payout` is derived (decision 13) so there is nothing to
write it to, and the rep is identified by `Agent #`, not by a display name that two people
could share.

### 7.5 `create-user` — one field added

Accepts an optional `agent_number`, validated with a new `isAgentNumber` in
`_shared/admin-users.ts` (trimmed, non-empty, ≤ 32 chars). Written into the `profiles`
insert. Everything else — the `auth.users` rollback on profile-insert failure, the temp
password, the audit write — is unchanged.

A duplicate `agent_number` must be caught **before** `auth.admin.createUser`, otherwise the
unique violation lands on the `profiles` insert and triggers the rollback path with a
confusing message. Check it first, return `409`.

## 8. Frontend

### 8.1 Routes

| Route | Who | What |
| --- | --- | --- |
| `/payouts` | all | Periods list. Admin: every period with row count, total residual, total payout, and an unfilled-figures count. Rep: their own periods and their own totals. Admin header action: "Import residuals". |
| `/payouts/[period]` | all | The ledger for one period. Admin: grouped by rep, inline-editable, per-agent bulk split, export buttons, "Delete period". Rep: their own rows, read-only. |
| `/payouts/[period]/summary/[agentId]` | all | The print-optimized payout summary (§8.5). A rep can reach their own; RLS returns nothing for anyone else's, which becomes `notFound()`. |
| `/payouts/import` | admin | Batch list + upload. |
| `/payouts/import/[batchId]` | admin | The review screen (§8.3). |

`[period]` is `YYYY-MM` in the URL, parsed to a date. A malformed segment is `notFound()`,
not a silent fallback — the merchants detail page's `Number.isInteger` guard is the
precedent.

Every page follows the house shape exactly: sync default export → `PageShell` →
`PageHeader` → `<Suspense>` around an async child that calls `requireUser()` (or
`requireAdmin()` for the two admin-only routes, which also get the "Back to dashboard" ghost
button the other admin pages carry). Errors render inline as
`text-sm text-destructive`, never thrown. Widths: `list` for `/payouts` and
`/payouts/import`, `detail` for a period, `form` for the upload step.

### 8.2 Nav

One item in the **Operations** group of `lib/nav.ts`, `{ label: "Payouts", href: "/payouts",
icon: BanknoteIcon }` — **no `adminOnly`**, because every rep uses it (decision 19). The
comment on Documents in that file records the same reasoning for the same choice.

`/payouts/import` gets no nav item of its own: `isNavItemActive` is a prefix match, so it
keeps Payouts lit, and the page is reached from the header action.

### 8.3 The review screen — the blocking surface

This is where "block that row's import" lives, and it is a **page, not a dismissible
dialog** — `new-user-form.tsx:15` gives the reason for exactly this shape of thing, and a
batch that survives across sessions (decision 7) cannot live in something a stray Escape
key destroys. Each unknown agent number expands **inline** to its resolve controls, in the
`ConfirmPair` spirit: the action lands where the eye already is.

```
Batch #4 — July-2026.xlsx — 38 rows                    [ Download original ]

  ⚠ 2 unrecognised agent numbers — 15 rows blocked
    4471   12 rows   Joe's Diner, Corner Mart, +10        [ Resolve ]
    9902    3 rows   Bayside Auto, +2                     [ Resolve ]

  ⚠ 1 unparseable period
    row 22   "Q3 2026"                                    (fix the file and re-upload)

  ⓘ Agent # 7788 (Dana Reyes) is deactivated — 4 rows will import, and Dana
    will not see them.

  [ Commit 38 rows ]   ← disabled while any blocker remains
  [ Abandon batch ]
```

Expanding **Resolve** offers the two paths of decision 9: a rep picker that calls
`set_agent_number`, or "Create a new rep" linking to `/admin/users/new?agent_number=4471`
with the field pre-filled and a `returnTo` back to the batch. Either way the screen then
re-invokes `parse-residual-import` (idempotent, §7.2) so resolution is one code path rather
than two.

Only `unknown_agent` is fixable in place. `unparseable_period`, `bad_number`, `missing_mid`
and `duplicate_in_file` are file problems: they report the sheet row number and the offending
text, and the fix is a corrected upload. Say so on screen rather than offering an edit
affordance that would let someone silently retype a commission figure the processor sent.

### 8.4 Inline editing on the period page

Two editable cells per row, admin only: Residual income and Rep split.

**Saved on blur and on Enter — not debounced per keystroke, and not through `useAutosave`.**
Two reasons. `useAutosave` is built around one react-hook-form instance with a hook-owned
set of dirty RHF paths (finding 10); a 40-row grid is not that shape, and forcing it would
mean one form over 80 fields whose pending-path set is the least of the problems. And a
money field written on every keystroke writes `8`, `88`, `88.4` — three history rows
(decision 16) for one edit, in a table whose entire purpose is a legible trail.

Each save is a scoped update with `count: "exact"`, and a zero count is surfaced as an
error — RLS filters rather than errors (finding 11), so without that check a rep who somehow
reached the control would be told their edit saved.

Rendering: `formatMoney` for money, existing `formatPct` for the split (which renders
`60.00%` from `numeric(5,2)`, consistent with the merchants list). A negative figure gets
the `destructive` token — **not** a status colour, and not a badge. `StatusBadge` and the
status palette are for state vocabularies; there is no status here.

Per-agent bulk split: "Set split for all 12 rows" above each group, behind `ConfirmPair`
with `destructive={false}` (it commits rather than removes), the confirm label naming the
count and the percentage. It overwrites blanks and existing values alike — stated in the
label, because a silent partial fill is the worse surprise.

"Delete period" uses `ConfirmPair` with `destructive`, and its label names both the row count
and how many rows carry hand-entered figures, so the cost of the click is visible before it.

### 8.5 The payout summary page

One agent, one period, print-first. A `@media print` block hides the sidebar, header and
every control; the page is otherwise ordinary app markup on ordinary tokens, so it needs no
separate stylesheet and cannot drift from the app's look.

Contents: rep name, agent number, period, generation date; a line per merchant with MID,
merchant name, volume, residual income, split % and payout; a total payout. Merchants that
matched a CRM record link through on screen — the link is inert on paper, which is fine.

Reached from each agent's group header on the period page, and from a rep's own period page.

### 8.6 `lib/payouts.ts`

Mirrors `lib/merchants.ts`: the batch-status vocabulary `as const` with a comment naming the
migration and stating the database is the authority; `PAYOUT_ROW_LIST_COLUMNS` as one
exported string so a test can assert the same set; row types; `parsePeriodParam()` returning
null for untrusted input; `batchStatusIntent()` returning a `StatusIntent`; and
`payoutTotals()` as a pure reducer so the same arithmetic serves the list page, the period
page and the summary. Blocker codes get a `blockerLabel()` map here too — one place where a
code becomes English.

### 8.7 `lib/format.ts` — two additions

- `formatMoney(value)` → `Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })`,
  em dash for null/undefined, per the file's stated contract. Negative values render as
  `-$88.40`, not `($88.40)`: the parens convention reads as a typo in a web table, and the
  colour token already carries the signal.
- `formatPeriod(value)` → `"July 2026"` from `"2026-07-01"`, **built on `parseDisplayDate`**.
  Not `new Date(value)`: the whole documented off-by-one-day bug in that file becomes an
  off-by-one-*month* bug here, and December would display as November of the wrong year.
  That is the one that would be noticed last and matter most.

`formatPct` is left alone — several pages depend on its exact output.

## 9. Changes to existing files

- `docs/tapswipe_crm_schema.sql` — all schema changes, **first**. New `REP PAYOUTS`
  section after `bug_reports`, following the house block order (create table → enable RLS →
  policies), with the four tables, both trigger/function definitions and their privilege
  lines. Additions to `PROFILES` (`agent_number` + `set_agent_number`), to the
  `DATA API GRANTS` section (one comment per table justifying the omitted verbs), and to the
  `NOTE ON SUPABASE STORAGE` section (the second bucket). A note under the cross-agent
  trigger recording why these tables are excluded (decision 17), beside the existing
  `documents` note.
- `CLAUDE.md` — the module in the "Built" list; the two new buckets/tables in the tiers
  section; the three-audit-sites paragraph becomes four, with `commit-residual-import`'s
  best-effort choice and the history trigger's fail-closed choice; the Edge Function table
  gains four rows; the "no file has ever been parsed" fact is now false and the parser's
  single-copy status is worth stating explicitly, since it is the opposite arrangement to the
  secrets validators.
- `supabase/config.toml` — four `[functions.*]` blocks, each `verify_jwt = false`.
- `lib/nav.ts` — the Payouts item (§8.2).
- `lib/format.ts` — `formatMoney`, `formatPeriod` (§8.7).
- `supabase/functions/_shared/admin-users.ts` — `isAgentNumber`.
- `supabase/functions/create-user/index.ts` — optional `agent_number` (§7.5).
- `components/new-user-form.tsx` — an optional Agent # field, pre-filled from the
  `agent_number` search param, and a `returnTo` that sends the admin back to the waiting
  batch.
- `app/(app)/admin/users/page.tsx` — an Agent # column, and inline set/clear via
  `set_agent_number`. **Its column list is pinned by `tests/rls/manage-users.test.ts`** — change
  it there too, or that test asserts the safety of a query nothing runs.
- `lib/admin-users.ts` — reuse `callAdminFunction` for the four new functions; it already
  unwraps `FunctionsHttpError` so the server's message reaches the UI.
- `tests/helpers/db.ts` — `agent_number` on the seeded profiles, payout rows for two agents
  across two periods, a staged batch with a deliberate `unknown_agent` blocker; the four
  tables added to `resetData()`'s truncate list; `audit_log` still cleared at the end of
  `seed()`.
- `tests/live/helpers/stack.ts` — provision the `residual-imports` bucket alongside
  `documents`.
- `app/globals.css` — a print block, if §8.5's needs exceed what a page-local
  `print:` utility set covers. Prefer the utilities; no new colour tokens either way.

## 10. Tests

| File | Suite | Asserts |
| --- | --- | --- |
| `tests/rls/rep-payouts.test.ts` | PGlite | Scoping on all four tables per persona — own / admin / other agent / unauthenticated / **deactivated**. `rep_payout_rows` has no insert policy (an `authenticated` insert is refused, not filtered). Admin-only select on `rep_payout_row_history`. The unique merge key rejects a duplicate. Both `check >= 0` columns and the 0–100 split range. `total_cost` and `residual_income` accept negatives. `rep_payout` computes, rounds, and is null when either input is null. A load-bearing case that mutates a policy to prove the test is not vacuous, per `documents.test.ts`. |
| `tests/rls/payout-history-trigger.test.ts` | PGlite | An update to either money field writes exactly one history row per changed field, with the right old/new/`changed_by`; an update touching neither writes none; the history row survives deleting its `rep_payout_rows` row and still reads (period/agent/mid denormalized); and the **fail-closed** case — break the history insert and assert the parent update rolls back, mirroring `audit-trigger.test.ts`. |
| `tests/rls/commit-residual-import.test.ts` | PGlite | The RPC (§7.3): admin-only, and nothing written when it refuses; refuses a blocked batch, an empty one, one already committed, one that does not exist, and a second commit. Then the merge — file columns overwritten, hand-entered figures **kept** when the file has none and **written** when it supplies them, no duplicate row, two reps' rows for one MID kept apart, history written for a figure a re-import changed and none for a file-only change. Plus the catalog facts: `prosecdef`, the `is_admin()` guard, `search_path`, and the literal `coalesce(excluded.residual_income` — because reversing that one expression is silent. |
| `tests/rls/set-agent-number.test.ts` | PGlite | Admin sets, changes and clears; an agent calling it is refused (not silently ignored); a duplicate number raises; `audit_log` gets the right `action` in each direction; `prosecdef` is true on this one and the `is_admin()` guard is present. |
| `tests/rls/grants.test.ts` | PGlite | Extended: `anon` has nothing on the four tables; `authenticated` has no insert on `rep_payout_rows` and no insert/update/delete on the history table; the two new functions are not executable by `anon`; `usage` on both new sequences is `service_role` only. |
| `tests/unit/residuals-parse.test.ts` | vitest | Every accepted Period form → the right first-of-month, including the Excel serial and the two-digit year; rejected forms (`"Q3 2026"`, a bare month) → `unparseable_period`. Number coercion: separators, `$`, `%`, parens-negative, empty vs `-` → **null, not zero**. Header matching case/whitespace-insensitively; a missing required header fails the parse. Blocker precedence in the §6 order. |
| `tests/unit/payouts.test.ts` | vitest | `parsePeriodParam` rejects untrusted input; `payoutTotals` over a mixed set including nulls and negatives; `formatMoney` (including negative and null) and `formatPeriod` — the latter with a **December** case, which is the one that catches the `new Date` mistake §8.7 warns about. |
| `tests/live/manage-users.test.ts` | HTTP | Extended for `create-user`'s new field: an account created with an `agent_number` lands with it on `profiles`; a duplicate number returns **409 before the `auth.users` row is created**, so no orphan and no rollback path; blank and whitespace store null rather than `''`; over 32 characters is a 400. Nothing in the repo type-checks `supabase/functions` (tsconfig excludes it, eslint ignores it), so this file is the only automated check on that handler. |
| `tests/live/residual-import.test.ts` (export half) | HTTP | `export-residuals` scoped by RLS — a rep's file contains their rows and not the other agent's, an admin's contains both; a deactivated caller gets 403. The header row is exactly the eleven columns, in order. **Every data row carries a MID**, which is how the "no total row" rule is pinned. And the round trip: commit a row, export it, assert the two money columns come out **blank rather than zero**, fill them in, re-import the same shape, and assert they land with `rep_payout` recomputed by the database. |
| `tests/live/residual-import.test.ts` | HTTP | `warmFunctions` first. The whole cycle against the running stack: mint upload URL → upload a fixture XLSX → parse → assert blockers → resolve an agent number → re-parse → commit → assert `rep_payout_rows`. Then: commit refused with a blocker outstanding; commit refused twice (already `committed`); merge preserves hand-entered figures on a re-upload of a fresh-format file and **writes** them on a round-trip file; a rep and a deactivated admin are both rejected by every admin-only function; `export-residuals` returns only the caller's rows as an admin vs as a rep; a batch id that is not the caller's returns **404, not 403**. Cleans its `audit_log` **and `rep_payout_row_history`** rows before deleting its users. |
| `tests/auth/require-admin.test.ts` | vitest | **Deliberately NOT extended — audited instead.** That file tests the branching in `lib/auth.ts` in isolation (which failure routes where), and it already covers every case `requireAdmin()` has; adding payout-flavoured copies would assert the same four branches again. The thing actually worth catching is an *omission* — a new admin route with no guard — and the only way to test that from vitest is to grep the page sources, which is brittle: `app/(app)/payouts/page.tsx` matches `requireAdmin` in a **comment** while correctly using `requireUser`, so a grep test would have passed for the wrong reason. Audited by hand on 2026-08-21 instead: all 32 pages under `app/(app)/` call a guard, and the five admin-only ones (`admin/users`, `admin/users/new`, `admin/bug-reports`, `payouts/import`, `payouts/import/[batchId]`) call `requireAdmin`. It is a UX boundary in any case — strip it and a rep sees an empty list, because the policies on `rep_payout_batches` are admin-only. |

## 11. Build order

Six commits, each independently working and verified.

1. **Agent numbers** — schema doc, migration 5.1, `set_agent_number`, `create-user` field,
   `new-user-form`, the Manage Users column, `tests/rls/set-agent-number.test.ts`, the
   `manage-users` column-list update, and the `tests/live/manage-users.test.ts` additions.
2. **Tables** — schema doc, migration 5.2, the history trigger, grants, fixtures,
   `tests/rls/rep-payouts.test.ts`, `tests/rls/payout-history-trigger.test.ts`, the
   `grants.test.ts` additions.
3. **Read-only surface** — `lib/payouts.ts`, `lib/format.ts` additions, `lib/nav.ts`,
   `/payouts` and `/payouts/[period]` reading seeded data, role-aware, still no import.
   `tests/unit/payouts.test.ts`.
4. **Parsing** — the bucket, `_shared/residuals.ts`, `residual-import-file-url`,
   `parse-residual-import`, config wiring, the upload page and the review screen,
   `tests/unit/residuals-parse.test.ts`.
5. **Commit and editing** — `commit-residual-import`, the resolve-inline paths, inline cell
   editing, per-agent bulk split, delete period, `tests/live/residual-import.test.ts`.
6. **Out** — `export-residuals`, both export buttons, the round-trip re-import path, the
   print summary page.

## 12. Verification

`npm run build`, `npm run lint`, `npx tsc --noEmit`, `npm test` after every commit;
`npm run test:live` after commits 4, 5 and 6. Nothing goes near the linked project without
asking, and `npx supabase config push` is never run.

Manual pass, once commit 6 lands, with a real file:

- **As admin:** upload a period with at least one unknown agent number. Confirm commit is
  disabled, resolve one number onto an existing rep and the other by creating a rep, commit,
  and see the rows on the period page. Type a residual income and a split; reload and confirm
  both persisted and the payout column computed. Bulk-set one rep's split. Export the table,
  edit two residual figures in Excel, re-upload, and confirm those two changed and nothing
  else did. Print a summary. Delete the period and confirm the history rows are still
  readable in the database.
- **As a rep** with rows in that period: confirm `/payouts` shows only their own periods and
  totals, no money field is editable, no import control is present, their own summary
  prints, and their export contains only their rows.
- **As a deactivated rep:** confirm the account cannot sign in at all, and that a token
  issued before deactivation returns zero payout rows.

Record what was run and what was observed. Both boundaries — `requireAdmin()` and RLS — are
verified independently, per the house rule; stripping the page guard must still yield nothing.

## 13. Open items — to confirm, not assume

1. **"Popup" is interpreted as a page with inline resolve controls** (§8.3), because the
   batch outlives the session and the codebase already rejected dismissible dialogs for
   exactly this kind of thing. If a modal is genuinely wanted, say so before commit 4.
2. **One agent number per rep** (decision 1). If reps hold different codes per processor,
   this becomes the mapping table and decisions 1, 6 and 9 change with it. Cheap now,
   expensive after real data exists.
3. **Whether a MID can legitimately appear twice for one rep in one period** — split by card
   type, say. The unique key and `duplicate_in_file` both assume not. Worth checking against
   a real file before commit 2.
4. ~~**Whether "Volume" is dollars or transaction count.**~~ **Settled 2026-08-17: dollars.**
   `numeric(14,2)`, rendered with `formatMoney`, consistent with Average ticket beside it.
5. **Whether a rep should see a period before its figures are filled in.** Currently yes:
   rows commit with null residual and split, so a rep can see a merchant list with blank
   money. The alternative is hiding a period from reps until complete, which needs a
   per-period published flag and is not specified here.
6. **Server-side PDF generation** (decision 25) — a follow-up once the print layout has
   settled from real use, reusing the same layout.
7. ~~**SheetJS distribution under Deno.**~~ **Settled 2026-08-17, mostly.** Pinned to
   `https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs` in
   `parse-residual-import/deno.json`, and **verified loading and parsing under the local
   edge runtime** — a real workbook round-tripped through upload → parse → staging rows.
   *Not* `npm:xlsx`: the npm registry's latest is 0.18.5, which carries two high-severity
   advisories (prototype pollution and ReDoS) fixed only in SheetJS's own 0.19.3/0.20.2
   builds, because they stopped publishing to npm. Shipping a known-vulnerable parser to
   read uploaded files was not worth the convenience, and "only admins can upload" is a
   thin last line of defence. **Still outstanding: confirming a remote-URL import survives
   `functions deploy`**, which only a deploy proves. If it does not, vendor the single
   `xlsx.mjs` file into the function directory rather than falling back to `npm:xlsx`.
   `xlsx@0.20.3` is also a **devDependency**, installed from the same CDN tarball, used
   only to *build* fixture workbooks in tests. That does not weaken decision 23: it never
   enters a shipped bundle, and pinning both sides to one version means fixtures and parser
   cannot disagree.

8. **Deleting a user requires clearing five payout FKs first.** All five references to
   `profiles` from these tables are `NO ACTION` — `rep_payout_rows.agent_id`,
   `rep_payout_import_rows.agent_id`, `rep_payout_batches.imported_by`, and both
   `rep_payout_row_history.agent_id` and `.changed_by`. Found the hard way: a probe script's
   teardown deleted the profile without clearing staging rows, the delete failed on the FK
   *without being checked*, and the leftover rep silently resolved an agent number a later
   run expected to be unknown — which looked like a parser bug. Production never deletes
   users (§8: deactivation, never deletion), so only tests pay this, but
   `tests/live/residual-import.test.ts` and `deleteUserCompletely()` must clear all five
   before `deleteUser`, and must check the error rather than assuming it worked.
