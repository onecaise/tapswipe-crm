import { expect, test, type Page } from "@playwright/test";

import {
  PERSONAS,
  createSharedBatch,
  plantLegacySkips,
  skipEvidence,
  storageStateFor,
} from "./fixtures/seed";

/**
 * The commit result of a shared account, and the skipped-rows Callout, on
 * desktop and mobile widths.
 *
 * Since phase 8 of docs/design/intake-and-reports.md the commit (v3) skips
 * nothing: a shared account's signer is its owner, and v3 writes the signer's
 * and the partner's lines itself. So this file pins two things a browser alone
 * shows:
 *
 *   * a batch with a shared account commits through the button as the pair,
 *     the commit result reports what it imported with no "Rows skipped" and
 *     no Callout, and each rep's period page shows their own line;
 *   * a skip record an EARLIER commit (v2) left on a batch is still shown --
 *     above the figures, on the batch and on its period, never to a rep -- and
 *     its review button still retires it, with the reviewer's name. That UI
 *     stays until the cleanup phase; the record is planted in v2's exact shape
 *     (plantLegacySkips), because nothing can produce one any more.
 *
 * None of it may scroll the page sideways at 375px. The RPCs are pinned in
 * tests/rls/acknowledge-residual-skips.test.ts and
 * tests/rls/commit-residual-import-v3.test.ts.
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
  test(`a shared account commits as the pair, nothing skipped, at ${viewport.width}px (${viewport.label})`, async ({
    page,
    browser,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const { batchId, period, sharedMid } = await createSharedBatch(viewport.label);

    // ---- The review screen: nothing to warn about, nothing to note. ----
    await page.goto(`/payouts/import/${batchId}`);
    await expect(page.getByTestId("import-refused")).toHaveCount(0);
    await expect(page.getByTestId("shared-account-flags")).toHaveCount(0);
    await expectNoSideScroll(page, viewport.width, "the review screen");

    // ---- Commit, through v3. ----
    await page.getByRole("button", { name: /commit 2 rows/i }).click();
    await page.getByRole("button", { name: "Commit import" }).click();
    await expect(page).toHaveURL(new RegExp(`/payouts/import/${batchId}$`));

    const imported = page.locator('[data-slot="stat-card"]').filter({ hasText: "Rows imported" });
    await expect(imported).toContainText("2");
    await expect(page.getByText("Rows skipped")).toHaveCount(0);
    await expect(page.getByTestId("residual-skips-notice")).toHaveCount(0);
    await expectNoSideScroll(page, viewport.width, "the commit result");
    expect(await skipEvidence(batchId)).toEqual({ skipped: 0, acknowledged: false, ackAudits: 0 });

    // ---- Each party sees their own line of the pair, and no notice. ----
    for (const persona of ["agent", "agent2"] as const) {
      const context = await browser.newContext({
        storageState: storageStateFor(persona),
        viewport: { width: viewport.width, height: viewport.height },
      });
      const repPage = await context.newPage();
      await repPage.goto(`/payouts/${period.slice(0, 7)}`);
      await expect(repPage.getByRole("cell", { name: sharedMid }), persona).toBeVisible();
      await expect(repPage.getByTestId("residual-skips-notice")).toHaveCount(0);
      await expectNoSideScroll(repPage, viewport.width, `${persona}'s period page`);
      await context.close();
    }
  });

  test(`a skip record an earlier commit left, and its review, at ${viewport.width}px (${viewport.label})`, async ({
    page,
    browser,
  }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const { batchId, sharedMid } = await plantLegacySkips(viewport.period);

    // ---- The batch page: the Callout ABOVE the figures. ----
    await page.goto(`/payouts/import/${batchId}`);
    const notice = page.getByTestId("residual-skips-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("1 row was not imported");

    const skippedRow = notice.getByRole("row").filter({ hasText: sharedMid });
    await expect(skippedRow).toContainText(PERSONAS.agent2.agentNumber);
    await expect(skippedRow).toContainText(viewport.monthName);
    await expect(skippedRow).toContainText("Names the partner on a shared account");

    const imported = page.locator('[data-slot="stat-card"]').filter({ hasText: "Rows imported" });
    const skipped = page.locator('[data-slot="stat-card"]').filter({ hasText: "Rows skipped" });
    await expect(imported).toContainText("1");
    await expect(skipped).toContainText("1");
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
    // The page rendered their own line, so the absence below is not an empty page.
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

    // Gone from the batch page too, with the muted line in its place.
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
