# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

Tapswipe's internal CRM (merchant services): Dashboard, Merchants, Pre-Apps, Leads, Ghost Sheets, Support Tickets, Document Center, My Submissions.

**Current state matters when reading the code:** `app/` and `components/` are still the unmodified [Next.js + Supabase starter kit](https://github.com/vercel/next.js/tree/canary/examples/with-supabase) — the README, `app/page.tsx`, `app/protected/*`, and `components/tutorial/*` are template scaffolding, not product code. All CRM-specific work so far lives in `supabase/`: the schema in `supabase/migrations/20260804201300_initial_schema.sql` and seven Edge Function directories that are **still `withSupabase` hello-world stubs** (identical 46-line files). The migration is the authoritative spec for the data model and access rules.

Stack: Next.js 16 (App Router, React 19), Supabase (Postgres + Auth + Storage + Deno Edge Functions), Tailwind 3 + shadcn/ui (new-york, `neutral` base), TypeScript strict. Linked Supabase project ref: `vdjtosofrimipklbdjbi`.

## Commands

```bash
npm run dev            # Next dev server on :3000
npm run build          # next build (also type-checks — currently fails, see below)
npm run lint           # eslint . (currently fails, see below)
npx tsc --noEmit       # type-check only

npx supabase start                       # local stack (API :54321, DB :54322, Studio :54323, mail :54324)
npx supabase db reset                    # rebuild local DB from migrations/ + seed.sql
npx supabase migration new <name>        # new timestamped migration
npx supabase db push                     # apply migrations to the linked remote project
npx supabase functions serve <name>      # run one function locally (hot reload)
npx supabase functions deploy <name>     # deploy one function
npx supabase secrets set KEY=value       # set Edge Function secrets (encryption key, etc.)
```

No test framework is configured — there is no `npm test`, and no test files exist.

### Known baseline failures (pre-existing, not caused by your change)

`npm run build`, `npx tsc --noEmit`, and `npm run lint` all fail today because `tsconfig.json` includes `**/*.ts` and ESLint lints everything, which pulls in the Deno Edge Functions under `supabase/functions/`. Those resolve `@supabase/server` through per-function `deno.json` import maps that Node/TS resolution cannot see, so every function reports `TS2307` plus implicit-`any` on `req`/`ctx`, and ESLint reports unused `ctx`. `tailwind.config.ts:62` also trips `@typescript-eslint/no-require-imports`.

Fix (do it if the task touches the build, otherwise just don't chase these errors): add `"supabase"` to `exclude` in `tsconfig.json` and ignore `supabase/functions/**` in `eslint.config.mjs`. Next.js compilation itself succeeds — only the type-check step fails.

## Definition of done

A feature isn't done when it compiles — it's done when it's verified and committed.

- **Verify every feature before calling it complete.** Write a test where one fits (an RLS policy check against the local DB, an Edge Function invoked with `curl` per the snippet at the bottom of each `index.ts`). Where no test harness exists, do the check manually and state in your response exactly what you ran and what you observed — "loaded `/leads` as an agent, saw only my 3 rows; as admin, saw all 11." An unverified claim of completion is not completion.
- **Commit after each working increment**, not once at the end of a session. Descriptive subject line saying what changed and why (`Add leads list page with agent-scoped RLS query`, not `updates`). Keep schema migrations and the code that depends on them in the same commit.

Note: this directory is **not yet a git repository** — run `git init` before the first commit.

## Architecture

### Access control is the core design constraint

One rule, everywhere: **`role = 'admin'` sees every row; `role = 'agent'` sees only rows where `agent_id = auth.uid()`.** Every table has RLS enabled and policies written as `agent_id = auth.uid() or is_admin()`. Child tables of `pre_apps` (`pre_app_owners`, `pre_app_terminal`, `pre_app_business_profile`) reach the check through an `exists (select 1 from pre_apps ...)` subquery on the parent. Deletes are usually admin-only.

`is_admin()` is `security definer` on purpose — a policy on `profiles` that queried `profiles` directly would recurse. Reuse it; don't inline role lookups.

**When adding a table, follow this pattern** (`agent_id uuid references profiles(id) not null`, enable RLS, four policies) or the table will silently be either wide open or unreadable.

### Three tiers of data access — pick the right one

1. **Normal tables via `supabase-js`** (`merchants`, `leads`, `ghost_sheets`, `pre_apps` + children, `documents`, `support_tickets`, `notes`, `tasks`, `audit_log`). RLS does the enforcement; the client talks to Postgres directly.
2. **Secrets tables — Edge Function only.** `pre_app_owner_secrets` (SSN), `pre_app_banking_secrets` (ABA routing / account number), `pre_app_terminal_secrets` (RP password) have RLS enabled with **zero policies**, so `authenticated` is denied read *and* write. Values are stored as `bytea` AES ciphertext; only a service-role Edge Function holding the encryption key can touch them. This includes the agent's initial submission — the browser must POST that data to `submit-pre-app-secrets`, never insert it via `supabase-js`. Never add a policy to these tables.
3. **`approve_pre_app(pre_app_id_input int)` RPC** — `security definer` plpgsql that creates a `merchants` row from a pre-app, flips its status to `approved`, and writes `audit_log`. It guards itself with an explicit `is_admin()` check at the top; keep that check if you edit it.

`profiles` has no insert policy by design — rows are created by the `create-user` Edge Function using the service role, alongside `auth.users`.

### Edge Functions

Seven functions, all registered in `supabase/config.toml` (a function not listed there won't deploy or serve):

| Function | Purpose |
| --- | --- |
| `create-user`, `deactivate-user`, `admin-reset-password` | admin user management via `auth.admin` + `profiles` |
| `submit-pre-app-secrets`, `read-pre-app-secrets` | encrypt/decrypt the three secrets tables |
| `create-upload-url`, `create-download-url` | mint short-lived signed URLs for the private `documents` Storage bucket after checking `documents.agent_id` or `is_admin()` |

All are currently `verify_jwt = false` in `config.toml`, so **each function is responsible for authenticating the caller itself** — validate the JWT / check the caller's role before using `ctx.supabaseAdmin` (which bypasses RLS). Runtime is Deno 2 with per-function `deno.json` import maps; `.vscode/settings.json` enables the Deno language server only for `supabase/functions`, so the rest of the repo stays on the Node TS server.

Storage: one private bucket named `documents` (created out-of-band, not in SQL). The `documents` table stores metadata only (`owner_type` + `owner_id` polymorphic pointer, `doc_type`, `file_key`); bytes are in the bucket and are only reachable through the two signed-URL functions.

`notes` and `tasks` use the same polymorphic `owner_type` + `owner_id` shape (`lead` | `pre_app` | `merchant` | `ghost_sheet`) — there is no FK, so validate `owner_id` in application code.

### Next.js / auth wiring

- Three Supabase client factories, don't mix them up: `lib/supabase/client.ts` (browser), `lib/supabase/server.ts` (Server Components / Actions / Route Handlers, cookie-backed, `async`), `lib/supabase/proxy.ts` (request pipeline). Never hoist any of them into a module-level global — Fluid compute reuses processes across requests.
- `proxy.ts` at the repo root is Next 16's renamed middleware. It calls `updateSession()`, which refreshes the session cookie and redirects unauthenticated requests to `/auth/login` for everything except `/` and `/auth/*`. Do not insert code between `createServerClient()` and `supabase.auth.getClaims()` in that file, and return the `supabaseResponse` object unchanged — the comments there explain why (random logouts).
- Auth pages live under `app/auth/*` with matching form components at the top level of `components/`; `app/auth/confirm/route.ts` handles email OTP verification.
- `next.config.ts` sets `cacheComponents: true`, so dynamic data fetching must sit inside a `<Suspense>` boundary (see `app/protected/page.tsx` for the shape).
- Env vars (`.env.local`, mirrored in `.env.example`): `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. The publishable/anon key is the only key the Next app should ever hold — the service-role key belongs in Edge Function secrets only. `lib/utils.ts` exports `hasEnvVars`, a starter-only guard that several components branch on; it can be deleted once the template UI is replaced.

### Conventions

`@/*` path alias maps to the repo root. shadcn/ui components go in `components/ui/` (add via `npx shadcn@latest add <component>`); compose classes with `cn()` from `lib/utils.ts`. Icons from `lucide-react`. Theming is `next-themes` with CSS variables in `app/globals.css`.
