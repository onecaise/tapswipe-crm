import { expect, test, type Page } from "@playwright/test";
import * as XLSX from "xlsx";

import { storageStateFor } from "../fixtures/seed";
import { service } from "./qa-stack";

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
 */
test.use({ storageState: storageStateFor("admin") });

const PREFIX = "qa-b4-";

function workbook(rows: unknown[][]): Buffer {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), "Residuals");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

async function batchesNamed(fileName: string) {
  const { data, error } = await service()
    .from("rep_payout_batches")
    .select("id, status, row_count")
    .eq("file_name", fileName);
  if (error) throw new Error(error.message);
  return data as { id: number; status: string; row_count: number | null }[];
}

/** Service-role cleanup: staging rows, then batches, then their stored files. */
async function clearQaBatches() {
  const db = service();
  const { data } = await db.from("rep_payout_batches").select("id, file_key").like("file_name", `${PREFIX}%`);
  const rows = (data ?? []) as { id: number; file_key: string | null }[];
  if (rows.length === 0) return;
  const ids = rows.map((r) => r.id);
  await db.from("rep_payout_import_rows").delete().in("batch_id", ids);
  const { error } = await db.from("rep_payout_batches").delete().in("id", ids);
  if (error) throw new Error(`clear batches: ${error.message}`);
  const keys = rows.map((r) => r.file_key).filter((k): k is string => Boolean(k));
  if (keys.length > 0) await db.storage.from("residual-imports").remove(keys);
}

test.beforeAll(clearQaBatches);
test.afterAll(clearQaBatches);

async function upload(page: Page, name: string, buffer: Buffer, mimeType: string) {
  await page.goto("/payouts/import");
  await page.getByLabel("Residual report (XLSX)").setInputFiles({ name, mimeType, buffer });
  await page.getByRole("button", { name: "Upload" }).click();
}

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

test("B4 an empty file is refused before any batch exists", async ({ page }) => {
  const name = `${PREFIX}empty.xlsx`;
  await upload(page, name, Buffer.alloc(0), XLSX_TYPE);
  await expect(page.getByText("That file is empty.")).toBeVisible();
  expect(await batchesNamed(name)).toEqual([]);
});

test("B4 a non-spreadsheet leaves no batch in Review", async ({ page }) => {
  const name = `${PREFIX}not-a-sheet.xlsx`;
  await upload(page, name, Buffer.from("this is not a spreadsheet\njust words\n"), XLSX_TYPE);
  await expect(page.getByText(/no batch was kept in Review/i)).toBeVisible();
  const batches = await batchesNamed(name);
  expect(batches.filter((b) => b.status === "review")).toEqual([]);
  // Kept as a record of the attempt, exactly as Abandon would leave it.
  expect(batches.map((b) => b.status)).toEqual(["abandoned"]);
});

test("B4 a workbook missing required columns leaves no batch in Review", async ({ page }) => {
  const name = `${PREFIX}missing-columns.xlsx`;
  await upload(page, name, workbook([["Period", "MID"], ["2027-11-01", "X1"]]), XLSX_TYPE);
  await expect(page.getByText(/no batch was kept in Review/i)).toBeVisible();
  const batches = await batchesNamed(name);
  expect(batches.map((b) => b.status)).toEqual(["abandoned"]);
});

test("B4 a valid report still lands on its review screen", async ({ page }) => {
  const name = `${PREFIX}valid.xlsx`;
  const rows = [
    ["Period", "Agent #", "MID", "Merchant name", "Volume", "Average ticket", "Total cost"],
    ["2027-11-01", "9002", "QA-B4-MID-1", "QA B4 Merchant", 1000, 10, 50],
  ];
  await upload(page, name, workbook(rows), XLSX_TYPE);
  await expect(page).toHaveURL(/\/payouts\/import\/\d+$/);
  const batches = await batchesNamed(name);
  expect(batches.map((b) => b.status)).toEqual(["review"]);
  const { count } = await service()
    .from("rep_payout_import_rows")
    .select("id", { count: "exact", head: true })
    .eq("batch_id", batches[0].id);
  expect(count).toBe(1);
});
