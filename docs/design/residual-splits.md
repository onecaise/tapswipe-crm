# Shared-account residual splits: design memo

Status: **DESIGN ONLY. Revision 2, 14 Oct 2026**, updated with the owner's confirmed business
rule. No code, migration, test or hosted change has been made. Nothing in this memo has been run
against dev or prod; the queries in §10 are for someone to run deliberately.

## The confirmed rule (Owen, 14 Oct 2026)

> On every account the rep side is **50%** of the residual and the company keeps **50%**,
> shared or not. Two reps on an account divide that 50% in any ratio an admin chooses
> (40+10, 30+20, …). The company's 50% never changes.

Decisions that follow from this, all confirmed:

- **Payout.** The residual is divided in proportion to the reps' shares. Both lines are paid
  at the same standard rep %: the partner's line always copies the signer's %, and a shared
  account never carries a separate rep % per line.
- **Admin input.** The admin enters each rep's share in rep-percent terms (for example 40 and
  10), and the two must total the account's rep % (50).
- **Timing.** A share applies by **payout month**, not by commit date.
- **What reps see.** Each rep sees their partner's **name** and their **own share only**,
  never the other rep's payout.
- **Mismatched rows** are **flagged at preview** and do not block the batch.
- **The second rep gets no access** to the merchant record.
- **Excel bulk entry** for shared accounts is **deferred**.

---

## 0. Vocabulary

"Split" already means two other things in this schema:

| Existing name | Meaning |
| --- | --- |
| `rep_payout_rows.rep_split_pct` | the rep %: the rep side's share of the residual. **50 by the rule above.** |
| `merchants.split_agent_pct` / `split_company_pct` | deal terms copied from the pre-app. RESIDUALS_SPEC decision 14 says they are never used for payouts |

To avoid a third meaning, this memo calls the new thing a **shared account**: the table is
`merchant_rep_shares` and the columns are `*_rep_pct`. The UI says "Shared account" and
"Your share".

---

## 1. How money flows today (unchanged findings)

1. **The ledger rep comes from the processor file's `Agent #`** (resolved through
   `profiles.agent_number`), not from `merchants.agent_id`. The MID is only a soft link to a
   merchant.
2. **`rep_payout_rows` has one row per `(period, agent_id, mid)`**, and that key is unique. The
   key already allows two reps on one MID.
3. **`residual_income` and `rep_split_pct` are usually blank at commit.** Admins fill them in
   afterwards through:
   - inline cells (`PayoutFigureCell`)
   - the per-rep bulk split (`PayoutBulkSplit`)
   - a round-trip re-import of the export
4. **`rep_payout = round(residual_income * rep_split_pct / 100, 2)`** is a stored generated
   column, rounding half away from zero. NULL means "not worked out yet". Negatives flow
   through unchanged.
5. **`commit_residual_import`** is `security definer`, guarded by `is_admin()`, and takes a
   `for update` lock on the batch. It upserts with the coalesce merge rule, deletes the staging
   rows, and writes one audit row.
6. **`log_payout_row_change()`** writes field-level history and fails closed.
7. **Visibility.** Select is own-row-or-admin, and update and delete are admin-only. The UPDATE
   grant is **table-wide** today.
8. **Every reader computes a rep's money as the sum of `rep_payout` over rows where
   `agent_id = rep`.** That covers `/payouts`, the period page, the statement and the export.
   This design keeps that rule true.

---

## 2. Central design

**A shared account becomes two real ledger lines in a month: a signer (primary) line and a
partner (secondary) line.** Each rep's money is still the sum over their own rows, so every
existing page, statement, export and RLS policy stays correct without changes.

**What is divided is the rep side's payout.** Each shared line's **payout** is a piece of the
payout one rep alone would have received (§4). Each line's **residual income** is the
matching piece of the account residual, kept for display so that the period's Residual income
total stays exact.

Dividing the residual and then recomputing each line's payout separately is **not** used: it
breaks the cent rule. The counterexample is in §4.4.

---

## 3. Schema

### 3.1 `merchant_rep_shares`, storing what the admin typed

```sql
create table merchant_rep_shares (
  id serial primary key,
  merchant_id int not null references merchants(id) on delete restrict,
  primary_agent_id   uuid not null references profiles(id),   -- the signer
  secondary_agent_id uuid not null references profiles(id),   -- the partner
  -- In REP-PERCENT terms, exactly as the admin types them: 40 and 10.
  primary_rep_pct   numeric(5,2) not null check (primary_rep_pct   > 0),
  secondary_rep_pct numeric(5,2) not null check (secondary_rep_pct > 0),
  check (primary_rep_pct + secondary_rep_pct = 50.00),   -- the standard rep side
  effective_from date not null,   -- first payout month it applies to (1st of month)
  effective_to   date,            -- EXCLUSIVE: first month it no longer applies
  created_at timestamptz not null default now(),
  check (primary_agent_id <> secondary_agent_id),
  check (extract(day from effective_from) = 1),
  check (effective_to is null or (extract(day from effective_to) = 1
                                  and effective_to > effective_from)),
  exclude using gist (merchant_id with =,
                      daterange(effective_from, effective_to) with &&)
);
```

**How the admin's input maps to what is stored.** The stored values are the admin's own
numbers. Nothing is rescaled, so nothing is rounded at entry. The division uses the ratio
`secondary_rep_pct / (primary_rep_pct + secondary_rep_pct)`, and that ratio is evaluated in
exact integer arithmetic at payout time (§4.2), never stored as a rounded fraction.

