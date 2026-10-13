import { expect, test } from "@playwright/test";

/**
 * A3. Two halves of one problem.
 *
 * /auth/confirm put GoTrue's error.message straight into the URL —
 * `/auth/error?error=${error?.message}` with no encoding, so a message with
 * `&` or `#` in it truncated or split the query string — and /auth/error then
 * printed whatever `?error=` held as "Code error: …". That second half means
 * anyone can send a link to our own domain whose page says anything they like
 * ("Code error: your account is locked, call 555-0100"). React escapes it, so
 * it is not script injection, but it is our page speaking someone else's words.
 *
 * The claim: the confirm route sends a fixed code, never a message; and the
 * error page shows its own words for an unknown value and never echoes it.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const HOSTILE = `"quoted" <b>bold</b> & more\nsecond line call 555-0100`;

test("A3 /auth/error does not echo an unknown ?error= value", async ({ page }) => {
  await page.goto(`/auth/error?error=${encodeURIComponent(HOSTILE)}`);
  await expect(page.getByText("Sorry, something went wrong.")).toBeVisible();
  await expect(page.getByText("An unexpected error occurred.")).toBeVisible();
  const body = await page.locator("body").innerText();
  for (const fragment of ["quoted", "bold", "555-0100", "second line", "Code error"]) {
    expect(body, fragment).not.toContain(fragment);
  }
  // Nothing got parsed as markup either.
  await expect(page.locator("b", { hasText: "bold" })).toHaveCount(0);
});

test("A3 known codes keep their own words", async ({ page }) => {
  await page.goto("/auth/error?error=account-deactivated");
  await expect(page.getByText("This account has been deactivated")).toBeVisible();
});

test("A3 a failed OTP verify redirects with a fixed code, not the GoTrue message", async ({ request }) => {
  const response = await request.get(
    "/auth/confirm?token_hash=not-a-real-token&type=magiclink",
    { maxRedirects: 0 },
  );
  expect(response.status()).toBe(307);
  expect(response.headers()["location"]).toBe("/auth/error?error=link-invalid");
});

test("A3 a confirm link missing its token redirects with a fixed code", async ({ request }) => {
  const response = await request.get("/auth/confirm?type=magiclink", { maxRedirects: 0 });
  expect(response.status()).toBe(307);
  expect(response.headers()["location"]).toBe("/auth/error?error=link-incomplete");
});

test("A3 the invalid-link page explains itself", async ({ page }) => {
  await page.goto("/auth/confirm?token_hash=not-a-real-token&type=magiclink");
  await expect(page).toHaveURL(/\/auth\/error\?error=link-invalid$/);
  await expect(page.getByText("This link has expired or was already used")).toBeVisible();
});

test("A3 a prototype key is not mistaken for a known code", async ({ page }) => {
  await page.goto("/auth/error?error=constructor");
  await expect(page.getByText("An unexpected error occurred.")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("constructor");
});
