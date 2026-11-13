import { expect, test } from "@playwright/test";

import { storageStateFor } from "../fixtures/seed";
import { service } from "./qa-stack";
import { HEADER, XLSX_TYPE, clearQa, freeSlot, newMid, upload, workbook } from "./residual-files";

/**
 * B4 (D-08). Uploading a file that is not a residual report — a text file, an
 * empty file, a workbook missing the required columns — gave a clear message
 * but left a 0-row batch sitting in **Review** on /payouts/import until an
 * admin found it and pressed Abandon.
 *
 * The claim: none of those leaves a batch in Review. An empty file is refused
 * before any batch is created; the others are abandoned through the same
 * UPDATE the Abandon button runs (rep_payout_batches has no DELETE policy or
 * grant — a batch is the record that an import was attempted). A valid file
 * still lands on its review screen exactly as before.
 *
 * Phase 7 (docs/design/intake-and-reports.md): the file is the processor's six
 * columns, and the processor and month are chosen on the page. A file the
 * parser refuses OUTRIGHT -- missing columns, the CRM's own export -- is still
 * abandoned; one it reads but refuses row by row (an unknown MID) waits in
 * Review, because Read again can fix it.
 */
test.use({ storageState: storageStateFor("admin") });

const PREFIX = "qa-b4-";

async function batchesNamed(fileName: string) {
  const { data, error } = await service()
    .from("rep_payout_batches")
    .select("id, status, row_count, processor, period")
    .eq("file_name", fileName);
  if (error) throw new Error(error.message);
  return data as { id: number; status: string; row_count: number | null; processor: string; period: string }[];
}

test.beforeAll(() => clearQa(PREFIX));
test.afterAll(() => clearQa(PREFIX));

test("B4 an empty file is refused before any batch exists", async ({ page }) => {
  const name = `${PREFIX}empty.xlsx`;
  await upload(page, { name, buffer: Buffer.alloc(0) }, await freeSlot());
  await expect(page.getByText("That file is empty.")).toBeVisible();
  expect(await batchesNamed(name)).toEqual([]);
});

test("B4 a non-spreadsheet leaves no batch in Review", async ({ page }) => {
  const name = `${PREFIX}not-a-sheet.xlsx`;
  await upload(page, { name, buffer: Buffer.from("this is not a spreadsheet\njust words\n") }, await freeSlot());
  await expect(page.getByText(/no batch was kept in Review/i)).toBeVisible();
  const batches = await batchesNamed(name);
  expect(batches.filter((b) => b.status === "review")).toEqual([]);
  // Kept as a record of the attempt, exactly as Abandon would leave it.
  expect(batches.map((b) => b.status)).toEqual(["abandoned"]);
});

test("B4 a workbook missing required columns leaves no batch in Review", async ({ page }) => {
  const name = `${PREFIX}missing-columns.xlsx`;
  await upload(page, { name, buffer: workbook([["Processor", "Merchant Number"], ["TSYS", newMid()]]) }, await freeSlot());
  await expect(page.getByText(/missing columns: Merchant Name, Income Type, Volume, Residual/)).toBeVisible();
  await expect(page.getByText(/no batch was kept in Review/i)).toBeVisible();
  const batches = await batchesNamed(name);
  expect(batches.map((b) => b.status)).toEqual(["abandoned"]);
});

test("B4 the CRM's own export is refused as not a processor file, and leaves no batch in Review", async ({ page }) => {
  const name = `${PREFIX}crm-export.xlsx`;
  const rows = [
    ["Period", "Agent #", "Agent", "MID", "Merchant name", "Volume", "Average ticket", "Total cost", "Residual income", "Rep split", "Rep payout", "Line"],
    ["2026-07-01", "9002", "E2E Agent", newMid(), "QA Co", 1000, 10, 50, 5, 50, 2.5, ""],
  ];
  await upload(page, { name, buffer: workbook(rows) }, await freeSlot());
  await expect(page.getByText(/looks like a CRM export, not a processor file/)).toBeVisible();
  expect((await batchesNamed(name)).map((b) => b.status)).toEqual(["abandoned"]);
});

test("B4 a valid report still lands on its review screen, under the processor and month chosen", async ({ page }) => {
  const name = `${PREFIX}valid.xlsx`;
  const slot = await freeSlot();
  const rows = [HEADER, ["TSYS", newMid(), "QA B4 Merchant", "Residuals", "$1,000.00", "$50.00"]];
  await upload(page, { name, buffer: workbook(rows), mimeType: XLSX_TYPE }, slot);
  await expect(page).toHaveURL(/\/payouts\/import\/\d+$/);
  const batches = await batchesNamed(name);
  expect(batches).toEqual([expect.objectContaining({ status: "review", ...slot })]);
  const { count } = await service()
    .from("rep_payout_import_rows")
    .select("id", { count: "exact", head: true })
    .eq("batch_id", batches[0].id);
  expect(count).toBe(1);
});
