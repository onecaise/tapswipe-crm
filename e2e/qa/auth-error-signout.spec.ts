import { expect, test, type Page } from "@playwright/test";

import { ensureQaUser, QA_PASSWORD } from "./qa-stack";

/**
 * B2 (D-02). /auth/error?error=no-profile and …=account-deactivated are where a
 * signed-in user with no usable account lands, and they offered no way to sign
 * out: the session stayed live in that browser, so whoever used it next was
 * still "signed in" as an account that can do nothing. They now carry the same
 * sign-out the topbar uses — and only when there is a session to end.
 */
test.use({ storageState: { cookies: [], origins: [] } });

async function signIn(page: Page, email: string) {
  await page.goto("/auth/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(QA_PASSWORD);
  await page.getByRole("button", { name: "Login" }).click();
}

const cases = [
  { code: "account-deactivated", email: "qa-signout-inactive@tapswipe.test", profile: { is_active: false } },
  { code: "no-profile", email: "qa-signout-noprofile@tapswipe.test", profile: null },
] as const;

for (const { code, email, profile } of cases) {
  test(`B2 ${code}: Log out ends the session and lands on /auth/login`, async ({ page }) => {
    await ensureQaUser(email, profile === null ? null : { ...profile });
    await signIn(page, email);
    await expect(page).toHaveURL(new RegExp(`/auth/error\\?error=${code}$`));

    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page).toHaveURL(/\/auth\/login$/);

    // Really signed out, not just moved: a protected page sends us back.
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/auth\/login$/);
  });
}

test("B2 no Log out control without a session", async ({ page }) => {
  for (const { code } of cases) {
    await page.goto(`/auth/error?error=${code}`);
    await expect(page.getByText("Sorry, something went wrong.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Log out" })).toHaveCount(0);
  }
});
