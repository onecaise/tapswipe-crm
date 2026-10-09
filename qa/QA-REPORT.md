# QA sweep report — TapSwipe CRM

## Summary

Unattended sweep, 2026-10-09, branch **`qa-sweep`** (13 commits on top of `responsive-shell` @ b85d064,
**not pushed, not merged**). Local stack only — no hosted project, Vercel, migration, RLS policy, grant,
definer function, auth flow or price-lock trigger was touched.

**11 findings — 9 fixed, 2 NEEDS OWEN**, plus **9 DECISIONS** (D-01…D-09) and **1 observation** (OBS-1)
left unchanged. No Critical findings: no data leak, wrong saved money figure or crash on a core path.

| Severity | Fixed | NEEDS OWEN |
| --- | --- | --- |
| High (2) | 1 — QA-004 pre-app fields had no accessible names, incl. SSN/bank | 1 — QA-001 open redirect on `/auth/confirm` |
| Medium (5) | 5 — QA-003 price `0x10` saved as $16 · QA-005 unlabeled import inputs · QA-007 AA contrast tokens · QA-008 raw "non-2xx" text when a function is down · QA-010 payout column clipped on phones | — |
| Low (4) | 3 — QA-002 cart quantity → raw Postgres error · QA-006 invalid `<dl>` · QA-009 print toolbar overflow | 1 — QA-011 login tab order |

**Read first:** QA-001 (open redirect — fix suggested, auth code not changed) and QA-007 (it changes three
colour tokens away from the hexes annotated as the design spec; one-commit revert if unwanted).

**Final verification (after all commits):** `npm run build` ✓ · `npm run lint` ✓ · `npx tsc --noEmit` ✓ ·
`npm test` **1374/1374** (baseline 1365; +9 new unit tests) · `npm run test:live` **209/209** ·
`npm run test:e2e` **180/180** (baseline 164; +16 new specs in `e2e/qa/`, two of which are `test.fail()`
repros for the NEEDS OWEN items and will turn red once those are fixed — then delete the annotation).
A re-crawl of every route at 1440px after the fixes shows zero axe serious/critical violations, zero console
errors and no horizontal overflow; the 390/768 crawl's only overflows were QA-009/QA-010.

**How to review:** `git log --oneline responsive-shell..qa-sweep` — one commit per finding, subject
`qa(<area>): …`, each containing its failing-first spec, the fix and its report entry. `git show <hash>`
per row of the table below. Exploratory scripts (not part of the suites) are in `qa/explore/`; run with
`npx playwright test -c qa/playwright.qa.config.ts qa/explore/<name>.explore.ts`. Screenshots/JSON from
the crawls are in `qa/screens/` (git-excluded, local only). The progress journal is `qa/QA-LOG.md`.

**Housekeeping:** added devDependency `@axe-core/playwright@4.12.1` (exact pin; no transitive change).
QA data created during exploration was removed by `qa/explore/cleanup.explore.ts`. No dev server left
running; the `supabase functions serve` that was already running when the sweep started was left alone.

## Baseline (2026-10-09, before any change, `qa-sweep` @ b85d064)

| Check | Result |
| --- | --- |
| `npm run build` | pass |
| `npm run lint` | pass |
| `npx tsc --noEmit` | pass |
| `npm test` | 61 files, 1365/1365 pass |
| `npm run test:live` | 11 files, 209/209 pass |
| `npm run test:e2e` | 164/164 pass (6.8 min) |

## Tooling added
- devDependency `@axe-core/playwright@4.12.1`, pinned exact so it uses the
  `axe-core@4.12.1` already in the lockfile (the unpinned latest dragged
  `axe-core` to 4.13.0 — a transitive upgrade, so it was backed out).
- `qa/playwright.qa.config.ts` + `qa/explore/*.explore.ts`: exploratory crawlers that
  record observations (route matrix, console, failed requests, overflow, axe) to
  `qa/screens/` (git-excluded). NOT part of `npm run test:e2e`.
  Run: `npx playwright test -c qa/playwright.qa.config.ts`.
