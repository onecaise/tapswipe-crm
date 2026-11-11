# Deploy the residual build (intake-residuals, Phases 6–14, 14b and 15) — the plan

Written 6 Nov 2026 on `intake-residuals` at `2ca866f`, before anything was deployed. **A plan, not a record**: nothing in it has been run against a hosted project. Owen runs every hosted command himself, in PowerShell, one at a time, and reads the output before the next one. It assumes **batch 1 is already on both projects** (`docs/claude/deploy-batch-1.md`): dev and prod at migration `20261028140000`, twelve functions deployed from `40c02d9` (the tip of `intake-and-reports`), `master` containing batch 1.

This batch = everything on `intake-residuals` after `40c02d9`: Phases 6–14 (`d7f65bc` … `b3e6399`), the alphanumeric-MID change (`2ca866f`) and phase 15, the real ISO Hub files (11 Nov 2026: migration #14, `parse-residual-import` again; §0d of `docs/design/intake-and-reports.md`).

## 0. Starting point, and what was checked

| Claim | Checked how | Result |
| --- | --- | --- |
| Batch 1's deploy commit is `40c02d9` | `git rev-parse intake-and-reports origin/intake-and-reports` → both `40c02d9`; `git merge-base --is-ancestor 40c02d9 HEAD` → yes | **Yes**, and this branch contains it. |
| Dev and prod are at `20261028140000` | Not checkable offline; it is this plan's premise. | **Not verified.** D2/P5's `migration:list` / dry run settles it: exactly the 14 versions in §1 pending, no more, no fewer. If batch 1 is not on a project yet, run `deploy-batch-1.md` there first. |
| 84 migrations in the repo | `ls supabase/migrations \| wc -l` | 70 (batch 1) + 14 (this batch). `push-prod-migration.ps1` should end `RESULT: PASS -- all 84 migrations are recorded`. |
| The pre-check below is right | Run on PGlite built to exactly `20261028140000` (6 Nov 2026): 24 rows, all `0`. With a committed batch, two MIDs differing only in case and a `365 pay` processor added, it flagged exactly those three, and replaying the 13 migrations stopped at `20261030140000` naming the batch. | **Verified locally.** |
| The two fixture files stage as described in D6 | Read through the real `_shared/merchant-imports.ts` and `_shared/residuals.ts` code (6 Nov 2026) with the D6 reps as lookups | **Verified in code**, not on dev: every refusal and note listed in D6 appeared on its row, nothing else. |
| Vercel: `master` → prod, previews → dev | No Vercel config in the repo. | **Not verified** (as in batch 1). Check in the dashboard before D5/P8. |

## 1. The migrations (all 14 after `20261028140000`, in order)

`db push` applies **all** of them in one command. **None refuses because a table has rows**; each guard names the specific rows it cannot carry. When one fires, the push stops there; the earlier ones in the same push **stay applied** (see §6).

| # | File | What it does | Refuses to run when… |
| --- | --- | --- | --- |
| 1 | `20261030120000_import_schema.sql` | Processor and month on a residual batch, one committed batch per processor-month, status `replaced`, the staging warnings, the ledger's `processor` and confirmed-negative marker, the merge key with the processor, `payout_period_closures` (Mark paid). | a ledger line has a negative volume (the old CHECK forbids it, so only after a hand edit); four definition checks (merge key, volume CHECK, batch status CHECK, blocker CHECK) differ from what it replaces. |
| 2 | `20261030140000_import_parser.sql` | Processor and month required on new batches, the staging columns for the six-column file, `blockers[]`, the narrowed blocker list, the `payee_changed` note. | **a committed batch without processor or month — which is every committed residual batch already on the project**, because #1 adds the column empty and nothing fills it; a staged row carries a retired blocker (`unknown_agent`, `unparseable_period`, `bad_number`, `duplicate_in_file`). |
| 3 | `20261030160000_commit_v3.sql` | `commit_residual_import_v3` (the merchant's rate, owner re-resolved, no merge), v2 dropped, the merchant rate 0–50 CHECK and `set_merchant_split`, shares held to the owner. | **a merchant with a rate above 50** (or below 0, or a company half that is not 100 minus it); two share/ledger CHECK definitions differ. |
| 4 | `20261030180000_merchant_default_rate.sql` | A merchant created without a rate takes its owner's profile rate (A31). | Never (a function and a trigger). |
| 5 | `20261030190000_replace_paid_adjustments.sql` | Replace inside v3, Mark paid / Reopen, `delete_payout_period()`, `post_payout_adjustment()`, `audit_log.detail`, batch status `deleted`. | the ledger's `admin only delete` policy is missing (hand edit). Its three CHECK-definition checks read what #1–#3 create, so they cannot fire in this push. |
| 6 | `20261102120000_merchant_overrides.sql` | `merchant_overrides` and its three functions, override lines in v3, `rep_payout` regenerated with the override branch, `my_override_recipients()`. | three ledger CHECK definitions differ; something depends on, or a column grant sits on, `rep_payout_rows.rep_payout`. **A merchant with a live override cannot exist yet** (the table is new), and a live share does not stop any migration (see "commit time" below). |
| 7 | `20261102140000_lock_residuals.sql` | No client UPDATE on the ledger at all, a trigger refusing every client role; `set_shared_residual()` dropped. | the ledger's `admin only update` policy or `set_shared_residual(int, date, numeric)` is missing (hand edit). |
| 8 | `20261102160000_reports.sql` | `rep_payout_summary()` and `merchant_processor_summary()` (invoker, `is_admin()` first). | a column they read is missing; either function already exists (`create function`, not `or replace`). |
| 9 | `20261104120000_zero_volume_not_bad_numbers.sql` | v3 re-created: `bad_numbers` = volume < 0 or (volume > 0 and residual > volume). | v3 is not #6's body (cannot fire: #6 created it in this push). |
| 10 | `20261104140000_retire_legacy_import.sql` | Drops `commit_residual_import(int)`, `acknowledge_residual_skips(int)`, `skipped_rows`, `skips_acknowledged_at`; narrows `preview_flag`; v3 re-created. | **a batch holds a skip record** (`skipped_rows` not empty); a staged row has a retired preview flag; v3 is not #9's body (cannot fire). |
| 11 | `20261104150000_set_territory_ascii_trim.sql` | `set_territory()` trims every ASCII whitespace. | `set_territory` is not the 20261002143000 body (hand edit). |
| 12 | `20261106120000_merchant_import.sql` | Merchant bulk import: two staging tables, `commit_merchant_import()`, the location exception, the sixth processor **365 Pay**. | **a processor row is `365 Pay` in another spelling or label**, or sort order 60 is taken; **the location trigger body check**: `enforce_merchant_location()` does not contain `if NEW.city is null or NEW.state is null then` exactly once (it is the 20261013130000 body). |
| 13 | `20261106140000_alphanumeric_mids.sql` | `mid_key()`, the unique index `merchants_mid_key_ci`, v3 / `delete_payout_period` / `post_payout_adjustment` matching MIDs by key. | **two merchants' MIDs differ only in case or surrounding spaces** (it names them); a function body it copied differs (cannot fire: #5, #6 and #10 created them in this push). |
| 14 | `20261111120000_iso_hub_files.sql` | Phase 15: `processor_key()` (case, spaces, punctuation ignored; Goat → TSYS, Netevia → Netevia HQ), the fourth warning `other_income_type` in the staging CHECK, v3 re-created: another Income Type is that warning (no longer a refusal), a blank Processor cell is no `processor_mismatch`. | v3 is not #13's body (its Income Type refusal, `processor_mismatch` line and confirmable list, each exactly once) — cannot fire: #13 created it in this push. Its CHECK only widens. |

**Not refused at apply time, but refused later at commit** (worth knowing before the first import): a merchant with no rate (v3 refuses its MID); a share whose signer is not the owner or whose shares do not total the merchant's rate (v3 refuses its MID); a review batch started before #2 (it can be abandoned, never committed).

### The pre-check (read-only; SQL Editor, before every push)

Verified as described in §0. #14 (phase 15) adds no row: its one guard reads the v3 body #13 creates in the same push, and its CHECK only admits one more warning (`tests/rls/iso-hub-files.test.ts` applies it over a populated database: no row changes). Every `n` must be `0`. Rows 1–9 are data; the `D` rows are definitions that only a hand edit could have changed.

```sql
-- Read-only. Run on a project at 20261028140000, BEFORE the push. Every n must be 0.
select label, n from (
  select '1 20261030120000: ledger line with a negative volume' as label, count(*)::int as n
    from rep_payout_rows where volume < 0
  union all select '2 20261030140000: committed batch (gets no processor or month)', count(*)::int
    from rep_payout_batches where status = 'committed'
  union all select '3 20261030140000: staged row with a retired blocker', count(*)::int
    from rep_payout_import_rows where blocker in ('unknown_agent','unparseable_period','bad_number','duplicate_in_file')
  union all select '4 20261030160000: merchant rate outside 0-50 or halves not 100', count(*)::int
    from merchants
   where not ((split_agent_pct is null and split_company_pct is null)
              or (split_agent_pct between 0 and 50 and split_company_pct = 100 - split_agent_pct))
  union all select '5 20261104140000: batch with a skip record', count(*)::int
    from rep_payout_batches where jsonb_array_length(skipped_rows) > 0
  union all select '6 20261104140000: staged row with a retired preview flag', count(*)::int
    from rep_payout_import_rows where preview_flag in ('share_not_applied','partner_named','line_not_shared','looks_shared')
  union all select '7 20261106120000: a processor that is 365 Pay in another spelling', count(*)::int
    from processors
   where (lower(btrim(code)) = '365 pay' or lower(btrim(label)) = '365 pay')
     and not (code = '365 Pay' and label = '365 Pay' and sort_order = 60)
  union all select '8 20261106120000: sort order 60 already taken', count(*)::int
    from processors where sort_order = 60 and code <> '365 Pay'
  union all select '9 20261106140000: merchant MIDs equal ignoring case and spaces (groups)', count(*)::int
    from (select upper(btrim(mid)) from merchants where mid is not null group by 1 having count(*) > 1) g
  union all select 'D 20261030120000: ledger merge key', count(*)::int from (select 1) x
   where (select indexdef from pg_indexes where schemaname = 'public' and indexname = 'rep_payout_rows_import_merge_key')
     is distinct from 'CREATE UNIQUE INDEX rep_payout_rows_import_merge_key ON public.rep_payout_rows USING btree (period, agent_id, mid) WHERE (line_kind = ''import''::text)'
  union all select 'D 20261030120000: ledger volume CHECK', count(*)::int from (select 1) x
   where (select pg_get_constraintdef(oid) from pg_constraint
           where conrelid = 'public.rep_payout_rows'::regclass and conname = 'rep_payout_rows_volume_check')
     is distinct from 'CHECK ((volume >= (0)::numeric))'
  union all select 'D 20261030120000: batch status CHECK', count(*)::int from (select 1) x
   where (select pg_get_constraintdef(oid) from pg_constraint
           where conrelid = 'public.rep_payout_batches'::regclass and conname = 'rep_payout_batches_status_check')
     is distinct from 'CHECK ((status = ANY (ARRAY[''review''::text, ''committed''::text, ''abandoned''::text])))'
  union all select 'D 20261030120000: staged blocker CHECK', count(*)::int from (select 1) x
   where (select pg_get_constraintdef(oid) from pg_constraint
           where conrelid = 'public.rep_payout_import_rows'::regclass and conname = 'rep_payout_import_rows_blocker_check')
     is distinct from 'CHECK ((blocker = ANY (ARRAY[''unknown_agent''::text, ''unparseable_period''::text, ''bad_number''::text, ''missing_mid''::text, ''duplicate_in_file''::text])))'
  union all select 'D 20261030160000: share total CHECK', count(*)::int from (select 1) x
   where (select pg_get_constraintdef(oid) from pg_constraint
           where conrelid = 'public.merchant_rep_shares'::regclass and conname = 'merchant_rep_shares_total_rep_side')
     is distinct from 'CHECK (((primary_rep_pct + secondary_rep_pct) = 50.00))'
  union all select 'D 20261030160000: ledger share snapshot CHECK', count(*)::int from (select 1) x
   where (select pg_get_constraintdef(oid) from pg_constraint
           where conrelid = 'public.rep_payout_rows'::regclass and conname = 'rep_payout_rows_share_snapshot')
     is distinct from 'CHECK (((primary_rep_pct IS NULL) OR ((primary_rep_pct > (0)::numeric) AND (secondary_rep_pct > (0)::numeric) AND ((primary_rep_pct + secondary_rep_pct) = 50.00))))'
  union all select 'D 20261030190000: "admin only delete" policy on the ledger', count(*)::int from (select 1) x
   where not exists (select 1 from pg_policy where polrelid = 'public.rep_payout_rows'::regclass and polname = 'admin only delete')
  union all select 'D 20261102120000: line_kind CHECK', count(*)::int from (select 1) x
   where (select pg_get_constraintdef(oid) from pg_constraint
           where conrelid = 'public.rep_payout_rows'::regclass and conname = 'rep_payout_rows_line_kind')
     is distinct from 'CHECK ((line_kind = ANY (ARRAY[''import''::text, ''adjustment''::text])))'
  union all select 'D 20261102120000: objects depending on rep_payout', count(*)::int
    from pg_depend d join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
   where d.refobjid = 'public.rep_payout_rows'::regclass and a.attname = 'rep_payout'
     and d.classid <> 'pg_attrdef'::regclass
  union all select 'D 20261102120000: column privileges on rep_payout', count(*)::int
    from pg_attribute where attrelid = 'public.rep_payout_rows'::regclass and attname = 'rep_payout' and attacl is not null
  union all select 'D 20261102140000: "admin only update" policy on the ledger', count(*)::int from (select 1) x
   where not exists (select 1 from pg_policy where polrelid = 'public.rep_payout_rows'::regclass
                      and polname = 'admin only update' and polcmd = 'w')
  union all select 'D 20261102140000: set_shared_residual missing', count(*)::int from (select 1) x
   where to_regprocedure('public.set_shared_residual(int, date, numeric)') is null
  union all select 'D 20261102160000: report functions already exist', count(*)::int
    from pg_proc where pronamespace = 'public'::regnamespace
     and proname in ('rep_payout_summary', 'merchant_processor_summary')
  union all select 'D 20261104150000: set_territory body', count(*)::int from
    (select pg_get_functiondef(to_regprocedure('public.set_territory(uuid, text)')) as b,
            'normalised := nullif(btrim(coalesce(new_territory, '''')), '''');'::text as o) s
   where b is null or (length(b) - length(replace(b, o, ''))) / length(o) <> 1
  union all select 'D 20261106120000: enforce_merchant_location body', count(*)::int from
    (select (select prosrc from pg_proc where oid = to_regprocedure('public.enforce_merchant_location()')) as b,
            'if NEW.city is null or NEW.state is null then'::text as o) s
   where b is null or (length(b) - length(replace(b, o, ''))) / length(o) <> 1
) checks
order by label;
```

The query reads `skipped_rows`, which #10 drops: after the push, that line errors. Expected; it is a before-the-push query. To list the rows behind a non-zero count: row 2 `select id, file_name, committed_at from rep_payout_batches where status = 'committed'`; row 4 `select id, mid, dba, split_agent_pct, split_company_pct from merchants where …` (the same predicate); row 9 is the query in #13's header comment.

**If row 2 is not 0.** The batches cannot be fixed before the push (the column does not exist yet). On **dev**: run the reset (`docs/claude/reset-business-data.md`, dev steps) — dev holds test data. The current `scripts/reset-business-data.sql` works at this point, with dev still at `20261028140000`: it skips the four tables that do not exist yet (`merchant_overrides`, `payout_period_closures`, `merchant_import_batches`, `merchant_import_rows`) and reports them "absent (skipped)" (checked 6 Nov 2026 on PGlite at the batch 1 schema: dry run passed, commit cleared the other 32 tables). On **prod**: stop and ask. The repair, if wanted, is to let the push stop at #2 (#1 stays applied), set `processor` and `period` on each named batch by hand in the SQL Editor, and run the push again.

## 2. Edge Functions changed since `40c02d9`

Derived from `git diff --name-only 40c02d9 HEAD -- supabase/functions supabase/config.toml` plus each function's `../_shared/*.ts` imports and the `_shared` files' own imports (`merchant-imports.ts` → `user-imports.ts` → `admin-users.ts`, `provision-user.ts`; `provision-user.ts` → `admin-users.ts`; `secrets-env.ts` → `crypto.ts`).

Changed files: `_shared/residuals.ts`, `_shared/residual-imports.ts`, `_shared/report-sheets.ts` (new), `_shared/merchant-imports.ts` (new), the `index.ts` of `parse-residual-import`, `export-residuals`, `residual-import-file-url`, `provision-user-batch`, and the new `export-report/` and `stage-merchant-import/` (each with `index.ts` and `deno.json`). `config.toml` gains exactly two `[functions.*]` blocks, both `verify_jwt = false`, and nothing else.

| Function | Why it must be redeployed (file causing it) | Behaviour change? |
| --- | --- | --- |
| `export-report` | **NEW** (`export-report/index.ts`, `deno.json`; imports `_shared/report-sheets.ts`, `_shared/residual-imports.ts`) | New: Export Excel for both admin reports, admin-only, audited. |
| `stage-merchant-import` | **NEW** (`stage-merchant-import/index.ts`, `deno.json`; imports `_shared/merchant-imports.ts`) | New: stages the ISO Hub merchants file. |
| `parse-residual-import` | own `index.ts`; `_shared/residuals.ts`; `_shared/residual-imports.ts` | **Yes**: the six-column file, payee by MID, refusals and warnings, lettered MIDs in any case, CSV; phase 15: filler rows skipped, blank figures 0, `other_income_type`, processor aliases, exact-decimal rounding, exponent-shown MIDs of 15 digits or fewer read. Needs #14 (it stages `other_income_type`). |
| `export-residuals` (phase 15 note) | imports `_shared/residuals.ts`, which phase 15 changed | No behaviour change: it uses only the export header from that module. Redeployed anyway by the bare deploy. |
| `residual-import-file-url` | own `index.ts`; `_shared/residual-imports.ts` | **Yes**: processor and month at upload, the replace prompt. |
| `export-residuals` | own `index.ts`; `_shared/residuals.ts` | **Yes**: processor column, override lines, the header per memo §2.6. |
| `provision-user-batch` | own `index.ts` | No: one comment line (`commit_residual_import` → `…_v3`). |
| `admin-reset-password`, `business-document-file-url`, `create-user`, `deactivate-user`, `marketing-material-file-url`, `read-pre-app-secrets`, `stage-user-import`, `submit-pre-app-secrets` | nothing they import changed | No. |

**After the deploy: 14 functions**, all registered in `config.toml`. Recommendation: deploy **all fourteen** with one bare `functions deploy`, as in batch 1, so the hosted bundles equal the repo.

**Order: migrations first, functions second.** The new `parse-residual-import` writes `blockers`, `warnings` and the batch's processor/month columns (#1–#2); `stage-merchant-import` writes the #12 tables; `export-report` calls the #8 functions. All fail until the push is done. The OLD functions on the NEW schema are also partly broken (the old parser cannot create a batch: #2 requires processor and month), so keep the gap short and nobody importing in between.

## 3. Hosted dashboard changes

**None needed.** Checked with:

- `git diff --stat 40c02d9 HEAD -- supabase/templates next.config.ts proxy.ts lib/supabase app/auth .env.example lib/env-guard.ts` → empty. `supabase/config.toml` changes only by the two function blocks above (no `[auth]`, `[storage]` or `[api]` change). Never `config push`.
- New `Deno.env.get` / `process.env` / `NEXT_PUBLIC_` in the diff → none. No new secret.
- New Storage bucket → none (`grep` of the migrations for `storage.buckets` → nothing). The merchant import keeps its file on the batch row (`source_bytes`), not in Storage. The residual upload still uses `residual-imports`, now also for **CSV**: the bucket was created by `20261009170000` with no MIME restriction. **One look, not a change**: Dashboard → Storage → `residual-imports` → settings: "Allowed MIME types" must be empty (or include `text/csv`), on both projects. If someone restricted it by hand, a CSV upload fails with a Storage error.
- New Vercel env var → none.

Data, not settings, after the prod push: §5's real-data load.

## 4. DEV sequence

Assumes §7 is done (linked to dev; the guard prints `dev, ok`; dev awake).

**D1. Backup.**

```powershell
npm run db:dump -- -f C:\Users\owen\tapswipe-backups\dev-schema-2026-11-DD.sql
npm run db:dump -- --data-only -f C:\Users\owen\tapswipe-backups\dev-data-2026-11-DD.sql
```

Both non-empty. No backup, no push.

**D2. Pre-check + dry run.**

1. SQL Editor, top-left **`tapswipe-crm-dev`**: the §1 pre-check. All 0. Row 2 non-zero → reset dev first (§1, "If row 2 is not 0"), then re-run the pre-check.
2. `npm run migration:list` — Remote ends at `20261028140000`; exactly the 14 §1 versions missing.
3. `npm run db:push -- --dry-run` — "Would push these migrations" and **exactly** the 14 §1 files.

**D3. Push.** `npm run db:push` (answer `y`). Then `npm run migration:list`: both columns end at `20261111120000`. Then the P6 verification queries in the dev SQL Editor.

**D4. Functions.** `npm run functions:deploy` (no name = all fourteen), then `npx supabase functions list --project-ref vdjtosofrimipklbdjbi`: fourteen `ACTIVE`, updated today, `export-report` and `stage-merchant-import` among them.

**D5. Preview.** `git push -u origin intake-residuals`. Open the Vercel preview; confirm in DevTools → Network that requests go to `vdjtosofrimipklbdjbi.supabase.co`. Prod's ref (`zuvsdkjnfstrjahstsmg`) → **stop**.

**D6. Manual checklist on the preview — synthetic data only.** Two browsers (admin; rep). The two files are `docs/claude/fixtures/dev-merchants-iso-hub.csv` and `docs/claude/fixtures/dev-residuals-tsys.csv`; every name, MID and LLC in them is invented. **Upload the files as they are; do not open and save them in Excel** (it rewrites MIDs and evaluates `=1+1`).

*The fake reps.* Admin → `/admin/users/import`, a CSV with exactly these lines (the `example.com` addresses receive nothing; provisioning sends no mail):

```
Full name,Email,Role,Agent #,Legal name,LLC legal name
Avery Fakerep,avery.fakerep@example.com,agent,T901,Avery Q. Fakerep,Fakerep Avery Payments LLC
Blake Sampleton,blake.sampleton@example.com,agent,T902,Blake R. Sampleton,Sampleton Merchant Services LLC
Casey Dormant,casey.dormant@example.com,agent,T903,Casey Dormant,Dormant Test Holdings LLC
Drew Twinner,drew.twinner@example.com,agent,T904,Drew Twinner,Twinner Test Group LLC
Emery Twinner,emery.twinner@example.com,agent,T905,Emery Twinner,Twinner Test Group LLC
Finley Adminson,finley.adminson@example.com,admin,T906,Finley Adminson,Adminson Test Holdings LLC
Gray Overrider,gray.overrider@example.com,agent,T907,Gray Overrider,Overrider Test LLC
Tapswipe Test House,house.test@example.com,agent,T908,Tapswipe Test House,Tapswipe Test House
```

- [ ] **Create the reps.** Provision the eight. Then in Manage Users: Split (rate) Avery **40**, Blake **30**, Gray **20**, Tapswipe Test House **0** (the others any); **deactivate Casey Dormant**. Reset Avery's and Gray's passwords (Manage Users) to get temporary ones for the rep checks below.
- [ ] **One existing merchant by hand**, for the "already a merchant" refusal: Merchants → new, owner Avery, MID `EXIST0000001`, any name, Nashville TN.
- [ ] **Load the merchants: each refusal.** `/admin/merchants/import`, upload `dev-merchants-iso-hub.csv` (33 lines: the header with ISO Hub's mojibake non-breaking space in "Merchant Name", rows `#` 1–32). The header must be accepted. Commit stays disabled, and the review lists these 18 refusals, each with its row (sheet row = `#` + 1):
  `#13` invalid type · `#14` no MID · `#15` MID not 6–20 letters/digits (`4001-0020`) · `#16` MID damaged by a spreadsheet (`4.001E+11`) · `#17` no name · `#18` name over 200 · `#19` no agent · `#20` unknown agent · `#21` ambiguous agent (the two Twinners) · `#22` deactivated agent (Casey) · `#23` agent is an admin (Finley) · `#24` rate not in hundredths (`12.344%`) · `#25` rate above 50 (`0.6`) · `#26` unknown processor (`Fiserv Nova`) · `#27` status not Active/Inactive (`Closed`) · `#28`+`#29` one MID, two owners · `#30`+`#31` one MID, two processors · `#32` MID already a merchant (`exist0000001`, in another case).
  And these notes on the good rows: `#2` rate from profile (blank Split → 40) · `#3` rate differs from the profile (35 vs 30) · `#9` merged into `#8` (and its name differs). Rows `#4` (`SQTEST0001ABC`, Square), `#10` (365 Pay), `#11` (no processor) and `#12` (named `=1+1`) carry nothing.
- [ ] **Load the merchants: clean.** Abandon that batch. Make the clean file without opening it in Excel:
  `Get-Content docs\claude\fixtures\dev-merchants-iso-hub.csv -Encoding UTF8 | Where-Object { $_ -notmatch '^(1[3-9]|2[0-9]|3[0-2]),' } | Set-Content $env:TEMP\dev-merchants-clean.csv -Encoding UTF8`
  Upload it: no refusals; Commit → **11 merchants** created (12 rows, one merged). Merchants list: `SQTEST0001ABC` shows as written; `990000000105` inactive; `Test House Account Six` at 0; the location screen lists them (the file has no address — expected).
- [ ] **365 Pay in the dropdowns.** Merchant form processor list, `/pre-apps/new`, the residual upload and the `/admin/reports` filter each list six processors, `365 Pay` last.
- [ ] **An override on a merchant — before the first commit.** (An override cannot start in a month already committed for that MID.) Merchant `990000000107` (Test Override Store Seven) → override **10%** to **Gray Overrider**, starting the month you will import (say the previous month). More than 40% (the merchant's rate) is refused, and so is naming Avery (the owner).
- [ ] **Upload the residual file: each refusal and warning.** `/payouts/import`, processor **TSYS**, that month, `dev-residuals-tsys.csv`. Refused: row 13 `990000000199`, **unknown MID** (listed in the unknown-MIDs box). Warnings (one yes per type): **bad numbers** row 4 (residual 80 > volume 50); **processor mismatch** rows 5 (`sqtest0001abc`: merchant saved as Square), 8 (file says Square; merchant Red Fynn), 10 (merchant saved 365 Pay); **inactive merchant** row 6. **No** warning on row 9 (zero volume, −15.00), row 11 (negative residual on a positive volume) or row 12 (`=1+1`). Row 5's lower-case lettered MID is matched (no refusal). Commit is refused while row 13 stands.
- [ ] **Clean commit, via the unknown-MID loop.** Either load `990000000199` as a merchant (a one-row merchants file: `#,Type,Merchant ID,Merchant Name,Split,Agent,Processor,Added By,Override Agent,Status` / `1,MERCHANT,990000000199,Test Unknown Merchant,0.4,Fakerep Avery Payments LLC,TSYS,Test Admin,,Inactive`), then **Read again** on the residual review (no re-upload) → row 13 now carries inactive merchant; or abandon and upload the file without row 13. Confirm the warning types, Commit. Below, figures assume **row 13 removed**; if you loaded 199 instead, add Avery +0.40 and 100.00 / 1.00 to the totals.
- [ ] **What it wrote** (rep side = round(residual × merchant rate / 100, 2)): Avery 49.38 + 20.00 + 4.00 + 40.00 − 6.00 + 10.00 + 4.00 = **121.38**, less the override debit **−10.00**; Blake 28.00 + 9.00 − 3.70 = **33.30**; house **0.00** on 200.00; Gray **+10.00** (override credit). File residual **601.11**, volume **58,895.67**, rep side **154.68**, company **446.43** (checked through the real commit and both report functions on PGlite, 6 Nov 2026). The `SQTEST0001ABC` line shows the merchant's spelling (upper case), not the file's.
- [ ] **Replace before paid.** Edit nothing in Excel: copy the residual CSV in Notepad, change row 2's Residual from `123.45` to `133.45`, save as a new `.csv`. Upload it for TSYS and the same month: the Yes prompt names the committed import; Yes → review → commit. Avery's line for `990000000101` is now 53.38; the old batch shows "replaced"; the override lines were rebuilt (Gray still +10.00).
- [ ] **Mark paid.** `/payouts`, that month, TSYS → Mark paid (type the label exactly). The month shows paid; a second replace upload is refused ("marked paid").
- [ ] **Reopen with a reason.** Reopen; a reason under 10 characters is refused; a real reason works. (SQL Editor: `select action, detail from audit_log where action like '%payout_period%' order by created_at desc limit 3;` — the reason is on the reopen row.) Mark paid again.
- [ ] **An adjustment on the paid month.** Post −5.00 to Avery on `990000000101` for that month, with a reason. It is posted in the next open month; refused on an unpaid month; `990000000101` typed in lower case is found too.
- [ ] **The rep statement.** Sign in as Avery: her own lines only, `SQTEST0001ABC` absent (Blake's), the override debit −10.00 on `990000000107` labelled as an override, the adjustment with its reason in the posting month. Net for the imported month after the replace: 125.38 − 10.00 = **115.38** (the −5.00 adjustment is in the next month).
- [ ] **The recipient statement.** Sign in as Gray: one +10.00 override credit naming the merchant by name (no link to the merchant, no rate, no Avery figures).
- [ ] **A rep cannot edit lines.** As Avery, no edit control on any line. (Optional, DevTools console on the preview: a PATCH to `rep_payout_rows` returns `42501`.)
- [ ] **Both reports reconcile with the statements.** `/admin/reports`, that month: Report 1 Avery agent split **115.38** (121.38 + 4.00 replace − 10.00 debit), Blake **33.30**, Gray overrides received **10.00**, house 0 with its 20,000 volume; total commission = split + overrides received; the −5.00 adjustment is in **deductions** of the posting month only, never in the total. Report 2: one row per MID under TSYS, residual total **611.11** after the replace, rep side **158.68**, company **452.43** (rep side + company = residual). Report 1 totals + Report 2 company = the file residual.
- [ ] **Export Excel.** Both reports → Export Excel; open the `.xlsx` **in Excel**: the merchant named `=1+1` shows as the text `=1+1`, not `2`; MIDs keep all digits and `SQTEST0001ABC` its letters; figures equal the screen to the cent. (SQL Editor: one `export_report` audit row per export.)
- [ ] **The grants query for every new table.** Run the query in `docs/claude/grants-inventory.md` in the dev SQL Editor: every row `matches = true`, including `payout_period_closures`, `merchant_overrides`, `merchant_import_batches` and `merchant_import_rows`.

Dev passes when every box is ticked. Anything unticked: stop, note what you saw, do not start §5.

## 5. PROD sequence

Only after dev passed. One sitting, nobody else signed in.

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

**P3. Pre-check.** §1 pre-check in the prod SQL Editor (top-left **`tapwipe-crm-prod`**: no "s", the project's real name, not a typo). All 0. Anything else: stop and ask; no reset is planned on prod this time (it holds the batch 1 state only, and the real data comes after).

**P4. Dry run.** Local stack running (the script borrows its DB container as a psql client).

```powershell
powershell -File scripts\push-prod-migration.ps1 -DryRun
```

`TARGET aws-0-us-west-2.pooler.supabase.com:5432 as postgres.zuvsdkjnfstrjahstsmg`, latest `20261028140000`, and **exactly** the 14 §1 files.

**P5. Push.** `powershell -File scripts\push-prod-migration.ps1` → `RESULT: PASS -- all 84 migrations are recorded`.

**P6. Verification queries** (prod SQL Editor; the same on dev in D3):

```sql
-- the 14 versions
select version from supabase_migrations.schema_migrations
 where version > '20261028140000' order by version;                 -- 14 rows, ending 20261111120000
-- six processors, 365 Pay last
select code, sort_order from processors order by sort_order;         -- ... Square 50, 365 Pay 60
-- the new tables: RLS on
select relname, relrowsecurity from pg_class
 where oid in ('public.payout_period_closures'::regclass, 'public.merchant_overrides'::regclass,
               'public.merchant_import_batches'::regclass, 'public.merchant_import_rows'::regclass);   -- 4 rows, all t
-- the case-insensitive MID index
select indexdef from pg_indexes where indexname = 'merchants_mid_key_ci';
   -- CREATE UNIQUE INDEX merchants_mid_key_ci ON public.merchants USING btree (mid_key(mid))
-- no new function callable by anon; definer/invoker as designed
select p.proname, p.prosecdef as definer,
       has_function_privilege('anon', p.oid, 'execute') as anon_can_call,
       has_function_privilege('authenticated', p.oid, 'execute') as signed_in_can_call
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and p.proname in ('commit_residual_import_v3','close_payout_period','reopen_payout_period',
                     'delete_payout_period','post_payout_adjustment','set_merchant_split',
                     'set_merchant_override','end_merchant_override','cancel_merchant_override',
                     'my_override_recipients','rep_payout_summary','merchant_processor_summary',
                     'commit_merchant_import','mid_key')
 order by 1;   -- 14 rows; anon f everywhere; signed-in t; definer f only for the two reports and mid_key
-- the old commit is gone
select to_regprocedure('public.commit_residual_import(int)') is null as old_commit_gone;   -- t
```

Then the grants query in `docs/claude/grants-inventory.md`: every row `matches = true`.

**P7. Functions — all fourteen.**

```powershell
npx supabase functions deploy --project-ref zuvsdkjnfstrjahstsmg
npx supabase functions list --project-ref zuvsdkjnfstrjahstsmg
foreach ($f in 'create-user','deactivate-user','admin-reset-password','submit-pre-app-secrets','read-pre-app-secrets','residual-import-file-url','parse-residual-import','export-residuals','export-report','stage-user-import','provision-user-batch','stage-merchant-import','marketing-material-file-url','business-document-file-url') {
  "$f " + (curl.exe -s -o NUL -w "%{http_code}" -X POST "https://zuvsdkjnfstrjahstsmg.supabase.co/functions/v1/$f")
}
```

Fourteen `ACTIVE`, updated today; every curl **401** (each function's own guard). A **401, 400 or 405** is fine: the function exists and answered. A **404 or any 5xx** means the function is missing or broken: redeploy it (§6). The same rule as `deploy-batch-1.md`.

**P8. Merge to master and deploy the app.**

```powershell
git checkout master
git pull --ff-only
git merge --no-ff intake-residuals -m "Merge intake-residuals (residual build)"
git push origin master
```

Vercel builds `master` → wait for **Ready**. (Production branch `master`, Production env pointing at `zuvsdkjnfstrjahstsmg`: checked in the dashboard first.)

**P9. Clear and check.**

```powershell
Remove-Item Env:PGPASSWORD, Env:SUPABASE_DB_PASSWORD
Remove-Variable prod
npm run guard:linked     # dev, ok
```

Browser, as admin on prod: Dashboard loads; `/payouts/import` shows the processor/month form and "Residual report (XLSX or CSV)"; `/admin/merchants/import` and `/admin/reports` load; `365 Pay` is in the dropdowns. **No test data on prod.**

**P10. The real data, in this order.** Each step's precondition is the step before.

1. **Real reps first, through the user bulk import** (`/admin/users/import`), each with **LLC legal name exactly as ISO Hub's Legal Name text** (the merchant import matches the file's Agent column against `llc_legal_name`: case, runs of spaces and the mojibake/NBSP are forgiven, nothing else). A rep with no LLC gets their own legal name in both columns (A16). **The house profile "Tapswipe" included**: if it already exists (batch 1's agent 122), do not import it again (the row would be skipped as `email_exists`); set its LLC legal name to `Tapswipe` in Manage Users. Then set **every rep's rate** in Manage Users (the house **0**): a blank Split in the merchants file takes the profile rate, and a different explicit rate is only noted.
2. **The merchants file: the original ISO Hub CSV export, not an .xlsx** (an XLSX can lose MID digits, and a numeric MID is refused or loses leading zeros). Do not open and save it in Excel. Obtain it as a real CSV export from ISO Hub; if only an .xlsx exists, stop and ask before loading.
3. **Remove the rows Owen has marked as tests** from that CSV (in a text editor), and nothing else.
4. **A MID repeated with two different owners must be resolved in the file first** (`duplicate_mid_conflict` refuses every row involved, and the import is all or nothing). Same owner, rate and status merge on their own.
5. **Load the merchants**: upload, read every refusal and note, fix the file (never the CRM to fit the file), Read again / re-upload, Commit. Merchants arrive with no address (they are listed on `/admin/merchants/missing-location`).
6. **Overrides by hand, per merchant** (the file's Override Agent column is ignored): on each merchant page, recipient, percent (at most the merchant's rate), first month. **Before importing any month they apply to** — an override cannot start in a month already committed for that MID.
7. **The first processor month**: `/payouts/import`, the processor and month, **the processor's original file** (CSV preferred for lettered or long MIDs). Confirm each warning type on purpose, Commit. Then compare **Report 1** for that month with **ISO Hub's Agent Commissions export** for the same month, **rep by rep, to the cent** (total commission = split + overrides received). Any difference: stop and find it before the next month; until Mark paid a month is corrected by **replace**.
8. **The unknown-MID loop.** A file with MIDs the CRM lacks is refused, and the review lists every unknown MID. Put those MIDs in a second merchants file (ISO Hub format, owner and rate as ISO Hub has them, **Status `Inactive`**), load it, then **Read again** on the same residual batch (no re-upload): those rows now carry the inactive-merchant warning; confirm it and commit.

## 6. What can go wrong

Plain rule: **nothing before P5 changes prod.** After that, cannot be undone without the P2 backup: a pushed migration (only restored over), a committed merchant import (no bulk delete), an audit row. A residual commit **can** be undone until Mark paid (replace, or `delete_payout_period`); after Mark paid only by Reopen (with a reason) or an adjustment. An adjustment line cannot be deleted by anyone (post an opposite one). An override can be ended or cancelled, never edited.

| Step | What goes wrong | How you can tell | What to do | Undoable? |
| --- | --- | --- | --- | --- |
| §7 link | Linked to prod | `npm run guard:linked` prints `REFUSING … PRODUCTION` | Relink to dev | — |
| D1/P2 | Backup empty or auth failure | size 0; `password authentication failed`; `Tenant or user not found` (wrong pooler host; `aws-0` is right) | Fix and re-run. Never continue without a backup | read-only |
| D2/P4 | More or fewer than 14 pending | the dry-run list | Stop: the project is not at `20261028140000` (batch 1 missing, or something else pushed). Ask | read-only |
| D3/P5 push | #2 refuses: committed batches without processor | `import parser migration refuses to run: committed rep_payout_batches 3, 7 …` | #1 stays applied. Dev: reset, push again. Prod: stop and ask; repair = set `processor`, `period` on the named batches, push again | partial; restore from backup |
| D3/P5 push | #3 refuses: merchant rate | `commit v3 migration refuses to run: merchants …` | #1–#2 stay applied. Fix each named merchant's split pair by hand (0–50, halves to 100), push again | partial |
| D3/P5 push | #10 refuses: skip record / old preview flag | `retire_legacy_import refuses to run: …` | Copy the named record out first (the message gives the query), clear it, push again | partial |
| D3/P5 push | #12 refuses: `365 Pay` clash or sort order 60; location body | `merchant import migration refuses to run: processors already holds …` / `enforce_merchant_location() is not the body …` | Stop and ask (someone edited processors or the trigger by hand) | partial |
| D3/P5 push | #13 refuses: MIDs differing only in case | `alphanumeric_mids refuses to run: … merchant 12 (ABC123), merchant 40 (abc123)` | Change one MID of each pair (or remove the duplicate merchant), push again | partial |
| any push | Hangs | no output for minutes | Ctrl+C, then the read-only `scripts\diag-prod-trigger.ps1`. Never `migration repair` | — |
| P5 | Script ends FAIL | `RESULT: FAIL` and the problem | Do not re-run blindly; bring the log from `scripts\logs\` | — |
| D4/P7 | A function fails to bundle; old version live | deploy error; list time not today; curl 404 | `npx supabase functions deploy <name> --project-ref <ref>` again | redeploy from `40c02d9` |
| between push and deploy | Old functions on the new schema | residual upload fails ("needs its processor and month") | Expected; keep the gap short | — |
| D5/P8 | Build fails, or the preview/prod points at the other project | Vercel Error; Network tab shows the other ref | Previous deployment keeps serving / Promote it; fix env vars before testing | yes |
| D6 | CSV upload refused by Storage | "mime type … not supported" | Clear the bucket's Allowed MIME types (§3) | yes |
| D6/P10 merchants | Every row "unknown agent" | review lists all rows | LLC legal names do not match the file's Agent text: fix the profiles (Manage Users), Read again | yes (nothing committed) |
| P10 merchants | Committed with a wrong owner or rate | merchant pages | Owner: the merchant form (refused while a share or override is live); rate: `set_merchant_split` on the merchant page, audited. There is no bulk undo | per merchant only |
| P10 residuals | Report 1 differs from ISO Hub | the comparison | Before Mark paid: fix the cause (merchant rate, owner, override) and **replace**. After: Reopen with a reason, or an adjustment | until paid: yes |
| P10 residuals | A month committed to the wrong processor or month | `/payouts` | Before paid: `delete_payout_period` (audited), import again | until paid |

## 7. Before we start

- [ ] **CLI linked to dev:** `npm run guard:linked` prints exactly `[supabase-guard] linked project: tapswipe-crm-dev (vdjtosofrimipklbdjbi) — dev, ok`. If not: `npx supabase link --project-ref vdjtosofrimipklbdjbi`, then `supabase stop` / `supabase start` (the local stack's versions follow the link).
- [ ] **Env vars cleared** in the PowerShell window: `Get-ChildItem Env: | Where-Object Name -in 'ALLOW_PROD_SUPABASE','SUPABASE_DB_PASSWORD','PGPASSWORD','ALLOW_REMOTE_SUPABASE_IN_DEV'` prints nothing (P1 sets two deliberately, later).
- [ ] **Branch:** `git branch --show-current` → `intake-residuals`.
- [ ] **Clean tree:** `git status --short` → empty.
- [ ] **Storage accepts CSV on both projects** (§3), checked before D6 / P10: Dashboard → Storage → `residual-imports` → settings, "Allowed MIME types" is empty (or includes `text/csv`), on `tapswipe-crm-dev` and on `tapwipe-crm-prod`.
- [ ] **Batch 1 is on both projects** (§0): `npm run migration:list` on dev ends at `20261028140000`.
- [ ] **One clean full e2e pass on the final commit**, alone, after `supabase stop` / `supabase start`, `functions serve` up, port 3000 free, `.next` deleted; plus `npm test` and `npm run test:live` green. The result is recorded in `docs/design/intake-and-reports.md` (phase 14b notes) for the commit it was run on; a later commit needs its own run.
