# Tapswipe CRM

Tapswipe's internal CRM for merchant services. Dashboard, Merchants, Pre-Apps, Leads,
Ghost Sheets, Support Tickets, Document Center, Notes, Tasks, Rep Payouts and admin
user management.

Private and internal. There is no public sign-up and there never will be — accounts are
created by an admin through the `create-user` Edge Function, because an `auth.users` row
with no matching `profiles` row can log in, see nothing, and cannot heal itself.

Next.js 16 (App Router, React 19) · Supabase (Postgres + Auth + Storage + Deno Edge
Functions) · Tailwind 3 + shadcn/ui · TypeScript strict.

---

## Getting started

You need Docker (for the local Supabase stack) and Node ≥ 20.9.

```bash
npm install
npx supabase start                 # Postgres :54322, API :54321, Studio :54323, mail :54324
npx supabase db reset              # build the schema from supabase/migrations/
npm run seed:local                 # create the two local dev accounts
npm run dev                        # http://localhost:3000
```

`npm run dev` needs `.env.development.local`, which is gitignored. Create it from what
the stack reports:

```bash
npx supabase status -o env         # take API_URL and PUBLISHABLE_KEY
```

```env
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<PUBLISHABLE_KEY from the line above>
```

Then sign in as either account `npm run seed:local` made:

| Email | Password | Role |
| --- | --- | --- |
| `admin@tapswipe.test` | `local-dev-admin-123` | admin |
| `agent@tapswipe.test` | `local-dev-agent-123` | agent |

Local only, and they do not survive `npx supabase db reset` — it drops `auth.users` with
everything else, so re-seed after every reset.

### Two accounts, or a populated app

`npm run seed:local` gives you the two accounts and nothing else, which is what you want
while writing migrations. For pages with something actually on them — merchants, leads,
pre-apps, tickets, notes, tasks, and a payouts period with a review batch left blocked the
way a real one would be:

```bash
node seed-dev-local.mjs      # accounts + demo records + both Storage buckets
node seed-dev-payouts.mjs    # agent numbers, a committed period, one blocked import batch
```

`seed-dev-payouts.mjs` needs `seed-dev-local.mjs` to have run, and needs Edge Functions
served — it uploads and parses a real XLSX rather than faking the staging rows.

**The two paths collide, and the collision is the thing to know.** Both claim
`admin@tapswipe.test` and `agent@tapswipe.test`, both delete-then-recreate, and the
passwords differ — `seed-dev-local.mjs` sets **`TapswipeDev123!`** for both accounts.
Whichever you ran last owns the login. Pick one per session rather than alternating.

### Two things that are not obvious

**The Storage buckets are not in any migration, and `db reset` destroys them.** `documents`
and `residual-imports` are created out-of-band, so a freshly started stack has neither —
and, measured rather than assumed, `npx supabase db reset` drops both as well. That is the
one to watch: you reset to test a migration, and document upload and download start 404ing
for a reason nothing in the UI or the logs connects to what you just did.

`npm run seed:local` does **not** create them. **`npm run test:live` is the only command
that restores both** — the e2e fixtures provision `documents` alone, so a run of
`npm run test:e2e` leaves residual imports still broken. Otherwise create them in Studio as
**private**, with a 50 MiB file size limit (`MAX_DOCUMENT_BYTES` in `lib/documents.ts`).
The per-bucket limit is the real ceiling: `[storage] file_size_limit` in `config.toml` does
not constrain a signed upload, which was also measured rather than assumed.

**Anything that needs an Edge Function needs them served.** Document upload/download,
pre-app secrets, user management and residual imports all go through
`supabase/functions/`. `npx supabase start` brings up an edge runtime, but it can and does
die; when document features fail with nothing in the UI to explain it, that is the first
thing to check.

```bash
npx supabase functions serve --env-file ./supabase/functions/.env
```

---

## Environment files

There are three, all gitignored, and the split is deliberate. `.env.example` documents it
in full — the short version:

| File | Holds | Used by |
| --- | --- | --- |
| `.env.development.local` | the **local stack** | `npm run dev` |
| `.env.local` | the **hosted** project | `next build`, production |
| `.env.deployed.local` | every deployed project to check | `npm run test:deployed` |

