# Deploy override funding (`20261116120000`) and move the overrides to company funding — the plan

Written 16 Nov 2026 on `override-funding` at `a6c61b9`, before anything was deployed. **A plan, not a record**: nothing in it has been run against a hosted project. Owen runs every hosted command himself, in PowerShell, one at a time, and reads the output before the next one. The design is `docs/design/override-funding.md` (binding, with its §8 corrections and the decisions of 16 Nov 2026).

It assumes the residual build (`docs/claude/deploy-residuals.md`) is on **both** projects: dev and prod at migration `20261111120000`, fourteen functions deployed, and on prod the real data loaded, with **August 2026 committed** and **September 2026 committed and marked paid** (every processor).

**What changes, in one paragraph.** An override now says who pays it: the owner's side (as every override was paid until now) or the company's share (the owner keeps their full rate). The migration adds the choice as `owner` everywhere, which is how the committed lines were worked out, so **deploying changes no figure**. Then a one-off script, `scripts/set-override-funding.sql`, moves **91 of the 92 overrides** to company funding through the audited function: the 88 on Plumlee LLC merchants (to Bruce, 103) and Sherwin's 3 (105). The Lamar County Justice Court 25% to Plumlee (108) **stays owner-funded**, as ISO Hub pays it. Committed months pick the change up only when they are **replaced** with the same file; a paid month is reopened first.

## 0. Starting point, and what was checked

| Claim | Checked how | Result |
| --- | --- | --- |
| One new migration, `20261116120000_override_funding.sql`; 85 in the repo | `ls supabase/migrations \| wc -l` → 85 | `push-prod-migration.ps1` should end `RESULT: PASS -- all 85 migrations are recorded`. |
| It applies over a populated ledger and moves nothing | PGlite: `tests/rls/override-funding.test.ts` "the migration over a committed, owner-funded month" (md5 of every payout before and after; a hand-broken pair refused, naming it). The **local stack** (Postgres 17, 14 overrides, 21 override lines) on 16 Nov 2026: applied in one transaction; all lines `owner`; the four-argument function gone. | **Verified locally.** Not on dev or prod. |
| The script does what it says, as the editor's role | `tests/rls/set-override-funding.test.ts` (PGlite, the 92-override fixture, every refusal) and `tests/live/set-override-funding.test.ts` (local stack, as the non-superuser `postgres` role, inside a rolled-back transaction) | **Verified locally.** |
| Prod holds 92 overrides: 103 → 88, 105 → 3, 108 → 1 | Owen's decision of 16 Nov 2026 | **Not verified.** The counts file (pre-check, P3) shows it; the script refuses any other number. |
| Dev and prod are at `20261111120000` | Not checkable offline. | **Not verified.** D2/P4 settle it: exactly one version pending. |

## 1. The migration

