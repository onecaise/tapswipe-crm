# Deploy batch 1 (intake-and-reports, Phases 1–5) — the plan

Written 28 Oct 2026 on `intake-and-reports` at `23023d0`, before anything was deployed. **A plan, not a record**: nothing in it has been run against a hosted project. Owen runs every hosted command himself, in PowerShell, one at a time, and reads the output before the next one.

Batch 1 = everything on `intake-and-reports` that `origin/master` (`122aa99`) does not have: Phases 1–5, the reset-script merge (`4c7ac4a`, `8287390`), and the design-memo commit `039562e` (docs only; it is on local `master` but not pushed).

## 0. Starting point, and what was checked

| Claim | Checked how | Result |
| --- | --- | --- |
| `origin/master` is `122aa99` | `git rev-parse origin/master` | **Yes.** Local `master` is one commit ahead (`039562e`, the design memo, docs only, unpushed). |
| Dev and prod are both at `20261023120000` | Cannot be checked without a hosted connection. The only local prod log (`scripts/logs/push-prod-migration_20261023-112414.log`) is a **dry run**: prod was then at `20261019130000` with three pending, ending at `20261023120000`. No log of the real push exists here. | **Not verified.** Step D2/P5's dry run settles it: it must list exactly the five migrations in §1, no more. |
| Both projects run the 12 repo functions | Not checkable offline. `docs/claude/project-state.md` says the three functions removed on 13 Oct (`create-upload-url`, `create-download-url`, `delete-document`) were **still deployed on dev and prod** until deleted by name. | **Not verified**, and the repo's own notes disagree: the hosted projects may have 15. Harmless for this batch (nothing calls them; batch 1 neither adds nor removes a function), but `functions list` in D4/P7 will show it. Deleting them is a separate, deliberate step, not part of this plan. |
| CLI is linked to prod | `supabase/.temp/linked-project.json` | **Yes**: `tapwipe-crm-prod` (`zuvsdkjnfstrjahstsmg`). Must be relinked to dev before anything in §4. |
| Vercel: `master` → prod, previews → dev DB | No Vercel config in the repo (`vercel.json`/`.vercel` absent); env vars live in the Vercel dashboard. | **Not verified.** Check it in the dashboard before P8 (see §7). |

## 1. The migrations (all five after `20261023120000`, in order)

`db push` applies **all** of these in one command; there is no "just the first one".

| # | File | What it does | Refuses to run when… |
| --- | --- | --- | --- |
| 1 | `20261023130000_processors.sql` | New `processors` table (TSYS, Red Fynn, PayBright, Netevia HQ, Square), select-only to signed-in users; FK from `merchants.processor`; new nullable `pre_apps.processor`; `approve_pre_app()` now copies the processor onto the merchant. | any `merchants.processor` is not NULL and not one of the five names (exact spelling and case). |
| 2 | `20261026120000_rep_identity.sql` | `profiles.legal_name` + `profiles.llc_legal_name` (nullable, ≤ 200 chars), admin-only `set_rep_identity()`; two optional CSV columns ("Legal name", "LLC legal name") and two new blockers on the bulk-import staging rows. | **Never** — adds nullable columns and widens a CHECK. |
| 3 | `20261026140000_pre_app_tax_secrets.sql` | Fourth encrypted table `pre_app_tax_secrets` (zero policies, service role only); **drops `pre_apps.ein_number`**; `ein_type` must be `EIN` or `SSN`; `submit_pre_app()` and `pre_app_secrets_presence()` rewritten for it. | any `pre_apps.ein_number` holds a value (the message names pre-app ids, not numbers); any `pre_apps.ein_type` is not NULL and not `EIN`/`SSN`. |
| 4 | `20261028120000_pre_app_required_fields.sql` | `profiles.split_rate_pct` (default 50, 0–50) and admin-only, audited `set_rep_split()`; pre-app snapshot columns `rep_legal_name`/`rep_llc_legal_name`; `split_agent_pct` 0–50; country fixed to `US` on pre-apps and owners (NULLs are filled with `US`); `pre_app_missing_fields()` returns every missing item; `submit_pre_app()` refuses with the whole list and copies the split and legal names from the rep's profile. | any `pre_apps.split_agent_pct` is below 0 or above 50; any `pre_apps.country` or `pre_app_owners.home_country` is not NULL and not `US`. |
| 5 | `20261028140000_pre_app_secret_reveal.sql` | `record_pre_app_secret_reveal()`: admin-only, writes one `audit_log` row per reveal, 30 per admin per hour. | **Never** at migration time (it only creates a function). |

