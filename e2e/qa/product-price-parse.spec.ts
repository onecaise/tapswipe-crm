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
