import { expect, test } from "@playwright/test";

/**
 * QA-011 (NEEDS OWEN — login form, not changed by the sweep).
 *
 * "Forgot your password?" sits in the DOM between the Email and Password
 * inputs (it is laid out beside the Password label), so a keyboard user who
 * types their email and presses Tab lands on the link, not the password box.
 * Typing the password then goes nowhere, and Enter follows the link: in the
 * sweep, a keyboard-only login ended on /auth/forgot-password.
 *
 * `test.fail()` records that today the second Tab stop is the link. When the
 * order is fixed this goes red as "expected to fail, but passed" — drop the
 * annotation then.
 */
test.use({ storageState: { cookies: [], origins: [] } });

test("QA-011 Tab from the email field reaches the password field", async ({ page }) => {
  test.fail(true, "QA-011: forgot-password link precedes the password input — NEEDS OWEN");

  await page.goto("/auth/login");
  await page.getByLabel("Email").focus();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Password")).toBeFocused();
});