**None of them refuses merely because a table has rows.** Each guard refuses only the specific rows it would break, and names them. When a guard fires, the whole push stops at that migration — earlier ones in the same push stay applied (see §6).

### The pre-check (read-only; run it in the SQL Editor before every push)

Mirrors all six guards above. Every count must be `0`. It reads `pre_apps.ein_number`, so it only runs **before** migration 3 (after it, that line errors because the column is gone — that is expected).

```sql
select 'merchants.processor outside the list' as would_refuse, count(*) as rows
  from merchants where processor is not null
   and processor not in ('TSYS','Red Fynn','PayBright','Netevia HQ','Square')
union all select 'pre_apps.ein_number holds a value', count(*)
  from pre_apps where ein_number is not null
union all select 'pre_apps.ein_type not EIN or SSN', count(*)
  from pre_apps where ein_type is not null and ein_type not in ('EIN','SSN')
union all select 'pre_apps.split_agent_pct outside 0-50', count(*)
  from pre_apps where split_agent_pct < 0 or split_agent_pct > 50
union all select 'pre_apps.country not US', count(*)
  from pre_apps where country is not null and country <> 'US'
union all select 'pre_app_owners.home_country not US', count(*)
  from pre_app_owners where home_country is not null and home_country <> 'US';
```

(Tested 28 Oct 2026 against the local stack with `ein_number` re-added inside a rolled-back transaction: six rows, all 0.)

## 2. Edge Functions changed since `122aa99`

Derived from `git diff --stat 122aa99 HEAD -- supabase/functions` plus each function's relative imports (`grep "from '../_shared/…'"`, and `_shared` files that import each other). **All twelve are affected**, because `_shared/admin-users.ts` changed and ten functions import it.

Changed files: `_shared/admin-users.ts` (adds `isRepIdentityName`, `REP_IDENTITY_MAX_LENGTH` — additive only), `_shared/crypto.ts` (AAD accepts `pre_app_tax_secrets`), `_shared/pre-app-secrets.ts`, `_shared/provision-user.ts`, `_shared/user-imports.ts`, and the `index.ts` of `create-user`, `provision-user-batch`, `read-pre-app-secrets`, `stage-user-import`, `submit-pre-app-secrets`.

| Function | Why it must be redeployed | Behaviour changes? |
| --- | --- | --- |
| `submit-pre-app-secrets` | own `index.ts`; `_shared/pre-app-secrets.ts`; `_shared/crypto.ts` | **Yes** — accepts and encrypts the tax ID into `pre_app_tax_secrets`. |
| `read-pre-app-secrets` | own `index.ts`; `_shared/pre-app-secrets.ts`; `_shared/crypto.ts` | **Yes** — last four for everyone; one-field admin `reveal`, audited first. |
| `create-user` | own `index.ts`; `_shared/provision-user.ts` (→ `admin-users.ts`); `_shared/admin-users.ts` | **Yes** — takes both legal names. |
| `provision-user-batch` | own `index.ts`; `_shared/user-imports.ts`; `_shared/provision-user.ts`; `_shared/admin-users.ts` | **Yes** — passes the names to `set_rep_identity()`. |
| `stage-user-import` | own `index.ts`; `_shared/user-imports.ts`; `_shared/admin-users.ts` | **Yes** — reads the two name columns, two new blockers. |
| `admin-reset-password` | `_shared/admin-users.ts` | No (new exports unused) |
| `deactivate-user` | `_shared/admin-users.ts` | No |
| `business-document-file-url` | `_shared/admin-users.ts` | No |
| `marketing-material-file-url` | `_shared/admin-users.ts` | No |
| `residual-import-file-url` | `_shared/admin-users.ts` | No |
| `parse-residual-import` | `_shared/admin-users.ts` | No |
| `export-residuals` | `_shared/admin-users.ts` | No |

