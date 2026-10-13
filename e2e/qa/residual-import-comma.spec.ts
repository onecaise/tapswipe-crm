import { expect, test } from "@playwright/test";
import * as XLSX from "xlsx";

import { storageStateFor } from "../fixtures/seed";
import { service } from "./qa-stack";

/**
 * D-10, residual import. parseNumberCell() stripped commas wherever they were,
 * so a text cell reading "12,99" staged as 1299. Now the row is blocked as a bad
 * figure, and the review screen names the cell and says why — the row's figure
 * is not staged at all.
 */
test.use({ storageState: storageStateFor("admin") });

const PREFIX = "qa-d10-";
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function workbook(rows: unknown[][]): Buffer {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), "Residuals");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
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

test("D-10 a decimal comma in a residual row blocks it and names the cell", async ({ page }) => {
  const name = `${PREFIX}decimal-comma.xlsx`;
  const rows = [
    ["Period", "Agent #", "MID", "Merchant name", "Volume", "Average ticket", "Total cost"],
    // Text cells, as a hand-edited or CSV-sourced report carries them.
    ["2027-11-01", "9002", "QA-D10-MID-1", "QA D10 Merchant", "1,000.00", "10", "12,99"],
  ];

  await page.goto("/payouts/import");
  await page.getByLabel("Residual report (XLSX)").setInputFiles({ name, mimeType: XLSX_TYPE, buffer: workbook(rows) });
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page).toHaveURL(/\/payouts\/import\/\d+$/);

  await expect(
    page.getByText(
      'Row 2 — Total cost "12,99" has a comma that is not a thousands separator — use a period for decimals, for example 12.99.',
    ),
  ).toBeVisible();

  const { data: batch } = await service()
    .from("rep_payout_batches").select("id").eq("file_name", name).single();
  const { data: staged } = await service()
    .from("rep_payout_import_rows").select("blocker, total_cost, volume").eq("batch_id", batch!.id);
  // The well-formed grouped figure on the same row still reads as before.
  expect(staged).toEqual([{ blocker: "bad_number", total_cost: null, volume: 1000 }]);
});
