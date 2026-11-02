# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This file is the **core**: security and safety rules first, then deployment, commands, test baselines and an index. The long reference material lives in `docs/claude/*.md`, moved there **verbatim** on 19 Oct 2026 — those files are binding rules too, not history. Read the relevant one before touching its area.

## Security and safety rules (read first)

Each line is the rule; the full reasoning is in the linked file or in the sections directly below.

**Hosted projects and secrets**

- **Never touch the live Supabase projects (dev or prod) without asking first**, and treat `tapwipe-crm-prod` (`zuvsdkjnfstrjahstsmg`) as live production. Use the guarded `npm run` wrappers, never trust `npm run db:push -- --db-url <prod>`, and run `scripts/push-prod-migration.ps1 -DryRun` before a prod push. → "Hosted projects and deployment" below.
- **Never run `npx supabase config push`** and **never run `supabase projects api-keys`** by hand. Set the prod DB password with `Read-Host -AsSecureString`, never a literal. → below.
- **The service-role key belongs in Edge Function secrets only**; the Next app holds the publishable key only, and `.env.deployed.local` stays publishable-keys-only. → "Next.js / auth wiring" below.
- **`scripts/reset-business-data.sql`** (one-off, hand-run in the SQL Editor, dry run by default) empties every `public` table but `profiles` and `processors`. **A new `public` table must join its `keep_tables` or `clear_tables`** or it aborts. Never run it from here. → `docs/claude/reset-business-data.md`.
- **SheetJS stays pinned to the cdn.sheetjs.com 0.20.3 build**, never `npm:xlsx` (two high-severity advisories). → `docs/claude/payouts-and-teardown.md`.

**Database access control**

