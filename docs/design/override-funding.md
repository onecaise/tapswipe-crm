# Override funding: from the owner's share or from the company's share

Design only (16 Nov 2026). No code, no migration, nothing pushed. Written on branch
`plumlee-bruce-overrides` (after `2701254`). The build branches off master **after** that branch is
merged (§5.4). The owner's decisions of 16 Nov 2026 are recorded in §7.

Read with: `docs/claude/payouts-and-teardown.md` (Overrides, Reports, Replace / Mark paid),
`docs/design/intake-and-reports.md` §4 and phase 10, and `20261102120000_merchant_overrides.sql`.
The functions this design changes were last defined in these migrations:

| Function | Latest definition |
| --- | --- |
| `commit_residual_import_v3` | `20261111120000_iso_hub_files.sql` |
| `delete_payout_period`, `post_payout_adjustment` | `20261106140000_alphanumeric_mids.sql` |
| `set_merchant_override`, `end_`, `cancel_`, `my_override_recipients` | `20261102120000_merchant_overrides.sql` |
| `rep_payout_summary`, `merchant_processor_summary` | `20261102160000_reports.sql` |
| `close_payout_period` | `20261030190000_replace_paid_adjustments.sql` |

## 0. The business change (decided by the owner)

An override is paid from one of two places, chosen **per override**:

| | Recipient | Owner (rep side) | Company |
| --- | --- | --- | --- |
| **Owner-funded** (how the CRM works today) | 5 | 45 of the 50 | 50 |
| **Company-funded** (how ISO Hub pays application overrides) | 5 | the full 50 | 45 |

(The figures are a $100 residual, a merchant rate of 50 and a 5% override.)

**Update, 16 Nov 2026: every existing override becomes company-funded**, the Lamar County Justice
Court 25% to Plumlee included. A single override can be switched back to owner-funded afterwards
under the same audited, admin-only rule (§4).

---

## 1. Schema

### 1.1 `merchant_overrides.funded_by`

```sql
alter table merchant_overrides
  add column funded_by text not null default 'owner'
    constraint merchant_overrides_funded_by check (funded_by in ('owner', 'company'));
alter table merchant_overrides alter column funded_by drop default;
```

- **The backfill is `'owner'`, on purpose.** That is how every existing override was actually paid:
  every committed override line was worked out with an owner debit. The owner's decision to move
  them all to the company is then applied by the audited data change in §4, not by the migration.
  A migration that wrote `'company'` would make the table disagree with the committed ledger, with no
  audit row and no paid-month check.
- **The default is dropped in the same migration**, so nothing can create an override without saying
  who pays it. The column is never inferred.
- No new FK. `profiles` still has **twenty-six** references, so `tests/rls/user-imports.test.ts` and
  the teardown lists do not change (§5.1).
- Grants are unchanged: `authenticated` SELECT, `service_role` SELECT and DELETE, nobody INSERT or
  UPDATE. The column is written only by the definer functions.

### 1.2 `set_merchant_override` takes the funding as a required argument

```
set_merchant_override(merchant_id_input int, recipient_id_input uuid,
                      override_pct_input numeric, effective_from_input date,
                      funded_by_input text) returns int
```

- `funded_by_input` is **required**. NULL raises the existing "Every field is required…" 22023
  error, with "and who pays it" added to the message. A value other than `owner` or `company` is
  rejected with 22023, "Paid from must be the owner's side or the company's share." The function
  never picks a value itself, just as it never guesses the recipient.
- **The old four-argument function is DROPPED in the same migration** (`drop function
  set_merchant_override(int, uuid, numeric, date)`). `create or replace` with a fifth argument
  creates an *overload*. The old signature would stay callable with its old meaning, and any caller
  still using it (including `scripts/add-plumlee-bruce-overrides.sql`) would quietly create overrides
  with no stated funding. The new function needs its own `revoke all … from public` /
  `revoke … from anon` / `grant execute … to authenticated, service_role` lines.
- When "Change the override" ends the open override and starts a new one, the new one takes the
  funding passed in. **It does not inherit the old one's funding.** The form asks again (§3).
- The audit row is still `set_merchant_override`. Its `detail` becomes `funded_by=owner` or
  `funded_by=company`, so the history shows the choice without a join.
