import { expect, test } from "@playwright/test";

import { catalogRows, clearCatalogBrand, storageStateFor } from "../fixtures/seed";

/**
 * QA-003. parsePriceInput() handed the cleaned text to Number(), which reads
 * JavaScript numeric literals, not prices: "0x10" was saved as a $16.00 list
 * price and "1e3" as $1,000.00. A price typed or pasted wrong must be refused,
 * not reinterpreted into a different figure that then lands on proposals.
 */
test.use({ storageState: storageStateFor("admin") });

const BRAND = "QA Price Parse Brand";

test.beforeAll(async () => {
  await clearCatalogBrand(BRAND);
});
test.afterAll(async () => {
  await clearCatalogBrand(BRAND);
});

test("QA-003 a list price that is not a plain decimal is refused, not reinterpreted", async ({ page }) => {
  await page.goto("/admin/products");
  await page.getByRole("button", { name: "Add brand" }).click();
  await page.getByLabel("Brand name").fill(BRAND);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/products\/\d+$/);

  for (const typed of ["0x10", "1e3"]) {
    await page.getByRole("button", { name: "Add product" }).click();
    await page.getByLabel("Name", { exact: true }).fill(`QA price ${typed}`);
    await page.getByLabel("Type").fill("QA type");
    await page.getByLabel("List price").fill(typed);
    await page.getByRole("button", { name: "Add product" }).click();
    await expect(page.getByText("That is not a number.")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
  }

  expect((await catalogRows(BRAND)).products).toEqual([]);

  // What an admin copying from a price sheet types is still accepted.
  await page.getByRole("button", { name: "Add product" }).click();
  await page.getByLabel("Name", { exact: true }).fill("QA price sheet");
  await page.getByLabel("Type").fill("QA type");
  await page.getByLabel("List price").fill("$1,299.50");
  await page.getByRole("button", { name: "Add product" }).click();
  await expect(page.getByText("$1,299.50")).toBeVisible();
});

/**
 * A1. Commas used to be stripped wherever they sat, so a decimal comma —
 * "12,99", which is how much of the world writes twelve ninety-nine — was saved
 * as a $1,299.00 list price. It must be refused with a sentence that says how to
 * type it, and nothing saved.
 */
test("A1 a decimal comma is refused, not read as thousands", async ({ page }) => {
  await page.goto("/admin/products");
  const brandLink = page.getByRole("link", { name: new RegExp(BRAND) });
  if ((await brandLink.count()) === 0) {
    await page.getByRole("button", { name: "Add brand" }).click();
    await page.getByLabel("Brand name").fill(BRAND);
    await page.getByRole("button", { name: "Add", exact: true }).click();
  } else {
    await brandLink.first().click();
  }
  await expect(page).toHaveURL(/\/admin\/products\/\d+$/);

  await page.getByRole("button", { name: "Add product" }).click();
  await page.getByLabel("Name", { exact: true }).fill("QA price decimal comma");
  await page.getByLabel("Type").fill("QA type");
  await page.getByLabel("List price").fill("12,99");
  await page.getByRole("button", { name: "Add product" }).click();
  await expect(page.getByText("Use a period for decimals, for example 12.99")).toBeVisible();

  const { products } = await catalogRows(BRAND);
  expect(products.filter((p) => p.name === "QA price decimal comma")).toEqual([]);
});
