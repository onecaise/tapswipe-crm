import fs from "node:fs";
import { test } from "@playwright/test";
import { STORE_FIXTURE, brandIdByName, clearCatalogBrand, storageStateFor } from "../../e2e/fixtures/seed";

const log: string[] = [];
const note = (s: string) => { log.push(s); console.log(s); };
const BRAND = "QA Explore Brand";

test("catalog admin edge cases", async ({ browser }) => {
  test.setTimeout(600_000);
  await clearCatalogBrand(BRAND).catch(() => {});
  await clearCatalogBrand("QA Explore Renamed").catch(() => {});
  const ctx = await browser.newContext({ storageState: storageStateFor("admin") });
  const page = await ctx.newPage();
  const errs: string[] = [];
  page.on("pageerror", (e) => errs.push(e.message));

  await page.goto("/admin/products");
  // duplicate brand with different case
  await page.getByRole("button", { name: "Add brand" }).click();
  await page.getByLabel("Brand name").fill(STORE_FIXTURE.brand.toUpperCase());
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.waitForTimeout(1500);
  note(`dup brand (case): url=${page.url()} msg=${(await page.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 300)}`);

  await page.goto("/admin/products");
  await page.getByRole("button", { name: "Add brand" }).click();
  await page.getByLabel("Brand name").fill(BRAND);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.waitForURL(/\/admin\/products\/\d+$/);
  const brandUrl = page.url();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "qa/screens/catalog-after-add-brand.png", fullPage: true });
  note(`after add brand: brand-name inputs visible=${await page.locator("#new-brand-name").isVisible().catch(() => false)} h1=${await page.locator("h1:visible").innerText()}`);

  const addProduct = async (name: string, sku: string, price: string) => {
    await page.getByRole("button", { name: "Add product" }).click();
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByLabel("Model / SKU").fill(sku);
    await page.getByLabel("Type").fill("QA type");
    await page.getByLabel("List price").fill(price);
    await page.getByRole("button", { name: "Add product" }).click();
    await page.waitForTimeout(1500);
    return (await page.locator("main").innerText()).replace(/\s+/g, " ");
  };
  note(`dup sku: ${(await addProduct("QA Dup Sku", STORE_FIXTURE.device.sku, "10")).slice(0, 500)}`);
  await page.goto(brandUrl);
  await page.goto(brandUrl);
  note(`price 0x10: ${(await addProduct("QA Hex Price", "QA-HEX", "0x10")).slice(0, 400)}`);
  await page.goto(brandUrl);
  note(`price 1e3: ${(await addProduct("QA Exp Price", "QA-EXP", "1e3")).slice(0, 400)}`);

  // delete brand while products exist
  await page.goto(brandUrl);
  note(`brand page buttons: ${(await page.getByRole("button").allInnerTexts()).join(" / ")}`);
  const del = page.getByRole("button", { name: /^Delete/ }).first();
  if (await del.count()) {
    await del.click();
    await page.waitForTimeout(300);
    note(`after delete click buttons: ${(await page.getByRole("button").allInnerTexts()).join(" / ")}`);
    const confirm = page.getByRole("button", { name: /delete/i }).last();
    await confirm.click();
    await page.waitForTimeout(1500);
    note(`delete w/ products: url=${page.url()} ${(await page.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 300)}`);
  }
  // rename to existing brand
  await page.goto(brandUrl);
  await page.getByRole("button", { name: /Rename/ }).click();
  await page.getByLabel(/name/i).first().fill(STORE_FIXTURE.otherBrand);
  await page.getByRole("button", { name: /Save|Rename/ }).first().click();
  await page.waitForTimeout(1500);
  note(`rename to existing: ${(await page.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 300)}`);
  await page.screenshot({ path: "qa/screens/catalog-rename.png", fullPage: true });

  note(`brand id: ${await brandIdByName(BRAND).catch((e) => String(e))}`);
  note(`errors: ${errs.join(" | ")}`);
  await clearCatalogBrand(BRAND).catch((e) => note(`cleanup: ${e}`));
  fs.writeFileSync("qa/screens/catalog.txt", log.join("\n"));
});
