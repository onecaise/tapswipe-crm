# Tapswipe Internal CRM — End-to-End Plan

Everything decided in this project, consolidated. The full runnable schema
lives in `tapswipe_crm_schema.sql` — this document is the narrative plan
around it: scope, architecture, security, cost, and build order.

## 1. What this is

An internal CRM for Tapswipe's sales team, modeled on the current ISO Hub
feature set, built by Owen (3rd-year MIS major) using Claude Code as the
primary implementation tool. Goal is a working internal MVP first — not a
commercial competitor to ISO Hub — scoped to the features Tapswipe's reps
and admins actually use day to day.

## 2. Stack

| Layer | Choice |
|---|---|
| Database | Supabase (managed Postgres) |
| Auth | Supabase Auth |
| File storage | Supabase Storage (private bucket) |
| Privileged server logic | Supabase Edge Functions |
| Frontend | **Decided:** Next.js (App Router), started from Supabase's official `create-next-app -e with-supabase` template. Chosen specifically because it comes with cookie-based (`httpOnly`) session handling already wired up — the more secure approach settled on in §8, which a plain client-only React SPA structurally cannot do on its own (there's no server to set an `httpOnly` cookie from). Tier 1 direct `supabase-js` calls from client components still work exactly as designed elsewhere in this plan; Next.js hosts that pattern, it doesn't replace it. |
| UI / forms | Tailwind CSS + shadcn/ui (ships with the starter template) for components; React Hook Form + Zod for the pre-app form (see §14.5/14.6); TanStack Query for data fetching/caching against Supabase |
| Frontend hosting | Vercel |

## 3. Feature scope (mapped from ISO Hub's sidebar)

- **Dashboard** — counts/recent items for active merchants, active leads, ghost sheets, pre-apps; scoped like everything else.
- **Merchants** — active / inactive / other, MID, DBA, processor, split %.
- **Pre-Apps** — the full merchant application: business info, ownership (51%+ rule, multiple owners), banking, business profile (card mix), terminal/POS setup, document uploads.
- **Leads** — source, contact info, follow-up date, probability to close, industry/vertical, notes, documents, tasks.
- **Ghost Sheets** — lightweight pre-lead capture, can convert into a full Lead.
- **Support Tickets** — tied to a merchant, category/sub-category/priority, attachments.
- **Document Center** — driver's licenses, voided checks, business verification docs.
- **My Submissions** — for agents this is identical to their normal list views (RLS already restricts them); for admins it's an explicit "just my own" filter distinct from the company-wide view.
- **Profile** — self-service edit of own name/contact info/password.

## 4. Data model

Full DDL is in `tapswipe_crm_schema.sql`. Table summary:

| Table | Purpose |
|---|---|
| `profiles` | Extends Supabase's `auth.users` with `role` (`agent`/`admin`) and `is_active` |
| `merchants` | Active/inactive merchant records, tied to the agent who owns them |
| `leads` | Sales leads |
| `ghost_sheets` | Lightweight pre-lead capture |
| `pre_apps` | Merchant application — business info, non-sensitive banking fields |
| `pre_app_owners` | Ownership info (non-sensitive half) |
| `pre_app_terminal` | Terminal/POS setup (non-sensitive half) |
| `pre_app_business_profile` | Card-mix percentages, notes |
| `pre_app_owner_secrets` | **SSN only** — locked down, Edge Function access only |
| `pre_app_banking_secrets` | **Routing/account number only** — locked down, Edge Function access only |
| `pre_app_terminal_secrets` | **RP password only** — locked down, Edge Function access only |
| `documents` | File metadata (actual bytes in Supabase Storage) |
| `support_tickets` | Support requests tied to a merchant |
| `notes`, `tasks` | Generic, attach to any of lead/pre_app/merchant/ghost_sheet |
| `audit_log` | Who did what, when — admin-readable only |

## 5. Access control model

One rule, applied uniformly: `role = 'admin'` sees every row; `role =
'agent'` sees only rows where `agent_id = auth.uid()`. Enforced via
Postgres Row Level Security, using Supabase's automatic `auth.uid()` (no
manual session-variable plumbing needed, since Supabase's API layer sets
this from the caller's JWT on every request).

Key details worth remembering, not just the headline rule:

- Every RLS policy is written per action (select/insert/update/delete)
  rather than one blanket rule, because the risk differs per action — in
  particular, `update` policies carry a `with check` clause too, so an
  agent can't quietly reassign one of their own rows to someone else by
  changing `agent_id` in an update.