- All other rules stay as they are. The rules that held "because it comes out of the owner's side"
  are listed in §6, decisions D1 and D2. **This design keeps them for both modes** (cap ≤ the
  merchant's rate, rate > 0, no recipient who is the owner or a share party, no move while live), so
  the only new branch is in the arithmetic.

### 1.3 `rep_payout_rows.override_funded_by`: a snapshot on every override line

```sql
alter table rep_payout_rows add column override_funded_by text;   -- no default
```

The funding is **snapshotted on the line**, exactly as `override_amount` and `rep_split_pct` are.
A committed month's figures never depend on the current state of `merchant_overrides`. The reports
read the snapshot, and a later funding change shows as "the ledger disagrees with the override"
until the month is replaced (§4.3). It is never silently reinterpreted.

---

## 2. The ledger, commit v3 and the other functions

### 2.1 The lines a company-funded override writes

For a file row with residual `R`, merchant rate `s` and override `o` in force:

```
T = round(R × s / 100, 2)   the rep side, on the import line(s), exactly as today
X = round(R × o / 100, 2)   the override, once, from the account residual, exactly as today
```

| Line | Owner-funded (today, unchanged) | Company-funded (new) |
| --- | --- | --- |
| Owner's import line (or signer + partner) | `rep_payout` = `T` | `rep_payout` = `T` |
| Owner's override **debit** | `-X` (shared: signer `-(X - x_p)`, partner `-x_p`) | **none** |
| Recipient's override **credit** | `+X` | `+X` |
| `override_funded_by` on each override line | `'owner'` | `'company'` |
| Company share (not a ledger line) | `R - T` | `R - T - X` |

So a company-funded override is **one line**: the recipient's credit. There is no debit line to
anyone. In particular, there is no debit to the house profile (agent 122, Tapswipe), for these reasons:

- The company's share has never been a ledger line. Adding one for this case only would make the
  house profile's Report 1 row show a negative split.
- It would put a company figure on a rep-shaped profile.
- It would change what `rep_payout_rows` means.

The company's share is what the reports compute: the residual minus what the ledger pays.

On a shared account nothing is divided. There is no deduction to share, so the signer keeps
`T - p` and the partner keeps `p`, exactly as with no override.

### 2.2 The invariant, to the cent

**Claim.** For every file row, owner line(s) + override line(s) + company share = `R`, to the cent,
in both modes.

All quantities are `numeric(14,2)`, which is exact decimal. `round(·, 2)` returns whole cents. Sums and
differences of whole cents are whole cents, with no float error.

- **Owner-funded, unshared:** owner lines `T + (-X)`, override lines `-X + X`, company `R - T`.
  Paid to people: `(T - X) + X = T`. With the company: `T + (R - T) = R`. ∎
- **Owner-funded, shared:** the signer's `T - p` plus the partner's `p` equals `T`. This is the
  existing generated column with the `shared_part()` cent rule, already proved. The debits are
  `-(X - x_p)` and `-x_p`, which total `-X`. So again `T - X + X + (R - T) = R`. ∎
- **Company-funded (shared or not):** the owner (or the pair) holds `T`, the recipient `X`, and the
  company `R - T - X`. The total is `T + X + (R - T - X) = R`. ∎

The company's share is defined as a difference, so the identity holds by construction. **What the tests must
actually pin is that the ledger writes exactly these lines**: no debit on a company-funded override,
exactly one credit of `X`, and debits summing to `-X` on an owner-funded one. The reports must then
subtract exactly the company-funded credits.

**The sign of the company's share** (worth knowing, not a defect): if `R ≥ 0`, then
`R - T - X ≥ R(1 - (s + o)/100) - 0.01`, because each rounding is at most +0.005. The result is a whole
number of cents, so it is ≥ 0.00 whenever `s + o < 100`. Under the kept cap (`o ≤ s ≤ 50`),
`s + o = 100` happens only at `s = o = 50`. On an odd-cent residual, that case gives a company
share of **-0.01** (e.g. `R = 0.01`: `T = 0.01`, `X = 0.01`). A clawback mirrors this, because rounding
is half away from zero. The identity still holds. A test pins the edge so nobody "fixes" it into a
broken sum.

### 2.3 Every ledger CHECK, index and generated column the new case touches

| Object | Change |
| --- | --- |
| `rep_payout_rows_override_columns` | **Rewritten.** It now covers four columns that are set together, on override lines only: `override_id`, `override_role`, `override_amount` **and `override_funded_by`**, plus `processor is not null and rep_share_id is null` as today. The migration first checks the existing definition text against the expected 20261102120000 text and refuses to run on anything else (the 20261102120000 pattern). |
| **new** `rep_payout_rows_override_funded_by` | `override_funded_by is null or override_funded_by in ('owner', 'company')` |
| **new** `rep_payout_rows_company_override_no_debit` | `not (override_funded_by = 'company' and override_role = 'debit')`. A company-funded override never has a debit line. A CHECK sees one row, so "an owner-funded override has debits totalling -X" stays the commit's job and the property tests'. |
| `rep_payout_rows_override_role` (`debit`/`credit`) | unchanged |
| `rep_payout_rows_line_kind` | unchanged (no new line kind) |
| `rep_payout_rows_adjustment_columns`, `rep_payout_rows_adjustment_no_figures` | unchanged. An override line still carries a batch and no figures, and an adjustment never carries `override_funded_by` (covered by the rewritten `_override_columns`). |
| `rep_payout_rows_share_snapshot` | unchanged (override lines carry no share columns) |
| `rep_payout_rows_override_line_key` (unique `batch, override, role, agent` where override) | unchanged. A company-funded override writes one row per batch under it. |
| `rep_payout_rows_import_merge_key` | unchanged (import lines only) |
| generated `rep_payout` | **unchanged, not dropped and re-added.** The override branch is still `override_amount`. This avoids the drop-and-re-add rewrite risk the last two ledger migrations had to guard against. |
| `merchant_overrides_funded_by` | new (§1.1) |

**Backfill of existing override lines** (in the migration, as the owner role):
`update rep_payout_rows set override_funded_by = 'owner' where line_kind = 'override'`, then the
new CHECKs. The migration checks the following before and after, and refuses on any mismatch:

1. **The backfill is true.** For every `(batch_id, override_id)` among the existing override lines
   there is exactly one credit and at least one debit, and the debits sum to minus the credit.
   The migration names any batch/override that breaks this; it does not paper over it.
2. **Nothing moved.** The count, the total and a per-row md5 of `rep_payout` are compared before and
   after (the 20261102120000 pattern). The update touches only `override_funded_by` and `updated_at`.
   The `rep_payout_rows_set_updated_at` trigger moves `updated_at` on those lines, and that is the
   only side effect. `log_payout_row_change()` records only residual/rate changes, and
   `guard_client_payout_update()` refuses only `authenticated`/`anon`.

**Confirmed: every existing committed override line is backfilled and satisfies every new CHECK.**

- **Which lines exist.** Override lines exist only on `committed` batches:
  - v3 writes them on commit;
  - a replace deletes the old batch's lines (`batch_id`);
  - `delete_payout_period` deletes them with their import lines;
  - `rep_payout_rows_adjustment_no_figures` requires a batch on every override line, so there is no
    detached one.

  The backfill's `where line_kind = 'override'` therefore covers exactly the August and September
  2026 override lines (and any earlier month's) on prod, with no batch-status filter needed.
- **The rewritten `rep_payout_rows_override_columns`** requires `override_funded_by is not null` on
  override lines and `is null` on every other line. Every override line is set to `'owner'` by the
  backfill, and no import or adjustment line is touched. Both sides hold.
- **`rep_payout_rows_override_funded_by`** requires `'owner'` or `'company'`. Every value is `'owner'`.
- **`rep_payout_rows_company_override_no_debit`** forbids a company-funded debit. No line is
  `'company'` after the migration. Lines become `'company'` only when v3 writes them, and v3 never
  writes a company debit.
- **How it is proved, not assumed.** All three constraints are added **after** the backfill and
  **validated** (plain `add constraint`, never `NOT VALID`). Postgres therefore checks every
  existing row, and any failure rolls the whole migration back, so it cannot half-apply.
- **Checked again by the migration.** Before the constraints are added it also asserts, naming
  counts only:
  - `count(*) where line_kind = 'override' and override_funded_by is null` = 0;
  - `count(*) where line_kind <> 'override' and override_funded_by is not null` = 0;
  - and check 1 above (every pair is a true owner-funded pair).

  `npm test` replays the migrations, and the new test's `migrationsBefore()` case seeds August-like
  lines first, so both prove this on a populated ledger, not an empty one.

### 2.4 `commit_residual_import_v3`: step 6 only

Every refusal and warning in steps 1-4 stays as it is. The override backstops are kept for both
modes, because this design keeps the rules for both (D1, D2). In step 6:

- `applied` also selects `o.funded_by`.
- `pieces`: `partner_piece` is computed only when `funded_by = 'owner'`.
- `lines`: the signer/owner debit and the partner debit are emitted **only `where funded_by =
  'owner'`**. The credit is emitted for both.
- The insert writes `override_funded_by = funded_by` on every override line.
- The result's `overrides` key still counts credits (one per file row an override applied to). A new
  key, `company_overrides`, counts those with `funded_by = 'company'`, so the commit toast can say
  so. Both are additions; nothing that reads the result breaks.

On a **replace**, step 5 still deletes the old batch's lines, override lines included. Step 6 then
writes them again from the override **as it is now**, and a funding change takes effect at that
point (§4.3). Nothing else in v3 changes. Its revoke/grant lines are restated as usual.

### 2.5 `delete_payout_period`: no change

It deletes `line_kind in ('import', 'override')` for the processor-month, which covers credit-only
company-funded lines as well. A new test pins that it leaves none behind.

### 2.6 `post_payout_adjustment`: no change

An adjustment carries no override and no funding. This design does not use adjustments for the
funding change on a paid month; it requires a Reopen (§4.2, D6). The function still matters to the
runbook: a replace is refused while an adjustment adjusts that month (v3's adjustment block), so
§4.4 checks for one before reopening anything.

### 2.7 `close_payout_period`: one new refusal (recommended, D5)

Mark paid is refused (PT409) while a committed processor-month's override lines disagree with their
overrides' current funding, with the message: "Overrides on … changed who pays them after this month
was committed. Replace the month first." Without this check, a month could be marked paid on stale
figures, and only an adjustment could then correct it.

### 2.8 The two report functions

**`rep_payout_summary` (Report 1): no SQL change.** `agent_split` is import `rep_payout` plus the
rep's override **debits**, and a company-funded override has none, so the owner's split is the full
`T`. `overrides_received` is credits, which are unchanged. `total_commission = split + received` is
unchanged. Its header comment is restated with one sentence about company-funded overrides.

**`merchant_processor_summary` (Report 2): one new column, so the function is dropped and recreated**
(a change of return type cannot be done with `create or replace`). The new column is
`company_overrides`: the sum of the MID's committed `override_funded_by = 'company'` credit lines
in that processor-month. The override line carries `period`, `processor`, `mid` and `batch_id`, and
the same "batch committed" filter applies. Then:

```
rep_side          = sum(rep_payout) over import lines        (unchanged: the merchant's rate of R)
company_overrides = sum(override_amount) over company-funded credit lines   (new)
company_share     = residual - rep_side - company_overrides  (was residual - rep_side)
```

So each Report 2 row reads `residual = rep side + overrides from company + company share`.
An owner-funded override still moves money only inside the rep side and does not appear in Report 2.
The function stays security invoker, `is_admin()` first, with a pinned search_path and its
revoke/grant lines, and the `prosecdef = false` test still holds. The page, `MERCHANT_FIGURES` in
`supabase/functions/_shared/report-sheets.ts` ("Overrides from company") and the `export-report`
function change with it. **This means `export-report` must be redeployed** (D8).

**The report identity, both modes:**
Σ(split + received) + Σ company share = Σ T − Σ X_owner + Σ X_all + Σ (R − T − X_company) = Σ R,
because `X_all = X_owner + X_company`. `tests/rls/reports.test.ts`'s random identity test gains the
company mode.

### 2.9 Visibility: no new read paths

- **Owner of a company-funded override:** no debit line, so no override shows on their statement,
  and `my_override_recipients()` (debits only) does not name the recipient. Nothing is taken from
  them, so nothing is explained to them. This is D3.
- **Recipient:** no change. They see the credit, labelled "Override received", with the merchant
  name as text.
- **Admin:** the override detail (Report 1's plus, `loadOverrideDetail`) names the debtors of a
  credit. For a company-funded credit it says **"Tapswipe (company share)"** instead of an empty name.
  This needs `override_funded_by` added to that select. On a statement page, an admin's credit label
  gains "· from the company's share". `lib/payouts.ts` `PAYOUT_ROW_COLUMNS` gains the column.
- `export-residuals`: no change. Its header is the pinned memo §2.6 header, and the override line is
  still `Line = Override`.

---

## 3. UI: the override card (`components/merchant-override-card.tsx`, `lib/overrides.ts`)

**The form** (`SetOverrideForm`) gains a required **"Paid from"** choice: a radio group of two
options, **with neither selected**. It goes under the percent and before the worked example:

- ( ) **The owner's side**: "comes out of {owner}'s {rate}% rep side"
- ( ) **The company's share**: "the owner keeps the full {rate}%; the company pays it"

Save stays disabled, and the problem line reads **"Choose who pays it: the owner's side or the
company's share."**, until one option is chosen. The choice resets after a save, so the next override
starts blank again.

**The worked-example line** (`overrideExample(pctHundredths, rate, fundedBy)`) is recomputed on every change:

| State | Line under the form ($100 residual, rate 50, override 5) |
| --- | --- |
| no choice yet | "Choose who pays it: the owner's side or the company's share." |
| owner | "On a $100 residual: the recipient gets $5.00, the owner keeps $45.00 of the $50.00 rep side, and the company keeps $50.00." (today's sentence) |
| company | "On a $100 residual: the recipient gets $5.00, the owner keeps the full $50.00 rep side, and the company keeps $45.00 of its $50.00." |

**The in-force text** names who pays:
"In force: 5% of residual to Bruce Rozar, **paid from the company's share**, from January 2026."
or "… **paid from the owner's side** …".

**Each `OverrideRow`** gets a line, "Paid from the company's share" or "Paid from the owner's side".
It also gets a third control, **"Change who pays"** (beside End and Cancel), which opens:

- the other choice, stated in words ("Switch to: paid from the owner's side");
- a **Reason** field, required, 10-500 characters (D4), stored in the audit row;
- a list of the committed months this override already touched, each with its state. A month
  marked paid is shown with "Reopen it first" and blocks the change. The others show "will need
  a replace to take effect";
- a confirm pair calling `set_merchant_override_funding` (§4.1). On success, the card lists the
  processor-months to replace.

**The card's intro paragraph** now says "…taken out of the owner's side **or paid from the company's
share**…". The sentence "the company's share never changes" is removed, because it is no longer
always true. **`parseOverridePct`**'s cap message changes from "comes out of the rep side, so" to
"cannot be more than this merchant's rate" (D1 keeps the cap in both modes).

**`/payouts`, Processor months (admin)**: a processor-month whose override lines disagree with their
overrides' current funding shows **"Override funding changed: replace this month to apply"**, with
the number of overrides. Mark paid is disabled there, and the database refuses it too (§2.7).

---

## 4. Existing data: changing the funding of an override

### 4.1 `set_merchant_override_funding(override_id_input int, funded_by_input text, reason_input text) returns jsonb`

This is the only way to change `funded_by` after creation. Overrides are otherwise still not
editable; their history is still new overrides plus end and cancel.

- `security definer`, `search_path = public, pg_temp`, **`is_admin()` first** (PT403). It has its own
  `revoke all … from public` / `revoke … from anon` / `grant execute … to authenticated,
  service_role` lines.
- Arguments: the override (PT404 if missing); `funded_by_input` in (`owner`, `company`) (22023); a
  reason, trimmed, 10-500 characters (22023). The same value as now returns `{changed: false}` and
  writes nothing, like `set_merchant_split`.
- **Locks, in v3's order, to avoid deadlocks.** It reads the override's touched processor-months
  (below), takes each `tapswipe.residual_month:<processor>/<period>` advisory lock in sorted order,
  and then the share lock. It then reads the set again and refuses with "A month was committed
  meanwhile, try again" if it grew. After that, no commit, replace, delete, Mark paid or other
  override change can interleave.
- **Touched months** = the distinct `(period, processor)` of this override's lines on `committed`
  batches. Lines on replaced or deleted batches are already gone, and a batch in review has none.
- **Refused (PT409) if any touched month is marked paid** (`payout_period_closures`). The error names
  each month: "TSYS September 2026 is marked paid. Reopen it (with a reason) before changing who
  pays this override."
- **Switching to `owner`** re-checks the rules that owner funding needs, against the merchant as it
  is now: rate not NULL and > 0, `o ≤ rate`, recipient not the owner and not a party to an
  overlapping share. Under D1 and D2 these already hold for every override, so these are
  backstops. They are kept so that if D1/D2 ever relax company funding, switching back is still
  safe.
- Writes `merchant_overrides.funded_by` (as owner; no client UPDATE grant exists), then **one audit
  row** with `action = 'set_override_funding'`, `table_name = 'merchant_overrides'`,
  `row_id = <id>` and `detail = '<old> -> <new>; replace: TSYS 2026-08, Square 2026-09; reason: …'`.
  It has **no exception handler**: if the audit insert fails, the change fails (it fails closed).
- Returns `{changed, from, to, replace: [{processor, period, batch_id}, …]}`.
- **It never touches `rep_payout_rows`.** The ledger is changed only by a commit, a replace, a
  delete or an adjustment line. "Never edit a committed line" still holds.

### 4.2 The paid-month rule

A funding change is allowed only while **no month it touches is marked paid**. For a paid month, the
order is:

1. **Reopen** the processor-month on `/payouts` (`reopen_payout_period`, with a 10-500 character
   reason, audited on the closure row). The reason is Reopen's only requirement.
2. Change the funding (§4.1).
3. Replace the month (§4.3).
4. Mark paid again. `close_payout_period` refuses while the month is still stale (§2.7).

### 4.3 How committed months pick the change up: replace

The override lines on a committed batch carry `override_funded_by` as it was **at commit**. After a
funding change they disagree with the override, and the month shows as needing a replace (§3).
The admin replaces it the existing way: upload the processor's file for that month again and answer
**Yes** to replace. This is `residual-import-file-url` with `replace_batch_id`, then read, review,
and `commit_residual_import_v3` on the replacing batch. Step 5 deletes the old batch's lines,
including its override lines, and step 6 writes them again with the current funding. A new admin-only
invoker function lists the stale months for the UI and the runbook:
`override_funding_pending()` → `(processor, period, batch_id, override_count)`. It is `is_admin()`
first, with its own revoke/grant lines, and needs no new grant because admins already read both
tables.

**The month rule still holds for everything else.** A replace reads the same override (same
recipient, percent and months), because no override boundary can move at or before a committed
month. The funding is the one deliberate exception, and that is why it has its own audited function,
the paid-month refusal and the stale flag.

### 4.4 The one-off for the 92 existing overrides (runbook, dev first, then prod)

**The count is 92** (decided 16 Nov 2026): 88 overrides on Plumlee LLC merchants paid to Bruce
Rozar (103), 3 paid to Sherwin Anderson (105), and the Lamar County Justice Court 25% paid to
Plumlee LLC (108). All 92 become company-funded.

**Pre-check count**, `scripts/set-override-funding-company-counts.sql` (read-only, SQL Editor, no
names, emails or ids): one row per recipient's `agent_number` × `funded_by`, with columns:

- `overrides`: the total;
- `on_plumlee_merchants`: those whose merchant is owned by the `llc_legal_name = 'Plumlee LLC'`
  profile;
- `live`: according to `merchant_has_live_override()`;
- `with_committed_lines`;

plus a total row. The expected result before the change:

| recipient | funded_by | overrides | on_plumlee_merchants |
| --- | --- | --- | --- |
| 103 | owner | 88 | 88 |
| 105 | owner | 3 | 0 |
| 108 | owner | 1 | 0 |
| **total** | | **92** | **88** |

After the change, the same rows read `company`. The same file also holds the other read-only
pre-checks in step 2 below, so a single paste answers all of them.

`scripts/set-override-funding-company.sql` is a SQL Editor one-off with the same shape as
`scripts/add-plumlee-bruce-overrides.sql`:

- It ships as a **dry run** (`do_commit := false`), so the report comes back as a rolled-back error
  that starts with "DRY RUN".
- `expected_count constant int := 92`. The script **counts the overrides on the project it is run
  against** and asserts that the number found is exactly `expected_count`. The dry-run report
  **prints the number found** (with the per-recipient breakdown above) whether or not it matches.
  A mismatch aborts before anything is written, and the message says "found N, expected 92". It
  never takes "every override there is" as the count. On dev, the constant is edited to dev's own
  number, which the counts file shows.
- It takes `lock_timeout 10s` and, as the admin, uses a transaction-local role `authenticated` plus
  JWT claims.
- It calls `set_merchant_override_funding(id, 'company', '<reason>')` **for every override**. It
  never updates the table directly.
- It aborts before writing if any of these fail:
  - the count matches;
  - no touched month is marked paid. Otherwise it lists the blocking processor-months and stops;
  - no override is already `'company'`. A re-run then reports "nothing to do" instead of writing
    audit rows that change nothing.
- After writing it re-checks:
  - every override is now `'company'`;
  - there are exactly 92 `set_override_funding` audit rows from this run, with the admin as actor;
  - nothing else in `merchant_overrides` moved (byte-for-byte as before, apart from `funded_by`).
- It prints counts and the stale processor-months.
- PGlite and live tests run both files as pasted.

The order of work, in full:

0. **Merge `plumlee-bruce-overrides` into master first** (§5.4). The funding work is a new branch
   off master after that merge.
1. Ship the migration and app together (dev, then prod via `scripts/push-prod-migration.ps1 -DryRun`
   first; functions: `export-report`). Every existing override is then `'owner'`, and every existing
   override line carries `override_funded_by = 'owner'` (§2.3). Nothing is stale.
2. **Pre-checks, read-only, on prod** (the counts file):
   1. **The count by recipient** is the table above: 92 in total.
   2. `override_funding_pending()` is empty.
   3. No adjustment line adjusts August or September 2026 under any affected processor. Such a line
      would refuse the replace.
   4. **Drift check:** no merchant in the August/September batches has changed owner, rate or MID
      since commit. A replace re-pays the whole file from the merchants **as they are now**, not only
      the override lines (§6, R1).
   5. Debits per rep per month, to confirm §4.5's attribution exactly.
3. **Reopen each September 2026 processor-month that any override touched** (the dry run lists them)
   with a reason, e.g. "Overrides move to company funding (owner decision, 16 Nov 2026); replacing
   with the same file." This is the decided route (D6).
4. Run the one-off: dry run (check that it says found 92), then commit.
5. **Replace** each processor-month `override_funding_pending()` lists, August and September, with
   the same files.
6. Compare Report 1 for August and September with ISO Hub's Agent Commissions (§4.5).
7. **Mark paid** the September processor-months again (typed phrase), but only once step 6's
   differences are the expected ones (§4.5).

**Fallback only (D6):** if step 3 or step 5 cannot be done for a September processor-month, for
example because an adjustment already adjusts it, that month stays paid. The difference is then
posted with `post_payout_adjustment` in the open month instead: Plumlee +760.29 and Bruce +126.76,
per affected processor and MID. This needs one variant of §4.1: an override whose touched paid
months are left stale on purpose, recorded in the audit `detail`. It is designed only if it is
needed.

### 4.5 Expected effect on Report 1, and the comparison with ISO Hub

**Where the figures come from:**

- the CRM's two Report 1 exports downloaded on 16 Nov 2026
  (`residual-report-1-2026-0{8,9}-all-processors.xlsx`);
- ISO Hub's `Agent_Commissions_Aug_2026.xlsx` and `Agent_Commissions_Sep_2026.xlsx`
  (`C:\Users\owen\iso-hub-export`), TOTAL AGENT COMMISSION column only. Those files also carry bank
  routing and account columns, which this design does not copy;
- the rule above: a company-funded override removes the owner's debit and leaves the credit.

**The new split is the old split minus the debits the rep holds. Overrides received do not change.**

**Who holds the debits.** This is inferred from the exports and confirmed exactly by pre-check 2.5
before it is relied on. Every rep's split is half their net residual, apart from per-line rounding,
except Plumlee and Bruce:

| Month | Plumlee: net/2 − split | Bruce's credits | Bruce: net/2 − split | Plumlee's + Sherwin's credits |
| --- | --- | --- | --- | --- |
| Aug | 4,485.04 − 4,036.57 = 448.47 | 448.49 | 1,044.11 − 949.31 = 94.80 | 81.11 + 13.71 = 94.82 |
| Sep | 7,603.06 − 6,842.94 = 760.12 | 760.29 | 1,626.70 − 1,499.96 = 126.74 | 111.86 + 14.90 = 126.76 |

So **Plumlee's merchants fund Bruce's 88 overrides**, and **Bruce's merchants (Lamar County Justice
Court and the three behind Sherwin's credits) fund Plumlee's and Sherwin's**. Sherwin holds no debit.
The few cents of difference are the per-line half-cent rounding of the import lines. The debit totals
below equal the credits exactly, as v3 writes them.

| Rep | Month | Agent split now → after | Override received | **Total agent commission now → after** | Change | **ISO Hub** | CRM after − ISO Hub |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Plumlee LLC (108) | Aug | 4,036.57 → **4,485.06** | 81.11 | 4,117.68 → **4,566.17** | +448.49 | **5,786.65** | **−1,220.48** |
| Bruce Rozar (103) | Aug | 949.31 → **1,044.13** | 448.49 | 1,397.80 → **1,492.62** | +94.82 | **1,170.31** | **+322.31** |
| Sherwin Anderson (105) | Aug | 13,489.58 (unchanged) | 13.71 | 13,503.29 (unchanged) | 0.00 | **13,503.13** | +0.16 |
| Plumlee LLC (108) | Sep | 6,842.94 → **7,603.23** | 111.86 | 6,954.80 → **7,715.09** | +760.29 | **11,135.17** | **−3,420.08** |
| Bruce Rozar (103) | Sep | 1,499.96 → **1,626.72** | 760.29 | 2,260.25 → **2,387.01** | +126.76 | **1,715.27** | **+671.74** |
| Sherwin Anderson (105) | Sep | 12,837.95 (unchanged) | 14.90 | 12,852.85 (unchanged) | 0.00 | **12,852.67** | +0.18 |

The "all reps" total commission rises by the total of overrides received: August $29,341.69 →
**$29,885.00** (+543.31) and September $32,878.28 → **$33,765.33** (+887.05). Report 2's company
share falls by the same amounts, and the new "Overrides from company" column shows them. No other
rep's row changes. The replace re-reads the same files, so volume, net residual and the other reps'
splits are unchanged, provided pre-check 2.4 finds no drift.

**How close "exact" can be.** ISO Hub rounds its totals differently from the CRM, which rounds every
line. Across every rep this change does not touch (all of them except 103 and 108), the CRM and ISO
Hub differ by up to **$0.46 in August** (Jonathan Pope 133; Taylor Thomas 111 is −0.42) and
**$0.18 in September** (Sherwin). Sherwin is one of those: his +0.16 / +0.18 is rounding, and this
change does not move it. "Lands on ISO Hub" below therefore means **within that rounding band**,
not to the cent.

**Plumlee (108): does NOT land on ISO Hub. The change narrows the gap but leaves −$1,220.48
(August) and −$3,420.08 (September).**

The brief asked this design to say Plumlee should land exactly. The two ISO Hub files do not
support that. In ISO Hub, Plumlee is paid **$1,301.61 (Aug) / $3,532.11 (Sep)** above half of
Plumlee's CRM net residual (8,970.08 / 15,206.12). In the CRM, the only addition to Plumlee's 50% is
the Lamar override (81.11 / 111.86). That override is the same amount in both systems, and Plumlee
holds no other debit after the change. So **no choice of override funding can close this gap**. Its
cause is outside this design, and the most likely ones are:

- ISO Hub credits Plumlee on merchants the CRM pays to someone else, such as the house account
  (122, $54,068.40 net in August at rate 0) or another rep;
- or overrides to Plumlee that the CRM does not have. A house merchant at rate 0 cannot carry an
  override under D1.

**This must be explained before step 7 (Mark paid September again).** The next step is ISO Hub's
per-MID agent report for Plumlee (the `AgentResidualReportLumpSum` export) for August and September,
compared MID by MID with the CRM's Plumlee lines and with the credits Plumlee receives.

**Bruce (103): stays above ISO Hub by $322.31 (Aug) / $671.74 (Sep)**, itemized:

| Item | Aug | Sep | Why |
| --- | --- | --- | --- |
| Lamar County Justice Court, 25% to Plumlee | 81.11 | 111.86 | Company-funded here, so Bruce keeps his full 50%. Owner-funded in ISO Hub: Bruce is at 50% with the 25% coming out of his side (change-log row 273). |
| Sherwin's 3 overrides | 13.71 | 14.90 | Company-funded here. Owner-funded from Bruce's side in ISO Hub. |
| The 79 Plumlee overrides ISO Hub doesn't have | 227.49 | 544.98 | The CRM pays Bruce 5% on all 88 Plumlee merchants. ISO Hub pays him on 9. These amounts are the remainder, and equal **today's** gap (CRM now − ISO Hub: 1,397.80 − 1,170.31 = 227.49; 2,260.25 − 1,715.27 = 544.98), to within ISO Hub's rounding. Pre-check 2.5 can give them exactly as the sum of Bruce's credits on those 79 merchants. |
| **Total** | **322.31** | **671.74** | |

So the change **widens** Bruce's difference from ISO Hub by the Lamar and Sherwin items, and that is
expected. The owner chose company funding for all 92, so the CRM deliberately differs from ISO Hub
on Lamar and on Sherwin's 3. The 79-override difference was already there and comes from the 5%
on every Plumlee merchant (`0b2e1d9`), which this change does not touch. That implies 9 overrides
in ISO Hub worth about 221.00 (Aug) / 215.31 (Sep) to Bruce (448.49 − 227.49; 760.29 − 544.98).

**Sherwin (105): unchanged, and within rounding of ISO Hub** (+0.16 / +0.18) before and after.

---

## 5. What else changes

### 5.1 Teardown lists, `reset-business-data.sql`, grants inventory

- **Teardown lists: no change.** CLAUDE.md / `payouts-and-teardown.md` actually name **four**:
  `scripts/seed-local-users.mjs`, `tests/live/helpers/stack.ts`, `e2e/fixtures/seed.ts` and
  `seed-dev-local.mjs`. There is no new table and no new `profiles` FK (`funded_by` is text), so the
  count stays at twenty-six and the clearing order is unchanged. Company-funded overrides write fewer
  ledger rows; they do not add a new kind. The teardowns' "override lines first" step deletes by
  `override_id`/`batch_id`, which covers credit-only lines.
- **Fixtures that insert into `merchant_overrides` directly break** on `funded_by not null` and must
  name it: `tests/fixtures/reset-business-data-seed.sql`, `tests/live/helpers/stack.ts`, and the
  direct inserts in `tests/rls/lock-residuals.test.ts`, `tests/rls/reports.test.ts`,
  `tests/rls/merchant-overrides.test.ts`, `tests/rls/reset-business-data.test.ts`, and both
  `add-plumlee-bruce-overrides` tests.
- **`scripts/reset-business-data.sql`: no change** (no new table; `merchant_overrides` is already in
  `clear_tables`).
- **Grants inventory (`docs/claude/grants-inventory.md`, `tests/helpers/grants-inventory.ts`): no
  table grant changes.** No new table, no new sequence, and `merchant_overrides` keeps `authenticated`
  SELECT / `service_role` SELECT, DELETE. The *function* surface changes:
  - `set_merchant_override` loses its four-argument form and gains the five-argument form;
  - `set_merchant_override_funding(int, text, text)` and `override_funding_pending()` are new;
  - `merchant_processor_summary` is recreated, so its grants are re-stated.

  `tests/rls/grants.test.ts` ("no function EXECUTE for anon/PUBLIC") covers them automatically. The
  migration text must carry each revoke/grant pair.
- **Spec first:** `docs/tapswipe_crm_schema.sql` gets the block (OVERRIDE FUNDING, this migration)
  before the migration copies it verbatim, per the house rule.
- **Docs:** `payouts-and-teardown.md` (Overrides, Reports), the CLAUDE.md rule lines on overrides
  ("An override is at most the merchant's rate…", the Report 2 sentence) and the `docs/claude` index
  line for this memo.

### 5.2 Test files that change

| File | Why |
| --- | --- |
| `tests/rls/merchant-overrides.test.ts` | Every `set_merchant_override` call gains the fifth argument (one helper). The catalog test asserts the five-argument signature and **that the four-argument one is gone**. The CHECK tests cover the new columns. The random invariant runs in both modes (below). |
| `tests/rls/reports.test.ts` | The worked month gains a company-funded override. The random identity covers both modes. The Report 2 shape gains `company_overrides`, and the mutation proofs include one that drops the new subtraction. |
| `tests/rls/lock-residuals.test.ts` | Direct override inserts name `funded_by`. The new ledger column has no client UPDATE path (the guard still refuses). |
| `tests/rls/shared-lines.test.ts`, `shared-lines-rewrite.test.ts`, `zero-volume-lines.test.ts` | Their constraint-definition snapshots of `rep_payout_rows` (re-run against the new migration set). |
| `tests/rls/user-imports.test.ts` | Unchanged assertion (still 26). Re-run to prove it. |
| `tests/rls/reset-business-data.test.ts`, `tests/fixtures/reset-business-data-seed.sql`, `tests/live/reset-business-data.test.ts` | The fixture inserts name `funded_by`. |
| `tests/rls/add-plumlee-bruce-overrides.test.ts`, `tests/live/add-plumlee-bruce-overrides.test.ts`, `scripts/add-plumlee-bruce-overrides*.sql` | Retired in the migration's commit (§5.4). |
| `tests/live/report-export.test.ts`, `tests/unit/report-sheets.test.ts`, `e2e/admin-reports-export.spec.ts` | The new Report 2 column in the file and the page. |
| `tests/live/residual-import.test.ts`, `commit-concurrency.test.ts`, `override-teardown.test.ts`, `tests/live/helpers/stack.ts` | `set_merchant_override` calls and inserts gain the argument. |
| `tests/unit/overrides.test.ts` | `overrideExample` gains the mode, plus the new label helpers. |
| `tests/unit/payouts.test.ts` | `PAYOUT_ROW_COLUMNS` gains `override_funded_by`. |
| `e2e/fixtures/seed.ts`, `e2e/merchant-override.spec.ts` | The form's required choice. The spec asserts that Save is disabled until "Paid from" is chosen, and that the example line changes with the choice. |

### 5.3 New tests

PGlite (`tests/rls/override-funding.test.ts`) unless noted:

1. **The invariant to the cent, both modes, many random cases through the real v3**: a random `R`
   (including negative, zero and sub-cent-carrying values), random rates and `o ≤ s`, shared and
   unshared, and a random mode. For each row, `owner/pair lines + override lines + company share =
   R`. Owner-funded: debits + credit = 0. Company-funded: **no debit line at all**, exactly one
   credit of `X`, and the owner's lines total `T`. Two seeds, as the existing test uses.
2. **The worked examples:** owner (45 / 5 / 50) and company (50 / 5 / 45) on `R = 100, s = 50,
   o = 5`. A shared account with a company-funded override: the signer and partner are unchanged
   by the override. The −0.01 edge (`s = o = 50`, `R = 0.01`) is pinned.
3. **`set_merchant_override` requires the choice:** NULL is 22023, `'house'` is 22023, the
   four-argument call does not exist (42883), and "Change" does not inherit the old funding.
4. **A funding change:**
   - Audited once, admin as actor, with the reason and the months in `detail`.
   - The table changes and **the ledger does not**. `override_funding_pending()` lists the month,
     and a replace makes the lines match and clears it.
   - Report 1 and Report 2 move by exactly `X` per line.
   - Switching back to owner and replacing restores the original figures to the cent.
5. **Refusals:**
   - a rep (PT403) and anon (no EXECUTE);
   - a missing override (PT404);
   - a bad value or a short reason (22023);
   - **any touched month marked paid** (PT409 naming it), then allowed after Reopen;
   - Mark paid refused while the month is stale (§2.7);
   - switching to owner when the rate has since dropped below `o` (backstop);
   - the ledger CHECKs: a company line with `override_role = 'debit'`, and a line with
     `override_funded_by` but no override.
6. **`delete_payout_period`** removes credit-only lines. **Cancel** is still refused once a
   company-funded line references the override.
7. **The migration's own checks:** the backfill refuses on a hand-made inconsistent pair (a credit
   with no debit), and the nothing-moved md5 holds. This uses `migrationsBefore()`, as phase 10 did.
8. **The one-off script and its counts file**, as pasted, in PGlite and on the local stack:
   - dry run writes nothing and prints the number found with the per-recipient breakdown;
   - commit sets every override to `'company'` with exactly `expected_count` audit rows;
   - a paid touched month aborts the whole run;
   - a project holding one override more or one fewer than `expected_count` aborts, saying "found N";
   - a re-run reports nothing to do;
   - the counts file returns the recipient × funding rows and the total, and writes nothing.
9. **Live** (`tests/live/override-funding.test.ts`): the funding RPC through PostgREST as admin/rep,
   and a replace through the real Edge Functions, with the reports before and after.
10. **e2e:** the card's required radio, the example line for each choice, the in-force wording, the
    "Change who pays" flow with a paid month blocking it, and the stale flag on Processor months.

### 5.4 The `plumlee-bruce-overrides` branch once the four-argument function is dropped

**Assumption:** `plumlee-bruce-overrides` is merged into master **before** the funding work starts,
and the funding branch is cut from master after that merge. On master that branch adds:

- `scripts/add-plumlee-bruce-overrides.sql`, which calls `set_merchant_override(merchant, Bruce, 5,
  2026-01-01)` with four arguments, once per Plumlee merchant;
- `scripts/add-plumlee-bruce-overrides-counts.sql` (read-only; it calls no write function);
- `tests/rls/add-plumlee-bruce-overrides.test.ts` (PGlite);
- `tests/live/add-plumlee-bruce-overrides.test.ts` (local stack);
- the CLAUDE.md baseline bump (3108 tests, 130 files).

**What breaks.** Once the funding migration drops `set_merchant_override(int, uuid, numeric, date)`,
the script fails on its first call with 42883 (function does not exist). Both test files replay
**every** migration and then run the script as pasted, so `npm test` and `npm run test:live` go red.
That is the right outcome: a script that silently created overrides of undeclared funding would be
worse.

**How they are handled: retired in the funding migration's own commit**, so master is never red:

1. **Delete** `scripts/add-plumlee-bruce-overrides.sql`, `scripts/add-plumlee-bruce-overrides-counts.sql`
   and their two test files. The one-off has done its job: the 88 overrides exist on prod, and git
   keeps the files at `0b2e1d9` / `2701254`. Re-running it is never wanted. Every Plumlee merchant
   now has a live override, so it would create nothing anyway, and the new counts file replaces its
   counts file.
2. Do **not** update the script to pass `'company'` instead. It would stay a runnable,
   tested script that creates overrides, kept alive only to be maintained.
3. **CLAUDE.md test baselines** move by the retired files and the new ones. The hermetic file count
   stays at 130 (`add-plumlee-bruce-overrides` out, `override-funding` in), and the
   test counts are recounted from the real run, never estimated. The same applies to the live-suite
   count.
4. A one-line note under Overrides in `docs/claude/payouts-and-teardown.md` records that the
   2026-01 Plumlee → Bruce 5% overrides were created by `scripts/add-plumlee-bruce-overrides.sql`
   (retired; see git `0b2e1d9`) and moved to company funding by
   `scripts/set-override-funding-company.sql`.

**If the order is reversed** (the funding work lands before the Plumlee branch is merged), the merge
itself brings back a script that calls a function that no longer exists. Merging then needs the same
four deletions as a merge-resolution commit. Merge Plumlee first.

---

## 6. Risks

- **R1. A replace re-pays the whole file from today's merchants, not just the override lines.** v3
  reads the current owner, rate and share for every MID. A merchant moved, or re-rated since August,
  would be paid differently on replace, and the funding change would bring that along.
  Merchants with a live override cannot move, but other merchants in the same file can. Pre-check
  2.4 (§4.4) lists any such lines, and the replace should not go ahead until they are explained.
- **R2. September is marked paid (2026-11-16).** The decided route is reopen, switch, replace and
  re-mark paid (D6). If the September money has already been paid out, the extra $760.29 (Plumlee)
  and $126.76 (Bruce) are paid outside the CRM. The adjustment route stays a fallback (§4.4).
- **R3. Plumlee does not reconcile with ISO Hub** (§4.5): −$1,220.48 / −$3,420.08 after the change.
  Override funding cannot close that gap. September should not be re-marked paid until it is
  explained.
- **R4. Deploy window.** The app's `set_merchant_override` call gains an argument at the same moment
  the database drops the old signature. Between the migration and the app deploy, saving a new
  override fails (with an error, never with the wrong funding). Ship them together, or accept a
  short window when nobody is setting overrides.
- **R5. Report 2 changes shape.** `export-report` must be redeployed with the migration, or the
  exported file and the page disagree. The export reads columns by name and would leave the new one
  out, so this does not break silently, but it is stale.
- **R6. Unconfirmed debit attribution.** §4.5's split of who funds whom is inferred from two exports.
  Pre-check 2.5 confirms it exactly, and the table should be re-issued from that query if anything
  differs.
- **R7. The −0.01 company share** at `s = o = 50` on an odd-cent residual (§2.2). This is harmless,
  and the identity holds, but it is visible in Report 2 if it ever happens.
- **R8. The branch order** (§5.4). Merging `plumlee-bruce-overrides` after the funding migration
  brings back a script that calls a dropped function.

## 7. Decisions

**Decided by the owner, 16 Nov 2026:**

| # | Decision |
| --- | --- |
| **D1** | **Cap: "at most the merchant's rate" in both modes** (and rate > 0). Company-funded overrides on rate-0 house merchants stay impossible. |
| **D3** | **The owner does not see a company-funded override on their statement.** The recipient still sees "Override received", and admins see "from the company's share". |
| **D6** | **September: reopen, switch the funding, then replace August and September.** Adjustment lines are a fallback only (§4.4). |
| **D9** | **The count is 92**: 88 on Plumlee merchants to Bruce, Sherwin's 3, and Lamar. A read-only count by recipient is a pre-check, the dry run prints the number found, and the script asserts the exact number found on the target project (§4.4). |

**Still recommended, not yet confirmed:**

| # | Question | Recommendation |
| --- | --- | --- |
| **D2** | Moving a merchant with a live **company-funded** override. It no longer comes out of the owner's side, so the original reason for refusing doesn't apply. | **Keep refusing** in both modes. It is simpler, and switching to owner later can never land on the wrong owner. |
| **D4** | Require a written reason (10-500 characters) to change funding? | **Yes.** It is money, and Reopen already sets the precedent. |
| **D5** | Refuse Mark paid while a month's override lines disagree with their overrides' funding? | **Yes** (§2.7). |
| **D7** | The Plumlee script and its tests. | **Retire them** in the migration's commit (§5.4). |
| **D8** | Report 2's new "Overrides from company" column (and in its Excel export). | **Add it.** Without it a Report 2 row no longer adds up (residual ≠ rep side + company share). |
| **D10** | Replace means uploading the same file again. Would you want a "re-commit from the stored file" button instead? | **Not now.** Re-uploading the original files is the existing, tested path. A button is a separate feature. |
| **D11** | Plumlee's gap to ISO Hub (§4.5). | Pull ISO Hub's per-MID agent report for Plumlee, August and September, and reconcile it MID by MID before re-marking September paid. It is outside this design's change. |

## 8. Open reconciliation questions (16 Nov 2026, read-only analysis)

These results come from the ISO Hub load files (`C:\Users\owen\iso-hub-export\to-load`, August and
September 2026), `Merchants-final.csv`, `Merchant Application.csv`, `overrides-final.csv` and
the Agent Commissions totals. Only residual and commission figures were used. **This note supersedes
§4.5's Bruce itemization**, which assumed Sherwin's 3 overrides were owner-funded in ISO Hub; the
analysis below shows they are not.

**Q1. Plumlee's remaining gap is the 45 Smokes self-overrides, not Smokes #2 alone.**

- Smokes #2 (MID 30119988817) has a residual of 39.00 (Aug) and 233.631 (Sep). Half of that is
  19.50 / 116.82, nowhere near the gap. In the application file, Smokes #2 is one of the **9**
  merchants with Bruce's 5%, not a self-override.
- In `Merchant Application.csv`, **45 of Plumlee's Smokes merchants** name Plumlee LLC as its own
  1st Override at 50%. Their residual is 2,441.000 (Aug) and 6,840.494 (Sep), and **50% of it is
  1,220.500 / 3,420.247**.
- ISO Hub's Plumlee total is reproduced as 50% of Plumlee's net (8,970.082 / 15,206.129) + 25% of
  Lamar + 50% of the 45. That gives 5,786.647 / 11,135.168, against ISO Hub's 5,786.645 /
  11,135.165.
- **This does not equal the gap to the cent:** 1,220.50 against 1,220.48 (Aug) and 3,420.25 against
  3,420.08 (Sep). The residue is the CRM's per-line rounding on Plumlee's own lines (4,485.06 against
  4,485.041; 7,603.23 against 7,603.065) plus 0.006 on Lamar. The merchant set is not wrong, so no
  other combination was searched for.
- The CRM cannot pay this: an override to the merchant's owner is refused. **Question:** confirm that
  the accepted difference is "50% self-override on these 45 Smokes merchants", not "Smokes #2", and
  that the CRM stays at 50% on them.

**Q2. In ISO Hub, Lamar is owner-funded and Sherwin's 3 are company-funded.** The Agent Commissions
files hold agent totals only, with no per-merchant lines or rates. So this is inferred: Bruce's ISO Hub
total is tested against each funding combination, using his net (2,088.218 / 3,253.403), Lamar's
residual (324.424 / 447.424), the residual of Sherwin's 3 (274.104 / 297.880) and the 5% on the 9
application merchants (207.313 / 200.429).

| Funding in ISO Hub | Bruce, Aug | − ISO Hub | Bruce, Sep | − ISO Hub |
| --- | --- | --- | --- | --- |
| Lamar owner, Sherwin's 3 owner | 1,156.611 | −13.70 | 1,700.380 | −14.89 |
| **Lamar owner, Sherwin's 3 company** | **1,170.316** | **+0.003** | **1,715.274** | **+0.000** |
| Lamar company, Sherwin's 3 owner | 1,237.717 | +67.40 | 1,812.236 | +96.96 |
| Lamar company, Sherwin's 3 company | 1,251.422 | +81.11 | 1,827.130 | +111.86 |

Only one row matches, to a third of a cent. ISO Hub implements Lamar's owner funding as a 25% split
for Bruce (change-log row 273), so it charges Bruce for Lamar. It does **not** charge him for
Sherwin's 3. Sherwin's ISO Hub total also equals the CRM's net/2 plus 5% of his 3 (13,503.13 /
12,852.67), so ISO Hub pays Sherwin that 5% on top.

**Corrected §4.5 itemization for Bruce** (CRM after the change minus ISO Hub):

| Month | Lamar | Sherwin's 3 | 79 Plumlee overrides ISO Hub doesn't have | CRM rounding | Total |
| --- | --- | --- | --- | --- | --- |
| Aug | 81.11 | 0.00 | 241.18 (448.49 − 207.31) | 0.02 | 322.31 |
| Sep | 111.86 | 0.00 | 559.86 (760.29 − 200.43) | 0.02 | 671.74 |

**Today's** gap (227.49 / 544.98) is the 79-override piece **minus** Sherwin's 3 (241.18 − 13.71 /
559.86 − 14.90). The CRM currently charges Bruce for Sherwin's 3 and ISO Hub does not. Bruce's CRM
figure only looked equal to ISO Hub apart from the 79-override piece because those two pieces offset.

- **For ISO Hub parity, the decided all-company funding is right for Sherwin's 3** (the CRM matches ISO
  Hub after the change).
- **For Lamar, all-company funding is a deliberate difference** of 81.11 / 111.86 against ISO Hub.
  **Question:** keep Lamar company-funded as decided, or make it the one owner-funded override to match
  ISO Hub? The runbook in §4.4 is unaffected either way: run the one-off for 92, then switch Lamar back
  with `set_merchant_override_funding`. Or the script can skip it, with `expected_count` unchanged and
  Lamar reported separately.

**Q3. Confirm Q2 from ISO Hub itself.** The inference rests on totals. To confirm it per merchant,
download ISO Hub's per-agent residual report: the export that produced `AgentResidualReportLumpSum.csv`,
whose columns are `#, Processor, MID, MERCHANT NAME, SALES VOLUME, TRANSACTIONS, TOTAL INCOME,
TOTAL EXPENSE, GROSS, NET, Bonus, Deduction, Agent Split(%), Agent Split`. Download it for **August
2026 and September 2026, all processors**, for **Bruce Rozar, Dubble Bubbles Distributing Company LLC
(Sherwin) and Plumlee LLC**. The copy in Downloads (6 Nov) is Bruce's with all-zero totals, so it was
run for a month or filter with no data. On it, Lamar should show Agent Split(%) 25 for Bruce, Sherwin's
3 should show no deduction to Bruce, and the 45 Smokes should show Plumlee's extra 50%.

**Q4 (minor). Sherwin's net in the load files is higher than in the CRM and ISO Hub.** Summing the
load files over `Merchants-final.csv`'s Dubble Bubbles merchants gives 27,217.80 (Aug) / 25,958.73 (Sep),
against 26,978.85 / 25,675.55 in both the CRM and ISO Hub (a difference of 238.95 / 283.18). Some
residual on those MIDs is paid to neither system's Sherwin. The likely causes are shared accounts or
non-residual income rows, but this was not traced. It does not affect overrides.
