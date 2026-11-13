import { expect, test } from "@playwright/test";

import { createClient } from "@supabase/supabase-js";

import { E2E_PASSWORD, PERSONAS, publicStackConfig, storageStateFor } from "../fixtures/seed";
import { service } from "./qa-stack";
import { HEADER, clearQa, freeSlot, merchantFor, newMid, upload, workbook } from "./residual-files";

/**
 * Phase 7 of docs/design/intake-and-reports.md, as an admin sees it:
 *
 *   1. A second file for a COMMITTED processor-month asks "Replace it?" (phase
 *      9): No uploads nothing; Yes reads the file into an import that replaces
 *      the committed one at commit; a month marked paid is not offered the Yes.
 *   2. A refused import says so at the top, listing every unknown MID, and
 *      offers no commit.
 *   3. Warnings are confirmed once per TYPE, never per line, and the commit
 *      appears only when every type present has a Yes; a No takes it away.
 */
test.use({ storageState: storageStateFor("admin") });

const PREFIX = "qa-p7-";

test.beforeAll(() => clearQa(PREFIX));
test.afterAll(() => clearQa(PREFIX));

/** A committed batch for a free processor-month, as the service role. */
async function committedSlot(tag: string): Promise<{ slot: { processor: string; period: string }; id: number }> {
  const slot = await freeSlot();
  const db = service();
  const { data: admin } = await db.from("profiles").select("id").eq("email", PERSONAS.admin.email).single();
  const { data: committed, error } = await db
    .from("rep_payout_batches")
    .insert({
      imported_by: admin!.id,
      file_key: `e2e/${PREFIX}${tag}.xlsx`,
      file_name: `${PREFIX}${tag}.xlsx`,
      status: "committed",
      committed_at: new Date().toISOString(),
      ...slot,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return { slot, id: committed!.id as number };
}

/** The admin's own session, for the two calls no service role can make. */
async function adminSession() {
  const { apiUrl, publishableKey } = publicStackConfig();
  const client = createClient(apiUrl, publishableKey, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email: PERSONAS.admin.email, password: E2E_PASSWORD });
  if (error) throw new Error(error.message);
  return client;
}

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

test("a committed processor-month asks Replace it?: No uploads nothing, Yes reads the file into a replacing import", async ({ page }) => {
  const { slot, id } = await committedSlot("first");
  const name = `${PREFIX}second.xlsx`;
  const file = { name, buffer: workbook([HEADER, [slot.processor, newMid(), "QA Co", "Residuals", "1", "1"]]) };
  const db = service();

  await upload(page, file, slot);
  const prompt = page.getByTestId("replace-blocked");
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText(`${slot.processor} for`);
  await expect(prompt).toContainText("was already imported");
  await expect(prompt).toContainText("Replace it?");
  await expect(prompt.getByRole("link", { name: `Open ${PREFIX}first.xlsx` })).toHaveAttribute("href", `/payouts/import/${id}`);

  // No: nothing happened, and no batch for the second file.
  await prompt.getByRole("button", { name: "No" }).click();
  await expect(prompt).toHaveCount(0);
  await expect(page).toHaveURL(/\/payouts\/import$/);
  expect((await db.from("rep_payout_batches").select("id").eq("file_name", name)).data ?? []).toEqual([]);

  // Yes: the same file is read into a new import that replaces the committed one.
  await upload(page, file, slot);
  await page.getByTestId("replace-blocked").getByRole("button", { name: "Yes, replace it" }).click();
  await expect(page).toHaveURL(/\/payouts\/import\/\d+$/);
  const notice = page.getByTestId("replaces-import");
  await expect(notice).toContainText(`This file replaces import #${id}.`);
  await expect(notice.getByRole("link", { name: `import #${id}` })).toHaveAttribute("href", `/payouts/import/${id}`);
  const { data: created } = await db.from("rep_payout_batches").select("status, replaces_batch_id").eq("file_name", name);
  expect(created).toEqual([{ status: "review", replaces_batch_id: id }]);
  // Nothing replaced until a commit.
  expect((await db.from("rep_payout_batches").select("status").eq("id", id).single()).data).toEqual({ status: "committed" });
});

test("a committed month marked paid is not offered the Yes, and the prompt says what to do", async ({ page }) => {
  const { slot } = await committedSlot("paid");
  const admin = await adminSession();
  const label = `${slot.processor} ${MONTHS[Number(slot.period.slice(5, 7)) - 1]} ${slot.period.slice(0, 4)}`;
  const { error } = await admin.rpc("close_payout_period", {
    period_input: slot.period, processor_input: slot.processor, confirmation_input: label,
  });
  if (error) throw new Error(error.message);
  try {
    const name = `${PREFIX}after-paid.xlsx`;
    await upload(page, { name, buffer: workbook([HEADER, [slot.processor, newMid(), "QA Co", "Residuals", "1", "1"]]) }, slot);
    const prompt = page.getByTestId("replace-blocked");
    await expect(prompt).toContainText("is marked paid, so it cannot be replaced.");
    await expect(prompt).toContainText("Reopen the month on the Payouts page (with a reason)");
    await expect(prompt.getByRole("button", { name: "Yes, replace it" })).toHaveCount(0);
    expect((await service().from("rep_payout_batches").select("id").eq("file_name", name)).data ?? []).toEqual([]);
  } finally {
    await admin.rpc("reopen_payout_period", {
      period_input: slot.period, processor_input: slot.processor, reason_input: "e2e cleanup: reopening its own month",
    });
  }
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
    [slot.processor, unknownB, "QA Stranger B", "Residuals", "12,99", "$5.00"],
  ];
  await upload(page, { name: `${PREFIX}refused.xlsx`, buffer: workbook(rows) }, slot);
  await expect(page).toHaveURL(/\/payouts\/import\/\d+$/);

  const refused = page.getByTestId("import-refused");
  await expect(refused).toContainText("This import is refused.");
  await expect(refused).toContainText(`2 MIDs are not merchants in the CRM: ${unknownA}, ${unknownB}.`);
  // The unreadable figure on the same row is listed too, not hidden behind it.
  await expect(refused).toContainText("A figure could not be read");
  await expect(refused).toContainText('Row 4 — ');
  await expect(page.getByTestId("import-warnings")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^commit/i })).toHaveCount(0);
});

