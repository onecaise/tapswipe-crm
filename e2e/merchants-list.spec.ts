import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import {
  PAGING_FIXTURE,
  clearPagingMerchants,
  pagingDba,
  pagingMid,
  seedPagingMerchants,
  storageStateFor,
} from "./fixtures/seed";

/**
 * The merchants list, paged, sorted and filtered on the server (phase 1a of
 * docs/design/merchants-and-dashboard.md).
 *
 * tests/rls/merchant-list-view.test.ts owns who sees which rows through the
 * view, and tests/unit/merchant-list.test.ts the URL rules. What only a
 * browser shows is that the page puts them together: the header links and
 * their aria-sort, the page boundaries and the total, the URL surviving a
 * reload, the agent controls absent for a rep, and the phone layout's sort
 * chips.
 *
 * Every test narrows to PAGING_FIXTURE's thirty merchants with the one rate
 * nothing else in the seed uses, so counts and orders are exact whatever else
 * the database holds. MID n is pagingMid(n); DBAs run the other way, and the
 * added dates step back a day per n, so "newest first" is MID 001.
 */

const ONLY_FIXTURE = `split_min=${PAGING_FIXTURE.rate}&split_max=${PAGING_FIXTURE.rate}`;
const LIST = `/merchants?${ONLY_FIXTURE}`;

test.beforeAll(async () => {
  await seedPagingMerchants();
});

test.afterAll(async () => {
  await clearPagingMerchants();
});

/** The table's body rows (the cards are display:none at this width). */
function bodyRows(page: Page) {
  return page.getByRole("table").getByRole("row").filter({ has: page.getByRole("cell") });
}

/** The MID column, in table order. */
async function mids(page: Page): Promise<string[]> {
  return bodyRows(page).locator("td:nth-child(2)").allInnerTexts();
}

function header(page: Page, name: string) {
  return page.getByRole("columnheader", { name: new RegExp(`^${name}`) });
}