| Admin enters (signer + partner) | Stored `primary_rep_pct`, `secondary_rep_pct` | Partner's fraction of the rep side | Equivalent share of the rep side |
| --- | --- | --- | --- |
| 25 + 25 (default) | 25.00, 25.00 | 25/50 | 50% / 50% |
| 40 + 10 | 40.00, 10.00 | 10/50 | 80% / 20% |
| 30 + 20 | 30.00, 20.00 | 20/50 | 60% / 40% |
| 33.33 + 16.67 | 33.33, 16.67 | 16.67/50 | 66.66% / 33.34% |

- **Input steps are 0.01 rep-percent** (Q7 default), and each side must be greater than 0. The
  form shows "Company 50% · Signer 40% · Partner 10%" live, and refuses to save unless the two
  rep figures add to 50.
- **At most two reps, totalling exactly 50**, is enforced by the table's structure and CHECKs,
  not by a trigger.
- **`btree_gist`** is needed for the no-overlap constraint (§11).
- **No `agent_id` column.** This is a documented deviation, the same as
  `rep_payout_batches.imported_by`. **No `created_by` column**, because `audit_log` records the
  actor. That leaves **2 new `profiles` FKs**, taking the asserted count from 23 to 25.
- **Rows are immutable except `effective_to`, which can only move forward.** To change a ratio
  or a rep, end the share and start a new one.
- **A share can only be created on a merchant that has a MID.**

### 3.2 New columns on `rep_payout_rows`

```sql
line_kind   text not null default 'import'
            check (line_kind in ('import', 'adjustment')),
-- shared-account lines
rep_share_id            int references merchant_rep_shares(id) on delete restrict,
share_role              text check (share_role in ('primary', 'secondary')),
account_residual_income numeric(14,2),   -- the whole account residual, on both lines
primary_rep_pct         numeric(5,2),    -- snapshot of the share, on both lines
secondary_rep_pct       numeric(5,2),
-- adjustment lines (§6)
adjustment_amount       numeric(14,2),
adjusts_period          date,
adjustment_note         text
```

- CHECKs tie each group together:
  - the share columns are all null or all set
  - adjustment columns are set **only** when `line_kind = 'adjustment'`
  - an adjustment line is never also a shared line
- **The share figures are snapshotted onto the lines** because a generated column cannot read
  another table. The snapshot also means a later edit to a share can never re-price a month
  that was already paid.
- Every existing row gets `line_kind = 'import'` (a constant default, so Postgres records it in
  the catalog and does not rewrite rows) and NULL everywhere else. **There is no backfill.**
- **The merge key becomes a partial unique index**:
  `unique (period, agent_id, mid) where line_kind = 'import'`. That leaves import lines exactly
  as today and lets adjustments repeat. Two consequences to carry into implementation:
  - the planner cannot use a partial index for a bare `where period = $1`, so add a plain
    `(period, agent_id)` index to replace what the old constraint's index served
  - the commit's `on conflict` target gains `where line_kind = 'import'`

### 3.3 `rep_payout` gets two more branches; the unshared branch is textually unchanged

```sql
alter table rep_payout_rows alter column rep_payout set expression as (
  case
    when line_kind = 'adjustment' then adjustment_amount
    when share_role is null then
      round(residual_income * rep_split_pct / 100, 2)               -- TODAY'S EXPRESSION
    when share_role = 'secondary' then
      shared_part(round(account_residual_income * rep_split_pct / 100, 2),
                  secondary_rep_pct, primary_rep_pct + secondary_rep_pct)
    else
      round(account_residual_income * rep_split_pct / 100, 2)
      - shared_part(round(account_residual_income * rep_split_pct / 100, 2),
                    secondary_rep_pct, primary_rep_pct + secondary_rep_pct)
  end);
```

- **This rewrite requires Postgres 17**, because `ALTER COLUMN … SET EXPRESSION` first
  appeared in 17. The local stack is 17 (`config.toml`) and PGlite 0.5.x is 17. **Dev's and
  prod's versions are unknown until `select version();` is run (§10, Q-0).** The statement
  **rewrites the table and recomputes every stored value**. For unshared rows the branch is
  the same text, so the values must come out identical. The golden snapshot test (§12) checks
  every row locally, and the prod before/after check (§11) checks every row there.
- **Fallback if either project is older than 17:** drop and re-add the column in one
  migration transaction: `alter table rep_payout_rows drop column rep_payout;` then
  `add column rep_payout numeric(14,2) generated always as (<the case above>) stored;`.
  - It performs the same full recompute, under the same before/after check.
  - The column moves to the end of the table. Nothing here reads it positionally; every
    reader names it in `PAYOUT_ROW_COLUMNS` or the export's select list.
  - Anything depending on the column has to be dropped and recreated with it. Nothing does
    today, but check `pg_depend` first.
  - The rejected alternative is turning `rep_payout` into an ordinary column maintained by a
    trigger. That gives up the "never independently editable" guarantee.
- **Decide which path applies before phase 3 is built**, because the migration text differs.
  The migration should not branch on the server version at run time: one statement that
  behaves differently per environment is exactly what this repo's tests cannot see.
- **`shared_part()` is now referenced by stored data.** It must never be `create or replace`d
  with different behaviour without a forced recompute. Stored values keep the old function's
  answers, which is the same trap as the `dup_*` normalisers and their indexes.

### 3.4 Edge cases

