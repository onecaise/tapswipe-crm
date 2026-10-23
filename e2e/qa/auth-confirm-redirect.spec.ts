import { expect, test, type Page } from "@playwright/test";

import {
  clearMailTo,
  ensureQaUser,
  latestMailTo,
  mailLinks,
  QA_PASSWORD,
  service,
} from "./qa-stack";

/**
 * QA-001 — /auth/confirm followed `next` wherever it pointed once the OTP
 * verified, so a genuine sign-in email carrying `&next=https://elsewhere`
 * landed a freshly signed-in user off-site: an open redirect, delivered from
 * our own domain. Fixed by `safeNextPath()` (lib/safe-redirect.ts); the
 * exhaustive table of shapes is in tests/unit/safe-redirect.test.ts. This file
 * proves the route actually uses it, and that the legitimate flows a `next`
 * exists for still land where they should.
 *
 * Since phase 7 the token is exchanged only when the Continue page POSTs (see
 * auth-confirm-csrf.spec.ts), and the only type accepted is `recovery`, the
 * one email the app sends. So every case here opens the link AND presses
 * Continue; a GET alone proves nothing now.
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

/** Open an email link and press Continue, as a person would. */
async function openAndContinue(page: Page, url: string) {
  await page.goto(url);
  await expect(page.getByText("Reset your password", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
}

test.describe("QA-001 /auth/confirm refuses an off-site next", () => {
  for (const next of [
    "https://example.com/phish",
    "//example.com/phish",
    "/\\example.com/phish",
    "/%2F/example.com/phish",
  ]) {
    test(`next=${next} falls back to the reset form`, async ({ page }) => {
      await ensureQaUser(EMAIL, {});
      const tokenHash = await tokenFor("recovery", EMAIL);

      // Not even carried to the Continue page: the GET's own redirect already
      // holds the fallback.
      const response = await page.request.get(confirmUrl(tokenHash, "recovery", next), {
        maxRedirects: 0,
      });
      expect(response.status()).toBe(307);
      const location = response.headers()["location"] ?? "";
      expect(location).not.toContain("example.com");
      expect(location).toContain(`next=${encodeURIComponent("/auth/update-password")}`);

      await openAndContinue(page, confirmUrl(tokenHash, "recovery", next));
      // The verify itself must have succeeded, or this proves nothing.
      await expect(page).toHaveURL(/\/auth\/update-password$/);
      await expect(page.getByLabel("New password", { exact: true })).toBeVisible();
    });
  }
});

test.describe("QA-001 legitimate next targets still land", () => {
  test("recovery link with next=/auth/update-password lands there and the new password works", async ({ page }) => {
    await ensureQaUser(EMAIL, {});
    const tokenHash = await tokenFor("recovery", EMAIL);
    await openAndContinue(page, confirmUrl(tokenHash, "recovery", "/auth/update-password"));
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

  test("recovery link with no next still lands on the reset form", async ({ page }) => {
    await ensureQaUser(EMAIL, {});
    const tokenHash = await tokenFor("recovery", EMAIL);
    await openAndContinue(page, confirmUrl(tokenHash, "recovery"));
    await expect(page).toHaveURL(/\/auth\/update-password$/);
  });

  test("a same-site next on a recovery link is followed", async ({ page }) => {
    await ensureQaUser(EMAIL, {});
    const tokenHash = await tokenFor("recovery", EMAIL);
    await openAndContinue(page, confirmUrl(tokenHash, "recovery", "/leads?status=new"));
    await expect(page).toHaveURL(/\/leads\?status=new$/);
    await expect(page.getByRole("heading", { name: "Leads", level: 1 })).toBeVisible();
  });
});

test.describe("phase 7: the real reset email, end to end", () => {
  // The forgot-password form, the email the local stack actually sends from
  // supabase/templates/recovery.html, and the link in it. This is the template
  // wording the hosted projects are told to use, so this test is what says
  // that wording works.
  test("forgot password → email → Continue → new password", async ({ page, browser }) => {
    await ensureQaUser(EMAIL, {});
    await clearMailTo(EMAIL);

    await page.goto("/auth/forgot-password");
    await page.getByLabel("Email").fill(EMAIL);
    await page.getByRole("button", { name: "Send reset email" }).click();
    await expect(page.getByText("Check Your Email")).toBeVisible();

    const mail = await latestMailTo(EMAIL);
    expect(mail.subject).toBe("Reset your password");
    const links = mailLinks(mail.html);
    expect(links).toHaveLength(1);
    const link = new URL(links[0]);
    expect(link.pathname).toBe("/auth/confirm");
    expect(link.searchParams.get("type")).toBe("recovery");
    expect(link.searchParams.get("next")).toBe("/auth/update-password");
    expect(link.searchParams.get("token_hash")).toBeTruthy();

    // Opened in a DIFFERENT browser from the one that asked: a token_hash link
    // needs no PKCE verifier, which is the point of the template. The email's
    // host is the stack's site_url (127.0.0.1); the path and query are what is
    // under test, so it is opened on the app's own base URL.
    const other = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      const fresh = await other.newPage();
      await openAndContinue(fresh, `${link.pathname}${link.search}`);
      await expect(fresh).toHaveURL(/\/auth\/update-password$/);

      const newPassword = `${QA_PASSWORD}-by-email`;
      await fresh.getByLabel("New password", { exact: true }).fill(newPassword);
      await fresh.getByLabel("Confirm new password").fill(newPassword);
      await fresh.getByRole("button", { name: "Save new password" }).click();
      await expect(fresh).toHaveURL(/\/dashboard$/);

      const { error } = await service().auth.signInWithPassword({ email: EMAIL, password: newPassword });
      expect(error).toBeNull();
    } finally {
      await other.close();
      await ensureQaUser(EMAIL, {});
    }
  });
});

test.describe("phase 7: only the types the app sends", () => {
  // The app sends recovery and nothing else: sign-up is off, and nothing sends
  // invites or magic links. A magic link can still be requested by anyone for
  // their own address from GoTrue's public API, which is the attack.
  for (const type of ["magiclink", "invite"] as const) {
    test(`a ${type} link is refused before any page, and signs nobody in`, async ({ page, context }) => {
      const email = type === "invite" ? `qa-invite-${Date.now()}@tapswipe.test` : EMAIL;
      if (type === "magiclink") await ensureQaUser(EMAIL, {});
      const tokenHash = await tokenFor(type, email);
      try {
        const response = await page.request.get(confirmUrl(tokenHash, type), { maxRedirects: 0 });
        expect(response.status()).toBe(307);
        expect(response.headers()["location"]).toBe("/auth/error?error=link-unsupported");
        expect(response.headers()["set-cookie"] ?? "").not.toMatch(/sb-.*-auth-token/);

        await page.goto(confirmUrl(tokenHash, type));
        await expect(page).toHaveURL(/\/auth\/error\?error=link-unsupported$/);
        await expect(page.getByText("This kind of link is not used here")).toBeVisible();
        expect((await context.cookies()).some((c) => /^sb-.+-auth-token/.test(c.name))).toBe(false);

        // Nor through the Continue page by hand: it parses the link again.
        await page.goto(`/auth/confirm/continue?token_hash=${tokenHash}&type=${type}`);
        await expect(page).toHaveURL(/\/auth\/error\?error=link-unsupported$/);
      } finally {
        if (type === "invite") {
          const db = service();
          const { data } = await db.auth.admin.listUsers({ perPage: 1000 });
          const user = data.users.find((u) => u.email === email);
          if (user) expect((await db.auth.admin.deleteUser(user.id)).error).toBeNull();
        }
      }
    });
  }
});