- Deletes are admin-only across the board — reps edit and update, they
  don't permanently remove company records.
- The truly sensitive fields (SSN, bank routing/account, terminal
  password) live in their own narrow tables with **zero policies for the
  authenticated role** — not even the owning agent can read or write them
  directly through the client. The only path in is a server-side Edge
  Function using the service-role key, which is how the encryption key
  stays out of the browser entirely (see §6).
- **Deactivation must gate "own row" access too, not just admin status.**
  Every policy's own-row branch is `(agent_id = auth.uid() and
  is_active_agent())`, not just `agent_id = auth.uid()` — otherwise a
  deactivated agent who's still logged in (or who logs back in before
  their session is separately revoked) keeps full read/write access to
  their own merchants, leads, and everything else. `is_active_agent()` is
  a small `security definer` helper alongside `is_admin()`.
- **Role lives only in Postgres, never in the JWT.** No custom access
  token hook adding a role claim — every admin check is a live query via
  `is_admin()`. This is deliberate: a role baked into a JWT can go stale
  until the token refreshes, which is exactly wrong for the case that
  matters most (a just-deactivated user's existing token still claiming
  they're fine). Revisit only if per-request role checks become a real
  measured performance problem, which is unlikely at this scale.
- **`profiles` has no self-update policy.** Letting agents `UPDATE` their
  own profile row directly would let them attempt to set their own
  `role` to `'admin'`. Self-service edits (e.g. changing `full_name`) go
  through a narrow `update_own_full_name()` RPC instead, which only ever
  touches that one column no matter what's passed in.

## 6. Sensitive data handling

**No card numbers, ever.** Nothing in this system's schema captures a raw
card PAN — the pre-app form collects banking info for settlement (ACH),
not card data. Keep it that way: any future workflow that touches a card
(e.g., a virtual terminal) should route straight to the processor's own
hosted/tokenized fields so a card number never transits Tapswipe's
servers, logs, or database. This is a technical design choice on my end,
not a compliance sign-off — worth confirming explicitly with whoever owns
compliance at Tapswipe, since PCI scope is a company-wide determination.

**SSN, bank account/routing, terminal password are encrypted, not stored
in plain text.** Encryption/decryption happens in one place: a Supabase
Edge Function, using AES-256-GCM, with the key held as a Supabase secret
(never in git, never sent to the browser). The flow:

1. Rep fills out the pre-app form. Non-sensitive fields (owner name/
   address, bank name, terminal settings) get written directly from the
   frontend via `supabase-js`, protected by normal RLS.
2. The sensitive fields (SSN, routing/account, RP password) get sent
   instead to a `submit-pre-app-secrets` Edge Function over HTTPS, which
   encrypts them and inserts into the `*_secrets` tables using the
   service-role key.
3. Reading them back later (rare — an admin needs to verify something) goes
   through a matching `read-pre-app-secrets` Edge Function, which decrypts
   only what's requested and should log the access to `audit_log`.

If you ever need to detect duplicate SSNs across applications without
decrypting everything, add a deterministic HMAC-SHA256 hash column
alongside the encrypted value and compare hashes instead.

## 7. File storage

One private Supabase Storage bucket (`documents`). No public storage
policies — all upload/download access goes through two Edge Functions
(`create-upload-url`, `create-download-url`) that check the `documents`
table's `agent_id` (or `is_admin()`) before minting a short-lived signed
URL. The metadata row in Postgres is what RLS actually protects; the
signed URL is just a temporary key to the underlying bytes.

## 8. Auth & user management

- **Login**: Supabase Auth, directly from the frontend client. Each rep
  gets their own account — never a shared login, since the entire access
  model depends on `agent_id` identifying exactly one person.
- **No public sign-up.** This is an admin-provisioned internal tool, not
  a self-service product. `enable_signup` must be set to `false` under
  `[auth]` in `supabase/config.toml`, and the starter template's
  `/auth/sign-up` page must be removed or replaced, not left live.
  Otherwise anyone can create an `auth.users` row with no matching
  `profiles` row, log in, and land on an app that's silently empty for
  them with no way to self-heal (by design, `profiles` has no insert
  policy for `authenticated`).
- **Bootstrapping the first admin.** Before `create-user` exists as a
  working Edge Function, admin #1 has to be created by hand: create the
  account in the Supabase dashboard (Authentication → Users → Add User),
  then insert their `profiles` row directly via the SQL Editor with
  `role = 'admin'`. Every admin after that is created through the
  `create-user` Edge Function by an existing admin.
- **Onboarding reps**: admin creates each account directly (via the
  `create-user` Edge Function) with a temporary password, hands it to the
  rep out-of-band, and the rep is forced to set a real password on first
  login. Chosen over an email-invite flow for now since Tapswipe's rep
  list is small and known — invite-by-email is a reasonable upgrade later,
  not a blocker now.
- **Admin managing other accounts**: a "Manage Users" admin screen backed
  by three Edge Functions — `create-user`, `deactivate-user`,
  `admin-reset-password` — all using the Supabase Auth Admin API under the
  service-role key (never exposed to the frontend).
- **Deactivation, never deletion**: a rep who leaves has `agent_id` on real
  historical deals and residuals. Set `profiles.is_active = false` and
  block login at the Auth layer too; never hard-delete the account.
- **Roles enforced in three places, not just one**: RLS (row-level data
  access), Edge Function checks (`is_admin()` verified server-side before
  any admin action runs), and the frontend (hiding admin UI for non-admins
  — a UX nicety only, never the actual security boundary).

## 9. Backend architecture — three tiers

| Tier | What | Examples |
|---|---|---|
| 1 | Direct from frontend via `supabase-js`, protected by RLS | Merchants, leads, ghost sheets, non-sensitive pre-app fields, notes, tasks, support tickets, document metadata |
| 2 | Postgres functions via `supabase.rpc()` — atomic DB logic, no secrets | `approve_pre_app()`, a future search function across leads/pre-apps/ghost-sheets (written as a plain function, not `security definer`, so the caller's own RLS scoping still applies to search results) |
| 3 | Supabase Edge Functions — anything needing the service-role key or external services | `submit-pre-app-secrets`, `read-pre-app-secrets`, `create-upload-url`, `create-download-url`, `create-user`, `deactivate-user`, `admin-reset-password` |

The result: most of the CRM needs no custom backend code at all. What you
do write concentrates exactly on the two places with real risk — sensitive
data and admin actions — instead of being spread evenly across every
feature.

## 10. Security checklist (Supabase-specific)

- **Anon key vs service-role key**: the anon key (safe for the frontend
  bundle) only ever gets you as far as RLS allows. The service-role key
  bypasses RLS entirely — it must never appear in frontend code, only in
  Edge Function environment secrets.
- **Environment separation**: separate Supabase projects for dev/staging/
  production. Claude Code will be running migrations and seeding test data
  constantly while you build — that should never be able to touch a
  production project holding real merchant data.
- **Backups**: automatic on Supabase's paid tier (daily, with retention) —
  confirm it's on, and test a restore once before this holds real data.
- **Rate limiting on auth**: Supabase Auth has some built-in protection,
  but confirm current defaults against the docs when you set this up —
  these details shift between versions.
- **Audit logging**: the `audit_log` table plus explicit inserts from every
  admin Edge Function and from sensitive-data access — this is what turns
  "we don't know what happened" into "we can show exactly who touched this
  and when."
- **RLS testing**: before launch, write a basic test pass — log in as
  agent A, confirm you cannot fetch agent B's merchants/leads/pre-apps
  through the client. Don't assume the policies are correct just because
  they look right on paper.

## 11. Cost estimate

Supabase: free tier is enough while building and testing (500 MB database,
1 GB file storage, 5 GB egress). Moving to real usage: the Pro tier is
$25/month, including 8 GB database storage, 100 GB file storage, and daily
backups with 7-day retention. Edge Functions are included in both tiers.

Frontend hosting: Vercel's free "Hobby" tier works technically, but its
terms are scoped to personal/non-commercial use — for a company-owned
internal tool, budget for Vercel Pro (~$20/month per seat) to stay within
their terms.

Rough total: **$0/month** while building, roughly **$45/month** once this
is real-usage production (Supabase Pro + one Vercel Pro seat). That scales
with storage and traffic, not with how many features you build — pricing
on all of this is worth a quick recheck against current numbers before you
commit, since it does shift over time.

## 12. Build order

1. **Supabase project + repo setup.** Separate dev project first; create
   staging/production projects before real data enters the picture.
2. **Auth + `profiles`.** Login, logout, session handling, the
   `is_admin()` helper, and a "Manage Users" screen (`create-user`,
   `deactivate-user`, `admin-reset-password` Edge Functions). Nothing else
   works without this, and it's the best place to prove out the RLS
   pattern with the simplest possible data.
3. **Merchants.** Simplest CRUD shape — confirms the whole Tier 1 (direct
   client + RLS) pattern works end to end before anything more complex.
4. **Leads, then Ghost Sheets.** Same shape as Merchants, largely reusing
   what you just built. Add the ghost-sheet-to-lead conversion action.
5. **Document storage.** The `documents` table, the private bucket, and
   the `create-upload-url`/`create-download-url` Edge Functions — needed
   before Pre-Apps, since pre-apps depend on file uploads.
6. **Pre-Apps.** The big one. Build the parent record and one sub-section
   at a time: business info → owners (non-sensitive) → terminal
   (non-sensitive) → business profile → then the `submit-pre-app-secrets`
   Edge Function for SSN/banking/RP-password last, once the rest of the
   form works.
7. **`approve_pre_app()` RPC**, wired to an admin-only "Approve" action in
   the UI.
8. **Support Tickets, Notes, Tasks.**
9. **Dashboard + Search.** Both are read-only aggregations over what
   already exists, so they're genuinely easiest last.
10. **Security hardening pass.** RLS testing (agent-A-can't-see-agent-B),
    confirm backups, confirm service-role key never reaches the frontend
    bundle, add remaining `audit_log` writes.
11. **Data migration + parallel run.** Plan how existing ISO Hub data
    moves over; run both systems side by side for a stretch before
    trusting the new one with real numbers.
12. **Launch to reps.** Roll out accounts via the onboarding flow in §8,
    starting with a small group before the full team.

## 13. Open items to confirm before/while building

- Confirm with Tapswipe's compliance owner that no card PAN ever needs to
  flow through this system, now or in any near-term planned workflow.
- Confirm the current rep/admin headcount, since that's what determines
  whether Pattern 1 onboarding (admin-created accounts) stays sufficient
  or whether invite-by-email becomes worth building sooner.
- Recheck Supabase/Vercel pricing against their current pages before
  committing budget — figures above are current as of this conversation
  but these change.

## 14. Process gaps — what's missing to make this run smoothly end to end

Everything above covers *what* to build and *who can access what*. This
section covers the surrounding development process that determines
whether building it is smooth or painful. These are real gaps, not
restatements of earlier sections.

### 14.1 Schema changes belong in version-controlled migrations, not the SQL editor

Running `tapswipe_crm_schema.sql` once by hand in Supabase's dashboard is
fine to get started, but every change after that should go through the
**Supabase CLI**'s migration system (`supabase migration new ...`), with
the resulting `.sql` files committed to your git repo under
`supabase/migrations/`. This is what lets you apply the exact same schema
history to dev, staging, and production, and what lets Claude Code safely
propose a schema change as a reviewable diff instead of an unreviewable
click in a dashboard. Set this up in step 1 of the build order, before the
first real table changes past the initial schema — retrofitting migration
discipline after the schema has drifted between environments is real work
you can just avoid.

### 14.2 A CLAUDE.md file, so every session starts with the same ground rules

Since you'll be working with Claude Code across many separate sessions,
put a `CLAUDE.md` at the repo root summarizing: the three-tier
architecture (§9), which tables are locked-down secrets tables and must
never get a direct-client policy added to them, the RLS pattern to copy
for any new table, and where the encryption key/service-role key live.
Without this, it's easy for a future session (yours or Claude Code's) to
"helpfully" add a convenience policy to `pre_app_owner_secrets` that
quietly undoes the whole point of that table.

### 14.3 Git workflow and a CI pipeline

A simple branch-per-feature workflow with pull requests, even solo — it
gives you a diff to review (or have another Claude Code session review)
before merging, which matters more here than on a typical project because
some of these diffs touch RLS policies and encryption code. Pair it with
a basic CI pipeline (GitHub Actions is the common choice): on every push,
run your test suite and apply pending migrations to a throwaway/staging
database to catch a broken migration before it ever reaches production.
Vercel handles frontend preview deployments per pull request essentially
for free, which is worth turning on from day one.

### 14.4 A real testing strategy, not just "test it by clicking around"

Three things specifically worth automated tests, because they're the
places a manual click-through won't reliably catch a regression:

- **RLS policy tests** — log in as two different test agents and assert
  agent A's client genuinely cannot fetch agent B's rows, for every table.
  This is the test that catches "someone added a table without a policy"
  before a rep does.
- **Encryption round-trip tests** for the `submit-pre-app-secrets` /
  `read-pre-app-secrets` Edge Functions — encrypt a known value, decrypt
  it, assert it matches. A silent bug here doesn't crash anything, it just
  corrupts stored SSNs/bank numbers in a way nobody notices until someone
  needs the data back.
- **One end-to-end test of the core money path** (e.g. with Playwright):
  rep logs in, submits a pre-app including a file upload, admin approves
  it, a merchant record appears. This is the workflow the whole business
  depends on — worth protecting with a real automated test rather than
  "someone will notice if it breaks."

### 14.5 Input validation, separate from access control

RLS decides *who* can write a row; it says nothing about whether the data
they wrote is well-formed. The original ISO Hub form has a lot of
required (`*`) fields and specific formats (EIN, phone, zip, dates) — none
of that is enforced by anything in the schema right now. Use a schema
validation library (Zod is the natural fit with a JS/TS stack) to define
each form section's shape once, and reuse that same definition both in
the frontend form (so a rep sees an inline error immediately) and in the
Edge Functions that receive the sensitive fields (so a malformed request
can't reach the encryption step at all). Writing this once and sharing it
both places also means Claude Code has one source of truth to work from
instead of two definitions quietly drifting apart.

### 14.6 The pre-app form itself needs a specific frontend approach

This is the most complex screen in the whole app by far — multiple
sections, conditional fields, multiple owners, file uploads — and it
deserves a deliberate plan rather than "build a big form":

- A form library that handles multi-section state well (React Hook Form
  pairs naturally with the Zod schemas from §14.5).
- **Autosave the draft.** This form is long enough that a rep losing their
  work to a closed tab or a spotty connection is a real, likely event —
  save to `pre_apps` (status `draft`) periodically as they go, not only on
  a final submit button.
- A data-fetching layer (TanStack Query pairs well with `supabase-js`) so
  the same merchant/lead/pre-app data isn't independently re-fetched and
  re-cached inconsistently across the Dashboard, list pages, and detail
  views.

### 14.7 Realtime updates and the notification bell

The original sidebar/topbar included a notification icon and a live
dashboard — that implies data changing while a rep has the page open, not
just on refresh. Supabase Realtime (subscriptions over Postgres changes)
is the natural fit: the Dashboard's counts can update live, and a
notification (e.g., "your pre-app was approved") can appear without a
manual refresh. Not needed for the very first version, but worth planning
for once the core CRUD flows work, rather than bolting it on as an
afterthought later.

### 14.8 Indexing and search performance

Every RLS policy filters on `agent_id` — that means every single query
against every table implicitly filters on it too. Add a plain btree index
on every `agent_id` column now, while tables are empty; it costs nothing
today and prevents a real slowdown later as data grows. Also index the
columns your list-page filters actually use (`merchants.status`,
`pre_apps.status`, `leads.next_followup_date`). For the search feature
specifically, a naive `ILIKE '%text%'` search across DBA names and
contact names will get slow as the merchant/lead tables grow — Postgres's
trigram index extension (`pg_trgm`) is the standard fix and is available
on Supabase; worth using from the start rather than retrofitting once
search feels slow.

### 14.9 Application error tracking, separate from the database security monitoring in §10

§10 covers watching for security-relevant database events (failed logins,
unusual query volume). That's different from knowing when the *app itself*
throws an error — a frontend exception, a failed Edge Function invocation,
a bad API response. A lightweight error-tracking tool (Sentry has a free
tier that's plenty for this scale) wired into both the frontend and the
Edge Functions means you find out about a bug from a dashboard, not from a
rep messaging you that "the pre-app page is broken."

### 14.10 A rollback plan for when a deploy goes wrong

Vercel keeps previous frontend deployments and lets you roll back to one
instantly. The Supabase CLI supports down-migrations for schema changes.
Neither is useful unless you've actually confirmed how to trigger it
*before* the day you need it under pressure — worth a five-minute dry run
once staging exists, not something to figure out for the first time during
an actual incident.

### 14.11 A data retention question worth raising, not assuming

It's tempting to assume "delete old data we don't need anymore" is
obviously fine, but financial/merchant application recordkeeping often
carries retention *requirements* — rules that require keeping certain
records for a period of years, not deleting them promptly. Before building
any cleanup/archival job, this is worth a real question to whoever handles
compliance at Tapswipe: how long does merchant application and banking
data need to be retained, and does anything need to be deleted proactively
versus simply kept. Don't default to either "delete everything after a
year" or "keep everything forever" without that answer.

### 14.12 Rollout isn't just a technical step

The build order in §12 ends at "launch to reps," but a tool that's
technically correct and unfamiliar is still a rough launch. Plan for a
short overlap where a handful of reps use the new tool alongside ISO Hub
before the full team switches, and expect to spend real time on basic
things like "here's where Merchants moved to" — not because the tool is
wrong, but because any change to a tool people use daily needs a bit of
hand-holding regardless of how well it's built.
