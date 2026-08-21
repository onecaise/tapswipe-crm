import { defineConfig, devices } from "@playwright/test";

/**
 * The e2e suite: a real browser against the app running on the local stack.
 *
 * This is the FOURTH suite, and it exists for the same reason CLAUDE.md gives
 * for there being three rather than one — each covers what the others
 * structurally cannot. Concretely, the payouts pass found three bugs that no
 * other suite could have caught:
 *
 *   * an editable cell going stale when its value changed from outside it.
 *     Needs a live reconciler: renderToStaticMarkup gives one render, and a
 *     fresh render always looks right.
 *   * a long merchant name pushing six money columns out of a scrolling
 *     container. Needs layout — the DOM was correct the whole time.
 *   * a stat card clipping a figure because the next card painted over the
 *     spill. Needs paint, not markup.
 *
 * What does NOT belong here: RLS policy assertions (tests/rls), PostgREST and
 * Edge Function behaviour (tests/live), pure logic (tests/unit). Those are
 * faster and more precise where they are, and duplicating them here buys a
 * slower, flakier copy. The rule of thumb is that a spec here should be about
 * something a person could only see by looking.
 *
 * Local stack only. e2e/fixtures/seed.ts refuses a non-local API URL, and the
 * app's own lib/env-guard.ts throws at dev-server boot if it is pointed
 * anywhere else.
 */

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  // Relative to this config file. NOT import.meta.dirname: Playwright
  // transpiles the config to CJS (the vitest configs get ESM only because of
  // their .mts extension), so import.meta is a syntax error here.
  testDir: "./e2e",
  // Only .spec.ts here, and only under e2e/. vitest.config.mts includes
  // `tests/**/*.test.ts`, so the two suites cannot pick up each other's files
  // even by accident — different directory AND different suffix.
  testMatch: /.*\.spec\.ts/,

  // One app, one database, one set of fixture rows. Two files editing the same
  // period concurrently would each see the other's writes — the same reason
  // vitest.live.config.mts sets fileParallelism: false.
  fullyParallel: false,
  workers: 1,

  // Never in CI, and never locally either: a retry that passes hides exactly the
  // kind of ordering bug this suite exists to find. A flaky spec here is a bug
  // in the spec or in the app, and should be read rather than retried.
  retries: 0,

  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? "list" : [["list"], ["html", { open: "never" }]],

  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: BASE_URL,
    // Both only on failure: a passing run should leave nothing to clean up, and
    // a failing one should leave enough to diagnose without a re-run.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },

  projects: [
    // Provisions fixtures and signs each persona in ONCE, saving cookies to
    // e2e/.auth/*.json. Every other project depends on this, so no spec pays
    // for a login and none of them contain a password.
    { name: "setup", testMatch: /auth\.setup\.ts/ },

    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
    },
  ],

  // Reuses a dev server if one is already up, which it usually is during
  // development. `next dev` rather than `next start` deliberately: the specs
  // assert on behaviour, not on production bundling, and a build per run would
  // dominate the wall clock. It also means .env.development.local applies, which
  // is what points the app at the local stack.
  webServer: {
    command: "npm run dev",
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