- **Admin sees every row; an active agent sees only `agent_id = auth.uid()`** — `(agent_id = auth.uid() and is_active_agent()) or is_admin()`. Reuse the two `security definer` helpers; never inline a role lookup. → "Access control" below.
- **A new table needs RLS *and* explicit grants** (the four-step checklist below); **a new function needs `revoke all … from public` + `grant execute … to authenticated, service_role`** in the same migration. Never grant `anon` anything. **Do not rely on `ensure_rls`.** → below.
- **The four `*_secrets` tables: zero policies, zero grants, Edge Function only** — including the agent's first submission. Never add a policy or a grant. → "Three tiers" below.
- **`security invoker` is the default for RPCs.** `definer` only when the function must reach what the caller may not, and then it owes a hand-written guard first (`is_admin()` / `is_active_agent()`) plus `set search_path`. `search_crm`, `dashboard_counts` and the two report functions must stay invoker (tests assert `prosecdef` false). → `docs/claude/rpcs-profiles-audit.md`.
- **`/admin/reports` reads only the committed ledger** via the invoker `rep_payout_summary()` / `merchant_processor_summary()` (`is_admin()` first): the ledger's `rep_payout` and each line's `rep_split_pct`, never `profiles.split_rate_pct`. Total = split + overrides received; deductions never in it. → `docs/claude/payouts-and-teardown.md`.
- **The cross-book definer functions return redacted shapes, built with `jsonb_build_object` so hidden fields are ABSENT, not null**: `check_duplicates()` (warns only — **must never become a block**), `accounts_in_city()` (equality on `norm_city()` only; never a prefix/autocomplete for non-admins), `my_share_partners()` (party-only for every caller; a rep never sees the partner's share, rate or payout, and gets no access to the partner's merchant), `my_override_recipients()` (the caller's own debits only; the recipient gets the merchant's name as text, never the merchant). → `docs/claude/rpcs-profiles-audit.md`.
- **`profiles` has no client write path**: new columns are set only by a `security definer` RPC with `is_admin()` first (`set_user_role`, `set_agent_number`, `set_territory`, `set_manager`, `set_rep_identity`, `set_rep_split`). **`territory`, `manager_id`, `legal_name`, `llc_legal_name` and `split_rate_pct` must never appear in a policy**; `role` stays `'agent' | 'admin'`; manager graph is one hop. → `docs/claude/rpcs-profiles-audit.md`.
- **`log_cross_agent_change()` fails closed on purpose** — never wrap its audit insert in an exception handler. A new table must have **every verb** audited somewhere. `audit_log` has no insert policy and `authenticated` holds `select` only. → `docs/claude/rpcs-profiles-audit.md`.
- **A column that must be immutable is a GRANT, not a policy.** Column-level UPDATE grants: `quotes.status` only; `rep_payout_batches.status` only (a trigger admits only `review -> abandoned`; `replaced`/`deleted` are definer-only and final). `notes` and `rep_payout_rows` have no client UPDATE at either layer (the ledger also has a trigger refusing any client role, admin included, since `20261102140000`). → `docs/claude/proposals-and-catalog.md`, `docs/claude/payouts-and-teardown.md`.
- **Any column the client supplies and no policy reads is unvalidated** (the `documents.file_key` lesson). Fix it at the layer that cannot be skipped: the price lock trigger `snapshot_quote_line_item()` overwrites every snapshot column; `enforce_quote_version()` assigns versions and refuses foreign groups; the browser sends only `product_id` and `quantity`; only `submit_pre_app()` writes a pre-app's split and rep names, from the profile. → `docs/claude/edge-functions-and-storage.md`, `docs/claude/proposals-and-catalog.md`, `docs/claude/rpcs-profiles-audit.md`.
- **A committed processor-month changes only by replace or delete (until marked paid) or an adjustment line (after).** Replace is v3 on a batch with `replaces_batch_id`; delete is `delete_payout_period()` (no client DELETE on the ledger); `post_payout_adjustment()` needs a paid month; Mark paid / Reopen (typed phrase / written reason, on the one audit row) are `close_/reopen_payout_period()`. v3 never merges. The old `commit_residual_import(int)` keeps its `coalesce(excluded.<col>, rep_payout_rows.<col>)` until phase 13 — never reverse it, never copy it. Every `on conflict` on `rep_payout_rows` names `(period, processor, agent_id, mid)` and says `where line_kind = 'import'`; a negative `volume` only on a `volume_confirmed_negative` line. → "Three tiers" below, `docs/claude/payouts-and-teardown.md`.
- **A merchant's rate (0-50) is written only by `set_merchant_split()`** (audited; refused while a share is live; a trigger refuses any other write); a merchant created without one takes its owner's profile rate (A31). A share's signer is the owner, its shares total the rate, and a shared merchant cannot be moved. **An override is at most the merchant's rate** (`set_merchant_override()`, re-checked by v3; the table's `<= 50` is only the outer bound), never paid to the owner or a share party, and a merchant with a live override cannot be moved either. → `docs/claude/payouts-and-teardown.md`.
- **The legacy `documents` table and bucket are closed** (SELECT for admin only, no client write, its three functions removed). Do not reopen them. → `docs/claude/notes-tasks-documents.md`.

**Edge Functions, Storage and the app**

- **All twelve functions are `verify_jwt = false`, so each authenticates itself in a fixed order**: `withSupabase` → `callerIsActive` on the caller-scoped client → authorization through RLS → only then `supabaseAdmin`. Return **404, never 403**, for "not yours". → "Edge Function authentication" below.
- **`export-residuals` must never use `supabaseAdmin`** — RLS is its whole authorization. → Edge Functions table below.
- **Bulk provisioning never hands out a credential**: `provision-user-batch` discards the temporary password unread. **Deactivation is two layers** (ban in GoTrue first, then `profiles.is_active`). `create-user` must delete the `auth.users` row if the `profiles` insert fails. → `docs/claude/user-accounts.md`, "Three tiers" below.
- **Inline signed URLs are allow-listed by type** (PDF, plain text, three raster images; **never SVG**); everything else is forced to attachment. → `docs/claude/reference-data-and-marketing.md`.
- **The per-bucket 50 MiB limit is the real upload ceiling**; `config.toml`'s `file_size_limit` limits nothing. Hosted buckets need it set out-of-band. → `docs/claude/edge-functions-and-storage.md`.
- **The secrets validators exist twice and must change together** (`lib/masks.ts` and `_shared/pre-app-secrets.ts`, tax-ID pair `isTaxEin`/`isTaxSsn` included); the residual parser exists **once** — do not create a browser twin — and pays each row to the owner of the merchant its MID names (`agent_number` is a display code, never the join). → `docs/claude/edge-functions-and-storage.md`.
- **Never show a `functions.invoke()` error's `.message` to a user** — use `lib/edge-functions.ts`. → "Next.js / auth wiring" below.
- **`read-pre-app-secrets` returns last four to everyone, admin included.** A full value leaves only on a one-field `reveal`: admin-only, audited first by `record_pre_app_secret_reveal()` (fails closed, 30/hour), shown client-side and never printed. → `docs/claude/edge-functions-and-storage.md`.
- **"Email" on marketing materials sends nothing** and must say so; when sending lands it goes next to that log line. → `docs/claude/reference-data-and-marketing.md`.
- **`GET /auth/confirm` never verifies a token**: it redirects to the Continue page, and only that page's Server Action (same-origin POST) calls `verifyOtp`. Link types are an allow-list of what the app sends — `recovery` only. → `docs/claude/security-fixes.md`, phase 7.
- **Nothing is invented on the printed proposal** (`PROPOSAL_TERMS` empty by default; no phone; no stale contact) and print routes return **404, never 403**. → `docs/claude/proposals-and-catalog.md`.

## Security and access rules — the core text

### Access control is the core design constraint

One rule, everywhere: **`role = 'admin'` sees every row; an active `role = 'agent'` sees only rows where `agent_id = auth.uid()`.** Policies are written as `(agent_id = auth.uid() and is_active_agent()) or is_admin()`. Child tables of `pre_apps` (`pre_app_owners`, `pre_app_terminal`, `pre_app_business_profile`) reach the check through an `exists (select 1 from pre_apps ...)` subquery on the parent, with `is_active_agent()` wrapping the `exists` rather than inside it. Deletes are usually admin-only. (`documents` was the exception — reps deleted their own uploads — until 20261013121000 closed that table to every client write.)

The `is_active_agent()` half is load-bearing: a valid JWT proves who the caller is, not that their account is still enabled. A deactivated agent keeps a working token until it expires, so every own-row branch re-checks per request. Both `is_admin()` and `is_active_agent()` are `security definer` on purpose — a policy on `profiles` that queried `profiles` directly would recurse. Reuse them; don't inline role lookups.

### RLS and grants are two separate layers — a new table needs both

RLS decides which **rows** a caller sees. Grants decide whether the caller may touch the table **at all**, and they are independent: a table with perfect policies and no grant answers every request with `permission denied for table X`. That was the repo's actual state until `20260805200000_grant_data_api_roles.sql`, because Supabase's auto-exposure of new objects is deprecated and off by default now.

**When adding a table**, all four of these or it will silently be unreachable, wide open, or both:

1. `agent_id uuid references profiles(id) not null`
2. `alter table <t> enable row level security`
3. the four policies above
4. **explicit grants** — `grant select, insert, update, delete on <t> to authenticated` plus `grant usage on <t>_id_seq to authenticated`, and `grant all on <t> to service_role` if any Edge Function touches it. `20260805210000_revoke_legacy_anon_grants.sql` removed the default privileges that used to auto-grant new tables, precisely so this step can't be skipped by accident. Never grant `anon` anything, nor a `*_secrets` table to `authenticated`.

**When adding a function**, it needs its own privilege lines in the same migration:

```sql
revoke all on function <sig> from public;
grant execute on function <sig> to authenticated, service_role;
```

Postgres grants `EXECUTE` to `PUBLIC` on every new function, and `PUBLIC` includes `anon`. There is **no declarative backstop** for this: `alter default privileges ... revoke execute on functions from public` is a verified no-op here (a new function still lands with `proacl = NULL`, tested on both Postgres 17 and PGlite), which is why it isn't in the revoke migration. `tests/rls/grants.test.ts` pins the gap. Miss these lines and your RPC is callable unauthenticated from the moment it exists.

**Do not rely on `ensure_rls`.** An event trigger (`ensure_rls` → `public.rls_auto_enable()`) switches RLS on for new tables in `public`. `20260811150000` adopted it into the migrations, so it runs locally and in PGlite too — but where the migration role lacks superuser it is skipped with a NOTICE, and its handler swallows per-table failures. A migration that forgets step 2 therefore passes every behavioural test here; write step 2 anyway (`tests/rls/processors.test.ts` pins it in the migration text). History: the note in `docs/tapswipe_crm_schema.sql`.

### Three tiers of data access — pick the right one

1. **Normal tables via `supabase-js`** (`merchants`, `leads`, `ghost_sheets`, `pre_apps` + children, `support_tickets`, `notes`, `tasks`, `audit_log`, `rep_payout_rows` + the three other `rep_payout_*` tables, `payout_period_closures` (Mark paid, admin SELECT only), `merchant_overrides` (admin SELECT only; written by its three audited RPCs), the two `user_import_*` tables, and the reference-data tables `marketing_materials`, `business_documents`, `products`, `brands`, plus `processors`, which no client writes — `docs/claude/reference-data-and-marketing.md`). The legacy `documents` table is SELECT-only for `authenticated` and admits only an admin since 20261013121000. RLS does the enforcement; the client talks to Postgres directly. Note how little of that list is client-*writable*: the payout and user-import tables are read-only to `authenticated` apart from one status update each, because everything that creates their rows runs as service role.
2. **Secrets tables — Edge Function only.** `pre_app_owner_secrets` (SSN), `pre_app_banking_secrets` (ABA routing / account number), `pre_app_terminal_secrets` (RP password), `pre_app_tax_secrets` (business tax ID, EIN or SSN; its kind must equal `pre_apps.ein_type`, and the plaintext `pre_apps.ein_number` is dropped, `20261026140000`) are locked twice over: RLS enabled with **zero policies**, *and* no grant to `anon` or `authenticated` at all. Either alone denies read and write; both means a policy added by mistake still opens nothing. Values are stored as `bytea` AES ciphertext; only a service-role Edge Function holding the encryption key can touch them. This includes the agent's initial submission — the browser must POST that data to `submit-pre-app-secrets`, never insert it via `supabase-js`. Never add a policy to these tables, and never grant them.
3. **`commit_residual_import_v3(batch_id_input int, confirmed_input text[])` RPC** — `security definer`, `is_admin()` first; the commit the app calls. In one transaction it re-derives every refusal and warning from the database (refusing a type not confirmed), pays each row to its merchant's CURRENT owner at the MERCHANT's rate (a shared account as the signer/partner pair), and never merges; on a replacing batch it is the replace (refused once paid). Why an RPC, and its rules: `docs/claude/payouts-and-teardown.md`. The old `commit_residual_import(int)` and its merge go in phase 13.
4. **`approve_pre_app(pre_app_id_input int)` RPC** — `security definer` plpgsql that creates a `merchants` row from a pre-app (address and `processor` copied), flips its status to `approved`, and writes `audit_log`. It guards itself with an explicit `is_admin()` check at the top; keep that check if you edit it.

### Edge Function authentication

**All twelve are `verify_jwt = false` in `config.toml`** — verified, every one of the twelve `[functions.*]` blocks sets it. The platform therefore performs **no** auth check before your handler runs, so **each function is responsible for authenticating the caller itself**. `functions deploy` carries this setting up with the code, so it holds in production too.

Every one of them follows the same shape, and the order matters:

1. `withSupabase({ auth: "user" }, ...)` rejects a missing or invalid JWT before the handler body (this is what returns the `401`).
2. `callerIsActive(ctx.supabase)` — an `is_active_agent()` RPC through the **caller-scoped** client. A valid JWT does not mean the account is still enabled; a deactivated agent's token keeps working until it expires. Called via `ctx.supabaseAdmin` this would always be false, because a service-role connection has no `auth.uid()`.
3. Authorization through the caller-scoped client, so RLS makes the decision — `resolveParentAgentId()` looks the parent record up as the caller rather than re-implementing ownership by hand.
4. **Only then** `ctx.supabaseAdmin`, and only for the privileged step itself (minting the signed URL). It bypasses RLS, so nothing may reach it before authorization is settled.

Also: return `404`, not `403`, when a record isn't the caller's — "not yours" and "doesn't exist" must be indistinguishable or the endpoint becomes an id oracle. `tests/live/business-documents.test.ts` and `tests/live/marketing-materials.test.ts` assert these branches against the running functions. (`document-urls` and `document-lifecycle` did the same for the legacy functions and went with them.)

## What this project is

Tapswipe's internal CRM (merchant services): Dashboard, Merchants, Pre-Apps, Leads, Ghost Sheets, Support Tickets, Document Center, My Submissions.

**Current state matters when reading the code**, and it is a mix — real CRM pages alongside untouched starter scaffolding:

- **Built:** every CRM route under `app/(app)/`, the `lib/*` data-access helpers, notes/tasks panels, the Document Center (a company library, not per-record), Proposals at `/proposals`, and the payout Reports at `/admin/reports`. Full route and helper inventory → `docs/claude/project-state.md`.
- **Not built yet:** My Submissions.
- **Still starter-kit template:** `README.md` only. Edge Functions: twelve in the repo. Details of both → `docs/claude/project-state.md`.

**`docs/tapswipe_crm_schema.sql` is the authoritative spec** for the data model and access rules, not the migrations. Change the doc first, then make `supabase/migrations/` match it. Seventy-seven migrations exist; `20260804201300_initial_schema.sql` is the first.

## Hosted projects and deployment

Stack: Next.js 16 (App Router, React 19), Supabase (Postgres + Auth + Storage + Deno Edge Functions), Tailwind 3 + shadcn/ui (new-york, `neutral` base), TypeScript strict. Linked Supabase project ref: `vdjtosofrimipklbdjbi` — and note **which** project that is: `tapswipe-crm-dev`. The second project `tapwipe-crm-prod` (`zuvsdkjnfstrjahstsmg`) is **not linked, but it is deployed and real**: `PRE_APP_SECRETS_KEY` is set and its private buckets exist (made by hand before `20261009170000_storage_buckets.sql`, which only fills in a missing one). Treat it as live production, not as a spare project.

**Prod schema is caught up as of 18 Sep 2026 — all 30 migrations, verified against its own catalog** by `scripts/push-prod-migration.ps1`, which checks the migration rows AND the resulting objects rather than trusting the CLI's exit code. Log in `scripts/logs/`. Don't take that as standing parity: it was two behind for two days before this, and the only honest way to know is to run `scripts/diag-prod-trigger.ps1`, which says outright whether prod matches the repo.

**Functions are a separate question from the schema, and a migration push does not carry them.** That is `functions deploy`, which is also the one command where `--project-ref` genuinely exists — so deploying to prod needs no relink and no database password, only a logged-in CLI.

**As of 13 Oct 2026 the repo's functions and prod's are different sets** — which ones, and how a prod deploy is verified (401 from the function vs 404 for a missing slug): `docs/claude/project-state.md`.

So `supabase db push`, `functions deploy` and `migration list --linked` target **dev**; `npm run test:deployed` is the exception — it reads `.env.deployed.local` and checks **every** project named there, dev and prod both, so it is the one command whose target does not depend on the link at all. Wording below that says "production" of the linked project means "the hosted project" and is loose — **dev is what those commands hit, and that looseness is exactly what went wrong once.**

**Reaching prod is not one answer, and `--project-ref` is not it.** That flag exists on `functions deploy` — which is how the 4 Sep prod deploys were done, and for functions it genuinely is the form no one else's relink can invalidate. It does **not** exist on the migration commands. Verified 16 Sep 2026: `supabase db push --help` lists only `--linked`, `--local` and `--db-url` for targeting, and `migration list --project-ref …` fails outright with `UnrecognizedOption`. So for anything schema-related there are exactly two routes to prod, and both cost something:

- **Relink** (`supabase link --project-ref zuvsdkjnfstrjahstsmg`, then `ALLOW_PROD_SUPABASE=1 npm run db:push`). This is the 2 Sep incident's own mechanism — it changes global CLI state, and until it is reversed the guard fails closed on every wrapped command, blocking unrelated work.
- **`--db-url`** with the prod connection string. No relink and no global state, but it needs the prod Postgres password, which is deliberately nowhere in this repo — `.env.deployed.local` holds publishable keys only.

**And the URL is not the obvious one:** `db.<ref>.supabase.co` is IPv6-only and fails at DNS without IPv6 egress (`docs/claude/project-state.md`). Use the pooler in **session** mode; the username carries the ref:

```
postgresql://postgres.zuvsdkjnfstrjahstsmg@aws-0-us-west-2.pooler.supabase.com:5432/postgres   # password in $env:PGPASSWORD, never in the URL (a command line is readable by other processes; scripts/prod-db.ps1)
```

Port 5432, not 6543: transaction mode breaks a migration partway through. Both projects are `us-west-2`, so dev's pooler host is prod's too.

**Pooler host is `aws-0`, never `aws-1`:** the wrong one fails as `Tenant or user not found`, which reads like a bad password. History: `docs/claude/project-state.md`.

**Don't hand-build that URL — use the scripts.** `scripts/diag-prod-trigger.ps1` reads prod's state read-only and says whether it matches the repo; `scripts/push-prod-migration.ps1` applies what is pending and verifies the result against the catalog. Both take the password from `$env:SUPABASE_DB_PASSWORD` (set it with `Read-Host -AsSecureString`, never a literal assignment — PSReadLine's sensitive-input filter catches the word "password" but *not* a credential embedded in a URL, which is how three of them ended up in shell history), both redact it out of everything they print, and both write a log to `scripts/logs/` because the answer has to outlive the terminal. Run the push with `-DryRun` first.

Why they stream `db push --yes` and derive the migration check from the directory: `docs/claude/project-state.md`.

**`npm run db:push -- --db-url <prod>` used to print `dev, ok` and go to prod** (npm appended the flag after the guard); since 21 Oct 2026 the wrappers launch the CLI from the guard, which refuses `--project-ref` and `--db-url` (`docs/claude/security-fixes.md`, phase 4). When targeting prod by URL, call `npx supabase` directly so nothing claims to have checked something it did not.

**The linked-project claim above drifted once, silently, and the guard exists because of it.** On 2 Sep 2026 the CLI was relinked to **prod** while this file said dev for seven days (story: `docs/claude/project-state.md`). Now something does — `scripts/check-linked-project.mjs` prints the linked project and **fails closed** when it is prod, missing, or an unrecognised ref. Use the wrapped scripts for anything acting on the linked project:

```bash
npm run guard:linked      # print the linked project; exit 1 if prod or unrecognised
npm run db:push           # guard, then supabase db push
npm run db:dump           # guard, then db dump --linked
npm run migration:list    # guard, then migration list --linked
npm run functions:deploy  # guard, then functions deploy
ALLOW_PROD_SUPABASE=1 npm run db:push   # act on prod on purpose
```

The guard reads `supabase/.temp/linked-project.json`, so it reports what the CLI will *actually* do rather than what any doc claims. Raw `npx supabase …` still bypasses it — prefer the npm scripts for anything aimed at the linked project, and pin `--project-ref` when you mean prod **on a command that has that flag** (`functions deploy` does; `db push` and `migration list` do not — see above for what to use instead). Dev is also frequently `INACTIVE` (paused), in which case `migration list` fails with a connection timeout and `functions deploy` bundles fine but then 404s with `Cannot retrieve service for project … status 'INACTIVE'`; restoring it is a dashboard action, with no CLI equivalent under `supabase projects`.

**Never run `supabase projects api-keys`.** It prints the project's service-role key to stdout, and stdout is a transcript — a terminal scrollback, a CI log, an agent session — that outlives the command. `scripts/load-hardware-catalog.mjs` is the one caller, and it captures the output and never prints it; anything you type by hand has no such guarantee.

**The local stack's service versions follow the LINKED project**: after any `supabase link`, relink to dev and see `docs/claude/project-state.md` (the `42P10` fix).

## Commands

```bash
npm run dev            # Next dev server on :3000
npm run build          # next build (also type-checks)
npm run lint           # eslint .
npx tsc --noEmit       # type-check only

npm test               # hermetic suite — PGlite + pure logic, no Docker (2909 tests, 121 files — every file must load)
npm run test:live      # local stack over HTTP — needs `supabase start` + `functions serve` (347 tests)
npm run test:deployed  # read-only assertions about the DEPLOYED projects (29 tests)
npm run test:e2e       # Playwright, real browser against the app on the local stack (379 tests, 6 of them the shared setup)
npm run test:e2e:ui    # the same, in Playwright's watch/inspect UI

npx supabase start                       # local stack (API :54321, DB :54322, Studio :54323, mail :54324)
npx supabase db reset                    # rebuild local DB from migrations/ (there is no seed.sql)
npx supabase migration new <name>        # new timestamped migration
npx supabase db push                     # apply migrations to the linked remote project
npx supabase functions serve             # serve all functions locally (hot reload)
npx supabase functions deploy <name>     # deploy one function
npx supabase secrets set PRE_APP_SECRETS_KEY=$(openssl rand -base64 32)   # deployed encryption key
npx supabase functions serve --env-file ./supabase/functions/.env         # local serve WITH the key
```

`npm run build`, `npm run lint` and `npx tsc --noEmit` all pass. If one fails, it's your change.

**Never run `npx supabase config push`.** It has no `--dry-run`, and `config.toml`'s `[auth]` block holds local-dev values, so pushing it would set the production Site URL to `http://127.0.0.1:3000`, replace the redirect allow-list, clamp `[auth.rate_limit].email_sent` to 2 auth emails per hour project-wide, and turn off email confirmations. `config.toml` governs the **local stack only** — deployed Auth settings are a separate surface, changed in the Dashboard or via a targeted Management API `PATCH .../config/auth` with only the field you mean.

### Tests — four suites, four different targets

| Suite | Target | Needs |
| --- | --- | --- |
| `npm test` | the migrations themselves | nothing (in-process Postgres) |
| `npm run test:live` | the local Supabase stack | Docker, `supabase start`, `functions serve` |
| `npm run test:deployed` | every project in `.env.deployed.local` | network |
| `npm run test:e2e` | the rendered app in a real browser | Docker, `supabase start`, **`functions serve`**, Chromium |

Baselines are the counts in the Commands block above. The rules, each explained in full in **`docs/claude/testing.md`**:

- Run `npm test` for any schema change; queries must run as `authenticated`, never the owner.
- PGlite is Postgres 18.3, the stack 17.6 — pin constraint names in assertions, not SQLSTATEs.
- Never write a literal `\xHH`-shaped escape inside a JS template literal; use `decode('…', 'hex')` for `bytea`.
- A suite where a file fails to load is a failing suite. `.gitattributes` pins `*.mjs`/`*.sql`/`*.sh` to LF and must stay that narrow.
- The live suite fails loudly when functions are down; `ALLOW_SKIPPED_FUNCTION_TESTS=1` is the only skip; new live files use `skipWhenFunctionsDown()` and `warmFunctions([...])`.
- Fixtures must set every denormalised column something reads (`profiles.email`); live tests clean `audit_log` before deleting users.
- `test:e2e` needs `functions serve`; e2e holds only what a person could only find by looking; prove a spec by reverting the fix; read durations, not just passes; `retries: 0`.

### Build/lint exclusions are deliberate

`tsconfig.json` excludes `supabase`; `eslint.config.mjs` ignores `supabase/**`, `.next/**`, `next-env.d.ts`. Don't re-include them. `supabase/functions` is Deno and resolves imports through per-function `deno.json` maps that Node/TS cannot see (the Deno language server checks it instead, per `.vscode/settings.json`), and `supabase/.temp` is CLI scratch — `supabase start` writes a minified bundle there that alone produced 186 lint errors.

**`allowImportingTsExtensions: true` in `tsconfig.json` is load-bearing** (the unit suites import `_shared` modules, and Deno requires `.ts` extensions); why, in `docs/claude/edge-functions-and-storage.md`.

## Definition of done

A feature isn't done when it compiles — it's done when it's verified and committed.

- **Verify every feature before calling it complete.** A test harness exists now, so "no way to test it" is rarely true: schema and policy work goes in `tests/rls/`, anything crossing PostgREST/GoTrue/Storage goes in `tests/live/`, deployed-config facts go in `tests/deployed/`. Where no test fits, do the check manually and state in your response exactly what you ran and what you observed — "loaded `/leads` as an agent, saw only my 3 rows; as admin, saw all 11." An unverified claim of completion is not completion.
- **Don't generalize from one environment to another.** The local stack, a fresh project, and the linked project have measurably different grant surfaces and Auth config. If a claim is about production, verify against production (`supabase migration list`, `/rest/v1/…` and `/auth/v1/settings` with the publishable key, `supabase db dump --linked -s public`) rather than inferring from local behaviour.
- **Commit after each working increment**, not once at the end of a session. Descriptive subject line saying what changed and why (`Add leads list page with agent-scoped RLS query`, not `updates`). Keep schema migrations and the code that depends on them in the same commit.

## Architecture

### Edge Functions

Twelve functions, all registered in `supabase/config.toml` (a function not listed there won't deploy or serve):

| Function | Purpose |
| --- | --- |
| `create-user`, `deactivate-user`, `admin-reset-password` | admin user management via `auth.admin` + `profiles`, each writing `audit_log` |
| `submit-pre-app-secrets`, `read-pre-app-secrets` | encrypt/decrypt the four secrets tables |
| `residual-import-file-url` | admin-only; two modes — `{file_name, processor, period}` creates a `rep_payout_batches` row (both required, the month in the window) and signs an upload into `residual-imports`, or, for a committed processor-month, answers `{exists}` and creates nothing; `replace_batch_id` (the prompt's Yes) creates a replacing batch, 409 once paid; `{batch_id}` signs a download of the stored file |
| `parse-residual-import` | admin-only; reads a batch's six-column XLSX (Merchant Number as text) and stages each row for the owner of the merchant its MID names, with every refusal (`blockers`), the three `warnings` and advisory notes (`preview_flag`). **Idempotent** — clears the batch's staging rows first, so "add the merchant, then Read again" is one code path |
| `export-residuals` | **not admin-only, deliberately.** Reads every row through the *caller-scoped* client, so RLS is the whole authorization and a rep's export is their own book; `supabaseAdmin` anywhere in it, even to join names, would make it the company's. Paginates with `.range()`, or PostgREST's `max_rows` exports a silent prefix. Not an import format since phase 7 |
| `stage-user-import` | admin-only; parses a rep CSV into `user_import_rows`, creating the batch on the way. One function where residuals needs two, because the text arrives in the request body rather than via Storage. **Idempotent** — clears the batch's rows first, so "fix something, then read again" is one code path run twice. Two modes: `source_text` starts an import, `batch_id` re-reads the text already stored on the batch |
| `provision-user-batch` | admin-only; creates the accounts for a staged import, **a bounded chunk per call**. Calls the same `provisionUser` core as `create-user` and **discards the temporary password unread**. See the bulk-import section below for why the loop lives in the browser |
| `marketing-material-file-url` | the one function whose two modes have **different authorization**: an admin stocks the library (upload), every active user reads it (download). Detail: `docs/claude/reference-data-and-marketing.md` |

### Next.js / auth wiring

- Three Supabase client factories, don't mix them up: `lib/supabase/client.ts` (browser), `lib/supabase/server.ts` (Server Components / Actions / Route Handlers, cookie-backed, `async`), `lib/supabase/proxy.ts` (request pipeline). Never hoist any of them into a module-level global — Fluid compute reuses processes across requests.
- `proxy.ts` at the repo root is Next 16's renamed middleware. It calls `updateSession()`, which refreshes the session cookie and redirects unauthenticated requests to `/auth/login` for everything except `/auth/*`. Do not insert code between `createServerClient()` and `supabase.auth.getClaims()` in that file, and return the `supabaseResponse` object unchanged — the comments there explain why (random logouts).
- **`/` renders nothing: it redirects, in `app/page.tsx` AND in `updateSession()`, and both are load-bearing** (signed in → `/dashboard`, out → `/auth/login`; why both, and the cookie copy on the proxy redirect: `docs/claude/project-state.md`).
- Auth pages live under `app/auth/*` with matching form components at the top level of `components/`; `app/auth/confirm/route.ts` takes the email link and verifies nothing; `app/auth/confirm/continue/` (page + Server Action) exchanges the token on POST (phase 7). The local reset email is `supabase/templates/recovery.html`; the hosted ones are set in the dashboard.
- `next.config.ts` sets `cacheComponents: true`, so dynamic data fetching must sit inside a `<Suspense>` boundary (see `app/page.tsx`, or `ForcePasswordChangeGate` in `app/(app)/layout.tsx`, for the shape).
- Env vars (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`) live in **two** gitignored files, and the split matters: `.env.local` holds the **hosted** project and is what `next build` and production use; `.env.development.local` holds the **local stack** and wins in dev, because Next resolves `.env.development.local` ahead of `.env.local`. So `npm run dev` talks to the local stack with no flag to remember. Recreate it from `npx supabase status -o env` (`API_URL` + `PUBLISHABLE_KEY`) whenever the local ports change; `.env.example` documents the whole arrangement.
- **`lib/env-guard.ts` throws at dev-server boot if the Supabase URL isn't local.** This is not hypothetical: with only `.env.local` present, `npm run dev` pointed the app at production, and the symptoms were an admin-only column appearing for a rep and a list reading "no pre-apps yet" because the row was in the other database. Nothing announced it. The guard runs from `next.config.ts` (hard throw, server) and once per page load in `lib/supabase/client.ts` (warn, browser — a built bundle can't fix its own URL). Set `ALLOW_REMOTE_SUPABASE_IN_DEV=1` to develop against the hosted project deliberately.
- **Never show a `functions.invoke()` error's `.message` to a user.** supabase-js reports every non-2xx as a `FunctionsHttpError` whose message is the fixed string "Edge Function returned a non-2xx status code"; the function's own `{ error }` body sits unread on `error.context`. Use `invokeEdgeFunction()` / `edgeFunctionErrorMessage()` from `lib/edge-functions.ts`. Why: `docs/claude/edge-functions-and-storage.md`.
- The publishable/anon key is the only key the Next app should ever hold — the service-role key belongs in Edge Function secrets only. `lib/utils.ts` is down to `cn()`; the starter's `hasEnvVars` is gone, along with everything that branched on it.

### Conventions

`@/*` path alias maps to the repo root. shadcn/ui components go in `components/ui/` (add via `npx shadcn@latest add <component>`); compose classes with `cn()` from `lib/utils.ts`. Icons from `lucide-react`. Theming is `next-themes` with CSS variables in `app/globals.css`.

### The design system is tokens, not classnames

**Every colour comes from a CSS variable in `app/globals.css`.** No component names a palette colour (`bg-gray-100`) or a hex. Adding one is how the theme starts drifting, and there is nothing that will fail to warn you — so the check is: if you are about to type a Tailwind colour literal, the token you want either exists or should be added there.

Two colour systems that must not mix:

- **Brand and action** — `primary` (#DC2626: primary buttons, links, the sidebar's active accent and count pill, focus rings) and `destructive` (#B91C1C: delete/danger only, and always behind a confirmation step). They are deliberately different reds. A delete button that renders in the same red as the page's main create action invites the misclick the pair exists to prevent.
- **Status** — `success`/`warning`/`neutral`, for state badges only, via `components/status-badge.tsx` and a `StatusIntent` mapper per domain (`statusIntent` in `lib/{merchants,pre-apps,leads}.ts`, `supportTicketStatusIntent`, `conversionIntent` in `lib/ghost-sheets.ts`). **Never** put brand or destructive red on a status badge, and never put a status colour on a button or in the nav. `leads.status` had no mapper until 20261002 because it was unconstrained text with no vocabulary to colour; it has seven values now, and `lost` is **grey, not red** — a lost lead is an inert record, and colouring it like the delete button puts every closed-out row in the palette reserved for irreversible actions. Every mapper must also survive a value outside its vocabulary: `leads_status_vocabulary` ships `NOT VALID`, so rows predating it still hold rep-typed strings and the list page has to render them rather than crash on a missing label.

Shared structure lives in components, so page-level styling stays out of pages: `PageShell` (the three content widths), `PageHeader` (title row), `StatCard`, `StatusBadge`, `Callout`, `FilterTabs`. The `Table` primitive draws its own white card and uppercase muted headers — list pages don't wrap it.

The sidebar is dark in every theme, so its tokens live only in `:root` and are never overridden in `.dark`. The app is pinned to light (`defaultTheme="light"`, `enableSystem={false}` in `app/layout.tsx`) because there is no dark palette yet; the `.dark` block is the stock shadcn scale, left in place so turning dark mode on later is filling in values rather than re-plumbing.

Sidebar contents are data in `lib/nav.ts`, not JSX; the client nav sits inside `<Suspense>` and takes `pathname` as a prop (why, and the disabled-row mechanism: `docs/claude/project-state.md`).

## Docs index

Everything below was moved verbatim out of this file; one line each.

- `docs/tapswipe_crm_schema.sql` — **the authoritative spec** for the data model and access rules.
- `docs/claude/project-state.md` — full route/helper inventory, removed starter scaffolding, Edge Function and `_shared` inventory, removed-but-still-deployed functions.
- `docs/claude/testing.md` — the four suites in full: every test rule and the lessons behind it (revert experiments, timing, empty-state specs, leftovers).
- `docs/claude/rpcs-profiles-audit.md` — invoker vs definer RPCs, `check_duplicates`, `accounts_in_city`, `my_share_partners`, pg_trgm, `migrationsBefore()`, profiles columns (`agent_number`, `territory`, `manager_id`), the cross-agent audit trigger.
- `docs/claude/payouts-and-teardown.md` — `rep_payout_*` tables, merge key, shared accounts on the screens, batch status guard, the 25 `profiles` FKs and the four teardown lists, SheetJS pin, payout fixtures, audit consequences for fixtures.
- `docs/claude/user-accounts.md` — bulk rep import (staging rows as progress ledger, blocking vs skippable, no bulk credentials), deactivation, global logout.
- `docs/claude/reference-data-and-marketing.md` — tables with no owner (`products`, `marketing_materials`, `business_documents`), the marketing library, inline-URL allow-list, the Email button, `window.open` + `noopener`.
- `docs/claude/edge-functions-and-storage.md` — the `file_key` consistency lesson, Deno runtime, parser-once vs validators-twice, the four buckets, upload size limits, signed-URL origin rewrite.
- `docs/claude/notes-tasks-documents.md` — polymorphic `owner_type` + `owner_id`, notes append-only, the Document Center and the closed legacy `documents` path.
- `docs/claude/merchant-location.md` — location required for new merchants only, the NOT VALID lesson, format CHECK + guard trigger, `norm_city()`, the four hand-run SQL files, dev's hosted state.
- `docs/claude/proposals-and-catalog.md` — append-only quotes, column grants, line-item snapshots and the price lock, the catalog loader script, proposals as their own record, the store, brands, the printed proposal.
- `docs/claude/dashboard-followups-timeline.md` — dashboard filters (invoker, ANDed on policies), follow-ups in two places, the lead timeline.
- `docs/claude/security-fixes.md` — the Oct 2026 outside-review fixes, all seven phases: (1) merchants admin-only to change, every MID change audited, backfill same-owner rule, owner picker; (2) pre-app children frozen once submitted; (3) anti-framing and hygiene headers on every route; (4) npm wrappers refuse `--project-ref`/`--db-url`, env/key gitignores, no `api-keys` advice; (5) `accounts_in_city` audited and rate-limited (30/hour); (6) the prod DB password passed in `PGPASSWORD`, never on a command line; (7) login CSRF closed — `GET /auth/confirm` verifies nothing, a Continue page POSTs to a Server Action, `recovery` is the only link type, and the reset email template.
- `docs/claude/security-followups.md` — review findings recorded but deliberately not built, each with severity, evidence and a suggested fix.
- `docs/claude/reset-business-data.md` — runbook and design notes for the one-off business-data reset (written there, not moved).
- `docs/claude/deploy-batch-1.md` — the plan for deploying `intake-and-reports` (Phases 1–5) to dev then prod: migrations and their guards, functions to redeploy, test checklist, failure table (written there, not moved).
- `docs/design/residual-splits.md` — shared-account design memo.
- `docs/tapswipe_crm_master_plan.md` — product master plan.

Keep everything of ours **above** the marker below. `next dev` regenerates the block between `BEGIN:nextjs-agent-rules` and `END:nextjs-agent-rules` and deletes whatever else sits inside it — that is how this index went missing on 21 Oct 2026. `tests/unit/claude-md.test.ts` fails if a heading of ours is inside the block or a `docs/claude/*.md` file is missing from the index.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
