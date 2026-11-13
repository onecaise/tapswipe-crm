import { expect, test, type Page } from "@playwright/test";

import { createSharedBatch, storageStateFor } from "./fixtures/seed";

/**
 * The commit result of a shared account, on desktop and mobile widths.
 *
 * Since phase 8 of docs/design/intake-and-reports.md the commit (v3) skips
 * nothing: a shared account's signer is its owner, and v3 writes the signer's
 * and the partner's lines itself. What a browser alone shows: a batch with a
 * shared account commits through the button as the pair, the commit result
 * reports every row of the file as imported, and each rep's period page shows
 * their own line -- none of it scrolling the page sideways at 375px.
 *
 * Was e2e/residual-skips.spec.ts. Its second test (the skipped-rows Callout a
 * v2 commit left, and its review button) went with that UI in phase 13; the
 * commit itself is pinned in tests/rls/commit-residual-import-v3.test.ts.
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

for (const viewport of [
  { label: "desktop", width: 1440, height: 900 },
  { label: "mobile", width: 375, height: 812 },
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
    await expectNoSideScroll(page, viewport.width, "the commit result");

    // ---- Each party sees their own line of the pair. ----
    for (const persona of ["agent", "agent2"] as const) {
      const context = await browser.newContext({
        storageState: storageStateFor(persona),
        viewport: { width: viewport.width, height: viewport.height },
      });
      const repPage = await context.newPage();
      await repPage.goto(`/payouts/${period.slice(0, 7)}`);
      await expect(repPage.getByRole("cell", { name: sharedMid }), persona).toBeVisible();
      await expectNoSideScroll(repPage, viewport.width, `${persona}'s period page`);
      await context.close();
    }
  });
}
