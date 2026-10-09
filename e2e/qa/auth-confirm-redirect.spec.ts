import { expect, test } from "@playwright/test";

import { ensureQaUser, service } from "./qa-stack";

/**
 * QA-001 (NEEDS OWEN — auth flow, not changed by the sweep).
 *
 * /auth/confirm redirects to whatever `next` says once the OTP verifies, with
 * no check that it is a path on this site. A real sign-in link with
 * `&next=https://elsewhere` therefore lands a freshly signed-in user on an
 * external page — the classic open redirect, delivered from our own domain in
 * an email that looks entirely genuine.
 *
 * Marked `test.fail()`: the assertion below is what SHOULD hold, and the
 * annotation records that today it does not. When the redirect is fixed this
 * spec goes red as "expected to fail, but passed" — that is the signal to
 * delete the annotation, not to delete the spec.
 */
test.use({ storageState: { cookies: [], origins: [] } });

test("QA-001 /auth/confirm does not redirect off-site after a valid OTP", async ({ request }) => {
  test.fail(true, "QA-001: open redirect via ?next= — NEEDS OWEN");

  const email = "qa-confirm@tapswipe.test";
  await ensureQaUser(email, {});
  const { data, error } = await service().auth.admin.generateLink({ type: "magiclink", email });
  expect(error).toBeNull();
  const tokenHash = data.properties?.hashed_token;
  expect(tokenHash).toBeTruthy();

  const response = await request.get(
    `/auth/confirm?token_hash=${tokenHash}&type=magiclink&next=https://example.com/phish`,
    { maxRedirects: 0 },
  );
  // The verify itself must have succeeded, or this proves nothing.
  expect(response.status()).toBe(307);
  const location = response.headers()["location"] ?? "";
  expect(location.startsWith("/auth/error")).toBe(false);

  expect(location).not.toContain("example.com");
});
