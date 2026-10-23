# Security fixes from the October 2026 outside review

Branch `security-fixes`. **Local work only**: nothing here has been pushed, linked, or applied to a hosted project. Owen applies the migrations himself — dev first, then prod — after a dry run and a backup.

Every finding was treated as a claim: reproduced as a failing test on the local stack first, and fixed only if it reproduced. These are binding rules, like the rest of `docs/claude/`.

## Phase 1 (High): merchants are admin-only to change

**Rule (Owen): merchant information is changed by admins only.** A rep reads their own merchants (`select own or admin`, unchanged) and keeps adding notes and tasks to them — those are other tables. A rep cannot insert, update or delete a merchant, their own included.

### The finding, reproduced

`20260805103000`'s `insert own` / `update own or admin` let a rep write every column of their own merchant, `mid` included, and `20260811143000` grants `authenticated` table-wide `insert, update`. `commit_residual_import_v2` (as re-created by `20261016160000_import_merge_key.sql`) finds the share covering a staged row with `left join merchants m on m.mid = r.mid_raw` — the merchant's **current** MID.

`tests/rls/merchants-admin-only-writes.test.ts` runs the attack end to end against the schema **before** the fix (`migrationsBefore(20261021120000)`) and it succeeds in every step:

1. A share exists on `MID-AGENT-2`: signer `AGENT` 40%, partner 10%. A July row for it is staged in review.
2. The signer runs `update merchants set mid = 'MID-AGENT-2 '` — 1 row.
3. An admin commits the month: the row matches no merchant, so the plan is `ordinary`, and the ledger gets **one unshared line** for the signer. The partner gets nothing.
4. The signer restores the MID — 1 row. The merchant looks untouched.
5. `audit_log` holds **nothing** for `merchants`: `log_cross_agent_change()` only logs edits by someone other than the owner.

The same test file, against the current schema, asserts both edits touch 0 rows and the month commits as the pair (`primary` + `secondary`, both carrying `rep_share_id`).

### The fix — `20261021120000_merchants_admin_only_writes.sql`

- **Policies.** `insert own` → `admin insert only` (`with check (is_admin())`); `update own or admin` → `admin update only` (`using (is_admin()) with check (is_admin())`). SELECT and DELETE were already right.
- **Grants: unchanged, deliberately.** Admins and reps are both `authenticated`, so a grant cannot tell them apart, and the admin's form and the missing-location screen need `insert`/`update`. The policies are the only layer that can express "admins only". (The brief asked for both layers to change; this is why only one did. A grant-level split would need admin writes to move behind a `security definer` RPC — not proposed.)
- **`merchants_mid_audit`** — `BEFORE UPDATE OF mid`, `audit_merchant_mid_change()`: one `audit_log` row (`action = 'merchant_mid_changed'`, `row_id` = merchant id, `actor_id = auth.uid()`) for **every** actual MID change, by anyone — admins, a service-role script (NULL actor), and anyone a future policy lets in by mistake. No ownership test, which is the case that hid the attack. Only real changes (`is distinct from`), so a form re-sending the same MID logs nothing. Fails closed: no exception handler. `security definer`, `set search_path = public, pg_temp`, `revoke all … from public` and from `anon, authenticated` (a trigger function needs no EXECUTE). The row records who, when and which merchant, **not the old and new values** — `audit_log` has no column for them. Two rows for one merchant inside one review window is the shape of a pad-and-restore.

Mutation checks in the test file: with the two old rep branches restored on a throwaway database, the rep's update lands and their insert succeeds; with the trigger dropped, an admin's MID change leaves no row. Each was confirmed red.

### Every writer of `merchants`, checked

