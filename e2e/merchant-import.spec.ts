import { expect, test, type Page } from "@playwright/test";

import {
  clearMerchantImport,
  merchantByMid,
  repIdentity,
  setRepIdentity,
  storageStateFor,
} from "./fixtures/seed";

/**
 * The merchant bulk import in a real browser (phase 14 of
 * docs/design/intake-and-reports.md). Invented merchants, MIDs and rep names.
 *
 * Only what a person could only find by looking: the file input posting bytes,
 * the refusal grouped with its value and row count, Commit disabled while it
 * stands, Read again after a fix made OUTSIDE the file, the success state, a
 * rep shown nothing, and the page at 360px. The rules themselves are the unit,
 * PGlite and live suites'.
 */

const stamp = String(Date.now()).slice(-7);
const FILE_PREFIX = "e2e-merchants-";
const MID_PREFIX = "E2EIMP";
const LLC_PREFIX = "E2E Import Rep ";
const FILE_NAME = `${FILE_PREFIX}${stamp}.csv`;
const LLC = `${LLC_PREFIX}${stamp} LLC`;
const MIDS = [`${MID_PREFIX}${stamp}1`, `${MID_PREFIX}${stamp}2`];

const HEADER = "#,Type,MerchantÂ ID,Merchant Name,Split,Agent,Processor,Added By,Override Agent,Status";
const CSV = [
  HEADER,
  `1,MERCHANT,${MIDS[0]},E2E Fernwood Bakery,0.5,${LLC},TSYS,Someone,,Active`,
  `2,MERCHANT,${MIDS[1]},E2E Quill Hardware,25%,${LLC} ,,Someone,,Inactive`,
].join("\n");

let saved: { legal_name: string | null; llc_legal_name: string | null };

test.beforeAll(async () => {
  saved = await repIdentity("agent3");
  // A run that failed part-way leaves this spec's own name behind (Playwright
  // re-imports the file, with a new stamp, after a failure): never restore that.
  if (saved.llc_legal_name?.startsWith(LLC_PREFIX)) saved = { legal_name: null, llc_legal_name: null };
  await clearMerchantImport(FILE_PREFIX, MID_PREFIX);
});

test.afterAll(async () => {
  await clearMerchantImport(FILE_PREFIX, MID_PREFIX);
  await setRepIdentity("agent3", saved.legal_name, saved.llc_legal_name);
});

/**
 * Absence means absent from what is SHOWN: Next 16 keeps the previous route's
 * DOM mounted but hidden, so the list page (with an earlier run's "2 merchants
 * created") is still in the document behind the review page.
 */
const shown = (locator: ReturnType<Page["getByText"]>) => locator.filter({ visible: true });

async function upload(page: Page, name = FILE_NAME, csv = CSV) {
  await page.goto("/admin/merchants/import");
  await page.setInputFiles('input[type="file"]', {
    name,
    mimeType: "text/csv",
    buffer: Buffer.from(csv, "utf8"),
  });
  await page.getByRole("button", { name: "Upload" }).click();
  await page.waitForURL(/\/admin\/merchants\/import\/\d+$/);
}

test.describe("as an admin", () => {
  test.use({ storageState: storageStateFor("admin") });

  test("reachable from Merchants", async ({ page }) => {
    await page.goto("/merchants");
    await page.getByRole("link", { name: "Import merchants" }).click();
    await expect(page).toHaveURL(/\/admin\/merchants\/import$/);
    await expect(page.getByRole("heading", { name: "Import merchants" })).toBeVisible();
  });

  test("upload, a refusal, a fix outside the file, Read again, commit", async ({ page }) => {
    await upload(page);

    // --- refused: the rep's LLC name is not in the CRM yet ---------------
    const refusal = page.getByRole("group", { name: "Agent matches no rep's LLC legal name" });
    await expect(refusal).toContainText("2 rows");
    // The distinct value, trailing space and all collapsed, with its rows.
    await expect(refusal).toContainText(`${LLC} — rows 2, 3`);
    await expect(page.getByRole("button", { name: "Commit import" })).toBeDisabled();
    await expect(page.getByText("Not ready: fix every problem above first.")).toBeVisible();
    await expect(shown(page.getByText(/merchants? created/))).toHaveCount(0);

    // --- the fix, in the CRM: agent3's LLC legal name --------------------
    await setRepIdentity("agent3", "E2E Agent Three", LLC);
    await page.getByRole("button", { name: "Read again" }).click();
    await expect(page.getByText("Ready to create 2 merchants.")).toBeVisible();
    await expect(shown(page.getByRole("group", { name: "Agent matches no rep's LLC legal name" }))).toHaveCount(0);
    // The notes: one rate differs from the rep's profile rate (25 vs 50).
    await expect(page.getByText("Split differs from the rep's profile rate (kept as given)")).toBeVisible();

    // --- commit ---------------------------------------------------------
    await page.getByRole("button", { name: "Commit import" }).click();
    await page.getByRole("button", { name: "Commit import" }).click(); // the ConfirmPair's confirm
    await expect(page.getByText("2 merchants created", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Missing locations" })).toBeVisible();
    // Settled: nothing left to press.
    await expect(shown(page.getByRole("button", { name: "Commit import" }))).toHaveCount(0);
    await expect(shown(page.getByRole("button", { name: "Read again" }))).toHaveCount(0);
    await expect(shown(page.getByRole("button", { name: "Abandon" }))).toHaveCount(0);

    const first = await merchantByMid(MIDS[0]);
    const second = await merchantByMid(MIDS[1]);
    expect(first).toMatchObject({ status: "active", city: null, state: null });
    expect(second).toMatchObject({ status: "inactive", city: null, state: null });
  });

  test("fits a 360px screen without sideways scrolling, refusals and all", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    // Its own file, still refused (no rep has that LLC name): the busiest state.
    const nobody = CSV.replaceAll(LLC, `${LLC_PREFIX}${stamp} Nobody`).replaceAll(MID_PREFIX, `${MID_PREFIX}M`);
    await upload(page, `${FILE_PREFIX}${stamp}-mobile.csv`, nobody);
    await expect(page.getByRole("group", { name: "Agent matches no rep's LLC legal name" })).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.goto("/admin/merchants/import");
    await expect(page.getByRole("heading", { name: "Import merchants" })).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);
  });
});

test.describe("as a rep", () => {
  test.use({ storageState: storageStateFor("agent") });

  test("is shown neither the link nor the page", async ({ page }) => {
    await page.goto("/merchants");
    await expect(page.getByRole("heading", { name: "Merchants" })).toBeVisible();
    await expect(shown(page.getByRole("link", { name: "Import merchants" }))).toHaveCount(0);
    await page.goto("/admin/merchants/import");
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(shown(page.locator('input[type="file"]'))).toHaveCount(0);
  });
});
