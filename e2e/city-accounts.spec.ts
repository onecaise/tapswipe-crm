import { expect, test, type Page } from "@playwright/test";

import {
  CITY_FIXTURE,
  PERSONAS,
  publicStackConfig,
  storageStateFor,
} from "./fixtures/seed";

/**
 * "Find accounts in a city" on the dashboard, the Dashboard nav row, and the
 * admin's missing-location count.
 *
 * tests/rls/accounts-in-city.test.ts owns the SEMANTICS — the four-key shape,
 * normalisation, wildcards, the cap, the status rule, prosecdef. What only a
 * browser can show is that the page asks the right question and renders only
 * what came back: that a rep's screen carries no link, rep, status, street or
 * ZIP for another rep's merchant, that the states (loading, empty, invalid,
 * more) are distinguishable, and that it all fits at 390px with a keyboard.
 *
 * The "direct RPC" tests forge the call with the credential the browser is
 * carrying right now, the way someone with devtools open would — the question
 * is what THAT token can extract, not what a fresh one could.
 */

const RPC = "**/rest/v1/rpc/accounts_in_city";
const c = CITY_FIXTURE;

async function accessTokenFrom(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  const authCookie = cookies.find((x) => x.name.endsWith("-auth-token"));
  if (!authCookie) throw new Error("no auth cookie on the signed-in page");
  const raw = authCookie.value.startsWith("base64-")
    ? Buffer.from(authCookie.value.slice("base64-".length), "base64").toString("utf8")
    : decodeURIComponent(authCookie.value);
  return (JSON.parse(raw) as { access_token: string }).access_token;
}

function searchCard(page: Page) {
  return page.getByRole("region", { name: "Find accounts in a city" });
}

/** Fills the card and submits by keyboard; returns the RPC's JSON body. */
async function searchFor(
  page: Page,
  city: string,
  state = "",
): Promise<unknown> {
  const card = searchCard(page);
  await card.getByLabel("City").fill(city);
  await card.getByLabel("State (optional)").selectOption(state);
  const response = page.waitForResponse(RPC);
  await card.getByLabel("City").press("Enter");
  return (await response).json();
}

function results(page: Page) {
  return searchCard(page).getByRole("list", { name: /^Accounts in / }).getByRole("listitem");
}

