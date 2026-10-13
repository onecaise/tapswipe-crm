import { expect, test } from "@playwright/test";

import { ensureQaUser, QA_PASSWORD, service } from "./qa-stack";

/**
 * QA-001 — /auth/confirm followed `next` wherever it pointed once the OTP
 * verified, so a genuine sign-in email carrying `&next=https://elsewhere`
 * landed a freshly signed-in user off-site: an open redirect, delivered from
 * our own domain. Fixed by `safeNextPath()` (lib/safe-redirect.ts); the
 * exhaustive table of shapes is in tests/unit/safe-redirect.test.ts. This file
 * proves the route actually uses it, and that the legitimate flows a `next`
 * exists for still land where they should.
 *
 * Each case mints its own token: an OTP is single-use, so reusing one would
 * fail at verify and prove nothing about the redirect.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const EMAIL = "qa-confirm@tapswipe.test";

type LinkType = "magiclink" | "recovery" | "invite";

async function tokenFor(type: LinkType, email: string): Promise<string> {
  const { data, error } = await service().auth.admin.generateLink({ type, email } as never);
  expect(error).toBeNull();
  const tokenHash = data.properties?.hashed_token;
  expect(tokenHash).toBeTruthy();
  return tokenHash!;
}

const confirmUrl = (tokenHash: string, type: LinkType, next?: string) =>
  `/auth/confirm?token_hash=${tokenHash}&type=${type}` +
  (next === undefined ? "" : `&next=${encodeURIComponent(next)}`);

test.describe("QA-001 /auth/confirm refuses an off-site next", () => {
  for (const next of [
    "https://example.com/phish",
    "//example.com/phish",
    "/\\example.com/phish",
    "/%2F/example.com/phish",
  ]) {
    test(`next=${next} falls back to /`, async ({ request }) => {
      await ensureQaUser(EMAIL, {});
      const tokenHash = await tokenFor("magiclink", EMAIL);
      const response = await request.get(confirmUrl(tokenHash, "magiclink", next), {
        maxRedirects: 0,
      });
      // The verify itself must have succeeded, or this proves nothing.
      expect(response.status()).toBe(307);
      const location = response.headers()["location"] ?? "";
      expect(location.startsWith("/auth/error")).toBe(false);
      expect(location).not.toContain("example.com");
      expect(location).toBe("/");
    });
  }
});

test.describe("QA-001 legitimate next targets still land", () => {
  test("magic link with next=/leads signs in and lands on /leads", async ({ page }) => {
    await ensureQaUser(EMAIL, {});
    const tokenHash = await tokenFor("magiclink", EMAIL);
    await page.goto(confirmUrl(tokenHash, "magiclink", "/leads?status=new"));
    await expect(page).toHaveURL(/\/leads\?status=new$/);
    await expect(page.getByRole("heading", { name: "Leads", level: 1 })).toBeVisible();
  });

  test("magic link with no next lands on the dashboard", async ({ page }) => {
    await ensureQaUser(EMAIL, {});
    const tokenHash = await tokenFor("magiclink", EMAIL);
    await page.goto(confirmUrl(tokenHash, "magiclink"));
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test("password recovery lands on /auth/update-password and the new password works", async ({ page }) => {
    await ensureQaUser(EMAIL, {});
    const tokenHash = await tokenFor("recovery", EMAIL);
    await page.goto(confirmUrl(tokenHash, "recovery", "/auth/update-password"));
    await expect(page).toHaveURL(/\/auth\/update-password$/);

    const fresh = `${QA_PASSWORD}-recovered`;
    await page.getByLabel("New password", { exact: true }).fill(fresh);
    await page.getByLabel("Confirm new password").fill(fresh);
    await page.getByRole("button", { name: "Save new password" }).click();
    await expect(page).toHaveURL(/\/dashboard$/);

    // The session came from the recovery link; the password must also be the
    // live one, or "lands correctly" would be true of a reset that did nothing.
    const { error } = await service().auth.signInWithPassword({ email: EMAIL, password: fresh });
    expect(error).toBeNull();
    await ensureQaUser(EMAIL, {}); // back to QA_PASSWORD for whoever runs next
  });

  test("invite lands on /auth/update-password", async ({ page }) => {
    // An invite is for an address with no account yet, so it gets its own,
    // deleted afterwards. No profile is ever made for it.
    const invited = `qa-invite-${Date.now()}@tapswipe.test`;
    const tokenHash = await tokenFor("invite", invited);
    try {
      await page.goto(confirmUrl(tokenHash, "invite", "/auth/update-password"));
      await expect(page).toHaveURL(/\/auth\/update-password$/);
      await expect(page.getByLabel("New password", { exact: true })).toBeVisible();
    } finally {
      const db = service();
      const { data } = await db.auth.admin.listUsers({ perPage: 1000 });
      const user = data.users.find((u) => u.email === invited);
      if (user) {
        const { error } = await db.auth.admin.deleteUser(user.id);
        expect(error).toBeNull();
      }
    }
  });
});
