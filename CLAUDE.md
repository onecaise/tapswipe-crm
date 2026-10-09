# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

Tapswipe's internal CRM (merchant services): Dashboard, Merchants, Pre-Apps, Leads, Ghost Sheets, Support Tickets, Document Center, My Submissions.

**Current state matters when reading the code**, and it is a mix — real CRM pages alongside untouched starter scaffolding:

- **Built:** every CRM route lives under the `app/(app)/` route group so it renders inside the shell — `app/(app)/{dashboard,merchants,leads,ghost-sheets,pre-apps,support-tickets,documents,notes,tasks,payouts,marketing,marketing/manage,admin/users,admin/users/import,admin/products}`. Route groups don't affect URLs, so the paths are still `/dashboard`, `/merchants/7` and so on. Data-access helpers in `lib/{merchants,leads,ghost-sheets,pre-apps,pre-app-validation,masks,support-tickets,annotations,annotations-data,documents,payouts,user-imports,products,quotes,auth,format}.ts` and `hooks/use-autosave.ts`. Notes and tasks are **written** through panels (`components/{notes,tasks}-panel.tsx`) on the four owner records; `/notes` and `/tasks` are the cross-record view of the same rows, and are read-only (notes) or read plus the complete toggle (tasks). Creation stays on the record, because `owner_id` has no FK and the panels take the pair from a parent row already loaded under RLS. `components/documents-panel.tsx` hangs off **all four** `documents.owner_type` values — merchants, leads, pre-apps and support tickets — and `/documents` is the cross-record Document Center over the same rows. Quotes have no page of their own: `components/quotes-panel.tsx` is the builder and the version history, and it lives on **both the lead and the merchant** — `quotes_exactly_one_owner` means a proposal hangs off exactly one of them, and a rep sells hardware to win a deal and again to the same business once it is on the books. The two printable routes (`/{leads,merchants}/[id]/quotes/[quoteGroupId]/print`) share one document component.
- **Not built yet:** My Submissions.
- **Still [starter-kit](https://github.com/vercel/next.js/tree/canary/examples/with-supabase) template, not product code:** `README.md`, and that is now the whole list. The scaffold's UI was deleted on 14 Sep 2026 — `app/protected/*`, `components/tutorial/*`, `components/{hero,deploy-button,next-logo,supabase-logo,env-var-warning,auth-button,theme-switcher}.tsx`, the `hasEnvVars` export, and the two `app/{opengraph,twitter}-image.png` banners that served a "Next.js Starter Kit" social preview from an internal tool. `app/page.tsx` is product code now: it renders nothing and redirects (see below). Don't reintroduce a greyed-out template page for the same reason `lib/nav.ts` shouldn't carry a permanently-disabled row.
- **Edge Functions:** all fourteen are implemented — `create-upload-url`, `create-download-url`, `delete-document`, `submit-pre-app-secrets`, `read-pre-app-secrets`, `create-user`, `deactivate-user`, `admin-reset-password`, `residual-import-file-url`, `parse-residual-import`, `export-residuals`, `stage-user-import`, `provision-user-batch`, `marketing-material-file-url` (shared helpers in `supabase/functions/_shared/{documents,crypto,pre-app-secrets,secrets-env,admin-users,provision-user,residuals,residual-imports,user-imports,marketing-materials}.ts`).

**`docs/tapswipe_crm_schema.sql` is the authoritative spec** for the data model and access rules, not the migrations. Change the doc first, then make `supabase/migrations/` match it. Forty-one migrations exist; `20260804201300_initial_schema.sql` is the first.

Stack: Next.js 16 (App Router, React 19), Supabase (Postgres + Auth + Storage + Deno Edge Functions), Tailwind 3 + shadcn/ui (new-york, `neutral` base), TypeScript strict. Linked Supabase project ref: `vdjtosofrimipklbdjbi` — and note **which** project that is: `tapswipe-crm-dev`. The second project `tapwipe-crm-prod` (`zuvsdkjnfstrjahstsmg`) is **not linked, but it is deployed and real**: `PRE_APP_SECRETS_KEY` is set and both private buckets exist. Treat it as live production, not as a spare project.

**Prod schema is caught up as of 18 Sep 2026 — all 30 migrations, verified against its own catalog** by `scripts/push-prod-migration.ps1`, which checks the migration rows AND the resulting objects rather than trusting the CLI's exit code. Log in `scripts/logs/`. Don't take that as standing parity: it was two behind for two days before this, and the only honest way to know is to run `scripts/diag-prod-trigger.ps1`, which says outright whether prod matches the repo.

**Functions are a separate question from the schema, and a migration push does not carry them.** That is `functions deploy`, which is also the one command where `--project-ref` genuinely exists — so deploying to prod needs no relink and no database password, only a logged-in CLI.

**Thirteen of the fourteen are deployed to prod as of 18 Sep 2026** — `marketing-material-file-url` (2 Oct 2026) is NOT, and neither is the migration behind it; the marketing feature is dev-only until someone deploys both deliberately. The thirteen were each, each `ACTIVE` with `verify_jwt = false`. `stage-user-import` and `provision-user-batch` were deployed by name rather than with a bare `functions deploy`, which would have redeployed the eleven working ones for no reason. Verified two ways, because the CLI's success message is not evidence: `functions list --project-ref` reports thirteen, and an unauthenticated POST to each new one returns **401** from its own `withSupabase` guard — where a slug that does not exist returns **404**. That contrast is the check worth copying; a 401 proves the code is running, while `functions list` only proves a record exists.

So `supabase db push`, `functions deploy` and `migration list --linked` target **dev**; `npm run test:deployed` is the exception — it reads `.env.deployed.local` and checks **every** project named there, dev and prod both, so it is the one command whose target does not depend on the link at all. Wording below that says "production" of the linked project means "the hosted project" and is loose — **dev is what those commands hit, and that looseness is exactly what went wrong once.**

**Reaching prod is not one answer, and `--project-ref` is not it.** That flag exists on `functions deploy` — which is how the 4 Sep prod deploys were done, and for functions it genuinely is the form no one else's relink can invalidate. It does **not** exist on the migration commands. Verified 16 Sep 2026: `supabase db push --help` lists only `--linked`, `--local` and `--db-url` for targeting, and `migration list --project-ref …` fails outright with `UnrecognizedOption`. So for anything schema-related there are exactly two routes to prod, and both cost something:

- **Relink** (`supabase link --project-ref zuvsdkjnfstrjahstsmg`, then `ALLOW_PROD_SUPABASE=1 npm run db:push`). This is the 2 Sep incident's own mechanism — it changes global CLI state, and until it is reversed the guard fails closed on every wrapped command, blocking unrelated work.
- **`--db-url`** with the prod connection string. No relink and no global state, but it needs the prod Postgres password, which is deliberately nowhere in this repo — `.env.deployed.local` holds publishable keys only.

**And the URL is not the obvious one.** `db.zuvsdkjnfstrjahstsmg.supabase.co` resolves to an **AAAA record only** (measured 16 Sep 2026), so on a host without IPv6 egress it fails at DNS — "No address associated with hostname" — before any credential is tested. Use the pooler in **session** mode, and note the username carries the ref:

```
postgresql://postgres.zuvsdkjnfstrjahstsmg:<password>@aws-0-us-west-2.pooler.supabase.com:5432/postgres
```

Port 5432, not 6543: transaction mode breaks a migration partway through. Both projects are `us-west-2`, so dev's pooler host is prod's too.

**`aws-0`, not `aws-1` — this file said `aws-1` until 18 Sep 2026 and that was never verified.** `aws-0` is what actually authenticated against prod, twice, in the diagnostic and the push. Both hostnames resolve to real, distinct Supabase pooler IPs and both accept TCP on 5432, so nothing about DNS or a port check will tell you which is right. The wrong one fails as `Tenant or user not found`, which reads exactly like a bad password and will send you off rotating a credential that was fine. `scripts/prod-state.ps1` and its two callers all use `aws-0` and print the alternate as a hint on failure.

**Don't hand-build that URL — use the scripts.** `scripts/diag-prod-trigger.ps1` reads prod's state read-only and says whether it matches the repo; `scripts/push-prod-migration.ps1` applies what is pending and verifies the result against the catalog. Both take the password from `$env:SUPABASE_DB_PASSWORD` (set it with `Read-Host -AsSecureString`, never a literal assignment — PSReadLine's sensitive-input filter catches the word "password" but *not* a credential embedded in a URL, which is how three of them ended up in shell history), both redact it out of everything they print, and both write a log to `scripts/logs/` because the answer has to outlive the terminal. Run the push with `-DryRun` first.

Two things they encode that cost a session each: `db push` **prompts** for confirmation on a remote target, so it must be run with `--yes` and its output must STREAM rather than be captured — buffering with `Out-String` swallows the prompt and hangs forever at near-zero CPU. And `db push` applies **everything** pending with no target-version flag, so any verification pinned to one migration reports PASS over the ones it did not look at; the migration check is now derived from `supabase/migrations/` instead.

**The one combination to never trust: `npm run db:push -- --db-url <prod>`.** The guard reads the *linked* project, so it prints `dev, ok` and exits 0 while the command underneath goes to prod. That is a false reassurance from the very script written to prevent this mistake. When targeting prod by URL, call `npx supabase` directly so nothing claims to have checked something it did not.

**The linked-project claim above drifted once, silently, and the guard exists because of it.** On 2 Sep 2026 12:15 EDT the CLI was manually relinked to **prod**, and this file went on asserting dev was linked for seven days. Two read-only commands (`migration list --linked`, `npm run test:deployed`) ran under that false belief before anyone noticed — no writes, no data touched, and the 4 Sep prod deployment that followed was deliberate and taken from a full `db dump` backup first. That was luck rather than design: nothing in the repo compared the documented link against the actual one. Now something does — `scripts/check-linked-project.mjs` prints the linked project and **fails closed** when it is prod, missing, or an unrecognised ref. Use the wrapped scripts for anything acting on the linked project:

```bash
npm run guard:linked      # print the linked project; exit 1 if prod or unrecognised
npm run db:push           # guard, then supabase db push
npm run db:dump           # guard, then db dump --linked
npm run migration:list    # guard, then migration list --linked
npm run functions:deploy  # guard, then functions deploy
ALLOW_PROD_SUPABASE=1 npm run db:push   # act on prod on purpose
```

The guard reads `supabase/.temp/linked-project.json`, so it reports what the CLI will *actually* do rather than what any doc claims. Raw `npx supabase …` still bypasses it — prefer the npm scripts for anything aimed at the linked project, and pin `--project-ref` when you mean prod **on a command that has that flag** (`functions deploy` does; `db push` and `migration list` do not — see above for what to use instead). Dev is also frequently `INACTIVE` (paused), in which case `migration list` fails with a connection timeout and `functions deploy` bundles fine but then 404s with `Cannot retrieve service for project … status 'INACTIVE'`; restoring it is a dashboard action, with no CLI equivalent under `supabase projects`.

## Commands

```bash
npm run dev            # Next dev server on :3000
npm run build          # next build (also type-checks)
npm run lint           # eslint .
npx tsc --noEmit       # type-check only

npm test               # hermetic suite — PGlite + pure logic, no Docker (1316 tests)
npm run test:live      # local stack over HTTP — needs `supabase start` + `functions serve` (205 tests)
npm run test:deployed  # read-only assertions about the DEPLOYED projects (29 tests)
npm run test:e2e       # Playwright, real browser against the app on the local stack (146 tests, 5 of them the shared setup)
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

- **`npm test`** — vitest + `@electric-sql/pglite`, applying `supabase/migrations/` over a deliberately minimal auth shim (`tests/helpers/db.ts`: three Data API roles, `auth.users`, `auth.uid()` reading the `request.jwt.claims` GUC). Covers RLS policies (`tests/rls/*`) and the grant surface (`tests/rls/grants.test.ts`). **Run this for any schema change.** Queries must run as `authenticated`, not the owner — Postgres bypasses RLS for a table's owner, so an owner-run test passes regardless of policy.
- **Never write a literal `\xHH`-shaped escape inside a JS template literal**, including inside text meant to read as a SQL comment. `tests/helpers/db.ts` builds SQL in template literals, so JavaScript consumes the escape before Postgres ever sees the string: `\x00` becomes a real NUL byte, which desyncs the wire protocol and fails dozens of *unrelated* tests with a bare `invalid message format` from the pg-protocol parser, naming no statement and pointing nowhere near the cause. (It cost an hour once, in a comment that existed to warn about exactly this.) For `bytea` fixtures use `decode('0011', 'hex')` — no backslash to get wrong.
- **`npm run test:live`** — real HTTP with real JWTs. Covers what PGlite structurally cannot: GoTrue password sign-in, PostgREST grants, the Deno runtime, Storage signed URLs. Hard-errors rather than skipping when the stack is down. Run it when touching Edge Functions, auth, or Storage.
- **Call `warmFunctions([...])` in a live test's `beforeAll`, before any status-code assertion.** The CLI rewrites a function's `.npmrc` the first time that function is invoked in a `functions serve` session; its own file watcher sees the write and restarts the runtime, which `502`s whatever is in flight. On a cold serve this produced 24 failures across the suite, every one reading `expected 502 to be 200` and pointing nowhere near the cause. All live files warm the functions they exercise.
- **A fixture that omits a denormalised column is invisible to everything that resolves by it, and nothing will tell you.** `provisionFixtures()` inserted its personas into `profiles` without an `email` for weeks. `create-user` has always written that column, so no real account looked like that — but `stage-user-import` detects an already-registered address by reading `profiles.email`, so every persona looked like a brand-new person and two correct tests failed against the fixture. `scripts/seed-local-users.mjs` had the identical gap with nothing asserting against it at all. Both now set it. The general form: if a column exists because something reads it, a fixture that skips it has silently opted out of that feature.
- **A live test that writes `audit_log` must clean it up before deleting its users.** `audit_log.actor_id references profiles(id)` with **no `ON DELETE`**, so `deleteUser` fails on the FK while those rows exist — the persona survives teardown and the next run dies on "user already registered". `teardownFixtures()` and `deleteUserCompletely()` both delete by `actor_id` and by `row_id` first. The FK is deliberately left strict: production never deletes users (§8), so only tests pay for it.
- **`npm run test:deployed`** — read-only Auth-config and schema-drift assertions against every project in `.env.deployed.local`, not just whichever one is linked. It used to read `.env.local`, which names dev, so "compliance checks against the deployed project" never once looked at production — and production sat with public sign-up enabled and 12 unpushed migrations until the 2 Sep 2026 outage found it. A project named `prod` is now required and the suite refuses to run without one, so coverage cannot be quietly dropped. A red result means a deployed project drifted, not that code broke. Uses only publishable keys.
- **`npm run test:e2e`** — Playwright + Chromium against `next dev` on the local stack (`playwright.config.ts`, specs in `e2e/`). Covers only what needs a browser: **layout, paint, client state across a refresh, and `<input type="file">`.** `e2e/fixtures/seed.ts` provisions its own personas and its own periods (deliberately in **2027**, so it never collides with the `seed-dev-*` scripts' 2026), and `e2e/auth.setup.ts` signs each persona in once into `e2e/.auth/*.json` — so no spec logs in and no spec holds a password. Reuses a running dev server.
- **`npm run test:e2e` needs `functions serve` running, and the table above said it did not until 7 Oct 2026.** `playwright.config.ts` starts `next dev` and nothing else, so the app is up but every signed-URL mint, document delete and user-import call 404s. The symptom is **18 specs failing at once** across `documents-panel` and `user-import` with ordinary-looking assertion errors — "expected visible", "expected 1 to be 0" — and not one of them naming a function or a port. Nothing in the run says the functions are missing. If a block of e2e failures appears all at once in files you did not touch, check `functions serve` before reading the diff.
- **Do not put RLS, PostgREST or pure-logic assertions in `e2e/`.** They are faster and more precise in the other three, and a browser copy is just a slower flakier duplicate. The rule of thumb: a spec belongs there only if a person could **only** find it by looking.
- **A geometric bug needs a geometric assertion, and bounding boxes are usually the wrong one.** The `StatCard` clipping bug (a figure painted outside its card, hidden by the next card's opaque background) passed a bounding-box comparison: a block element's box is constrained by its parent, so the *ink* overflows while `getBoundingClientRect` reports the parent's width unchanged — measured, 213px box against a 270px `scrollWidth`. `scrollWidth > clientWidth` is what actually detects it. A text assertion cannot see it either, which is how it shipped.
- **Prove an e2e spec is non-vacuous by reverting the fix.** Cheap here and worth doing every time, because a spec that drives a whole page can pass for reasons unrelated to what it claims. All seven specs covering the three browser-only payouts bugs were checked this way: revert the fix, watch exactly those specs go red, restore. Two of them were rewritten as a result of that check — they had passed against the reverted bug. The document pass repeated it for all six of its browser-only fixes and rewrote one spec: **`setInputFiles` dispatches `change` unconditionally**, so Playwright cannot reproduce "the user re-picks the identical file and no event fires" — the retry assertion passed with the fix reverted, and had to be replaced with one on the input's value, which is observable.
- **A partial revert is the sharper instrument, and `e2e/root-redirect.spec.ts` is the worked example.** Its four specs go red together on the *full* original state — stuck on `http://localhost:3000/` — but reverting one layer at a time says much more. Restoring the starter page while leaving the proxy fixed changes **nothing**: all four still pass, because the proxy redirects before the page can render, so the "no starter markup" assertions in them are decoration rather than coverage. Reverting the proxy's `/` branch while leaving `app/page.tsx` fixed also leaves three of the four green, because the page's own redirect still gets you to `/dashboard` — only the rotated-cookie spec goes red, on `/ should redirect rather than render`. That one spec is therefore the entire proof that the proxy layer exists, and removing the cookie copy alone reds it and nothing else. Kept as-is rather than tightened: the URL assertions are the load-bearing ones and they are honest, and a spec that fails for two reasons at once is worse than two that each fail for one.
- **A spec that fails ~1 run in 3 but passes 3/3 in isolation is measuring the wrong thing, not flaky infrastructure.** The two-tabs document spec asserted that each tab's own row appeared after two *concurrent* `router.refresh()` calls, which is a claim about Next's refresh timing under contention rather than about documents; and it read `storage.list()` once immediately after a PUT, making a read-after-write lag indistinguishable from a lost file. Rewritten to wait for an observable settled state, reload both tabs (a fresh server render races nothing), and poll the storage read. Same claims, no races. `retries: 0` is what surfaces this instead of hiding it.
- **And when a spec fails ~1 run in 3 *in isolation too*, it is not a race — look at the clock.** The same two-tabs spec went on failing about one run in three, with passing runs landing at 23–29s against the 30s per-test timeout. The cause was not in the spec: `localStackConfig()` in `e2e/fixtures/seed.ts` ran `execSync("npx supabase status -o env")` on **every** call, and it has twelve call sites — including inside `expect.poll` loops, so it was spawning a CLI process per poll iteration. Roughly 17 of those seconds were `npx` starting up. Memoised (the ports cannot change mid-run), the spec now runs in a flat 10.0–10.7s, 4/4. The general form: a test whose *passing* runs sit just under the timeout is already failing, it just has not been unlucky yet — read the duration, not only the pass.
- **Sometimes the right answer to a revert experiment is to DELETE the spec.** The marketing View button had a real, shipped bug — `window.open(url, "_blank", "noopener")` **returns null by spec**, so the handle was always null, the fallback navigated the *current* tab, and the blank tab the browser had already created sat orphaned. Found by hand in Chrome; fixed and re-verified by hand. Playwright can see none of it: the cross-origin assignment never moves the page object (`waitForURL` dies with `net::ERR_ABORTED; maybe frame was detached?`, polling `opened.url()` sits on `about:blank`), and crucially the **fallback does not navigate under Playwright either** — so the broken version is indistinguishable from the fixed one. Two drafts went green with the bug deliberately restored, the first because it read `page.url()` before the fallback had had time to run, the second because the fallback never runs there at all. A spec green for the bug *and* the fix is worse than no spec: it claims coverage that does not exist. It was removed, with the reasoning left in `e2e/marketing.spec.ts` where the next person will look for it.
- **A spec that asserts an empty state is at the mercy of whatever ran before it.** `marketing_material_events` is append-only by design — no UPDATE or DELETE grant for `authenticated` — so a spec cannot undo its own writes, and the first draft of the Email test passed or failed on test ORDER. `clearMarketingEvents(leadId)` runs as the service role for exactly that reason. Per-lead rather than a blanket wipe, so a spec cannot quietly come to depend on being the only thing running.
- **Expect leftovers after a revert experiment.** Reverting the delete-document fix leaves a storage object with no row; reverting the orphan-cleanup leaves the same. Both are invisible (private bucket) and neither is a product bug — but the file names a spec *refuses* have to be in its cleanup list too, or the next run's empty-state assertion fails for an unrelated reason.

Why four and not one: each suite is green while the next one's class of bug sits in the repo. The PGlite suite was 100% green with no Data API grants at all and an `[auth.email] enable_signup = false` that disabled password login — neither visible below PostgREST/GoTrue. All three of those were green while `/payouts` shipped a stale editable cell (the page showing `410 × 50% = $174.25`), a clipped money figure, and six columns pushed off screen by one long merchant name — none visible without a browser.

### Build/lint exclusions are deliberate

`tsconfig.json` excludes `supabase`; `eslint.config.mjs` ignores `supabase/**`, `.next/**`, `next-env.d.ts`. Don't re-include them. `supabase/functions` is Deno and resolves imports through per-function `deno.json` maps that Node/TS cannot see (the Deno language server checks it instead, per `.vscode/settings.json`), and `supabase/.temp` is CLI scratch — `supabase start` writes a minified bundle there that alone produced 186 lint errors.

**`allowImportingTsExtensions: true` is in `tsconfig.json` because of those Deno files, and the reason is not obvious.** Excluding `supabase` from tsconfig's ROOTS does not exclude it from type-checking: a file reached by an `import` is checked anyway, and the unit suites deliberately import `_shared/{residuals,user-imports}.ts` so the parsing rules can be tested under vitest with no Deno. That was harmless while those modules imported nothing — but Deno *requires* the `.ts` extension on a relative import, so the moment one `_shared` module imported another, `npx tsc --noEmit` failed with `TS5097`. The flag is legal here only because `noEmit` is already set. The alternative was giving each browser-side module its own copy of the validators, which is the drift the sharing exists to prevent.

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

1. **Normal tables via `supabase-js`** (`merchants`, `leads`, `ghost_sheets`, `pre_apps` + children, `documents`, `support_tickets`, `notes`, `tasks`, `audit_log`, `rep_payout_rows` + the three other `rep_payout_*` tables, and the two `user_import_*` tables). RLS does the enforcement; the client talks to Postgres directly. Note how little of that list is client-*writable*: the payout and user-import tables are read-only to `authenticated` apart from one status update each, because everything that creates their rows runs as service role.
2. **Secrets tables — Edge Function only.** `pre_app_owner_secrets` (SSN), `pre_app_banking_secrets` (ABA routing / account number), `pre_app_terminal_secrets` (RP password) are locked twice over: RLS enabled with **zero policies**, *and* no grant to `anon` or `authenticated` at all. Either alone denies read and write; both means a policy added by mistake still opens nothing. Values are stored as `bytea` AES ciphertext; only a service-role Edge Function holding the encryption key can touch them. This includes the agent's initial submission — the browser must POST that data to `submit-pre-app-secrets`, never insert it via `supabase-js`. Never add a policy to these tables, and never grant them.
3. **`commit_residual_import(batch_id_input int)` RPC** — `security definer`, guarded by an explicit `is_admin()`, moves a reviewed batch's staging rows into `rep_payout_rows`. It is an RPC and **not** an eighth Edge Function on purpose: supabase-js has no client-side transaction, so a function would insert ledger rows, delete staging rows and flip the batch status as three round trips with a real window where a period is half-imported. It also sidesteps PostgREST's row cap (`insert … select` has none), gets a fail-closed audit row for free, and keeps `auth.uid()` — so the history rows the merge triggers name the committing admin. **The `coalesce(excluded.<col>, rep_payout_rows.<col>)` on the two money columns is the entire merge rule**: reverse those arguments and every re-import silently clears a month of hand-entered residuals, violating no constraint and raising no error. `tests/rls/commit-residual-import.test.ts` asserts both directions and greps the function body for it.
4. **`approve_pre_app(pre_app_id_input int)` RPC** — `security definer` plpgsql that creates a `merchants` row from a pre-app, flips its status to `approved`, and writes `audit_log`. It guards itself with an explicit `is_admin()` check at the top; keep that check if you edit it.

**A `security definer` RPC is the exception, not the default.** `convert_ghost_sheet_to_lead`, `dashboard_counts` and `search_crm` are all plain **security invoker** functions on purpose: the caller's own policies scope every read inside them, so an agent gets their own rows and an admin the company's with no role branch in the SQL and no `agent_id` filter to fall out of step with the policies. Reach for `definer` only when the function must touch something the caller genuinely may not (the `*_secrets` tables, writing `audit_log`, creating a merchant) — and then it owes you a hand-written ownership check plus `set search_path`. **`dashboard_counts()` keeps that property while taking filter parameters** (`20261007120000`), including one for another rep's `agent_id` — which sounds like exactly the thing a definer is reached for and is the opposite: see the dashboard-filters section below.

**`check_duplicates()` is the deliberate mirror of that, and the pair is worth reading together.** `search_crm` is invoker *so that* a search box cannot return a record the app hides; `check_duplicates` cannot be, because the duplicates that matter most are exactly the ones RLS hides — two reps working the same merchant. So it is `security definer` over `leads`, `ghost_sheets` and `merchants`, and it pays for that reach two ways: a hand-written `is_active_agent()` guard, and a return shape that for any record the caller could **not** already see carries the fact of a match plus the field it matched on and **nothing else** — `record_id`, `title` and `subtitle` are NULL from the function, not blanked in the UI. Redacted rows are also **aggregated** to `(record_type, matched_field, strength)`, so the row count cannot be read as a census of other people's books. `tests/rls/check-duplicates.test.ts` asserts `prosecdef` is **true** here — the opposite of `tests/rls/dashboard-and-search.test.ts`, and copying that file's assertion over would be asserting this function is broken.

**It only ever warns, and must never become a block.** A hard block on a cross-book duplicate is unrecoverable from the UI by construction: the rep cannot see the offending record, so the only move left is to make the check miss, and the workaround reps find is typing the phone number wrong — which destroys the most reliable field the check depends on.

**pg_trgm lives in the `extensions` schema** (Supabase convention), which is why everything downstream carries `set search_path = public, extensions`; without it the failure is a bare `operator does not exist: text % text` at runtime. In the hermetic suite it must additionally be handed to the **PGlite constructor** (`new PGlite({ extensions: { pg_trgm } })` in `tests/helpers/db.ts`) — `create extension` alone is not enough there, and because every suite applies every migration, forgetting it reds all 56 files at once. The `dup_digits` / `dup_email` / `dup_host` normalisers exist to be indexed: never `create or replace` one with different behaviour without reindexing, because Postgres leaves existing index entries computed by the old definition and a duplicate check that silently stops matching looks exactly like no duplicates.

**`migrationsBefore()`, not `migrationsExcept()`, when a test reconstructs a point in history.** `migrationsExcept` drops a file out of the middle and still applies everything after it, which is right for the grant regression tests and wrong for everything else: the moment a later migration references a column the excluded one added, the suite dies on a missing relation in a migration the test is not about. That is not hypothetical — `20261002161500` indexes `leads.website` and broke the `leads-status` backfill block exactly this way.

For `search_crm` that choice is a security property rather than a style preference: a search box is exactly the shape of thing that becomes a disclosure bug, and running as the invoker means it physically cannot return a record the rest of the app hides. `tests/rls/dashboard-and-search.test.ts` asserts the scoping per role *and* asserts `prosecdef` is false on both — because adding `security definer` to either signature would silently widen every count and every hit to the whole table, and nothing else in the suite would notice.

`profiles` has no insert policy by design — rows are created by the `create-user` Edge Function using the service role, alongside `auth.users`. **That function must delete the `auth.users` row if the `profiles` insert fails.** The two together are one logical account, and half of one is the ghost-user state `lib/auth.ts` routes to `/auth/error?error=no-profile`: able to log in, sees nothing, and unable to self-heal precisely because there is no insert policy.

`audit_log` has no insert policy either, which is what decides where an audited action has to live. Anything that must leave a trail runs as service role (an Edge Function) or as a `security definer` RPC — a plain client write cannot log itself. `set_user_role()` and `set_agent_number()` are `security definer` for that reason and one more: the 11 Aug audit removed the admin UPDATE policy on `profiles`, so there is now no client write path to that table at all. `authenticated` holds **`select` only** on `audit_log`; the security audit narrowed it, because write privileges there were previously held back by nothing but the absence of a policy for those verbs.

`profiles.agent_number` (added `20260817101500`) is the only join between a processor's residual report and this database — the spreadsheet's "Agent #" column has never heard of a uuid. Nullable with a **partial** unique index (`where agent_number is not null`), because every profile predating the column has none and there is nothing to backfill from. Blank must never be stored: `''` is a value that index enforces, so two reps cleared that way would collide. Both write paths normalise it to null and both cap the length at 32 — `set_agent_number()` in SQL and `isAgentNumber()` in `supabase/functions/_shared/admin-users.ts`, which `create-user` applies. Nothing type-checks that pair, so change them together. See `RESIDUALS_SPEC.md`.

`profiles.territory` (added `20261002143000`) looks like the same shape of column and is not. It is a **reporting label**: free text with no vocabulary (reference data an admin extends as the company opens a region, the same reasoning `support_tickets.category` stays unconstrained), no uniqueness — many reps per territory — and no index, because nothing resolves through it. Written only by `set_territory()`, which is the pattern to copy for **any** new `profiles` column: there is no UPDATE policy *and* no UPDATE grant for `authenticated` on that table, so a `security definer` RPC with a hand-written `is_admin()` guard is the only way a column there becomes settable. Answering that with a policy re-opens what the 11 Aug audit closed.

**`territory` is not an access boundary, and must not become one by accident.** No policy reads it; every `agent_id` table is still scoped by `agent_id = auth.uid()`. "Agents see their whole territory" is a different and much larger feature — it rewrites the own-row half of all seven owner tables, turns a per-row equality check into a join against `profiles`, and needs an answer for a rep whose territory changes while holding live deals. Wiring it into a policy as a convenience silently widens every rep's book, and the existing policy tests would not notice because their fixtures all share one territory (none). `tests/rls/set-territory.test.ts` greps `pg_policies` for the word and asserts zero hits.

**`profiles.manager_id` (added `20261002174500`) holds the same line for the same reason, and is the clearer case because "managers" sounds like access and is not.** A nullable self-reference written only by `set_manager()` — the `security definer` + hand-written `is_admin()` pattern above, because there is still no UPDATE policy or grant on `profiles`. What it buys is **filtering by an admin who already sees every row** (`agent_id in (select id from profiles where manager_id = $1)` in a dashboard query); it changes nothing about what a rep or a manager can see of their own accord, and `tests/rls/set-manager.test.ts` greps `pg_policies` the same way.

**It is NOT a third role, and that is the cheaper half of the trade.** `role` stays `'agent' | 'admin'`: every policy here is a binary `is_admin()` check — around forty of them, plus the guard at the top of every definer RPC — so a third value needs either a third branch in all of them or a `manages()` helper called alongside `is_admin()` everywhere. That is a rewrite of the access-control design, not a column.

**The graph is exactly one hop, enforced in BOTH directions and neither guard is redundant.** `set_manager()` refuses a proposed manager who already has a manager *and* refuses giving a manager to someone who already manages — the first blocks building a chain downward, the second blocks building the identical chain upward, which the first cannot see. Together they make cycles of any length unreachable, which is what keeps "does X manage Y" a single equality instead of a recursive CTE. The rule lives in the RPC because a `CHECK` cannot see another row. Both halves were verified by reverting each in turn: guard-by-guard, exactly the matching specs go red.

**`log_cross_agent_change()` audits admin action on other people's records, and it FAILS CLOSED — intentionally.** An AFTER INSERT/UPDATE/DELETE trigger logging only when `auth.uid()` is not the row's `agent_id`, so a rep's own edits stay out of the trail and an admin's do not.

**It is on TEN tables, not seven, and this paragraph said seven until 2 Oct 2026** — `merchants`, `leads`, `ghost_sheets`, `pre_apps`, `support_tickets`, `notes`, `tasks`, plus `documents` (added `20260811173000`), `bug_reports` (`20260812175050`) and `quotes` (`20261002194500`). `support_ticket_replies` is an eleventh table covered by a *sibling* function, `log_cross_agent_reply()`, which resolves the parent ticket's owner because the replies table has no `agent_id` of its own. Read `docs/tapswipe_crm_schema.sql` for the list rather than this file: the doc carries the per-table reasoning next to each `create trigger`, and it is what stayed correct while this sentence did not.

**`documents` is in the list, and the story of why is the one to copy when deciding about a new table.** It was excluded at first on the grounds that its access is audited inside `create-upload-url` and `create-download-url`, where the signed-URL mint is the event rather than the metadata row. That reasoning is right about *reads* and still holds. It does not cover DELETE — `documents` is the one table whose delete policy is own-row-or-admin, and a delete mints no URL, so no function ran, no trigger fired, and the row vanished with its Storage object orphaned and nothing written down. Three audit mechanisms, and `documents` DELETE fell through all three. So the test for a new table is not "is it audited somewhere" but "is **every verb** audited somewhere".

It is an AFTER ROW trigger with no `EXCEPTION` block, so it runs in the triggering statement's transaction and **an audit_log insert failure rolls the write back with it**. A mutation to those seven tables cannot succeed while its audit row quietly does not. Do not "fix" that by wrapping the insert in an exception handler — the rollback is the design, and `tests/rls/audit-trigger.test.ts` asserts it. Four audit sites, four different answers, each deliberate: this one, `read-pre-app-secrets` and `log_payout_row_change()` fail closed because nothing has been committed or handed over yet; `submit-pre-app-secrets` *cannot* (its ciphertext is already written, so it reports `auditWriteFailed`); `rls_auto_enable()` swallows failures, because a backstop that breaks DDL is worse than one that misses a table.

**The `rep_payout_*` tables are the deliberate exception to `log_cross_agent_change()`, and the reasoning is worth knowing before you "fix" the omission.** `rep_payout_rows` carries `agent_id` and would work with that trigger unchanged — but nobody except an admin can write the table at all (no insert policy, admin-only update and delete), so `actor is distinct from row_agent_id` is true for *every* write. One forty-row import would produce forty `cross_agent_insert` rows, and it still could not record what a figure changed *from*, because `audit_log` has no detail column. So the trail is split by granularity instead: `audit_log` per committed batch and per deleted period, and `rep_payout_row_history` per value change, where a before and an after actually fit. The other three payout tables have no `agent_id` at all, which is the `support_ticket_replies` trap — that function would read NULL and log everything.

`rep_payout_rows.rep_payout` is a **stored generated column** (`round(residual_income * rep_split_pct / 100, 2)`), so it is null whenever either input is null and cannot be written directly. Null means "not worked out yet", never zero, and every total, export and summary has to keep that distinction. `volume` and `average_ticket` are `check >= 0` because a negative there is a parse error; `total_cost` and `residual_income` are deliberately **signed**, because clawbacks are real and a constraint rejecting one turns valid processor data into an unexplainable blocked import.

**Deleting a user requires clearing five payout FKs first**, and all five are `NO ACTION`: `rep_payout_rows.agent_id`, `rep_payout_import_rows.agent_id`, `rep_payout_batches.imported_by`, and both `rep_payout_row_history.agent_id` and `.changed_by`. Exactly the trap `audit_log.actor_id` sets, with five doors instead of one — and it has already been walked into once: a teardown deleted a profile without clearing staging rows, the delete failed on the FK *unchecked*, and the surviving rep then resolved an agent number the next run expected to be unknown, which presented as a parser bug. Clear all five before `deleteUser`, and check the error.

And know the real total while you are there: **twenty-two columns reference `profiles(id)`, and twenty-one of them are `NO ACTION`** (`profiles.manager_id`, added 2 Oct 2026, is the single exception at `on delete set null` — see below) — the five payout ones, `user_import_batches.imported_by`, `audit_log.actor_id`, `support_ticket_replies.author_id`, both `bug_reports` columns, `agent_id` on each of the seven owner tables, the two marketing ones added 2 Oct 2026 (`marketing_materials.uploaded_by`, `marketing_material_events.agent_id`), and `quotes.agent_id` (`20261002194500`). Any single leftover row blocks the delete, so a hand-written teardown list is permanently one table behind: `scripts/seed-local-users.mjs` carried two entries and broke the moment `seed-dev-payouts.mjs` gave the rep a ledger row. It now holds all nineteen, in FK-safe order, with the `pg_constraint` query to regenerate it in a comment — copy that list rather than reinventing it. The failure mode is worth recognising: an unchecked `deleteUser` that fails on an FK leaves the user in place, and the next `createUser` reports `email_exists` (422), which names the one thing that is not wrong.

**There are now FOUR teardown lists, and they drift independently** — `scripts/seed-local-users.mjs` (`PROFILE_REFERENCES`), `tests/live/helpers/stack.ts` (`clearPayoutRows` + `clearUserImports` + `clearMarketingMaterials`), `e2e/fixtures/seed.ts` (`clearImportedUsers`), and `seed-dev-local.mjs` (its own `PROFILE_REFERENCES`). That fourth one went undocumented for a month and carried eight entries while the canonical list had eighteen, so `node seed-dev-local.mjs` died with `email_exists` on any stack where `seed-dev-payouts.mjs` had run — the exact trap this paragraph describes, walked into by the one list nobody had written down. Fixed 2 Oct 2026, and its `deleteUser` is now checked.

`tests/rls/user-imports.test.ts` asserts the count is exactly twenty-one and that the only non-`NO ACTION` one is `profiles.manager_id`, **by name** — a bare count of exceptions would let a twenty-second column arrive with an `ON DELETE` of its own and pass as the known one. So adding a twenty-second reds a test rather than a teardown — but the test only counts them, it cannot know which list forgot one. Update all four together.

**The two marketing columns cannot be two more rows in the flat lists**, and that is worth knowing before adding the next table that looks like them. A material uploaded by one admin can carry events logged by a DIFFERENT rep, and `marketing_material_events.material_id` is `NO ACTION` too — so deleting by `uploaded_by` alone fails on somebody else's row, naming `marketing_materials` while the row actually in the way belongs to a rep the teardown was never asked about. Events are cleared by material and then by actor, and only then the materials. `clearPayoutRows` already had the same shape for the same reason.

**`manager_id` is in all three lists even though it cannot block a delete**, and it is handled differently in each: `on delete set null` means Postgres would clear it unprompted, so these clear it with an **UPDATE, not a DELETE** — the row holding the pointer is a *different* rep's profile, which is also why it is not an entry in `PROFILE_REFERENCES` (that list deletes rows). The failure it guards against is the quiet one: a seeded reporting line vanishing from a surviving persona with nothing reporting that it happened.

**SheetJS is pinned to `https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs`, not `npm:xlsx`** — in `parse-residual-import/deno.json` and as the devDependency that builds test fixtures. npm's latest is 0.18.5 and carries two high-severity advisories (prototype pollution, ReDoS) fixed only in SheetJS's own later builds, since they stopped publishing to npm. Don't "simplify" it back to `npm:xlsx`. The remote-URL import is verified under `functions serve`; whether it survives `functions deploy` is untested, and the fallback is vendoring the one `xlsx.mjs` file, not downgrading.

Fixtures for these tables live in `seedPayouts()`, **not** `seed()`. Same reason `seed()` sets no `agent_number`: it is also run against a migration subset that predates them (`tests/rls/deactivation.test.ts` calls it with `createTestDb([INITIAL_MIGRATION])`), and anything it touches that a prefix has not created yet fails those suites with `relation does not exist`, pointing nowhere near the cause. `seedPayouts()` returns the ids it created rather than letting tests hardcode them, because `resetData()` clears these tables through the `cascade` from `profiles` without naming them — so their sequences are never restarted and the ids drift upward run after run.

Two consequences worth knowing before you write a test or a fixture. **Service-role and owner writes are logged with `actor_id = null`**, since neither has an `auth.uid()` — that is wanted for real server writes, but it means any fixture that seeds these tables as the platform owner stamps a `cross_agent_insert` per row. `tests/helpers/db.ts` `seed()` clears `audit_log` at the end for exactly that reason, and the live-suite teardowns clear the rows their own inserts *and deletes* generate. **And expect deliberate duplication**: `approve_pre_app` / `decline_pre_app` write their own row and also mutate a rep's `pre_apps`, so one event yields two rows at different granularities. Assert on `action` rather than on row counts.

### Bulk rep import — why its staging rows behave differently from the residual ones

`user_import_batches` + `user_import_rows` look like `rep_payout_batches` + `rep_payout_import_rows`, and the resemblance is deliberate, but **one difference is the entire design and everything else follows from it.**

`commit_residual_import` is a `security definer` RPC that moves a whole batch into the ledger in **one transaction** and **deletes** the staging rows. That is possible because everything it touches is in Postgres. Creating an account is not: each one is a GoTrue write plus a Postgres write, in two different systems, with nothing spanning them. Two hundred reps is four hundred operations that can stop anywhere, and there is no commit that either happens or does not — only progress.

So **these staging rows are NOT deleted when the import finishes. They survive, each carrying its own outcome**, which makes the table the progress ledger as well as the staging area. `outcome is null` is the work list, and that single fact is the whole of batch-level resume. Do not "tidy up" by deleting committed rows: that throws away the only record of what each row did and makes a half-finished batch indistinguishable from a fresh one.

Three consequences worth knowing before changing any of it:

- **The loop lives in the browser, and that is not laziness.** An Edge Function's wall clock cannot hold two hundred sequential account creations, so `provision-user-batch` does a bounded chunk (5 by default, hard cap 10) and reports what is left; `components/user-import-run-button.tsx` asks again until the answer is zero. Every row's outcome is written **before the next row starts**, server-side, so closing the tab mid-run loses at most the in-flight row — and even that is recoverable, because `provisionUser`'s resume path adopts the orphan. A real queue would be new infrastructure with no observability surface here; the staging table already is one. The batch flips to `committed` **server-side** on the call that empties the work list, so a browser dying after the last chunk still leaves a correct batch.
- **Blocking vs skippable is a real distinction, not a nicety.** Six blockers stop the import; `email_exists` and `agent_number_taken` do not — those rows are skipped and the rest still imports. Accounts are independent of one another, unlike the rows of one period's ledger, so refusing forty onboardings because three people already have logins is the wrong trade. The rule lives in `isBlocking()`, which exists **twice** — `supabase/functions/_shared/user-imports.ts` and `lib/user-imports.ts` — because the browser copy cannot import the shared one without dragging `generateTempPassword` and `writeAudit` into the bundle. Unlike the pre-app validator pair, this duplication **is** pinned: `tests/unit/user-import-lib.test.ts` imports both and asserts they agree.
- **No credential is ever handed out in bulk, and that is structural.** `provisionUser` generates a temporary password per account; `provision-user-batch` discards it unread and returns nothing about it. Every account lands with `must_change_password = true` and **cannot sign in** until an admin issues a password per rep from Manage Users. A live test asserts the response body carries no credential and an e2e spec asserts the rendered page offers no copy affordance. The result screen has to say the accounts cannot sign in yet — without that line an admin creates forty accounts and reports a bug.

`provisionUser` in `_shared/provision-user.ts` is the single account-creation path, shared by `create-user` and the batch. It returns a discriminated result rather than a `Response`, and `conflict` is the outcome that needs different answers from its two callers: a 409 for a form submission, a skipped row for a batch.

**Deactivation is two layers and neither is optional.** `profiles.is_active = false` is what RLS reads; `banned_until` on `auth.users` (via `auth.admin.updateUserById(id, { ban_duration })`) is what GoTrue reads. Without the ban a "deactivated" rep still signs in successfully and lands on an app that is empty by design, which reads as a bug. `deactivate-user` writes the auth layer **first**, so a partial failure leaves the account locked-but-shown-active (visible, safe) rather than shown-inactive-but-usable (invisible, not). Neither layer revokes an access token already issued — that stays valid up to an hour, and RLS is what makes the window harmless. `admin.signOut()` is not the fix: it takes the target's own JWT, which an admin does not have.

**A rep's own logout is a different thing again, and it is `scope: "global"`.** `components/logout-button.tsx` in the topbar calls `supabase.auth.signOut()` with supabase-js's default scope, so signing out at a desk revokes that user's refresh tokens on **every** device rather than ending just that browser's session — kept deliberately, but written down because nothing announces it: already-issued access tokens stay valid either way (JWTs are not checked against a revocation list), so the only thing that ever notices is something forcing a refresh, which is how it first surfaced — as `e2e/root-redirect.spec.ts`'s rotated-cookie test going red two files after the logout spec, pointing at the proxy rather than at the cause.

### Edge Functions

Fourteen functions, all registered in `supabase/config.toml` (a function not listed there won't deploy or serve):

| Function | Purpose |
| --- | --- |
| `create-user`, `deactivate-user`, `admin-reset-password` | admin user management via `auth.admin` + `profiles`, each writing `audit_log` |
| `submit-pre-app-secrets`, `read-pre-app-secrets` | encrypt/decrypt the three secrets tables |
| `create-upload-url`, `create-download-url` | mint short-lived signed URLs for the private `documents` Storage bucket after checking `documents.agent_id` or `is_admin()` |
| `delete-document` | removes a document's metadata row AND its storage object. Exists because the bucket is private with no storage policies, so the plain PostgREST delete it replaced could only ever reach the row — the file stayed in the bucket forever. Two modes: `document_id` for a real document (row first, then the object; the other order can leave a row whose bytes are gone), and `file_key` to clean up an object whose row was never written, which is the one non-atomic window in an upload |
| `residual-import-file-url` | admin-only; two modes — creates a `rep_payout_batches` row and signs an upload into `residual-imports`, or signs a download of a batch's stored file |
| `parse-residual-import` | admin-only; reads a batch's XLSX with SheetJS and stages its rows. **Idempotent** — it clears the batch's staging rows first, which is what makes "resolve an agent number, then read again" one code path rather than two |
| `export-residuals` | **not admin-only, deliberately.** Reads every row through the *caller-scoped* client, so RLS is the whole authorization story and a rep's export is their own book. Reaching for `supabaseAdmin` anywhere in it — even to join agent names — would silently turn that into the company's, which is the disclosure shape `search_crm` is `security invoker` to avoid. Paginates with `.range()`, because PostgREST's `max_rows` would otherwise export a silent prefix |
| `stage-user-import` | admin-only; parses a rep CSV into `user_import_rows`, creating the batch on the way. One function where residuals needs two, because the text arrives in the request body rather than via Storage. **Idempotent** — clears the batch's rows first, so "fix something, then read again" is one code path run twice. Two modes: `source_text` starts an import, `batch_id` re-reads the text already stored on the batch |
| `provision-user-batch` | admin-only; creates the accounts for a staged import, **a bounded chunk per call**. Calls the same `provisionUser` core as `create-user` and **discards the temporary password unread**. See the bulk-import section below for why the loop lives in the browser |
| `marketing-material-file-url` | the one function whose two modes have **different authorization**: an admin stocks the library (upload), every active user reads it (download). Copying `residual-import-file-url` wholesale would put `callerIsAdmin` on both branches and make the library invisible to the people it is for — with no policy failing, because the policy is correct and the function would simply be stricter than it. Creates the material row before signing, because the key is `{material_id}/{file_name}`. `download: true` asks Storage for `Content-Disposition: attachment`; without it the URL renders inline, which is what View and Print need |

### Two tables with no owner, and the one rule they share

`marketing_materials` and `products` are the only client-readable tables in the schema with **no `agent_id`**, and in both cases that is the design rather than an omission. They are company reference data: the select policy is `is_active_agent() or is_admin()` with nothing to compare an owner against, writes are `is_admin()`, and every active rep reads all of it. `is_active_agent()` is load-bearing on both and easy to misread as decoration — there is no ownership clause beside it, so it is the only thing stopping a let-go rep from reading the current rate cards and the current price list on a JWT that has not expired yet.

Both are **archived, never deleted** (`archived_at`), for the same structural reason: each exists to be referenced by an append-only child (`marketing_material_events`, `quote_line_items`), so a delete would either cascade that history away or be blocked by the FK forever. Neither has a DELETE policy or a DELETE grant.

**They differ on one thing worth knowing: `products` has no `profiles` reference and `marketing_materials` does.** A material has an upload lifecycle — `file_key` is nullable, an unfinished upload is a real state, and "which admin do I ask about this one" is a question the manage page answers — so `uploaded_by` earns its place. A product is a few fields an admin types and edits in place, so a `created_by` would record who first typed it and go stale the moment anybody repriced it, while costing a twenty-third column to clear before a user can be deleted. The saving is exactly the four teardown lists above.

### The marketing library

`marketing_materials` is the only client-readable table in the schema with **no `agent_id`**, and that is the whole design rather than an omission. It is company reference data: its select policy is `is_active_agent() or is_admin()` with nothing to compare an owner against, writes are `is_admin()`, and every active rep reads all of it. The consequence to hold onto is that **nothing published there is private**, which no policy can enforce — the admin UI says so on the upload form.

`marketing_material_events` carries the ownership instead, and its insert policy is where the `documents.file_key` lesson lands a second time. `lead_id` is client-supplied and nothing else in the policy reads it, so without the `exists` on `leads` a rep could write fabricated engagement history onto **another rep's lead** — not reading anything, but putting rows in front of the admin reviewing that deal. Proved by reverting that clause alone: exactly one test goes red.

**Materials are archived, never deleted**, and there is no DELETE in policy or in grant. A material exists to be referenced by the event log; deleting one would either cascade that log away or be blocked by the FK forever. `archived_at` drops it out of every rep's library while every event naming it stays readable. The events table is stricter still — no UPDATE or DELETE at all, unlike `notes` and `support_ticket_replies`, which both allow a delete — because it gets read back in front of a merchant disputing what they were told.

**Neither table gets `log_cross_agent_change()`, for two different reasons.** `marketing_materials` has no `agent_id`, so the trigger would read NULL and log every write (the `support_ticket_replies` trap). `marketing_material_events` **does** have one and the trigger would work — which makes it the more interesting omission: the table is already an audit trail, and a second one would record that an admin looked at something in a table whose entire content is a record of who looked at what. Admin action on the library is audited where it happens instead, in `marketing-material-file-url`.

**An inline signed URL renders on the STORAGE origin, so the type is allow-listed.** `marketing-material-file-url` signs inline only for `application/pdf`, `text/plain` and the three raster image types; everything else is forced to `attachment` whatever the caller asked for. `create-download-url` solves the same problem by always passing `download` — a document is never meant to be read in the tab — but this bucket cannot take that option, because rendering the collateral *is* the feature. An allow-list, not a block-list: the executable set is larger and far less stable than the passive one, and an unknown type downloading is a harmless surprise where an unknown type rendering is not. **`image/svg+xml` is deliberately absent** — an image everywhere else in a product and a script host in a browser, which is the exact trap an allow-list is for. This is also what closes the tabnabbing route the opened tab would otherwise leave: the component's `window.open` keeps a live `opener`, and this is why that is safe.

**"Email" sends nothing, deliberately, and says so on screen every time.** No proposal-email feature exists in this codebase — `proposal_sent` is a lead status, not an action, and nothing under `app/` or `supabase/functions/` sends mail. The button logs an `emailed` event and tells the rep plainly that nothing was sent, because an admin reading the history will otherwise see "Emailed" against the lead and believe it. **When the email phase lands, the send goes next to that log line** — do not build a second path.

**`window.open(..., "noopener")` returns NULL by spec**, which cost a bug here and will cost another somewhere else. View and Print open a tab synchronously before the await (a popup blocker would swallow a post-await open), then point it at the signed URL — but with `noopener` there is no handle to point, so every click fell through to the fallback and navigated the *current* tab while the blank one sat orphaned. Nothing failed and nothing was logged; the only symptom was the file opening in the wrong place. The opener link is cut by assignment instead. Only a browser finds this.

**All fourteen are `verify_jwt = false` in `config.toml`** — verified, every one of the fourteen `[functions.*]` blocks sets it. The platform therefore performs **no** auth check before your handler runs, so **each function is responsible for authenticating the caller itself**. `functions deploy` carries this setting up with the code, so it holds in production too.

Every one of them follows the same shape, and the order matters:

1. `withSupabase({ auth: "user" }, ...)` rejects a missing or invalid JWT before the handler body (this is what returns the `401`).
2. `callerIsActive(ctx.supabase)` — an `is_active_agent()` RPC through the **caller-scoped** client. A valid JWT does not mean the account is still enabled; a deactivated agent's token keeps working until it expires. Called via `ctx.supabaseAdmin` this would always be false, because a service-role connection has no `auth.uid()`.
3. Authorization through the caller-scoped client, so RLS makes the decision — `resolveParentAgentId()` looks the parent record up as the caller rather than re-implementing ownership by hand.
4. **Only then** `ctx.supabaseAdmin`, and only for the privileged step itself (minting the signed URL). It bypasses RLS, so nothing may reach it before authorization is settled.

Also: return `404`, not `403`, when a record isn't the caller's — "not yours" and "doesn't exist" must be indistinguishable or the endpoint becomes an id oracle. `tests/live/document-urls.test.ts` asserts every one of these branches against the running functions, and `tests/live/document-lifecycle.test.ts` asserts them for all four `owner_type` values rather than only `merchant`.

**RLS proving a row is the caller's does NOT prove the row is internally consistent, and `documents` is where that bit.** The metadata row is written by the *browser* — `create-upload-url` signs a key and the client inserts the row — so `owner_type`, `owner_id` and `file_key` are all client-supplied and the insert policy only ever looked at `agent_id`. Inserting a row with your own `agent_id` and *another agent's* `file_key` therefore got that agent's object signed for you with the service role: reproduced against the running stack, HTTP 200, someone else's bytes. Closed in two places, both needed — `documents_file_key_matches_owner` (a `CHECK`, `NOT VALID` so pre-existing hand-rolled fixture keys don't break `db push`; safe because `documents` has no UPDATE policy *or* grant, so nothing can be edited into violating it) and `fileKeyMatchesOwner()` in `create-download-url` and `delete-document`, which re-derives the key and refuses to sign or delete a mismatch, covering the rows `NOT VALID` exempts. In `delete-document` that check matters more than in the download path: there a forged key *leaked* a file, here it would have destroyed one. The general lesson: any column the client supplies and no policy reads is unvalidated, and the fix belongs at the layer that cannot be skipped.

Runtime is Deno 2 with per-function `deno.json` import maps; `.vscode/settings.json` enables the Deno language server only for `supabase/functions`, so the rest of the repo stays on the Node TS server.

**The residual parser exists ONCE, and that is the opposite arrangement to the secrets validators below — worth knowing before you "match the pattern".** `supabase/functions/_shared/residuals.ts` holds every parsing rule (header matching, period normalisation, number coercion, blocker precedence) and is deliberately dependency-free, so it needs no import map — and, usefully, Node can therefore import it: `tests/unit/residuals-parse.test.ts` exercises all of it under vitest with no Deno, no Docker and no running stack. Because parsing happens only server-side, there is no browser twin to drift from. **Do not create one.** (A file reached by an import is still type-checked even though `tsconfig` excludes `supabase` from its roots, so `npx tsc --noEmit` covers this module through that test.)

**The secrets validators exist twice, on purpose, and TypeScript cannot see the pair.** `lib/pre-app-validation.ts` (zod, browser) and `supabase/functions/_shared/pre-app-secrets.ts` (hand-written, dependency-free) both implement `isSsn` / `isRouting` / `isAccount` / the `rp_password` cap. (`isRouting` enforced a 3-7-1 mod-10 checksum on both sides until 25 Sep 2026; it was dropped deliberately — nine digits is now the whole rule. Each file carries a note explaining why and what to restore if that is ever reversed.) Genuinely sharing one file would need each `deno.json` to map a specifier reaching *above* `supabase/functions/` **and** `functions deploy` to bundle from there — not worth betting a deploy on, and `_shared/documents.ts` already answered this question the same way. The risk is real and one-directional in effect: change the checksum on one side only and the function starts rejecting values the UI accepts, producing a `400` the rep cannot explain. Nothing type-checks the pair, so **it is pinned by behaviour instead** — `tests/live/pre-app-secrets.test.ts` POSTs every value the client validator rejects and asserts `400`, plus a valid round-trip asserting success. Change both files together, and keep the cross-reference comments in each. (`tests/rls/validation-copy.test.ts`, which SPEC §10 lists, was deliberately **not** built: there is no second file to diff.)

Storage: **three** private buckets, `documents`, `residual-imports` and `marketing`, all created out-of-band — neither is in any migration, so a freshly started local stack has neither and every signing call 404s until they exist — **and `npx supabase db reset` drops them both too**, which is the version of this that actually bites, because you reset to test a migration and document upload starts 404ing for a reason nothing connects to what you just did (measured 14 Sep 2026: `listBuckets()` returns empty straight after a reset). `tests/live/helpers/stack.ts` creates ALL THREE as part of provisioning, so `npm run test:live` restores them; `e2e/fixtures/seed.ts` creates `documents` and `marketing` only, so a passing e2e run still leaves residual imports broken. `residual-imports` holds the raw XLSX behind every `rep_payout_batches` row under the key `{batch_id}/{file_name}`, reachable only through `residual-import-file-url`; it needed its own bucket because the `documents` path resolves a **parent record's** `agent_id` and a residual report has no owning rep — it spans every rep in the file. The `documents` table stores metadata only (`owner_type` + `owner_id` polymorphic pointer, `doc_type`, `file_key`); bytes are in the bucket and are only reachable through the two signed-URL functions. The object key is `{agent_id}/{owner_type}/{owner_id}/{uuid}`, where `agent_id` is the **parent record's** owner rather than the uploader — so an admin uploading for a rep files it under that rep, and the rep can see it. That key shape is now load-bearing rather than merely tidy: it is what `documents_file_key_matches_owner` and `fileKeyMatchesOwner()` check against.

**`[storage] file_size_limit` in `config.toml` does NOT limit an upload.** Measured on the local stack with it set to `50MiB`: a 120 MiB PUT through `uploadToSignedUrl` was accepted, and so was a 120 MiB service-role upload, and `listBuckets()` reported `file_size_limit = null` on **both** private buckets. So there was no ceiling at any layer — one rep with a video file could fill the project's storage quota, and the UI sat on "Uploading…" with no progress and no error. The real ceiling is the **per-bucket** limit, set at `MAX_DOCUMENT_BYTES` (50 MiB, `lib/documents.ts`) by `tests/live/helpers/stack.ts`, `e2e/fixtures/seed.ts` and `seed-dev-local.mjs` — re-asserted on every run, because a bucket created before the limit existed keeps accepting unbounded uploads and says nothing about it. **The hosted buckets still need it set out-of-band** (dashboard or `storage.updateBucket`); no migration can carry it. `documentUploadProblem()` refuses an over-size or zero-byte file in the browser, which is what produces a readable message instead of a 413 — a courtesy, not the boundary.

**A signed URL carries the *function's* `SUPABASE_URL` as its origin, which is not always the one the browser can reach.** On the local stack it is the container-internal `http://kong:8000`, so `create-download-url`'s links were unresolvable from the browser and the download button silently did nothing in development — navigating to a host that does not resolve is not an error the page can catch. `reachableStorageUrl()` in `lib/documents.ts` re-points the origin at `NEXT_PUBLIC_SUPABASE_URL`, leaving the path and `token` (the signature, which is not host-bound) untouched; a no-op in production. The upload side never had this problem because `uploadToSignedUrl(path, token, file)` builds its URL from the client's own config. The live suite's `toReachableUrl()` has always done the same rewrite to fetch a signed URL from Node — which was the standing clue that the browser needed it too.

`notes` and `tasks` use the same polymorphic `owner_type` + `owner_id` shape (`lead` | `pre_app` | `merchant` | `ghost_sheet`) — there is no FK, so validate `owner_id` in application code. Concretely: the panels take `ownerType`/`ownerId` as props from a page that already loaded that parent row under RLS, never from a searchParam. Two consequences of the missing FK that no policy covers — the policies check only `agent_id` — are that a row can be filed against an owner the writer cannot see, and that deleting an owner orphans its notes and tasks. **`owner_type` must be in every query**: ids collide across types (lead 7 and merchant 7 both exist) and both rows can legitimately belong to the caller, so dropping it mixes one record's notes into another's page and RLS will not object. `notes` is the one Tier 1 table with **no update policy** — append-only by design, so never offer an edit affordance. As of `20260812143407` the UPDATE grant is revoked too, so an attempt now fails loudly (`permission denied`) instead of being filtered to zero rows and reporting a save that did nothing. Deletes on `support_tickets`, `notes` and `tasks` are admin-only, as of `20260810171500`.

`documents.owner_type` is the same shape but a **different set** — `pre_app` | `merchant` | `support_ticket` | `lead`, with no `ghost_sheet` and, unlike notes and tasks, *with* `support_ticket`. Which is why the support ticket page carries a documents panel while deliberately carrying no notes or tasks panel: the check constraints differ, and so does the reasoning. An admin's note on a rep's ticket would be invisible to that rep (notes are scoped own-or-admin), whereas an admin's *document* is filed under the parent record's agent and therefore lands in the rep's own book.

### Quotes are append-only on EDIT, which is a different thing from `notes`

A quote is never updated in place. Each edit **inserts a new row** sharing the previous one's `quote_group_id` with `version + 1`, and the old row stays exactly as it was. `notes` is append-only because a note is a record of what somebody said; a quote is append-only because it is a record of **what a merchant was shown**, and "we never quoted that" is an argument a CRM should be able to settle.

**The current version is the highest `version` in the group.** There is no `is_current` flag, no partial unique index, and so no window where two rows both claim to be current. What the database enforces is that the rule is *well-defined*: `unique (quote_group_id, version)` means a group can never hold two rows at the same version. The rule itself lives in `currentVersion()` in `lib/quotes.ts` and nowhere else — spelling `Math.max` inline at two call sites is how a list page and a detail page come to disagree about which version a merchant was sent.

**A group id, not a self-reference to v1.** A parent pointer makes "every version of this quote" a recursive CTE and makes the chain breakable in the middle; a flat group id makes it `where quote_group_id = $1 order by version`. Same reasoning that keeps `profiles.manager_id` one hop deep.

**`status` is the one mutable column, and WHICH column is enforced by the GRANT rather than by a policy.** `grant update (status) on quotes to authenticated` is column-level, so an attempt on `title`, `version`, `lead_id` or `agent_id` fails with `permission denied for column` — loudly, before RLS is consulted. This is the `20260812143407` lesson applied one column at a time: a write the grant refuses is an error a rep can act on, where a write RLS filters is a save that silently did nothing. **RLS cannot express this** — it decides which *rows* an UPDATE may touch, never which columns — so if you are reaching for a policy to make a column immutable, the answer is a grant. `quote_line_items` is stricter still: no UPDATE or DELETE at either layer, because changing a line is the edit that is supposed to produce a new version.

Note what this means for a grants test: `has_table_privilege(…, 'UPDATE')` returns **false** when the privilege is held only on a column, so a column grant is invisible to the table-level check rather than indistinguishable from a table-level one. `tests/rls/grants.test.ts` asserts both — the table shape *and* a per-column loop — because each catches a different widening.

**`quote_line_items` snapshots `unit_price`, `product_name` and `product_sku`, and the snapshot is taken SERVER-SIDE.** Catalog prices change after a quote is sent; re-deriving a total from today's list price would silently restate what a merchant was offered last month, and the restatement would look exactly like the original. The browser sends `product_id` and `quantity` and nothing else that reaches a column — a client-supplied `unit_price` would be the `documents.file_key` shape one more time, a figure no policy reads on a document handed to a merchant.

**`create_quote_version()` is `security invoker`, like `convert_ghost_sheet_to_lead`, and exists for atomicity rather than privilege.** supabase-js has no client-side transaction, so the alternative is "insert the quote, then insert its lines" — two round trips with a real window, and a failure there leaves a **$0.00 quote against a lead, indistinguishable from one a rep meant to send**. `marketing_materials` tolerates the equivalent window because a row with no file is recognisable as unfinished and re-uploadable; an empty quote is neither. It refuses three things by name rather than by one count, because the causes need three different actions: a product not in the catalog, a product with **no list price** (null means "not priced yet", never zero — coalescing it to 0.00 would put a free terminal on the document), and a quantity below 1.

**`enforce_quote_version()` is `security definer`, and both of its jobs are the reason.** It assigns the version number — rather than validating a client's, so two tabs that both read "the latest is v2" cannot race into a constraint violation on an ordinary second edit — and it refuses an insert into **another rep's** quote group. That second check *cannot* be a policy: an `exists` subquery in the insert policy is itself filtered by the select policy, so a foreign group reads as an **absent** group and the forged row is admitted as a brand-new quote at version 1. It has to see past RLS to mean anything.

**The audit trigger is on `quotes` and deliberately not on `quote_line_items`.** `quotes` carries `agent_id` and the ordinary writer is the owning rep, so `log_cross_agent_change()` is quiet by default and speaks only when an admin acts on somebody else's deal — this is *not* the `rep_payout_rows` case, where no rep can write at all and the trigger would fire on every row of a forty-row import. The child table is excluded twice over: it has no `agent_id` (the `support_ticket_replies` trap), and even a working sibling function would write N+1 rows for one admin edit, N of them naming a table nobody looks up by id. The `documents` hole does not apply either — there is no UPDATE or DELETE on line items to go unrecorded.

**The catalog is loaded by a SCRIPT, and the staging-table pipeline this file once deferred is now cancelled rather than pending.** `data/hardware-catalog.csv` is the real lineup — 43 rows, 25 devices and 18 add-ons across five brands — and `scripts/load-hardware-catalog.mjs` loads it into `products` and `product_compatibility`. A column-mapping and blocker pipeline of the `rep_payout_import_rows` / `user_import_rows` kind exists so a non-engineer can load a file nobody has seen before, repeatedly, and inspect the damage before committing. This file is 43 curated rows in version control that change a few times a year, and an admin maintains them on `/admin/products` afterwards — so the review screen is the script's **dry run** (the default; `--write` is opt-in), the staging table is the CSV's git history, and there is nothing to build. Don't build it later either: the thing that would justify it is an unseen file, and this one is in the repo.

Five things the script decides that are worth knowing before changing it:

- **Any validation problem stops the whole load**, with no skippable/blocking split. That split is right for the rep import because two hundred accounts are two hundred independent things; a catalog is one document, and loading forty-two of forty-three rows leaves a half-stocked store that looks complete. `tests/unit/hardware-catalog.test.ts` is where every rule lives, and it validates the **shipped file** as well as fixtures — a validator green on synthetic input while the real catalog is broken is the failure that would otherwise go unnoticed.
- **A blank `retail_price` stays NULL, never 0.00** — `list_price` is nullable precisely so "not priced yet" survives as a different fact from "free", `create_quote_version()` refuses the null outright, and `Number("")` is 0. One row ships unpriced today (`greta-bs1560-ns`) and `valor-virtual-terminal` ships at a real $0.00, so both sides are live cases rather than hypotheticals. No migration is needed for this: the column was nullable from `20261002193000`.
- **`active=no` is `archived_at`, and the `review` note goes into `specs`.** The CSV's `review` column is the only place that says *why* a row is parked, and an archived product on `/admin/products` with no stated reason is one an admin un-archives at the price nobody confirmed. `specs` owns exactly `connectivity` and `review`; every other key an admin adds there survives a re-run, because that column exists to be extended without a migration.
- **It never deletes.** Not a product (`products` has no DELETE policy *or* grant, because `quote_line_items` snapshots what a product said), and not a compatibility link (an admin adding one on `/admin/products` is the expected workflow). A row or link the CSV no longer names is **reported and left**. A re-run does, however, RESET a product an admin edited back to what the file says — which is what the field-by-field dry run is for.
- **`splitCsvRows()` is a verbatim copy of `parseDelimitedText()`** from `supabase/functions/_shared/user-imports.ts`, because a `.mjs` script run by plain `node` cannot import a TypeScript module under `supabase/`. Pinned by behaviour, the `isBlocking()` arrangement: the unit test imports both and asserts they agree, including on the two cases this catalog contains — a comma inside a quoted field, and the doubled quote standing for the inches mark in `Square KDS 15.6" touchscreen`.

**Targets are `local` and `dev`, and there is no prod path in the file at all.** The client is built from the thing that was *checked*: `--target dev` spawns `scripts/check-linked-project.mjs` and then derives the URL from the same `supabase/.temp/linked-project.json` the guard read, so the `npm run db:push -- --db-url <prod>` shape — guard prints "dev, ok" while the command underneath goes elsewhere — is unreachable. It refuses the prod ref outright and does not honour `ALLOW_PROD_SUPABASE`. The guard also runs before a **local** write, because a relink is global CLI state and "I was only working locally" is the belief the 2 Sep incident was held under. The dev service-role key comes from the logged-in CLI (`projects api-keys --reveal`) or `$SUPABASE_SERVICE_ROLE_KEY`, is never printed and never written to a file — `.env.deployed.local` stays publishable-keys-only.

### A proposal belongs to a lead OR a merchant, and a rep cannot price one

As of `20261007150000`, `quotes` carries **both** `lead_id` and `merchant_id`,
both nullable, with `quotes_exactly_one_owner`
(`check (num_nonnulls(lead_id, merchant_id) = 1)`). A rep quotes hardware to
win a deal, and quotes more to the same business two years later when it is a
merchant on the books — one table, one append-only version history, one
printable document.

**Two real foreign keys, NOT the polymorphic `owner_type` + `owner_id`** that
`notes`, `tasks` and `documents` use. Those three point at four tables and
carry no FK at all, which costs them three documented problems (a row filed
against an invisible owner, orphans on delete, `owner_type` required in every
query or ids collide). With two targets, one extra column buys all three back.

**The constraint is ORDINARY, not `NOT VALID`,** and that is a decision rather
than a default. `NOT VALID` is for a constraint added over data that predates
it — `documents_file_key_matches_owner` and `merchants_split_totals_100` both
carry it. Here the rows can be *proven* clean: `lead_id` was `not null` until
that migration and `merchant_id` was added by it, so `num_nonnulls` is exactly
1 for every pre-existing row by construction. Reaching for `NOT VALID` anyway
gives up the guarantee for nothing, and silently — it looks identical in the
schema. A test asserts `convalidated`.

**THE PRICE LOCK is `snapshot_quote_line_item()`, a BEFORE INSERT trigger, and
the hole it closes was real.** `grant select, insert on quote_line_items to
authenticated` plus an insert policy that only asks whether the parent quote is
the caller's means **a rep's own session can POST a line item with any
`unit_price` it likes, on their own quote, and every policy agrees.** The three
more obvious answers each fail for a specific reason worth knowing:

- **Hiding the field in the UI** is not a boundary at all.
- **A column-level grant** (`grant insert (quote_id, product_id, quantity,
  sort_order)`) is the right instinct — it is exactly what makes
  `quotes.status` the only mutable column, and the standing rule is that an
  immutable column is a grant and not a policy. It fails *here* because
  `create_quote_version()` is `security INVOKER`, so it inserts as the caller
  and would be refused its own snapshot. Making it `definer` to work around
  that trades a narrow problem for the broad one invoker exists to avoid.
- **Revoking INSERT outright** fails identically.

So the trigger **overwrites** all five snapshot columns from `products`,
whatever the caller supplied — it sits below every path to the table.
Overwrite rather than raise, because nothing legitimate ever supplies a price:
`unit_price` is a **derived** column that merely cannot be `generated always
as`, since that cannot reach another table. It is `security definer`, and
**not for reach** (every active user already reads every product) — it is
definer so the figure on a document cannot be changed by changing a *policy*.
Contrast `enforce_compatibility_kinds()`, which is invoker precisely because it
has no such claim to make. The RPC also snapshots, independently: two layers
reading the same table in the same transaction, the
`documents_file_key_matches_owner` / `fileKeyMatchesOwner()` arrangement again.

`enforce_quote_version()` now also **pins who a group is about**, which a CHECK
cannot express (it is a fact about a row's siblings). Reachable without it: the
RPC takes a group id and an owner as separate arguments, so a rep passing their
own group id with a different — also their own — record would add a "version 2"
about another business. Nothing leaks, but the print route filters by owner, so
one page would read "version 2 of 1" and the other "version 1 of 1".

**`create_quote_version()`'s 7-argument signature is DROPPED, not left beside
the new one.** `create or replace function` with a different parameter count
creates a *second* function, so a default on `merchant_id_input` would leave a
7-argument call with two candidates — an ambiguity Postgres reports at call
time, from the browser, as a failed save. The `dashboard_counts()` trap, same
answer, same assertion that the name resolves exactly once.

### The store, and what hides an archived product

`products` gained `brand`, `kind` (`device` | `addon`) and `billing`
(`one_time` | `monthly`), plus `product_compatibility (addon_product_id,
device_product_id)` — the **third** client-readable table with no `agent_id`,
which it inherits from its parents rather than choosing: a fact about two
catalog rows cannot be owned by a rep. The checklist therefore applies with
step 1 struck out, and **step 4's sequence grant refers to nothing** — the
pair is the primary key, so there is no `_id_seq`. A test asserts that absence,
so a future surrogate key cannot arrive without the missing grant being noticed.

`brand` is free text like `category`; `kind` and `billing` are **closed
vocabularies**, and the difference is who reads them. Those are labels a person
reads; these are read by *code* — the compatibility trigger, the store's device
list, the proposal's two totals — so an invented value is not a new label but a
row all three silently skip. **The store's "device type" filter is `category`**;
a second column for it would be the same fact twice.

`product_compatibility` **allows DELETE where `products` withholds it**, and
that is the one deliberate difference: a product is archived because
`quote_line_items` snapshots what it said, so the row is history, while a
compatibility row is a current-state claim nothing snapshots.

**WHAT HIDES AN ARCHIVED PRODUCT FROM A REP IS THE QUERY, NOT RLS.** The select
policy stays `is_active_agent() or is_admin()` with no row filter;
`lib/quotes-data.ts` carries `.is("archived_at", null)` plus `isQuotable`.
Three reasons: an admin must still see everything on `/admin/products` (a
policy would need a role branch, which is two policies wearing one name);
archiving is a **lifecycle state, not an access boundary** — `profiles.territory`'s
lesson, where wiring a label into a policy means changing the label changes who
can see what; and **a quote outlives the product on it**, so a policy hiding
archived rows would make a future join from a historical line come back empty
while looking perfectly correct. `tests/rls/product-compatibility.test.ts`
asserts a rep can still *read* an archived row, and greps both tables' policies
for the word. The database still refuses one twice over, by name in the RPC and
again in the trigger — a hidden row is a courtesy, a refused write is the
boundary.

**The cart's ORDER is the saved proposal's structure.** `cartToPayload()` emits
device, then that device's add-ons, then the next device;
`create_quote_version()` writes `sort_order` from the array's order; and
`groupQuoteLines()` reads the grouping back off `(sort_order, product_kind)`
and nothing else. Deliberately **not** a live join against
`product_compatibility` — that would make a sent proposal re-group itself when
an admin unlinks an accessory, a document changing shape after it was handed
over. `quote_line_items` snapshots `product_kind` and `product_billing` for
exactly that, and **neither carries a CHECK**: these are a record of what was
true when the quote was sent, so a value retired from the catalog's vocabulary
is correct history, and a constraint would turn that migration into one that
has to rewrite documents.

**`components/quote-store.tsx` is deliberately NOT on `ListTable`,** the app's
responsive list pattern. `ListTable` renders both layouts and hides one, and
its own header records the cost: a locator that does not consult the
accessibility tree matches the hidden copy too, and converting the payouts
ledger reddened nine `getByLabel` specs. The store is almost entirely form
controls, so it follows the same discipline with **one** rendered copy —
`flex-col sm:flex-row`, `min-w-0` on every text child, nothing in a scrolling
container. `e2e/quote-store.spec.ts` asserts `scrollWidth <= clientWidth` at
375/768/1440 rather than trusting the classes.

**Two totals, never summed** — one-time and monthly, on screen and on paper.
$1,497 of terminals and $29 a month are not the same unit, so a combined figure
is a number that means nothing and reads as a price. `isMonthlyBilling()` tests
*for* `'monthly'` rather than against `'one_time'`, so an unrecognised value
lands in the one-time total: a figure wrongly counted once is an understatement
a rep can see, while one wrongly counted as recurring quietly multiplies by
twelve.

### The printed Hardware Proposal is ONE component on two routes

`/leads/[id]/quotes/[quoteGroupId]/print` and
`/merchants/[id]/quotes/[quoteGroupId]/print` both render
`QuoteProposalDocument`, fed by `loadProposal()` in `lib/quote-proposal.ts` —
so each route is about ten lines. The loader flattens the two owner tables
into one shape (a lead has `dba` / `merchant_legal_name` and three contact
columns; a merchant has `dba` / `legal_business_name` and **no contact columns
at all**), which means the document has one set of fields and cannot quietly
omit one on one route. This is a sheet somebody is handed, so two near-copies
is the worst place in the app for a wording drift. **That makes five printable
routes but four documents** — the counts in `print-document.tsx` and
`globals.css` say so.

**Nothing is invented on it.** `PROPOSAL_TERMS` is one constant and is **empty
by default**, so no terms block renders at all — not an empty heading, not
placeholder wording. Nothing in this repo knows Tapswipe's hardware terms, and
a wrong price is obvious where wrong terms are not. "Prepared by" prints only
what `profiles` actually has (`full_name`, `email`, `agent_number`) — there is
no phone column, so no phone is printed; and a merchant's contact line is
omitted rather than filled from its originating pre-app, because a contact
pulled from a two-year-old application is worse than none since it looks
current. The preparer is the **quote's own** `agent_id`, so an admin printing a
rep's proposal prints the rep's name.

**404 on everything, never 403** — and it matters more on the merchant route:
merchant ids are sequential and a rep knows their own, so "does merchant 41
exist" is exactly the question a distinguishable response would answer. Note
the e2e assertions are on the **rendered** not-found copy, not the status code:
under `cacheComponents` the static shell is flushed before the Suspense
boundary streams, so `notFound()` lands as **200** with not-found content in
the body. That is existing behaviour of every record page here, written up in
`e2e/print.spec.ts`.

### The dashboard's filters narrow a view the caller already had in full

`dashboard_counts()` takes six optional parameters as of `20261007120000` — rep
(`agent_id`), manager (via `profiles.manager_id`), territory, lead stage, and a
`created_at` range — and **stays security invoker**. That is the whole design,
not a property it happens to retain.

Every parameter is an extra `WHERE` clause **ANDed on top of** the caller's own
policies, never a substitute for one. An agent who passes another rep's
`agent_id` gets `agent_id = other` and the policy's `agent_id = auth.uid()`,
which is unsatisfiable — so the answer is zero, and that is a consequence of the
function not bypassing anything rather than a check it performs. The manager and
territory filters resolve *through* `profiles`, and that subselect is RLS-scoped
too (own-row plus admin), so for an agent it can only ever return their own row:
**the same call gives an admin the whole team and a rep only themselves.**
`tests/rls/dashboard-filters.test.ts` asserts both halves, and asserts
`prosecdef` is false — flip that and every scoping assertion in the file
silently becomes an assertion about nothing.

**It is not an access change.** No policy is touched, and none reads
`manager_id` or `territory` — both stay the reporting labels their column
comments describe. A manager gains no wider book by being nameable here; what
this adds is filtering **for an admin who already sees every row**, which is the
exact use `profiles.manager_id`'s own comment anticipates. The test greps
`pg_policies` for both words, the same way `set-manager` and `set-territory` do.

Three decisions worth knowing before changing any of it:

- **The zero-argument function is DROPPED, not replaced.** Left beside the new
  one it would give a bare `dashboard_counts()` two candidates, since every new
  parameter has a default — an ambiguity Postgres reports at call time, from the
  browser, not in the migration. A test asserts the name resolves exactly once.
- **A stage filter gets its own output column, `leads_at_stage`**, rather than
  narrowing `active_leads`. That column means "a lead no pre-app points at yet",
  a funnel position the records prove; a stage is something a rep types. Folded
  together, one output would mean two things depending on a parameter — and
  would read as near-zero for `application_sent`, whose leads are precisely the
  ones a pre-app points at, while looking entirely healthy. It is **null** when
  no stage was asked for, which is a different fact from zero and renders as a
  different thing (no card at all).
- **The upper date bound is `< to + 1`, not `<= to`.** `created_at` is a
  timestamptz, so `<=` compares against midnight and drops everything created on
  the last day of the range the person believes they asked for — a plausible set
  of smaller numbers with nothing to say it is wrong.

The filter bar (`components/dashboard-filters.tsx`) is a **server component with
no client JavaScript**: stage is a `FilterTabs` row whose chips carry the other
five filters (the job `leadsHref` does for the leads list's pair), and
rep/manager/territory/dates are a plain GET form with an Apply button. A rep
list is unbounded, so those four could not be chips; a form keeps them linkable
and working with JS off rather than introducing a second interaction model. The
three people controls are **admin-only in the UI** — not because a rep sending
`?rep=…` would learn anything, but because for a rep every setting of them is
their own numbers again or a blank page, and a control whose every option is a
no-op is a broken control.

**The "Your tasks" digest takes no part in any of it**, and that is structural
rather than a promise: `DashboardTasks` reads `profile.id` and never
`searchParams`, and sits in its own `<Suspense>` boundary *outside*
`DashboardOverview`. The page says so in a line under the heading, because the
filter bar sits directly above it and an admin who has just narrowed the
overview to one rep would otherwise read that list as that rep's.
`e2e/dashboard-filters.spec.ts` pins it by choosing a date range that empties
every figure above and showing the digest did not move.

**The e2e specs assert no hardcoded counts.** Numbers in the dev database move —
the live suite writes to the same stack — so each filter is checked by
*cross-reading*: an admin filtering by one rep must see exactly what that rep
sees on their own dashboard, which the suite can load because it holds a storage
state for them. That is both robust and a sharper claim than a constant: it says
the filter selected the same rows the policy would.

### Follow-ups live in two places, and they are reconciled in the UI rather than in the schema

`leads.next_followup_date` and the generic `tasks` table both answer "when is
the next thing to do on this lead", and they stay **separate columns on
purpose**. Three things decided it, and all three are reasons not to "fix" the
duplication later:

- **`tasks.owner_id` carries no foreign key** — it points into four tables — and
  PostgREST needs one to embed. So a lead cannot cheaply pull its own tasks.
- **The leads list would lose its single indexed query.** Today "order by next
  follow-up, show overdue" is one scan of one table. Derived from `tasks` it is
  N+1 or a new view/RPC, and the "Unscheduled" filter becomes a `NOT EXISTS`
  with no FK for the planner to use.
- **A sync trigger was considered and rejected.** Writing the lead from a task
  would fire the lead's own `log_cross_agent_change()`, so an admin adding a
  task on a rep's lead would produce **two audit rows for one event** — noise
  bought for a convenience.

The accepted cost is real and is written down rather than hidden: a rep can
leave `next_followup_date` blank while a task is due tomorrow, and the leads
list files that lead under "Unscheduled". The mitigation is two UI surfaces,
neither of which stores anything new — nothing is duplicated, so nothing can
drift silently afterwards:

- `components/followup-reconcile.tsx` on the lead detail page, which surfaces
  the earliest open task's date beside the lead's own and offers one click that
  writes `leads.next_followup_date`. It renders **nothing** when there is no
  dated open task; a permanent banner on every lead is how a prompt becomes
  wallpaper.
- The **"Your tasks" digest** on `/dashboard`, which is the login-surfaced half:
  what is late, and what is due inside `nextWeekBound()` — literally the leads
  list's own "Next 7 days", so a rep working a day sees one horizon rather than
  two.

`earliestOpenTaskDue()` in `lib/annotations.ts` is the one definition of "the
earliest open task", for the reason `currentVersion()` is the one definition of
a quote's current version: spelled inline, the surface that *shows* the date and
the control that *writes* it come to disagree about which task they mean. It
skips completed tasks — a bare `Math.min` over the panel's rows offers the date
of work already done, which is the fixture's `done` row and the trap it exists
for.

**The digest narrows by `agent_id` in application code, and that is not the rule
this repo otherwise follows.** `TaskIndexScope` in `lib/annotations-data.ts` is
the distinction: the standing "don't copy a policy into application code" rule
is about a query that means *everything I may see*; this means *a subset of it,
chosen by the page*. RLS hands an admin every task in the database and is right
to — `/tasks` shows them all — but an admin's own landing page listing the whole
company's work is not a digest. A company-wide view is a different feature with
a different shape. Because no policy expresses this, **no RLS test can see it**:
`e2e/followups.spec.ts` is the only place that promise is checked, and it checks
both halves (the admin's dashboard omits the rep's task; `/tasks` still shows it
to them), so a broken read cannot pass as correct scoping.

### The lead timeline merges six sources and widens none of them

`components/lead-timeline.tsx` on the lead detail page is one chronological
feed over notes, tasks, documents, quote versions, marketing events and the
audit trail. **It is a re-projection, not a sixth set of reads**: the page
already loads five of those for its panels, so `lib/timeline.ts` is **pure** —
it takes rows and returns entries, which is what lets
`tests/unit/timeline.test.ts` import it with no database. `lib/timeline-data.ts`
holds the only genuinely new query. Extending `loadAnnotations()` instead would
have pushed a lead-only concern into a function four detail pages share, and a
`loadLeadTimeline()` doing its own six reads would have doubled every one of
them on the page's hot path.

**`audit_log` is admin-only with NO own-row branch, and that is the whole
scoping story.** Its single policy is `for select using (is_admin())`, so an
**agent reads zero audit rows — on their own lead as much as anyone else's** —
while `grant select on audit_log to authenticated` means the query *succeeds*
and returns nothing. A rep's feed therefore simply has no audit entries, and
the page says **nothing** about the gap: a permanent notice would be wallpaper
on every lead (the thing `followup-reconcile.tsx` renders nothing to avoid),
and a conditional one would announce that an admin had touched the record,
which is exactly what the policy conceals. No definer RPC and no service-role
client anywhere in the chain.

**The query still runs for a rep rather than being skipped on role**, and that
is deliberate: a role branch there is a copy of a policy in application code,
and if `audit_log` ever gains an own-row branch the feed should widen by itself
rather than keep showing nothing while nothing fails.

Four decisions worth knowing before changing any of it:

- **Two sources must NOT carry a byline.** `documents.agent_id` and
  `quotes.agent_id` are the **parent record's owner**, not whoever acted — the
  page passes `lead.agent_id` into `QuotesPanel`, and `create-upload-url` files
  under the lead's rep so the file lands in that rep's book. So an admin's
  upload on a rep's lead is stamped with the REP's id, and printing it would
  attribute the act to the wrong person. The real actor is in `audit_log` and
  is therefore admin-only, which makes **no byline the honest rendering**.
  Notes, tasks and marketing events do carry theirs (`profile.id` is what the
  panels write).
- **Audit rows are matched on the `(table_name, row_id)` PAIR**, in one query
  per table. `row_id` is `text` and lead 7, quote 7 and pre-app 7 all plausibly
  exist, so a combined `.in("table_name", …).in("row_id", …)` would file one
  under another — and no policy would object, because an admin may read both.
  `leads`, `quotes` and `pre_apps` are covered; **`documents` is deliberately
  not**, because its upload rows duplicate entries the feed already builds from
  the table while its DELETE row — the one genuinely new fact — names a row
  that no longer exists, so nothing available here can tie it to the lead.
- **The ordering is a TOTAL order**, because exact ties are routine rather than
  freak: `created_at` defaults to `now()`, frozen for a whole transaction, so a
  quote and the audit row its own trigger writes tie to the microsecond. Rules
  are instant (parsed, **not** string-compared — a different offset is not a
  later time), then source rank with the audit *trace* after the act, then id
  descending. Without the tie-break the feed reshuffles when an unrelated
  source gains a row, since `Array.sort` is stable only against its input.
- **A task is placed at its CREATION**, which is why `tasks.created_at` joined
  `TASK_LIST_COLUMNS`. A due date is a plan, and dating the entry by it puts
  next Tuesday's task above everything that has actually happened. Completion
  is absent entirely: there is no `completed_at`, so there is no instant to
  place it at. And **`emailed` gets its own wording** — nothing in this
  codebase sends mail, and a row reading "Emailed" in a list of things that
  happened is how an admin comes to believe a proposal went out.

`e2e/lead-timeline.spec.ts` is where the scoping is actually checked, because
no RLS test can: it loads **one** lead in two real sessions and cross-reads
them, asserting the rep's five rows are *identical* to the admin's five rather
than merely fewer. "The admin sees more" is also true of a feed showing the two
roles unrelated things.

### Next.js / auth wiring

- Three Supabase client factories, don't mix them up: `lib/supabase/client.ts` (browser), `lib/supabase/server.ts` (Server Components / Actions / Route Handlers, cookie-backed, `async`), `lib/supabase/proxy.ts` (request pipeline). Never hoist any of them into a module-level global — Fluid compute reuses processes across requests.
- `proxy.ts` at the repo root is Next 16's renamed middleware. It calls `updateSession()`, which refreshes the session cookie and redirects unauthenticated requests to `/auth/login` for everything except `/auth/*`. Do not insert code between `createServerClient()` and `supabase.auth.getClaims()` in that file, and return the `supabaseResponse` object unchanged — the comments there explain why (random logouts).
- **`/` renders nothing: it redirects, in two places, and both are load-bearing.** Signed in goes to `/dashboard`, signed out to `/auth/login`. `app/page.tsx` holds the rule, and `updateSession()` holds it again so the hop happens in the request pipeline. Under `cacheComponents` a page's static shell paints *before* its dynamic segment can stream a redirect, so the page on its own means a blank frame first — which is precisely how the starter's marketing page stayed visible to signed-in users. The page is not redundant: it is what stops `/` from 404ing or going blank if the proxy matcher is ever narrowed. Note the proxy's `/` branch copies `supabaseResponse`'s cookies onto the redirect; `getClaims()` may have rotated the session, and a bare `NextResponse.redirect()` drops the new pair and logs the user out at random. `updateSession()` also no longer bails out when the public env vars are unset — that starter hatch skipped the auth check entirely for a deploy missing a variable, and `lib/env-guard.ts` only throws in development.
- Auth pages live under `app/auth/*` with matching form components at the top level of `components/`; `app/auth/confirm/route.ts` handles email OTP verification.
- `next.config.ts` sets `cacheComponents: true`, so dynamic data fetching must sit inside a `<Suspense>` boundary (see `app/page.tsx`, or `ForcePasswordChangeGate` in `app/(app)/layout.tsx`, for the shape).
- Env vars (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`) live in **two** gitignored files, and the split matters: `.env.local` holds the **hosted** project and is what `next build` and production use; `.env.development.local` holds the **local stack** and wins in dev, because Next resolves `.env.development.local` ahead of `.env.local`. So `npm run dev` talks to the local stack with no flag to remember. Recreate it from `npx supabase status -o env` (`API_URL` + `PUBLISHABLE_KEY`) whenever the local ports change; `.env.example` documents the whole arrangement.
- **`lib/env-guard.ts` throws at dev-server boot if the Supabase URL isn't local.** This is not hypothetical: with only `.env.local` present, `npm run dev` pointed the app at production, and the symptoms were an admin-only column appearing for a rep and a list reading "no pre-apps yet" because the row was in the other database. Nothing announced it. The guard runs from `next.config.ts` (hard throw, server) and once per page load in `lib/supabase/client.ts` (warn, browser — a built bundle can't fix its own URL). Set `ALLOW_REMOTE_SUPABASE_IN_DEV=1` to develop against the hosted project deliberately.
- **Never show a `functions.invoke()` error's `.message` to a user.** supabase-js reports every non-2xx as a `FunctionsHttpError` whose message is the fixed string "Edge Function returned a non-2xx status code"; the function's own `{ error }` body sits unread on `error.context`. Use `invokeEdgeFunction()` / `edgeFunctionErrorMessage()` from `lib/edge-functions.ts`. Three call sites had each grown their own copy of that unwrapping before it was extracted, and the two document components had not — which is how the panel shipped reporting a deactivated account, a record that wasn't yours, and a real fault as one identical sentence.
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

Sidebar contents are data in `lib/nav.ts`, not JSX. An item without an `href` renders as a muted, `aria-disabled` row — the mechanism for listing a section before its page exists. **No item currently uses it**; Notes and Tasks did until `/notes` and `/tasks` were built, and a permanently-greyed row trains people to ignore that part of the nav, so prefer building the page or dropping the row over leaving one there. `usePathname()` supplies the active item, which under `cacheComponents` is runtime-only data: the client nav **must** sit inside a `<Suspense>` boundary, and its fallback therefore cannot call the hook either. That is why `components/sidebar-nav-list.tsx` takes `pathname` as a prop and is shared by both the streamed nav and its fallback.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
