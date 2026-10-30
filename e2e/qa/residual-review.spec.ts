import { expect, test } from "@playwright/test";

import { PERSONAS, storageStateFor } from "../fixtures/seed";
import { service } from "./qa-stack";
import { HEADER, clearQa, freeSlot, merchantFor, newMid, upload, workbook } from "./residual-files";

/**
 * Phase 7 of docs/design/intake-and-reports.md, as an admin sees it:
 *
 *   1. A second file for a COMMITTED processor-month shows the replace prompt's
 *      facts and stops: the replace is phase 9, so nothing is uploaded and no
 *      batch is created.
 *   2. A refused import says so at the top, listing every unknown MID, and
 *      offers no commit.
 *   3. Warnings are confirmed once per TYPE, never per line, and the commit
 *      appears only when every type present has a Yes; a No takes it away.
 */
test.use({ storageState: storageStateFor("admin") });

const PREFIX = "qa-p7-";

test.beforeAll(() => clearQa(PREFIX));
test.afterAll(() => clearQa(PREFIX));

test("a committed processor-month shows the replace prompt and uploads nothing", async ({ page }) => {
  const slot = await freeSlot();
  const db = service();
  const { data: admin } = await db.from("profiles").select("id").eq("email", PERSONAS.admin.email).single();
  const { data: committed, error } = await db
    .from("rep_payout_batches")
    .insert({
      imported_by: admin!.id,
      file_key: `e2e/${PREFIX}first.xlsx`,
      file_name: `${PREFIX}first.xlsx`,
      status: "committed",
      committed_at: new Date().toISOString(),
      ...slot,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);

  const name = `${PREFIX}second.xlsx`;
  await upload(page, { name, buffer: workbook([HEADER, [slot.processor, newMid(), "QA Co", "Residuals", "1", "1"]]) }, slot);

  const prompt = page.getByTestId("replace-blocked");
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText(`${slot.processor} for`);
  await expect(prompt).toContainText("was already imported");
  await expect(prompt).toContainText("Replace it?");
  await expect(prompt).toContainText("Replacing a committed month is not available yet");
  await expect(prompt.getByRole("link", { name: `Open ${PREFIX}first.xlsx` })).toHaveAttribute(
    "href",
    `/payouts/import/${committed!.id}`,
  );
  // Nothing else happened: still on the list, and no batch for the second file.
  await expect(page).toHaveURL(/\/payouts\/import$/);
  const { data: second } = await db.from("rep_payout_batches").select("id").eq("file_name", name);
  expect(second ?? []).toEqual([]);
});

test("a refused import lists every unknown MID at the top and offers no commit", async ({ page }) => {
  const known = newMid();
  const unknownA = newMid();
  const unknownB = newMid();
  await merchantFor(PREFIX, known);
  // The file's Processor is the chosen one on every row, so no warning is
  // pending: the refusal alone has to be what keeps the commit away.
  const slot = await freeSlot();
  const rows = [
    HEADER,
    [slot.processor, known, "QA Known", "Residuals", "$1,000.00", "$5.00"],
    [slot.processor, unknownA, "QA Stranger A", "Residuals", "$1,000.00", "$5.00"],
    [slot.processor, unknownB, "QA Stranger B", "Fees", "$1,000.00", "$5.00"],
  ];
  await upload(page, { name: `${PREFIX}refused.xlsx`, buffer: workbook(rows) }, slot);
  await expect(page).toHaveURL(/\/payouts\/import\/\d+$/);

  const refused = page.getByTestId("import-refused");
  await expect(refused).toContainText("This import is refused.");
  await expect(refused).toContainText(`2 MIDs are not merchants in the CRM: ${unknownA}, ${unknownB}.`);
  // The wrong Income Type on the same row is listed too, not hidden behind it.
  await expect(refused).toContainText("Income Type is not Residuals");
  await expect(refused).toContainText('Row 4 — ');
  await expect(page.getByTestId("import-warnings")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^commit/i })).toHaveCount(0);
});

test("one Yes per warning type opens the commit; a No closes it again", async ({ page }) => {
  const mids = [newMid(), newMid(), newMid()];
  for (const mid of mids) await merchantFor(PREFIX, mid);
  const slot = await freeSlot();
  // Two zero-volume rows (one type, two lines) and one row whose file Processor
  // is not the one chosen.
  const other = slot.processor === "TSYS" ? "Square" : "TSYS";
  const rows = [
    HEADER,
    [slot.processor, mids[0], "QA Fee", "Residuals", "$0.00", "$1.50"],
    [slot.processor, mids[1], "QA Clawback", "Residuals", "$0.00", "-$2.00"],
    [other, mids[2], "QA Elsewhere", "Residuals", "$500.00", "$5.00"],
  ];
  await upload(page, { name: `${PREFIX}warnings.xlsx`, buffer: workbook(rows) }, slot);
  await expect(page).toHaveURL(/\/payouts\/import\/\d+$/);

  const warnings = page.getByTestId("import-warnings");
  const bad = warnings.locator('[data-warning="bad_numbers"]');
  const mismatch = warnings.locator('[data-warning="processor_mismatch"]');
  // One block per TYPE: two, not three -- the two zero-volume rows share one.
  await expect(warnings.locator("[data-warning]")).toHaveCount(2);
  await expect(bad).toContainText("2 rows");
  await expect(bad.getByRole("button", { name: "Yes" })).toHaveCount(1);
  await expect(mismatch).toContainText(`the file says "${other}"`);

  const commit = page.getByRole("button", { name: /^commit 3 rows/i });
  await expect(page.getByText("Answer each question above to commit.")).toBeVisible();
  await expect(commit).toHaveCount(0);

  await bad.getByRole("button", { name: "Yes" }).click();
  await expect(commit).toHaveCount(0);

  await mismatch.getByRole("button", { name: "Yes" }).click();
  await expect(commit).toBeVisible();
  await expect(page.getByText("All 3 rows read. This import is ready.")).toBeVisible();

  await bad.getByRole("button", { name: "No" }).click();
  await expect(commit).toHaveCount(0);
  await expect(page.getByText("This import will not be committed as it stands.")).toBeVisible();
});