- `e2e/qa/`: one regression spec per finding — these ARE part of `npm run test:e2e`.

## Findings

Severity: **Critical** (data leak / money wrong / crash on a core path) · **High** ·
**Medium** · **Low**. Status: commit hash, **NEEDS OWEN**, or **DECISION**.

| ID | Sev | Area | Finding | Status |
| --- | --- | --- | --- | --- |
| QA-001 | High | Auth | `/auth/confirm` redirects to any `next=` URL after a valid OTP (open redirect) | NEEDS OWEN (repro 20e065a) |
| QA-002 | Low | Proposals | Quantity > 2,147,483,647 is priced and Save is enabled; Save then shows raw Postgres `out of range for type integer` | dd95e78 |
| QA-003 | Medium | Products | List price `0x10` saved as $16.00, `1e3` as $1,000.00 (Number() reads JS literals) | 917f5ad |
| QA-004 | High | Pre-apps / a11y | No pre-app wizard field had an accessible name — incl. SSN, routing, account, RP password (axe `label`/`select-name` critical) | 0ebb211 |
| QA-005 | Medium | Payouts / Users / a11y | File inputs on `/payouts/import` and `/admin/users/import` have no accessible name (axe `label` critical) | cd48eec |
| QA-006 | Low | Proposals / a11y | Cart totals `<dl>` contains a bare `<p>` (axe `definition-list` serious) | b27c9f4 |
| QA-007 | Medium | Design tokens / a11y | `--muted-foreground` 3.0–3.4:1, `--success` 2.9:1, `--neutral` 4.0:1 on their surfaces — axe `color-contrast` on every route | 3f14ab1 |
| QA-008 | Medium | Error states | A down/unreachable Edge Function shows supabase-js's raw "Edge Function returned a non-2xx status code" / "Failed to send a request…" | 0603e8d |
| QA-009 | Low | Print pages / layout | At 390px the blank application's control row overflows 32px (Print button off-screen); merchant print uses the same row | 12d9af3 |
| QA-010 | Medium | Payouts / layout | At 390px the payout summary table pushes the page wide and clips the Payout column at the card edge | 9678877 |
| QA-011 | Low | Auth / keyboard | On `/auth/login`, Tab from Email lands on "Forgot your password?" instead of Password; a keyboard login ends on /auth/forgot-password | NEEDS OWEN (repro 3a16ee3) |
6.00, `1e3` as | QA-002 | Low | Proposals | Quantity > 2,147,483,647 is priced and Save is enabled; Save then shows raw Postgres `out of range for type integer` | dd95e78 |
,000.00 (Number() reads JS literals) | 917f5ad |

## Details

### QA-002 — cart quantity beyond the `int` column (Low, proposals)
- **Repro:** `/proposals/new` as an agent → Not in the CRM → add a device → type `3000000000`
  in its quantity → totals read `$1,200,000,000,000.00`, Save is enabled; Save prints
  `value "3000000000" is out of range for type integer`. Spec `e2e/qa/proposal-quantity-ceiling.spec.ts`.
- **Root cause:** `cartProblem()` (lib/quotes.ts) mirrors the RPC's refusals but not the
  column type's ceiling, so the Save button had no reason to disable itself.
- **Fix:** `MAX_LINE_QUANTITY` (int4 max) checked in `cartProblem()`; unit case added in
  `tests/unit/quote-cart.test.ts`. The RPC/DB remain the boundary — this only stops the raw
  error reaching the rep. The cap is the column's own limit, not a business rule.

### QA-003 — list price parsed as a JavaScript literal (Medium, products)
- **Repro:** `/admin/products/<brand>` → Add product → List price `0x10` → saved and shown as
  `$16.00`; `1e3` → `$1,000.00`. A mistyped price became a different, plausible price that
  then flows onto proposals. Spec `e2e/qa/product-price-parse.spec.ts`.
