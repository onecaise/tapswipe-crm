# QA sweep report — TapSwipe CRM

_Summary is written at the end of the sweep (see FINISH in qa/QA-LOG.md)._

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
| QA-003 | Medium | Products | List price `0x10` saved as | QA-002 | Low | Proposals | Quantity > 2,147,483,647 is priced and Save is enabled; Save then shows raw Postgres `out of range for type integer` | dd95e78 |
| QA-004 | High | Pre-apps / a11y | No pre-app wizard field had an accessible name — incl. SSN, routing, account, RP password (axe `label`/`select-name` critical) | __HASH__ |
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
  `
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