test.describe("as an agent", () => {
  test.use({ storageState: storageStateFor("agent") });

  test.beforeEach(async ({ page }) => {
    await page.goto("/dashboard");
    await expect(searchCard(page)).toBeVisible();
  });

  test("the sidebar's first item is Dashboard, and it is the current page", async ({ page }) => {
    const first = page.getByRole("navigation").getByRole("link").first();
    await expect(first).toHaveText(/Dashboard/);
    await expect(first).toHaveAttribute("href", "/dashboard");
    await expect(first).toHaveAttribute("aria-current", "page");
  });

  test("finds own and other reps' accounts, showing only DBA, legal name and city/state", async ({ page }) => {
    const body = (await searchFor(page, c.city, c.state)) as {
      results: Record<string, unknown>[];
      has_more: boolean;
    };

    // On the wire: exactly four keys per account, own and other alike.
    expect(body.results.map((r) => r.dba).sort()).toEqual([c.own.dba, c.other.dba].sort());
    for (const r of body.results) {
      expect(Object.keys(r).sort()).toEqual(["city", "dba", "legal_business_name", "state"]);
    }

    // On screen: both names, the closed one absent, and nothing else of the
    // other rep's merchant — no link, no rep, no status, no street, no ZIP.
    const items = results(page);
    await expect(items).toHaveCount(2);
    const rival = items.filter({ hasText: c.other.dba });
    await expect(rival).toContainText(c.other.legal);
    await expect(rival).toContainText(`${c.city}, ${c.state}`);
    await expect(rival.getByRole("link")).toHaveCount(0);
    const list = searchCard(page).getByRole("list", { name: /^Accounts in / });
    for (const hidden of [
      c.other.street,
      c.other.zip,
      PERSONAS.agent2.fullName,
      "Rep:",
      "active",
      c.closed.dba,
    ]) {
      await expect(list).not.toContainText(hidden);
    }
  });

  test("matches case, spacing and punctuation variants", async ({ page }) => {
    await searchFor(page, "  larkspur   HOLLOW. ");
    await expect(results(page)).toHaveCount(2);
  });

  test("says plainly when a city has no accounts", async ({ page }) => {
    await searchFor(page, "Nowhereville Junction");
    await expect(searchCard(page)).toContainText("No accounts found in that city");
  });

  test("explains invalid input instead of searching", async ({ page }) => {
    const card = searchCard(page);
    await card.getByRole("button", { name: "Search" }).click();
    await expect(card.getByRole("alert")).toHaveText("Enter a city.");

    await searchFor(page, "%");
    await expect(card.getByRole("alert")).toContainText("at least 2 letters");
  });

  test("shows a loading state while the search is in flight", async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(RPC, async (route) => {
      await held;
      await route.continue();
    });

    const card = searchCard(page);
    await card.getByLabel("City").fill(c.city);
    await card.getByRole("button", { name: "Search" }).click();
    await expect(card.getByRole("button", { name: "Searching…" })).toBeDisabled();
    release();
    await expect(results(page)).toHaveCount(2);
  });

  test("says when more accounts exist than are shown", async ({ page }) => {
    await searchFor(page, c.many.city);
    await expect(results(page)).toHaveCount(100);
    await expect(searchCard(page)).toContainText(`Showing the first 100 accounts in ${c.many.city}`);
    await expect(searchCard(page)).toContainText("More accounts exist than are shown here");
  });

  test("works by keyboard alone, in label order", async ({ page }) => {
    const card = searchCard(page);
    await card.getByLabel("City").focus();
    await page.keyboard.type(c.city);
    await page.keyboard.press("Tab");
    await expect(card.getByLabel("State (optional)")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(card.getByRole("button", { name: "Search" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(results(page)).toHaveCount(2);
  });

  test("fits a 390px screen with results showing, with no horizontal scroll", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await searchFor(page, c.city);
    await expect(results(page)).toHaveCount(2);
    const overflow = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      body: document.body.scrollWidth - document.body.clientWidth,
    }));
    expect(overflow.doc).toBeLessThanOrEqual(0);
    expect(overflow.body).toBeLessThanOrEqual(0);
    const box = await searchCard(page).boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);

    // And per element, because a document-level check only sees overflow
    // that reaches the page: ink that runs out of a card under an ancestor
    // with overflow hidden never scrolls anything (the StatCard bug). Both
    // checks go red when the results' wrapping is reverted to nowrap — the
    // fixture's long unbroken legal name is what makes that revert visible.
    const clipped = await searchCard(page).evaluate((section) =>
      [section, ...section.querySelectorAll("li")]
        .filter((el) => el.scrollWidth > el.clientWidth)
        .map((el) => el.textContent?.slice(0, 40)),
    );
    expect(clipped).toEqual([]);
  });

  test("sees no missing-location count, and cannot open the admin list", async ({ page }) => {
    await expect(page.getByText("Merchants missing a location")).toHaveCount(0);
    await page.goto("/admin/merchants/missing-location");
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test("a direct RPC call with wildcards or oversized input extracts nothing", async ({ page, request }) => {
    const { apiUrl, publishableKey } = publicStackConfig();
    const token = await accessTokenFrom(page);
    const call = (city: string, state?: string) =>
      request.post(`${apiUrl}/rest/v1/rpc/accounts_in_city`, {
        headers: {
          apikey: publishableKey,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        data: state === undefined ? { city } : { city, state },
      });

    // Wildcards alone normalise to nothing: refused, not "match everything".
    for (const city of ["%", "_", "*", "%%%", "%_*", "L*", "%L%"]) {
      const r = await call(city);
      expect(r.status(), city).toBe(400);
      expect((await r.json()).message).toMatch(/at least 2 letters/);
    }
    // Wildcards around real letters are punctuation, not patterns: no match.
    for (const city of ["Larkspur%", "%Hollow", "Larkspur_", "La*", "Lark%Hol"]) {
      const r = await call(city);
      expect(r.status(), city).toBe(200);
      expect(await r.json()).toEqual({ results: [], has_more: false });
    }
    // A state pattern is refused rather than matched.
    expect((await call(c.city, "%")).status()).toBe(400);

    // Oversized input is refused before any lookup.
    for (const city of ["L".repeat(61), "Larkspur Hollow ".repeat(400)]) {
      const r = await call(city);
      expect(r.status()).toBe(400);
      expect((await r.json()).message).toMatch(/at most 60/);
    }

    // And the honest call still gets only the four fields.
    const ok = await call(c.city, c.state);
    expect(ok.status()).toBe(200);
    const body = (await ok.json()) as { results: Record<string, unknown>[] };
    expect(body.results).toHaveLength(2);
    for (const r of body.results) {
      expect(Object.keys(r).sort()).toEqual(["city", "dba", "legal_business_name", "state"]);
    }
  });
});

test.describe("as an admin", () => {
  test.use({ storageState: storageStateFor("admin") });

  test.beforeEach(async ({ page }) => {
    await page.goto("/dashboard");
    await expect(searchCard(page)).toBeVisible();
  });

  test("also sees the rep, status, street, ZIP and a link for each account", async ({ page }) => {
    await searchFor(page, c.city, c.state);
    const rival = results(page).filter({ hasText: c.other.dba });
    await expect(rival).toContainText(`Rep: ${PERSONAS.agent2.fullName}`);
    await expect(rival).toContainText(c.other.street);
    await expect(rival).toContainText(c.other.zip);
    await expect(rival).toContainText("active");
    const link = rival.getByRole("link", { name: c.other.dba });
    await expect(link).toHaveAttribute("href", /^\/merchants\/\d+$/);
    // Still no closed merchant, for an admin too.
    await expect(results(page)).toHaveCount(2);

    await link.click();
    await expect(page).toHaveURL(/\/merchants\/\d+$/);
    await expect(page.getByRole("heading", { name: c.other.dba })).toBeVisible();
    await expect(
      page.getByRole("definition").filter({ hasText: `${c.city}, ${c.state}` }),
    ).toBeVisible();
  });

  test("the missing-location count matches the list it links to", async ({ page }) => {
    const card = page.locator('[data-slot="stat-card"]', {
      hasText: "Merchants missing a location",
    });
    await expect(card).toBeVisible();
    const figure = Number(
      (await card.locator("p").last().textContent())?.trim(),
    );
    expect(Number.isInteger(figure)).toBe(true);

    await card.click();
    await expect(page).toHaveURL(/\/admin\/merchants\/missing-location$/);
    await expect(
      page.getByRole("heading", { name: "Merchants missing a location" }),
    ).toBeVisible();
    const rows = page.getByRole("list", { name: "Merchants missing a location" }).getByRole("listitem");
    if (figure === 0) {
      await expect(page.getByText("Every merchant has a city and state.")).toBeVisible();
    } else {
      await expect(rows).toHaveCount(figure);
    }
  });
});