- **Root cause:** `parsePriceInput()` (lib/products.ts) stripped `$ , space` and handed the
  rest to `Number()`, which accepts hex/binary/octal/exponent literals.
- **Fix:** a plain-decimal regex before `Number()` (the same approach `parseFigureInput()` in
  lib/payouts.ts already takes). Unit tests in `tests/unit/product-price-input.test.ts`.

### QA-004 — pre-app wizard labels not associated with inputs (High, accessibility)
- **Repro:** `/pre-apps/<id>/edit?step=business` (and owners/terminal/profile/secrets) → axe
  reports `label` (critical) on every input and `select-name` on Billing type. A screen reader
  announces "edit text" for DBA name, SSN, routing and account number alike; clicking a label
  focuses nothing. Spec `e2e/qa/pre-app-labels.spec.ts`.
- **Root cause:** the four per-step `Field` helpers render `<Label>` as a sibling of the control
  with no `htmlFor`/`id`; `secrets-step.tsx` hand-writes the same shape.
- **Fix:** each `Field` generates an id (`useId`) and puts it on its single child unless the child
  already has one, with `htmlFor` on the label (plus an explicit `htmlFor` for the datalist-backed
  Entity type). Secrets step: explicit id/htmlFor pairs. Markup only — no data or validation path touched.

### QA-005 — unlabeled import file inputs (Medium, accessibility)
- **Repro:** axe on `/payouts/import` or `/admin/users/import` as admin → `label` (critical) on
  `.border-input`; a screen reader hears only "Choose File". Spec `e2e/qa/upload-labels.spec.ts`.
- **Root cause:** the heading above each input is a `<p>`, and the `<Input type="file">` has no
  label or `aria-label` (the documents and marketing uploads do label theirs).
- **Fix:** `aria-label` on both inputs ("Residual report (XLSX)", "Rep list (CSV)"). No visual change.

### QA-006 — invalid definition list in the proposal cart (Low, accessibility)
- **Repro:** axe on `/proposals/new` (agent or admin) → `definition-list` (serious). Spec
  `e2e/qa/proposal-totals-markup.spec.ts`.
- **Root cause:** `components/quote-store.tsx` put the "Prices are taken from the catalog…" `<p>`
  inside the totals `<dl>`.
- **Fix:** the flex row is now a `<div>`; the two dt/dd pairs sit in a `<dl className="contents">`
  and the note is its sibling. Layout unchanged (`display: contents`); quote-store e2e (incl.
  the 375/768/1440 overflow checks) green.

### QA-007 — text tokens below WCAG AA contrast (Medium, accessibility)
- **Repro:** axe `color-contrast` (serious) flagged every route in the crawl, signed in or not.
  Measured: `--muted-foreground` #8A8A93 = 3.42:1 on white, 3.27:1 on #FAFAFA, 3.03:1 on the
  #F1F1F3 chips; status `--success` #16A34A = 2.95:1 on its badge background; `--neutral`
  #777777 = 3.96:1 on its badge. Spec `e2e/qa/color-contrast.spec.ts` (login, leads, tasks, new lead).
