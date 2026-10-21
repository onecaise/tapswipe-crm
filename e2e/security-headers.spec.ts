import { expect, request, test, type APIRequestContext } from "@playwright/test";

import { CITY_FIXTURE, merchantByMid, storageStateFor } from "./fixtures/seed";

/**
 * Security fix phase 3 (docs/claude/security-fixes.md): every response
 * carries the anti-framing and hygiene headers from lib/security-headers.ts,
 * and a real browser refuses to frame the app.
 *
 * Two halves, because they fail differently. The header reads prove the
 * values on each KIND of response Next produces -- a page, an admin page, a
 * print page, a 404, a static asset, a route handler, and the proxy's own
 * redirect -- since next.config headers() and proxy.ts answer on different
 * paths. The framing test proves the browser acts on them, which a header
 * read cannot: a typo in the CSP value would still be "present".
 */

const EXPECTED = {
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
};

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

async function client(persona?: "admin"): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: BASE_URL,
    storageState: persona ? storageStateFor(persona) : undefined,
  });
}

async function headersOf(ctx: APIRequestContext, path: string) {
  const res = await ctx.get(path, { maxRedirects: 0 });
  return { status: res.status(), headers: res.headers() };
}

function expectSecurityHeaders(headers: Record<string, string>, where: string) {
  for (const [name, value] of Object.entries(EXPECTED)) {
    expect(headers[name], `${name} on ${where}`).toBe(value);
  }
}

test.describe("security headers on every kind of response", () => {
  test("signed-out pages, a 404, a static asset and the proxy's redirect", async () => {
    const anon = await client();
    try {
      const cases: [string, number][] = [
        ["/auth/login", 200],
        ["/dashboard", 307], // the proxy's own redirect to /auth/login
        ["/favicon.ico", 200],
        ["/auth/confirm", 307], // a route handler (no token: redirects to the error page)
      ];
      for (const [path, status] of cases) {
        const r = await headersOf(anon, path);
        expect(r.status, path).toBe(status);
        expectSecurityHeaders(r.headers, path);
      }
    } finally {
      await anon.dispose();
    }
  });

  test("signed-in pages: the dashboard, an admin screen, a print page and a 404", async () => {
    const admin = await client("admin");
    try {
      const { id } = await merchantByMid(CITY_FIXTURE.own.mid);
      for (const [path, status] of [
        ["/dashboard", 200],
        ["/admin/users", 200],
        [`/merchants/${id}/print`, 200],
        ["/no-such-page-e2e", 404],
      ] as const) {
        const r = await headersOf(admin, path);
        expect(r.status, path).toBe(status);
        expectSecurityHeaders(r.headers, path);
      }
    } finally {
      await admin.dispose();
    }
  });
});

/**
 * What a framed load would show, once it has had every chance to happen.
 * Both tests were run with the headers removed and went red on this.
 */
async function framedText(page: import("@playwright/test").Page): Promise<string> {
  await page.waitForTimeout(3000);
  const child = page.frames().find((f) => f !== page.mainFrame());
  if (!child) return "";
  return child.evaluate(() => document.body?.innerText ?? "").catch(() => "");
}

test.describe("the browser refuses to frame the app", () => {
  test.use({ storageState: storageStateFor("admin") });

  test("from another origin: the login page does not render in an attacker's iframe", async ({ page }) => {
    // A page from a different origin, as an attacker's would be. The session
    // cookie is SameSite=Lax, so a CROSS-site frame arrives signed out -- what
    // an attacker can frame from elsewhere is the sign-in form (credential
    // overlay, login CSRF), which is what this asserts is refused.
    await page.setContent(
      `<iframe id="victim" src="${BASE_URL}/auth/login" width="800" height="600"></iframe>`,
    );
    expect(await framedText(page)).not.toMatch(/password/i);
  });

  test("from the app's own origin: a signed-in admin screen does not render in a frame", async ({ page }) => {
    // Same-origin, so the admin's cookie IS sent: without the headers this
    // frame renders the real user-management screen. DENY (not SAMEORIGIN)
    // refuses it too -- the app never frames itself.
    await page.goto("/dashboard");
    await page.evaluate((src) => {
      const iframe = document.createElement("iframe");
      iframe.id = "victim";
      iframe.src = src;
      iframe.width = "800";
      iframe.height = "600";
      document.body.appendChild(iframe);
    }, `${BASE_URL}/admin/users`);
    expect(await framedText(page)).not.toMatch(/users/i);
  });

  test("control: the same screen renders normally at the top level", async ({ page }) => {
    await page.goto("/admin/users");
    await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
  });
});
