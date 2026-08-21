import { expect, test as setup } from "@playwright/test";

import {
  E2E_PASSWORD,
  PERSONAS,
  seedE2E,
  storageStateFor,
  type PersonaKey,
} from "./fixtures/seed";

/**
 * Provision fixtures, then sign each persona in once and save their cookies.
 *
 * Every other project depends on this one, so no spec logs in and no spec
 * contains a password. That is worth the indirection for two reasons beyond
 * speed: a login in each spec makes every failure look like an auth failure, and
 * a password repeated across files is a password that gets left behind in one of
 * them when it changes.
 *
 * The sign-in goes through the real form rather than seeding a session token
 * directly. It is the one place this suite should exercise the login path at all,
 * and doing it here means a broken login fails once, loudly, in setup — rather
 * than as twenty confusing redirect assertions downstream.
 */

setup("seed fixtures", async () => {
  const { ids } = await seedE2E();
  // Fail loudly here rather than letting a spec assert on an empty page later.
  for (const [key, id] of Object.entries(ids)) {
    expect(id, `${key} should have a profile id`).toBeTruthy();
  }
});

for (const persona of Object.keys(PERSONAS) as PersonaKey[]) {
  setup(`authenticate as ${persona}`, async ({ page }) => {
    await page.goto("/auth/login");

    await page.getByLabel("Email").fill(PERSONAS[persona].email);
    await page.getByLabel("Password").fill(E2E_PASSWORD);
    await page.getByRole("button", { name: "Login" }).click();

    // The shell's identity block is the signal that the session is real: it
    // renders from requireUser(), so reaching it proves both auth and a profile
    // row. Waiting on a URL alone would pass for the ghost-user state that
    // routes to /auth/error?error=no-profile.
    await expect(
      page.getByText(PERSONAS[persona].fullName, { exact: true }),
    ).toBeVisible();
    await expect(page).not.toHaveURL(/\/auth\//);

    await page.context().storageState({ path: storageStateFor(persona) });
  });
}
