import { expect, test, type Page } from "@playwright/test";

import {
  STORE_FIXTURE,
  brandIdByName,
  catalogRows,
  clearCatalogBrand,
  seedE2E,
  storageStateFor,
} from "./fixtures/seed";

/**
 * /admin/products as boxes: a grid of brands, each opening a compact list.
 *
 * What only a browser can show, and so what belongs here rather than in
 * tests/rls (where the brands table's access rules are already pinned):
 *
 *   1. The admin's whole loop works end to end — add a brand, add a device,
 *      add an add-on and link it through the searchable multi-select, archive
 *      and restore — and each step is checked against the TABLES as well as
 *      the page, because a page that rendered the right row while writing a
 *      different one would look identical.
 *   2. The picker is limited to THIS brand's devices. Another brand's device
 *      exists in the database (the store fixture's) and must not be offered.
 *   3. A rep cannot reach any of it.
 *   4. Nothing scrolls sideways at 375 / 768 / 1440.
 *
 * Names are unique to this spec and cleared before AND after, because a run
 * that died halfway leaves the brand behind, and "Add brand" would then hit
 * the name's unique index on the next run.
 */

const BRAND = "E2E Boxes Brand";
const DEVICE = { name: "E2E Boxes Terminal", sku: "E2E-BOX-TERM", price: "349" };
const ADDON = { name: "E2E Boxes Stand", sku: "E2E-BOX-STAND" };

test.beforeAll(async () => {
  await seedE2E();
  await clearCatalogBrand(BRAND);
});

test.afterAll(async () => {
  await clearCatalogBrand(BRAND);
});

/** A product's row on a brand page, by its name. */
const productRow = (page: Page, name: string) =>
  page
    .getByRole("listitem")
    .filter({ has: page.getByText(name, { exact: true }) });

async function expectNoSidewaysScroll(page: Page, width: number) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    overflow.scrollWidth,
    `the page scrolls sideways at ${width}px`,
  ).toBeLessThanOrEqual(overflow.clientWidth);
}

