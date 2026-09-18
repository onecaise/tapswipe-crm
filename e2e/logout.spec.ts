import { expect, test, type Locator, type Page } from "@playwright/test";

import { storageStateFor, type PersonaKey } from "./fixtures/seed";

/**
 * There is a way out of the app from every page, and it works.
 *
 * This is here rather than in a faster suite because all three claims are
 * things a person could only find by looking. Whether a control is *mounted on
 * every route* is a fact about the rendered shell; whether Tab reaches it and
 * paints a ring is a fact about focus and paint; and whether signing out
 * actually ends the session is a fact about cookies surviving a navigation.
 * None of those is visible below the browser.
 *
 * It is also a regression guard with a specific past. The logout control lived
 * on the dashboard's PageHeader alone until 2026-09-18 — a leftover of the
 * starter kit, whose deleted auth-button.tsx had surfaced it on the old
 * marketing `/` page. A rep on /merchants had to navigate home to get out.
 * Nothing failed; no test ever asked. Hence assertion 1 below sweeps several
 * routes rather than trusting one.
 */

/** Routes both roles can reach, used to prove the control is shell-wide. */
const SHELL_ROUTES = ["/dashboard", "/merchants", "/leads"];

const logoutButton = (page: Page): Locator =>
  page.getByRole("button", { name: "Log out" });

/**
 * Tab until the button holds focus, and report how many presses it took.
 *
 * Real key presses rather than `.focus()`, because `:focus-visible` is what is
 * being measured and it resolves differently for programmatic focus. The bound
 * is a failure mode, not a tuning knob: if the control ever stops being
 * keyboard-reachable — a `div`, a `tabindex="-1"`, an `aria-hidden` ancestor —
 * this runs out rather than hanging until the suite times out.
 */
async function tabTo(page: Page, target: Locator, maxPresses = 40): Promise<number> {
  for (let presses = 1; presses <= maxPresses; presses += 1) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((el) => el === document.activeElement)) {
      return presses;
    }
  }
  throw new Error(
    `Tabbed ${maxPresses} times without reaching the log out button. ` +
      `It is not in the keyboard tab order.`,
  );
}

for (const persona of ["agent", "admin"] as PersonaKey[]) {
  test.describe(`signed in as ${persona}`, () => {
    test.use({ storageState: storageStateFor(persona) });

    test("offers a way out from every page in the shell", async ({ page }) => {
      for (const route of SHELL_ROUTES) {
        await page.goto(route);
        await expect(
          logoutButton(page),
          `no log out control on ${route}`,
        ).toBeVisible();
      }
    });

    test("is keyboard reachable and shows a visible focus ring", async ({
      page,
    }) => {
      await page.goto("/dashboard");

      const button = logoutButton(page);
      await expect(button).toBeVisible();

      // A real <button>, not a clickable div dressed up as one. getByRole above
      // already implies it, but naming it here is what makes the intent survive
      // someone "simplifying" the locator later.
      await expect(button).toHaveJSProperty("tagName", "BUTTON");

      // Unfocused, the ring classes are all `focus-visible:`-prefixed, so
      // nothing paints a shadow. Captured first so the assertion after the Tab
      // is a measured change rather than a guess about the default.
      const resting = await button.evaluate(
        (el) => getComputedStyle(el).boxShadow,
      );
      expect(resting).toBe("none");

      await tabTo(page, button);
      await expect(button).toBeFocused();

      // The ring is a box-shadow in Tailwind. This is the assertion that fails
      // if someone drops the focus-visible classes — a bare toBeFocused() would
      // still pass with no visible indicator at all, which is the whole bug
      // this test exists to catch.
      const focused = await button.evaluate(
        (el) => getComputedStyle(el).boxShadow,
      );
      expect(
        focused,
        "focused log out button painted no focus ring",
      ).not.toBe("none");
    });

  });
}

/**
 * The destructive half, deliberately on a persona of its own.
 *
 * Clicking the button really does sign the account out, and `signOut()` defaults
 * to `scope: "global"` — which revokes that user's refresh tokens server-side for
 * every device. Run as `agent`, this reds root-redirect.spec.ts's rotated-cookie
 * test two files later, because that spec forces a token refresh the sign-out has
 * already killed. Measured, not guessed: it failed exactly that way first.
 *
 * The role is incidental here — whether an admin's button works is covered above
 * by the presence and focus tests. What this proves is that clicking it ends a
 * session, and one account is enough to prove that.
 */
test.describe("clicking it actually ends the session", () => {
  test.use({ storageState: storageStateFor("logout") });

  test("signs you out and keeps you out", async ({ page }) => {
    await page.goto("/merchants");
    await logoutButton(page).click();

    await expect(page).toHaveURL(/\/auth\/login$/);
    await expect(page.getByLabel("Email")).toBeVisible();

    // The load-bearing half. Landing on /auth/login only proves the router
    // moved; coming back to a protected route and being turned away again is
    // what proves the session is actually gone rather than merely navigated
    // away from.
    await page.goto("/merchants");
    await expect(page).toHaveURL(/\/auth\/login$/);
    await expect(logoutButton(page)).toHaveCount(0);
  });
});

test.describe("signed out", () => {
  // An explicitly empty state, not merely the absence of `test.use` — without
  // it a spec inherits whatever the project config supplies, and "signed out"
  // quietly becomes "however the last project was configured". Same reasoning
  // as root-redirect.spec.ts.
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const route of ["/auth/login", "/auth/forgot-password"]) {
    test(`${route} offers no log out control`, async ({ page }) => {
      await page.goto(route);

      // These pages are outside the (app) route group, so they get no topbar at
      // all. Asserted anyway: it is cheap, and it is what would catch someone
      // "helpfully" hoisting the shell into the root layout.
      await expect(logoutButton(page)).toHaveCount(0);
    });
  }
});