- **Root cause:** token values in `app/globals.css`.
- **Fix:** same hues, darkened only as far as AA on the darkest surface each sits on:
  muted-foreground → `240 4% 44%` (#6C6C75, ≥4.6:1), success → `142 76.2% 27%` (#107937, 4.9:1),
  neutral → `0 0% 42%` (#6B6B6B, 4.7:1). The dark sidebar had been borrowing `text-muted-foreground`
  (fine there at 5.6:1, but it would have dropped to 3.7:1), so it gets its own `--sidebar-muted`
  token at the **old** value — the sidebar looks exactly as before.
- **Owen:** these hexes were annotated as matching a design spec. If the spec values are wanted
  back, revert this one commit; the spec will then go red, which is the point.

### QA-008 — raw supabase-js text when a function is down (Medium, error states)
- **Repro:** agent on a lead with a document; make `create-download-url` answer `503 text/plain`
  (or refuse the connection) → under Download: "Edge Function returned a non-2xx status code"
  (or "Failed to send a request to the Edge Function"). Spec `e2e/qa/function-down-message.spec.ts`
  (uses `page.route`, so the real functions stay up).
- **Root cause:** `edgeFunctionErrorMessage()` (lib/edge-functions.ts) correctly reads a JSON
  `{ error }` body, but when there is none it returned `error.message` — supabase-js's fixed
  transport string — instead of the readable `fallback` every caller passes.
- **Fix:** for supabase-js `Functions*Error`s with no body message, return the caller's fallback.
  Affects every function caller (documents, marketing, secrets, admin users, residuals, imports).
  Unit tests `tests/unit/edge-function-errors.test.ts`; documents-panel e2e still green.

### QA-009 — print control row overflows on a phone (Low, layout)
- **Repro:** `/pre-apps/blank-form` at 390×844 → page scrollWidth 422; the Print button ends at
  x=422. Found by the viewport crawl. Spec `e2e/qa/print-pages-phone-width.spec.ts` (QA-009 case).
- **Root cause:** the screen-only row is `flex justify-between` with a `shrink-0` pair of controls
  and no wrap, so title + controls cannot be narrower than their sum. `/merchants/[id]/print`
  has the identical row (it fits today only because the fixture DBA is short).
- **Fix:** `flex-wrap` on both rows — on a phone the controls drop below the title. Print output
  is untouched (`print:hidden`); print.spec.ts green.

### QA-010 — payout summary clips the Payout column on a phone (Medium, layout / money)
- **Repro:** agent → `/payouts/2027-04/summary/<own id>` at 390×844 → page scrollWidth 422; the
  Payout figures render as "$247.5" with the rest off the card. A rep checking their statement on
  a phone cannot read the one number it exists for. Spec `e2e/qa/print-pages-phone-width.spec.ts`.
- **Root cause:** six-column `<table className="w-full">` with no horizontal scroll container.
- **Fix:** wrapped in `overflow-x-auto print:overflow-visible` — scrolls sideways on screen, prints
  exactly as before. print.spec.ts and payouts-rendering.spec.ts green.

## NEEDS OWEN6.00`; `1e3` → `
## NEEDS OWEN,000.00`. A mistyped price became a different, plausible price that
  then flows onto proposals. Spec `e2e/qa/product-price-parse.spec.ts`.
- **Root cause:** `parsePriceInput()` (lib/products.ts) stripped `$ , space` and handed the
  rest to `Number()`, which accepts hex/binary/octal/exponent literals.
- **Fix:** a plain-decimal regex before `Number()` (the same approach `parseFigureInput()` in
  lib/payouts.ts already takes). Unit tests in `tests/unit/product-price-input.test.ts`.

## NEEDS OWEN

### QA-001 — open redirect on `/auth/confirm` (High, auth)
- **Repro:** generate a magic link for any account (`auth.admin.generateLink`), then
  `GET /auth/confirm?token_hash=<hash>&type=magiclink&next=https://example.com/phish`
  → `307 Location: https://example.com/phish`, with the session cookie set.
  Spec: `e2e/qa/auth-confirm-redirect.spec.ts` (`test.fail()` — goes red once fixed; then drop the annotation).
- **Root cause:** `app/auth/confirm/route.ts` passes `searchParams.get("next")` straight to
  `redirect()` (starter-kit code). The error branch also interpolates `error.message`
  into the query string without `encodeURIComponent`.
- **Suggested fix (not applied — auth flow):** accept `next` only when it starts with a single
  `/` and not `//` or `/\`; otherwise fall back to `/dashboard`. Encode the error message.

### QA-011 — login tab order skips the password box (Low, auth / keyboard)
- **Repro:** `/auth/login`, focus Email, type, press Tab → focus is on the "Forgot your password?"
  link. Type the password, press Enter → `/auth/forgot-password`. Spec
  `e2e/qa/login-tab-order.spec.ts` (`test.fail()`).
- **Root cause:** `components/login-form.tsx` (starter-kit layout) renders the link inside the
  Password label row, before the `<input id="password">` in DOM order.
- **Suggested fix (not applied — login form):** move the link after the password input in the
  DOM (it can stay visually beside the label with `order`/grid), or give it `tabIndex={-1}`
  and repeat it below the button.

## DECISIONS (observed, deliberately not changed)

- **D-01 (auth wording).** A deactivated rep whose GoTrue ban is in place sees GoTrue's raw
  `User is banned` under the login form; one whose profile is inactive but who is not banned
  gets the friendly `/auth/error?error=account-deactivated` page. Same state, two wordings.
  Mapping the GoTrue message in `components/login-form.tsx` would be a one-liner, but it is
  login-flow copy, so left for Owen.
- **D-02 (auth).** `/auth/error?error=no-profile` and `…=account-deactivated` offer no sign-out
  control. The user is not trapped (they can visit `/auth/login` and sign in as someone else),
  but the session stays live in that browser.
- **D-03 (auth).** A signed-in user who opens `/auth/login` gets the login form rather than a
  redirect to `/dashboard`; and a signed-out user sent to `/auth/login` from a deep link is
  always taken to `/dashboard` after signing in (no return-to). Both are workflow choices.
- **D-04 (notifications).** A rep's bell lists "New ghost sheet" / "New support ticket" for records
  the rep created themselves. Useful for an admin; arguably noise for the creator.
- **D-05 (error copy).** About 30 client components still show a PostgREST/RPC `error.message`
  verbatim (`grep -rn "error.message" components app`). Many RPCs raise deliberate human-readable
  messages, so this is mostly fine, but a constraint violation there reads as Postgres text. Only
  the concrete cases I could reach as a user were fixed (QA-002, QA-008); a sweep would be a refactor.
- **D-06 (tap targets).** The complete-task checkboxes on `/tasks` are 16×16px. They meet
  WCAG 2.2 AA 2.5.8 via its spacing exception, so not a defect, but small on a phone.
- **D-07 (forms).** Refreshing a half-filled form loses the input; Back after creating a lead returns
  to a still-filled `/leads/new` (a second Create is caught by the duplicate warning, not prevented).
- **D-08 (residuals).** Uploading a non-spreadsheet or empty `.xlsx` gives a clear "missing columns"
  message but leaves a 0-row batch in **Review** on the import list until an admin discards it.
- **D-09 (proposals).** `/proposals?rep=<other rep>` as an agent silently shows the agent's own list
  (RLS-correct; the rep filter is admin-only UI). `/leads` has no `?q=` search (global search covers it).

## Observations (not reproducible / not defects)

- **OBS-1 (hydration warning, dev).** Once per long scripted flow (create leads → convert ghost sheet →
  open `/merchants/new` at 390px), the dev console logged React's "A tree hydrated but some attributes
  of the server rendered HTML didn't match". Direct and sequenced visits to the same pages (both roles,
  both widths) never reproduced it, and React truncated the diff. Three attempts, then moved on.
  Likely dev-server/HMR transient; worth a glance if it shows up in production logs.
- Areas checked with no defect found: role/route matrix for 66 routes × admin/agent/anon; cross-rep
  direct ids for leads, merchants, pre-apps, tickets, ghost sheets, proposals (incl. `?quote=` and old
  print URLs) → not-found; admin pages redirect agents; inactive / banned / no-profile / must-change-password
  / garbage-cookie sessions; double-click save on proposals and leads (one row each); brand duplicate
  name/case, rename-to-existing, duplicate SKU, delete hidden while products exist; pre-app wizard end to
  end with fake SSN/routing/account (encrypted, only last-4 shown, survives reload); ticket replies;
  ghost-sheet convert; dashboard counts equal to direct DB counts for agent and admin; global search with
  quotes/`%`/HTML/300-char input; create user / taken agent # / duplicate email / reset / deactivate;
  empty states for a brand-new rep; residual export as agent.
