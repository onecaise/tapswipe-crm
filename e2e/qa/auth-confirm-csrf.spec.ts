import { expect, test, type APIRequestContext } from "@playwright/test";

import { storageStateFor } from "../fixtures/seed";
import {
  clearMailTo,
  ensureQaUser,
  latestMailTo,
  mailLinks,
  publicClient,
  service,
  sessionEmail,
} from "./qa-stack";

/**
 * Phase 7 — login CSRF through `GET /auth/confirm`.
 *
 * The claim: a rep can send an admin their own unused sign-in link and the
 * admin is silently signed in as the rep. Reproduced before the fix: a rep
 * asks GoTrue's PUBLIC API for a magic link to their own address (no app
 * screen needed), takes the token out of the email, and
 * `/auth/confirm?token_hash=<it>&type=magiclink` signed in whoever opened it —
 * the admin's session replaced, no click. A token_hash, unlike a PKCE code,
 * works in any browser, and GoTrue's default email link carries the same hash
 * as `token=`, so this held whatever the email templates said.
 *
 * The fix, pinned here: the GET verifies nothing and only shows a Continue
 * page; the token is exchanged by a Server Action that runs only on a
 * same-origin POST; and the only type accepted is `recovery`.
 */

const REP = "qa-csrf-rep@tapswipe.test";
const ADMIN = "e2e-admin@tapswipe.test";

async function recoveryToken(email: string): Promise<string> {
  const { data, error } = await service().auth.admin.generateLink({ type: "recovery", email });
  expect(error).toBeNull();
  return data.properties!.hashed_token;
}

const confirmUrl = (tokenHash: string, type = "recovery") =>
  `/auth/confirm?token_hash=${tokenHash}&type=${type}`;

test.describe("an admin opening a rep's link", () => {
  test.use({ storageState: storageStateFor("admin") });

  test("the rep's own magic link, from the public API, does not sign the admin in as the rep", async ({ page, context }) => {
    await ensureQaUser(REP, {});
    expect(sessionEmail(await context.cookies())).toBe(ADMIN);

    // What the rep does: no app screen, just the publishable key.
    await clearMailTo(REP);
    const { error } = await publicClient().auth.signInWithOtp({
      email: REP,
      options: { shouldCreateUser: false },
    });
    expect(error).toBeNull();
    const [link] = mailLinks((await latestMailTo(REP)).html);
    const token = new URL(link).searchParams.get("token");
    expect(token).toBeTruthy();

    // The shape that worked before the fix.
    await page.goto(confirmUrl(token!, "magiclink"));
    await expect(page).toHaveURL(/\/auth\/error\?error=link-unsupported$/);
    expect(sessionEmail(await context.cookies())).toBe(ADMIN);
  });

  test("the rep's reset link opens a Continue page that names the admin's session and changes nothing", async ({ page, context }) => {
    await ensureQaUser(REP, {});
    const token = await recoveryToken(REP);

    await page.goto(confirmUrl(token));
    await expect(page).toHaveURL(/\/auth\/confirm\/continue\?/);
    await expect(page.getByText("Reset your password", { exact: true })).toBeVisible();
    await expect(page.getByRole("note")).toContainText(`You are signed in as ${ADMIN}`);
    // Opening it changed nothing.
    expect(sessionEmail(await context.cookies())).toBe(ADMIN);
    await page.goto("/admin/users");
    await expect(page.getByRole("heading", { name: "Manage Users", level: 1 })).toBeVisible();

    // And the token is still unused: a person who does press Continue on it
    // gets the account it was sent to. (Same browser — the warning above is
    // what stands between the click and that.)
    await page.goto(confirmUrl(token));
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page).toHaveURL(/\/auth\/update-password$/);
    expect(sessionEmail(await context.cookies())).toBe(REP);
  });
});

test.describe("the POST", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  /** The no-JS form exactly as the Continue page renders it. */
  async function continueForm(request: APIRequestContext, token: string) {
    const html = await (await request.get(`/auth/confirm/continue?token_hash=${token}&type=recovery`)).text();
    const fields: Record<string, string> = {};
    for (const m of html.matchAll(/<input[^>]*type="hidden"[^>]*>/g)) {
      const name = /name="([^"]+)"/.exec(m[0])?.[1];
      const value = /value="([^"]*)"/.exec(m[0])?.[1] ?? "";
      if (name) fields[name] = value.replaceAll("&amp;", "&");
    }
    expect(Object.keys(fields).some((k) => k.startsWith("$ACTION_ID_"))).toBe(true);
    expect(fields.token_hash).toBe(token);
    return fields;
  }

  const setsSession = (headers: { name: string; value: string }[]) =>
    headers.some((h) => h.name.toLowerCase() === "set-cookie" && /sb-.+-auth-token/.test(h.value));

  test("a cross-site POST is refused and leaves the token unused", async ({ request, baseURL }) => {
    await ensureQaUser(REP, {});
    const token = await recoveryToken(REP);
    const form = await continueForm(request, token);

    // Another site auto-submitting the form: the browser sends its Origin.
    const forged = await request.post("/auth/confirm/continue", {
      multipart: form,
      headers: { Origin: "https://attacker.example", "Sec-Fetch-Site": "cross-site" },
      maxRedirects: 0,
    });
    expect(setsSession(forged.headersArray())).toBe(false);

    // Same Origin header but the browser says cross-site: refused by the
    // action's own check, not only by Next's.
    const sameOriginHeader = await request.post("/auth/confirm/continue", {
      multipart: form,
      headers: { Origin: baseURL!, "Sec-Fetch-Site": "cross-site" },
      maxRedirects: 0,
    });
    expect(setsSession(sameOriginHeader.headersArray())).toBe(false);
    expect(sameOriginHeader.headers()["location"] ?? "").toContain("/auth/error?error=link-invalid");

    // Control, on the SAME token: the hand-built POST is a real action call,
    // and the token survived both refusals.
    const genuine = await request.post("/auth/confirm/continue", {
      multipart: form,
      headers: { Origin: baseURL!, "Sec-Fetch-Site": "same-origin" },
      maxRedirects: 0,
    });
    expect(setsSession(genuine.headersArray())).toBe(true);
    expect(genuine.headers()["location"]).toBe("/auth/update-password");
  });

  test("a POST that edits the hidden type is refused", async ({ request, baseURL }) => {
    await ensureQaUser(REP, {});
    const { data } = await service().auth.admin.generateLink({ type: "magiclink", email: REP });
    const magic = data.properties!.hashed_token;
    // A valid action id from a real recovery page, with the type swapped.
    const form = { ...(await continueForm(request, await recoveryToken(REP))), token_hash: magic, type: "magiclink" };
    const response = await request.post("/auth/confirm/continue", {
      multipart: form,
      headers: { Origin: baseURL!, "Sec-Fetch-Site": "same-origin" },
      maxRedirects: 0,
    });
    expect(setsSession(response.headersArray())).toBe(false);
    expect(response.headers()["location"]).toBe("/auth/error?error=link-unsupported");
  });

  test("a GET with a live token sets no session", async ({ request }) => {
    await ensureQaUser(REP, {});
    const token = await recoveryToken(REP);
    for (const url of [confirmUrl(token), `/auth/confirm/continue?token_hash=${token}&type=recovery`]) {
      const response = await request.get(url, { maxRedirects: 0 });
      expect(setsSession(response.headersArray()), url).toBe(false);
    }
  });
});