| Writer | How it writes | Affected? |
| --- | --- | --- |
| `approve_pre_app()` | `security definer`, `is_admin()` first | No — runs as owner. Asserted: it still creates the rep's merchant. |
| Ghost sheet → lead → pre-app flow | `convert_ghost_sheet` writes `leads`/`notes`; merchants come only from `approve_pre_app()` | No |
| Share RPCs (`set/end/cancel_merchant_rep_share`, share card, corrections) | write `merchant_rep_shares` / `rep_payout_rows`; only **read** `merchants` | No |
| `parse-residual-import`, `_shared/residuals.ts` | service role, reads only | No |
| Triggers on `merchants` (`set_updated_at`, `merchants_location_guard`, cross-agent audit, new MID audit) | fire on the writer's statement; none write `merchants` | No |
| `/admin/merchants/missing-location` | `requireAdmin()`, reads only | No |
| `scripts/backfill-merchant-location*.sql`, `recon-…`, `preview-…` | hand-run as `postgres` | No (RLS does not apply) — but see the owner fix below |
| Bulk user import / provision | do not touch `merchants` | No |
| e2e seed, live fixtures, `seed-local-users.mjs` | service role | No |
| **Merchant form** (`components/merchant-form.tsx`) | browser `update` / `insert` | **Yes** — admin-only now |

**What relied on a rep updating a merchant**, all now admin-only:

1. The Edit page and form for a rep's own merchant.
2. **New merchant** for reps (manual creation). Confirmed with Owen's rule: reps lose it. No flow in the app depends on it — every rep merchant path goes through `approve_pre_app()`.
3. Filling in a legacy merchant's location: the detail page said "Not recorded — edit to add". A rep now sees "Not recorded"; admins fill it from `/admin/merchants/missing-location` or the edit form.
4. `merchants.pre_app_id` was rep-writable, so a rep could point their merchant at **another rep's** pre-app — which is what made the backfill fix below necessary.

### App

- `/merchants/[id]/edit` and `/merchants/new` call `requireAdmin()` (a rep is redirected to `/dashboard`).
- The detail page hides **Edit** from reps and shows "To change this merchant, contact an admin." No request workflow.
- The list page renders **New merchant** only for an admin (its own `<Suspense>`, the `payouts` `HeaderActions` shape).
- Form copy no longer says "you can only edit merchants in your book".

### Backfill scripts: same owner only

`scripts/backfill-merchant-location.sql` (and, to keep the "identical rules" promise, `backfill-merchant-location-editor.sql`, `recon-merchant-location.sql` and `preview-merchant-location-backfill.sql`) now require `p.agent_id = m.agent_id` on the pre-app join. The preview reports such merchants as `linked pre-app belongs to another rep`. `tests/rls/merchant-location-backfill.test.ts` gained a merchant linked to `OTHER_AGENT`'s approved pre-app with a usable address; all four scripts filled it (8 tests red) before the change, none do after.

### Tradeoff, reported not built: storing the MID on `merchant_rep_shares`

Snapshotting `mid` onto the share at `set_merchant_rep_share()` and matching staged rows on `share.mid` would make the commit independent of the merchant's mutable MID.

- **For:** no later MID edit, by anyone, can detach a share during review; the ledger is keyed by MID text anyway.
- **Against:** a *legitimate* MID change (a typo fix, a processor re-boarding the account) silently detaches the share the other way — the share keeps matching the old MID, and next month's file, carrying the new one, commits unshared. That is the same failure from an honest edit. Avoiding it needs either a sync trigger (which re-couples them) or a block on MID changes while a share is active. It also means two sources of truth, a backfill of existing shares, and lockstep changes to `commit_residual_import_v2`, `previewSharedRow()` in `_shared/residuals.ts`, and the three share RPCs' "latest committed month" reads.
- **Recommendation:** not now (Owen agreed, 21 Oct 2026). With rep writes closed and every MID change audited, the remaining exposure is an admin. A cheaper guard if wanted later: staged rows already carry `merchant_id`; the commit could block a row whose `merchant_id`'s current MID differs from `mid_raw` ("this merchant's MID changed since the file was read").