Recommendation: deploy **all twelve** with one bare `functions deploy` (no name). The seven "no" rows would run identically if skipped, but deploying them keeps the hosted bundles equal to the repo, which is the only state anyone can reason about later. `config.toml` is unchanged since `122aa99`, so every function stays `verify_jwt = false`.

**Order matters: migrations first, functions second.** The new `submit-pre-app-secrets` writes to `pre_app_tax_secrets` and `stage-user-import` writes `legal_name_raw`; both fail until migrations 2 and 3 exist. The old functions against the new schema are also partly broken (the old tax ID path is gone), so keep the gap between push and deploy short, and keep people out of the app in between.

## 3. Hosted dashboard changes

**None needed.** Checked with:

- `git diff 122aa99 HEAD -- supabase/config.toml supabase/templates next.config.ts proxy.ts lib/supabase app/auth .env.example` → empty. No Auth setting, email template, redirect URL or app env var moved.
- New `Deno.env.get` / `process.env` / `NEXT_PUBLIC_` in the diff (code only) → none. The functions read one secret, `PRE_APP_SECRETS_KEY`, already set on both projects. `pre_app_tax_secrets` uses the same key.
- New Storage bucket → none. New Vercel env var → none.

One **data** change after the prod push (not a dashboard setting): the house profile (agent code 122) needs its split set to **0** with `set_rep_split` — the migration defaults everyone to 50 and deliberately hard-codes nobody. Reps also need both legal names set before their first submit (see D-tests).

## 4. DEV sequence

Assumes §7 is done (linked to dev, guard prints `dev, ok`). Dev must be **awake** (dashboard → project not `INACTIVE`); a paused dev shows up as a connection timeout in D2.

**D1. Backup** (real data never goes inside the repo):

```powershell
npm run db:dump -- -f C:\Users\owen\tapswipe-backups\dev-schema-2026-10-DD.sql
npm run db:dump -- --data-only -f C:\Users\owen\tapswipe-backups\dev-data-2026-10-DD.sql
```

Both files must exist and be non-empty. No backup, no push.

**D2. Pre-check + dry run.**

1. SQL Editor, project name top-left **`tapswipe-crm-dev`**: run the §1 pre-check. All six 0. If not: dev holds test data that a guard would refuse — either run the reset on dev first (`docs/claude/reset-business-data.md`, dev steps) or stop and ask.
2. `npm run migration:list` — the Remote column must end at `20261023120000`, with exactly the five §1 versions missing on the remote.
3. `npm run db:push -- --dry-run` — must say "Would push these migrations" and list **exactly** the five §1 files, nothing else.

**D3. Push.** `npm run db:push` (answer `y`). Then `npm run migration:list`: local and remote both end at `20261028140000`. Then run the §5 verification queries (P6) in the dev SQL Editor.

**D4. Deploy functions.** `npm run functions:deploy` (no name = all twelve). Then:

```powershell
npx supabase functions list --project-ref vdjtosofrimipklbdjbi
```

All twelve `ACTIVE`, each with a new version / updated time from today. (Legacy names, if listed, have an old time — see §0.)

