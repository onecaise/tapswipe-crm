# Pre-app intake, MID-based residual import, overrides and reports: design memo

Status: **Revision 3, 28 Oct 2026. Decisions taken; phases 1-6 built locally (§10).** Nothing has
been run against dev or prod.

- Owen's decisions of 23 Oct 2026 are recorded in §0 and are binding. Where an older paragraph
  below says **Recommend**, §0 is what was decided.
- Owen's later answers of 28 Oct 2026 (§0c) close two §11 questions (deductions, the 50 cap).
- Owen's decisions of 28 Oct 2026 (§0b), taken from his real residual file and his current payout
  report, are also binding and **supersede §0 where they differ**: the split is a per-rep rate, not
  a constant 50, and the file has six columns. §11 lists the questions still open.
- §9 lists the remaining defaults this memo assumes. The ones marked **[CONFIRM]** affect money,
  security or what reps can see, and are waiting for Owen's confirmation.
- §8 is the 13-phase build plan, and §8.4 lists the CLAUDE.md rules each phase must change.

Inputs: Owen's requirements A-H (23 Oct 2026), `CLAUDE.md`, `docs/claude/*.md`,
`docs/design/residual-splits.md` (the shared-account memo, phases 1-8 built locally) and
`RESIDUALS_SPEC.md`. File and line references are to the tree at commit `122aa99`.

**Data.** Prod and dev were reset and hold no real pre-apps, merchants or payout rows, so no
change below needs a data backfill. Where one *would* be needed if real rows existed, the section
says so. Two cautions apply anyway:

- "No real data" is not "no rows". Dev may still hold seed rows from `seed-dev-*.mjs`. Every
  migration below that tightens a constraint therefore **checks that the table is empty, or that
  every row passes, and raises otherwise**. A project that turns out to hold rows then fails
  loudly instead of being quietly rewritten.
- The `NOT VALID` lesson in `docs/claude/merchant-location.md` still applies. A constraint that
  skips old rows is still enforced on their next UPDATE.

**The schema doc comes first, on every phase.** `docs/tapswipe_crm_schema.sql` is the spec, and
each phase in §8 edits it before the migration.

---

## 0. Owen's decisions (23 Oct 2026), binding

1. **Override is a percent of the FULL residual.** 10% of $100 is $10, taken out of the rep side.
   *(Cap and rep side restated by §0b.4-5: the rep side is the merchant's split rate, not 50.)*
   - The rep nets the merchant's rate minus the override, the recipient gets the override, and the
     company's share (residual minus the merchant's rate) never moves.
   - The percent is in 0.01 steps, `> 0`, and **no more than the merchant's split rate** (§0b.5).
     On a shared account the limit is the reps' combined share, which equals the merchant's rate
     (§0b.4).
   - It is admin-only, settable only once the pre-app is submitted, and audited.
   - The recipient defaults to the rep's manager (`profiles.manager_id`), and may otherwise be any
     named person.
   - On a shared account the deduction is divided between the two reps in their share ratio, using
     the existing cent rule (§4).
2. **Owners keep ONE address**, the home address (`home_*`), and it is required.
3. **EIN type is `'EIN'` or `'SSN'`.** Whichever is chosen, the number goes in the same encrypted
   tax-id field, with the same redaction and last-four rules (§5).
4. **Refusals and confirmations.**
   - These **refuse the whole import**, with no yes option, and list the MIDs:
     - a MID repeated within one file
     - a MID that is not a merchant in the CRM
   - These are **confirmable** (yes/no):
     - processor mismatch
     - inactive merchant
     - bad numbers: volume ≤ 0, or residual > volume. This is the only path by which a negative
       volume can enter.
   - Every confirmation is recomputed and enforced in the database at commit.
5. **Residuals are not editable after commit.** A fix is either a **replace** of that processor and
   month, allowed until the month is marked paid, or an **adjustment line** once it is paid.
6. **A rep cannot submit a pre-app until an admin has set the rep's legal name and LLC legal
   name.** Both fields go on the create-user screen, Manage Users, and the bulk user import.
7. **Every other recommendation stands**, including:
   - payee by MID
   - replace until Mark paid
   - one processor reference table
   - EIN as a fourth encrypted table, with the plain column dropped
   - one required-fields function used by both submit and the wizard
   - reports admin-only at `/admin/reports`, through normal access rules
   - rep identity on `profiles`, copied to the pre-app at submit

---

## 0b. Owen's decisions (28 Oct 2026), binding; from his real residual file and payout report

1. **File format: six columns, in this order:** `Processor`, `Merchant Number`, `Merchant Name`,
   `Income Type`, `Volume`, `Residual`. "Merchant Number" is the MID (earlier revisions called the
   column "MID"). The parser (phase 7) must:
   - read `Merchant Number` as **text, never as a number**. Real values are 11 to 12 digits, with
     different prefixes, and may carry leading zeros; a numeric read loses them, and a 12-digit
     value read through a float is not guaranteed to survive;
   - tolerate a leading apostrophe, a BOM, or stray whitespace on header cells;
   - accept currency formatting in `Volume` and `Residual`: `$76,877.18`, `-$11.76`, commas;
   - **refuse the whole file** if any row's `Income Type` is anything other than `Residuals`
     (case-insensitive), listing the offending rows;
   - compare the `Processor` column with the processor chosen on the upload page. A mismatch is a
     yes/no warning (`processor_mismatch`, as already decided in §0.4). Real files carry one of the
     five real processor names; Owen's sample uses a placeholder, so **tests use real names**.
2. **One merchant per MID.** Several MIDs can share one merchant name: a business with 7 locations is
   7 merchant records, each with its own MID. No schema change (§2.0).
3. **Warnings come in bulk.** Rows with zero volume and a small or negative residual are common
   (monthly fees, clawbacks). The yes/no confirmation is **one per warning type per import**, not
   per line. The commit still recomputes every warning in the database and refuses any type the
   admin did not confirm.
4. **A split rate replaces "fixed 50".**
   - Each rep profile has a rate: default 50, `CHECK` between 0 and 50, set **only** by a new
     admin-only, audited, `security definer` function `set_rep_split`, never by a direct update.
   - The **house profile** (agent code 122) has rate 0: the company keeps 100% of those merchants.
     Their lines are still produced, with a zero rep amount, so reports show the volume and net.
   - The rate is **copied onto the pre-app at submit and onto the merchant at approval** (a
     snapshot). Changing a rep's rate later does not change existing merchants.
   - An admin can change **one merchant's** rate through an audited function, refused while that
     merchant has an open share.
   - A shared account divides the **merchant's rate** between the two reps, with the existing cent
     rule. The company's share is the residual minus the merchant's rate.
5. **Override cap.** An override is a percent of the full residual, in 0.01 steps, and cannot exceed
   the **merchant's rate** (not always 50). Rep shares plus override equal exactly the merchant's
   rate.
6. **Phase impact.** Phase 4 gains the rate column, `set_rep_split`, and the copy to pre-app (and to
   merchant at approval). Phase 8 (commit) uses the merchant's rate. Phase 10 uses the new cap.
   Phase 12 reads rates. §8.1, §8.3 and §8.4 are updated to match.
7. **Report 1 columns:** agent code, legal name (the LLC name, or the rep's own legal name if no
   LLC), full name, sales volume, net residual, agent split, deductions (adjustments), override
   received, total agent commission. **Total commission is split plus override received.** Not
   included, because the file does not carry them: transactions, total income, total expense,
   gross, BPSR, rental, bonus (§7.2).

---

## 0c. Owen's answers (28 Oct 2026, later), binding

1. **Deductions on Report 1 are shown but NOT subtracted** from Total Agent Commission, which stays
   agent split + override received (§0b.7). The column is labelled so a reader cannot take it as
   part of the total: **"Deductions (info only, not in total)"**. Closes §11 Q4.
2. **50 is the maximum rep rate.** The 0-50 limit stays on the profile, pre-app and merchant rates
   and on the override's outer bound. Closes §11 Q2.

---

## Headline decisions (as decided)

1. **The payee is the merchant's owner, found by MID.** The file's MID resolves to
   `merchants.mid`, then to `merchants.agent_id`. Agent # leaves the import entirely.
   `profiles.agent_number` stays only as the rep's display "agent code".
2. **Any MID in the file that matches no merchant refuses the whole batch.** The batch stays in
   review with every unknown MID listed, and cannot be committed. Once the merchants exist, the
   admin presses "Read again"; the parser's idempotent re-read already supports this.
3. **The admin picks processor and month at upload.** One committed batch is allowed per
   (processor, month). A second upload for the same pair is a **replace**, done atomically by one
   RPC.
4. **A replace is allowed only until the month is marked paid.** After that it is refused, and
   corrections are made with adjustment lines.
5. **A repeated MID and an unknown MID each refuse the batch.** The three confirmable
   contradictions (processor mismatch, inactive merchant, bad numbers) are stored warnings that the
   admin must confirm. The commit RPC recomputes them and refuses any that were not confirmed. That
   makes "yes" enforced in the database, not just a dialog in the browser.
6. **The rep split is the merchant's split rate (§0b.4), and residuals are not editable after
   commit.** The rate is set per rep by an admin (`set_rep_split`, default 50, between 0 and 50),
   snapshotted onto the pre-app at submit and onto the merchant at approval, and read from the
   merchant at commit. It is removed from the pre-app wizard as an input. The file's Residual is
   the pre-split figure. Client UPDATE on `rep_payout_rows` is revoked entirely. A fix is a replace
   before the month is paid, or an adjustment after.