### Ownership: an admin creates a merchant for a rep, and moves one between books

Decision (Owen, 21 Oct 2026). The admin's New merchant and Edit forms have a required **Owner** select (`lib/merchant-owners.ts`, `ownerOptions()`): every active rep by name with their Agent #, then the admin themself as "(you)". There is **no default** on New — the admin picks, themself included. On Edit it starts on the current owner; a current owner who would not otherwise be offered (a deactivated rep, another admin) is listed first and labelled, so saving the form never silently moves the merchant.

- **No schema change was needed.** "admin insert only" / "admin update only" already admit any owner for an admin and nobody else.
- **Audited by the existing trigger.** `log_cross_agent_change()` writes `cross_agent_insert` when an admin creates a merchant in another rep's book and `record_reassigned` on any owner change — including out of the admin's own book, which its reassignment branch checks before ownership. Creating a merchant in the admin's own book is not an ownership change and logs nothing.
- **Payouts do not follow the owner.** `parse-residual-import` resolves the payee from the file's Agent # (`profiles.agent_number`), and `commit_residual_import_v2` never reads `merchants.agent_id`. Asserted: after reassigning `MID-AGENT-1` to another rep, a row naming the old rep's number is paid to the old rep; after reassigning a shared merchant, the signer's row still commits as the signer/partner pair.
- **`merchant_rep_shares` is untouched.** No trigger on `merchants` writes it; asserted by snapshotting the table and the ledger across a reassignment. The share card's *default* signer for a new share is still the merchant's current owner.
- **Visibility moves with it.** Asserted: the previous owner's `select` returns 0 rows and the new owner's returns 1. A rep cannot give a merchant away or take one (0 rows each, no audit row).

**What a reassignment does not move** (reported, not changed): notes, tasks and proposals on the merchant keep their author's `agent_id`, so the new owner does not see the old owner's notes/tasks/quotes, and the old owner still sees their own notes and tasks on a merchant they can no longer open; the merchant's `pre_app_id` still points at the old owner's pre-app. Owen to decide whether a reassignment should carry any of these.

Tests: 7 in `tests/rls/merchants-admin-only-writes.test.ts` ("an admin decides who owns a merchant", one of them the mutation check with `merchants_audit_cross_agent` dropped), 5 in `tests/unit/merchant-owners.test.ts`, 3 in `e2e/merchant-owner.spec.ts`. Revert experiment: with the form put back to inserting into the caller's own book, "creates the merchant in the chosen rep's book" goes red (the serial reassign spec after it was skipped, so it was not independently proven that way; its RLS twin was).

The cheaper "block a staged row when the merchant's current MID no longer matches the file" idea is recorded in `docs/claude/security-followups.md`.

### Not verified

- Nothing ran against a hosted project. The policy change and trigger are verified on PGlite (`npm test`) and on the local stack (`migration up --local`, then `test:live` and `test:e2e`).
- `audit_merchant_mid_change()` is not in `tests/rls/grants.test.ts`'s function inventory by name; its privileges are asserted in its own file.

## Phase 2 (Medium): pre-app child rows are frozen with their parent

**Rule:** a rep changes the owners, terminal and business profile of a **draft** pre-app only; an admin changes them at any status. The same rule `pre_apps_guard_transitions` has applied to the `pre_apps` row itself since 20260806141000.

### The finding, reproduced

The policies on `pre_app_owners`, `pre_app_terminal` and `pre_app_business_profile` check that the parent pre-app is the rep's and never its status. `tests/rls/pre-app-children-draft-only.test.ts` submits the seeded draft through the real `submit_pre_app()` as the rep, then — on the schema **before** the fix — the rep successfully updated an owner, inserted an owner, deleted an owner, and updated and deleted the terminal and business profile (1 row each). Deleting the owner cascaded their `pre_app_owner_secrets` row away (SSN rows 2 → 1) on an application waiting for approval.