| # | File | What it does | Refuses to run when… |
| --- | --- | --- | --- |
| 1 | `20261116120000_override_funding.sql` | `merchant_overrides.funded_by` (`owner` \| `company`, required, no default; existing rows `owner`); `rep_payout_rows.override_funded_by` (the funding as at commit; existing override lines `owner`); three ledger CHECKs (one rewritten), validated; commit v3 step 6 (a company-funded override writes the recipient's credit only); `set_merchant_override` with a required fifth argument and **the four-argument function dropped**; `set_merchant_override_funding()` and `override_funding_pending()` (new); `close_payout_period` refuses a month whose override lines are stale; `merchant_processor_summary` (Report 2) re-created with `company_overrides`; the move guard's and v3's cap messages reworded. | `rep_payout_rows_override_columns` is not the `20261102120000` CHECK; v3 is not the `20261111120000` body; `set_merchant_override(int, uuid, numeric, date)` is missing; **an existing override pair is not an owner-funded pair** (one credit, debits totalling minus it) — it names the batch and override. Nothing on prod should trip any of these: every committed override line was written by v3 as such a pair. |

**Deploying it changes no payout.** Every committed line keeps its figure (the migration compares an md5 of every `rep_payout` before and after, and rolls back on a difference). Report 2 shows **Overrides from company: $0.00** everywhere until the one-off below runs.

### The pre-check (read-only; SQL Editor, before the push)

```sql
select
  (select count(*) from merchant_overrides)                                         as overrides,
  (select count(*) from rep_payout_rows where line_kind = 'override')               as override_lines,
  (select count(*) from (
     select batch_id, override_id
       from rep_payout_rows where line_kind = 'override'
      group by batch_id, override_id
     having count(*) filter (where override_role = 'credit') <> 1
         or count(*) filter (where override_role = 'debit') < 1
         or coalesce(sum(override_amount) filter (where override_role = 'debit'), 0)
            <> -coalesce(sum(override_amount) filter (where override_role = 'credit'), 0)) p) as bad_pairs,
  (select string_agg(format('batch %s / override %s', batch_id, override_id), ', '
                     order by batch_id, override_id) from (
     select batch_id, override_id
       from rep_payout_rows where line_kind = 'override'
      group by batch_id, override_id
     having count(*) filter (where override_role = 'credit') <> 1
         or count(*) filter (where override_role = 'debit') < 1
         or coalesce(sum(override_amount) filter (where override_role = 'debit'), 0)
            <> -coalesce(sum(override_amount) filter (where override_role = 'credit'), 0)) p) as bad_pair_list,
  (select max(version) from supabase_migrations.schema_migrations)                  as latest;
```

`bad_pairs` **0** (`bad_pair_list` empty) and `latest` **20261111120000**. Prod: `overrides` **92**. Anything else: stop and ask.

`bad_pairs` is the migration's own section-0 proof, read-only: the same grouping by (batch, override) and the same three conditions (exactly one credit, at least one debit, the debits totalling minus the credit). The migration refuses the push on exactly the pairs `bad_pair_list` names, in the same `batch N / override M` form, so a problem shows here, before the push, not during it.

## 2. Edge Functions

Derived from `git diff --name-only 2701254 HEAD -- supabase/functions supabase/config.toml` plus each function's `../_shared/*.ts` imports. One file changed: `_shared/report-sheets.ts` (Report 2's column list gains **Overrides from company**). The only function importing it is `export-report`. `config.toml` is unchanged; no new function, no new secret.

| Function | Why it must be redeployed | Behaviour change? |
| --- | --- | --- |
| `export-report` | imports `_shared/report-sheets.ts` | **Yes**: Report 2's Excel has the **Overrides from company** column, matching the page. Until it is redeployed, the exported Report 2 silently lacks that column, though its other figures are right (Company share is already net of company-funded overrides, because the SQL changed). |
| the other thirteen | nothing they import changed | No. |

**Order: migration first, then `export-report`, then the app.** The new app calls `set_merchant_override` with five arguments and the old database has four. The old app on the new database cannot save an override (the four-argument function is gone; it errors, never saves with the wrong funding). So keep the gap between the push and the Vercel deploy short, and nobody setting overrides in between.

## 3. Hosted dashboard changes

**None.** No `[auth]`, `[storage]` or `[api]` change, no bucket, no env var, no secret. Never `config push`.

## 4. DEV sequence

Assumes §7 is done (linked to dev; the guard prints `dev, ok`; dev awake).

**D1. Backup.**

```powershell
npm run db:dump -- -f C:\Users\owen\tapswipe-backups\dev-schema-2026-11-DD.sql
npm run db:dump -- --data-only -f C:\Users\owen\tapswipe-backups\dev-data-2026-11-DD.sql
```

Both non-empty.

**D2. Pre-check + dry run.** The §1 pre-check in the dev SQL Editor (`bad_pairs` 0). `npm run migration:list` — Remote ends at `20261111120000`; `npm run db:push -- --dry-run` lists **exactly** `20261116120000_override_funding.sql`.

**D3. Push.** `npm run db:push` (answer `y`). `npm run migration:list`: both columns end at `20261116120000`. Then the P6 verification queries in the dev SQL Editor.

