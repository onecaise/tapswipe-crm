# Resetting business data (dev, then prod)

A one-off. It empties every CRM table — merchants, pre-apps, leads, notes, payouts, the product catalog, the marketing library, the audit log, everything — and keeps **only the user accounts** (`auth.users` and `profiles`, unchanged) **and the processor list** (`processors`, the six processors merchants and pre-apps point at — configuration, not business data). The schema, security rules and functions are not touched. Files in Storage are **not** deleted by the script; you delete them by hand at the end.

The three files, all in `scripts/`:

| File | What it does | Changes anything? |
| --- | --- | --- |
| `reset-business-data-counts.sql` | Row count of every table | No |
| `reset-business-data.sql` | The reset. Dry run unless you switch it on | Only when `do_commit` is `true` |
| `reset-business-data-storage-inventory.sql` | Lists every stored file | No |

To run a file: open it, copy **all** of it, paste it into a new query in the Supabase **SQL Editor**, press **Run**.

## Three rules for every run

- **Check the project name, top-left of the SQL Editor, before EVERY Run.** Dev is `tapswipe-crm-dev`. Prod is `tapwipe-crm-prod`. If it is not the one you mean, stop.
- **No one signs in to the CRM while the reset runs.** A sign-in changes the accounts table, and the script then refuses and undoes itself (safe, but you start that step again).
- **Delete all Storage files before anyone uploads anything** — in all four buckets: `documents`, `residual-imports`, `marketing`, `business-documents`. Record numbering restarts at 1, so a new upload can land on an old file's name.

## Do dev first, then prod

Do steps 1–10 on **dev**. Only when dev finished cleanly, do steps 1–10 on **prod**.

