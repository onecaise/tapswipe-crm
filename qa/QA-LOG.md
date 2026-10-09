# QA sweep — progress journal

Branch `qa-sweep` (from `responsive-shell` @ b85d064). Started 2026-10-09.
Resume rule: read this file, continue at the first unchecked item.

## Environment notes
- Local stack was already up on start (docker, `tapswipe-crm`).
- A `supabase functions serve` (PID 22428 / npx 29888) was **already running when the sweep started** —
  started by the user, not by me. Reused rather than starting a second (two crashed each other last time).
  Not stopped at the end either, since I did not start it.
- No dev server on :3000 at start; Playwright's webServer starts/stops its own.

## Checklist
- [x] 0. Setup: branch, qa/ files, exclude qa/screens
- [x] 0. Baseline: build, lint, tsc, npm test, test:live, test:e2e
- [x] 1. Auth & roles (route matrix, cross-rep direct ids, admin-only pages)
- [x] 2. Money (proposals, products/brands, residuals)
- [ ] 3. Data capture (leads, ghost sheets, merchants, pre-apps, docs, marketing, tickets, tasks, timeline, dashboard, search)
- [ ] 4. Admin (create user, deactivate, reset password, import)
- [ ] 5. Cross-cutting (viewports, console, axe, keyboard, edge input)
- [ ] FINISH: full suites, report summary

## Journal
- 2026-10-09T22:21 Setup done; branch qa-sweep, axe pinned.
- 2026-10-09T22:21 Baseline all green: build/lint/tsc ok, unit 1365, live 209, e2e 164.
- 2026-10-09T22:21 Area 1 done. Route matrix (crawl, 66 routes x admin/agent/anon) correct: agents get not-found on other reps' records, redirected off admin pages; anon -> /auth/login. QA-001 open redirect (NEEDS OWEN). D-01..D-03.
- 2026-10-09T22:21 Area 2 in progress: QA-002 (cart qty ceiling) and QA-003 (price parse) fixed. Brands: dup name/case, rename-to-existing, dup SKU all give friendly messages; delete hidden while products exist. Next: residual import/export.
- 2026-10-09T22:23 Area 2 done. Residual import: non-xlsx/empty files get a friendly 'missing columns' message (batch left in Review — by design). Agent export downloads residuals-2027-04.xlsx. QA exploration batches cleaned up.
