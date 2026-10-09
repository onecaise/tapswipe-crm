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
- [ ] 0. Setup: branch, qa/ files, exclude qa/screens
- [ ] 0. Baseline: build, lint, tsc, npm test, test:live, test:e2e
- [ ] 1. Auth & roles (route matrix, cross-rep direct ids, admin-only pages)
- [ ] 2. Money (proposals, products/brands, residuals)
- [ ] 3. Data capture (leads, ghost sheets, merchants, pre-apps, docs, marketing, tickets, tasks, timeline, dashboard, search)
- [ ] 4. Admin (create user, deactivate, reset password, import)
- [ ] 5. Cross-cutting (viewports, console, axe, keyboard, edge input)
- [ ] FINISH: full suites, report summary

## Journal