1. **Backup.** In PowerShell, in the repo folder. Backups hold real data: save them in `C:\Users\owen\tapswipe-backups\`, never inside the repo.
   - **Dev** (the guard must print that dev is linked — if it says anything else, stop):
     ```powershell
     npm run db:dump -- -f C:\Users\owen\tapswipe-backups\dev-schema-2026-MM-DD.sql
     npm run db:dump -- --data-only -f C:\Users\owen\tapswipe-backups\dev-data-2026-MM-DD.sql
     ```
   - **Prod** (type the password at the prompt; never paste it into a command). The password travels in `PGPASSWORD` and **never inside the URL**: a command line is readable by other processes, and with `--db-url` the CLI reads `PGPASSWORD` (`docs/claude/security-fixes.md`, phase 6; `scripts/prod-db.ps1`). The URL below carries no password; its username carries the project ref:
     ```powershell
     $sec = Read-Host -AsSecureString "prod database password"
     $env:PGPASSWORD = [Net.NetworkCredential]::new('', $sec).Password
     $url = "postgresql://postgres.zuvsdkjnfstrjahstsmg@aws-0-us-west-2.pooler.supabase.com:5432/postgres"
     npx supabase db dump --db-url $url -f C:\Users\owen\tapswipe-backups\prod-schema-2026-MM-DD.sql
     npx supabase db dump --db-url $url --data-only -f C:\Users\owen\tapswipe-backups\prod-data-2026-MM-DD.sql
     Remove-Item Env:PGPASSWORD; Remove-Variable url, sec
     ```
     Until 4 Nov 2026 this step put the password, percent-encoded, inside the URL; do not go back to that form. That `db dump` takes the password from `PGPASSWORD` under `--db-url` is how the CLI was measured to behave (on `migration list`); this exact form has not been run against prod, so the check below is what tells you it worked. An authentication failure writes no file.
   - Check both files exist and are not empty. No backup, no reset.
2. **Counts, before.** Run `reset-business-data-counts.sql`. Save the result (export/download it, or copy it into a text file next to the backup) as `<project>-counts-1-before.csv`.
3. **Dry run.** Run `reset-business-data.sql` exactly as it is in the repo. You will get a **red error**. That is correct **only if it starts with `DRY RUN: rolled back, nothing was changed. Every check passed.`** Read its list: every table should go to `0`, `audit_log` to `1`, and `profiles`, `processors` (5) and `auth.users` should keep their numbers. Any other red error: **stop** and send it to Owen/Claude. Tables marked `absent, skipped` are normal on prod.
4. **Counts, after the dry run.** Run the counts query again. It must match step 2 exactly. If anything differs, **stop.**
5. **Switch the script on.** In the SQL Editor (not in the repo file), change `do_commit       boolean := false;` to `true`.
   - **Prod only:** also change the `expected_emails` line to exactly:
     ```sql
     expected_emails text[]  := array['owen@tapswipellc.com', 'owen7550@icloud.com']::text[];
     ```
   - **Dev:** leave `expected_emails` empty. That keeps every existing dev account.
6. **Check the project name top-left again**, then **Run.** You get a table, one row per table: kept tables say `kept, unchanged`, the rest `cleared` (audit_log: `cleared + 1 marker row`). A red error instead means nothing was changed — **stop** and send it on.
7. **Counts, the record.** Run the counts query. Expected: `profiles`, `processors` (6) and `auth.users` as in step 2, `audit_log` = 1, every other table 0, `storage.objects` as in step 2. Save it as `<project>-counts-2-after-reset.csv` and keep it — this is the record of the reset.
8. **Close the edited query without saving it**, so a switched-on copy is never left lying in the editor.
9. **Delete the Storage files.** Run `reset-business-data-storage-inventory.sql`: it lists every file as bucket + path. In the dashboard go to **Storage**, open each bucket listed, select every file and folder, **Delete**. Do all four buckets; leave the buckets themselves. Run the inventory again — it must return **no rows**.
10. **Counts, final.** Run the counts query once more: `storage.objects` is now 0. Save it as `<project>-counts-3-final.csv`. The CRM may be used again.

## If something goes wrong

- Any red error other than the dry-run message: nothing was changed. Stop and send the full error text.
- Something was committed that should not have been: restore from the step-1 backup. Ask Claude/Owen; do not improvise.

## For whoever maintains this (technical)

- One `DO` block = one transaction. One `truncate … restart identity` without `cascade`, then one `audit_log` row (`business_data_reset`, actor null). TRUNCATE fires no row triggers, so the audit triggers write nothing and none is disabled.
- **A new table in `public` must be added to `keep_tables` or `clear_tables` in the script**, or the script aborts ("unclassified table"). A listed table that does not exist is skipped, because prod runs behind the repo's migrations.
- The lists (2 Nov 2026). **Kept:** `profiles`; `processors` (20261023130000 — reference data the migration itself seeds; merchants and pre-apps reference it, and it references nothing, so truncating them is allowed). **Cleared:** sales pipeline (`leads`, `ghost_sheets`, `merchants`, `pre_apps` and its three child tables, the four pre-app secrets tables `pre_app_owner_secrets`, `pre_app_banking_secrets`, `pre_app_terminal_secrets`, `pre_app_tax_secrets` — the last added by 20261026140000); activity (`notes`, `tasks`, `support_tickets`, `support_ticket_replies`, `bug_reports`, `documents`, `audit_log`); proposals (`quotes`, `quote_line_items`); residuals (the four `rep_payout_*` tables, `merchant_rep_shares`, `merchant_overrides` — added by 20261102120000, `payout_period_closures` — the Mark-paid months, added by 20261030120000); bulk import (`user_import_batches`, `user_import_rows`; and, from 20261106120000, `merchant_import_batches`, `merchant_import_rows`); other reference data (`brands`, `products`, `product_compatibility`, `marketing_materials`, `marketing_material_events`, `business_documents`). 39 tables (37 until the merchant import's two staging tables, 6 Nov 2026). Of the migrations from 20261026120000 on, only 20261030120000 (`payout_period_closures`) and 20261102120000 (`merchant_overrides`) add a table; the rest add columns.
- It refuses when: an `expected_emails` entry is missing from `auth.users` or `profiles`; the per-row md5 of `auth.users` or of any kept table (`profiles`, `processors`) differs at the end; the caller lacks TRUNCATE/INSERT/SELECT; any cleared table is non-empty afterwards; `storage.objects`' count moved; a lock is not granted in 10 s.
- The legacy `documents` table is cleared like the rest. `scripts/purge-legacy-documents.mjs` is dev-only and not part of this; the `documents` bucket's files go in step 9.
- Tests: `tests/rls/reset-business-data.test.ts` (PGlite, full guard matrix) and `tests/live/reset-business-data.test.ts` (local stack, as the non-superuser `postgres` role the editor uses). Fixture: `tests/fixtures/reset-business-data-seed.sql`.
