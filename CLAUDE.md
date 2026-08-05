# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

Tapswipe's internal CRM (merchant services): Dashboard, Merchants, Pre-Apps, Leads, Ghost Sheets, Support Tickets, Document Center, My Submissions.

**Current state matters when reading the code**, and it is a mix — real CRM pages alongside untouched starter scaffolding:

- **Built:** `app/dashboard`, `app/merchants/*`, `app/leads/*`, `app/ghost-sheets/*`, `app/documents`, `app/admin/users`, with data-access helpers in `lib/{merchants,leads,ghost-sheets,documents,auth,format}.ts`.
- **Not built yet:** Pre-Apps, Support Tickets, My Submissions.
- **Still [starter-kit](https://github.com/vercel/next.js/tree/canary/examples/with-supabase) template, not product code:** `README.md`, `app/page.tsx`, `app/protected/*`, `components/tutorial/*`, and `components/{hero,deploy-button,next-logo,supabase-logo,env-var-warning}.tsx`.
- **Edge Functions:** `create-upload-url` and `create-download-url` are implemented (with shared helpers in `supabase/functions/_shared/documents.ts`). The other five are still `withSupabase` hello-world stubs — identical 36-line files that echo `Hello ${name}`.

**`docs/tapswipe_crm_schema.sql` is the authoritative spec** for the data model and access rules, not the migrations. Change the doc first, then make `supabase/migrations/` match it. Six migrations exist; `20260804201300_initial_schema.sql` is the first.

Stack: Next.js 16 (App Router, React 19), Supabase (Postgres + Auth + Storage + Deno Edge Functions), Tailwind 3 + shadcn/ui (new-york, `neutral` base), TypeScript strict. Linked Supabase project ref: `vdjtosofrimipklbdjbi`.

## Commands

```bash
npm run dev            # Next dev server on :3000
npm run build          # next build (also type-checks)
npm run lint           # eslint .
npx tsc --noEmit       # type-check only

npm test               # PGlite suite — hermetic, no Docker (117 tests)
npm run test:live      # local stack over HTTP — needs `supabase start` + `functions serve` (17 tests)
npm run test:deployed  # read-only assertions about the DEPLOYED project (4 tests)

npx supabase start                       # local stack (API :54321, DB :54322, Studio :54323, mail :54324)
npx supabase db reset                    # rebuild local DB from migrations/ (there is no seed.sql)
npx supabase migration new <name>        # new timestamped migration
npx supabase db push                     # apply migrations to the linked remote project
npx supabase functions serve             # serve all functions locally (hot reload)
npx supabase functions deploy <name>     # deploy one function
npx supabase secrets set KEY=value       # set Edge Function secrets (encryption key, etc.)
```

`npm run build`, `npm run lint` and `npx tsc --noEmit` all pass. If one fails, it's your change.

**Never run `npx supabase config push`.** It has no `--dry-run`, and `config.toml`'s `[auth]` block holds local-dev values, so pushing it would set the production Site URL to `http://127.0.0.1:3000`, replace the redirect allow-list, clamp `[auth.rate_limit].email_sent` to 2 auth emails per hour project-wide, and turn off email confirmations. `config.toml` governs the **local stack only** — deployed Auth settings are a separate surface, changed in the Dashboard or via a targeted Management API `PATCH .../config/auth` with only the field you mean.

### Tests — three suites, three different targets

| Suite | Target | Needs |
| --- | --- | --- |
| `npm test` | the migrations themselves | nothing (in-process Postgres) |
| `npm run test:live` | the local Supabase stack | Docker, `supabase start`, `functions serve` |
| `npm run test:deployed` | the hosted project in `.env.local` | network |

- **`npm test`** — vitest + `@electric-sql/pglite`, applying `supabase/migrations/` over a deliberately minimal auth shim (`tests/helpers/db.ts`: three Data API roles, `auth.users`, `auth.uid()` reading the `request.jwt.claims` GUC). Covers RLS policies (`tests/rls/*`) and the grant surface (`tests/rls/grants.test.ts`). **Run this for any schema change.** Queries must run as `authenticated`, not the owner — Postgres bypasses RLS for a table's owner, so an owner-run test passes regardless of policy.
- **`npm run test:live`** — real HTTP with real JWTs. Covers what PGlite structurally cannot: GoTrue password sign-in, PostgREST grants, the Deno runtime, Storage signed URLs. Hard-errors rather than skipping when the stack is down. Run it when touching Edge Functions, auth, or Storage.
- **`npm run test:deployed`** — read-only Auth-config assertions against production. A red result means the deployed project drifted, not that code broke. Uses only the publishable key.

Why three and not one: the PGlite suite was 100% green while two deployment-breaking bugs sat in the repo — no Data API grants at all, and an `[auth.email] enable_signup = false` that disabled password login. Neither is visible below PostgREST/GoTrue.

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

1. **Normal tables via `supabase-js`** (`merchants`, `leads`, `ghost_sheets`, `pre_apps` + children, `documents`, `support_tickets`, `notes`, `tasks`, `audit_log`). RLS does the enforcement; the client talks to Postgres directly.
2. **Secrets tables — Edge Function only.** `pre_app_owner_secrets` (SSN), `pre_app_banking_secrets` (ABA routing / account number), `pre_app_terminal_secrets` (RP password) are locked twice over: RLS enabled with **zero policies**, *and* no grant to `anon` or `authenticated` at all. Either alone denies read and write; both means a policy added by mistake still opens nothing. Values are stored as `bytea` AES ciphertext; only a service-role Edge Function holding the encryption key can touch them. This includes the agent's initial submission — the browser must POST that data to `submit-pre-app-secrets`, never insert it via `supabase-js`. Never add a policy to these tables, and never grant them.
3. **`approve_pre_app(pre_app_id_input int)` RPC** — `security definer` plpgsql that creates a `merchants` row from a pre-app, flips its status to `approved`, and writes `audit_log`. It guards itself with an explicit `is_admin()` check at the top; keep that check if you edit it.

`profiles` has no insert policy by design — rows are created by the `create-user` Edge Function using the service role, alongside `auth.users`.

### Edge Functions

Seven functions, all registered in `supabase/config.toml` (a function not listed there won't deploy or serve):

| Function | Purpose |
| --- | --- |
| `create-user`, `deactivate-user`, `admin-reset-password` | admin user management via `auth.admin` + `profiles` |
| `submit-pre-app-secrets`, `read-pre-app-secrets` | encrypt/decrypt the three secrets tables |
| `create-upload-url`, `create-download-url` | mint short-lived signed URLs for the private `documents` Storage bucket after checking `documents.agent_id` or `is_admin()` |

**All seven are `verify_jwt = false` in `config.toml`** — verified, every one of the seven `[functions.*]` blocks sets it. The platform therefore performs **no** auth check before your handler runs, so **each function is responsible for authenticating the caller itself**. `functions deploy` carries this setting up with the code, so it holds in production too.

The two implemented functions show the required shape, and the order matters:

1. `withSupabase({ auth: "user" }, ...)` rejects a missing or invalid JWT before the handler body (this is what returns the `401`).
2. `callerIsActive(ctx.supabase)` — an `is_active_agent()` RPC through the **caller-scoped** client. A valid JWT does not mean the account is still enabled; a deactivated agent's token keeps working until it expires. Called via `ctx.supabaseAdmin` this would always be false, because a service-role connection has no `auth.uid()`.
3. Authorization through the caller-scoped client, so RLS makes the decision — `resolveParentAgentId()` looks the parent record up as the caller rather than re-implementing ownership by hand.
4. **Only then** `ctx.supabaseAdmin`, and only for the privileged step itself (minting the signed URL). It bypasses RLS, so nothing may reach it before authorization is settled.

Also: return `404`, not `403`, when a record isn't the caller's — "not yours" and "doesn't exist" must be indistinguishable or the endpoint becomes an id oracle. `tests/live/document-urls.test.ts` asserts every one of these branches against the running functions.

Runtime is Deno 2 with per-function `deno.json` import maps; `.vscode/settings.json` enables the Deno language server only for `supabase/functions`, so the rest of the repo stays on the Node TS server.

Storage: one private bucket named `documents`, created out-of-band — it is not in any migration, so a freshly started local stack does not have it and every signing call 404s until it exists (`tests/live/helpers/stack.ts` creates it as part of provisioning). The `documents` table stores metadata only (`owner_type` + `owner_id` polymorphic pointer, `doc_type`, `file_key`); bytes are in the bucket and are only reachable through the two signed-URL functions. The object key is `{agent_id}/{owner_type}/{owner_id}/{uuid}`, where `agent_id` is the **parent record's** owner rather than the uploader — so an admin uploading for a rep files it under that rep.

`notes` and `tasks` use the same polymorphic `owner_type` + `owner_id` shape (`lead` | `pre_app` | `merchant` | `ghost_sheet`) — there is no FK, so validate `owner_id` in application code.

### Next.js / auth wiring

- Three Supabase client factories, don't mix them up: `lib/supabase/client.ts` (browser), `lib/supabase/server.ts` (Server Components / Actions / Route Handlers, cookie-backed, `async`), `lib/supabase/proxy.ts` (request pipeline). Never hoist any of them into a module-level global — Fluid compute reuses processes across requests.
- `proxy.ts` at the repo root is Next 16's renamed middleware. It calls `updateSession()`, which refreshes the session cookie and redirects unauthenticated requests to `/auth/login` for everything except `/` and `/auth/*`. Do not insert code between `createServerClient()` and `supabase.auth.getClaims()` in that file, and return the `supabaseResponse` object unchanged — the comments there explain why (random logouts).
- Auth pages live under `app/auth/*` with matching form components at the top level of `components/`; `app/auth/confirm/route.ts` handles email OTP verification.
- `next.config.ts` sets `cacheComponents: true`, so dynamic data fetching must sit inside a `<Suspense>` boundary (see `app/protected/page.tsx` for the shape).
- Env vars (`.env.local`, mirrored in `.env.example`): `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. The publishable/anon key is the only key the Next app should ever hold — the service-role key belongs in Edge Function secrets only. `lib/utils.ts` exports `hasEnvVars`, a starter-only guard that several components branch on; it can be deleted once the template UI is replaced.

### Conventions

`@/*` path alias maps to the repo root. shadcn/ui components go in `components/ui/` (add via `npx shadcn@latest add <component>`); compose classes with `cn()` from `lib/utils.ts`. Icons from `lucide-react`. Theming is `next-themes` with CSS variables in `app/globals.css`.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