test.describe("an admin managing the catalog", () => {
  test.use({ storageState: storageStateFor("admin") });
  test.describe.configure({ mode: "serial" });

  let brandUrl = "";

  test("adds a brand from the grid and lands on its empty page", async ({
    page,
  }) => {
    await page.goto("/admin/products");
    await page.getByRole("button", { name: "Add brand" }).click();
    await page.getByLabel("Brand name").fill(BRAND);
    await page.getByRole("button", { name: "Add", exact: true }).click();

    await expect(page).toHaveURL(/\/admin\/products\/\d+$/);
    await expect(page.getByRole("heading", { name: BRAND })).toBeVisible();
    await expect(page.getByText("No products in this brand yet.")).toBeVisible();
    brandUrl = page.url();

    // Back on the grid, the new brand is a box with nothing in it yet.
    await page.goto("/admin/products");
    await expect(
      page.getByRole("link", { name: new RegExp(`^${BRAND}\\s*0 products`) }),
    ).toBeVisible();
  });

  test("adds a device by hand", async ({ page }) => {
    await page.goto(brandUrl);
    await page.getByRole("button", { name: "Add product" }).click();

    await page.getByLabel("Name").fill(DEVICE.name);
    await page.getByLabel("Model / SKU").fill(DEVICE.sku);
    await page.getByLabel("Type").fill("E2E countertop");
    await page.getByLabel("List price").fill(DEVICE.price);
    await page.getByLabel("Connectivity").fill("Wi-Fi / Ethernet");
    await page.getByLabel("Description").fill("Made by the boxes spec.");
    // Kind defaults to Device, billing to One-time — the column defaults.
    await page.getByRole("button", { name: "Add product" }).click();

    const row = productRow(page, DEVICE.name);
    await expect(row).toBeVisible();
    await expect(row.getByText("Device", { exact: true })).toBeVisible();
    await expect(row.getByText("$349.00")).toBeVisible();

    const { products } = await catalogRows(BRAND);
    expect(products).toEqual([
      expect.objectContaining({
        name: DEVICE.name,
        kind: "device",
        archived_at: null,
        specs: { connectivity: "Wi-Fi / Ethernet" },
      }),
    ]);
    expect(Number(products[0].list_price)).toBe(349);
  });

  test("adds an add-on that fits the device, through the multi-select", async ({
    page,
  }) => {
    await page.goto(brandUrl);
    await page.getByRole("button", { name: "Add product" }).click();

    await page.getByLabel("Name").fill(ADDON.name);
    await page.getByLabel("Model / SKU").fill(ADDON.sku);
    await page.getByLabel("Type").fill("E2E accessories");
    // Left blank on purpose: blank is "not priced yet", stored NULL, never 0.
    await page.getByLabel("Kind").selectOption("addon");

    const picker = page.getByRole("combobox", { name: "Fits these devices" });

    // Limited to THIS brand. The store fixture's terminal is a live device of
    // another brand, so it exists to be wrongly offered.
    await picker.fill(STORE_FIXTURE.device.name);
    await expect(page.getByText("No matching device.")).toBeVisible();

    await picker.fill("boxes term");
    await page.getByRole("option", { name: new RegExp(DEVICE.name) }).click();
    await expect(
      page.getByRole("button", { name: `Remove ${DEVICE.name}` }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Add product" }).click();

    const row = productRow(page, ADDON.name);
    await expect(row).toBeVisible();
    await expect(row.getByText("Add-on", { exact: true })).toBeVisible();
    await expect(row.getByText("No price")).toBeVisible();
    await expect(row.getByText("Fits nothing")).toHaveCount(0);

    // Devices first, then add-ons.
    const names = await page
      .getByTestId(/^product-row-/)
      .locator("span.font-medium")
      .allTextContents();
    expect(names).toEqual([DEVICE.name, ADDON.name]);

    const { products, links } = await catalogRows(BRAND);
    const device = products.find((p) => p.name === DEVICE.name)!;
    const addon = products.find((p) => p.name === ADDON.name)!;
    expect(addon.kind).toBe("addon");
    expect(addon.list_price).toBeNull();
    expect(links).toEqual([
      { addon_product_id: addon.id, device_product_id: device.id },
    ]);
  });

  test("archives and restores a product, and the grid counts it inactive", async ({
    page,
  }) => {
    await page.goto(brandUrl);
    const row = productRow(page, DEVICE.name);

    await row.getByRole("button", { name: `Archive ${DEVICE.name}` }).click();
    await expect(row.getByText("Archived", { exact: true })).toBeVisible();
    await expect(
      row.getByRole("button", { name: `Restore ${DEVICE.name}` }),
    ).toBeVisible();
    let device = (await catalogRows(BRAND)).products.find(
      (p) => p.name === DEVICE.name,
    )!;
    expect(device.archived_at).not.toBeNull();

    await page.goto("/admin/products");
    await expect(
      page.getByRole("link", {
        name: new RegExp(`^${BRAND}\\s*2 products\\s*1 inactive`),
      }),
    ).toBeVisible();

    await page.goto(brandUrl);
    await productRow(page, DEVICE.name)
      .getByRole("button", { name: `Restore ${DEVICE.name}` })
      .click();
    await expect(
      productRow(page, DEVICE.name).getByText("Active", { exact: true }),
    ).toBeVisible();
    device = (await catalogRows(BRAND)).products.find(
      (p) => p.name === DEVICE.name,
    )!;
    expect(device.archived_at).toBeNull();
  });

  for (const width of [375, 768, 1440]) {
    test(`nothing scrolls sideways at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });

      await page.goto("/admin/products");
      await expect(page.getByRole("button", { name: "Add brand" })).toBeVisible();
      await expectNoSidewaysScroll(page, width);

      await page.goto(brandUrl);
      await expect(productRow(page, ADDON.name)).toBeVisible();
      await expect(page.getByRole("button", { name: "Add product" })).toBeVisible();
      await expect(
        productRow(page, ADDON.name).getByRole("button", {
          name: `Archive ${ADDON.name}`,
        }),
      ).toBeVisible();
      await expectNoSidewaysScroll(page, width);

      // With the edit form and the picker open, which is the widest state.
      await productRow(page, ADDON.name)
        .getByRole("button", { name: `Edit ${ADDON.name}` })
        .click();
      await expect(
        page.getByRole("button", { name: `Remove ${DEVICE.name}` }),
      ).toBeVisible();
      await expectNoSidewaysScroll(page, width);
    });
  }
});

test.describe("a rep", () => {
  test.use({ storageState: storageStateFor("agent") });

  // A brand that EXISTS (the store fixture's). An invented id would 404 even
  // with the admin guard removed, and the spec would pass for the wrong
  // reason — a rep reading a real brand page is the case that matters.
  let realBrandPath = "";
  test.beforeAll(async () => {
    realBrandPath = `/admin/products/${await brandIdByName(STORE_FIXTURE.brand)}`;
  });

  for (const path of [
    "/admin/products",
    "/admin/products/unbranded",
    "a real brand's page",
  ]) {
    test(`is redirected away from ${path}`, async ({ page }) => {
      await page.goto(path.startsWith("/") ? path : realBrandPath);
      await expect(page).toHaveURL(/\/dashboard$/);
      await expect(page.getByRole("button", { name: "Add brand" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Add product" })).toHaveCount(0);
    });
  }

  test("has no Products item in the nav", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByRole("link", { name: "Products", exact: true })).toHaveCount(0);
  });
});
