import { open } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { marketingMaterialIds, seedE2E, storageStateFor } from "./fixtures/seed";

/**
 * The marketing "Publish a material" form refuses an oversized file in a
 * sentence that does not contradict itself. Same formatter and the same
 * defect as the business-documents form (see e2e/business-document-upload.spec.ts):
 * 50 MiB + 1 byte used to read "That file is 50 MiB. The limit is 50 MiB."
 */

const TITLE = "E2E oversized material";
const LIMIT = 50 * 1024 * 1024;

test.use({ storageState: storageStateFor("admin") });

test.beforeAll(async () => {
  await seedE2E();
});

test("an oversized material is refused before upload, without contradicting itself", async ({ page }, testInfo) => {
  // Sparse file on disk: Playwright refuses an in-memory file over 50 MB.
  const hugePath = testInfo.outputPath("huge-material.bin");
  const handle = await open(hugePath, "w");
  await handle.truncate(LIMIT + 1);
  await handle.close();

  await page.goto("/marketing/manage");
  await page.locator("#material_category").fill("E2E Upload checks");
  await page.locator("#material_title").fill(TITLE);
  await page.locator("#material_file").setInputFiles(hugePath);

  await expect(page.getByText("That file is slightly over the 50 MiB limit.")).toBeVisible();
  await expect(page.getByText("That file is 50 MiB. The limit is 50 MiB.")).toHaveCount(0);
  // Refused in the browser: no row was created for it.
  expect(await marketingMaterialIds(TITLE)).toEqual([]);
});
