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

test("at 1024 with the sidebar hidden, every column fits too", async ({
  page,
}) => {
  await openUsers(page, 1024);
  await page.getByRole("button", { name: "Hide menu" }).click();
  await expect(page.locator("#app-sidebar")).toBeHidden();

  const o = await overflow(page);
  expect(o.scrollWidth, "table scrolls sideways").toBeLessThanOrEqual(o.clientWidth);
  expect(o.pageScrollWidth).toBeLessThanOrEqual(o.viewport);
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
});