**D4. Function.** `npm run functions:deploy -- export-report`, then `npx supabase functions list --project-ref vdjtosofrimipklbdjbi`: `export-report` `ACTIVE`, updated today.

**D5. Preview.** `git push -u origin override-funding`. Open the Vercel preview; DevTools → Network: requests go to `vdjtosofrimipklbdjbi.supabase.co`. Prod's ref → **stop**.

**D6. Manual checklist on the preview — synthetic data only.** Use dev's test reps and merchants (`deploy-residuals.md` D6: Avery 40, Gray Overrider, the house).

- [ ] **The form asks who pays.** A merchant with no override → Override card: **Paid from** shows *The owner's side* and *The company's share*, neither chosen; with a percent typed, the line under it reads "Choose who pays it…" and **Save override** is disabled. Choose each in turn: owner → "the owner keeps $X of the $rate rep side, and the company keeps $(100−rate)"; company → "the owner keeps the full $rate rep side, and the company keeps $(100−rate−X) of its $(100−rate)". Save with **company**: the in-force line says "paid from the company's share"; the row says "Paid from the company's share"; the form is blank again.
- [ ] **A company-funded month.** Set a company-funded override on a dev merchant for a month not yet committed, import that month (a dev residual file, `deploy-residuals.md` D6), commit. **The owner's statement** shows no override line for it, and their split is the full rep side. **The recipient's statement** shows "Override received". **Report 1**: owner split = full rep side; recipient's overrides received = X. **Report 2**: that MID's **Overrides from company** = X, company share = residual − rep side − X. **Export Excel** (Report 2): the same five figures, the new column between Rep side and Company share.
- [ ] **Change who pays, and replace.** On an owner-funded override with a committed month (dev's 10% to Gray on `990000000107`): **Change who pays** → the month is listed "will need a replace to take effect"; Save is disabled until the reason is 10+ characters; save. The row shows the stale note; `/payouts` → Processor months: that month shows **"Override funding changed: replace this month to apply (1 override)"** and no **Mark paid**. Upload the same file again for that processor-month, answer **Yes** to replace, commit. The flag is gone; the owner's split is up by X; Report 2's Overrides from company shows X. Switch it back to owner and replace again: every figure is as before, to the cent.
- [ ] **A paid month refuses it.** Mark a month paid, then **Change who pays** on an override with lines in it: the card names the month ("…is marked paid. Reopen it…") and offers no Save. Reopen it (with a reason) and the change is allowed.
- [ ] **The script, dry run, on dev.** Dev does not hold 92 overrides, so the script refuses: it reports "found N, expected 92" per line and changes nothing. **That refusal is the dev check** (it proves the count guard and the identity switch on a hosted project). Do not edit the constants to make it pass on dev.
- [ ] **The grants query** in `docs/claude/grants-inventory.md`: every row `matches = true` (no table grant changed).

Dev passes when every box is ticked. Anything unticked: stop, note what you saw, do not start §5.

## 5. PROD sequence

Only after dev passed. One sitting, nobody else signed in, nobody setting overrides.

**P1. Prod connection in this terminal.** The linked project stays dev.

```powershell
$sec = Read-Host -AsSecureString "prod database password"
$env:PGPASSWORD = [Net.NetworkCredential]::new('', $sec).Password
$env:SUPABASE_DB_PASSWORD = $env:PGPASSWORD
Remove-Variable sec
$prod = "postgresql://postgres.zuvsdkjnfstrjahstsmg@aws-0-us-west-2.pooler.supabase.com:5432/postgres"   # no password in it
```

**P2. Backup.**

```powershell
npx supabase db dump --db-url $prod -f C:\Users\owen\tapswipe-backups\prod-schema-2026-11-DD.sql
npx supabase db dump --db-url $prod --data-only -f C:\Users\owen\tapswipe-backups\prod-data-2026-11-DD.sql
```

Both non-empty.

**P3. Pre-check.** In the prod SQL Editor (top-left **`tapwipe-crm-prod`**): the §1 pre-check (`overrides` 92, `bad_pairs` 0, `latest` 20261111120000).

**P4. Dry run.** Local stack running (the script borrows its DB container as a psql client).

```powershell
powershell -File scripts\push-prod-migration.ps1 -DryRun
```

`TARGET aws-0-us-west-2.pooler.supabase.com:5432 as postgres.zuvsdkjnfstrjahstsmg`, latest `20261111120000`, and **exactly** `20261116120000_override_funding.sql`.

**P5. Push.** `powershell -File scripts\push-prod-migration.ps1` → `RESULT: PASS -- all 85 migrations are recorded`.

**P6. Verification queries** (prod SQL Editor; the same on dev in D3):

```sql
-- the version
select max(version) from supabase_migrations.schema_migrations;            -- 20261116120000
-- every override owner-funded, every override line too, nothing stale
select funded_by, count(*) from merchant_overrides group by 1;             -- owner 92
select override_funded_by, count(*) from rep_payout_rows
 where line_kind = 'override' group by 1;                                   -- owner <all of them>
select count(*) from rep_payout_rows
 where line_kind <> 'override' and override_funded_by is not null;          -- 0
-- the old signature is gone, the new ones are there, nothing for anon
select p.oid::regprocedure as fn, p.prosecdef as definer,
       has_function_privilege('anon', p.oid, 'execute') as anon_can_call,
       has_function_privilege('authenticated', p.oid, 'execute') as signed_in_can_call
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and p.proname in ('set_merchant_override', 'set_merchant_override_funding',
                     'override_funding_pending', 'close_payout_period',
                     'merchant_processor_summary', 'commit_residual_import_v3')
 order by 1;
   -- 6 rows: set_merchant_override(integer,uuid,numeric,date,text) only; anon f everywhere;
   -- signed-in t; definer f only for override_funding_pending and merchant_processor_summary
-- the CHECKs, validated
select conname, convalidated from pg_constraint
 where conrelid = 'public.rep_payout_rows'::regclass
   and conname in ('rep_payout_rows_override_columns', 'rep_payout_rows_override_funded_by',
                   'rep_payout_rows_company_override_no_debit');            -- 3 rows, all t
```

**P7. Function.**

```powershell
npx supabase functions deploy export-report --project-ref zuvsdkjnfstrjahstsmg
npx supabase functions list --project-ref zuvsdkjnfstrjahstsmg
"export-report " + (curl.exe -s -o NUL -w "%{http_code}" -X POST "https://zuvsdkjnfstrjahstsmg.supabase.co/functions/v1/export-report")
```

`export-report` `ACTIVE`, updated today; the curl **401**. A 404 or 5xx: redeploy it (§6).

**P8. Merge to master and deploy the app.**

```powershell
git checkout master
git pull --ff-only
git merge --no-ff override-funding -m "Merge override-funding (who pays an override)"
git push origin master
```

Vercel builds `master` → wait for **Ready**. Browser, as admin on prod: a merchant page's Override card shows **Paid from**; `/admin/reports?report=merchants` shows **Overrides from company** (all $0.00 until P10).

## 5b. The data change and the September runbook (prod, after P8)

Every step reads before it writes. Keep the counts file open in a second SQL Editor tab: `scripts/set-override-funding-counts.sql` (read-only; one grid; months August and September 2026).

**R1. Counts, before.** Run the counts file. It must read:

| section | expected |
| --- | --- |
| `1 overrides` | `103 owner` 88, `105 owner` 3, `108 owner` 1, `total` 92 |
| `2 plumlee` | `103 on Plumlee LLC merchants` 88, `108 on Lamar County Justice Court` 1 |
| `3 paid` | every September 2026 processor-month (`… 2026-09`); no August |
| `4 touched` | the processor-months carrying lines of the 91, August and September: **the months to reopen (September) and to replace (both)** |
| `5 pending` | **no rows** |
| `6 adjustments` | **no rows**. Any row is a month whose replace will be refused (an adjustment was worked out from its figures): stop and ask before reopening anything. |
| `7 drift` | **no rows**. A row is a merchant whose owner, rate or MID changed since that month was committed; a replace would re-pay it at today's values. Stop and explain each before replacing. |
| `8 debits` | `108 2026-08` −448.49, `108 2026-09` −760.29 (Plumlee funds Bruce's 88); `103 2026-08` −94.82, `103 2026-09` −126.76 (Bruce funds Lamar's 81.11/111.86 and Sherwin's 13.71/14.90) — within a few cents; these are the design's §4.5 inferences, now read exactly. Any other owner: stop and ask. |

**R2. Reopen September.** `/payouts` → Processor months → each **September 2026** processor-month listed in `4 touched` → **Reopen**, reason: `Overrides move to company funding (owner decision 16 Nov 2026); replacing with the same file.` (The script refuses while any of them is paid, and names the month.)

**R3. The script: dry run.** SQL Editor: paste `scripts/set-override-funding.sql` as shipped (`do_commit := false`), Run. Expect an error that **starts `DRY RUN`** and reads:

```
overrides by recipient (agent 103 / 105 / 108 / total): 88 / 3 / 1 / 92
would change to company-funded: 91
left owner-funded: Lamar County Justice Court (agent 108, 25%)
final tally: 91 company, 1 owner, 92 in total
by recipient: 103 company 88, 105 company 3, 108 owner 1
committed months to REPLACE (override count): <processor YYYY-MM (n)>, ...
```

Anything else — "found N, expected M", a paid month, Lamar not owner-funded — **stop**; it changed nothing.

**R4. The script: commit.** Change the one literal to `do_commit boolean := true`, Run. The result grid: `changed 91, company 91, owner 1, total 92, replace <the months>`. Then the counts file again: `1 overrides` reads `103 company 88`, `105 company 3`, `108 owner 1`, `total 92`; `5 pending` lists the months to replace. (Audit: `select count(*) from audit_log where action = 'set_override_funding';` → 91, the admin as actor.)

**R5. Replace August and September.** For **each** processor-month in `5 pending`, August first: `/payouts/import`, that processor and month, upload **the same original file** that was committed (the CSV from the processor; never an Excel re-save), answer **Yes** to replace, review (the same warnings as at the first commit: confirm the same types), **Commit**. After each, `5 pending` loses that row. When it is empty, every committed line carries its override's funding.

**R6. Re-run the reconciliation.** `/admin/reports`, Report 1, **August 2026**, all processors, then **September 2026**. The expected figures (§8 of the design, with Lamar owner-funded):

| Rep | Month | Agent split | Override received | **Total agent commission** | ISO Hub | CRM − ISO Hub | Why |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Plumlee LLC (108) | Aug | 4,485.06 | 81.11 | **4,566.17** | 5,786.65 | −1,220.48 | ISO Hub's 50% self-override on 45 Smokes merchants (accepted; the CRM pays 50%). 50% of their residual is 1,220.50; the 0.02 is per-line rounding. |
| Bruce Rozar (103) | Aug | 963.02 | 448.49 | **1,411.51** | 1,170.31 | +241.20 | The 79 Plumlee overrides ISO Hub does not pay (448.49 − 207.31 = 241.18) + 0.02 rounding. |
| Sherwin Anderson (105) | Aug | 13,489.58 | 13.71 | **13,503.29** | 13,503.13 | +0.16 | ISO Hub's rounding of totals. |
| Plumlee LLC (108) | Sep | 7,603.23 | 111.86 | **7,715.09** | 11,135.17 | −3,420.08 | As August (3,420.25 less 0.17 rounding). |
| Bruce Rozar (103) | Sep | 1,514.86 | 760.29 | **2,275.15** | 1,715.27 | +559.88 | The 79 overrides (760.29 − 200.43 = 559.86) + 0.02 rounding. |
| Sherwin Anderson (105) | Sep | 12,837.95 | 14.90 | **12,852.85** | 12,852.67 | +0.18 | Rounding. |

All reps: August total commission **29,803.89** (was 29,341.69; +462.20 = Bruce's 448.49 and Sherwin's 13.71 now paid by the company), September **33,653.47** (was 32,878.28; +775.19). Report 2's **Overrides from company** totals 462.20 and 775.19; the company share falls by the same. Every other rep's row is unchanged to the cent. Any other difference: stop before R7; until Mark paid, a month is corrected by replace.

**R7. Mark paid September again.** `/payouts` → each September processor-month → **Mark paid** (type the label). Refused while the month is still in `5 pending` ("…changed who pays them after this month was committed. Replace the month first").

**P9. Clear and check.**

```powershell
Remove-Item Env:PGPASSWORD, Env:SUPABASE_DB_PASSWORD
Remove-Variable prod
npm run guard:linked     # dev, ok
```

**Fallback only (design D6):** if a September processor-month cannot be reopened and replaced (an adjustment already corrects it, `6 adjustments`), leave it paid and stop: the difference would be posted as adjustment lines in the open month (Plumlee +760.29, Bruce +14.90 for September, by processor and MID), which needs a variant of the funding function not built here. Ask before doing anything.

## 6. What can go wrong

Plain rule: **nothing before P5 changes prod.** After P5 the migration cannot be undone without the P2 backup, but it changed no figure. The funding changes (R4) are each audited and reversible one override at a time ("Change who pays", or `set_merchant_override_funding(id, 'owner', reason)`), then a replace. A replace can be redone until Mark paid.

| Step | What goes wrong | How you can tell | What to do | Undoable? |
| --- | --- | --- | --- | --- |
| P3/P5 | An override pair is not an owner-funded pair | `bad_pairs` > 0; the push names `batch N / override M` | Stop and ask. Do not edit ledger lines by hand | read-only / rolled back |
| P4 | More than one migration pending | the dry-run list | The project is not at `20261111120000`. Ask | read-only |
| P5 | Script ends FAIL | `RESULT: FAIL` | Bring the log from `scripts\logs\`; never `migration repair` | — |
| P5→P8 gap | Saving an override fails on the old app | "Could not find the function … set_merchant_override …" | Expected; keep the gap short | — |
| P7 | `export-report` not redeployed | Report 2's Excel has no Overrides from company column | Redeploy it | yes |
| R1 | `6 adjustments` or `7 drift` has rows | the counts file | Stop and ask before reopening | read-only |
| R3/R4 | "found N, expected M" | the script's message | Find which override is missing or extra (the counts file, section 1); never edit the constants to fit | nothing changed |
| R3/R4 | "marked paid … : TSYS 2026-09" | the script's message | Reopen that month (R2) and run again | nothing changed |
| R5 | Replace refused: "Adjustments already correct …" | the commit's message | That month is the fallback (above). Ask | nothing changed |
| R5 | A replace is committed with a different file | figures differ from R6 | Before Mark paid: replace again with the right file | yes |
| R6 | A difference not in the table | Report 1 vs ISO Hub | Stop before R7. Check `7 drift`, the merchant's rate and owner, the override | yes, until paid |
| R7 | Mark paid refused: "changed who pays them" | the message | That month is still pending: replace it (R5) | — |

## 7. Before we start

- [ ] **CLI linked to dev:** `npm run guard:linked` prints `… tapswipe-crm-dev (vdjtosofrimipklbdjbi) — dev, ok`.
- [ ] **Env vars cleared:** `Get-ChildItem Env: | Where-Object Name -in 'ALLOW_PROD_SUPABASE','SUPABASE_DB_PASSWORD','PGPASSWORD','ALLOW_REMOTE_SUPABASE_IN_DEV'` prints nothing.
- [ ] **Branch:** `git branch --show-current` → `override-funding`; `git status --short` → empty.
- [ ] **The original residual files** for every processor-month in R1's `4 touched`, August and September 2026, as committed (the processor's CSV), at hand for R5.
- [ ] **One clean e2e pass of the changed specs** (`merchant-override`, `admin-reports-export`) and `npm run test:live` green on the final commit, the local stack reachable from the host.
