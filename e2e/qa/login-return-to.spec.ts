import { expect, test, type Page } from "@playwright/test";

import { ensureQaUser, QA_PASSWORD } from "./qa-stack";

/**
 * C1a (D-03). A signed-out user who followed a deep link was always taken to
 * /dashboard after signing in, losing the page they were sent. The proxy now
 * carries the path to /auth/login as `?next=`, and the login form lands there
 * — both ends through safeNextPath() (lib/safe-redirect.ts), falling back to
 * /dashboard. The full bypass table is in tests/unit/login-redirect.test.ts;
 * the hostile values here go through the real form.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const EMAIL = "qa-return-to@tapswipe.test";

async function submit(page: Page) {
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("Password").fill(QA_PASSWORD);
  await page.getByRole("button", { name: "Login" }).click();
}

test.beforeAll(async () => {
  await ensureQaUser(EMAIL, {});
});

test("C1a a deep link survives the trip through /auth/login", async ({ page }) => {
  await page.goto("/leads?status=new");
  await expect(page).toHaveURL(/\/auth\/login\?next=%2Fleads%3Fstatus%3Dnew$/);
  await submit(page);
  await expect(page).toHaveURL(/\/leads\?status=new$/);
  await expect(page.getByRole("heading", { name: "Leads", level: 1 })).toBeVisible();
});

test("C1a signing in from a plain /auth/login still goes to the dashboard", async ({ page }) => {
  await page.goto("/auth/login");
  await submit(page);
  await expect(page).toHaveURL(/\/dashboard$/);
});

for (const hostile of [
  "https://example.com/phish",
  "//example.com/phish",
  "/\\example.com/phish",
  "/%2F/example.com/phish",
  "javascript:alert(1)",
]) {
  test(`C1a ?next=${hostile} on the login page lands on /dashboard`, async ({ page }) => {
    await page.goto(`/auth/login?next=${encodeURIComponent(hostile)}`);
    await submit(page);
    await expect(page).toHaveURL(/^http:\/\/localhost:3000\/dashboard$/);
  });
}