| Case | Behaviour |
| --- | --- |
| Merchant with no MID | Share creation refused, with a sentence saying why. |
| MID with no merchant record | No share can exist, so the row imports exactly as today. |
| File names a rep outside the pair for a shared MID and month | **Flagged at preview, not blocked.** The row imports as an ordinary unshared line for the rep the file names, and the share produces nothing that month. Preview says "Share Ann/Bo not applied to MID X for July: the file names Cy." |
| File names the **partner** for a shared MID and month | Flagged. Skipped if it would land on the partner's shared line (§5.3). Otherwise imported as an ordinary line. |
| Deactivated rep on an existing share | Commits normally, with a preview warning (RESIDUALS_SPEC decision 10). |
| New share naming a deactivated rep | Refused by the RPC (Q10 default). |
| Change mid-month | Not possible. A change takes effect at a month boundary as end-then-start, in one RPC call. |
| End a share | `effective_to`, forward only, never at or before a committed month. |
| Share created by mistake | `cancel_merchant_rep_share` deletes it only if no line references it. |
| Signer's rep % is not 50 that month | See §10. Divided proportionally, never blocked, and flagged on preview and on the period page. |

### 3.5 Month rule and the race

A share applies to lines whose `period` is in `[effective_from, effective_to)`. The RPCs refuse
any boundary at or before the latest month already committed for that MID. Re-committing any
month therefore reproduces the same result, and no committed figure ever moves because of a
share edit. **A share that should have started in an already-committed month is handled by an
adjustment line, never by back-dating (§6).**

The commit RPC and every share RPC take the same `pg_advisory_xact_lock`, so a share edit cannot
interleave with an in-flight commit. That has to be verified by hand against real Postgres with
two sessions; PGlite is a single connection (the `20260821171000` precedent).

---

## 4. The cent rule

### 4.1 Statement

For a shared account in month M, with account residual `R` and the signer's rep % `p`
(normally 50):

> **signer payout + partner payout = `round(R × p / 100, 2)`, exactly to the cent.**

The right-hand side is precisely what one rep alone would have received: the same expression as
today's unshared generated column. This holds for every sign of `R`. On an exact half-cent tie
in the division, **the signer's line absorbs the cent**.

### 4.2 Definitions

Work in integer cents.

- **Solo payout:** `T = round_half_away_from_zero(R × p / 100)`, the expression today's column
  uses.
- **Partner's part:** `shared_part(T, b, w)`, where `b` is the partner's rep % and
  `w = a + b = 50`. With `t` = T in cents:

  ```
  n = |t| × b'        (b' = b × 100, an integer)
  d = w'              (w' = w × 100, an integer; 5000 at the standard rate)
  partner_cents = sign(t) × floor((2n + d − 1) / (2d))
  ```

  That is the nearest whole cent to `|t| × b / w`, **with an exact half-cent tie rounded toward
  zero**. All of it is integer `div`, so no `numeric` division is ever truncated.
- **Signer's part:** `signer = T − partner`.

### 4.3 Proof

1. **The sum is exact.** `signer + partner = (T − partner) + partner = T`. Both are exact
   integers of cents, so there is no rounding in the sum, and T is by construction the solo
   payout. ∎
2. **Negatives.** `round_half_away_from_zero` is odd (`round(−x) = −round(x)`), so
   `T(−R) = −T(R)`. The `shared_part` formula depends on `t` only through `sign(t)` and `|t|`,
   so it is odd too. Both lines negate exactly: a clawback is shared in the same ratio and the
   identity in (1) still holds. ∎
3. **Half-cents, at the account level.** A residual that puts the solo payout on a half cent
   (for example R = $0.03 at 50% gives 1.5¢) rounds exactly as it does for a solo rep, because
   it is the same expression. Sharing an account never changes the total paid to the rep side.
   ∎
4. **Half-cents, at the division.** For non-negative `x = n/d`,
   `floor((2n + d − 1)/(2d))` equals `⌈x − ½⌉`. Write `x = k + f` with `0 ≤ f < 1`:
   - `f < ½`: the value lies in `(k − ½, k]` and the ceiling is `k`.
   - `f = ½` exactly: the value is `k`, so the tie goes **down**.
   - `f > ½`: the value lies in `(k, k + ½)` and the ceiling is `k + 1`.

   So `|partner − exact| ≤ ½¢` and, since `signer = T − partner`, `|signer − exact| ≤ ½¢`.
   On an exact tie the partner gets `k` and the signer gets `|t| − k`, which is the larger
   magnitude. **The signer's line absorbs the cent**, for credits and clawbacks alike. ∎

### 4.4 Examples, and why per-line recomputation is wrong

| R | p | Split (a+b) | T (solo) | Partner | Signer | Sum |
| --- | --- | --- | --- | --- | --- | --- |
| $100.01 | 50 | 25+25 | $50.01 (5000.5¢, away) | $25.00 (2500.25¢) | $25.01 | $50.01 ✓ |
| $0.03 | 50 | 25+25 | $0.02 (1.5¢, away) | $0.01 (exact) | $0.01 | $0.02 ✓ |
| $0.02 | 50 | 25+25 | $0.01 | $0.00 (0.5¢ tie → toward zero) | $0.01 | $0.01 ✓ |
| −$0.02 | 50 | 25+25 | −$0.01 | $0.00 | −$0.01 | −$0.01 ✓ |
| −$100.01 | 50 | 40+10 | −$50.01 | −$10.00 (1000.2¢) | −$40.01 | −$50.01 ✓ |
| $7.77 | 50 | 30+20 | $3.89 (388.5¢, away) | $1.56 (155.6¢) | $2.33 | $3.89 ✓ |

**Counterexample showing why the payout is divided rather than recomputed per line:**
R = $0.02 at 50%, 25+25. Dividing the residual first gives $0.01 + $0.01. Then each line
computes `round($0.01 × 50%) = round($0.005) = $0.01`. That totals **$0.02 against a solo $0.01**:
the company loses a cent and the rule above is broken. Dividing T avoids this by construction.

