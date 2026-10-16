import { expect, test, type Page } from "@playwright/test";

import {
  PERSONAS,
  createSkippingBatch,
  skipEvidence,
  storageStateFor,
} from "./fixtures/seed";

/**
 * The commit result and the skipped-rows Callout (phase 4b of
 * docs/design/residual-splits.md, §5.4), on desktop and mobile widths.
 *
 * The RPCs are pinned in tests/rls/acknowledge-residual-skips.test.ts and the
 * preview-to-commit agreement in tests/live/residual-import.test.ts. What only
 * a browser shows is what these assert:
 *
 *   * the commit button lands on the commit result, which reports written and
 *     skipped and puts the Callout ABOVE the figures;
 *   * the Callout survives a reload and appears on the period page too;
 *   * the button retires it everywhere, leaving a muted line with the
 *     reviewer's name, and the import list marks the batch either way;
 *   * a rep looking at the same period sees none of it;
 *   * none of it scrolls the page sideways at 375px.
 *
 * One period per width, so each spec's batch is the only one on its period
 * page; createSkippingBatch clears an earlier run's.
 */

test.use({ storageState: storageStateFor("admin") });

async function expectNoSideScroll(page: Page, width: number, where: string) {
  // On the DOCUMENT, not a bounding box -- the StatCard lesson: a box is
  // constrained by its parent while the ink overflows it.
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `${where} scrolls sideways at ${width}px`).toBeLessThanOrEqual(clientWidth);
}

async function topOf(page: Page, locator: ReturnType<Page["locator"]>): Promise<number> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("not rendered");
  return box.y;
}

for (const viewport of [
  { label: "desktop", width: 1440, height: 900, period: "2027-12", monthName: "December 2027" },
  { label: "mobile", width: 375, height: 812, period: "2028-01", monthName: "January 2028" },
]) {
  test(`commit result, skipped-rows Callout and its review, at ${viewport.width}px (${viewport.label})`, async ({
    page,
    browser,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const { batchId, sharedMid } = await createSkippingBatch(viewport.period);

    // ---- The review screen: the preview flag, which never blocks. ----
    await page.goto(`/payouts/import/${batchId}`);
    const flags = page.getByTestId("shared-account-flags");
    await expect(flags).toBeVisible();
    await expect(flags.getByText("Partner row will be skipped")).toBeVisible();
    await expectNoSideScroll(page, viewport.width, "the review screen");

    // ---- Commit, through v2. ----
    await page.getByRole("button", { name: /commit 3 rows/i }).click();
    await page.getByRole("button", { name: "Commit import" }).click();
    await expect(page).toHaveURL(new RegExp(`/payouts/import/${batchId}$`));

    const notice = page.getByTestId("residual-skips-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("1 row was not imported");

    const skippedRow = notice.getByRole("row").filter({ hasText: sharedMid });
    await expect(skippedRow).toContainText(PERSONAS.agent2.agentNumber);
    await expect(skippedRow).toContainText(viewport.monthName);
    await expect(skippedRow).toContainText("Names the partner on a shared account");

    // {written, skipped}, read back from the batch.
    const imported = page.locator('[data-slot="stat-card"]').filter({ hasText: "Rows imported" });
    const skipped = page.locator('[data-slot="stat-card"]').filter({ hasText: "Rows skipped" });
    await expect(imported).toContainText("2");
    await expect(skipped).toContainText("1");

    // At the TOP of the commit result: above the figures.
    expect(await topOf(page, notice)).toBeLessThan(await topOf(page, imported));
    await expectNoSideScroll(page, viewport.width, "the commit result");

    expect(await skipEvidence(batchId)).toEqual({ skipped: 1, acknowledged: false, ackAudits: 0 });

    // Not a toast: it survives a reload.
    await page.reload();
    await expect(page.getByTestId("residual-skips-notice")).toBeVisible();

    // ---- The import list marks it. ----
    await page.goto("/payouts/import");
    const listRow = page.getByRole("row").filter({ hasText: `e2e-skips-${viewport.period}.xlsx` });
    await expect(listRow).toContainText("1 skipped, not reviewed");
    await expectNoSideScroll(page, viewport.width, "the import list");

    // ---- The period page carries the same Callout, above the stat cards. ----
    await page.goto(`/payouts/${viewport.period}`);
    const periodNotice = page.getByTestId("residual-skips-notice");
    await expect(periodNotice).toBeVisible();
    await expect(periodNotice.getByRole("link", { name: `batch #${batchId}` })).toBeVisible();
    const merchantsCard = page.locator('[data-slot="stat-card"]').filter({ hasText: "Merchants" });
    expect(await topOf(page, periodNotice)).toBeLessThan(await topOf(page, merchantsCard));
    await expectNoSideScroll(page, viewport.width, "the period page");

    // ---- A rep on the same period sees no notice: skips are admin-only. ----
    const repContext = await browser.newContext({
      storageState: storageStateFor("agent"),
      viewport: { width: viewport.width, height: viewport.height },
    });
    const repPage = await repContext.newPage();
    await repPage.goto(`/payouts/${viewport.period}`);
    // The page rendered their own lines, so the absence below is not an empty page.
    await expect(repPage.getByRole("cell", { name: sharedMid })).toBeVisible();
    await expect(repPage.getByTestId("residual-skips-notice")).toHaveCount(0);
    await expect(repPage.getByTestId("residual-skips-reviewed")).toHaveCount(0);
    await expect(repPage.getByRole("button", { name: /reviewed/i })).toHaveCount(0);
    await repContext.close();

    // ---- Review it. ----
    await page.getByRole("button", { name: "I've reviewed this skipped row" }).click();
    await expect(page.getByTestId("residual-skips-notice")).toHaveCount(0);
    const reviewed = page.getByTestId("residual-skips-reviewed");
    await expect(reviewed).toContainText(`1 row skipped in batch #${batchId}, reviewed`);
    await expect(reviewed).toContainText(`by ${PERSONAS.admin.fullName}`);
    await expectNoSideScroll(page, viewport.width, "the period page after review");

    expect(await skipEvidence(batchId)).toEqual({ skipped: 1, acknowledged: true, ackAudits: 1 });

    // Gone from the commit result too, with the muted line in its place.
    await page.goto(`/payouts/import/${batchId}`);
    await expect(page.getByTestId("residual-skips-notice")).toHaveCount(0);
    await expect(page.getByTestId("residual-skips-reviewed")).toContainText(`by ${PERSONAS.admin.fullName}`);
    await expect(page.getByRole("button", { name: /reviewed/i })).toHaveCount(0);

    await page.goto("/payouts/import");
    await expect(
      page.getByRole("row").filter({ hasText: `e2e-skips-${viewport.period}.xlsx` }),
    ).toContainText("1 skipped, reviewed");
  });
}
