import { expect, test, type Page } from "@playwright/test";

import { PERSONAS, storageStateFor, type PersonaKey } from "./fixtures/seed";

/**
 * `/` is a signpost: it renders nothing and redirects, signed in to /dashboard
 * and signed out to /auth/login.
 *
 * This is the one claim in the app that a browser is the honest way to check,
 * which is why it is here rather than duplicated from a faster suite. The rule
 * lives in TWO places — `app/page.tsx` and `updateSession()` in
 * `lib/supabase/proxy.ts` — and only a real client exercises the pair the way a
 * person meets them: one request, following redirects, carrying cookies, with
 * the proxy deciding before the page ever renders. A curl of `/` proves the
 * status code; it does not prove a signed-in rep ends up looking at their
 * dashboard with a session that still works afterwards.
 *
 * It is also a regression guard with a specific past. `/` served the
 * with-supabase starter's marketing page until 14 Sep 2026 — logos, a "Deploy to
 * Vercel" button, a tutorial panel — and a signed-in rep landing there got a
 * greeting and a Logout button instead of their book. Nothing failed. It just
 * sat there, for months, because no test ever asked what `/` did.
 */

/** Anything from the deleted starter template. None of it may ever paint. */
const STARTER_MARKUP = [
  "Deploy to Vercel",
  "Powered by Supabase",
  "Next.js Supabase Starter",
  "The fastest way to build apps",
];

/**
 * The browser's Supabase session cookie.
 *
 * Matched by suffix rather than by name: the name embeds the project ref, which
 * differs per stack. Same approach as payouts-roles.spec.ts. If supabase-ssr
 * ever has to chunk the session it appends `.0`/`.1` and this returns the first
 * chunk only — the rotation test below asserts on a single cookie's value, so it
 * would start failing rather than quietly measuring the wrong thing.
 */
async function authCookie(page: Page) {
  const cookies = await page.context().cookies();
  return cookies.find((c) => c.name.endsWith("-auth-token")) ?? null;
}

function decodeSession(value: string): Record<string, unknown> {
  const raw = value.startsWith("base64-")
    ? Buffer.from(value.slice("base64-".length), "base64").toString("utf8")
    : decodeURIComponent(value);
  return JSON.parse(raw) as Record<string, unknown>;
}

function encodeSession(session: Record<string, unknown>): string {
  return "base64-" + Buffer.from(JSON.stringify(session), "utf8").toString("base64");
}

test.describe("the root route sends you somewhere real", () => {
  for (const persona of ["agent", "admin"] as PersonaKey[]) {
    test.describe(`signed in as ${persona}`, () => {
      test.use({ storageState: storageStateFor(persona) });

      test("lands on the dashboard, not a template page", async ({ page }) => {
        // Captured before goto() follows the chain: this is the response for
        // `/` itself, which is where starter markup would have to appear.
        const rootBodies: string[] = [];
        page.on("response", async (response) => {
          if (new URL(response.url()).pathname !== "/") return;
          rootBodies.push(await response.text().catch(() => ""));
        });

        await page.goto("/");

        await expect(page).toHaveURL(/\/dashboard$/);

        // The identity block renders from requireUser(), so seeing it proves we
        // arrived with a real session and a profile row — not merely that the
        // URL changed. Same signal auth.setup.ts waits on.
        await expect(
          page.getByText(PERSONAS[persona].fullName, { exact: true }),
        ).toBeVisible();

        // `/` must not have a page to look at. A redirect body is either empty
        // or the bare target path; either way none of the starter can be in it.
        expect(rootBodies.length, "expected a response for /").toBeGreaterThan(0);
        for (const body of rootBodies) {
          for (const markup of STARTER_MARKUP) {
            expect(body, `/ served starter markup: ${markup}`).not.toContain(markup);
          }
        }

        // And nothing from the template survives on the page we landed on.
        for (const markup of STARTER_MARKUP) {
          await expect(page.getByText(markup, { exact: false })).toHaveCount(0);
        }
      });
    });
  }

  test.describe("signed out", () => {
    // An explicitly empty state, not just the absence of `test.use`: without it
    // a spec inherits whatever the project config supplies, and "signed out"
    // would silently become "however the last project was configured".
    test.use({ storageState: { cookies: [], origins: [] } });

    test("lands on the login form", async ({ page }) => {
      await page.goto("/");

      await expect(page).toHaveURL(/\/auth\/login$/);
      await expect(page.getByLabel("Email")).toBeVisible();

      for (const markup of STARTER_MARKUP) {
        await expect(page.getByText(markup, { exact: false })).toHaveCount(0);
      }
    });
  });
});

test.describe("the root redirect carries a rotated session with it", () => {
  test.use({ storageState: storageStateFor("agent") });

  /**
   * The bug this exists for is invisible in every other test here.
   *
   * `updateSession()` calls `getClaims()`, which refreshes the session when the
   * access token is past due. The refresh writes the new token pair onto
   * `supabaseResponse` via setAll(). A bare `NextResponse.redirect()` is a
   * DIFFERENT response object, so returning one throws that pair away and hands
   * the browser back a token that has just been superseded — the random-logout
   * failure `lib/supabase/proxy.ts` keeps warning about. The `/` branch copies
   * the cookies across for exactly this reason.
   *
   * Nothing catches it at rest, because with a fresh token no refresh happens,
   * setAll() never fires, and copying zero cookies is indistinguishable from not
   * copying them. So this test forces the refresh: it backdates `expires_at` in
   * the browser's own cookie while leaving the refresh_token intact, which is
   * precisely the state a rep's browser is in an hour after signing in.
   *
   * The assertion is on the `set-cookie` header of the redirect response itself
   * rather than on the cookie jar afterwards. Reading the jar at the end would
   * pass either way: if the redirect dropped the pair, the very next request to
   * /dashboard would refresh again and set a good cookie, and the window in
   * which the session was broken would have closed before we looked.
   */
  test("the 307 for / sets the refreshed cookie", async ({ page }) => {
    const before = await authCookie(page);
    expect(before, "signed-in fixture should carry an auth cookie").not.toBeNull();

    const session = decodeSession(before!.value);
    expect(
      session.refresh_token,
      "session should carry a refresh_token to rotate with",
    ).toBeTruthy();

    // Past due, but with the refresh_token untouched — supabase-js decides to
    // refresh from expires_at, so this is the whole trigger.
    session.expires_at = Math.floor(Date.now() / 1000) - 60;
    session.expires_in = 0;

    await page.context().addCookies([{ ...before!, value: encodeSession(session) }]);

    const rootResponses: { status: number; setCookie: string | null }[] = [];
    page.on("response", async (response) => {
      if (new URL(response.url()).pathname !== "/") return;
      rootResponses.push({
        status: response.status(),
        setCookie: await response.headerValue("set-cookie"),
      });
    });

    await page.goto("/");

    await expect(page).toHaveURL(/\/dashboard$/);

    const root = rootResponses.at(0);
    expect(root, "expected a response for /").toBeDefined();
    expect(
      root!.status,
      "/ should redirect rather than render",
    ).toBeGreaterThanOrEqual(300);
    expect(
      root!.setCookie,
      "the / redirect dropped the refreshed session cookie — see the proxy's cookie copy",
    ).toContain("-auth-token");

    // The session the browser is left holding has to actually work. If the
    // rotated pair had been lost, the refresh_token in the old cookie is spent
    // and the next protected page bounces to login.
    await page.goto("/merchants");
    await expect(page).toHaveURL(/\/merchants$/);
    await expect(page).not.toHaveURL(/\/auth\//);
  });
});