**Residual pieces (display only).** Each line's `residual_income` is the same split applied to
R: `partner_res = shared_part(R, b, w)` and `signer_res = R − partner_res`. They sum to R
exactly, so the period's Residual income total is unchanged. On a few-cent residual,
`round(piece × 50%)` can differ by 1¢ from the line's payout. The statement says this in a
footnote: "On a shared account, payout is your share of the account's rep payout."

---

## 5. Commit path

### 5.1 `commit_residual_import_v2`: a new function beside the old one

The shared-aware commit is a **new function**,
`commit_residual_import_v2(batch_id_input int) returns jsonb`, which returns
`{"written": n, "skipped": m}`. **The existing `commit_residual_import(int) returns int` is
kept** until the app that calls v2 is live. That way an app version still deployed somewhere
keeps a working commit, and the change in return type never breaks a caller mid-deploy. (A new
name is also forced, not just chosen: `create or replace` cannot change a function's return
type.)

- **The old function stays byte-for-byte, with one guard added at the top.** If any staged
  row of the batch matches an active share, it raises PT409: "This import contains shared
  accounts. Reload the page to commit it." Without that guard, an old client could commit a
  shared MID as an ordinary signer line, which is the one outcome this design exists to
  prevent. With no shares, its behaviour is unchanged. The existing
  `commit-residual-import` tests keep passing against it.
- **The old function is dropped by a separate, later migration**, once all of these are true:
  1. the app version that calls only v2 is deployed on **both** dev and prod
  2. a repo grep finds no caller of `commit_residual_import(` outside migrations and the drop
     itself
  3. at least one real monthly batch has been committed through v2 on prod
- **The drop migration** moves the coalesce-grep and catalog assertions in
  `tests/rls/commit-residual-import.test.ts` onto v2 in the same commit, so the "reversed
  coalesce is silent" protection is never missing for a moment.

v2's steps, all in one transaction after the existing guards and the batch lock:

1. **Take the advisory lock.** `pg_advisory_xact_lock(<shared-account key>)`.
2. **Find shares at commit.** For each staging row, look up the share active for its `period`
   on the merchant whose **current** `merchants.mid = r.mid_raw`. Commit is authoritative;
   the preview is advisory.
3. **Unshared rows** go through **the existing upsert, unchanged** except for two edits:
   - one predicate that excludes the rows step 2 matched or step 5 skips
   - the conflict target becomes `on conflict (period, agent_id, mid) where line_kind = 'import'`

   The coalesce merge rule stays byte-identical, so the existing test's grep still holds.
4. **Shared rows** are rows whose file rep is the signer. Each one produces two lines:
   - **First commit of that month (insert):**
     - **Signer line.** The file-sourced columns are written as today. If the file supplied
       the residual and rep %, they set `account_residual_income` and `rep_split_pct`;
       otherwise these stay NULL. Shared Excel entry is deferred, but a fresh processor file
       supplies neither anyway.
     - **Partner line.** `volume`, `average_ticket` and `total_cost` stay NULL (Q4 default), so
       the account's volume is counted once. `rep_split_pct` is copied from the signer line.
     - **Both lines** get the share snapshot and their `residual_income` pieces.
   - **Conflict (re-import of a shared month):** **only the signer line's file-sourced columns
     are updated** (`merchant_name`, `merchant_id`, `volume`, `average_ticket`, `total_cost`,
     `batch_id`). `residual_income`, `account_residual_income`, `rep_split_pct` and every share
     column are **never written on conflict, on either line** (§5.3).
5. **Rows that are not applied, and are flagged instead:**
   - a row naming the partner that would land on the partner's shared line key: **skipped**
   - a residual or rep % supplied in the file for a shared line: **ignored**

   Skipped rows are recorded on the batch (§5.4). Nothing is silently dropped.
6. Staging delete, status flip and audit row are unchanged.

### 5.2 After commit: setting the residual and the rep %

- **Residual.** `set_shared_residual(rep_share_id, period, amount)`: `security definer`,
  guarded by `is_admin()`, takes the advisory lock and sets the transaction-local flag
  `tapswipe.shared_write`. It writes `account_residual_income` on both lines plus the two
  `residual_income` pieces. The generated column produces both payouts. History gets one row
  per line for `residual_income`, attributed to the admin.
- **Rep %, signer line only.**
  - An admin's normal PATCH or bulk split on the **signer** line is allowed.
  - An AFTER UPDATE trigger copies the new value to the partner line under the flag, so the
    partner always carries the signer's %. Recursion stops because the propagated update runs
    on a `secondary` row.
  - `guard_shared_line()`, a BEFORE UPDATE trigger, refuses any change to a **partner** line's
    `rep_split_pct`, and to `residual_income` or `account_residual_income` on either shared
    line, unless the flag is set. The message is PT409: "Shared account: set the account total
    on the signer's line." It is a no-op on unshared rows.
- **`PayoutBulkSplit` must skip partner lines.** Its update needs
  `.or("share_role.is.null,share_role.eq.primary")`, and its expected count must exclude them.
  Otherwise the guard rejects the whole statement.
- **The UPDATE grant narrows** to `grant update (residual_income, rep_split_pct)`. I checked
  that the only client writers, `PayoutFigureCell` and `PayoutBulkSplit`, touch only those two
  columns. All share and adjustment columns therefore become client-immutable by grant.

### 5.3 Re-import must never overwrite the divided lines

This is the invariant behind §5.1 step 4's conflict rule. Every re-import shape of a shared
month must leave both lines' money and share columns untouched:

- the same fresh file
- a corrected file
- an edited round-trip export
- a file naming the partner
- a file naming a third rep

It is a required test (§12, R-1).

### 5.4 Skipped rows: recorded, shown prominently, acknowledged

A non-blocking flag (§7) must still never be **quiet**. Staging rows are deleted at commit, so
v2 copies what it skipped onto the batch before deleting them:

```sql
alter table rep_payout_batches
  add column skipped_rows jsonb not null default '[]',   -- [{row_number, mid, agent_number, reason}]
  add column skips_acknowledged_at timestamptz;          -- null = still owed an acknowledgement
```

- **Who acknowledged is in `audit_log`**, not a column. A `skips_acknowledged_by` column would
  be a 26th `profiles` FK and one more entry in every teardown list.
- **On the commit result:** the admin lands on a **warning `Callout` at the top**, not a
  toast: "3 rows were not imported", with a table listing each row's sheet row number, MID,
  Agent # and reason. It stays on screen until an **"I've reviewed these 3 skipped rows"**
  button is pressed. That button calls `acknowledge_residual_skips(batch_id)`, which is
  `security definer` with an `is_admin()` guard. It sets `skips_acknowledged_at` and writes
  `audit_log` (`acknowledge_residual_skips`), failing closed. The commit itself does not wait
  for the acknowledgement: the rows it imported are already correct.
- **Period page (admins):** every period touched by a batch with unacknowledged skips shows the
  same Callout above the stat cards, with the list and the button, until it is acknowledged.
  Afterwards a muted line remains ("3 rows skipped in batch #12, reviewed 14 Oct by Ann Ito",
  with the name read from `audit_log`), so the record stays findable. The import list marks
  such batches too.
- **Reps** never see skip notices. A skipped row is not on their ledger.
- **Grants:** `skipped_rows` and `skips_acknowledged_at` are written only by definer
  functions. The existing `update` grant on `rep_payout_batches` (used for "Abandon") is
  narrowed to `update (status)` in the same migration, so an admin's PATCH cannot clear a skip
  record.

---

## 6. Correction path: a share agreed after the month was committed

The month rule forbids back-dating, so the correction is an **adjustment pair posted in an open
month**. No committed line is ever edited.

`post_share_correction(merchant_id, original_period, posting_period, partner_agent_id,
primary_rep_pct, secondary_rep_pct, note)` is `security definer` with an `is_admin()` guard,
takes the advisory lock, and writes `audit_log`.

1. Reads the signer's committed import line for `original_period`. That month's payout must be
   final: the RPC refuses if `rep_payout` is NULL.
2. Computes `x = shared_part(T, b, w)` with the §4 function on that month's T.
3. Inserts two `line_kind = 'adjustment'` lines in `posting_period`, on the same MID:
   - **partner:** `+x`
   - **signer:** `−x`

   Both carry `adjusts_period = original_period` and the note.

**What this guarantees.** The two lines sum to zero, so the company's 50% is untouched, and the
signer plus partner across both months equal T exactly.

**What it does not do.** It does not create the share itself. Shares for future months are set
the normal way, and the RPC is usually called alongside `set_merchant_rep_share`.

Reader changes the adjustment line needs (small and listed so none is forgotten):

- **`payoutTotals`:** adjustment lines are excluded from `unfilled` (their `residual_income` is
  NULL by design). They still count in `repPayout`.
- **Period page and statement:** show adjustment lines in their own "Adjustments" block with
  `adjusts_period` and the note.
- **Export:** a new `Line` column (`Adjustment` or blank). On re-import the parser **skips**
  rows marked `Adjustment`, and preview says "N adjustment lines ignored: adjustments are
  entered in the CRM". Without this, a round trip would turn an adjustment into an import line.

---

## 7. Preview (review screen) flags

None of these block. Each lists the sheet rows it applies to.

| Flag | Trigger |
| --- | --- |
| **Share not applied** | The file names a rep outside the pair for a shared MID and month (§3.4). |
| **Partner row skipped** | The file names the partner on a shared MID and month. |
| **Shared figures ignored** | The file supplies residual or rep % for a shared line. The message says to set them on the period page. |
| **Non-standard rate** | The rep % is not 50 on any row, shared or not (§10). |
| **Deactivated rep** | Existing decision-10 warning, extended to the partner. |
| **Looks shared, no share set** | Any of these, for a MID with no active share that month: (a) the same MID under two different Agent #s in this file; (b) the MID was committed under a different rep in any of the last 6 months; (c) the merchant's CRM owner (`merchants.agent_id`) is not the rep the file names. Heuristic and advisory. The message says "If two reps share this account, set it on the merchant page before committing." |

The preview is computed by `parse-residual-import`, which already reads with the admin client
after verifying an active admin. Commit recomputes the facts that actually change the outcome
(§5.1), because a share can change between preview and commit.

---

## 8. Visibility, RLS, grants, audit

**`merchant_rep_shares`**
- RLS enabled, select is `is_admin()` only.
- Grants: `select` to `authenticated`, no write grant. `all` to `service_role`. Sequence usage to
  `service_role` only.
- No `log_cross_agent_change()`: there is no `agent_id`, and only admins write.

**Write RPCs** are all `security definer`, `set search_path = public`, with a hand-written
`is_admin()` guard and the advisory lock. Each writes `audit_log` and fails closed:

- `set_merchant_rep_share`
- `end_merchant_rep_share`
- `cancel_merchant_rep_share`
- `post_share_correction`
- `set_shared_residual`, which leaves its trail in the history table rather than an audit row

Each gets its own `revoke all … from public; grant execute … to authenticated, service_role;`
lines.

**What a rep sees.** This follows the confirmed rule: the partner's name, and their own share
only, never the partner's payout.

- **Period page and statement.** The rep's own line shows "Shared account with Bo Lee · your
  share 40%", plus their residual piece, the rate and their payout. The partner's line stays
  invisible under the existing policy.
