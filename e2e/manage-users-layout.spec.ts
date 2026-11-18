import { expect, test, type Page } from "@playwright/test";

import { PERSONAS, storageStateFor } from "./fixtures/seed";

/**
 * Manage Users' layout at computer and iPad widths — layout being the one
 * thing only a browser can measure. What the columns contain is covered by
 * rep-identity, rep-split and user-import specs; this file only asks whether
 * all nine fit, and what happens when they do not.
 *
 * The admin persona's row is the anchor: it exists in every run, and its name
 * and address are fixed strings.
 *
 * The 1440 fit does not depend on which rows exist. Every column whose width
 * comes from data is capped (name and email 8rem, agent number 4.5rem,
 * territory 6rem, legal names 8rem with the "can't submit pre-apps yet" badge
 * wrapping inside it), so the table's natural width is bounded: about 1080px
 * with every column at its widest at once, against 1126px available. Leftover
 * rows from other specs can only make a column wider up to its cap.
 */

test.use({ storageState: storageStateFor("admin") });

const HEADERS = [
  "Name",
  "Agent #",
  "Territory",
  "Legal names",
  "Split",
  "Role",
  "Status",
  "Created",
  "Actions",
];

const container = (page: Page) =>
  page.locator('[data-slot="table-container"]');

async function overflow(page: Page) {
  return container(page).evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
    pageScrollWidth: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
}

async function openUsers(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/admin/users");
  await expect(
    page.getByRole("row", { name: new RegExp(PERSONAS.admin.fullName) }),
  ).toBeVisible();
}

test("at a desktop width every column fits without scrolling sideways", async ({
  page,
}) => {
  await openUsers(page, 1440);

  for (const name of HEADERS) {
    await expect(page.getByRole("columnheader", { name, exact: true })).toBeInViewport();
  }

  const o = await overflow(page);
  expect(o.scrollWidth, "table scrolls sideways").toBeLessThanOrEqual(o.clientWidth);
  expect(o.pageScrollWidth, "page scrolls sideways").toBeLessThanOrEqual(o.viewport);

  // The 1152px list cap is gone: the card spans the content column.
  const box = await container(page).boundingBox();
  expect(box!.width).toBeGreaterThan(1100);
});

/**
 * Shared by the two widths where nine columns do not fit: the card scrolls,
 * the page does not, and the name column stays put while it does.
 */
async function expectCardScrollWithNamePinned(page: Page) {
  const o = await overflow(page);
  // The fallback: the card scrolls, the page does not.
  expect(o.scrollWidth).toBeGreaterThan(o.clientWidth);
  expect(o.pageScrollWidth, "page scrolls sideways").toBeLessThanOrEqual(o.viewport);

  const nameCell = page
    .getByRole("row", { name: new RegExp(PERSONAS.admin.fullName) })
    .getByRole("cell")
    .first();
  const actionsHeader = page.getByRole("columnheader", { name: "Actions" });

  const before = await nameCell.boundingBox();
  await container(page).evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await expect(actionsHeader).toBeInViewport();

  const after = await nameCell.boundingBox();
  expect(after!.x).toBeCloseTo(before!.x, 0);
  await expect(nameCell).toBeInViewport();
}

// 958px of content column is not enough for nine columns with their labels
// as they are (the table needs about 975px with the fixture rows, more with
// long agent numbers or territories), so 1024 keeps the card's own scroll.
test("at 1024 with the sidebar hidden, the table scrolls inside its card, with the name column pinned", async ({
  page,
}) => {
  await openUsers(page, 1024);
  await page.getByRole("button", { name: "Hide menu" }).click();
  await expect(page.locator("#app-sidebar")).toBeHidden();

  await expectCardScrollWithNamePinned(page);
});

test("long text carries its full value in a title", async ({ page }) => {
  await openUsers(page, 1440);
  const row = page.getByRole("row", { name: new RegExp(PERSONAS.admin.fullName) });

  await expect(row.getByTitle(PERSONAS.admin.fullName, { exact: true })).toBeVisible();
  await expect(row.getByTitle(PERSONAS.admin.email, { exact: true })).toBeVisible();
});

test("on an iPad the table scrolls inside its card, with the name column pinned", async ({
  page,
}) => {
  await openUsers(page, 768);

  await expectCardScrollWithNamePinned(page);
});
