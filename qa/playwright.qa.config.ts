import { defineConfig, devices } from "@playwright/test";

/**
 * Exploratory QA runs (qa/explore/*.explore.ts). NOT part of `npm run test:e2e`:
 * these record observations to qa/screens/ rather than asserting, and every
 * finding they surface is reproduced as a real spec under e2e/qa/ before it is
 * fixed. Reuses the main suite's setup project for fixtures and sign-in.
 *
 *   npx playwright test -c qa/playwright.qa.config.ts
 */
export default defineConfig({
  testDir: "..",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 600_000,
  reporter: [["line"]],
  use: { baseURL: "http://localhost:3000", trace: "off", screenshot: "off", actionTimeout: 10_000, navigationTimeout: 60_000 },
  projects: [
    { name: "setup", testMatch: /e2e[\/]auth\.setup\.ts/ },
    {
      name: "explore",
      testMatch: /qa[\/]explore[\/].*\.explore\.ts/,
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