test.describe("an admin on the merchants list", () => {
  test.use({ storageState: storageStateFor("admin") });

  test("pages 25 at a time with the total, and Previous/Next", async ({ page }) => {
    await page.goto(LIST);
    await expect(page.getByTestId("list-total")).toHaveText("30 merchants · showing 1–25");
    await expect(bodyRows(page)).toHaveCount(25);
    await expect(page.getByText("Previous")).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByText("Page 1 of 2")).toBeVisible();

    await page.getByRole("link", { name: "Next" }).click();
    await expect(page).toHaveURL(/[?&]page=2(&|$)/);
    await expect(page.getByTestId("list-total")).toHaveText("30 merchants · showing 26–30");
    await expect(bodyRows(page)).toHaveCount(5);
    await expect(page.getByText("Next")).toHaveAttribute("aria-disabled", "true");
  });

  test("changes the page size, back to page 1", async ({ page }) => {
    await page.goto(`${LIST}&page=2`);
    await page.getByRole("link", { name: "50 per page" }).click();
    await expect(page).toHaveURL(/[?&]size=50(&|$)/);
    await expect(page).not.toHaveURL(/[?&]page=/);
    await expect(bodyRows(page)).toHaveCount(30);
    await expect(page.getByRole("link", { name: "50 per page" })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  test("defaults to newest first, marked on the Added header", async ({ page }) => {
    await page.goto(LIST);
    await expect(header(page, "Added")).toHaveAttribute("aria-sort", "descending");
    await expect(header(page, "DBA")).not.toHaveAttribute("aria-sort", /.*/);
    expect((await mids(page)).slice(0, 3)).toEqual([pagingMid(1), pagingMid(2), pagingMid(3)]);
  });

  test("sorts by MID as text, both ways, from page 1", async ({ page }) => {
    await page.goto(`${LIST}&page=2`);
    await page.getByRole("link", { name: "Sort by MID" }).click();
    await expect(page).toHaveURL(/[?&]sort=mid(&|$)/);
    await expect(page).not.toHaveURL(/[?&]page=/);
    await expect(header(page, "MID")).toHaveAttribute("aria-sort", "ascending");
    expect(await mids(page)).toEqual(
      Array.from({ length: 25 }, (_, i) => pagingMid(i + 1)),
    );

    await page.getByRole("link", { name: "Sort by MID, Z to A" }).click();
    await expect(page).toHaveURL(/[?&]dir=desc(&|$)/);
    await expect(header(page, "MID")).toHaveAttribute("aria-sort", "descending");
    expect((await mids(page))[0]).toBe(pagingMid(30));
  });

  test("sorts by DBA, which is not the MID order", async ({ page }) => {
    await page.goto(LIST);
    await page.getByRole("link", { name: "Sort by DBA" }).click();
    await expect(header(page, "DBA")).toHaveAttribute("aria-sort", "ascending");
    await expect(bodyRows(page).first()).toContainText(pagingDba(30));
    expect((await mids(page))[0]).toBe(pagingMid(30));
  });

  test("keeps sort, size and page across a reload", async ({ page }) => {
    await page.goto(`${LIST}&sort=mid&dir=desc&page=2`);
    const before = await mids(page);
    expect(before).toEqual(
      Array.from({ length: 5 }, (_, i) => pagingMid(5 - i)),
    );
    await page.reload();
    expect(await mids(page)).toEqual(before);
    await expect(header(page, "MID")).toHaveAttribute("aria-sort", "descending");
  });

  test("shows the last page for a page past the end", async ({ page }) => {
    await page.goto(`${LIST}&page=9`);
    await expect(page.getByText("Page 2 of 2")).toBeVisible();
    await expect(page.getByTestId("list-total")).toHaveText("30 merchants · showing 26–30");
  });

  test("applies the filter form, and Clear filters keeps the order", async ({ page }) => {
    await page.goto("/merchants?sort=mid");
    await page.getByLabel("Split from").fill(String(PAGING_FIXTURE.rate));
    await page.getByLabel("Split to").fill(String(PAGING_FIXTURE.rate));
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page).toHaveURL(/split_min=12\.34/);
    await expect(page.getByTestId("list-total")).toHaveText("30 merchants · showing 1–25");
    await expect(header(page, "MID")).toHaveAttribute("aria-sort", "ascending");

    await page.getByRole("link", { name: "Clear filters" }).click();
    await expect(page).toHaveURL(/\/merchants\?sort=mid$/);
  });

  test("offers the Agent filter, column and sort", async ({ page }) => {
    await page.goto(LIST);
    await expect(page.getByLabel("Agent")).toBeVisible();
    await expect(header(page, "Agent")).toBeVisible();
    await expect(bodyRows(page).first()).toContainText("E2E Agent Two");
  });

  test("has no axe violations in the list's controls", async ({ page }) => {
    await page.goto(LIST);
    await page.waitForLoadState("networkidle");
    const result = await new AxeBuilder({ page })
      .include("main")
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();
    const where = result.violations.flatMap((v) =>
      v.nodes.map((n) => `${v.id}: ${n.target.join(" ")}`),
    );
    expect(where).toEqual([]);
  });
});

test.describe("the rep who owns them", () => {
  test.use({ storageState: storageStateFor("agent2") });

  test("sees them paged, with no Agent filter, column or sort", async ({ page }) => {
    await page.goto(`${LIST}&sort=agent`);
    await expect(page.getByTestId("list-total")).toHaveText("30 merchants · showing 1–25");
    await expect(page.getByLabel("Agent")).toHaveCount(0);
    await expect(header(page, "Agent")).toHaveCount(0);
    // ?sort=agent is dropped for a rep: the default order stands.
    await expect(header(page, "Added")).toHaveAttribute("aria-sort", "descending");
  });
});

test.describe("another rep", () => {
  test.use({ storageState: storageStateFor("agent") });

  test("sees none of them", async ({ page }) => {
    await page.goto(LIST);
    await expect(page.getByTestId("list-total")).toHaveText("0 merchants");
    await expect(page.getByText("No merchants match these filters.")).toBeVisible();
  });
});

test.describe("on a phone", () => {
  test.use({ storageState: storageStateFor("admin"), viewport: { width: 375, height: 812 } });

  test("shows cards and sorts with the chips", async ({ page }) => {
    await page.goto(LIST);
    await expect(page.getByRole("table")).toBeHidden();
    const sort = page.getByRole("navigation", { name: "Sort merchants" });
    await expect(sort.getByRole("link", { name: "Added, newest first" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    await sort.getByRole("link", { name: "MID", exact: true }).click();
    await expect(page).toHaveURL(/[?&]sort=mid(&|$)/);
    await expect(sort.getByRole("link", { name: "MID, A to Z" })).toBeVisible();
    const firstCard = page.getByRole("listitem").filter({ hasText: pagingMid(1) }).first();
    await expect(firstCard).toBeVisible();
    // No horizontal page scroll at phone width.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