7. **Override, precisely.** An override is a percent of the **full residual `R`**, capped at the
   merchant's split rate (§0b.5), and taken out of the rep side. It is set per merchant by an admin, paid to a **named profile**
   (defaulting to the owner's `manager_id`), and effective by payout month.
   - The commit writes it as a pair of ledger lines: a debit on the rep(s) and a credit on the
     recipient.
   - On a shared account the debit is divided between signer and partner in their share ratio,
     using the same cent rule (`shared_part`).
8. **EIN moves to a fourth secrets table, `pre_app_tax_secrets`,** which holds an EIN or an SSN
   according to `ein_type`. It is handled through the existing two Edge Functions. Reps see the
   last four digits, and `submit_pre_app` checks that the row exists and matches the chosen type.
9. **Mandatory fields are enforced in the database and mirrored in the wizard.** A new definer
   function, `pre_app_missing_fields(id)`, returns every missing item at once. `submit_pre_app`
   refuses with that whole list, and the review step shows the same list by calling the same
   function.
10. **Rep identity lives on `profiles`.** Two new columns, `legal_name` and `llc_legal_name`, are
    set by an admin only, through a definer RPC, from the create-user screen, Manage Users or the
    bulk import. The pre-app snapshots them at submit, and submit is refused until both are set.
    The report reads agent code, legal name and rep name from `profiles`.
11. **One processor vocabulary everywhere.** It is a reference table, `processors`, referenced by
    foreign key from `pre_apps`, `merchants`, `rep_payout_batches` and `rep_payout_rows`.
12. **Reports are an admin-only page, `/admin/reports`.** It reads two `security invoker` SQL
    functions, so RLS still scopes every row.

---

## 1. What exists today, and what changes, item by item

### A. Pre-app mandatory before submit

**Today.** `submit_pre_app()` (latest `20261013132000_submit_pre_app_requires_location.sql`) is
`security definer` and refuses with PT422 in this order:

1. no DBA name
2. no legal business name
3. no usable city or two-letter state
4. no owner, or no owner with 51% or more
5. an owner without an SSN row in `pre_app_owner_secrets`
6. a card-mix pair that does not total 100, checked only when filled
7. no `pre_app_banking_secrets` row

It checks the secrets tables for **existence only** and never names an `*_encrypted` column. The
terminal secret (RP password) is deliberately not required.

The wizard mirrors this in `preAppSubmitBlockers()` (`lib/pre-apps.ts:393-464`), and
`tests/unit/pre-app-logic.test.ts:422` pins that the two lists agree. The zod step schemas
(`lib/pre-app-validation.ts`) require only DBA, legal name, city and state.

Fields that exist: everything in Owen's list has a column **except** the rep's LLC legal name and
the rep's actual name.
- Street is `pre_apps.physical_address`; there is no `street` column on pre-apps.
- The four volume columns came from `20260928143000`.
- Owners have exactly **one** address, the `home_*` columns (`home_address`, `home_city`,
  `home_state`, `home_country`, `home_zip`). **Decided (§0.2): that one address is the owner
  address, and it is required.** No new address columns.

**Changes.**
- Submit requires the full list: Owen's fields, every owner field, the SSN, the EIN in the secrets
  table, banking, and the two rep identity fields.
- The RP password stays optional.
- Details are in §6 and §7.

### B. Processor drop-down

**Today.** `merchants.processor` is the only processor column (`initial_schema.sql:56`). It is free
text, with no CHECK, entered as a plain `<Input>` (`components/merchant-form.tsx:359-365`). Pre-apps
have no processor column, and neither do batches or ledger lines. `approve_pre_app()` leaves the
merchant's `processor` and `mid` null.

**Changes.**
- New reference table `processors (code text primary key, label text not null, sort_order int)`,
  seeded with `TSYS`, `Red Fynn`, `PayBright`, `Netevia HQ` and `Square` (spellings to confirm, §9,
  Q1).
- `merchants.processor` becomes `references processors(code)`.
- New column `pre_apps.processor`, with the same FK. `approve_pre_app()` copies it to the
  merchant.
- `rep_payout_batches.processor` is `not null`, with the FK.
- `rep_payout_rows.processor` is a snapshot from the batch on import lines (§2).
- One `<Select>` component reads the table, so the list exists once.

Why a table rather than a CHECK: three CHECKs would be three copies of the list to keep in step,
the drift this repo keeps paying for. Adding a processor becomes one `insert` in a migration.

`processors` is reference data with no owner. Its access rules:
- RLS on.
- Policy `select using (true)` for `authenticated`, plus `grant select`.
- No write grant; rows are added by migration.
- Never anything for `anon`.

*Backfill if real data existed:* existing free-text `merchants.processor` values would have to be
mapped onto the five codes before the FK could be added. The migration checks and raises on any
non-matching value.

### C. Rep split from the rep's rate; overrides by admin after submit

**Today.**
- `pre_apps.split_agent_pct` and `split_company_pct` are `not null default 50`, with the CHECK
  `pre_apps_split_sums_to_100`. The rep **can edit them** on the Business step
  (`components/pre-app-steps/business-step.tsx:275-301`).
- `approve_pre_app()` copies both onto `merchants.split_*`. RESIDUALS_SPEC decision 14 says the
  payout never reads them.
- On the ledger, `rep_payout_rows.rep_split_pct` is **typed by an admin after commit**, through
  `PayoutFigureCell` or `PayoutBulkSplit`. `authenticated` holds column UPDATE on
  `residual_income` and `rep_split_pct` (`20261014160000`).
- There is no override concept anywhere.

**Changes** (rewritten by §0b.4; there is no constant 50).
- New `profiles.split_rate_pct numeric(5,2) not null default 50`, `CHECK` between 0 and 50. Set only
  by `set_rep_split(user_id, rate)`: `security definer`, pinned `search_path`, `is_admin()` first,
  audited `set_rep_split` in the same statement, failing closed, its own privilege lines. Built
  exactly like `set_rep_identity`. No UPDATE policy or grant on `profiles`; the column never
  appears in a policy. Manage Users shows it to admins only, as an inline cell.
- The **house profile** (agent code 122) is set to 0 by an admin after the migration. No rate is
  hard-coded in a migration.
- **Snapshot onto the pre-app at submit.** The existing `pre_apps.split_agent_pct` /
  `split_company_pct` become the snapshot: `submit_pre_app()` overwrites them with the rep's rate
  and `100 - rate`, so whatever a draft holds is irrelevant (the price-lock principle: the layer
  that cannot be skipped writes the value). The rep's split input leaves the wizard; the review
  step shows the rate read-only. `pre_apps` gains `CHECK (split_agent_pct between 0 and 50)`.
- **Snapshot onto the merchant at approval.** `approve_pre_app()` already copies both columns;
  `merchants` gains the same 0-50 CHECK in phase 8 (§10, phase 4 notes). A later `set_rep_split` changes no existing merchant.
- **Per-merchant change.** `set_merchant_split(merchant_id, rate)`: admin-only, audited, `security
  definer`, refused while the merchant has an open or future share (§2.5). The merchant form's
  split input goes, and client UPDATE on the two split columns is removed, so the function is the
  only write path. Built in phase 8.
- The commit writes `rep_split_pct = merchants.split_agent_pct` on every import line, including 0
  for house merchants (a line with a zero rep amount, kept so reports show volume and net).
- **Decided (§0.5):** client UPDATE on `rep_payout_rows` is removed altogether, for both
  `residual_income` and `rep_split_pct`.
  - The grant is revoked, and `PayoutBulkSplit` and `PayoutFigureCell` go.
  - "Reps cannot change it" is then true at the grant layer, which cannot be skipped.
  - Admins cannot change a committed line either. The split of future months moves only by
    `set_merchant_split` (or by a new merchant snapshotting a new rep rate); the override is the
    only lever inside a merchant's rate; replace or adjustment is the only lever on a residual.
- Overrides are new (§4).

### D. EIN encrypted and redacted

**Today.** EIN is **plaintext** in `pre_apps.ein_number`, with `ein_type` next to it, both free text
(`initial_schema.sql:176-177`). The rep and admins read it in full through RLS, and
`components/pre-app-summary.tsx:68` prints it on the detail page. The only validation is browser
side: `isEin`, `/^\d{2}-\d{7}$/`, in `lib/masks.ts:67`.

**Changes.** Covered in §5: a new `pre_app_tax_secrets` table, the column dropped, both Edge
Functions extended, and the presence check added.

### E. Visibility and edit rules for pre-apps

**Today.**
- **Edit rules, already correct.**
  - A rep edits only a **draft**. The parent trigger `pre_apps_guard_transitions` (latest
    `20260916104500`) refuses a non-admin edit of a non-draft.
  - The children are frozen the same way by `pre_app_children_guard()` (`20261021130000`).
  - Secrets writes are frozen by `submit-pre-app-secrets`, which returns 409 for a non-admin on a
    non-draft.
  - An admin may edit everything except `status`, at any status.
- **Visibility, incomplete.** `PreAppSummary` shows the same fields to rep and admin, but leaves out
  many of them:
  - business: `ein_type`, `state_incorporated`, `business_type`, `sub_business_type`, `country`,
    `fax`
  - owners: the ID fields, the full home address, `length_of_ownership`
  - card mix: `test_product_type` and the profile notes
- The detail page shows no secret at all. Plaintext appears only inside the wizard's Sensitive data
  step, and only for an admin; this is follow-up "Admins see full SSNs … as soon as the step opens"
  in `docs/claude/security-followups.md`.

**Changes.**
- `PreAppSummary` shows **every** stored field to both roles.
- A new "Sensitive data" section on the detail page:
  - rep: `SSN ···1234`, `EIN ···6789`, `Routing ···0021`, `Account ···4410`, `RP password: on
    file`
  - admin: the same masked view, plus a per-field **Show** that calls `read-pre-app-secrets` with
    `reveal`
- **Recommend** building the reveal from that follow-up at the same time. Reveals are audited as
  `read_pre_app_secrets:reveal:<field>`, and the default read for everyone becomes last-four, so
  admins stop getting plaintext on mount.
- No edit-rule change is needed. A test pins the rule as it stands.
- One gap to state plainly: an admin's edit to an **approved** pre-app does not reach the merchant.
  The merchant is a copy made at approval. That is unchanged and recorded in §9 (A12).

### F. Residual import landing page and confirmations

**Today.**
- `/payouts/import` (`components/residual-upload.tsx`) has **one input, the file**.
- The month comes from each row's `Period` cell, so one file may span several months
  (RESIDUALS_SPEC decision 27).
- Batches have no `period` and no `processor` column, and nothing stops two committed batches for
  the same month.
- Re-uploading a month **merges** through the coalesce upsert.
- The review screen's blockers are `missing_mid`, `unparseable_period`, `unknown_agent`,
  `bad_number` and `duplicate_in_file`. The last is keyed on (period, Agent #, MID), so the same
  MID under two Agent #s is *not* a duplicate.
- The five preview flags are advisory.

**Changes.**
- Landing inputs: Processor (select), Month (select), Year (select or number), and File.
- Replace prompt (§3).
- Two whole-batch refusals, for a repeated MID and an unknown MID, plus three confirmable warnings
  (§2.4).

### G. New file format

**Today.**
- Required headers: `Period`, `Agent #`, `MID`, `Merchant name`, `Volume`, `Average ticket`,
  `Total cost`.
- Optional: `Residual income`, `Rep split` and `Line`.
- There is no alias list, by design.
- `Residual income` is the **net** figure; `Rep split` is the round trip of what an admin typed.

**Changes** (as decided, §0b.1). Owen's real file has exactly six columns, in this order:

| Column | Read as | Use |
| --- | --- | --- |
| `Processor` | text | Compared with the processor chosen at upload; a difference is the `processor_mismatch` warning. |
| `Merchant Number` | **text, never a number** | The MID. 11 to 12 digits, different prefixes, leading zeros possible. |
| `Merchant Name` | text | Kept raw on the staging row for the review screen ("file says *Joe's Pizza*, CRM says *Joe's Pizza LLC*"). The ledger's `merchant_name` comes from the CRM merchant's `dba`. |
| `Income Type` | text | Must be `Residuals` (case-insensitive, trimmed) on every row, or the whole file is refused (`wrong_income_type`), listing the rows. |
| `Volume` | currency | `$76,877.18`, `-$11.76`, plain numbers, commas. |
| `Residual` | currency | As Volume. The pre-split figure. |

- All six are required headers. Header cells are matched case- and space-insensitively after
  stripping a leading BOM, a leading apostrophe (Excel's text marker) and surrounding whitespace.
- The `Merchant Number` cell is read from the sheet's **formatted text** (SheetJS `w`, or `raw:
  false`), never its numeric value, so `012345678901` keeps its zero. A cell that is not all digits
  after trimming (and stripping a leading apostrophe) is `missing_mid` / unreadable.
- A missing `Residual` or `Volume` **cell** is a blocker, `missing_figure`. Today's blank-means-null
  rule would otherwise commit a line with no payout.
- The export's round trip ends (§2.6).

### H. Reports page

**Today.** There is no reports page. `app/(app)/admin` holds `bug-reports`, `merchants`, `products`
and `users`. The nearest things are `/payouts` (`summarizeByPeriod` over all lines) and the per-rep
statement at `/payouts/[period]/summary/[agentId]`.

**Changes.** New `/admin/reports`, with `requireAdmin()` and an Admin nav item, holding two reports
(§7.2).

---

## 2. Residual import redesign

### 2.1 The old rule and everything that depends on it

The old rule: **the ledger rep is whoever the file's Agent # resolves to, through
`profiles.agent_number`.** The CRM owner is "not a signal" (`_shared/residuals.ts:775-776`), and the
commit never re-resolves `r.agent_id`.

| Piece | Where | Fate |
| --- | --- | --- |
| Header set incl. `Period`, `Agent #`, `Average ticket`, `Total cost`, `Rep split`, `Line` | `_shared/residuals.ts:24-94` | **Rebuilt.** The six new headers (§1.G, §0b.1). |
| `parsePeriodCell` (per-row month) | `residuals.ts:348-406` | **Removed from the import path.** The month comes from the batch. The function can stay for tests, or be deleted. |
| Blocker `unknown_agent` plus the Agent # lookup | `parse-residual-import/index.ts:179-210, 396-401` | **Removed.** |
| "Unrecognised agent numbers" UI: Assign to a rep / Create the rep | `/payouts/import/[batchId]/page.tsx:221-279`, `reviewImportRows` grouping in `lib/payouts.ts:542-602`, `FIXABLE_BLOCKER` | **Removed.** Replaced by the unknown-MID list (§2.4). |
| `duplicate_in_file` keyed on period, Agent # and MID | `residuals.ts:541-551` | **Rebuilt** as the blocker `duplicate_mid`, keyed on MID alone (the month is fixed). It refuses the batch (§0.4). |
| `unparseable_period` | parser | **Removed.** Replaced by validating the batch's own month at upload. |
| MID lookup (`merchants.select("id, mid")`) | `parse-residual-import/index.ts:212-225` | **Kept and widened** to `id, mid, agent_id, status, processor, dba`. It is now the payee lookup. |
| `previewSharedRow` / `previewUnsharedRow` and the five `preview_flag` values | `residuals.ts:632-871`, CHECK in `20261016161000:109-113` | Each flag is decided below. |
| ↳ `partner_named` | | **Removed.** The file names no rep, so it cannot name the partner. |
| ↳ `share_not_applied` | | **Removed.** The payee is the owner, and the share's signer must *be* the owner (§2.5). |
| ↳ `line_not_shared` | | **Removed.** Its trigger was a non-share line already on the pair's key for that month. Under one committed batch per (processor, month), and replace deleting that batch's lines first, no import line can be there unless it came from **another processor's** batch, which is the blocker `mid_in_other_batch` (§2.4). |
| ↳ `looks_shared` (another rep paid on the MID in the last 6 months) | | **Removed as a share heuristic.** Optionally **repurposed** as the informational `payee_changed`: "last month this MID paid Ann Ito; this month it pays Bo Lee, the merchant's current owner". That catches a merchant reassignment nobody meant to affect payouts. Not in Owen's list, so it is offered rather than assumed (§9, A10). |
| ↳ `share_not_in_force` | | **Kept, informational.** The MID has shares, but none covers this month. |
| `skipped_rows`, `skips_acknowledged_at`, `acknowledge_residual_skips()`, `ResidualSkipsNotice` | `20261016120000`, `20261016140000` | **Kept in the schema, no longer written.** Nothing is skipped any more: every row is either refused or committed. The columns stay so the code that reads them keeps working, and the new commit writes `'[]'`. **Recommend** removing the UI in the cleanup phase. Dropping the columns is optional, since there is no hosted data. |
| `adjustment_rows_ignored`, `isAdjustmentLine`, the `Line` column | `residuals.ts:88-90, 494-501` | **Removed from the parser.** The export is no longer an import format (§2.6), so there is no round trip to protect. The column on batches stays and is written as 0. |
| Merge key `rep_payout_rows_import_merge_key` (period, agent_id, mid) where import | `20261016160000:108-110` | **Rebuilt** as (period, processor, agent_id, mid) where import. Every `on conflict` still says `where line_kind = 'import'`. |
| Coalesce merge rule `coalesce(excluded.<col>, rep_payout_rows.<col>)` | both commits | **Retired with the merge.** First import of a (processor, month) is a plain insert, and a second is a replace (§3). Nothing hand-entered exists to preserve, because residual and split now come from the file and the merchant's rate. **This removes a rule CLAUDE.md calls binding**, so the phase that does it must also edit CLAUDE.md and `payouts-and-teardown.md`. The test that greps for the coalesce moves with the retired functions. |
| `commit_residual_import(int)` (old, **on prod**) | `20261016160000:131-244` | **Dropped** once the new app is deployed on both projects. Same condition as residual-splits §5.1, which is unchanged. |
| `commit_residual_import_v2(int)` (**on no hosted project**) | `20261016160000:246-454` | **Dropped in the same migration that adds v3.** No deployed app calls it: nothing from `20261014120000` on is hosted. |
| `set_shared_residual()` + `SharedResidualControl` | `20261014140000:338-402` | **Retired** in phase 11. The file supplies the residual, so the commit writes `account_residual_income` and both pieces. |
| `PayoutFigureCell` (residual and split) and `PayoutBulkSplit` | components | **Retired** in phase 11 (§0.5). The `residual_income` / `rep_split_pct` UPDATE grant is revoked in the same phase. A correction is a replace before paid, or an adjustment after. |
| `guard_shared_line()`, `copy_signer_rate` triggers | `20261014140000:251-330` | **Kept.** They become backstops with no normal client path. |
| `post_share_correction()` and the adjustment lines | `20261019130000` | **Kept, unchanged.** Still the only way to correct a paid month. |
| `export-residuals` | `index.ts:159-175` | **Kept as a download, header changed** (§2.6). Still caller-scoped, still never `supabaseAdmin`. |
| Period delete (`payout-period-delete.tsx`) | client `DELETE … eq(period)` | **Replaced** by an RPC (§3.4). **Existing defect:** it writes no `audit_log` row, though `20260817102000:328` and the schema doc say it does. |
| Tests and fixtures | §8.3 | Estimate in §8.3. |

### 2.0 Data model: one merchant per MID

A merchant record has exactly one MID (`merchants.mid`, unique where set), and the import resolves
each file row by MID alone. **Several MIDs may share one merchant name**: a business with 7
locations is 7 merchant records, one per MID, each with its own owner, processor and split rate.
Nothing groups them, and nothing needs to: the payee, the rate and any override are per MID. No
schema change (§0b.2). Report 2 is therefore one row per MID; two rows with the same DBA are two
locations, not a duplicate.

### 2.2 New flow

1. **Upload screen.** The admin chooses processor, month and year, and picks the file.
   - The browser calls `residual-import-file-url` with
     `{file_name, processor, period: 'YYYY-MM-01'}`.
   - The function validates the processor against `processors` and the period. The period must be
     the 1st of a month, not in the future, and in 2000-2100. **Recommend** also refusing anything
     more than 24 months back (§9, A11).
   - It then checks `rep_payout_batches` for a **committed** batch on (processor, period).
     - If one exists, the response is `{exists: {batch_id, committed_at, paid}}` and **no batch is
       created**.
     - The browser asks: "TSYS for July 2026 was imported on 4 Aug. Replace it? Yes / No".
     - On No, nothing happens. On Yes, it calls again with `replace_batch_id`. If that month is
       marked paid, the function refuses outright and the dialog says so (§3).
   - Otherwise it creates the batch with `processor`, `period` and `replaces_batch_id`, and signs
     the upload, as today.
2. **Parse** (`parse-residual-import`, still idempotent, still admin-only, still first sheet only):
   - Read the six headers (§1.G). Refuse the whole file if any row's `Income Type` is not
     `Residuals`, listing the rows. Read `Merchant Number` as text and resolve it against
     `merchants.mid`.
   - Stage one row per file row, with:
     - `merchant_id` and `agent_id`, both from the merchant
     - `volume` and `residual_income`, parsed from currency text
     - `merchant_name_raw`, `processor_raw` and `income_type_raw`
     - `blocker`
     - `warnings text[]`, a new column
     - `preview_flag` / `preview_note`, for the informational flags
3. **Review screen.**
   - Blocked rows, starting with unknown or repeated MIDs, mean **Commit is disabled**, with the
     list and "Read again".
   - Otherwise, **one confirmation block per warning type present in the import** (never one per
     line, §0b.3), each listing its rows (collapsed past the first few, since zero-volume fee and
     clawback rows are common), with **Yes / No** buttons.
   - Commit is enabled only when every type present has a Yes. A No on any type means the admin
     abandons the batch or fixes the data and reads again.
4. **Commit**: `commit_residual_import_v3(batch_id_input int, confirmed_input text[])`
   (§2.3).

### 2.3 `commit_residual_import_v3`

`security definer`, `set search_path = public, pg_temp`, `is_admin()` first, batch `for update`,
and the same `pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'))` as today, so share
and override edits cannot interleave with a commit. Its own `revoke` / `grant execute` lines.

1. **Guards as v2.** Status must be `review`, the batch must have rows, and no row may be blocked.
2. **Re-resolve the payee at commit; the preview is advisory.** Join the staged rows to
   `merchants` by `mid_raw`.
   - If a staged `merchant_id` no longer matches, or `agent_id` is no longer the merchant's
     `agent_id`, refuse PT409: "A merchant's MID or owner changed after this file was read. Read it
     again."
   - This also closes the security follow-up "Block a staged residual row whose merchant's MID
     changed".
3. **Recompute the warnings** from current data.
   - If the set of warning **types** present is not a subset of `confirmed_input`, refuse PT409,
     naming the unconfirmed types. A warning that appeared after the review cannot be committed
     on an old "yes". Confirmation is per type per import, so one "yes" covers every row of that
     type, but every row is still recomputed (§0b.3).
   - Store `confirmed_warnings` (jsonb: classes and the row numbers each covered) on the batch.
4. **Replace.** If `replaces_batch_id` is set, run the replace steps in §3.2 first, in the same
   transaction.
5. **Write the lines.**
   - **Unshared** row: an insert with:
     - `agent_id` = owner, `mid`, `merchant_id`, `merchant_name` = `merchants.dba`
     - `processor` = batch processor, `period` = batch period
     - `volume`, `residual_income` = file Residual,
       `rep_split_pct = merchants.split_agent_pct` (the merchant's rate, §0b.4; 0 for a house
       merchant, which still gets its line)
     - `batch_id`, `line_kind = 'import'`
   - A repeated MID never reaches this step: `duplicate_mid` blocks the batch (§0.4). v3 re-checks
     it as a guard, and refuses PT409 if it is present.
   - **Shared** row, where a share covers the batch month: signer and partner lines as v2 builds
     them, with two changes. `account_residual_income` = the file Residual, and both
     `residual_income` pieces come from `shared_part`, **at commit**. v2 left these null and waited
     for `set_shared_residual`. And the two shares divide the **merchant's rate**, not 50 (§2.5).
     Volume stays on the signer line only.
6. **Override lines** for every override active in the batch month on a committed merchant (§4.5).
7. Delete the staging rows and set the status to `committed`, with `committed_at`,
   `row_count = written`, `skipped_rows = '[]'`. Write the audit row
   `commit_residual_import` (`rep_payout_batches`, batch id). On a replace, also write
   `replace_residual_import` (§3.2). Both fail closed.
8. Return `{written, overrides, replaced_lines}`.

### 2.4 The refusals and the three confirmations (as decided, §0.4)

| Code | Kind | Rule | On Yes |
| --- | --- | --- | --- |
| `unknown_mid` | **Blocker; refuses the batch** | `mid_raw` matches no `merchants.mid` (exact text after trim, as today's lookup). | Not confirmable. The review screen's red Callout at the top: "This import is refused. 3 MIDs are not merchants in the CRM: 4400…, 4401…, 4402…. Add them (or correct their MID), then Read again." The screen is the alert (§9, A9). |
| `duplicate_mid` | **Blocker; refuses the batch** | The same MID appears on more than one row of the file. | Not confirmable. The Callout lists each repeated MID with its sheet rows: "MID 4400… appears on rows 7 and 31. Fix the file and upload it again." |
| `mid_in_other_batch` | **Blocker** | That MID already has an import line for this month from a *different* processor's committed batch. | Not confirmable. Two processors cannot both pay one MID in one month without double payment, so the admin resolves which file is wrong. |
| `wrong_income_type` | **Blocker; refuses the file** | A row's `Income Type` is not `Residuals` (case-insensitive, trimmed) (§0b.1). | Not confirmable. The Callout lists the rows and what each says. |
| `missing_mid`, `missing_figure`, `unreadable_number` | Blockers | As today, plus a blank Volume or Residual. `unreadable_number` is today's `bad_number`, renamed so that "bad numbers" means only the confirmable warning below. Currency text (`$76,877.18`, `-$11.76`) is readable; anything else is not. | Not confirmable. |
| `processor_mismatch` | Warning | The row's `Processor` cell differs from the batch processor (§0b.1), **or** `merchants.processor` is set and differs from it. **A merchant with no processor is not a mismatch** (§9, A6). | The lines are recorded under the **batch's** processor. The merchant's processor is not changed automatically; the review screen links to the merchant. |
| `inactive_merchant` | Warning | `merchants.status = 'inactive'`. `'other'` does not trigger it. | Paid to the owner as normal. |
| `bad_numbers` | Warning | `volume <= 0`, or `residual > volume`. Common on real files: zero-volume rows with a small or negative residual are monthly fees and clawbacks (§0b.3), so one "yes" per import covers them all. | Imported as read. **Needs a schema change:** `rep_payout_rows_volume_check` (`volume >= 0`) would refuse a negative volume. It becomes `volume >= 0 or volume_confirmed_negative`, where `volume_confirmed_negative` is a boolean only v3 sets, and only for a row whose `bad_numbers` warning was confirmed. So a negative volume can enter **only** through this path (§0.4), and the column records which lines did. |

The warning codes live in a CHECKed vocabulary on `rep_payout_import_rows.warnings` (each element
`in (…)`, enforced by a trigger or a CHECK over `array <@`). The rule for each lives **once**, in
`_shared/residuals.ts`, and the SQL in v3 recomputes the same three warnings and two refusals. The pair is pinned the way
`previewSharedRow` / v2 is today: a live test runs one file through parse, then commit, and requires
the warnings the parser stored to equal the set v3 demands.

### 2.5 Shared accounts under the owner rule

The share feature keeps working. Signer and partner divide **the merchant's split rate** (§0b.4) in
the admin's ratio, the cent rule still holds, and the partner still gets no merchant access.
`merchant_rep_shares`' CHECK `primary_rep_pct + secondary_rep_pct = 50.00` becomes "equals the
merchant's `split_agent_pct`": a CHECK cannot read `merchants`, so `set_merchant_rep_share()`
enforces it and the CHECK is relaxed to `<= 50` (phase 8). It holds over time because
`set_merchant_split` is refused while a share is open or future. A house merchant (rate 0) cannot
be shared. One invariant becomes mandatory, because "the rep the file names" no longer exists:

> **A share's signer is the merchant's owner.** `primary_agent_id = merchants.agent_id` for every
> month the share covers.

- `set_merchant_rep_share()` adds a guard: `primary_agent_id_input` must equal the merchant's
  current `agent_id`. The partner is any other active rep.
- A merchant **owner change** while a share is open or starts in the future is refused by a
  `BEFORE UPDATE OF agent_id` trigger on `merchants`: PT409, "This merchant has a shared-account
  split. End it before moving the merchant." The admin ends the share, moves the merchant, and
  sets a new share if one is wanted.
- v3 still checks `s.primary_agent_id = m.agent_id` per row, and refuses PT409 on a mismatch, as a
  backstop for rows that predate the trigger.
- What v3 does with a shared MID, given the file has no rep: it always builds the signer and
  partner pair. `partner_named` and `share_not_applied` become impossible by construction.

How shares combine with overrides is in §4.4.

### 2.6 Export after the redesign

- The export stays a download of the caller's own lines; RLS scopes it, never the service role.
- New header: `Period, Processor, Agent #, Agent, MID, Merchant name, Volume, Residual, Rep split,
  Rep payout, Line, Account share`. `Line` gains `Override`.
- **It is no longer importable**, because the import requires `Processor, Merchant Number, Merchant
  Name, Income Type, Volume, Residual`.
- **Recommend** the parser refuse a file carrying `Agent #` or `Rep payout` with "This looks like a
  CRM export, not a processor file". An exported sheet then cannot be re-imported by mistake with
  each shared account's volume counted once per rep.

---

## 3. Replacing a committed processor/month

### 3.1 The risk, plainly

A committed month is money owed, and possibly money already sent. Replacing it rewrites what each
rep is owed.

- **Before payment**, that is exactly what Owen wants: the processor sent a corrected file.
- **After payment**, a replace silently makes the CRM disagree with the bank. A rep paid $412 on
  the 5th would see $380 on their statement, with nothing recording that $32 is owed back.
- The replace also reaches three dependent things:
  - shared lines, which are regenerated
  - override lines, which are regenerated
  - share **corrections** posted in later months, computed from the old figures. Those would stay
    and be wrong.

The ledger has no "paid" state today, so the CRM cannot currently tell the two cases apart. That is
the gap to close first.

### 3.2 Recommendation: replace allowed until the month is marked paid

**New table `payout_period_closures`:** `period date`, `processor text references processors`,
`closed_at`, plus `primary key (period, processor)`.
- There is no `closed_by` column. The actor is in `audit_log`, which keeps the `profiles` FK count
  at 25.
- RLS: admin select; no client write.
- It is written only by `close_payout_period(period, processor)`: definer, `is_admin()` first,
  audited `close_payout_period`, failing closed. Its own privilege lines.
- **Decided (A8, 23 Oct 2026): an admin-only reopen, with a written reason, audited.**
  `reopen_payout_period(period, processor, reason_input text)` is `security definer`, `is_admin()`
  first, refuses a blank reason, deletes the closure row, and writes `audit_log`
  (`reopen_payout_period`), failing closed. The reason is kept on a
  `payout_period_reopenings(period, processor, reason, reopened_at)` row, because `audit_log` has no
  detail column. The UI asks for the reason in a text box; "Mark paid" keeps its typed
  confirmation. Built in phase 9.

**Replace,** inside v3, under the batch lock and the share lock:

1. Refuse PT409 if `(period, processor)` is in `payout_period_closures`: "July 2026 TSYS is marked
   paid and cannot be replaced. Post an adjustment instead."
2. Refuse PT409 if any `line_kind = 'adjustment'` line has `adjusts_period = period` on any MID the
   old batch paid. The admin must deal with that correction first, because its amount was computed
   from the old payout.
3. Delete every line with `batch_id = old batch` (import lines and that batch's override lines),
   **and nothing else**.
   - Not adjustments: they carry no batch.
   - Not other processors' lines for the month.
4. Set the old batch to the new status **`replaced`**. The CHECK on `status` widens, and
   `guard_batch_status_transition` still admits only `review -> abandoned` for clients; definer
   writes are unaffected. Record `replaced_by_batch_id` on it. Its file stays in the
   `residual-imports` bucket as evidence.
5. Insert the new lines (§2.3 step 5), then the override lines (step 6).
6. Write the audit row `replace_residual_import` with `row_id = old batch id`, alongside the
   commit's own row for the new batch.

What happens to each dependent piece:

| Thing | On replace |
| --- | --- |
| Shares (`merchant_rep_shares`) | **Untouched.** Shared lines are rebuilt from the new file with the same share. `set_merchant_rep_share`'s "latest committed month" rule reads import lines, which exist again after step 5, so the share boundaries stay valid. |
| Share corrections (adjustments) | Refused by step 2 if one adjusts this month. Ones that adjust *other* months are unaffected. |
| `rep_payout_row_history` | Gets **no** rows. History records field edits, and a replace is a delete plus an insert. The trail is the two audit rows plus the old batch row, which keeps its file and is now `replaced`. **Recommend** also writing a per-line before/after summary into the new batch's `replace_summary jsonb`: lines removed, lines added, payout before and after per rep. The admin sees the effect, and it outlives the screen. |
| Anything paid | Impossible by step 1. That is the reason for the closure table. |

### 3.3 What to offer after a month is paid

- An **adjustment** through the existing `line_kind = 'adjustment'` path.
- Today only `post_share_correction` writes adjustments. **Recommend** a general
  `post_payout_adjustment(agent_id, mid, adjusts_period, amount, note)`: definer, admin, audited,
  posting in the open month the way `share_correction_posting_period()` computes it. That covers
  "the processor corrected July after we paid".
- Because §0.5 makes the adjustment line the only fix after payment, this is **built in phase 9**,
  before the first real import (§9, A23).

### 3.4 Period delete

- Replace the client `DELETE` with `delete_payout_period(period, processor)`: definer, admin,
  refused when the month is closed, refused when adjustments target it, and audited.
- Revoke `delete` on `rep_payout_rows` from `authenticated`, and drop the "admin only delete"
  policy.
- This fixes the missing-audit defect in §2.1, and stops a paid month being deleted from the
  browser.

---

## 4. Overrides (as decided, §0.1)

### 4.1 Definition

An override is a **percent of the full account residual `R`**, taken out of the rep side. With the
merchant's split rate `s` (§0b.4, `merchants.split_agent_pct`, 0-50), rep side
`T = round_half_away(R × s / 100)` and override percent `o`:

| Example: R = $100, s = 50, o = 10 | Amount |
| --- | --- |
| Rep side T | $50.00 |
| Override X | **$10.00**, paid to the recipient |
| Rep nets | $40.00 |
| Company | $50.00 (R − T), unchanged |

The rules:

- **`0 < o ≤ s`, in 0.01 steps** (`numeric(5,2)`), §0b.5. `o = s` sends the whole rep side to the
  recipient and leaves the rep zero, never negative. A house merchant (`s = 0`) cannot carry an
  override.
- The table CHECK stays `override_pct > 0 and override_pct <= 50` (the widest any rate can be). The
  per-merchant cap `o ≤ s` cannot be a CHECK, because it reads `merchants`, so
  `set_merchant_override()` enforces it, and `set_merchant_split()` refuses a new rate below an open
  or future override's percent (assumed, §9 A29). v3 re-checks `o ≤ s` per row and refuses PT409
  as a backstop.
- On a shared account, the cap is the reps' **combined** share, which equals `s` (§2.5). Rep shares
  plus override equal exactly `s`.
- **Recipient:** a named active profile. It defaults to the owner's `profiles.manager_id`,
  prefilled in the form but editable. It may not be a party to the account: refusing the owner or
  either share party keeps the arithmetic meaningful.
  - `manager_id` stays a reporting label. Nothing here makes it an access path; no policy reads it.
- An override paid outside the CRM, with no recipient, is not supported (§9, A4f).

### 4.2 Storage

```sql
create table merchant_overrides (
  id serial primary key,
  merchant_id  int  not null references merchants(id) on delete restrict,
  recipient_id uuid not null references profiles(id),          -- 26th profiles FK
  -- % of the FULL residual, taken from the rep side. <= 50 because no split rate exceeds 50
  -- (profiles/pre_apps/merchants CHECKs). The real cap, <= the merchant's split_agent_pct, is
  -- enforced by set_merchant_override() and re-checked by commit v3. Move together.
  override_pct numeric(5,2) not null check (override_pct > 0 and override_pct <= 50),
  effective_from date not null check (extract(day from effective_from) = 1),
  effective_to   date check (effective_to is null or (extract(day from effective_to) = 1
                                                      and effective_to > effective_from)),
  created_at timestamptz not null default now(),
  exclude using gist (merchant_id with =, daterange(effective_from, effective_to) with &&)
);
```

- Like `merchant_rep_shares`:
  - no `agent_id` and no `created_by`; the actor is in `audit_log`
  - RLS on, select `is_admin()`
  - `grant select` to `authenticated`, `all` to `service_role`
  - no client write
- **At most one override per merchant per month** (the exclusion; §9, A4e).
- `recipient_id` makes **26** `profiles` FKs. `tests/rls/user-imports.test.ts` asserts the count by
  name, and **all four teardown lists** gain `merchant_overrides`.
- New `rep_payout_rows` columns:
  - `override_id int references merchant_overrides(id) on delete restrict`
  - `override_amount numeric(14,2)`
  - `override_role text check (override_role in ('debit','credit'))`
- `line_kind` widens to `('import','adjustment','override')`.
- `rep_payout` gains `when line_kind = 'override' then override_amount`. That is a rewrite of the
  generated column, done version-independently by drop and re-add, under the migration's own
  before/after check (the residual-splits §3.3 precedent).
- CHECKs:
  - the override columns are set only on override lines
  - an override line carries no residual, rate or volume
  - a debit line's `agent_id` is never the override's `recipient_id`
  - The signs (debit = −credit, summed per `batch_id` + `override_id`) are the function's job,
    asserted by tests. A CHECK cannot see the other row.

### 4.3 Who, when, audit

- **RPCs** (all `security definer`, `is_admin()` first, the share lock, audited, failing closed,
  with their own privilege lines):
  - `set_merchant_override(merchant_id, recipient_id, pct, effective_from)`
  - `end_merchant_override(id, effective_to)`
  - `cancel_merchant_override(id)`, allowed only if no line references it
- **Only after the pre-app is submitted.** The override is stored on the merchant.
  - A merchant exists only after `approve_pre_app()`, which requires a submitted pre-app.
  - As an explicit guard, `set_merchant_override` also refuses a merchant whose `pre_app_id`
    points at a pre-app not in `submitted`/`approved`.
  - Merchants an admin creates without a pre-app are allowed.
  - Whether it must also be settable between submit and approval is assumption A4b in §9.
- **Month rule, copied from shares.** `effective_from` and `effective_to` must be later than the
  latest month committed for that MID. Re-committing a month, by replace, therefore reproduces the
  same overrides. A back-dated override is not possible. An override agreed for a month already
  committed is an adjustment line (§3.3).
- Reps never write any of it.
- The rep's statement shows their own debit lines: "Override 10% of residual · −$10.00 · to Dana
  Cole" (§9, A4c **[CONFIRM]**).
- The recipient sees the credit line with the merchant name as **plain text**, never a link, and
  gets no merchant access. That is the partner rule exactly.
- The names cross books, so they come through a narrow definer read function shaped like
  `my_share_partners()`: key absence, `is_active_agent()` first. **No policy changes.**

### 4.4 How it combines with a shared account (exact)

For a merchant in month M:
- `R` is the file residual
- `s` is the merchant's split rate, `0 ≤ s ≤ 50`
- `T = round_half_away(R × s / 100)` is the rep side, today's `rep_payout` expression with
  `rep_split_pct = s`
- `o` is the override percent, with `o ≤ s`

1. **Override total.** `X = round_half_away(R × o / 100)` in cents. Because `o ≤ s` and the
   rounding is monotone and odd, `|X| ≤ |T|`, and `X` has the sign of `R`. In a clawback month
   (`R < 0`) the recipient gives back their cut in the same proportion.
2. **Unshared:** one debit line on the owner, `−X`, and one credit line on the recipient, `+X`.
   The owner nets `T − X`.
3. **Shared** (signer `a`, partner `b`, `a + b = s`):
   - The debit is divided the way the payout is: `x_p = shared_part(X, b, s)` and `x_s = X − x_p`.
   - So the signer has a debit of `−x_s`, the partner a debit of `−x_p`, and the recipient one
     credit of `+X`.
   - The signer absorbs the odd cent, as in residual-splits §4.
4. **Invariants**, tested exhaustively the way `shared_part` is: every R from −$100 to $100 by the
   cent, × s ∈ {50, 46, 30, 0.01}, × o ∈ {0.01, 5, 10, 33.33, 49.99, 50} where `o ≤ s`, × the
   splits of `s` (for 50: 25+25, 40+10, 0.01+49.99). Each assertion is shown non-vacuous by
   reverting the formula.
   - signer net + partner net + recipient credit = `T` exactly, so the company's `R − T` never
     moves
   - debits + credit = 0
   - `f(−R) = −f(R)`
   - `o = s` gives the rep side exactly zero net
   - no rep's net has the opposite sign to their own share of `T`
5. The override lines carry the batch's `batch_id`, so a replace deletes and rebuilds them with the
   import lines (§3.2 step 3).

### 4.5 How the report computes "amount subtracted"

For rep `P` and month `M`:

| Report column | Computation |
| --- | --- |
| Earned after split | `sum(rep_payout)` over `P`'s **import** lines, for both unshared lines and either side of a share. Each line used its merchant's rate (§0b.4); a house merchant's line contributes 0. |
| Override on their accounts, and the $ subtracted | `−sum(override_amount)` over `P`'s **debit** override lines, with the percent, merchant and recipient in a detail row. |
| **Agent split** (Report 1) | Earned after split minus the override subtracted: what `P` keeps from their own merchants. |
| Overrides received | `sum(override_amount)` over `P`'s **credit** lines (§0b.7: a Report 1 column). |
| Deductions (adjustments), for information | `sum(rep_payout)` over `P`'s adjustment lines posted in `M`. **Shown, not subtracted** (§0c.1). |
| **Total agent commission** | **Agent split + overrides received** (§0b.7). Deductions are **not** subtracted (§0c.1): they sit in their own column, labelled as not included in the total, and a test pins that `total + deductions = sum(rep_payout)` over every line `P` has in `M`, so the report and the statement reconcile on the screen. |

---

## 5. EIN (or SSN tax id) into the encrypted secrets flow

**Now:** `pre_apps.ein_number` (plaintext text) and `pre_apps.ein_type` (free text). They are
entered on the Business step (`business-step.tsx:239-252`), autosaved by PATCH, shown in plaintext
on the detail page, and validated only in the browser.

**New storage.** A fourth table:

```sql
create table pre_app_tax_secrets (
  id serial primary key,
  pre_app_id int not null unique references pre_apps(id) on delete cascade,
  -- Which identifier the ciphertext holds (§0.3). Written by the function from the value's
  -- own validator, never by a client. Plaintext: it says what the number is, not what it is.
  tax_id_type text not null check (tax_id_type in ('EIN', 'SSN')),
  tax_id_encrypted bytea not null,
  key_version smallint not null default 1
);
alter table pre_app_tax_secrets enable row level security;
-- ZERO policies. ZERO grants to anon/authenticated. grant all to service_role.
```

- **Why not a column on `pre_app_banking_secrets`:** that row is written as a routing and account
  pair, with both `not null`. An EIN entered before the bank details would need a half-row, or
  nullable ciphertext columns. A separate table keeps each secret's existence as simple as one row,
  which is what the presence check reads.
- **`ein_type` stays plaintext** on `pre_apps`, and becomes `check (ein_type in ('EIN', 'SSN'))`
  (§0.3). It describes the identifier, not the number, and it is required at submit.
- **When `ein_type = 'SSN'`**, the business's tax id is an SSN. It goes in the same
  `tax_id_encrypted` column, with `tax_id_type = 'SSN'`, the SSN validator, and the same redaction:
  reps see last four, admins full or reveal. It is **not** copied from, or shared with, any owner's
  `pre_app_owner_secrets` row. The two are entered separately even when they are the same number,
  so neither path ever reads the other's ciphertext.
- **Every rule for the "three `*_secrets` tables" now applies to four.** That means:
  - zero policies and zero grants
  - Edge Function only, including the first submission
  - `tests/rls/grants.test.ts` and `pre-app-secrets-presence.test.ts:192-208` extended to the new
    table
  - CLAUDE.md's wording ("The three `*_secrets` tables") updated in the same commit

**Edge Functions.**
- `_shared/pre-app-secrets.ts` gains the kind `{kind: "tax_id", pre_app_id, tax_id_type, tax_id}`.
  - `tax_id_type` must be `'EIN'` or `'SSN'`, **and must equal the pre-app's current
    `ein_type`**, which the function reads through the caller's RLS client. Otherwise 400.
  - The value is validated by `isEin` (`/^\d{2}-\d{7}$/`) or `isSsn` (`/^\d{3}-\d{2}-\d{4}$/`),
    by type.
  - Encryption uses `secretAad('pre_app_tax_secrets', 'tax_id_encrypted', id)`, and the upsert is
    on `pre_app_id`.
- The validator **exists twice and must change together**: `lib/masks.ts` `isEin` plus the zod
  schema, and `_shared/pre-app-secrets.ts`. `tests/live/pre-app-secrets.test.ts` gets the
  rejected-values loop for EIN, as it has for SSN and routing.
- `submit-pre-app-secrets`: unchanged rules. Draft or admin, else 409. Audit
  `submit_pre_app_secrets:tax_id`.
- `read-pre-app-secrets`: a rep gets `tax_id_type` + `tax_id_last4`; an admin gets full, or
  last-four plus `reveal: "tax_id"` if the reveal follow-up is built (§1.E). Audit tier as today.
- `pre_app_secrets_presence()` gains `tax_id_on_file boolean`, existence only, still naming no
  `*_encrypted` column; the test's `pg_get_functiondef` grep extends.

**Wizard.** The EIN field moves to the "Sensitive data" step with its own "Encrypt & save". It is
never autosaved, because autosave writes through PostgREST and a secret must never take that path.
The Business step keeps only "EIN type" (a select: EIN / SSN). The secrets field's label and
mask follow it: "EIN 12-3456789" or "SSN 123-45-6789".

**Existing rows.** Drop `pre_apps.ein_number` in the migration that creates the table. Prod and dev
hold no real pre-apps, so the migration asserts
`not exists (select 1 from pre_apps where ein_number is not null)` and raises otherwise. *If real
data existed* this could not be a SQL migration at all: the key lives only in Edge Function
secrets. It would be a one-off service-role script (create table → script encrypts and inserts
every value → verify counts → drop column), with the drop as a separate later migration.

**Other readers to change:**
- `components/pre-app-summary.tsx:68` (the plaintext EIN)
- `lib/pre-app-form-fields.ts` (EIN moves to `SECRET_FIELDS` on the paper blank form)
- the review step blockers
- `tests/rls/pre-apps.test.ts` and `tests/unit/pre-app-logic.test.ts` where they touch `ein_number`
- `e2e/qa/pre-app-sensitive-inputs.spec.ts`

**Mandatory check for encrypted fields.** Exactly as SSN and banking work today: the database cannot
read the ciphertext, but it can see that a row exists, and only the function that validated the
plaintext could have written that row. `submit_pre_app()` (definer, so it can see the zero-grant
table) checks
`exists (select 1 from pre_app_tax_secrets where pre_app_id = pa.id and tax_id_type = pa.ein_type)`.
- The type comparison matters. A rep who saved an EIN and then switched EIN type to SSN has a row
  of the wrong kind, and is told "The tax id on file is an EIN, but EIN type says SSN. Enter the
  SSN."
- The validity of the value is guaranteed by the write path, not by the submit.

---

## 6. Mandatory-field enforcement

**Where.** Both, with the database authoritative.
- `submit_pre_app()` is the only door out of draft. Anything not checked there can be skipped by
  calling the RPC directly, which a rep can do.
- The wizard mirrors it, so a rep learns about a gap on the step where they can fix it.
- Neither can be a table constraint on `pre_apps`, because drafts are autosaved field by field (the
  location precedent).

**Recommend one list, not two.**
- New `pre_app_missing_fields(pre_app_id_input int) returns jsonb`. It returns
  `[{code, step, label}]`, for example
  `{"code":"tax_id","step":"secrets","label":"The EIN has not been entered."}`.
- It is `security definer`, because it must see the secrets tables. It has the same caller guard as
  `pre_app_secrets_presence()` (admin or the active owner, an identical PT404 otherwise),
  `set search_path = public, pg_temp`, and its own privilege lines.
- It returns **codes and labels only**, never a value.
- `submit_pre_app()` calls it first and refuses PT422 when it is non-empty. The message joins every
  label, so the rep sees all twelve gaps at once instead of one per click.
  `lib/db-errors.ts` passes PT4xx text through.
- The review step **calls the function** for its list, in place of the hand-written
  `preAppSubmitBlockers()`. That retires the browser-side twin and the "blockers mirror the RPC"
  unit test. The function supersedes `pre_app_secrets_presence()`; keep that until its one caller,
  the review step, has moved.
- Per-step UX:
  - each required field gets the required marker and zod `min(1)`
  - the shell's Next button stays enabled for **missing** fields (autosave tolerates blanks, and
    blocking Next on an empty field would trap a rep who wants to look ahead)
  - Next stays greyed for **malformed** values, as today
  - the step list shows a count badge ("Owners · 3 missing") from the function's `step` key

**The required set** (as decided). Each item is a code in the function.

- **Business:**
  - `dba_name`, `legal_business_name`, `contact_phone`
  - `physical_address`, `city`, `state`, `zip`, `country`
  - `legal_entity_type`, `state_incorporated`, `business_type`
  - `ein_type`, `bank_name`
  - `est_annual_volume`, `est_monthly_volume`, `est_average_ticket`, `est_high_ticket`, each
    non-null and `> 0` (§9, A13).
  - Plus the existing location rule and the 51% owner rule. `processor` stays optional (§9, A6).
- **Owners, every owner:**
  - `owner_name`, `title`, `percent_owned`, `dob`, `home_phone`
  - `id_type`, `id_number`, `id_state`, `id_issue_date`, `id_expiration_date`
  - the one owner address, required (§0.2): `home_address`, `home_city`, `home_state`, `home_zip`,
    `home_country`
  - `length_of_ownership`
  - SSN row present
- **Secrets:** a tax-id row of the chosen type (§5), and a banking row. **Not** the RP password.
- **Rep identity:** the pre-app's rep (`pre_apps.agent_id`, not the caller, so an admin submitting
  on a rep's behalf is held to the same rule) has both `legal_name` and `llc_legal_name` set on
  their profile (§0.6, §7). They are snapshotted onto the pre-app by the submit, together with the
  rep's split rate (§0b.4, `profiles.split_rate_pct` → `pre_apps.split_agent_pct`). The rate always
  has a value (default 50), so it is never a missing item.
- **Kept:** the card-mix pair totals.

**Country.** Today it is free text with no default.
- **Assumed** (§9, A14): US only. `country` defaults to `US` in the wizard and must be `US` at
  submit, for the business and every owner address.
- `state` is already two-letter US. Supporting non-US merchants later means relaxing both rules
  together.

**Existing drafts.** There are none on prod or dev that matter. Every draft simply meets the new
submit rules; nothing is backfilled and nothing is refused at rest. Already-submitted pre-apps are
untouched: the function gates only the transition out of draft, as the location rule did.

**Paper blank form.** `PAPER_COMPLETENESS_CHECKLIST` (`lib/pre-app-form-fields.ts:523-533`, nine
items, pinned at 9 by `tests/unit/pre-app-form-fields.test.ts:172`) already lags the RPC: it lacks
city and state. **Recommend** generating it from the same code list, exported as a constant beside
the function's labels, so it cannot lag again.

---

## 7. Rep identity, and the reports

### 7.1 Where the LLC legal name and real name live

**Decided (§0.6, §0.7):** on `profiles`, as two new nullable text columns. They are nullable because
admins and older accounts have none, and the gate is at pre-app submit, not at account creation.
- `legal_name` is the rep's real legal name. `full_name` stays the display name and is often a
  nickname.
- `llc_legal_name` is the legal name of the rep's LLC.

Both are set only by `set_rep_identity(user_id uuid, legal_name text, llc_legal_name text)`:
- the `set_territory()` pattern: `security definer`, `is_admin()` first
- trims, turns blank into null, caps at 200 characters
- audited `set_rep_identity`, failing closed
- its own privilege lines

There is still no UPDATE policy or grant on `profiles`. Neither column may appear in a policy.

**Why the profile and not the pre-app.** The report is per rep, not per deal. If each pre-app
carried its own typed value, one rep could have five spellings of their LLC and the report would
have to pick one. The pre-app still needs the values, for the processor's paperwork and because
Owen listed them, so **`submit_pre_app()` snapshots them** into new columns
`pre_apps.rep_legal_name` and `pre_apps.rep_llc_legal_name`.
- The detail page and print page read the snapshot.
- A later change to the profile does not rewrite a submitted application.
- The wizard shows them read-only on the Review step: "Submitted by Ann Ito · Ito Payments LLC".
- If either is missing, `pre_app_missing_fields()` returns `rep_identity`, labelled "Your legal name
  and LLC name are not on your profile yet. Ask an admin to add them."

**Decided (§0.6):** admin-set only. There is no self-service RPC, and a rep cannot submit until an
admin has set both fields. For a rep with no LLC, see §9, A16.

**Edited from:**
- `/admin/users/[id]`, next to territory and manager
- the **create-user screen** (`/admin/users/new` → `create-user`), which gains the two fields,
  optional at creation (§9, A20). The `_shared/admin-users.ts` validator and the SQL cap change
  together, as `agent_number`'s pair does.
- **Manage Users** (the list and the per-user edit): both fields, plus a "can't submit pre-apps
  yet" marker on reps missing either.
- the **bulk user import** CSV, which gains two optional columns (`Legal name`, `LLC legal name`).
  The `isBlocking()` pair is unchanged, and both copies stay pinned together.

### 7.2 Report sourcing

**Report 1: "Rep payout summary".** `rep_payout_summary(period_from date, period_to date) returns
table(...)` is `security invoker`, so RLS scopes it exactly as it does `/payouts`. The page is
admin-only. If a rep ever called the function, they would get their own rows only, which is the
`dashboard_counts` / `search_crm` property. A test asserts `prosecdef = false`.

Columns, in Owen's order (§0b.7). Per rep, per month (`rep_payout_rows.period`):

| Column | Source |
| --- | --- |
| Agent code | `profiles.agent_number` (still unique and admin-set; no longer used by the import) |
| Legal name | `profiles.llc_legal_name`, which holds the rep's own legal name when there is no LLC (A16) |
| Full name | `profiles.full_name` |
| Sales volume | `sum(volume)` over the rep's import lines that month. On a shared account, volume is on the **signer's line only** (residual-splits Q4), so the partner shows none for it (§9, A18). |
| Net residual | `sum(residual_income)` over the rep's import lines (the pre-split figure; on a shared account, the rep's piece) |
| Agent split | §4.5 "Agent split": earned at the merchants' rates, minus overrides taken from the rep's accounts |
| Deductions (adjustments), not included in the total | §4.5; the header reads "Deductions (info only, not in total)" (§0c.1) |
| Override received | §4.5 |
| Total agent commission | **Agent split + override received** (§0b.7); deductions not subtracted (§0c.1) |

The rep's split rate is read from the lines (`rep_split_pct`, the merchant's rate at commit), never
from `profiles.split_rate_pct`, which may have changed since. **Not included**, because the file
does not carry them (§0b.7): transactions, total income, total expense, gross, BPSR, rental, bonus.

**Report 2: merchants by processor.** `merchant_processor_summary(period_from, period_to)` is also
an invoker function.
- Grouped by `merchant_id`, `mid`, `merchants.dba` and `rep_payout_rows.processor`, for the snapshot
  taken at import.
- Volume is the sum of import-line volume, so the signer's line only.
- Residual is the sum of the **account** residual: `account_residual_income` on the primary line of
  a shared account, `residual_income` on an unshared line. The partner's piece is not added again.
- Optionally a rep-side column and a company-share column, since both are derivable (company share
  = residual − rep side at the merchant's rate; 100% for a house merchant).
- One row per merchant per processor, with a totals row per processor.
- Admin sees every merchant, by RLS.

**Page.**
- `/admin/reports`, guarded by `requireAdmin()`, with an `adminOnly` nav item "Reports" in the Admin
  group of `lib/nav.ts`.
- Two `FilterTabs`. Month and year selects default to the latest committed month, with a range
  option.
- `Table` primitives. Money figures use the `PayoutFigure` formatting already used for overflow.
- **Recommend** an XLSX download through a new caller-scoped Edge Function only if asked; printing
  the page covers the first need.
- Inside `<Suspense>` (`cacheComponents`).

---

## 8. Phased build plan

Thirteen phases, one prompt and one commit each, with the schema doc edited first in every phase.

- **P** marks phases that must land **before real pre-apps are entered**.
- **R** marks phases that must land **before the first real residual import**.
- The order respects dependencies: 1-5 are independent of 6-12, and within each block the order
  matters.
- After every schema phase, `npm test` runs in full, and the new baseline is recorded in CLAUDE.md.
- Deployment stays a separate, explicit decision. Nothing from `20261014120000` on is hosted yet;
  these phases add to that queue, and the residual-splits §11 runbook (version check, before/after
  checksum, `push-prod-migration.ps1 -DryRun`) applies to all of it.

### 8.1 The phases

| # | Phase | Scope (one line) | Gate | Existing tests it changes |
| --- | --- | --- | --- | --- |
| 1 | Processor vocabulary | `processors` reference table and seed, FK from `merchants.processor` and new `pre_apps.processor`, `approve_pre_app()` copies it, one `<ProcessorSelect>` on the merchant form and the wizard. | **P** | `rls/grants` (new table's grants), `rls/pre-app-state-machine` (approve copies processor), `rls/merchants` + `rls/merchants-admin-only-writes` (FK refusal on free text), `e2e/merchant-owner` (form field) |
| 2 | Rep identity | `profiles.legal_name` + `llc_legal_name`, admin-only `set_rep_identity()` with audit, on the create-user screen, Manage Users and the bulk user import. | **P** | `live/manage-users` + `live/user-provision` (create-user fields), `unit/user-import-parse` + `unit/user-import-lib` (two CSV columns, `isBlocking` pair), `rls/user-imports` (staging columns), `e2e/user-import` |
| 3 | Tax id to secrets | `pre_app_tax_secrets` (EIN or SSN by `tax_id_type`, zero policies/grants), drop `pre_apps.ein_number`, `ein_type in ('EIN','SSN')`, the `tax_id` kind in both secrets functions with the validator pair, presence gains `tax_id_on_file`. | **P** | `rls/grants` + `rls/pre-app-secrets-presence` (fourth table), `rls/pre-apps` (column gone, type CHECK), `live/pre-app-secrets` (+tax-id rejects, round trip, last-four, type mismatch), `unit/pre-app-logic` (EIN mask now secrets-side), `unit/pre-app-form-fields` (`SECRET_FIELDS`), `e2e/qa/pre-app-sensitive-inputs`, `e2e/print` (still no secrets) |
| 4 | Required fields and split rate | `pre_app_missing_fields()` used by `submit_pre_app()` and the review step; snapshot of rep identity **and the rep's split rate** onto the pre-app at submit (approval already copies `split_*` to the merchant); `profiles.split_rate_pct` (default 50, CHECK 0-50) with admin-only audited `set_rep_split()` and an admin-only Manage Users cell; `split_agent_pct` 0-50 CHECK on pre-apps (the merchants one moved to phase 8, §10); `country = 'US'`; the wizard's required markers and step badges; the split input removed; the paper checklist generated. | **P** | `rls/pre-app-state-machine` (submit-validation block rewritten; `makeSubmittable()` must fill every field; approval copies the snapshot rate), `rls/pre-app-children-draft-only` + `rls/pre-app-secrets-presence` (fixtures that submit), `rls/pre-apps` (split), `rls/grants` (`set_rep_split` privileges), `unit/pre-app-logic` ("blockers mirror the RPC" retired), `unit/pre-app-location`, `unit/pre-app-form-fields` (checklist count → generated), `live/manage-users` (rate cell), `e2e/pre-app-wizard`, `e2e/qa/pre-app-labels`, `e2e/merchant-location` (submits a pre-app) |
| 5 | Pre-app visibility | `PreAppSummary` shows every stored field to both roles; a masked Sensitive data section on the detail page; admin per-field reveal with its own audit tier (the security follow-up). | **P** | `live/pre-app-secrets` (read tiers: default last-four for admins too), `e2e/qa/pre-app-sensitive-inputs`, `e2e/print` |
| 6 | Import schema | Batches gain `processor`, `period` and replace columns, status `replaced`, and one committed batch per (processor, month). Staging gains `warnings` and the new blocker vocabulary. Ledger gains `processor`, the merge key with processor, and the confirmed-negative-volume column. `payout_period_closures` + `close_payout_period()`. Empty-table assertions. | **R** | `rls/rep-payouts` (merge key, volume CHECK), `rls/import-merge-key` (catalog diff), `rls/batch-status-transitions` (+`replaced`), `rls/commit-residual-import` + `-v2` (fixtures gain processor/period), `rls/acknowledge-residual-skips` + `rls/shared-lines` + `rls/share-corrections` (fixtures), `rls/grants` |
| 7 | Parser and upload page | Six-header parser (§1.G: Processor, Merchant Number, Merchant Name, Income Type, Volume, Residual); Merchant Number read as text; BOM/apostrophe/whitespace-tolerant headers; currency-formatted figures; whole-file refusal on a non-`Residuals` Income Type; file Processor vs chosen processor as the `processor_mismatch` warning; MID → merchant → owner; the refusals and three warnings, confirmed once per type per import; the upload page with processor, month, year and the replace prompt; the review screen's refusal Callout and yes/no blocks; Agent # UI removed. Tests use real processor names. | **R** | `unit/residuals-parse` (mostly rewritten), `unit/residuals-preview` (three flags removed), `unit/payouts` (`reviewImportRows`, blockers, flag labels), `unit/figure-comma` (`COLUMN_HEADERS`), `live/residual-import` (upload → parse half), `e2e/qa/residual-bad-import`, `e2e/qa/residual-import-comma`; fixtures `seed-dev-payouts.mjs` and `e2e/fixtures/seed.ts` (`createCommittableBatch`, `createSkippingBatch`) |
| 8 | Commit v3 | `commit_residual_import_v3(batch, confirmed[])`: re-resolves the owner, recomputes and enforces confirmations, **split = the merchant's rate** (house merchants at 0 still get a line), residual from the file, shared pair from the file. `commit_residual_import_v2` dropped. The share signer must be the owner, the two shares total the merchant's rate, and the merchant owner-change guard is added. `set_merchant_split()` (admin-only, audited, refused while a share is open or future) replaces the merchant form's split input, and client UPDATE on the merchant split columns is removed. The merchants `split_agent_pct` 0-50 CHECK (deferred from phase 4) lands here, after the hermetic fixture's 55/60/70 merchants are rewritten. | **R** | `rls/commit-residual-import-v2` (deleted, replaced by a v3 file), `rls/merchant-rep-shares` (signer = owner, owner-change refusal, shares total the rate), `rls/merchants-admin-only-writes` (split columns RPC-only), `rls/my-share-partners` (fixtures), `e2e/merchant-owner` (split input gone), `live/residual-import` (commit half, parse-vs-commit parity), `live/rep-share-teardown`, `e2e/payouts-commit`, `e2e/residual-skips` (retired), `e2e/payouts-shares` (fixtures) |
| 9 | Replace, Mark paid, adjustments | Replace inside v3 (refused once paid or when a correction targets the month), the "Mark paid" button with its typed confirmation, an admin-only "Reopen" requiring a written reason (`reopen_payout_period(period, processor, reason)`, definer, `is_admin()` first, audited, fails closed; A8), `delete_payout_period()` replacing the client delete (revokes DELETE), and a general `post_payout_adjustment()` for paid months (§0.5). | **R** | `rls/rep-payouts` (delete tests become RPC tests), `rls/grants` (DELETE revoked), `rls/share-corrections` + `rls/share-correction-posting-period` (posting month now shared with the general RPC), `e2e/payouts-roles` (delete), `e2e/payouts-adjustments` |
| 10 | Overrides | `merchant_overrides` (`0 < pct ≤` the merchant's rate, of the full residual; table CHECK ≤ 50, the per-merchant cap in the RPC and v3), set/end/cancel RPCs, `set_merchant_split` refusing a rate below an open override, override lines written by v3, the `rep_payout` generated-column branch, the merchant-page override card, statement lines, and the cross-book name read function. 26th `profiles` FK. | **R**, needed before the first imported month any override applies to | `rls/user-imports` (FK count 25 → 26, by name), `rls/shared-lines-rewrite` (generated column), `rls/shared-part` (reused for the debit division), `unit/payouts` (`payoutTotals`, `PAYOUT_ROW_COLUMNS`), `live/rep-share-teardown` + all four teardown lists, `e2e/payouts-rendering` + `e2e/payouts-shares` (statement lines) |
| 11 | Residual lock and payout UI cleanup | Revoke client UPDATE on `rep_payout_rows`; remove `PayoutFigureCell`, `PayoutBulkSplit`, `SharedResidualControl` and the round-trip copy; drop `set_shared_residual()`; new export header. | **R** (§0.5: not editable from the first import) | `rls/rep-payout-update-grant` (inverted: no UPDATE), `rls/shared-lines` (`set_shared_residual` tests retired), `rls/payout-history-trigger` (no client edit path; trigger kept as backstop), `unit/payout-figure-cell` (deleted), `unit/payouts`, `live/residual-import` (export header, 42501 test inverted), `e2e/payouts-editing` (retired or rewritten), `e2e/payouts-shares`, `e2e/payouts-states`, `e2e/qa/payout-figure-comma` (retired) |
| 12 | Reports | `rep_payout_summary()` (Owen's nine columns, §7.2; the rate read from each line's `rep_split_pct`) and `merchant_processor_summary()` (both `security invoker`), `/admin/reports` page, admin nav item. | none (after 10) | none existing; `unit/` nav test only if one asserts the Admin group's items |
| 13 | Docs and the old commit | CLAUDE.md, `docs/claude/*`, `RESIDUALS_SPEC.md` addendum, a docs-index line for this memo, and `commit_residual_import(int)` dropped once the new app is on dev and prod. | after deploy | `rls/commit-residual-import` (deleted with the function), `unit/claude-md` (index) |

### 8.2 Size and order notes

- Phase 9 is the largest. If it does not fit one prompt, split it into 9a (closures, replace) and
  9b (period-delete RPC, general adjustment).
- Phases 10 and 11 can run in either order. Phase 11 must land before the first real import,
  because §0.5 makes residuals uneditable from the start.

### 8.3 Overall test impact (estimate)

- Roughly **250-300 existing tests change or go**, mostly in the residual files:
  - `unit/residuals-parse` (50)
  - `live/residual-import` (46)
  - `rls/commit-residual-import-v2` (32)
  - `unit/residuals-preview` (23)
- About as many new ones arrive. Of those, the exhaustive cent-rule grids for overrides (§4.4) are
  single SQL statements, not hundreds of cases; the rate dimension (§0b.4) multiplies the grid's
  cases, not its statements.
- The split rate (§0b.4) adds, by phase:
  - **4:** about 25-35 new tests: `set_rep_split` (admin-only, audit row, bounds 0 and 50 and
    outside them, grants, no client UPDATE path, never in a policy), the submit snapshot (rate and
    `100 − rate`, a draft's own value overwritten, a later rate change leaving a submitted pre-app
    and an approved merchant unchanged), the 0-50 CHECKs, and the Manage Users cell (admin-only).
    Tests that read the wizard's split input (`e2e/pre-app-wizard`, `unit/pre-app-logic`'s split
    sum) change or go.
  - **8:** v3 at rates 50, 46, 0 (house line with a zero rep amount), shares totalling the
    merchant's rate, `set_merchant_split` (audited, refused with a share open). Every v3 fixture
    states its merchant's rate.
  - **10:** the cap at the merchant's rate rather than 50; `set_merchant_split` refusing a rate
    below an open override.
  - **12:** a report row per rate, and the house profile's zero-commission row.
- The six-column file format (§0b.1) rewrites essentially all of `unit/residuals-parse` (as already
  counted) and adds about 15 cases: MID as text (leading zero, 12 digits), header BOM / apostrophe /
  whitespace, currency figures, the Income Type refusal listing rows, and the file-processor
  mismatch.
- The hermetic baseline (2138 / 100 files at the memo's writing) moves in every phase from 1 to
  12.

### 8.4 CLAUDE.md rules that must change, and when

| Rule (CLAUDE.md unless noted) | Change | Phase |
| --- | --- | --- |
| "Three tiers" §1: the list of normal tables | Add `processors` (1), `payout_period_closures` (9), `merchant_overrides` (10) | 1, 9, 10 |
| `approve_pre_app` description (Three tiers §4) | Also copies `processor` | 1 |
| "`profiles` has no client write path: new columns are set only by … (`set_user_role`, `set_agent_number`, `set_territory`, `set_manager`)" | Add `set_rep_identity`; `legal_name` and `llc_legal_name` never in a policy. Same in `docs/claude/rpcs-profiles-audit.md`'s profiles paragraphs. | 2 |
| "**The three `*_secrets` tables: zero policies, zero grants, Edge Function only**", and Three tiers §2 | **Four** tables, naming `pre_app_tax_secrets`; same lock-twice rule | 3 |
| "The secrets validators exist twice" (and `docs/claude/edge-functions-and-storage.md`) | The pair now includes the tax-id validators (EIN or SSN by type) | 3 |
| `docs/claude/merchant-location.md`: "`submit_pre_app()` now refuses the same…" | The location rule now lives in `pre_app_missing_fields()`, which `submit_pre_app()` calls | 4 |
| "`profiles` has no client write path: new columns are set only by … (`set_user_role`, …, `set_rep_identity`)" | **Add `set_rep_split`**; `split_rate_pct` never in a policy (§0b.4). Same in `docs/claude/rpcs-profiles-audit.md` | 4 |
| `approve_pre_app` description (Three tiers §4) / pre-app docs | `submit_pre_app()` snapshots the rep's rate into `pre_apps.split_agent_pct` (overwriting the draft's value); approval copies it to the merchant; a later rate change touches neither | 4 |
| `docs/claude/security-fixes.md` phase 1 / the merchants write rule ("merchants admin-only to change") | **The merchant split columns are written only by `set_merchant_split()`** (audited, refused while a share is open or future); no client UPDATE on them, admin included | 8 |
| `payouts-and-teardown.md` / residual-splits: "the two shares total 50" (`merchant_rep_shares` CHECK) | The two shares total **the merchant's rate**, enforced by `set_merchant_rep_share()` | 8 |
| `docs/claude/rpcs-profiles-audit.md`: "`profiles.agent_number` … is the only join between a processor's residual report and this database" | **No longer true.** The MID is the join, and `agent_number` is a display code only | 7 |
| Edge Functions table: `residual-import-file-url` and `parse-residual-import` rows ("resolve an agent number, then read again", preview flags) | Upload takes processor and month; parse resolves MID → owner; refusals and warnings replace the agent-number flow | 7 |
| `docs/claude/payouts-and-teardown.md`: "`volume` and `average_ticket` are `check >= 0` because a negative there is a parse error" | A negative volume is allowed only on a line whose confirmed `bad_numbers` warning set `volume_confirmed_negative` | 6 |
| `docs/claude/payouts-and-teardown.md`: merge key `(period, agent_id, mid) where line_kind = 'import'` | `(period, processor, agent_id, mid) where line_kind = 'import'`. **"Every `on conflict` … must say `where line_kind = 'import'`" is KEPT** | 6 |
| **"The commit RPC's merge rule is `coalesce(excluded.<col>, rep_payout_rows.<col>)` — reversing the arguments silently wipes hand-entered residuals"**, and the matching Three tiers §3 paragraph | **RETIRED.** v3 never merges: one committed batch per (processor, month), a second is a replace, and there are no hand-entered residuals. Rewritten in phase 8 to say so, noting that the old `commit_residual_import(int)` still carries the rule until it is dropped. **Removed entirely in phase 13.** The replacement rule: *"A committed processor-month changes only by `replace` (until paid) or an adjustment line (after)."* | 8, 13 |
| `docs/claude/payouts-and-teardown.md`: "The commit button calls v2" | Calls v3 | 8 |
| `payouts-and-teardown.md`: batch status guard "only `review -> abandoned`" | Unchanged for clients; `replaced` added as a definer-only status | 9 |
| `payouts-and-teardown.md` / `rpcs-profiles-audit.md`: "`audit_log` per committed batch and per deleted period" | Now true: the period delete is an audited RPC. **Record the defect it fixes** (no audit row was ever written) | 9 |
| `payouts-and-teardown.md`: "twenty-five columns reference `profiles(id)`" and the four teardown lists | Twenty-six; all four lists gain `merchant_overrides` | 10 |
| Overrides (new rule) | An override is `≤` the merchant's rate, enforced in `set_merchant_override()` and re-checked by v3; the table CHECK (`≤ 50`) is only the outer bound | 10 |
| Reports (new rule) | Report 1 reads each line's `rep_split_pct`, never `profiles.split_rate_pct` | 12 |
| "**A column that must be immutable is a GRANT…** `rep_payout_rows.residual_income` + `rep_split_pct` only" | `rep_payout_rows`: **no client UPDATE at all** | 11 |
| `payouts-and-teardown.md`: the shared-accounts-on-screens paragraph (`SharedResidualControl`, `PayoutBulkSplit` partner filter, `PayoutFigureCell`) | Those controls are gone; shared lines are filled from the file at commit | 11 |
| `docs/claude/project-state.md` routes list | Add `/admin/reports` | 12 |
| Test baselines in the Commands block | New counts | every phase |
| Docs index | Add `docs/design/intake-and-reports.md` | 13 |

---

## 9. Risks, and the defaults assumed for the open questions

### 9.1 Risks

1. **Replacing money.** Bounded by Mark paid (§3.2), but only if admins actually press it. If they
   never do, every month stays replaceable forever. **Mitigation:** the import list shows "not
   marked paid" on every committed month older than 45 days.
2. **The payee follows the merchant owner silently.** Reassigning a merchant changes who is paid for
   every month not yet imported. Mitigated by the `payee_changed` warning (A10).
3. **The merge rule is retired.** CLAUDE.md calls it binding, and its protective test goes with v2.
   The replacement protection is structural: one committed batch per (processor, month), changes
   only by replace or adjustment, and no client UPDATE on the ledger. §8.4 makes the rule text
   change in phases 8 and 13, so no later reader "restores" a merge.
4. **Two lists, again.** The parser's warnings and v3's recomputation are a TS/SQL pair, pinned by
   the live parity test only, as `previewSharedRow` is today.
5. **A negative volume can be committed on a "yes".** It is limited to the confirmed `bad_numbers`
   path and marked per line, so it is findable.
6. **Override privacy.** A rep's debit line names the recipient, and the recipient's credit names
   the merchant. Both are cross-book facts, and both go through a definer read function with key
   absence, never a policy.
7. **Rep identity blocks submission** until an admin fills the profile (§0.6). Manage Users shows
   which reps cannot submit yet.
8. **Fourth secrets table.** Every "three tables" statement in docs and tests must move (§8.4), or a
   policy added to the new table by mistake would go unnoticed.

### 9.2 Defaults assumed

Each item is what the build will assume unless Owen says otherwise.
- **[CONFIRM]** marks a default that affects **money**, **security** or **what reps can see**.
- Items marked *Decided* were settled on 23 Oct 2026 (§0) and are listed only so the numbering
  matches the earlier questions.

| # | Question | Default assumed | Why |
| --- | --- | --- | --- |
| A1 | Processor spellings | Exactly `TSYS`, `Red Fynn`, `PayBright`, `Netevia HQ`, `Square`; code = label. More are added by migration. | As Owen wrote them; a table row is cheap to fix. |
| A2 | EIN type values | *Decided:* `EIN` or `SSN` (§0.3). | — |
| A3 | Owner address | *Decided:* one, the home address, required (§0.2). | — |
| A4a | Percent of what | *Decided:* of the full residual, ≤ the merchant's split rate (§0.1, §0b.5). | — |
| A4b | Settable between submit and approval? | **[CONFIRM: money]** No. The override is set on the merchant, which exists from approval, and the RPC refuses a merchant whose pre-app is not submitted or approved. | Nothing can be paid before a merchant and MID exist, so no month is missed. Storing it on the pre-app as well would be a second home for the same fact. |
| A4c | Does the rep see who receives it? | **[CONFIRM: rep visibility]** Yes. The rep's line reads "Override 10% of residual · −$10.00 · to Dana Cole". The recipient sees the merchant name as plain text, with no link and no access. | A deduction with no stated payee reads as an error. This mirrors the shared-account rule, where each party sees the other's name. |
| A4d | "Overrides received" column in Report 1 | **[CONFIRM: money]** Yes, as a separate column, included in Total agent commission. | Without it, a manager's total understates what they are paid. |
| A4e | Several overrides on one merchant at once? | **[CONFIRM: money]** No: at most one per merchant per month (exclusion constraint). | A second needs a second table and a cap across them. Simpler to add later than to remove. |
| A4f | Override paid outside the CRM (no recipient) | **[CONFIRM: money]** Not supported. Every override has a named recipient. | §0.1 says "a named person otherwise". |
| A5 | Duplicate MID on yes | *Decided:* refuses the import (§0.4). | — |
| A6 | Processor mismatch details | **[CONFIRM: money]** A merchant with **no** saved processor is not a mismatch and imports silently. A confirmed mismatch does not change the merchant's processor. Processor stays **optional** on the pre-app. | It is not in Owen's mandatory list (§0, item A). The admin sets it on the merchant, and the review screen links there. |
| A7 | Admin edits after commit | *Decided:* none (§0.5). | — |
| A8 | Paid months | **Approved with a change (Owen, 23 Oct 2026):** "Mark paid" is per processor and month and keeps its typed confirmation, **and there is an admin-only "Reopen"** that requires a written reason and is audited. Built in phase 9 (§3.2). | Reopening a paid month is the dangerous operation, so it is deliberate (a reason, typed) and leaves a trail, rather than impossible. |
| A9 | Unknown-MID alert | The refusal Callout on the review screen is the alert. No notification, no email. | The admin is on that screen when it happens, and email sending does not exist yet. |
| A10 | Payee changed since last month | **[CONFIRM: money]** Build `payee_changed` as an informational, non-blocking note in phase 7 ("last month this MID paid Ann Ito; now it pays Bo Lee"). | It is the only signal that a merchant reassignment moved money. |
| A11 | Import window | **[CONFIRM: money]** Not a future month, and not more than 24 months back. | It catches a mistyped year. Adjustments cover anything older. |
| A12 | Edits to an approved pre-app | Do not reach the merchant (unchanged). Admins edit the merchant directly. | The merchant is the record of truth once it exists. |
| A13 | Volume estimates | Required and `> 0`. | A zero estimate is a placeholder, not an estimate. |
| A14 | Non-US merchants | None. `country = 'US'` for business and owners. | `state` is already two-letter US; relax both together if this changes. |
| A15 | Who sets rep identity | *Decided:* admin only (§0.6). | — |
| A16 | Rep with no LLC | The admin enters the rep's own legal name (or sole-proprietor business name) as the LLC legal name. Blank is not accepted for submit. | §0.6 requires both fields. A placeholder like "N/A" would print on the processor's paperwork. |
| A17 | Report "legal name" / "rep name" | *Decided (§0b.7):* Legal name = `llc_legal_name` (the rep's own legal name when there is no LLC, A16); Full name = `full_name`. | — |
| A18 | Shared-account volume in Report 1 | **[CONFIRM: money]** On the signer's row only; the partner's row shows none for that account. Report 2 counts it once. | Adding it to both would double the company's total volume when summed. |
| A19 | File headers | *Decided (§0b.1):* the six columns `Processor`, `Merchant Number`, `Merchant Name`, `Income Type`, `Volume`, `Residual`, all required, matched case- and space-insensitively after stripping a BOM or leading apostrophe. A `Processor` cell that differs from the chosen processor is the `processor_mismatch` warning, no longer ignored. | Owen's real file. A real file per processor should still be checked before phase 7 (the sample's Processor column is a placeholder). |
| A20 | Identity fields at account creation | Optional at creation (create-user, bulk import); required only to submit a pre-app. | Admin accounts and bulk-imported reps may not have them yet. The gate is where Owen put it. |
| A21 | Split exceptions | *Decided (§0b.4):* the rate is per rep (default 50, 0-50, `set_rep_split`), snapshotted per merchant, and changeable per merchant by `set_merchant_split` (refused while a share is open). The house profile is 0. | — |
| A22 | Shares under the owner rule | **[CONFIRM: money]** The share's signer must be the merchant's owner. Moving a merchant with an open or future share is refused until the share is ended. | The file no longer names a rep, so the owner is the only possible signer. A silent change of signer would move money. |
| A23 | Adjustment after a paid month | **[CONFIRM: money]** A general `post_payout_adjustment(rep, MID, month adjusted, amount, note)`: admin-only, audited, posting to the open month like a share correction. Built in phase 9. | §0.5 makes the adjustment line the only fix after payment, so it has to exist before the first paid month needs one. |
| A24 | Admin view of secrets | **[CONFIRM: security]** Admins also get masked values by default, with a per-field Show, audited as a reveal. Reps never see a full value. | Closes the "admins see full SSNs as soon as the step opens" follow-up, and makes the audit row distinguish a look from a glance. |
| A25 | Negative residual (clawback) | **[CONFIRM: money]** Not a "bad number". It imports without a warning, and the override reverses in proportion. | Clawbacks are real (`residual_income` is signed today), and residual > volume cannot be true for a negative residual. |
| A26 | Inactive vs other | **[CONFIRM: money]** Only `status = 'inactive'` raises the inactive-merchant warning; `'other'` does not. | `inactive` is the only closed state in the vocabulary (as `accounts_in_city` treats it). |
| A27 | Re-reading after a refusal | Unknown MIDs: the batch stays in review, and "Read again" works once the merchants exist. Repeated MIDs or a wrong Income Type: the file itself is wrong, so the admin abandons it and uploads a fixed file. | Reading the same file again cannot remove a repeat. |
| A28 | Sharing a house merchant | **[CONFIRM: money]** Refused: a merchant at rate 0 has no rep side to divide. | Two shares of 0 pay nobody and only add lines. |
| A29 | Lowering a merchant's rate below its open override | **[CONFIRM: money]** `set_merchant_split` refuses it, naming the override; the admin ends or changes the override first. | Otherwise the override would exceed the rate (§0b.5) and the rep's net would go negative. |
| A30 | Rate precision | `numeric(5,2)`, 0.00-50.00 in 0.01 steps, matching `split_agent_pct` and the override. | The existing columns already have that type; Bruce Rozar's ~46% effective rate (§11) may be a blend, not a single rate. |

---

## 10. Build notes

### Phase 1: processor vocabulary (23 Oct 2026, branch `intake-and-reports`)

Built: the `processors` table (`20261023130000_processors.sql`), FKs from `merchants.processor` and a
new `pre_apps.processor`, `approve_pre_app()` copying it, `lib/processors.ts` +
`components/processor-select.tsx` on the merchant form and the wizard's Business step, the
processor on the pre-app summary and the blank paper form.

What differed from the plan, and why:

- **The guard refuses rows it would break, not a non-empty table.** A strict "refuse unless
  `merchants` and `pre_apps` are empty" guard was built first and run: it failed four hermetic
  suites (`accounts-in-city`, `accounts-in-city-limits`, `merchant-location`,
  `merchant-location-backfill`; 132 tests skipped as a consequence). Those suites seed a database
  before replaying later migrations, which is the shape of a real project with data, and every row
  they seed is valid. The guard therefore refuses when any `merchants.processor` value is outside
  the list, naming the values. On an empty table that is the same as an empty-table guard.
  `pre_apps` only gains a nullable column, which changes no row. **Later phases should use the same
  rule: refuse the rows the change would break, and say which.**
- **`revoke all` before the grants.** On the local stack, `pg_default_acl` for role `postgres` gives
  `service_role` TRUNCATE/REFERENCES/TRIGGER/MAINTAIN on every new table, and PGlite has no such
  default. The migration starts from nothing, so the surface is exactly SELECT for `authenticated`
  and `service_role` everywhere. Measured on the stack after the fix.
- **The paper form keeps one copy of the list** (`PAPER_PROCESSOR_CODES`), because that page is
  static by design. A unit test pins it to the migration and the schema doc.

Found while building, **not fixed** (outside phase 1):

- **A wizard select changed in the first moment after the step loads is reset and autosaved as
  NULL.** Reproduced on the code *before* this phase (billing type, with phase 1 stashed): the
  PATCH carried `{"billing_type": null}`. Waiting for the network to settle makes the choice hold
  (3/3). It was seen in `next dev` only; whether a production build does the same is unverified.
  `e2e/processor-select.spec.ts` waits for `networkidle` and says why.
- **CLAUDE.md says the `ensure_rls` backstop "exists on that hosted project only — not in any
  migration … not in PGlite".** That has been untrue since `20260811150000` adopted it. The rule
  "do not rely on it" still stands. The practical effect: a migration that forgets
  `enable row level security` passes every behavioural test here, so `tests/rls/processors.test.ts`
  pins the line in the migration's text.
- **The Supabase CLI was found linked to PROD** (`zuvsdkjnfstrjahstsmg`; `npm run guard:linked`
  refused). Nothing linked was run. Only local commands (`migration up --local`, `psql` inside the
  local DB container) were used. Relinking to dev is a deliberate action left to Owen.

### Phase 2: rep identity (26 Oct 2026, branch `intake-and-reports`)

Built: `profiles.legal_name` + `profiles.llc_legal_name` and `set_rep_identity(user_id, legal_name,
llc_legal_name)` (`20261026120000_rep_identity.sql`); the two fields on the create-user screen
(`create-user`), an inline "Legal names" cell on Manage Users with a "can't submit pre-apps yet"
marker, and two optional CSV columns `Legal name` / `LLC legal name` in the bulk import
(`stage-user-import`, `provision-user-batch`, staging columns on `user_import_rows`).

**The no-LLC rule (A16), recorded here as decided:** a rep with no LLC has their own legal name (or
sole-proprietor business name) entered by the admin as the LLC legal name. The LLC field may be
empty at account creation; it is the phase 4 submit gate, not the account, that requires both.
Never a placeholder like "N/A", which would print on the processor's paperwork.

Where the memo was silent or said otherwise, and what was chosen (conservative side each time):

- **Blank is refused, not turned into null.** §7.1 says "turns blank into null"; the phase 2
  instruction said "rejects empty strings". The later, stricter one won: a blank-after-trim string
  raises PT400. **Null** clears a value (an admin correcting a mistake). Forms and the CSV treat a
  blank box as "not given" and send null, so the refusal only bites a direct API caller.
- **"Trim" means ASCII whitespace** (`btrim(x, E' \t\n\r\f\x0b')`). Plain `btrim(x)` strips spaces
  only; the tests caught `'\tIto LLC'` being stored as typed.
- **Named CHECKs on both columns** restate the RPC's rules (trimmed, non-blank, ≤ 200), so the
  service role cannot store what the RPC refuses. Not in the memo; cheap and strictly tighter.
- **One audit verb, `set_rep_identity`, for set and clear**, written in the same statement with no
  exception handler (fails closed). No change → no audit row, as `set_territory`.
- **Self-target allowed** for an admin, as `set_territory`.
- **The memo's parameter names are kept** (`user_id`, `legal_name`, `llc_legal_name`). They shadow
  the columns, so every parameter reference in a statement is qualified with the function name.
- **Create-user and the bulk import write the names through the RPC, on the caller-scoped client,
  after the profile insert** — not in the service-role insert — so the RPC is the only write path
  and its audit row names the admin. If that call fails, the account is kept (retrying would now be
  a conflict) and the failure is surfaced: `identityWriteFailed` on the create-user response and a
  warning on its success screen; a note in `outcome_detail` on the import row, which the batch page
  now shows under a created row's badge.
- **`create-user` returns 400 before creating anything** for a name over 200 characters or a
  non-text value.
- **The bulk import blocks an over-long name** with two new blocking codes,
  `invalid_legal_name` / `invalid_llc_legal_name`; the skippable pair is unchanged.
- **Manage Users has no `/admin/users/[id]` page** (§7.1 names one). The fields went into an inline
  cell on the list, the `TerritoryCell` pattern. The marker shows for `role = 'agent'` missing
  either value, deactivated or not.
- **There is no downloadable CSV template.** The "template" is the column list on the upload
  screen, which now names the two columns.

**Where the phase 4 submit rule plugs in:** `pre_app_missing_fields()` returns `rep_identity` when
`profiles.legal_name` or `profiles.llc_legal_name` is null for `pre_apps.agent_id` (not the caller);
`submit_pre_app()` refuses on it and copies both into `pre_apps.rep_legal_name` /
`rep_llc_legal_name`. Because the CHECKs forbid blank, `is null` is the whole test. The wizard's
Review step reads the same function; Manage Users' marker is the admin-side view of the same
condition.

Found while building, **not fixed** (outside phase 2): `set_territory()` has the same plain
`btrim()`, so a tab-padded territory is stored with its tab.

### Phase 3: tax ID to secrets (26 Oct 2026, branch `intake-and-reports`)

Built: `pre_app_tax_secrets` and the drop of `pre_apps.ein_number`, the `pre_apps_ein_type_check`
CHECK (`'EIN'`/`'SSN'`), the `submit_pre_app()` tax-ID rule and two new columns on
`pre_app_secrets_presence()` (`20261026140000_pre_app_tax_secrets.sql`); the `tax_id` kind in
`submit-pre-app-secrets` and `read-pre-app-secrets`; the validator pair `isTaxEin` / `isTaxSsn`
(`lib/masks.ts`, `_shared/pre-app-secrets.ts`); the EIN type select on the Business step, the tax-ID
input on the Sensitive data step, the review-step blockers, the summary, and the paper form.

**How "switching the EIN type forces re-entry" is enforced.** The stored row keeps the kind it was
written with (`tax_id_type`), and nothing counts a row whose kind differs from the pre-app's
*current* `ein_type`:
- `submit_pre_app()` requires `exists (… where tax_id_type = pa.ein_type)` and, when only a row of
  the other kind exists, refuses with "the tax ID on file is an EIN, but EIN type says SSN. Enter
  the SSN." (PT422);
- `pre_app_secrets_presence()` reports `tax_id_on_file` against the current type, plus the stored
  kind, so the review step shows the same sentence;
- `submit-pre-app-secrets` refuses (400) a `tax_id_type` that differs from the current `ein_type`,
  read through the caller's client, so a value can never be filed under the wrong kind;
- the Sensitive data step shows the mismatch and asks for the number of the new kind; saving it
  upserts over the old row.
The stale row is **not** deleted when the type changes. A trigger that destroyed ciphertext on a
select change (an admin toggling a submitted pre-app's type included) is the less conservative
choice; refusing to count it is enough to force the re-entry.

**Where phase 4 takes over.** The only change to `submit_pre_app()` is one block, checked last,
after the banking rule; the rest of the body is `20261013132000`'s. Phase 4's
`pre_app_missing_fields()` should carry it as the `tax_id` code (three labels: no type, none on
file, wrong kind) and `preAppSubmitBlockers()`'s copy of it retires with the rest of that function.

Where the memo was silent or said otherwise, and what was chosen (conservative side each time):

- **Kind values are `'EIN'`/`'SSN'`**, as §5 and §0.3 say, matching `ein_type`. (The phase 3
  instruction wrote them lower-case; it also said to use the memo's real values.) Column name
  `tax_id_type`, as §5.
- **No stored last-four column.** The other three tables store none; the read function decrypts
  and slices, so the tax ID does the same.
- **Validators are stricter than the existing SSN ones.** The instruction assumed the SSN
  validators refuse all zeros; they do not (`isSsn` is a shape check on both sides). `isTaxEin`
  refuses all zeros and prefix `00`; the IRS prefix list is not enforced (it changes, and the
  routing-checksum lesson applies). `isTaxSsn` refuses area 000/666/9xx, group 00, serial 0000.
  The owner `isSsn` is unchanged — tightening it is a separate decision.
- **The guard's test is `ein_number is not null`** (the memo's), so a blank string also refuses.
  The message names pre-app ids, never the number. It also refuses an `ein_type` outside
  `('EIN','SSN')`, naming the values (they are not secret), rather than rewriting them.
- **Presence gains two columns, not one:** `tax_id_on_file` (of the current kind) and
  `tax_id_type_on_file` (the stored kind, plaintext), so the wizard can name the mismatch.
- **No EIN type → submit refuses** "an EIN type (EIN or SSN) and the tax ID are required"; the
  function refuses any tax ID until a type is chosen.
- **The summary / detail page shows the EIN type and no digits at all.** Last four is shown on the
  Sensitive data step only, as SSNs are today. Putting it on the server-rendered summary would put
  it in the RSC payload, and calling the decrypting function there would hand an admin the full
  number on a page phase 5 is meant to mask.
- **Admin read is full**, exactly as SSN reads are today (phase 5 masks it). Audit verbs unchanged:
  `read_pre_app_secrets:full|last4`, and `submit_pre_app_secrets:tax_id` for a write.
- **The paper form:** `ein_type` prints as EIN/SSN tick boxes; one "Tax ID (EIN or SSN, as ticked
  under EIN type)" box in the Sensitive data section; the completeness checklist gains the tax ID
  line (9 → 10), since submit now requires it.
- **`search_path = public`** kept on both rewritten functions, as their existing tests pin; not
  widened to `public, pg_temp` in this phase (security-followups has that item).
- **Grants:** `revoke all` from everyone, then `grant all` to `service_role` on the table and
  sequence — measured on the local stack to equal `pre_app_banking_secrets` exactly.
- **The secrets step now shows the function's own error** (`edgeFunctionErrorMessage`), not
  supabase-js's fixed "non-2xx" string, so the 400 for a type mismatch is readable.
- `isEin` was removed (nothing used it once `ein_number` left the form); its unit assertions moved
  to `isTaxEin`.

Found while building, **not fixed**: the owner-SSN validator pair accepts `000-00-0000` and other
never-issued SSNs (shape only).


### Phase 4: required fields, split rate, country (28 Oct 2026, branch `intake-and-reports`)

Built (`20261028120000_pre_app_required_fields.sql`):
- `pre_app_missing_fields(pre_app_id)` returns every missing item at once as
  `[{code, step, label, owner_id?}]`; 40 stable codes, listed in
  `lib/pre-app-required.ts` and pinned to the SQL body by
  `tests/unit/pre-app-required.test.ts`. It absorbs the location rule, the owner
  rules, card mix, banking and the phase 3 tax-ID block (`tax_id`, three labels).
- `submit_pre_app()` refuses with the whole list (PT422; the labels in the
  message, the codes in DETAIL), then snapshots `rep_legal_name`,
  `rep_llc_legal_name` and the rep's rate into `split_agent_pct` /
  `split_company_pct`. Its body now names no secrets table at all.
- `profiles.split_rate_pct` (default 50, CHECK 0-50) and `set_rep_split(user_id,
  rate)`, the `set_rep_identity()` shape; an admin-only "Split" cell on Manage
  Users.
- `pre_apps_guard_transitions` refuses any write of the split or the two name
  snapshots outside the state-machine flag (an admin's included); on INSERT they
  must be the defaults.
- `pre_apps.country` and `pre_app_owners.home_country`: not null, default `'US'`,
  CHECK `= 'US'`; shown as fixed text in the wizard.
- The wizard: the review step shows the function's list (fetched by the page
  through the RPC); `preAppSubmitBlockers()` is gone; step links carry "· N
  missing"; required fields carry an `aria-hidden` `*`; the split input is
  replaced by the rep's rate, read-only.
- The owner `isSsn` on both sides is now `isTaxSsn`.
- The paper checklist is generated from the code list (24 lines; it had 10 and
  lacked city and state).

Where the memo was silent or said otherwise, and what was chosen (conservative
side each time):
- **The snapshot columns are the existing `split_agent_pct` / `split_company_pct`**,
  not a new column: `approve_pre_app()` already copies them, so the merchant
  snapshot at approval needed no change.
- **The snapshot is enforced by the guard trigger, admin included**, rather than
  by revoking column grants (a column-grant list on `pre_apps` would have to name
  every other column and drift with each new one).
- **The merchants 0-50 CHECK is deferred to phase 8** (with `set_merchant_split`),
  although §1.C/§8.1 put it here: nothing reads the merchant split until v3, the
  merchant form still edits it, and the shared hermetic fixture seeds 55/60/70
  merchants that a dozen suites rely on. Phase 8 must add it.
- **A NULL country is filled with `'US'` by the migration** (with the state flag
  on), on drafts and submitted pre-apps alike: it is the only value the column
  can now hold, and leaving it null would strand a draft with an item nobody can
  fix. A non-null value other than `'US'` refuses the migration, naming it.
- **`rep_identity` still needs both names**, so the A16 fallback
  (`coalesce(llc_legal_name, legal_name)`) in the snapshot is written down but
  unreachable through submit; A16 is the admin entering the rep's own name in
  both fields, which is what the tests exercise.
- **The labels are neutral** ("The rep's legal name and LLC legal name are not
  on their profile yet…") rather than §7.1's "Your…", because an admin submitting
  on a rep's behalf reads the same list.
- **Owner percent owned must be above zero; ZIPs must be 12345 or 12345-6789;
  ID state and home state must be two letters** — the wizard's own formats.
- **`pre_app_secrets_presence()` is kept** (no caller left in the app; tests and
  the definer-function audit still read it). Dropping it is a cleanup-phase
  choice.
- **New functions pin `search_path = public, pg_temp`** (§6); the rewritten
  `submit_pre_app()` and guard keep `public`, which their tests pin.
- **`set_rep_split` refuses more than two decimals** instead of letting
  `numeric(5,2)` round silently.
- **Step badges refresh on navigation**, not keystroke by keystroke.
- **The Agent # agent code 122 house rate is not set by the migration** (an
  admin does it, §11).

Not done here:
- **The reset script (`scripts/reset-business-data.sql`) is not on this branch.**
  It lives on the unmerged `reset-business-data` branch (`d6d248b`, `90d6242`),
  and its `keep_tables` is `profiles` only. When it is merged, `processors` must
  join `keep_tables`, and `pre_app_tax_secrets` `clear_tables` next to the other
  three secrets tables. Phase 4 adds no table.

The wizard bug from phase 1 (a select changed straight after a step loads is
reset and autosaved as empty) **reproduces on a production build** (`next build`
+ `next start` against the local stack, env from `.env.development.local`; no
hosted project reachable from the bundle): 4 of 27 runs of
`e2e/qa/wizard-early-select.spec.ts` lost the choice ("net" chosen, "—" shown),
against 2 of 3 on `next dev`. Cause: the step is server-rendered and usable
before hydration; react-hook-form's `register()` ref writes the loaded value
back as it registers, and React's replay of the early change event then
autosaves that reset value. Fix: the shell holds the step's controls in a
`<fieldset disabled>` until it has hydrated (`useSyncExternalStore`, server
snapshot false). After the fix, 27 of 27 pass on a rebuilt production build.
Consequence for specs: `pressSequentially` does not wait for an input to be
enabled, so `e2e/qa/pre-app-tax-id.spec.ts` now waits for `toBeEnabled()` first.

Found while building, not fixed: the Supabase CLI is still linked to PROD
(`supabase/.temp/linked-project.json`), as phase 1 found; nothing linked was
run. Local service versions therefore follow prod's `.temp` files.

### Phase 5: pre-app visibility and secret reveal (28 Oct 2026, branch `intake-and-reports`)

Built (`20261028140000_pre_app_secret_reveal.sql`):
- `read-pre-app-secrets` answers every **default read** with the masked tier, admin included: last
  four of each owner SSN, the tax ID (with its stored kind), routing and account; presence only
  for the RP password, which the default read no longer decrypts. Audited `read_pre_app_secrets:last4`
  for everyone. There is no `full` tier.
- A **reveal** names one field (`owner_ssn` + owner, `aba_routing`, `account_number`,
  `rp_password`, `tax_id`). Admin only: the role check runs before any record is looked up, so a
  rep gets one identical 403 for every id. Then the pre-app and owner through the caller's client
  (404), the ciphertext's existence ("Not on file", 404, no audit), then
  `record_pre_app_secret_reveal()` through the caller's client, and only then the decrypt. An RPC
  error returns 500 with no value; the limit returns 429 with the function's sentence.
- `record_pre_app_secret_reveal(pre_app_id, field, owner_id)`: `security definer`, `is_admin()`
  first, one `audit_log` row per call naming the admin (`actor_id`), the pre-app (`row_id`), the
  field (`read_pre_app_secrets:reveal:<field>`, owner SSNs `…:owner_ssn:<owner id>`) and the time
  (`created_at`); no exception handler; 30 per admin per rolling hour under a per-admin advisory
  lock, with a partial index, exactly the `accounts_in_city()` shape.
- The detail page's **Sensitive data** section (`components/pre-app-sensitive-data.tsx`):
  client-fetched, masked for both roles, a per-field Show/Hide for an admin. The wizard's
  Sensitive data step shows last four only, to everyone (no Show there).
- `PreAppSummary` shows every stored column of `pre_apps` and its three children, pinned by a
  render test whose fixtures are typed `satisfies <RowType>`.
- The edit rule: **no gap found, no rule changed.** The guard trigger refuses a rep's parent
  edit at submitted, approved and declined; deletes are admin-only; the children guard and the
  secrets function's 409 cover the rest; an admin edits parent and children at every status but
  never `status` directly. `tests/rls/pre-app-edit-rules.test.ts` pins what was not pinned at
  every status.

Where the memo was silent, and what was chosen (conservative side each time):
- **The audit row and the limit are a SQL function, not an insert from the Edge Function**, so the
  count and the insert are one atomic step per admin, and the reveal's audit row is written
  through the caller's own client (the admin is `auth.uid()`, not a value the function passes).
- **30 reveals per admin per rolling hour.** No admin action was rate-limited before
  (`accounts_in_city` exempts admins), so "the same way" is the same mechanism and the same
  number. A pre-app needs about five to eight reveals to key into a processor portal, so 30 an
  hour is four to six pre-apps; Owen may want it raised.
- **Re-mask after 30 seconds**, and at once on a pathname change, a hidden tab, pagehide and
  beforeprint; Hide masks one field at once.
- **The audit action names the owner for an SSN** (`…:owner_ssn:<owner id>`), beyond the memo's
  `reveal:<field>`, so the trail says whose SSN.
- **Routing and account are separate fields**, so revealing one does not reveal the other.
- **The RP password stays presence-only on the default read for admins too**, and is revealable.
- **A rep's reveal is 403, not 404**, and the same 403 for any id (the check precedes the lookup),
  so it is no id oracle.
- **Not on file is a 404 with no audit row**: nothing was revealed.
- **The default read still writes `read_pre_app_secrets:last4` on every detail-page view**, rep
  and admin, as the wizard step did; the trail now separates a glance from a look.
- **Print pages stay without any secret**, not even last four: the merchant print page and the
  paper form have no data path to them, which is stricter than "masked". The detail page, if
  printed from the browser, prints the masked form (`print:hidden` on the value, a masked twin
  for print, and beforeprint masks the state).
- **The owners' ID-document fields (`id_number` etc.) are shown to both roles**: they are plain
  columns, not secrets-table fields, and the instruction was "every field but the secrets".
- **Summary metadata shown:** the lead it came from, date submitted, created and last updated.
  Not shown as fields: `status` (the badge) and `decline_reason` (the page's callout).

Found while building:
- **Next 16 with `cacheComponents` keeps the route just left in the document, hidden (React
  `<Activity>`), with its state.** Unmounting is therefore not what clears a revealed value on
  navigation; the pathname effect's cleanup is. Removing that one effect left the value in the
  hidden DOM, and on screen again after Back (e2e revert proof). Any later component that holds
  something sensitive in state needs the same cleanup.
- The routing input's placeholder is `021000021`, the routing number most fixtures use, so a
  "nowhere in the HTML" check on the secrets step must use another number.
- A PostgREST bulk insert whose rows differ in keys sends NULL for a missing column rather than its
  default (a test bug here, not an app bug).
- The guard's message reads "a approved pre-app" (existing grammar, not changed).
- The Supabase CLI is still linked to PROD, as phases 1 and 4 found; nothing linked was run.

### Phase 6: import schema (30 Oct 2026, branch `intake-residuals`)

Built (`20261030120000_import_schema.sql`; database only, no Edge Function changed):
- `rep_payout_batches`: `processor` (FK `processors`), `period` (the 1st), set together or not at
  all; `replaces_batch_id` / `replaced_by_batch_id` (self FKs); status gains `replaced`, which
  needs `replaced_by_batch_id` and vice versa. The import window (memo A11) is the trigger
  `guard_payout_batch_period()`: not after the current month, not more than 24 months before it
  (24 back accepted, 25 refused).
- `rep_payout_batches_one_committed_per_month`: unique `(processor, period) where status =
  'committed'`. Review, abandoned and replaced batches are not limited.
- Staging: `warnings text[]` (the three confirmable types) and the six new blocker codes beside
  the five the deployed parser still writes.
- Ledger: `processor` (FK, snapshot of the batch's), `volume_confirmed_negative`, the volume rule,
  and the merge key `(period, processor, agent_id, mid) NULLS NOT DISTINCT where line_kind =
  'import'`. Both commit functions re-created to write `batch.processor` and name the new key;
  nothing else in them changed (pinned by a test that undoes the edits and compares bodies).
- `payout_period_closures (period, processor, closed_at)`: admin SELECT, no client write, no
  UPDATE, no future month, every insert and delete audited by its own trigger.
- `scripts/reset-business-data.sql` clears the new table (36 tables).
- Tests: `tests/rls/import-schema.test.ts` (catalog diff, every rule above, the migration's
  refusals and its pass over a populated database).

**Where the coalesce merge rule lives now, and what phase 8 must change.** The latest definitions
of both functions are in `20261030120000` (§4 of the file): `commit_residual_import(int)` (its one
`on conflict … do update`) and `commit_residual_import_v2(int)` step 3, the ordinary-rows upsert
(`residual_income = coalesce(excluded.residual_income, rep_payout_rows.residual_income)` and the
same for `rep_split_pct`). v2's shared-signer conflict writes no money ("NEVER THE MONEY ON
CONFLICT") and its partner insert is `do nothing`. Phase 8: v3 never merges (plain insert; a second
import of a processor-month is phase 9's replace), drop v2, and rewrite the CLAUDE.md rule line and
Three tiers §3 to say the old function still carries the rule; `tests/rls/commit-residual-import-v2.test.ts`
(which greps for it) goes with v2. Phase 13 drops `commit_residual_import(int)`, its test and the
rule text.

Where the memo was silent or said otherwise, and what was chosen (conservative side each time):
- **`processor` and `period` are nullable in this phase**, though §1.B says `not null`.
  `residual-import-file-url` still creates batches without them until phase 7, and making them
  required now would break the current upload → commit path (and the live and e2e suites that
  drive it). Instead: together-or-neither, FK, first-of-month and the window apply to every value
  written. **The phase that makes them `NOT NULL` must first refuse, naming the ids, any committed
  batch that has none.**
- **So this migration has no batch row it cannot carry.** Every new batch column is nullable and
  every new batch CHECK passes on a row that has none of them. Its refusals are what it can
  actually break: a ledger line with a negative volume (only possible where the old CHECK was
  altered by hand; named by id), and four preconditions on the definitions it replaces (merge key,
  volume CHECK, status CHECK, blocker CHECK). No empty-table assertion (§8.1), per the phase 1
  lesson.
- **The window is a trigger, not a CHECK**: a CHECK reading the clock passes on insert and refuses
  the same row on a restore years later. It checks the period only when it is written. "Current
  month" is UTC, pinned rather than read from the session's TimeZone.
- **`replaced` is added now** (§8.1 puts it in phase 6, §8.4 in phase 9): a replaced batch must
  leave the one-committed rule, so the status is part of the rule's shape. Phase 9 still owns the
  replace itself and the definer-side transitions (`committed -> replaced` only, `replaced`
  terminal); the client rule is unchanged (review -> abandoned only), and a client cannot set
  `replaced`.
- **A replace pair cannot point at itself, and a batch that replaces another must carry a
  processor-month.** Not in the memo; cheap and strictly tighter.
- **NULLs distinct in the batch rule, NOT distinct in the merge key.** A batch without a processor
  has no month to be unique on. A ledger line without one (every line today) must still collide
  with its twin, or a re-import would duplicate a month instead of merging it.
- **The volume rule is stricter than §2.4's `volume >= 0 or volume_confirmed_negative`**: it is
  `volume_confirmed_negative = coalesce(volume < 0, false)`, so the marker is allowed only on a
  negative volume and the column says exactly which lines entered that way. Phase 8 must set the
  marker on negative-volume lines only, not on every confirmed `bad_numbers` row (a zero-volume or
  residual-over-volume row stays unmarked). Zero and NULL volume stay allowed unmarked. No existing
  test inserted a negative volume, so none had to be marked; "rejects a negative volume" in
  `rep-payouts.test.ts` still holds (unmarked) and is unchanged.
- **Staging `warnings` and the new blocker codes are in this phase** (§8.1), but the TypeScript
  lists (`PAYOUT_BLOCKERS`, labels) are not touched: they move with the parser in phase 7, which
  also removes the five old codes. The staging raw columns (`processor_raw`, `income_type_raw`) and
  `confirmed_warnings` / `replace_summary` on batches are left to phases 7-9, which write them.
- **`payout_period_closures` has no `closed_by` and no confirmation column**, as §3.2 says (Owen
  confirmed 30 Oct 2026, over the phase 6 instruction's wording). Who marked it is the audit row.
- **The closure audit is a table trigger, not a line in each RPC**, so every verb is audited
  whoever writes (CLAUDE.md's every-verb rule). Phase 9's `close_payout_period()` and
  `reopen_payout_period()` must therefore NOT write their own `close_payout_period` /
  `reopen_payout_period` rows (the trail would double); the reopen's reason goes on its
  `payout_period_reopenings` row. Row id format: `'2026-07-01/TSYS'`.
- **A closure is never UPDATEd and never for a month that has not begun**, enforced by a trigger.
  Phase 9's close function should also require a committed batch for that processor-month (not
  enforced here; phase 9 owns that rule).
- **`close_payout_period()` is NOT built here**, though §8.1 lists it under phase 6: the phase 6
  instruction moved it to phase 9 with Reopen.
- **`service_role` gets SELECT on the closures table**, as `processors`; nothing writes it outside
  a definer function.
- **v2's partner line copies its signer line's processor.** A filter matching the signer line to
  the batch's processor was written first and taken out: the partner's conflict target already
  separates processors, so no test could tell it was there.

Not done here, for later phases:
- **Phase 7:** a NULL-processor import line (everything committed before phase 7) and a
  processor-tagged one are different keys now, so a legacy month re-imported under a processor would
  sit beside the old lines. Nothing writes a tagged line before phase 7; its `mid_in_other_batch`
  blocker must count a NULL-processor line as "another processor's".
- **Phase 8:** check a staged row's period against its batch's (v3 takes the month from the batch),
  and write `processor` from the batch on every line, adjustments excepted.

Found while building: PGlite's `service_role` has no BYPASSRLS (the hosted one does), so a test
that reads an admin-only table as `service_role` sees nothing there; `import-schema.test.ts` reads
back as the owner and says why.

---

## 11. Open questions (28 Oct 2026)

Waiting on Owen. None blocks phase 4: the rate column defaults to 50 and every real rate is entered
by an admin after the migration.

1. **Reps who are not at 50.** Names and rates, to be entered by an admin with `set_rep_split` once
   phase 4 is deployed. The house profile (agent code 122) is set to 0 the same way. No rate is
   hard-coded in a migration.
2. ~~Does any rep ever exceed 50?~~ **Closed (§0c.2): no.** 50 is the maximum; the 0-50 CHECKs stay.
3. **Bruce Rozar's effective rate is about 46%.** That suggests his merchants are at different
   rates (some below 50), or an override or adjustment is netting against a 50% split. Which one
   decides whether his profile rate is 50 with a few merchants changed by `set_merchant_split`, or
   a lower profile rate.
4. ~~Report 1 total and deductions.~~ **Closed (§0c.1): not subtracted.** Total = agent split +
   override received; deductions have their own column, labelled "info only, not in total", and
   the test still pins `total + deductions = sum of every line` (§4.5).