**D5. Preview.** `git push -u origin intake-and-reports`. Vercel builds a preview; open its URL from the Vercel dashboard. Confirm it really talks to dev: sign in, and the data you see is dev's (or: browser DevTools → Network → requests go to `vdjtosofrimipklbdjbi.supabase.co`). If the requests go to `zuvsdkjnfstrjahstsmg`, **stop** — the preview is pointed at prod.

**D6. Manual checklist on the preview** (two browsers or one normal + one private window: one admin, one rep). Tick each:

- [ ] **Create a user with both legal names.** Admin → `/admin/users` → new user, fill Legal name and LLC legal name. The user list's **Legal names** column shows both on that row.
- [ ] **Bulk import with names.** `/admin/users/import`. CSV headers, exact spelling (no aliases): `Full name,Email,Role,Agent #,Legal name,LLC legal name`, one valid rep row. Review shows both names; provision; the new account's Legal names column shows both. (Optional: a 201-character name is blocked as "Legal name too long".)
- [ ] **Set a rate.** In the **Split** column (writes through `set_rep_split`), set the test rep to e.g. 40. Saved value shows 40. Entering 60 is refused ("between 0 and 50").
- [ ] **Submit refuses with the whole list first.** As the rep, start a pre-app, fill almost nothing, go to Review: every missing item is listed at once. Press Submit: refused, with the same full list (not just the first problem). If the rep has no legal names on file, that appears in the list as a rep-identity item.
- [ ] **Fill and submit.** Fill every item including owner SSN, banking, terminal password, EIN type + tax ID, and pick a processor. Submit succeeds; status becomes submitted.
- [ ] **Rep sees last four only, cannot reveal.** As the rep, open the submitted pre-app: SSN, account number, routing, tax ID show last four; RP password shows as present only. There is **no** Show button.
- [ ] **Admin reveal, then Back.** As admin, open the same pre-app: last four by default (RP password: present only). Press **Show** beside one field (e.g. "Show tax ID"): the full value appears, for that field only. Navigate away (e.g. to Dashboard), then press the browser **Back** button: the field is **masked again** (last four), not the full value.
- [ ] **Reveal is audited.** (SQL Editor, dev) `select actor_id, action, row_id, created_at from audit_log where action like 'read_pre_app_secrets:reveal:%' order by created_at desc limit 5;` — one row for the reveal above.
- [ ] **Approve copies processor and split.** As admin, approve the pre-app. Open the new merchant: processor is the one chosen; split shows the rep's 40 / company 60 (the snapshot taken at submit).
- [ ] **Print shows no secret.** Open the merchant's print page (`/merchants/<id>/print`) and the blank pre-app form (`/pre-apps/blank-form`): no SSN, account number, routing number or tax ID anywhere (search the page for the last four digits too).

Dev passes when every box is ticked. Anything unticked: stop, note what you saw, do not start §5.

## 5. PROD sequence

Only after dev passed. Same day if possible, in one sitting, nobody else signed in to prod.

**Why the reset comes BEFORE the push.** Three of the five migrations (1, 3, 4) refuse to run over specific values — a free-text merchant processor, any plaintext EIN, an `ein_type` outside EIN/SSN, a split over 50, a non-US country. Prod holds test data from before, and any one such row stops the push half-way (see §6). Emptying the business tables first makes all six guards pass by construction, with no mapping decisions to make on data that is about to be deleted anyway. The reset script is built to run on a schema that is behind the repo: tables that do not exist yet (`processors`, `pre_app_tax_secrets`) are reported `absent, skipped`. Resetting after the push would also work only if the push got through — which is exactly what the test data might prevent.

**P1. Prod connection in this terminal.** Linked project stays **dev**; prod is reached by URL and `--project-ref` only.

```powershell
$sec = Read-Host -AsSecureString "prod database password"
$env:PGPASSWORD = [Net.NetworkCredential]::new('', $sec).Password
$env:SUPABASE_DB_PASSWORD = $env:PGPASSWORD      # push-prod-migration.ps1 reads this name
Remove-Variable sec
$prod = "postgresql://postgres.zuvsdkjnfstrjahstsmg@aws-0-us-west-2.pooler.supabase.com:5432/postgres"   # no password in it
```

