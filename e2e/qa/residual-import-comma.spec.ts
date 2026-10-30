import { expect, test } from "@playwright/test";

import { storageStateFor } from "../fixtures/seed";
import { service } from "./qa-stack";
import { HEADER, clearQa, freeSlot, merchantFor, newMid, upload, workbook } from "./residual-files";

/**
 * D-10, residual import. parseNumberCell() stripped commas wherever they were,
 * so a text cell reading "12,99" staged as 1299. Now the row is refused as an
 * unreadable figure, and the review screen names the cell and says why — the
 * row's figure is not staged at all.
 *
 * Phase 7: the six-column file, so the misplaced comma is in the Residual; the
 * MID belongs to a merchant this spec creates, so the figure is the row's only
 * problem and the sentence on the screen is that one alone.
 */
test.use({ storageState: storageStateFor("admin") });

const PREFIX = "qa-d10-";

test.beforeAll(() => clearQa(PREFIX));
test.afterAll(() => clearQa(PREFIX));

test("D-10 a decimal comma in a residual row refuses it and names the cell", async ({ page }) => {
  const name = `${PREFIX}decimal-comma.xlsx`;
  const mid = newMid();
  await merchantFor(PREFIX, mid);
  const rows = [
    HEADER,
    // Text cells, as a hand-edited or CSV-sourced report carries them.
    ["TSYS", mid, "QA D10 Merchant", "Residuals", "1,000.00", "12,99"],
  ];

  await upload(page, { name, buffer: workbook(rows) }, await freeSlot());
  await expect(page).toHaveURL(/\/payouts\/import\/\d+$/);

  await expect(
    page.getByText(
      'Row 2 — Residual "12,99" has a comma that is not a thousands separator — use a period for decimals, for example 12.99.',
    ),
  ).toBeVisible();

  const { data: batch } = await service()
    .from("rep_payout_batches").select("id").eq("file_name", name).single();
  const { data: staged } = await service()
    .from("rep_payout_import_rows").select("blocker, residual_income, volume").eq("batch_id", batch!.id);
  // The well-formed grouped figure on the same row still reads as before.
  expect(staged).toEqual([{ blocker: "unreadable_number", residual_income: null, volume: 1000 }]);
});
