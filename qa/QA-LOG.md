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
- [x] 3. Data capture (leads, ghost sheets, merchants, pre-apps, docs, marketing, tickets, tasks, timeline, dashboard, search)
- [x] 4. Admin (create user, deactivate, reset password, import)
- [x] 5. Cross-cutting (viewports, console, axe, keyboard, edge input)
- [x] FINISH: full suites, report summary

## Journal
- 2026-10-09T22:21 Setup done; branch qa-sweep, axe pinned.
- 2026-10-09T22:21 Baseline all green: build/lint/tsc ok, unit 1365, live 209, e2e 164.
- 2026-10-09T22:21 Area 1 done. Route matrix (crawl, 66 routes x admin/agent/anon) correct: agents get not-found on other reps' records, redirected off admin pages; anon -> /auth/login. QA-001 open redirect (NEEDS OWEN). D-01..D-03.
- 2026-10-09T22:21 Area 2 in progress: QA-002 (cart qty ceiling) and QA-003 (price parse) fixed. Brands: dup name/case, rename-to-existing, dup SKU all give friendly messages; delete hidden while products exist. Next: residual import/export.
- 2026-10-09T22:23 Area 2 done. Residual import: non-xlsx/empty files get a friendly 'missing columns' message (batch left in Review — by design). Agent export downloads residuals-2027-04.xlsx. QA exploration batches cleaned up.
- 2026-10-09T22:49 Area 3 done. Pre-app wizard walked end-to-end with fake data (autosave, sales volume, encrypt&save shows last4 only). Leads: dup warning, lost-reason required, double-submit safe. Ghost convert, ticket+reply OK with quotes/emoji/SQL/long text. Dashboard counts == DB for agent & admin. QA-004 fixed. Intermittent hydration warning on /merchants/new after a long flow - not reproducible (3 tries), logged as OBS.
- 2026-10-09T22:54 Area 4 done. Create user: taken agent# and dup email (case-insensitive) give friendly 409 messages; reset shows one-time temp password; deactivate flips is_active; own row's destructive controls disabled. User import covered by e2e/user-import.spec.ts.
- 2026-10-09T23:26 Area 5: QA-005..QA-011 done. Viewport crawl 390/768: only blank-form + payout summary overflowed (fixed). Keyboard: shell tab order + focus rings fine, drawer opens/Escape returns focus; login tab order -> QA-011 (NEEDS OWEN). Empty states fine for a new rep. Full suites after 7 fixes: unit 1374, live 209, e2e 177 pass (+2 intentionally red new specs, then fixed).
- 2026-10-09T23:49 Area 5 done. 1440 re-crawl after fixes: 0 axe serious/critical, 0 console errors, no overflow. QA data cleaned up.
- 2026-10-09T23:49 FINISH: build ok, lint ok, tsc ok, unit 1374/1374, live 209/209, e2e 180/180. 11 findings: 9 fixed, 2 NEEDS OWEN; 9 decisions; 1 observation. Not pushed.

# Run 2 — 2026-10-13, Owen's follow-up list (unattended)
Resume rule: continue at the first unchecked item. Local only; no push/deploy/db push/link.
- [x] A1 price parsing (thousands grouping, misplaced comma)
- [x] A2 sensitive pre-app field attributes
- [x] A3 /auth/confirm error branch encoding + generic /auth/error
- [x] Group A suites
- [ ] B1 D-01 banned wording on login
- [ ] B2 D-02 sign-out on /auth/error
- [ ] B3 D-06 /tasks checkbox hit area
- [ ] B4 D-08 bad residual import leaves no batch
- [ ] B5 D-04 notifications self-filter (only if actor recorded)
- [ ] Group B suites
- [ ] C1 D-03 return-to after login + signed-in /auth/login redirect
- [ ] C2 D-05 db error-code helper on busiest forms
- [ ] C3 D-07 unsaved-changes warning + router.replace after create
- [ ] C4 D-09 record as by design
- [ ] Group C suites + final summary
- 2026-10-13 A1 done (e3c4041). Docker Desktop died mid-item; restarted it (docker desktop restart). The user's functions serve died with it; started my own (bg), to be stopped at the end.
- A2 done (56ac323).
- A3 done (3250ae4).
- Group A suites: build ok, lint ok, tsc ok, unit 1404/1404, live 209/209, e2e 198/198.
