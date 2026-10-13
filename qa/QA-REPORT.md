# QA sweep report — TapSwipe CRM

## Summary

Unattended sweep, 2026-10-09, branch **`qa-sweep`** (13 commits on top of `responsive-shell` @ b85d064,
**not pushed, not merged**). Local stack only — no hosted project, Vercel, migration, RLS policy, grant,
definer function, auth flow or price-lock trigger was touched.

**11 findings — all 11 fixed** (9 in the sweep; QA-001 and QA-011 were NEEDS OWEN and were fixed on
2026-10-13 at Owen's request, commits afc4beb and 32d48ad — see "Fixed on review" below), plus
**9 DECISIONS** (D-01…D-09) and **1 observation** (OBS-1) left unchanged. No Critical findings: no data
leak, wrong saved money figure or crash on a core path.

| Severity | Fixed | NEEDS OWEN |
| --- | --- | --- |
| High (2) | 2 — QA-004 pre-app fields had no accessible names, incl. SSN/bank · QA-001 open redirect on `/auth/confirm` (2026-10-13) | — |
| Medium (5) | 5 — QA-003 price `0x10` saved as $16 · QA-005 unlabeled import inputs · QA-007 AA contrast tokens · QA-008 raw "non-2xx" text when a function is down · QA-010 payout column clipped on phones | — |
| Low (4) | 4 — QA-002 cart quantity → raw Postgres error · QA-006 invalid `<dl>` · QA-009 print toolbar overflow · QA-011 login tab order (2026-10-13) | — |

**Read first:** QA-007 (it changes three colour tokens away from the hexes annotated as the design spec;
one-commit revert if unwanted).

**Verification after the 2026-10-13 fixes:** `npm run build` ✓ · `npm run lint` ✓ · `npx tsc --noEmit` ✓ ·
`npm test` **1401/1401** (64 files; +27 `safe-redirect` cases) · `npm run test:live` **209/209** ·
`npm run test:e2e` **190/190** (8.3 min; incl. the 5 setup; +10: QA-001 now 8 specs, QA-011 now 4,
neither `test.fail()` any more).

**Final verification of the original sweep (2026-10-09):** `npm run build` ✓ · `npm run lint` ✓ · `npx tsc --noEmit` ✓ ·
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
| QA-001 | High | Auth | `/auth/confirm` redirects to any `next=` URL after a valid OTP (open redirect) | afc4beb (repro 20e065a) |
| QA-002 | Low | Proposals | Quantity > 2,147,483,647 is priced and Save is enabled; Save then shows raw Postgres `out of range for type integer` | dd95e78 |
| QA-003 | Medium | Products | List price `0x10` saved as $16.00, `1e3` as $1,000.00 (Number() reads JS literals) | 917f5ad |
| QA-004 | High | Pre-apps / a11y | No pre-app wizard field had an accessible name — incl. SSN, routing, account, RP password (axe `label`/`select-name` critical) | 0ebb211 |
| QA-005 | Medium | Payouts / Users / a11y | File inputs on `/payouts/import` and `/admin/users/import` have no accessible name (axe `label` critical) | cd48eec |
| QA-006 | Low | Proposals / a11y | Cart totals `<dl>` contains a bare `<p>` (axe `definition-list` serious) | b27c9f4 |
| QA-007 | Medium | Design tokens / a11y | `--muted-foreground` 3.0–3.4:1, `--success` 2.9:1, `--neutral` 4.0:1 on their surfaces — axe `color-contrast` on every route | 3f14ab1 |
| QA-008 | Medium | Error states | A down/unreachable Edge Function shows supabase-js's raw "Edge Function returned a non-2xx status code" / "Failed to send a request…" | 0603e8d |
| QA-009 | Low | Print pages / layout | At 390px the blank application's control row overflows 32px (Print button off-screen); merchant print uses the same row | 12d9af3 |
| QA-010 | Medium | Payouts / layout | At 390px the payout summary table pushes the page wide and clips the Payout column at the card edge | 9678877 |
| QA-011 | Low | Auth / keyboard | On `/auth/login`, Tab from Email lands on "Forgot your password?" instead of Password; a keyboard login ends on /auth/forgot-password | 32d48ad (repro 3a16ee3) |

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

## Fixed on review (2026-10-13) — formerly NEEDS OWEN

Both fixed at Owen's request, local only (no push, deploy or `db push`).

### QA-001 — open redirect on `/auth/confirm` (High, auth) — afc4beb
- **Repro:** generate a magic link for any account (`auth.admin.generateLink`), then
  `GET /auth/confirm?token_hash=<hash>&type=magiclink&next=https://example.com/phish`
  → `307 Location: https://example.com/phish`, with the session cookie set.
- **Root cause:** `app/auth/confirm/route.ts` passed `searchParams.get("next")` straight to
  `redirect()` (starter-kit code).
- **Every user-controlled return target in the app** (searched `next`, `redirect`, `redirectTo`,
  `returnTo`, `callbackUrl`, `continue` across route handlers, server actions, the proxy, the login
  page, `router.push`, `window.location` and `Location` headers): only two exist —
  `/auth/confirm` `next`, and `components/new-user-form.tsx` `returnTo` (already narrowed to
  `/payouts/import/<id>` by a regex). There are no server actions; the login form always goes to
  `/dashboard`; the proxy's redirects are fixed paths; every `router.push` / `location.assign` is
  built from server data or constants; `forgot-password-form` builds its `redirectTo` from
  `window.location.origin`.
- **Fix:** `lib/safe-redirect.ts` `safeNextPath(raw, fallback)` — returns `raw` only if it starts
  with a single `/` (not `//`), has no backslash or control character (C0, DEL, C1) in the raw,
  once-decoded or twice-decoded form, and resolving it against `http://x.invalid` keeps that
  origin. Used at both sites (`returnTo` keeps its narrower regex after the shared check).
  Fallback for `/auth/confirm` stays `/` (the proxy sends that on to `/dashboard`).
- **Tests:** `tests/unit/safe-redirect.test.ts` (27 cases: the 17 brief cases plus double-encoded
  and newline variants fall back; `/leads/123?tab=a`, `/ok?x=https://evil.com`, `/proposals/new`,
  `/search?q=100%25`, `/auth/update-password` allowed). `e2e/qa/auth-confirm-redirect.spec.ts` no
  longer `test.fail()`: four off-site shapes through the real route, plus the legitimate landings —
  magic link with `next=/leads?status=new` and with no `next`, recovery to `/auth/update-password`
  through to a new password that then signs in, and invite to `/auth/update-password`.
  **Non-vacuous:** with the helper short-circuited to `return raw`, 20 unit cases and all 4
  off-site e2e cases went red; reverted.
- **Not changed (out of scope, noted):** the error branch still interpolates `error.message`
  unencoded into `/auth/error?error=…`. It is a same-origin path, not a redirect target, so not
  an open redirect. There is no post-login return-to (D-03) and no invite UI in the app — the
  invite/recovery cases cover what an email template pointing at `/auth/confirm` would send.
  The app's own forgot-password flow uses GoTrue's `redirectTo` (PKCE `?code=`), not `next`.

### QA-011 — login tab order skips the password box (Low, auth / keyboard) — 32d48ad
- **Repro:** `/auth/login`, focus Email, type, press Tab → focus is on the "Forgot your password?"
  link. Type the password, press Enter → `/auth/forgot-password`.
- **Root cause:** `components/login-form.tsx` (starter-kit layout) rendered the link inside the
  Password label row, before the `<input id="password">` in DOM order.
- **Fix:** the form body is one grid; DOM order is Email, Password, Login, Forgot your password?,
  and the link is placed beside the Password label with `col-start-2 row-start-3`. No `tabIndex`.
  Spacing unchanged. The other auth forms (forgot-password, update-password) already put their
  link after the submit button; there is no accept-invite page and no show-password toggle.
- **Tests:** `e2e/qa/login-tab-order.spec.ts` no longer `test.fail()`; adds the full tab sequence,
  a keyboard-only login reaching `/dashboard`, and a geometric check that the link is on the
  label's row. Against the old form the three order specs go red and the placement spec stays
  green (it guards the layout, not the order).

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

## Run 2 — Owen's follow-up list (2026-10-13, unattended)

### A1 — list price read a decimal comma as thousands (Medium, products)
- **Was:** `parsePriceInput()` stripped commas anywhere, so `12,99` was saved as $1,299.00.
- **Now:** optional `$` and surrounding whitespace, then only `^\d+(\.\d{1,2})?$` or
  `^\d{1,3}(,\d{3})+(\.\d{1,2})?$`. A misplaced comma says "Use a period for decimals, for example
  12.99"; three or more decimals, negatives and the column ceiling keep their own messages; anything
  else is "That is not a number." Unit cases for every accept/reject in the brief plus `$ 12.99`,
  `1,234,567.89`, `€12,99`, `1 299`, `$$12`, `12$`, `12.`; e2e `e2e/qa/product-price-parse.spec.ts`
  types `12,99` and asserts the message and that nothing was saved (red on the old parser).
- **Changed behaviour to note:** `.5` was accepted before and is now refused ("That is not a
  number."), because the brief requires digits first. The old unit assertion was moved, not dropped.
  An inner space (`1 299`) is also refused now; only surrounding whitespace is trimmed.
- **Other places money/quantity text is parsed (not changed):**
  | Where | Comma behaviour | Why not changed |
  | --- | --- | --- |
  | `lib/payouts.ts` `parseFigureInput()` (payout residual/split cells) | strips commas anywhere — **same bug**: `12,99` → 1299 | payouts are out of bounds for this run (hard rule); see D-10 |
  | `supabase/functions/_shared/residuals.ts` cell coercion (residual import) | strips commas anywhere | residual import is out of bounds; cells are usually numeric, not text; see D-10 |
  | `lib/masks.ts` `maskMoney()` (pre-app est. volume/ticket fields) | drops every non-digit at keystroke time, so typing `12,99` shows `1299` while you type | a mask, not a parser: the figure is visible as it is typed. Same fix would need caret work; listed for Owen (D-10) |
  | `lib/masks.ts` `maskPercent()` (pre-app splits/ownership/tax) | same, digits and one `.` only | as above |
  | pre-app step `Number(value)` coercions (business/owners/profile/terminal) | input already masked, so no comma reaches them | n/a |
  | `components/merchant-form.tsx` split %, `components/quote-store.tsx` quantity | `type="number"` inputs — the browser refuses a comma (value becomes empty) | n/a |

### A2 — sensitive pre-app inputs offered autofill/autocorrect (Low, pre-apps)
- **Was:** SSN, ABA routing and account inputs set no `autocomplete`, so a browser could remember a
  merchant's SSN and offer it later; phone keyboards could autocorrect/capitalise them.
- **Now:** one `SENSITIVE_NUMBER_INPUT` constant in `components/pre-app-steps/secrets-step.tsx`
  (`autoComplete="off"`, `spellCheck={false}`, `autoCorrect="off"`, `autoCapitalize="off"`,
  `inputMode="numeric"`) spread onto those three. RP password keeps `autoComplete="new-password"`.
- **Test:** `e2e/qa/pre-app-sensitive-inputs.spec.ts` seeds an owner on the agent's fixture pre-app
  (the SSN input does not render without one) and asserts all five attributes on all three inputs,
  and `new-password` on RP password. Red before the change (SSN had `autocomplete=""`), green after.

### A3 — /auth/confirm put GoTrue's message in the URL; /auth/error echoed it (Low, auth)
- **Was:** `redirect(\`/auth/error?error=${error?.message}\`)` unencoded, and `/auth/error` printed any
  unknown `?error=` as "Code error: …" — so a link to our own domain could carry any sentence
  (React escaped it, so text spoofing rather than script). `?error=constructor` also matched
  Object's prototype and was echoed under "Code:".
- **Now:** the route sends fixed codes only — `link-invalid` (verify failed; GoTrue's message goes to
  the server log) and `link-incomplete` (no token/type) — each with its own explanation on
  `/auth/error`. Unknown values get a generic sentence and are never shown. Lookup uses
  `Object.hasOwn`. Fixed codes exceed "encodeURIComponent at minimum": no message is in the URL at all.
- **Test:** `e2e/qa/auth-error-copy.spec.ts` — a `?error=` holding quotes, `<b>`, `&` and a newline
  is not echoed and not parsed as markup; known codes keep their words; bad token → exactly
  `/auth/error?error=link-invalid`; missing token → `link-incomplete`; prototype key. Four red
  before the change; the prototype spec red with only the `hasOwn` guard reverted.

### B1 (D-01) — banned login showed GoTrue's raw "User is banned" (Low, auth)
- **Now:** `lib/auth-copy.ts` `ACCOUNT_DEACTIVATED` (`title`, `remedy`) is the one copy; `/auth/error`'s
  account-deactivated entry is built from it, and `components/login-form.tsx` shows
  "This account has been deactivated. An admin can turn it back on." when GoTrue returns
  `code === "user_banned"` (message `User is banned` as fallback). No new wording. Every other sign-in
  error is passed through unchanged — GoTrue's generic "Invalid login credentials".
- **Test:** `e2e/qa/login-errors.spec.ts` — banned user sees the deactivated words and not GoTrue's;
  inactive-but-unbanned user lands on `/auth/error?error=account-deactivated` with the same title and
  remedy; a wrong password on a real account and an unknown address render identical text that names
  no account state. Banned spec red before, green after.
- **Limit (D-11):** GoTrue returns `user_banned` for a banned account *whatever password is sent*
  (measured), so the response already says the address exists; the UI can't change that.

### B2 (D-02) — no sign-out on /auth/error's signed-in dead ends (Low, auth)
- **Now:** `components/logout-button.tsx` keeps one sign-out (`useLogout()`: `supabase.auth.signOut()`
  then `/auth/login`), used by the topbar icon unchanged and by a new `LogoutTextButton`. `/auth/error`
  renders it for `no-profile` and `account-deactivated` only, and only when `getClaims()` finds a session.
- **Test:** `e2e/qa/auth-error-signout.spec.ts` — for both codes, sign in, land on the error page,
  Log out → `/auth/login`, then `/dashboard` redirects to login (really signed out); signed out, neither
  page shows the control. Both sign-out specs red before; the no-session spec red with only the
  session check reverted. `e2e/logout.spec.ts` still green.

### B3 (D-06) — /tasks complete checkbox hit area (Low, tasks / touch)
- **Now:** the checkbox in `components/tasks-index-table.tsx` gets a transparent `::after`
  (`after:-inset-[15px]`) — a 44×44 hit area around the unchanged 16×16 box. (`-14px` measured 42×42:
  inset is from inside the 1px border.) Scoped to /tasks; the shared `ui/checkbox` is untouched.
- **Test:** `e2e/qa/tasks-checkbox-target.spec.ts`, agent and admin at 390×844 — every visible checkbox
  is still 16×16, `elementFromPoint` lands on it at 25 points across the 44×44 square, and the square
  intersects no other reachable control (Radix's aria-hidden, pointer-events:none bubble input excluded).
  Red before (hit-area misses), green after.

### B4 (D-08) — a refused residual file left a 0-row batch in Review (Low, residuals)
- **Now (`components/residual-upload.tsx`):** an empty file is refused before any batch is created
  ("That file is empty."). A non-empty file can only be judged by the parser (SheetJS is in the
  function, not the browser bundle), so when `parse-residual-import` answers **400** — not a
  spreadsheet, no sheets, missing columns — the batch is abandoned through `abandonResidualBatch()`
  (`lib/residual-batches.ts`), now the single path also used by the Abandon button; the message ends
  "No batch was kept in Review." Other failures (5xx, no response, upload error) still leave the batch
  in Review for Re-parse, as before. `invokeEdgeFunction()` now also returns the HTTP `status` (additive;
  unit-tested). No parsing or payout logic changed.
- **Test:** `e2e/qa/residual-bad-import.spec.ts` — empty → message and no batch row at all; text file
  named `.xlsx` and a workbook missing columns → status `abandoned`, none in `review`; a valid workbook →
  its review screen with one staged row, as before. Three red before; the two abandon specs red with
  only the abandon call removed.
- **Edge function redeploy: not needed.** Client-only change; both functions are unchanged.

### B5 (D-04) — bell lists the user's own new records — **no change**
- The brief allowed a read-side filter only if the rows record the actor. They do not: there is no
  notifications table (the bell derives items from `support_tickets` / `ghost_sheets.created_at`), and
  neither table has a created-by column — `agent_id` is the **owner**, and an admin can create a row
  *for* a rep (exactly the case the rep should be told about), so filtering on `agent_id` would hide
  the wrong items. The only record of a cross-agent author is `audit_log`, which agents cannot read.
  `lib/notifications.ts` already says the fix is a created-by column, i.e. a migration. Left for Owen.

### C1a (D-03) — return to the deep-linked page after sign-in (auth)
- **Now:** when the proxy sends a signed-out user to `/auth/login`, it adds `?next=<path+query>`
  (Next's `_rsc` dropped; nothing added when the target is `/dashboard`). The login form pushes
  `postLoginPath(window.location.search)`. Both ends are `lib/login-redirect.ts`, both call
  `safeNextPath()`, and both fall back to `/dashboard`. Read from `window.location` at submit time so
  the form needs no Suspense boundary under `cacheComponents`.
- **Test:** `tests/unit/login-redirect.test.ts` (34) — QA-001's bypass table (plus `/%252F/…`) against the
  form side and, for the ones that are paths, against the proxy side (a request path can itself be
  `//evil.com`); `_rsc` stripping. `e2e/qa/login-return-to.spec.ts` — `/leads?status=new` signed out →
  `/auth/login?next=%2Fleads%3Fstatus%3Dnew` → sign in → back on `/leads?status=new`; plain login →
  `/dashboard`; five hostile `next` values through the real form → `/dashboard`. **Non-vacuous:** with
  the form following `next` raw, all five hostile specs went red; with the helper bypassed, 26 unit cases.

### C1b (D-03) — a signed-in user opening /auth/login is sent on (auth)
- **Now:** in `lib/supabase/proxy.ts`, after `getClaims()`, a signed-in user requesting `/auth/login`
  whose profile reads `is_active = true` is redirected to `postLoginPath(search)` — a safe `?next=` or
  `/dashboard` — with the refreshed cookies copied as on the `/` branch. Inactive, profile-less or
  unreadable profiles get the form: that is the loop guard (`/dashboard` sends those users to
  `/auth/error`, so bouncing them back would leave no way to sign in as someone else).
- **Test:** `e2e/qa/login-signed-in-redirect.spec.ts` — active agent → `/dashboard`; `?next=%2Fleads` →
  `/leads`; hostile `next` → `/dashboard`; inactive, no-profile, and deactivated-mid-session
  (banned + inactive, valid JWT still in the browser) each reach their page and then get `/auth/login`
  with a **200** (no redirect at all). Active specs red before; with the guard loosened to "any
  signed-in user", all three must-reach-the-form specs went red.
- **Existing spec updated (stricter):** `e2e/logout.spec.ts` now expects
  `/auth/login?next=%2Fmerchants` exactly after sign-out (separate commit).
- **Note:** a ban *without* `is_active = false` and a still-valid JWT would be redirected to the app,
  as it would be for any page today; `deactivate-user` always sets both, so that state is not reachable
  through the app.
