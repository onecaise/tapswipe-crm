import { expect, test } from "@playwright/test";

import { ensureQaUser, QA_PASSWORD } from "./qa-stack";

/**
 * QA-011 — "Forgot your password?" sat in the DOM between the Email and
 * Password inputs (laid out beside the Password label), so Tab from Email
 * landed on the link; typing the password went nowhere and Enter followed the
 * link, ending a keyboard-only login on /auth/forgot-password.
 *
 * Fixed in components/login-form.tsx by DOM order (Email, Password, Login,
 * then the link) with the link still PLACED beside the label by the grid. The
 * last spec checks that placement survived, so the fix cannot quietly become
 * "move the link to the bottom".
 */
test.use({ storageState: { cookies: [], origins: [] } });

const EMAIL = "qa-login-keyboard@tapswipe.test";

test("QA-011 Tab from the email field reaches the password field", async ({ page }) => {
  await page.goto("/auth/login");
  await page.getByLabel("Email").focus();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Password")).toBeFocused();
});

test("QA-011 tab order is Email, Password, Login, Forgot your password?", async ({ page }) => {
  await page.goto("/auth/login");
  await page.getByLabel("Email").focus();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Password")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Login" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Forgot your password?" })).toBeFocused();
});

test("QA-011 a keyboard-only login lands on the dashboard", async ({ page }) => {
  await ensureQaUser(EMAIL, {});
  await page.goto("/auth/login");
  await page.getByLabel("Email").focus();
  await page.keyboard.type(EMAIL);
  await page.keyboard.press("Tab");
  await page.keyboard.type(QA_PASSWORD);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/dashboard$/);
});

test("QA-011 the link still sits beside the Password label", async ({ page }) => {
  await page.goto("/auth/login");
  const label = await page.locator("label[for=password]").boundingBox();
  const link = await page.getByRole("link", { name: "Forgot your password?" }).boundingBox();
  const input = await page.getByLabel("Password").boundingBox();
  expect(label && link && input).toBeTruthy();
  // Same row as the label, to its right, and above the input.
  const mid = (b: { y: number; height: number }) => b.y + b.height / 2;
  expect(Math.abs(mid(link!) - mid(label!))).toBeLessThan(6);
  expect(link!.x).toBeGreaterThan(label!.x + label!.width);
  expect(link!.y + link!.height).toBeLessThanOrEqual(input!.y);
});
