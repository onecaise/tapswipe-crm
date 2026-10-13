import { expect, test, type Page } from "@playwright/test";

import { storageStateFor } from "../fixtures/seed";
import { ensureQaUser, QA_PASSWORD, service } from "./qa-stack";

/**
 * C1b (D-03). A signed-in user who opened /auth/login got the login form. An
 * active one is now sent to /dashboard (or to a safe `?next=`). The hazard is a
 * loop: /dashboard sends an inactive or profile-less user to /auth/error, and if
 * /auth/login bounced them back to /dashboard they could never reach the form
 * to sign in as someone else. So the redirect is for ACTIVE profiles only, and
 * this file proves the other three states still get the form.
 */

async function signIn(page: Page, email: string) {
  await page.goto("/auth/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(QA_PASSWORD);
  await page.getByRole("button", { name: "Login" }).click();
}

/** /auth/login answers 200 with the form — not a redirect of any kind. */
async function expectLoginForm(page: Page) {
  const response = await page.request.get("/auth/login", { maxRedirects: 0 });
  expect(response.status()).toBe(200);
  await page.goto("/auth/login");
  await expect(page).toHaveURL(/\/auth\/login$/);
  await expect(page.getByRole("button", { name: "Login" })).toBeVisible();
}

test.describe("an active user", () => {
  test.use({ storageState: storageStateFor("agent") });

  test("C1b /auth/login sends an active user to the dashboard", async ({ page }) => {
    await page.goto("/auth/login");
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test("C1b a safe ?next= is honoured, a hostile one is not", async ({ page }) => {
    await page.goto("/auth/login?next=%2Fleads");
    await expect(page).toHaveURL(/\/leads$/);
    await page.goto(`/auth/login?next=${encodeURIComponent("//example.com/phish")}`);
    await expect(page).toHaveURL(/^http:\/\/localhost:3000\/dashboard$/);
  });
});

test.describe("users who must still reach the form", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("C1b an inactive profile reaches its error page and then the form", async ({ page }) => {
    const email = "qa-c1b-inactive@tapswipe.test";
    await ensureQaUser(email, { is_active: false });
    await signIn(page, email);
    await expect(page).toHaveURL(/\/auth\/error\?error=account-deactivated$/);
    await expectLoginForm(page);
  });

  test("C1b a user with no profile reaches its error page and then the form", async ({ page }) => {
    const email = "qa-c1b-noprofile@tapswipe.test";
    await ensureQaUser(email, null);
    await signIn(page, email);
    await expect(page).toHaveURL(/\/auth\/error\?error=no-profile$/);
    await expectLoginForm(page);
  });

  test("C1b a user deactivated mid-session (banned + inactive) still gets the form", async ({ page }) => {
    const email = "qa-c1b-banned@tapswipe.test";
    const id = await ensureQaUser(email, {});
    await signIn(page, email);
    await expect(page).toHaveURL(/\/dashboard$/);

    // What deactivate-user does: ban in GoTrue, then is_active = false. The
    // session in this browser is still a valid JWT until it expires.
    const db = service();
    expect((await db.auth.admin.updateUserById(id, { ban_duration: "876000h" })).error).toBeNull();
    expect((await db.from("profiles").update({ is_active: false }).eq("id", id)).error).toBeNull();

    try {
      await expectLoginForm(page);
    } finally {
      await ensureQaUser(email, {}); // lifts the ban
    }
  });
});