- **Where the partner's name comes from.** `profiles` RLS only shows a rep their own profile, so
  the name comes from a narrow read function, `my_share_partners()`. It is `security definer`
  with an `is_active_agent()` guard, built on the `accounts_in_city` pattern. It returns
  `{rep_share_id, partner_name, own_rep_pct, effective_from, effective_to}` for shares where the
  caller is a party. **No partner payout, rate or share key** is returned; the keys are absent,
  not null.
- **Merchant page.** Only the signer can open it. It shows "Shared with Bo Lee from Nov 2026 ·
  your share 40%". The partner's statement line shows the merchant name as plain text, not a
  link.

**Honest caveat to keep on record.** Hiding the partner's figures is a **display rule, not a
secret.** The rep side is always 50 and both lines share one rate, so a rep who knows their own
share (40) knows the partner's (10). Their own line also carries `account_residual_income` and
the share snapshot, because the generated column needs them on the row. Together those let a
rep work out the partner's payout. Making them unreadable would take column-level select grants
and moving admin reads behind definer functions, which is a large change for something the rule
itself already reveals. **Not recommended.** The UI and export never display the partner's
figures.

**Admins** see:
- **On the period page:** both lines marked "Shared · Ann Ito 40 / Bo Lee 10 · account residual
  $X". The "Set account total" control sits on the signer's line, and the partner's line is
  read-only.
- **On the merchant page:** a "Shared account" card with every past and current share and the
  set, end, cancel and post-correction controls.
- **On the review screen:** the preview flags from §7.