**P2. Fresh backup.**

```powershell
npx supabase db dump --db-url $prod -f C:\Users\owen\tapswipe-backups\prod-schema-2026-10-DD.sql
npx supabase db dump --db-url $prod --data-only -f C:\Users\owen\tapswipe-backups\prod-data-2026-10-DD.sql
```

Both non-empty. (Measured 28 Oct 2026 on the local stack: `db dump --db-url` takes the password from `PGPASSWORD` — wrong value fails with `password authentication failed`, right one dumps. Note `docs/claude/reset-business-data.md` step 1 still shows the older form with the password inside the URL; use this one.)

**P3. Final reset** — `docs/claude/reset-business-data.md` steps 2–10, on **`tapwipe-crm-prod`** (check the name top-left before every Run):

1. counts before → save;
2. dry run → must start `DRY RUN: rolled back, nothing was changed. Every check passed.` On prod **before the push**, `processors` and `pre_app_tax_secrets` say `absent, skipped` — correct; the runbook's "processors (5)" applies only after migration 1;
3. counts again = identical;
4. commit: `do_commit := true` and `expected_emails := array['owen@tapswipellc.com', 'owen7550@icloud.com']::text[]` in the editor only;
5. counts after → save as the record; close the edited query without saving;
6. **Storage files by hand**: inventory query, delete every file in all four buckets (`documents`, `residual-imports`, `marketing`, `business-documents`), inventory again → no rows; counts final.

**P4. Pre-check.** §1 pre-check on prod → six 0s (it should be, right after the reset).

**P5. Dry run of the push.** Needs the **local stack running** (`npx supabase start`): the script borrows its DB container as a psql client; the push itself goes to prod.

```powershell
powershell -File scripts\push-prod-migration.ps1 -DryRun
```

Must show `TARGET aws-0-us-west-2.pooler.supabase.com:5432 as postgres.zuvsdkjnfstrjahstsmg`, `latest=20261023120000`, and "Would push these migrations" with **exactly** the five §1 files. Anything else: stop.

**P6. Push.** `powershell -File scripts\push-prod-migration.ps1` → must end `RESULT: PASS`. That PASS covers "all 70 versions recorded" plus older structure checks; it does **not** look at batch 1's objects, so run these in the prod SQL Editor:

```sql
-- the five versions
select version from supabase_migrations.schema_migrations
 where version > '20261023120000' order by version;                -- 5 rows, ending 20261028140000
-- processors seeded
select code from processors order by sort_order;                    -- TSYS, Red Fynn, PayBright, Netevia HQ, Square
-- new columns present, ein_number gone
select table_name, column_name from information_schema.columns
 where table_schema = 'public'
   and ((table_name = 'pre_apps' and column_name in ('processor','rep_legal_name','rep_llc_legal_name','ein_number'))
     or (table_name = 'profiles' and column_name in ('legal_name','llc_legal_name','split_rate_pct'))
     or (table_name = 'user_import_rows' and column_name in ('legal_name','llc_legal_name')))
 order by 1, 2;                                                     -- 8 rows; NO pre_apps.ein_number
-- the new secrets table is locked
select c.relrowsecurity as rls_on,
       (select count(*) from pg_policies where schemaname = 'public' and tablename = 'pre_app_tax_secrets') as policies,
       has_table_privilege('authenticated', c.oid, 'select') as authenticated_can_read,
       has_table_privilege('anon', c.oid, 'select') as anon_can_read
  from pg_class c where c.oid = 'public.pre_app_tax_secrets'::regclass;   -- t, 0, f, f
-- no new function callable by anon
select p.proname, p.prosecdef as definer,
       has_function_privilege('anon', p.oid, 'execute') as anon_can_call,
       has_function_privilege('authenticated', p.oid, 'execute') as signed_in_can_call
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and p.proname in ('set_rep_identity','set_rep_split','pre_app_missing_fields',
                     'record_pre_app_secret_reveal','submit_pre_app','approve_pre_app','pre_app_secrets_presence')
 order by 1;                                                        -- 7 rows: definer t, anon f, signed-in t
```

