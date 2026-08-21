# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

Tapswipe's internal CRM (merchant services): Dashboard, Merchants, Pre-Apps, Leads, Ghost Sheets, Support Tickets, Document Center, My Submissions.

**Current state matters when reading the code**, and it is a mix — real CRM pages alongside untouched starter scaffolding:

- **Built:** every CRM route lives under the `app/(app)/` route group so it renders inside the shell — `app/(app)/{dashboard,merchants,leads,ghost-sheets,pre-apps,support-tickets,documents,notes,tasks,payouts,admin/users}`. Route groups don't affect URLs, so the paths are still `/dashboard`, `/merchants/7` and so on. Data-access helpers in `lib/{merchants,leads,ghost-sheets,pre-apps,pre-app-validation,masks,support-tickets,annotations,annotations-data,documents,payouts,auth,format}.ts` and `hooks/use-autosave.ts`. Notes and tasks are **written** through panels (`components/{notes,tasks}-panel.tsx`) on the four owner records; `/notes` and `/tasks` are the cross-record view of the same rows, and are read-only (notes) or read plus the complete toggle (tasks). Creation stays on the record, because `owner_id` has no FK and the panels take the pair from a parent row already loaded under RLS.
- **Not built yet:** My Submissions.
- **Still [starter-kit](https://github.com/vercel/next.js/tree/canary/examples/with-supabase) template, not product code:** `README.md`, `app/page.tsx`, `app/protected/*`, `components/tutorial/*`, and `components/{hero,deploy-button,next-logo,supabase-logo,env-var-warning}.tsx`.
- **Edge Functions:** all ten are implemented — `create-upload-url`, `create-download-url`, `submit-pre-app-secrets`, `read-pre-app-secrets`, `create-user`, `deactivate-user`, `admin-reset-password`, `residual-import-file-url`, `parse-residual-import`, `export-residuals` (shared helpers in `supabase/functions/_shared/{documents,crypto,pre-app-secrets,secrets-env,admin-users,residuals,residual-imports}.ts`).

**`docs/tapswipe_crm_schema.sql` is the authoritative spec** for the data model and access rules, not the migrations. Change the doc first, then make `supabase/migrations/` match it. Twenty-four migrations exist; `20260804201300_initial_schema.sql` is the first.

Stack: Next.js 16 (App Router, React 19), Supabase (Postgres + Auth + Storage + Deno Edge Functions), Tailwind 3 + shadcn/ui (new-york, `neutral` base), TypeScript strict. Linked Supabase project ref: `vdjtosofrimipklbdjbi` — and note **which** project that is: `tapswipe-crm-dev`. There is a second, **unlinked** project `tapwipe-crm-prod` (`zuvsdkjnfstrjahstsmg`). So `supabase db push`, `functions deploy` and `npm run test:deployed` all target **dev**, not production; reaching prod would need an explicit relink. Wording below that says "production" of the linked project means "the hosted project" and is loose — dev is what those commands hit. Dev is also frequently `INACTIVE` (paused), in which case `migration list` fails with a connection timeout and `functions deploy` bundles fine but then 404s with `Cannot retrieve service for project … status 'INACTIVE'`; restoring it is a dashboard action, with no CLI equivalent under `supabase projects`.

## Commands

```bash
npm run dev            # Next dev server on :3000
npm run build          # next build (also type-checks)
npm run lint           # eslint .
npx tsc --noEmit       # type-check only

npm test               # hermetic suite — PGlite + pure logic, no Docker (509 tests)
npm run test:live      # local stack over HTTP — needs `supabase start` + `functions serve` (68 tests)
npm run test:deployed  # read-only assertions about the DEPLOYED project (4 tests)
npm run test:e2e       # Playwright, real browser against the app on the local stack (46 tests)
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
| `npm run test:deployed` | the hosted project in `.env.local` | network |
| `npm run test:e2e` | the rendered app in a real browser | Docker, `supabase start`, Chromium |

- **`npm test`** — vitest + `@electric-sql/pglite`, applying `supabase/migrations/` over a deliberately minimal auth shim (`tests/helpers/db.ts`: three Data API roles, `auth.users`, `auth.uid()` reading the `request.jwt.claims` GUC). Covers RLS policies (`tests/rls/*`) and the grant surface (`tests/rls/grants.test.ts`). **Run this for any schema change.** Queries must run as `authenticated`, not the owner — Postgres bypasses RLS for a table's owner, so an owner-run test passes regardless of policy.
- **Never write a literal `\xHH`-shaped escape inside a JS template literal**, including inside text meant to read as a SQL comment. `tests/helpers/db.ts` builds SQL in template literals, so JavaScript consumes the escape before Postgres ever sees the string: `\x00` becomes a real NUL byte, which desyncs the wire protocol and fails dozens of *unrelated* tests with a bare `invalid message format` from the pg-protocol parser, naming no statement and pointing nowhere near the cause. (It cost an hour once, in a comment that existed to warn about exactly this.) For `bytea` fixtures use `decode('0011', 'hex')` — no backslash to get wrong.
- **`npm run test:live`** — real HTTP with real JWTs. Covers what PGlite structurally cannot: GoTrue password sign-in, PostgREST grants, the Deno runtime, Storage signed URLs. Hard-errors rather than skipping when the stack is down. Run it when touching Edge Functions, auth, or Storage.
- **Call `warmFunctions([...])` in a live test's `beforeAll`, before any status-code assertion.** The CLI rewrites a function's `.npmrc` the first time that function is invoked in a `functions serve` session; its own file watcher sees the write and restarts the runtime, which `502`s whatever is in flight. On a cold serve this produced 24 failures across the suite, every one reading `expected 502 to be 200` and pointing nowhere near the cause. All three live files warm the functions they exercise.
- **A live test that writes `audit_log` must clean it up before deleting its users.** `audit_log.actor_id references profiles(id)` with **no `ON DELETE`**, so `deleteUser` fails on the FK while those rows exist — the persona survives teardown and the next run dies on "user already registered". `teardownFixtures()` and `deleteUserCompletely()` both delete by `actor_id` and by `row_id` first. The FK is deliberately left strict: production never deletes users (§8), so only tests pay for it.
- **`npm run test:deployed`** — read-only Auth-config assertions against production. A red result means the deployed project drifted, not that code broke. Uses only the publishable key.
- **`npm run test:e2e`** — Playwright + Chromium against `next dev` on the local stack (`playwright.config.ts`, specs in `e2e/`). Covers only what needs a browser: **layout, paint, and client state across a refresh.** `e2e/fixtures/seed.ts` provisions its own personas and its own periods (deliberately in **2027**, so it never collides with the `seed-dev-*` scripts' 2026), and `e2e/auth.setup.ts` signs each persona in once into `e2e/.auth/*.json` — so no spec logs in and no spec holds a password. Reuses a running dev server.
- **Do not put RLS, PostgREST or pure-logic assertions in `e2e/`.** They are faster and more precise in the other three, and a browser copy is just a slower flakier duplicate. The rule of thumb: a spec belongs there only if a person could **only** find it by looking.
- **A geometric bug needs a geometric assertion, and bounding boxes are usually the wrong one.** The `StatCard` clipping bug (a figure painted outside its card, hidden by the next card's opaque background) passed a bounding-box comparison: a block element's box is constrained by its parent, so the *ink* overflows while `getBoundingClientRect` reports the parent's width unchanged — measured, 213px box against a 270px `scrollWidth`. `scrollWidth > clientWidth` is what actually detects it. A text assertion cannot see it either, which is how it shipped.
- **Prove an e2e spec is non-vacuous by reverting the fix.** Cheap here and worth doing every time, because a spec that drives a whole page can pass for reasons unrelated to what it claims. All seven specs covering the three browser-only payouts bugs were checked this way: revert the fix, watch exactly those specs go red, restore. Two of them were rewritten as a result of that check — they had passed against the reverted bug.

Why four and not one: each suite is green while the next one's class of bug sits in the repo. The PGlite suite was 100% green with no Data API grants at all and an `[auth.email] enable_signup = false` that disabled password login — neither visible below PostgREST/GoTrue. All three of those were green while `/payouts` shipped a stale editable cell (the page showing `410 × 50% = $174.25`), a clipped money figure, and six columns pushed off screen by one long merchant name — none visible without a browser.

### Build/lint exclusions are deliberate

`tsconfig.json` excludes `supabase`; `eslint.config.mjs` ignores `supabase/**`, `.next/**`, `next-env.d.ts`. Don't re-include them. `supabase/functions` is Deno and resolves imports through per-function `deno.json` maps that Node/TS cannot see (the Deno language server checks it instead, per `.vscode/settings.json`), and `supabase/.temp` is CLI scratch — `supabase start` writes a minified bundle there that alone produced 186 lint errors.

## Definition of done

A feature isn't done when it compiles — it's done when it's verified and committed.

- **Verify every feature before calling it complete.** A test harness exists now, so "no way to test it" is rarely true: schema and policy work goes in `tests/rls/`, anything crossing PostgREST/GoTrue/Storage goes in `tests/live/`, deployed-config facts go in `tests/deployed/`. Where no test fits, do the check manually and state in your response exactly what you ran and what you observed — "loaded `/leads` as an agent, saw only my 3 rows; as admin, saw all 11." An unverified claim of completion is not completion.
- **Don't generalize from one environment to another.** The local stack, a fresh project, and the linked project have measurably different grant surfaces and Auth config. If a claim is about production, verify against production (`supabase migration list`, `/rest/v1/…` and `/auth/v1/settings` with the publishable key, `supabase db dump --linked -s public`) rather than inferring from local behaviour.
- **Commit after each working increment**, not once at the end of a session. Descriptive subject line saying what changed and why (`Add leads list page with agent-scoped RLS query`, not `updates`). Keep schema migrations and the code that depends on them in the same commit.

## Architecture

### Access control is the core design constraint

One rule, everywhere: **`role = 'admin'` sees every row; an active `role = 'agent'` sees only rows where `agent_id = auth.uid()`.** Policies are written as `(agent_id = auth.uid() and is_active_agent()) or is_admin()`. Child tables of `pre_apps` (`pre_app_owners`, `pre_app_terminal`, `pre_app_business_profile`) reach the check through an `exists (select 1 from pre_apps ...)` subquery on the parent, with `is_active_agent()` wrapping the `exists` rather than inside it. Deletes are usually admin-only; `documents` is the exception (reps delete their own uploads).

The `is_active_agent()` half is load-bearing: a valid JWT proves who the caller is, not that their account is still enabled. A deactivated agent keeps a working token until it expires, so every own-row branch re-checks per request. Both `is_admin()` and `is_active_agent()` are `security definer` on purpose — a policy on `profiles` that queried `profiles` directly would recurse. Reuse them; don't inline role lookups.

### RLS and grants are two separate layers — a new table needs both

RLS decides which **rows** a caller sees. Grants decide whether the caller may touch the table **at all**, and they are independent: a table with perfect policies and no grant answers every request with `permission denied for table X`. That was the repo's actual state until `20260805200000_grant_data_api_roles.sql`, because Supabase's auto-exposure of new objects is deprecated and off by default now.

**When adding a table**, all four of these or it will silently be unreachable, wide open, or both:

1. `agent_id uuid references profiles(id) not null`
2. `alter table <t> enable row level security`
3. the four policies above
4. **explicit grants** — `grant select, insert, update, delete on <t> to authenticated` plus `grant usage on <t>_id_seq to authenticated`, and `grant all on <t> to service_role` if any Edge Function touches it. `20260805210000_revoke_legacy_anon_grants.sql` removed the default privileges that used to auto-grant new tables, precisely so this step can't be skipped by accident. Never grant `anon` anything, and never grant the three `*_secrets` tables to `authenticated`.

**When adding a function**, it needs its own privilege lines in the same migration:

```sql
revoke all on function <sig> from public;
grant execute on function <sig> to authenticated, service_role;
```

Postgres grants `EXECUTE` to `PUBLIC` on every new function, and `PUBLIC` includes `anon`. There is **no declarative backstop** for this: `alter default privileges ... revoke execute on functions from public` is a verified no-op here (a new function still lands with `proacl = NULL`, tested on both Postgres 17 and PGlite), which is why it isn't in the revoke migration. `tests/rls/grants.test.ts` pins the gap. Miss these lines and your RPC is callable unauthenticated from the moment it exists.

**Do not rely on `ensure_rls`.** The linked project has an enabled event trigger (`ensure_rls` → `public.rls_auto_enable()`) that switches RLS on for new tables in `public`. It exists on that hosted project **only** — not in any migration, not on the local stack, not in PGlite, and `supabase db dump` can't carry it (the CLI comments out `CREATE EVENT TRIGGER` lines). A migration that forgets step 2 therefore fails two different ways: on production the table comes up RLS-enabled with no policies and denies everyone (looks like a broken feature), while everywhere else it's wide open (a leak). Same SQL, opposite failure, and the environment where it looks fine is the one nobody tests against. See the note in `docs/tapswipe_crm_schema.sql`.

### Three tiers of data access — pick the right one

1. **Normal tables via `supabase-js`** (`merchants`, `leads`, `ghost_sheets`, `pre_apps` + children, `documents`, `support_tickets`, `notes`, `tasks`, `audit_log`, `rep_payout_rows` + the three other `rep_payout_*` tables). RLS does the enforcement; the client talks to Postgres directly.
2. **Secrets tables — Edge Function only.** `pre_app_owner_secrets` (SSN), `pre_app_banking_secrets` (ABA routing / account number), `pre_app_terminal_secrets` (RP password) are locked twice over: RLS enabled with **zero policies**, *and* no grant to `anon` or `authenticated` at all. Either alone denies read and write; both means a policy added by mistake still opens nothing. Values are stored as `bytea` AES ciphertext; only a service-role Edge Function holding the encryption key can touch them. This includes the agent's initial submission — the browser must POST that data to `submit-pre-app-secrets`, never insert it via `supabase-js`. Never add a policy to these tables, and never grant them.
3. **`commit_residual_import(batch_id_input int)` RPC** — `security definer`, guarded by an explicit `is_admin()`, moves a reviewed batch's staging rows into `rep_payout_rows`. It is an RPC and **not** an eighth Edge Function on purpose: supabase-js has no client-side transaction, so a function would insert ledger rows, delete staging rows and flip the batch status as three round trips with a real window where a period is half-imported. It also sidesteps PostgREST's row cap (`insert … select` has none), gets a fail-closed audit row for free, and keeps `auth.uid()` — so the history rows the merge triggers name the committing admin. **The `coalesce(excluded.<col>, rep_payout_rows.<col>)` on the two money columns is the entire merge rule**: reverse those arguments and every re-import silently clears a month of hand-entered residuals, violating no constraint and raising no error. `tests/rls/commit-residual-import.test.ts` asserts both directions and greps the function body for it.
4. **`approve_pre_app(pre_app_id_input int)` RPC** — `security definer` plpgsql that creates a `merchants` row from a pre-app, flips its status to `approved`, and writes `audit_log`. It guards itself with an explicit `is_admin()` check at the top; keep that check if you edit it.

**A `security definer` RPC is the exception, not the default.** `convert_ghost_sheet_to_lead`, `dashboard_counts` and `search_crm` are all plain **security invoker** functions on purpose: the caller's own policies scope every read inside them, so an agent gets their own rows and an admin the company's with no role branch in the SQL and no `agent_id` filter to fall out of step with the policies. Reach for `definer` only when the function must touch something the caller genuinely may not (the `*_secrets` tables, writing `audit_log`, creating a merchant) — and then it owes you a hand-written ownership check plus `set search_path`.

For `search_crm` that choice is a security property rather than a style preference: a search box is exactly the shape of thing that becomes a disclosure bug, and running as the invoker means it physically cannot return a record the rest of the app hides. `tests/rls/dashboard-and-search.test.ts` asserts the scoping per role *and* asserts `prosecdef` is false on both — because adding `security definer` to either signature would silently widen every count and every hit to the whole table, and nothing else in the suite would notice.

`profiles` has no insert policy by design — rows are created by the `create-user` Edge Function using the service role, alongside `auth.users`. **That function must delete the `auth.users` row if the `profiles` insert fails.** The two together are one logical account, and half of one is the ghost-user state `lib/auth.ts` routes to `/auth/error?error=no-profile`: able to log in, sees nothing, and unable to self-heal precisely because there is no insert policy.

`audit_log` has no insert policy either, which is what decides where an audited action has to live. Anything that must leave a trail runs as service role (an Edge Function) or as a `security definer` RPC — a plain client write cannot log itself. `set_user_role()` and `set_agent_number()` are `security definer` for that reason and one more: the 11 Aug audit removed the admin UPDATE policy on `profiles`, so there is now no client write path to that table at all. `authenticated` holds **`select` only** on `audit_log`; the security audit narrowed it, because write privileges there were previously held back by nothing but the absence of a policy for those verbs.

`profiles.agent_number` (added `20260817101500`) is the only join between a processor's residual report and this database — the spreadsheet's "Agent #" column has never heard of a uuid. Nullable with a **partial** unique index (`where agent_number is not null`), because every profile predating the column has none and there is nothing to backfill from. Blank must never be stored: `''` is a value that index enforces, so two reps cleared that way would collide. Both write paths normalise it to null and both cap the length at 32 — `set_agent_number()` in SQL and `isAgentNumber()` in `supabase/functions/_shared/admin-users.ts`, which `create-user` applies. Nothing type-checks that pair, so change them together. See `RESIDUALS_SPEC.md`.

**`log_cross_agent_change()` audits admin action on other people's records, and it FAILS CLOSED — intentionally.** An AFTER INSERT/UPDATE/DELETE trigger on all seven `agent_id` tables (`merchants`, `leads`, `ghost_sheets`, `pre_apps`, `support_tickets`, `notes`, `tasks`), logging only when `auth.uid()` is not the row's `agent_id`, so a rep's own edits stay out of the trail and an admin's do not. `documents` is excluded on purpose: its access is audited in the two signed-URL functions, where the mint is the event rather than the metadata row.

It is an AFTER ROW trigger with no `EXCEPTION` block, so it runs in the triggering statement's transaction and **an audit_log insert failure rolls the write back with it**. A mutation to those seven tables cannot succeed while its audit row quietly does not. Do not "fix" that by wrapping the insert in an exception handler — the rollback is the design, and `tests/rls/audit-trigger.test.ts` asserts it. Four audit sites, four different answers, each deliberate: this one, `read-pre-app-secrets` and `log_payout_row_change()` fail closed because nothing has been committed or handed over yet; `submit-pre-app-secrets` *cannot* (its ciphertext is already written, so it reports `auditWriteFailed`); `rls_auto_enable()` swallows failures, because a backstop that breaks DDL is worse than one that misses a table.

**The `rep_payout_*` tables are the deliberate exception to `log_cross_agent_change()`, and the reasoning is worth knowing before you "fix" the omission.** `rep_payout_rows` carries `agent_id` and would work with that trigger unchanged — but nobody except an admin can write the table at all (no insert policy, admin-only update and delete), so `actor is distinct from row_agent_id` is true for *every* write. One forty-row import would produce forty `cross_agent_insert` rows, and it still could not record what a figure changed *from*, because `audit_log` has no detail column. So the trail is split by granularity instead: `audit_log` per committed batch and per deleted period, and `rep_payout_row_history` per value change, where a before and an after actually fit. The other three payout tables have no `agent_id` at all, which is the `support_ticket_replies` trap — that function would read NULL and log everything.

`rep_payout_rows.rep_payout` is a **stored generated column** (`round(residual_income * rep_split_pct / 100, 2)`), so it is null whenever either input is null and cannot be written directly. Null means "not worked out yet", never zero, and every total, export and summary has to keep that distinction. `volume` and `average_ticket` are `check >= 0` because a negative there is a parse error; `total_cost` and `residual_income` are deliberately **signed**, because clawbacks are real and a constraint rejecting one turns valid processor data into an unexplainable blocked import.

**Deleting a user requires clearing five payout FKs first**, and all five are `NO ACTION`: `rep_payout_rows.agent_id`, `rep_payout_import_rows.agent_id`, `rep_payout_batches.imported_by`, and both `rep_payout_row_history.agent_id` and `.changed_by`. Exactly the trap `audit_log.actor_id` sets, with five doors instead of one — and it has already been walked into once: a teardown deleted a profile without clearing staging rows, the delete failed on the FK *unchecked*, and the surviving rep then resolved an agent number the next run expected to be unknown, which presented as a parser bug. Clear all five before `deleteUser`, and check the error.

**SheetJS is pinned to `https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs`, not `npm:xlsx`** — in `parse-residual-import/deno.json` and as the devDependency that builds test fixtures. npm's latest is 0.18.5 and carries two high-severity advisories (prototype pollution, ReDoS) fixed only in SheetJS's own later builds, since they stopped publishing to npm. Don't "simplify" it back to `npm:xlsx`. The remote-URL import is verified under `functions serve`; whether it survives `functions deploy` is untested, and the fallback is vendoring the one `xlsx.mjs` file, not downgrading.

Fixtures for these tables live in `seedPayouts()`, **not** `seed()`. Same reason `seed()` sets no `agent_number`: it is also run against a migration subset that predates them (`tests/rls/deactivation.test.ts` calls it with `createTestDb([INITIAL_MIGRATION])`), and anything it touches that a prefix has not created yet fails those suites with `relation does not exist`, pointing nowhere near the cause. `seedPayouts()` returns the ids it created rather than letting tests hardcode them, because `resetData()` clears these tables through the `cascade` from `profiles` without naming them — so their sequences are never restarted and the ids drift upward run after run.

Two consequences worth knowing before you write a test or a fixture. **Service-role and owner writes are logged with `actor_id = null`**, since neither has an `auth.uid()` — that is wanted for real server writes, but it means any fixture that seeds these tables as the platform owner stamps a `cross_agent_insert` per row. `tests/helpers/db.ts` `seed()` clears `audit_log` at the end for exactly that reason, and the live-suite teardowns clear the rows their own inserts *and deletes* generate. **And expect deliberate duplication**: `approve_pre_app` / `decline_pre_app` write their own row and also mutate a rep's `pre_apps`, so one event yields two rows at different granularities. Assert on `action` rather than on row counts.

**Deactivation is two layers and neither is optional.** `profiles.is_active = false` is what RLS reads; `banned_until` on `auth.users` (via `auth.admin.updateUserById(id, { ban_duration })`) is what GoTrue reads. Without the ban a "deactivated" rep still signs in successfully and lands on an app that is empty by design, which reads as a bug. `deactivate-user` writes the auth layer **first**, so a partial failure leaves the account locked-but-shown-active (visible, safe) rather than shown-inactive-but-usable (invisible, not). Neither layer revokes an access token already issued — that stays valid up to an hour, and RLS is what makes the window harmless. `admin.signOut()` is not the fix: it takes the target's own JWT, which an admin does not have.

### Edge Functions

Ten functions, all registered in `supabase/config.toml` (a function not listed there won't deploy or serve):

| Function | Purpose |
| --- | --- |
| `create-user`, `deactivate-user`, `admin-reset-password` | admin user management via `auth.admin` + `profiles`, each writing `audit_log` |
| `submit-pre-app-secrets`, `read-pre-app-secrets` | encrypt/decrypt the three secrets tables |
| `create-upload-url`, `create-download-url` | mint short-lived signed URLs for the private `documents` Storage bucket after checking `documents.agent_id` or `is_admin()` |
| `residual-import-file-url` | admin-only; two modes — creates a `rep_payout_batches` row and signs an upload into `residual-imports`, or signs a download of a batch's stored file |
| `parse-residual-import` | admin-only; reads a batch's XLSX with SheetJS and stages its rows. **Idempotent** — it clears the batch's staging rows first, which is what makes "resolve an agent number, then read again" one code path rather than two |
| `export-residuals` | **not admin-only, deliberately.** Reads every row through the *caller-scoped* client, so RLS is the whole authorization story and a rep's export is their own book. Reaching for `supabaseAdmin` anywhere in it — even to join agent names — would silently turn that into the company's, which is the disclosure shape `search_crm` is `security invoker` to avoid. Paginates with `.range()`, because PostgREST's `max_rows` would otherwise export a silent prefix |

**All ten are `verify_jwt = false` in `config.toml`** — verified, every one of the ten `[functions.*]` blocks sets it. The platform therefore performs **no** auth check before your handler runs, so **each function is responsible for authenticating the caller itself**. `functions deploy` carries this setting up with the code, so it holds in production too.

Every one of them follows the same shape, and the order matters:

1. `withSupabase({ auth: "user" }, ...)` rejects a missing or invalid JWT before the handler body (this is what returns the `401`).
2. `callerIsActive(ctx.supabase)` — an `is_active_agent()` RPC through the **caller-scoped** client. A valid JWT does not mean the account is still enabled; a deactivated agent's token keeps working until it expires. Called via `ctx.supabaseAdmin` this would always be false, because a service-role connection has no `auth.uid()`.
3. Authorization through the caller-scoped client, so RLS makes the decision — `resolveParentAgentId()` looks the parent record up as the caller rather than re-implementing ownership by hand.
4. **Only then** `ctx.supabaseAdmin`, and only for the privileged step itself (minting the signed URL). It bypasses RLS, so nothing may reach it before authorization is settled.

Also: return `404`, not `403`, when a record isn't the caller's — "not yours" and "doesn't exist" must be indistinguishable or the endpoint becomes an id oracle. `tests/live/document-urls.test.ts` asserts every one of these branches against the running functions.

Runtime is Deno 2 with per-function `deno.json` import maps; `.vscode/settings.json` enables the Deno language server only for `supabase/functions`, so the rest of the repo stays on the Node TS server.

**The residual parser exists ONCE, and that is the opposite arrangement to the secrets validators below — worth knowing before you "match the pattern".** `supabase/functions/_shared/residuals.ts` holds every parsing rule (header matching, period normalisation, number coercion, blocker precedence) and is deliberately dependency-free, so it needs no import map — and, usefully, Node can therefore import it: `tests/unit/residuals-parse.test.ts` exercises all of it under vitest with no Deno, no Docker and no running stack. Because parsing happens only server-side, there is no browser twin to drift from. **Do not create one.** (A file reached by an import is still type-checked even though `tsconfig` excludes `supabase` from its roots, so `npx tsc --noEmit` covers this module through that test.)

**The secrets validators exist twice, on purpose, and TypeScript cannot see the pair.** `lib/pre-app-validation.ts` (zod, browser) and `supabase/functions/_shared/pre-app-secrets.ts` (hand-written, dependency-free) both implement `isSsn` / `isRouting` (incl. the mod-10 checksum) / `isAccount` / the `rp_password` cap. Genuinely sharing one file would need each `deno.json` to map a specifier reaching *above* `supabase/functions/` **and** `functions deploy` to bundle from there — not worth betting a deploy on, and `_shared/documents.ts` already answered this question the same way. The risk is real and one-directional in effect: change the checksum on one side only and the function starts rejecting values the UI accepts, producing a `400` the rep cannot explain. Nothing type-checks the pair, so **it is pinned by behaviour instead** — `tests/live/pre-app-secrets.test.ts` POSTs every value the client validator rejects and asserts `400`, plus a valid round-trip asserting success. Change both files together, and keep the cross-reference comments in each. (`tests/rls/validation-copy.test.ts`, which SPEC §10 lists, was deliberately **not** built: there is no second file to diff.)

Storage: **two** private buckets, `documents` and `residual-imports`, both created out-of-band — neither is in any migration, so a freshly started local stack has neither and every signing call 404s until they exist (`tests/live/helpers/stack.ts` creates them as part of provisioning). `residual-imports` holds the raw XLSX behind every `rep_payout_batches` row under the key `{batch_id}/{file_name}`, reachable only through `residual-import-file-url`; it needed its own bucket because the `documents` path resolves a **parent record's** `agent_id` and a residual report has no owning rep — it spans every rep in the file. The `documents` table stores metadata only (`owner_type` + `owner_id` polymorphic pointer, `doc_type`, `file_key`); bytes are in the bucket and are only reachable through the two signed-URL functions. The object key is `{agent_id}/{owner_type}/{owner_id}/{uuid}`, where `agent_id` is the **parent record's** owner rather than the uploader — so an admin uploading for a rep files it under that rep.

`notes` and `tasks` use the same polymorphic `owner_type` + `owner_id` shape (`lead` | `pre_app` | `merchant` | `ghost_sheet`) — there is no FK, so validate `owner_id` in application code. Concretely: the panels take `ownerType`/`ownerId` as props from a page that already loaded that parent row under RLS, never from a searchParam. Two consequences of the missing FK that no policy covers — the policies check only `agent_id` — are that a row can be filed against an owner the writer cannot see, and that deleting an owner orphans its notes and tasks. **`owner_type` must be in every query**: ids collide across types (lead 7 and merchant 7 both exist) and both rows can legitimately belong to the caller, so dropping it mixes one record's notes into another's page and RLS will not object. `notes` is the one Tier 1 table with **no update policy** — append-only by design, so never offer an edit affordance. As of `20260812143407` the UPDATE grant is revoked too, so an attempt now fails loudly (`permission denied`) instead of being filtered to zero rows and reporting a save that did nothing. Deletes on `support_tickets`, `notes` and `tasks` are admin-only, as of `20260810171500`.

### Next.js / auth wiring

- Three Supabase client factories, don't mix them up: `lib/supabase/client.ts` (browser), `lib/supabase/server.ts` (Server Components / Actions / Route Handlers, cookie-backed, `async`), `lib/supabase/proxy.ts` (request pipeline). Never hoist any of them into a module-level global — Fluid compute reuses processes across requests.
- `proxy.ts` at the repo root is Next 16's renamed middleware. It calls `updateSession()`, which refreshes the session cookie and redirects unauthenticated requests to `/auth/login` for everything except `/` and `/auth/*`. Do not insert code between `createServerClient()` and `supabase.auth.getClaims()` in that file, and return the `supabaseResponse` object unchanged — the comments there explain why (random logouts).
- Auth pages live under `app/auth/*` with matching form components at the top level of `components/`; `app/auth/confirm/route.ts` handles email OTP verification.
- `next.config.ts` sets `cacheComponents: true`, so dynamic data fetching must sit inside a `<Suspense>` boundary (see `app/protected/page.tsx` for the shape).
- Env vars (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`) live in **two** gitignored files, and the split matters: `.env.local` holds the **hosted** project and is what `next build` and production use; `.env.development.local` holds the **local stack** and wins in dev, because Next resolves `.env.development.local` ahead of `.env.local`. So `npm run dev` talks to the local stack with no flag to remember. Recreate it from `npx supabase status -o env` (`API_URL` + `PUBLISHABLE_KEY`) whenever the local ports change; `.env.example` documents the whole arrangement.
- **`lib/env-guard.ts` throws at dev-server boot if the Supabase URL isn't local.** This is not hypothetical: with only `.env.local` present, `npm run dev` pointed the app at production, and the symptoms were an admin-only column appearing for a rep and a list reading "no pre-apps yet" because the row was in the other database. Nothing announced it. The guard runs from `next.config.ts` (hard throw, server) and once per page load in `lib/supabase/client.ts` (warn, browser — a built bundle can't fix its own URL). Set `ALLOW_REMOTE_SUPABASE_IN_DEV=1` to develop against the hosted project deliberately.
- The publishable/anon key is the only key the Next app should ever hold — the service-role key belongs in Edge Function secrets only. `lib/utils.ts` exports `hasEnvVars`, a starter-only guard that several components branch on; it can be deleted once the template UI is replaced.

### Conventions

`@/*` path alias maps to the repo root. shadcn/ui components go in `components/ui/` (add via `npx shadcn@latest add <component>`); compose classes with `cn()` from `lib/utils.ts`. Icons from `lucide-react`. Theming is `next-themes` with CSS variables in `app/globals.css`.

### The design system is tokens, not classnames

**Every colour comes from a CSS variable in `app/globals.css`.** No component names a palette colour (`bg-gray-100`) or a hex. Adding one is how the theme starts drifting, and there is nothing that will fail to warn you — so the check is: if you are about to type a Tailwind colour literal, the token you want either exists or should be added there.

Two colour systems that must not mix:

- **Brand and action** — `primary` (#DC2626: primary buttons, links, the sidebar's active accent and count pill, focus rings) and `destructive` (#B91C1C: delete/danger only, and always behind a confirmation step). They are deliberately different reds. A delete button that renders in the same red as the page's main create action invites the misclick the pair exists to prevent.
- **Status** — `success`/`warning`/`neutral`, for state badges only, via `components/status-badge.tsx` and a `StatusIntent` mapper per domain (`statusIntent` in `lib/{merchants,pre-apps}.ts`, `supportTicketStatusIntent`, `conversionIntent` in `lib/ghost-sheets.ts`). **Never** put brand or destructive red on a status badge, and never put a status colour on a button or in the nav. `leads.status` maps to `neutral` unconditionally — it's unconstrained text, so there is no vocabulary to colour, and inventing one is the drift `lib/leads.ts` warns about.

Shared structure lives in components, so page-level styling stays out of pages: `PageShell` (the three content widths), `PageHeader` (title row), `StatCard`, `StatusBadge`, `Callout`, `FilterTabs`. The `Table` primitive draws its own white card and uppercase muted headers — list pages don't wrap it.

The sidebar is dark in every theme, so its tokens live only in `:root` and are never overridden in `.dark`. The app is pinned to light (`defaultTheme="light"`, `enableSystem={false}` in `app/layout.tsx`) because there is no dark palette yet; the `.dark` block is the stock shadcn scale, left in place so turning dark mode on later is filling in values rather than re-plumbing.

Sidebar contents are data in `lib/nav.ts`, not JSX. An item without an `href` renders as a muted, `aria-disabled` row — the mechanism for listing a section before its page exists. **No item currently uses it**; Notes and Tasks did until `/notes` and `/tasks` were built, and a permanently-greyed row trains people to ignore that part of the nav, so prefer building the page or dropping the row over leaving one there. `usePathname()` supplies the active item, which under `cacheComponents` is runtime-only data: the client nav **must** sit inside a `<Suspense>` boundary, and its fallback therefore cannot call the hook either. That is why `components/sidebar-nav-list.tsx` takes `pathname` as a prop and is shared by both the streamed nav and its fallback.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