**Export.** Adds `Account share` (the row's own rep %, blank when unshared) and `Line`. The
parser ignores `Account share`. The live test's exact header list is updated.

---

## 9. Answers recorded and defaults for the rest

| # | Question | Status |
| --- | --- | --- |
| 1 | What is divided | **Answered.** Proportional to the shares, both lines at the signer's rep %, payout divided from the solo payout (§2, §4). |
| 2 | Month vs commit date | **Answered.** By month. |
| 3 | Show the partner? | **Answered.** Partner's name and own share only, never the partner's payout. |
| 5 | Mismatched rows | **Answered.** Flagged at preview, not blocked (§3.4, §7). |
| 6 | Merchant access for the partner | **Answered.** None. |
| 11 | Excel bulk entry | **Answered.** Deferred. Shared figures in a file are ignored and flagged. |
| 4 | Account volume on the partner's line | **Default: no.** Volume, average ticket and total cost go on the signer's line only, so the Volume total is not double-counted. The partner's statement shows "—" with "reported on the signer's line". |
| 7 | Share granularity | **Default: 0.01 rep-percent steps**, each side > 0, summing to exactly 50. |
| 8 | Who gets the odd cent | **Default and proven (§4): the signer**, on exact half-cent ties, for credits and clawbacks alike. |
| 9 | Two reps maximum | **Default: permanent for this design.** It is two columns; a third rep would need a redesign. |
| 10 | New share naming a deactivated rep | **Default: refused.** Existing shares keep paying a later-deactivated rep, with a warning. |
| 12 | Processor lists one MID under both reps | **Default: assume it does not.** If it does, the partner's row is flagged and skipped where it would collide (§5.1 step 5), and the "looks shared" flag fires. |
| 13 | Merchants stat counts lines or accounts | **Default: unchanged (lines).** Switching to distinct MIDs would change the figure for existing periods where two reps already share a MID, which breaks the no-change rule. Revisit separately if wanted. |

---

## 10. Data check: any `rep_split_pct` other than 50?

> **Note, 14 Oct 2026: confirmed by the owner.** On **prod**, `rep_payout_rows` is **empty**:
> no residual or rep payout data has ever been loaded there. The Phase 3 payout-column
> rewrite on prod therefore touches **zero rows**. The §11 before/after check still runs
> there, and should report 0 lines before and after. **Dev has test data**, so the rewrite
> does real work there. **Phase 3 should prefer a single method that works on every Postgres
> version**: drop and re-add the generated column (§3.3's fallback), not `SET EXPRESSION`.
> One migration text then applies everywhere, so it cannot depend on the version result.
> **Dev's Q-0 version result is still pending.**

These are **read-only and have not been run.** Run them in the dev and prod SQL Editors, one
query at a time. Each is wrapped so it cannot write anything.

```sql
-- Q-0: server version. The payout-column rewrite (§3.3) needs Postgres 17 for
-- ALTER COLUMN ... SET EXPRESSION. On anything older, the drop-and-re-add
-- fallback in §3.3 applies, and which path to build must be decided BEFORE
-- phase 3. Record the full string for dev and for prod.
select version();

-- Q-a: distribution of rep % across the ledger
begin transaction read only;
select rep_split_pct, count(*) as lines, count(distinct agent_id) as reps,
       min(period) as first_month, max(period) as last_month
  from rep_payout_rows group by rep_split_pct order by lines desc;
rollback;

-- Q-b: every committed line whose rep % is set and not 50, with the rep
begin transaction read only;
select r.period, p.full_name, p.agent_number, r.mid, r.merchant_name,
       r.rep_split_pct, r.residual_income, r.rep_payout
  from rep_payout_rows r left join profiles p on p.id = r.agent_id
 where r.rep_split_pct is not null and r.rep_split_pct <> 50
 order by r.period, r.mid;
rollback;

-- Q-c: staged (uncommitted) rows carrying a non-50 rep % from a file
begin transaction read only;
select b.id as batch_id, b.status, i.row_number, i.agent_number_raw, i.mid_raw,
       i.rep_split_raw, i.rep_split_pct
  from rep_payout_import_rows i join rep_payout_batches b on b.id = i.batch_id
 where i.rep_split_pct is not null and i.rep_split_pct <> 50
 order by b.id, i.row_number;
rollback;

-- Q-d: MIDs already paid to more than one rep (candidate shared accounts)
begin transaction read only;
select mid, count(distinct agent_id) as reps,
       array_agg(distinct agent_id) as agent_ids,
       min(period) as first_month, max(period) as last_month
  from rep_payout_rows group by mid having count(distinct agent_id) > 1
 order by reps desc, mid;
rollback;

-- Q-e (context only): merchant deal-terms splits that are not 50/50
begin transaction read only;
select id, dba, mid, split_agent_pct, split_company_pct
  from merchants
 where split_agent_pct is distinct from 50 and split_agent_pct is not null;
rollback;
```

The editor runs as the owner, so RLS does not filter these; that is intended for an audit. If an
editor shows only the last result, run each query on its own. Record the output in this memo
before phase 4.

**A shared account whose signer rate is not 50.** The rule says this should not exist, so it
is treated as an anomaly that is surfaced, never silently corrected:

- **Payout.** The division still applies **proportionally** to whatever the signer's line
  carries: `T = round(R × p / 100)` at that p, divided a : b. The cent rule (§4) holds for any p,
  so the two lines still sum to exactly what a solo rep at that rate would get.
- **The partner copies that same rate** (§5.2). There is never a second rate on a shared
  account.
- **It is flagged**: "Non-standard rate" on preview and on the period page beside the shared
  pair. The admin decides whether the rate is a mistake to fix (an ordinary edit on the signer's
  line, which propagates) or an agreed exception.
- **Nothing blocks, and nothing defaults the rate to 50 automatically.** Auto-defaulting
  unshared lines to 50 at commit would change existing behaviour and is out of scope.

---

## 11. Production runbook notes (for whenever this is deliberately deployed; NOT now)

1. **Check the hosted Postgres version** on each project (§10 Q-0). The payout rewrite needs
   Postgres 17 for `alter column … set expression`. If either project is older, phase 3 is
   built with the drop-and-re-add fallback (§3.3) instead. **Decide this before phase 3**,
   not at deploy time.
1a. **Prod before/after check on the payout rewrite. Required, and the results must match
   exactly.** Run this read-only on prod immediately **before** the push, save the output to
   `scripts/logs/`, then run it again immediately **after**:
   ```sql
   begin transaction read only;
   select count(*)                                   as lines,
          count(rep_payout)                          as lines_with_payout,
          sum(rep_payout)                            as total_payout,
          md5(string_agg(id::text || ':' || coalesce(rep_payout::text, 'null'),
                         ',' order by id))           as per_row_checksum
     from rep_payout_rows;
   rollback;
   ```
   - `per_row_checksum` covers **every row's** payout, so a single changed cent anywhere fails
     it even when the totals still agree.
   - **The migration enforces the same thing itself.** It copies `(id, rep_payout)` into a
     temp table before the rewrite, compares after, and `raise`s on any difference. That
     rolls the whole migration back, so prod cannot end up rewritten and wrong.
   - The external before/after record is still required: it is the evidence that outlives the
     terminal, the way `scripts/push-prod-migration.ps1` logs are.
   - Any mismatch, or a migration abort, stops the deploy, and the cause is investigated
     before anything is retried.
   - Run the same check on dev at its push.
2. **`btree_gist`, in the `extensions` schema**, before or at the top of the share-table
   migration:
   ```sql
   create extension if not exists btree_gist with schema extensions;
   ```
   - The exclusion constraint's integer operator class then lives in `extensions`. Either run
     the migration with `set search_path = public, extensions` or qualify the operator class.
     The `pg_trgm` precedent applies: without it, the failure is an operator-class-not-found
     error at migration time.
   - **Hermetic suite:** pass `btree_gist` to the PGlite **constructor** in
     `tests/helpers/db.ts`. `create extension` alone is not enough there, and forgetting it reds
     every file.
3. Run the §10 queries on each project first, and record the results.
4. **Follow the existing prod path.** `scripts/push-prod-migration.ps1 -DryRun`, then the real
   push, then `scripts/diag-prod-trigger.ps1`. Never `npm run db:push -- --db-url <prod>`.
5. **Dev still carries the old `20261013130000`** (see CLAUDE.md). Its revert plan must be
   settled before any push that includes these migrations.
6. After deploying, `npm run test:deployed` should report the new objects. Drift is expected
   until then.

---

## 12. Tests

**Requirements carried from revision 1**, adjusted for the confirmed rule: golden regression,
RPC guards, grants, RLS redaction, live export, e2e geometry, and a manual two-session lock
check.

**Hermetic (PGlite)**

1. **The cent rule, exhaustively (§4).** One SQL statement per grid, asserting **zero
   violating rows**:
   - every R from −$100.00 to $100.00 by the cent × p ∈ {50, every non-50 value Q-a finds,
     0.01, 99.99} × a representative set of splits (25+25, 40+10, 30+20, 33.33+16.67, 0.01+49.99)
   - every split pair in 0.01 steps (4,999 pairs) × R from −$2.00 to $2.00
   - Assertions:
     - signer + partner = solo `round(R·p/100, 2)`
     - `f(−R) = −f(R)` for both lines
     - each line within ½¢ of exact
     - every exact tie gives the signer the larger magnitude
     - residual pieces sum to R
     - NULL R or NULL p gives NULL on both lines
   - Each assertion is shown non-vacuous by reverting `shared_part` (for example to half-up,
     or to per-line recompute) and watching exactly that assertion go red.
2. **Golden: unshared is unchanged to the cent.** Commit the same fixture batches on
   `migrationsBefore(<first new migration>)` and on full migrations. The batches cover fresh,
   corrected, round-trip, negative, NULL, and two reps on one MID. Compare the full ledger
   (every column that existed before, **including `rep_payout` for every row after the
   `SET EXPRESSION` rewrite**), history, audit and the return value's `written`. Repeat with a
   share on a different merchant.
3. **R-1: re-importing a shared month never overwrites the divided lines.**
   - Setup: commit a shared month, set the account total via the RPC, and set the signer's
     rate.
   - Re-import (a) the same fresh file, (b) a corrected file with a changed volume, (c) a
     round-trip export with edited residuals on both shared lines, (d) a file naming the
     partner, (e) a file naming a third rep.
   - After each: both lines' `residual_income`, `account_residual_income`, `rep_split_pct`,
     `rep_payout` and share snapshot are **byte-identical** to before. No history row is
     written for them. The signer line's file columns did update in (b). `skipped` and the
     preview flags match.
   - Prove non-vacuous by reverting the "never write money on conflict" rule: R-1 must go red.
4. **Shared commit:**
   - two lines; partner copies the rate; volume on the signer only
   - months outside `[from, to)` are unshared
   - a third-rep row imports as an ordinary line and is flagged
   - a share changed between preview and commit: commit uses the current share
5. **Rate propagation and guard:**
   - editing the signer's rate updates the partner's, with two history rows
   - editing the partner's rate directly gets PT409
   - PATCH of residual on a shared line gets PT409
   - `PayoutBulkSplit`'s filtered update succeeds on a group containing partner lines
   - column grants: PATCH of `agent_id` or `rep_share_id` gets `permission denied for column`
6. **Correction:**
   - the adjustment pair sums to zero; partner + signer across both months = T exactly
   - refused when the original month is unfilled
   - `payoutTotals` does not count adjustments as unfilled
   - the export carries `Line = Adjustment` and re-import skips it
7. **Share RPCs:**
   - an agent or a deactivated admin is refused, and nothing is written
   - refusals: sum ≠ 50, a side ≤ 0, no MID, same rep twice, overlap, boundary at or before a
     committed month, cancel of a used share, backwards end, deactivated rep
   - audit rows are written
   - `prosecdef` true, guard present, `search_path` set
   - the exclusion constraint is a working backstop
8. **RLS redaction:**
   - both reps read zero `merchant_rep_shares` rows
   - each reads only their own line
   - `my_share_partners()` returns the partner's name and own share, with **no** partner
     payout, rate or share key (asserted by key absence)
   - a deactivated caller gets nothing; an admin sees everything
   - `pg_policies` on `merchants` does not mention shares
9. **Counts.** `profiles` FK count is 25, with the two new names listed.

**Live:** the export header list (adds `Account share` and `Line`); a rep's export holds only
their own line; the upload → preview flags → commit cycle with a shared MID.

**e2e:**
- admin enters 40 + 10 and sees the live "Company 50 · Signer 40 · Partner 10" summary, and is
  refused at 40 + 15
- period-page markers with no overflow at 375/768/1440
- the rep statement shows the partner's name and own share, and no partner figure
- the partner's merchant name is not a link
- "Set account total" updates both lines after reload

Each is proven by revert.

**Existing tests that will change:**
- `user-imports` (23 → 25)
- `commit-residual-import` (untouched until phase 9, because the old function survives; v2
  gets its own test file with the coalesce grep)
- `grants`
- `rep-payouts` (the partial index replaces the unique constraint)
- live `residual-import` (the 11-column header)
- `unit/payouts` (`payoutTotals`, `PAYOUT_ROW_COLUMNS`)
- e2e `payouts-rendering` and `payouts-editing` (bulk split)
- `deployed/schema-drift` (expected drift until pushed)

All four teardown lists clear `merchant_rep_shares` after `rep_payout_rows`.

---

## 13. Phased build plan (one prompt, one commit each)

| # | Phase | Contents |
| --- | --- | --- |
| 0 | Data check | Run §10 on dev and prod (read-only), record the results here. |
| 1 | Cent function | Schema doc first. `shared_part()` with its privilege lines. Test 1. |
| 2 | Share table | `merchant_rep_shares`, `btree_gist` (migration plus PGlite constructor), RLS, grants, the set/end/cancel RPCs with audit and lock. Tests 7, part of 8, and 9. All four teardown lists. |
| 3 | Ledger columns | **Prerequisite: the Postgres version path is decided (§10 Q-0).** New columns, partial unique index plus the period index, `SET EXPRESSION`, column-level UPDATE grant, guard and propagation triggers, `set_shared_residual`. Golden test 2, written **before** this migration lands and kept green. Test 5. |
| 4 | Commit and preview | `commit_residual_import_v2` (§5.1) beside the old function, plus the old function's share guard. The skip record and acknowledgement (§5.4). The commit button calls v2. `parse-residual-import` preview flags (§7). Tests 3 (R-1) and 4. |
| 5 | Correction | `post_share_correction`, adjustment rendering, `payoutTotals`, the export `Line` column and parser skip. Test 6. |
| 6 | Merchant page | Admin share card with the 40+10 input, `my_share_partners()`, the rep notice. e2e. |
| 7 | Payout surfaces | Period-page markers and the account-total control, `PayoutBulkSplit` filter, statement marker and footnote, partner non-link. e2e geometry. |
| 8 | Docs | CLAUDE.md and the RESIDUALS_SPEC addendum. Deployment stays a separate, explicit decision following §11. |
| 9 | Drop the old commit | Only after §5.1's three conditions hold. Drop `commit_residual_import(int)`, and move its test assertions onto v2 in the same commit. |

## 14. Still open (small, needs Owen only if the defaults are wrong)

- **Default posting month for a correction pair:** the earliest month not yet committed.
- **"Looks shared" lookback window:** 6 months.
