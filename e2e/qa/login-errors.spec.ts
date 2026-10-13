import { expect, test, type Page } from "@playwright/test";

import { ensureQaUser, QA_PASSWORD, service } from "./qa-stack";

/**
 * B1 (D-01). One state, two wordings: a deactivated rep whose GoTrue ban is in
 * place saw GoTrue's raw "User is banned" under the login form, while one whose
 * profile was inactive but not yet banned got the friendly
 * /auth/error?error=account-deactivated page. Both now read the same words,
 * from one constant (lib/auth-copy.ts).
 *
 * Wrong credentials must stay generic: an unknown address and a wrong password
 * on a real one have to be indistinguishable.
 *
 * Note what the UI cannot change: GoTrue answers `user_banned` for a banned
 * account whatever password is sent (measured on the local stack), so the
 * response itself says the account exists. That is recorded as a decision in
 * qa/QA-REPORT.md, not asserted away here.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const BANNED = "qa-login-banned@tapswipe.test";
const INACTIVE = "qa-login-inactive@tapswipe.test";
const ACTIVE = "qa-login-active@tapswipe.test";

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/auth/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Login" }).click();
}

test.afterAll(async () => {
  // Lift the ban so the account is reusable; ensureQaUser also does this.
  await ensureQaUser(BANNED, {});
});

test("B1 a banned account sees the deactivated wording, not GoTrue's", async ({ page }) => {
  const id = await ensureQaUser(BANNED, { is_active: false });
  const { error } = await service().auth.admin.updateUserById(id, { ban_duration: "876000h" });
  expect(error).toBeNull();

  await signIn(page, BANNED, QA_PASSWORD);
  await expect(page.getByText("This account has been deactivated")).toBeVisible();
  await expect(page.getByText("An admin can turn it back on.")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("User is banned");
  await expect(page).toHaveURL(/\/auth\/login$/);
});

test("B1 an inactive but unbanned profile reaches the same words on /auth/error", async ({ page }) => {
  await ensureQaUser(INACTIVE, { is_active: false });
  await signIn(page, INACTIVE, QA_PASSWORD);
  await expect(page).toHaveURL(/\/auth\/error\?error=account-deactivated$/);
  await expect(page.getByText("This account has been deactivated")).toBeVisible();
  await expect(page.getByText(/An admin can turn it back on\./)).toBeVisible();
});

test("B1 a wrong password and an unknown address read identically", async ({ page }) => {
  await ensureQaUser(ACTIVE, {});

  await signIn(page, ACTIVE, "definitely-not-the-password");
  const wrongPassword = page.locator("form p.text-destructive");
  await expect(wrongPassword).toBeVisible();
  const first = await wrongPassword.innerText();

  await signIn(page, "nobody-here-b1@tapswipe.test", "definitely-not-the-password");
  const unknown = page.locator("form p.text-destructive");
  await expect(unknown).toBeVisible();
  const second = await unknown.innerText();

  expect(second).toBe(first);
  expect(first).not.toMatch(/deactivated|banned|not found|no account|exist/i);
});