test("an ISO Hub file: ACH asks once with its count and sums, a blank Volume is counted as 0, blank and aliased Processor cells and filler rows say nothing", async ({ page }) => {
  // Phase 15 of docs/design/intake-and-reports.md. Every figure is invented.
  const mids = [newMid(), newMid(), newMid()];
  for (const mid of mids) await merchantFor(PREFIX, mid);
  const slot = await freeSlot();
  // Goat on a TSYS file, Netevia on Netevia HQ's; otherwise the name in capitals.
  const alias = slot.processor === "TSYS" ? "Goat " : slot.processor === "Netevia HQ" ? "Netevia" : slot.processor.toUpperCase();
  const rows = [
    HEADER,
    [null, mids[0], "QA Blank Cell", "Residual ", "$1,000.00", "$5.00"],
    [alias, mids[1], "QA Ach", "ACH", "$2,695.16", "$49.51"],
    [slot.processor, mids[2], "QA No Volume", "Residuals ", null, "$1.25"],
    [alias, null, null, "ACH", null, null],
    [null, null, null, null, null, null],
  ];
  await upload(page, { name: `${PREFIX}iso-hub.xlsx`, buffer: workbook(rows) }, slot);
  await expect(page).toHaveURL(/\/payouts\/import\/\d+$/);

  const warnings = page.getByTestId("import-warnings");
  await expect(warnings.locator("[data-warning]")).toHaveCount(1);
  const other = warnings.locator('[data-warning="other_income_type"]');
  await expect(other).toContainText("Income Type is not Residuals");
  await expect(other.getByTestId("warning-summary")).toHaveText("1 row: volume $2,695.16, residual $49.51.");
  await expect(other).toContainText('Income Type "ACH"');
  await expect(page.getByTestId("blank-figures")).toContainText("1 row has a blank Volume or Residual, read as 0.");
  await expect(page.getByTestId("blank-figures")).toContainText("Row 4.");
  await expect(page.getByTestId("import-refused")).toHaveCount(0);

  await other.getByRole("button", { name: "Yes" }).click();
  await expect(page.getByRole("button", { name: /^commit 3 rows/i })).toBeVisible();
});

test("one Yes per warning type opens the commit; a No closes it again", async ({ page }) => {
  const mids = [newMid(), newMid(), newMid()];
  for (const mid of mids) await merchantFor(PREFIX, mid);
  const slot = await freeSlot();
  // Two bad-numbers rows (one type, two lines: a negative volume, and a
  // residual over its volume; zero volume raises nothing since 20261104120000)
  // and one row whose file Processor is not the one chosen.
  const other = slot.processor === "TSYS" ? "Square" : "TSYS";
  const rows = [
    HEADER,
    [slot.processor, mids[0], "QA Refund", "Residuals", "-$500.00", "-$2.00"],
    [slot.processor, mids[1], "QA Swapped", "Residuals", "$1.50", "$100.00"],
    [other, mids[2], "QA Elsewhere", "Residuals", "$500.00", "$5.00"],
  ];
  await upload(page, { name: `${PREFIX}warnings.xlsx`, buffer: workbook(rows) }, slot);
  await expect(page).toHaveURL(/\/payouts\/import\/\d+$/);

  const warnings = page.getByTestId("import-warnings");
  const bad = warnings.locator('[data-warning="bad_numbers"]');
  const mismatch = warnings.locator('[data-warning="processor_mismatch"]');
  // One block per TYPE: two, not three -- the two bad-numbers rows share one.
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