### The fix — `20261021130000_pre_app_children_draft_only.sql`

`pre_app_children_guard()`, one `BEFORE INSERT OR UPDATE OR DELETE` row trigger on each of the three tables (`*_draft_only`). No policy or grant changes.

- Passes an admin (`is_admin()`) and the state machine's own flag (`tapswipe.pre_app_transition`, which a client cannot set). Otherwise refuses with **PT409** "the owners, terminal and business profile of a {status} pre-app can only be changed by an admin" when the parent is not a draft. `lib/db-errors.ts` passes PT4xx text through verbatim.
- INSERT checks the new parent, DELETE the old one, UPDATE **both** — an owner cannot be re-parented onto or off a non-draft pre-app.
- **A parent that is not found is allowed**: that is a cascade from a `pre_apps` delete, and the children must go with it. `security definer` (with `set search_path = public, pg_temp`) so "not found" means deleted, never "not visible to this caller"; ownership stays the policies' job, and they still run afterwards. Checked on PGlite (Postgres 18) and by hand on the local stack's Postgres 17.6 (a rep's update refused; a platform-owner delete of a submitted pre-app cascaded its owner), in a rolled-back transaction.
- **A service-role connection is not exempt**, exactly as for `pre_apps` (no `auth.uid()`, so not admin). No Edge Function writes these three tables — the secrets functions only read `pre_app_owners`.
- `revoke all … from public` and from `anon, authenticated` (a trigger function needs no EXECUTE).

### Transitions and the wizard still work

Asserted in the test file: submitted, approved and declined all refuse the rep; after `reopen_pre_app()` the rep can change every child again; an admin can at any status; the rep's own draft is fully editable; deleting a non-draft pre-app still cascades, as an admin and as the platform owner. Mutation checks: with the trigger dropped on any **one** of the three tables, that table's rep update lands. The existing state-machine suite (64 tests: submit, approve, decline, reopen) passes.

The wizard already opened only for a draft or an admin (`canEditPreApp()` in `lib/pre-apps.ts`, which redirects a rep off `/pre-apps/[id]/edit` for anything else), so the database rule now matches what the UI promised and no app change was needed. e2e (308, including `pre-app-wizard.spec.ts` and the pre-app QA specs) passes.

One fixture changed: `makeSubmittable()` in `tests/rls/pre-app-state-machine.test.ts` writes owners onto the seeded **submitted** pre-app as the platform owner, and now sets the transition flag around that write, as `seed()` does for `pre_apps`. Its assertions are unchanged.

### The secrets tables: no client gap; one gap closed by this fix

- **No client path at all**: zero policies, zero grants (pinned by `tests/rls/grants.test.ts`).
- **The write path, `submit-pre-app-secrets`, already refuses a non-draft for non-admins** (409 "Pre-app is not editable") before `supabaseAdmin` is reached. That branch had **no test**; `tests/live/pre-app-secrets.test.ts` now has three ("after submission"): the rep's secrets write gets 409 and stores nothing, the rep's owner edit and delete through PostgREST get 409 and the SSN row stays, and an admin can still do both. Live mutation check: with `pre_app_owners_draft_only` dropped on the local stack, the owner-edit test went red; the trigger was recreated.
- **The gap that did exist was indirect**: deleting an owner cascaded the SSN row. Closed by the owners trigger.
- **Not built: a trigger on the secrets tables themselves.** The function writes them as service role, which has no `auth.uid()`, so the database cannot tell an admin's write from a rep's there; a status trigger would refuse an admin correcting a submitted pre-app's banking details. The function's check remains the only guard on that path. Recorded in `docs/claude/security-followups.md`.

## Phase 3 (Medium): security headers

**Rule:** every response carries `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'` (and **no other CSP directive**), `Referrer-Policy: strict-origin-when-cross-origin`, `X-Content-Type-Options: nosniff`. The list is `lib/security-headers.ts`; `next.config.ts`'s `headers()` applies it to `/:path*`. Nothing is exempt.

### Nothing is legitimately framed

Searched `app/`, `components/`, `lib/`, `hooks/`, `e2e/`: no `<iframe>`, `<embed>`, `<object>` or frame scripting anywhere. The print pages call `window.print()` on the top-level page (`components/print-button.tsx`). The file viewers (business documents, marketing materials, residual files) open a signed Storage URL in a **new tab** on the Supabase origin, which our headers do not govern. So `DENY` everywhere, with no `SAMEORIGIN` route — the app never frames itself either. No `vercel.json` or other layer sets headers.

### The finding, reproduced — with one correction

`e2e/security-headers.spec.ts`, run before the config change, went red on all four checks: no header on any response, the login page rendered inside a cross-origin iframe, and a signed-in `/admin/users` rendered inside a same-origin frame.

The correction: the review's example (an attacker framing `/admin/users`, pre-app approve or residual commit) does **not** work cross-site today. The session cookie is `SameSite=Lax` (the `@supabase/ssr` default; checked in `e2e/.auth/admin.json`), so a third-party iframe loads the app signed out and gets the login page. The first draft of the framing test framed `/admin/users` from another origin and **passed with no headers at all** for exactly that reason. It was rewritten. What was actually exposed:

- the **sign-in form**, frameable from anywhere (credential-overlay phishing, and the login-CSRF shape phase 7 deals with);
- **every signed-in screen from a same-site origin** — another app on a sibling subdomain of the deployed domain, or the app itself — where Lax cookies are sent;
- and any signed-in screen cross-site the day the cookie's SameSite changes, or in a browser that does not apply Lax by default.

### What checks it

- `e2e/security-headers.spec.ts` (5 tests): the four values on a public page, the proxy's own 307, a static file, a route handler (`/auth/confirm`), the signed-in dashboard, `/admin/users`, a print page and a 404; a cross-origin iframe of `/auth/login` shows no password field; a same-origin iframe of signed-in `/admin/users` shows nothing; control — the same screen renders at the top level. All but the control were red before the fix.
- `tests/unit/security-headers.test.ts` (3 tests): the exact four values, a CSP of `frame-ancestors 'none'` and nothing else, and that `next.config.ts` applies the list to `/:path*`.
- **Production build, by hand:** `next build` with the local stack's URL and key passed in the environment (so nothing pointed at a hosted project), then `next start -p 3100`. `curl -D -` on `/auth/login` (200), signed-out `/dashboard` (307), `/favicon.ico` (200), an unknown path (307) and a hashed `/_next/static/chunks/*.js` (200) all carried the headers. The spec itself runs against `next dev`.

### Not verified

- The **deployed** site. Whatever serves production must not strip or override these; checking needs one `curl -D -` against the real URL after a deploy.
- Browsers other than Chromium.
- `.next/` currently holds that local-stack production build; the next `npm run build` replaces it.

## Phase 4 (hygiene): the deploy-guard bypass, ignored files, `api-keys` advice

### The guard bypass, reproduced

npm appends `npm run <script> -- <args>` to the **end** of the script string. The wrappers read `npm run guard:linked && npx supabase functions deploy`, so `npm run functions:deploy -- --project-ref <prod>` gave the flag to the CLI and nothing to the guard: the guard read the (dev) link file, printed "dev, ok", exited 0, and the command underneath targeted prod. Same for `db:push -- --db-url <url>`. Reproduced in `tests/unit/linked-project-guard.test.ts` ("control: the old … form"), which runs the real `npm run` with the old script string against a fake `supabase` bin and asserts the CLI received `--project-ref`.

### The fix

- **The wrappers launch the CLI from the guard**: `"db:push": "node scripts/check-linked-project.mjs -- db push"` (and `db:dump`, `migration:list`, `functions:deploy`). npm's appended arguments now land in the guard's own argv.
- **The guard refuses `--project-ref` and `--db-url`** (both the `--flag value` and `--flag=value` spellings) before reading the link file and before running anything, **even with `ALLOW_PROD_SUPABASE=1`**: those flags name a target other than the linked project, so a check of the linked project vouches for nothing. The message says to call `npx supabase` directly for a by-ref/by-URL target, which is the rule CLAUDE.md already gave.
- Only then does it check the link (unchanged: prod refused unless `ALLOW_PROD_SUPABASE=1`, a missing link file or an unknown ref refused) and spawn `npx supabase <args>` with inherited stdio, so `db push`'s confirmation prompt still streams. The CLI's exit code is passed back.
- **Check-only mode is unchanged**: with no `--`, the guard only checks and exits. `load-hardware-catalog.mjs` and `purge-legacy-documents.mjs` spawn it that way.

Tests (20, all hermetic): every wrapper's string starts with the guard and contains no `&&`/`;`/`|` or `npx supabase`; real `npm run` refusals for `functions:deploy -- --project-ref`, `db:push -- --db-url`, and `migration:list -- --project-ref=…` with `ALLOW_PROD_SUPABASE=1`; all four wrappers × both flags × both spellings through the guard's argv; the allowed paths (`functions:deploy -- create-user`, `db:push -- --yes`, prod with the override) reach the fake CLI with exactly the right argv; prod linked, no link file and an unknown ref run nothing; exit-code pass-through; check-only mode. Mutation checks: with the flag refusal disabled, 7 tests go red; with `package.json` put back to the `&&` form, 11 go red. Smoke-checked in this repo with a **bogus** ref and URL (so a guard bug could reach nothing): both refused, exit 1.

**Not closed by this:** npm echoes the full command line (`npm notice run node scripts/… --db-url=…`) before the guard runs, so a password inside a `--db-url` still lands in the terminal scrollback even though the command is refused. Raw `npx supabase …` still bypasses the guard entirely, as before.

### Ignored files

`.gitignore` adds `.env.production`, `.env.development`, `.env.test` (the existing `.env*.local` and `.env` did not cover them) and `supabase/signing_keys.json`. Checked with `git check-ignore -v` on a touched copy of each. None of them existed or was tracked.

### `supabase projects api-keys` advice removed

`.env.example` told people to run `npx supabase projects api-keys --project-ref <ref>` to fill `.env.deployed.local`; so did the error `tests/deployed/helpers/projects.ts` throws when that file is missing. Both now say to copy the publishable key from the dashboard and not to run that command (it prints the service-role key). The two scripts that call it with `--reveal` (`load-hardware-catalog.mjs`, `purge-legacy-documents.mjs`) capture the output and never print it; they are CLAUDE.md's stated exception and were not changed.

## Phase 5 (Medium): `accounts_in_city` audited and rate-limited

**Numbers (Owen, 23 Oct 2026):** at most 5 cities per call, 30 calls per rep per rolling hour, admins exempt from the limit but audited.

### The finding, reproduced — with one correction

`accounts_in_city()` is `security definer` over every rep's book, takes a public city name, and was neither audited nor limited. `tests/rls/accounts-in-city-limits.test.ts` ("reproduced") runs 40 searches as one rep on the schema **before** the fix: all 40 answer and `audit_log` gains nothing.

The correction: the function takes **one** city per call; "100" is the cap on *results* per city, not on cities. So the enumeration is one call per city name, and the cap of 5 per call is already met by the signature. The UI (`components/city-accounts-search.tsx`) sends one city per submit. No multi-city variant was added; one would have to revisit the cap. A test pins the identity arguments to `city text, state text`.

### The fix — `20261023120000_accounts_in_city_audit_and_limit.sql`

Same signature, `create or replace`, grants restated. Schema doc updated first.

- **Audit.** Every answered call inserts one `audit_log` row: `actor_id` = caller, `action = 'accounts_in_city:1'`, `table_name = 'merchants'`, `row_id` null. The number after the colon is the number of cities queried, in the templated-verb form `read_pre_app_secrets:<mode>` already uses, because `audit_log` has no detail column. **The city and the results are not recorded.** Admins are audited. No exception handler. A refused call (inactive, bad input, over the limit) raises, which rolls the whole call back, so it leaves no row and returns nothing. That means failed attempts are invisible to the audit trail; recording them would need an autonomous transaction, which Postgres does not have.
- **Rate limit.** Non-admins: count the caller's `accounts_in_city:%` rows with `created_at > now() - interval '1 hour'`; at 30, raise **PT429** (HTTP 429 through PostgREST): "You have reached the limit of 30 city searches an hour. Try again in N minutes." N is when the oldest call in the window ages out. **Durable and not client-trusting**: the counter is the audit rows, which `authenticated` cannot insert, delete or even read (SELECT grant, admin-only policy). `pg_advisory_xact_lock(hashtextextended('accounts_in_city:' || uid, 0))` serialises one rep's concurrent calls. Partial index `audit_log_city_search_idx (actor_id, created_at) where action like 'accounts_in_city:%'`.
- `volatile` (it writes; was `stable`) and `set search_path = public, pg_temp` (was `public`). supabase-js uses POST for RPCs, which PostgREST runs read-write. A `GET /rpc/accounts_in_city` would now fail.
- App: no change needed. `friendlyDbError` passes PT4xx text through verbatim, so the card shows the sentence. `lib/timeline.ts` gained a label ("Accounts searched by city") for the new action; `lib/db-errors.ts`'s comment lists PT429.

### What checks it

- `tests/rls/accounts-in-city-limits.test.ts` (15): the reproduction; the signature; volatile/definer/search_path and the lock call in the body; the index; one row per call with nothing about the query; admins audited; an empty result still audited; refused calls leave no row; a rep cannot read, delete or forge the rows; 30 then PT429 with the exact sentence and no 31st row; the minutes in the message (10, then "1 minute"); rows older than an hour stop counting; per-rep counting; admin exempt (35 calls) but audited; other audit actions do not count.
- `tests/rls/accounts-in-city.test.ts`: `search_path` assertion now exact; "nothing is written" flipped to "one audit row per call, rep and admin alike"; a `beforeEach` clears the city-search rows, since that file makes 38 calls on one database.
- `tests/live/accounts-in-city-limit.test.ts` (3), against the local stack: **40 simultaneous** calls by one rep, exactly 30 answer and 10 get HTTP 429/PT429; an admin's 35 simultaneous calls all answer and are all audited; a rep's API delete of the rows is `permission denied`.
- `e2e/city-accounts.spec.ts`: a new agent test seeds 30 rows and sees the sentence and no results; every agent test now starts at 0 (`setCitySearchCount()` in `e2e/fixtures/seed.ts`), because the local stack keeps the rows between runs and a second run inside an hour would otherwise hit the limit.
- **Mutation checks:**
  - With the limit check disabled, 3 RLS tests fail.
  - With the audit insert removed, 9 fail.
  - With the advisory lock removed on the local stack, the live race test fails: 33 of 40 answered.
  - With the old function restored on the local stack, the new e2e test fails.
  - Each was restored afterwards and confirmed.

### Not verified

- Nothing ran against a hosted project.
- The limit's behaviour under PgBouncer transaction pooling. PostgREST talks to Postgres directly on hosted Supabase, and the lock is transaction-scoped, so pooling should not matter, but this was not tested there.
- Other cross-book definer reads (`check_duplicates()`, `my_share_partners()`) remain unaudited and unlimited. `check_duplicates` takes free-text inputs that could be looped the same way, though its output is narrower. Not in scope; noted for review.
