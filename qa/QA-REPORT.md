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

## Details

## NEEDS OWEN

## DECISIONS (observed, deliberately not changed)