Next resolves `.env.development.local` ahead of `.env.local`, so dev talks to the local
stack with no flag to remember. That ordering is load-bearing: with only `.env.local`
present, `npm run dev` once pointed the whole app at the hosted project, and the symptom
was not an error but an admin-only column appearing for a rep and a list reading "no
pre-apps yet" because the row was in the other database. `lib/env-guard.ts` now throws at
dev-server boot if the URL is not local. Set `ALLOW_REMOTE_SUPABASE_IN_DEV=1` to do it on
purpose.

The publishable/anon key is the only key this app should ever hold. The service-role key
belongs in Edge Function secrets, and nowhere else.

---

## Acting on a hosted project

There are two hosted projects — `tapswipe-crm-dev` and `tapswipe-crm-prod` — and **both are
real**. Prod is fully deployed and carries live data; it is not a spare.

The Supabase CLI is linked to exactly one of them at a time, and a README cannot tell you
which. Use the wrapped scripts, which read `supabase/.temp/linked-project.json` and report
what the CLI will *actually* do:

```bash
npm run guard:linked      # print the linked project; exit 1 if prod, missing or unrecognised
npm run db:push           # guard, then supabase db push
npm run db:dump           # guard, then db dump --linked
npm run migration:list    # guard, then migration list --linked
npm run functions:deploy  # guard, then functions deploy

ALLOW_PROD_SUPABASE=1 npm run db:push    # act on prod on purpose
```

Raw `npx supabase …` bypasses the guard entirely. Prefer the scripts, and pin
`--project-ref` when you mean prod — that is the only form nobody else's relink can
invalidate.

**Never run `npx supabase config push`.** It has no `--dry-run`, and `config.toml` holds
local-dev auth values; pushing it would set the production Site URL to `localhost`, replace
the redirect allow-list, clamp auth emails to 2/hour project-wide, and turn off email
confirmations. `config.toml` governs the local stack only.

---

## Tests

Four suites, four different targets. Each is green while the next one's class of bug is
sitting in the repo, which is why there are four and not one.

```bash
npm test               # the migrations themselves — PGlite, in-process, no Docker
npm run test:live      # the local stack over real HTTP — needs `supabase start` + `functions serve`
npm run test:deployed  # read-only compliance checks against the deployed projects — needs network
npm run test:e2e       # the rendered app in a real browser — needs Docker + Chromium
npm run test:e2e:ui    # the same, in Playwright's inspect UI
```

Run `npm test` for any schema change, `npm run test:live` for anything crossing
PostgREST/GoTrue/Storage or an Edge Function, and `npm run test:e2e` only for things a
person could **only** find by looking — layout, paint, client state across a refresh, file
inputs. A browser copy of an RLS assertion is just a slower, flakier duplicate.

A red `npm run test:deployed` means a deployed project drifted, not that code broke.

```bash
npm run build          # next build (also type-checks)
npm run lint           # eslint .
npx tsc --noEmit       # type-check only
```

---

## Documentation

This README gets you running. Everything else lives in four documents, and they are worth
reading before changing anything structural:

| Document | What it is |
| --- | --- |
| **`CLAUDE.md`** | How the codebase actually works, and why. The access-control model, the three tiers of data access, what each Edge Function is responsible for, and a long list of decisions that look arbitrary until you know what went wrong. Start here. |
| **`docs/tapswipe_crm_schema.sql`** | **The authoritative spec** for the data model and access rules — not the migrations. Change the doc first, then make `supabase/migrations/` match it. |
| `docs/tapswipe_crm_master_plan.md` | The narrative plan around the schema: scope, architecture, security, cost, build order. |
| `SPEC.md`, `RESIDUALS_SPEC.md` | Design records for the pre-app submission flow and rep payouts. Both shipped; where they disagree with the code, the code is the fact. |

One rule runs through all of it: **`role = 'admin'` sees every row; an active
`role = 'agent'` sees only rows where `agent_id = auth.uid()`.** It is enforced by RLS
policies in the database rather than by checks in the app, so a new table needs an
`agent_id`, RLS enabled, the four policies, **and** explicit grants — the last one is
independent of the others, and a table with perfect policies and no grant answers every
request with `permission denied`.

## Not built yet

My Submissions.

`README.md` was the last of the [Next.js + Supabase starter kit](https://github.com/vercel/next.js/tree/canary/examples/with-supabase)
still in the repo. The rest of the scaffold — the marketing page at `/`, the `/protected`
route, the tutorial components — was deleted on 14 September 2026.