(All five tested against the local stack on 28 Oct 2026 with the expected results shown.)

**P7. Function deploys.** No npm wrapper (the guard refuses `--project-ref`, by design):

```powershell
npx supabase functions deploy --project-ref zuvsdkjnfstrjahstsmg
npx supabase functions list --project-ref zuvsdkjnfstrjahstsmg
```

All twelve `ACTIVE`, updated today. Then prove the code runs (expect **401** from each function's own guard; **404** would mean the slug does not exist):

```powershell
foreach ($f in 'create-user','deactivate-user','admin-reset-password','submit-pre-app-secrets','read-pre-app-secrets','residual-import-file-url','parse-residual-import','export-residuals','stage-user-import','provision-user-batch','marketing-material-file-url','business-document-file-url') {
  "$f " + (curl.exe -s -o NUL -w "%{http_code}" -X POST "https://zuvsdkjnfstrjahstsmg.supabase.co/functions/v1/$f")
}
```

**P8. Merge to master and deploy the app.**

```powershell
git checkout master
git pull --ff-only
git merge --no-ff intake-and-reports
git push origin master
```

Vercel builds `master` for production. Wait for the build to show **Ready** in the Vercel dashboard. (Before pushing, confirm in Vercel → Settings → Git that the Production Branch is `master`, and that the Production env vars point at `zuvsdkjnfstrjahstsmg` — §0, not verifiable from the repo.)

**P9. Clear the credential and tidy.**

```powershell
Remove-Item Env:PGPASSWORD, Env:SUPABASE_DB_PASSWORD
Remove-Variable prod
npm run guard:linked     # still: dev, ok
npm run test:deployed    # 29 pass (it checks Auth settings and older schema; it does not cover batch 1)
```

**P10. Short browser check on production** (as admin):

- [ ] sign in; Dashboard loads; no error banner;
- [ ] Manage Users shows the Legal name / LLC legal name and split columns;
- [ ] set the house profile (agent 122) split to **0**; set legal names on each real rep;
- [ ] Pre-Apps → new: the processor dropdown lists the five; country is fixed to US;
- [ ] open `/pre-apps/blank-form`: renders, no secret fields filled.

Do **not** create test pre-apps on prod: the point of the reset was an empty database. If a smoke test is wanted, do it on dev.

## 6. What can go wrong

Plain rule: **nothing before P3-step 4 changes prod**. After that, two things cannot be undone without the P2 backup: the reset commit and the Storage deletes. A pushed migration cannot be "un-pushed" either — only restored over.

| Step | What goes wrong | How you can tell | What to do | Undoable? |
| --- | --- | --- | --- | --- |
| §7 relink | Still linked to prod | `npm run guard:linked` prints `REFUSING ... PRODUCTION` | Relink to dev (§7) | — |
| D1/P2 backup | Empty or missing file; auth failure | file size 0; `password authentication failed`; `Tenant or user not found` = wrong pooler host (`aws-0` is right) | Fix and re-run. **Never** continue without a backup | read-only |
| D2 | Dev paused | `connection timeout`, or `status 'INACTIVE'` | Restore dev in the dashboard, wait, re-run | — |
| D2/P5 dry run | Lists more or fewer than the five | the list | Stop: the remote is not where §0 assumed. Ask before pushing | read-only |
| D3/P6 push | A guard fires | red `... migration refuses to run: ...` naming the rows | Earlier migrations in the same push **stay applied**; the refusing one and those after it do not. Fix the named rows (or reset), re-run the push — it continues from where it stopped. Never `migration repair` | partial; restore from backup |
| D3/P6 push | Hangs | no output for minutes | It is waiting at a prompt; the script uses `--yes` and streams. Ctrl+C, then run the read-only `scripts\diag-prod-trigger.ps1` before anything else | — |
| P6 | Script says FAIL after a push | `RESULT: FAIL` and a named problem | Do not re-run blindly ("db push skips recorded versions"). Bring the log from `scripts\logs\` | — |
| D4/P7 deploy | One function fails to bundle, or old version still live | error in deploy output; `functions list` time not today; curl gives 404 | Re-run deploy for that name: `npx supabase functions deploy <name> --project-ref <ref>`. Deploys are repeatable and replace the previous version | redeploy older code from `122aa99` if needed |
| Gap between push and deploy | Old app/old functions on new schema | pre-app tax ID / secrets steps error | Expected; keep the gap short and no users in | — |
| P3 reset | Dry run red with anything else | message other than `DRY RUN: rolled back…` | Stop. Nothing changed | — |
| P3 reset commit | Wrong project or wrong `expected_emails` | project name top-left; script refuses and rolls back if an email is missing | Script refusal = nothing changed. A wrong-project commit = **restore from backup** | **No** (backup only) |
| P3 Storage | Deleted the wrong bucket's files / the buckets themselves | buckets list | Delete files, never buckets. File deletes **cannot be undone** and are not in the DB backup | **No** |
| D5/P8 Vercel | Build fails | Vercel shows Error | The previous production deployment keeps serving; fix and push again, or Vercel → Deployments → *Promote* the previous one | yes (Vercel rollback) |
| D5/P8 Vercel | Preview points at prod, or prod at dev | Network tab shows the other project's ref | Stop; fix env vars in Vercel before any test | — |
| D6 | A checklist item fails | as described per item | Stop before §5; it is a code bug — fix on the branch, re-run `npm test`/e2e, redeploy to dev | — |

## 7. Before we start

- [ ] **Relink the CLI to dev:** `npx supabase link --project-ref vdjtosofrimipklbdjbi`, then `npm run guard:linked` must print exactly
      `[supabase-guard] linked project: tapswipe-crm-dev (vdjtosofrimipklbdjbi) — dev, ok`
      (the guard prints `name (ref)` from `supabase/.temp/linked-project.json`). After the relink, `supabase stop` / `supabase start` the local stack, because `.temp/*-version` now follows dev (CLAUDE.md, "local stack's service versions").
- [ ] **Env vars cleared** in the PowerShell window you will use: `Get-ChildItem Env: | Where-Object Name -in 'ALLOW_PROD_SUPABASE','SUPABASE_DB_PASSWORD','PGPASSWORD','ALLOW_REMOTE_SUPABASE_IN_DEV'` prints nothing. (P1 sets the two password ones deliberately, later.)
- [ ] **Branch:** `git branch --show-current` → `intake-and-reports`.
- [ ] **Clean tree:** `git status --short` → empty.
- [ ] **Full green on the final commit** after a stack restart: `npm test` and `npm run test:e2e` (run 28 Oct 2026 — results below).

### Test results on this commit (28 Oct 2026)

Run after `supabase stop` / `supabase start` (local stack at 70 migrations, newest `20261028140000`) and a fresh `functions serve --env-file ./supabase/functions/.env`. Note: the local stack was started while the CLI was **linked to prod**, so it ran prod's recorded service versions; rerun after the dev relink if the two differ.

- `npm test`: **2545 passed (2545), 113 files passed (113)**, 343 s — equal to the CLAUDE.md baseline. Plus `tests/unit/claude-md.test.ts` re-run after this file was added to the index: 4/4.
- `npm run test:e2e`: **346 passed (346)** in 13.8 min, `retries: 0`, none flaky — equal to the baseline.
