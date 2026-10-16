import { expect, test, type Page } from "@playwright/test";

import {
  ADJUSTMENT_NOTE,
  PERSONAS,
  plantAdjustments,
  storageStateFor,
} from "./fixtures/seed";

/**
 * Adjustment lines on the payout pages (phase 5 of
 * docs/design/residual-splits.md, §6), and the review screen's notice for
 * adjustment rows a re-import ignored.
 *
 * The arithmetic is pinned in tests/rls/share-corrections.test.ts and
 * tests/unit/payouts.test.ts. What only a browser shows:
 *
 *   * each rep's adjustment sits in its own "Adjustments" block under that
 *     rep's merchant table -- never as a row in it -- naming the month it
 *     corrects and the note, with the merchant name as plain text;
 *   * the period's Payout figure and the rep's total include it, while the
 *     Merchants figure does not count it;
 *   * a rep sees their own adjustment and not the other rep's;
 *   * the printed statement lists it under "Adjustments" and totals it;
 *   * a long note and a long merchant name wrap or truncate rather than
 *     scroll the page sideways, at 375, 768 and 1440.
 */

const PERIOD = "2028-03";
const CORRECTS = "February 2028";

async function expectNoSideScroll(page: Page, width: number, where: string) {
  // On the document, not a bounding box (the StatCard lesson).
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `${where} scrolls sideways at ${width}px`).toBeLessThanOrEqual(clientWidth);
}

let planted: Awaited<ReturnType<typeof plantAdjustments>>;

test.beforeAll(async () => {
  planted = await plantAdjustments(PERIOD);
});

test.describe("as an admin", () => {
  test.use({ storageState: storageStateFor("admin") });

  for (const width of [375, 768, 1440]) {
    test(`each rep's adjustment is its own block, totalled, at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/payouts/${PERIOD}`);

      // By the whole heading -- name, then agent number -- because "E2E Agent"
      // is a prefix of "E2E Agent Two".
      const group = (persona: (typeof PERSONAS)["agent" | "agent2"]) =>
        page.locator("section").filter({
          has: page.getByRole("heading", {
            name: new RegExp(`^${persona.fullName}\\s*${persona.agentNumber}$`),
          }),
        });
      const signer = group(PERSONAS.agent);
      const partner = group(PERSONAS.agent2);

      // The signer: the merchant table holds the import line only, and the
      // adjustment is in the block under it.
      const signerBlock = signer.getByTestId("payout-adjustments");
      await expect(signerBlock).toBeVisible();
      await expect(signerBlock.getByRole("row").filter({ hasText: planted.mid })).toContainText(CORRECTS);
      await expect(signerBlock).toContainText("-$10.61");
      await expect(signerBlock).toContainText(ADJUSTMENT_NOTE);
      // Plain text, never a link: the partner cannot open the merchant.
      await expect(signerBlock.getByRole("link")).toHaveCount(0);
      const merchantTable = signer.getByRole("table").first();
      await expect(merchantTable).toContainText("E2E Adjusted Co");
      await expect(merchantTable).not.toContainText(CORRECTS);

      // The rep's line: 1 merchant, $25.00 - $10.61 = $14.39, and the count.
      await expect(signer.getByText(/1 merchant ·/)).toContainText("$14.39");
      await expect(signer.getByText(/1 merchant ·/)).toContainText("1 adjustment");

      // The partner has only the adjustment: no merchant table, no bulk split.
      const partnerBlock = partner.getByTestId("payout-adjustments");
      await expect(partnerBlock).toContainText("$10.61");
      await expect(partner.getByRole("table")).toHaveCount(1);
      await expect(partner.getByLabel(/Split percentage for all of/)).toHaveCount(0);
      await expect(partner.getByText(/0 merchants ·/)).toContainText("$10.61");

      await expectNoSideScroll(page, width, "the period page");
    });
  }

  test("the review screen says how many adjustment lines a re-import ignored", async ({ page }) => {
    await page.goto(`/payouts/import/${planted.batchId}`);
    await expect(page.getByTestId("adjustments-ignored")).toHaveText(
      "2 adjustment lines ignored: adjustments are entered in the CRM.",
    );
    await page.setViewportSize({ width: 375, height: 812 });
    await expectNoSideScroll(page, 375, "the review screen");
  });
});

test.describe("as the signer", () => {
  test.use({ storageState: storageStateFor("agent") });

  test("sees their own adjustment and not the partner's, on the page and the statement", async ({ page }) => {
    await page.goto(`/payouts/${PERIOD}`);
    const block = page.getByTestId("payout-adjustments");
    await expect(block).toHaveCount(1);
    await expect(block).toContainText("-$10.61");
    await expect(page.getByText(PERSONAS.agent2.fullName)).toHaveCount(0);

    await page.goto(`/payouts/${PERIOD}/summary/${planted.signerId}`);
    const line = page.getByTestId("statement-adjustment");
    await expect(line).toHaveCount(1);
    await expect(line).toContainText(`Corrects ${CORRECTS}`);
    await expect(line).toContainText("-$10.61");
    // Total payout: $25.00 import line + -$10.61 adjustment.
    await expect(page.getByRole("row", { name: /Total payout/ })).toContainText("$14.39");

    await page.setViewportSize({ width: 375, height: 812 });
    await expectNoSideScroll(page, 375, "the statement");
  });

  test("cannot open the partner's statement", async ({ page }) => {
    await page.goto(`/payouts/${PERIOD}/summary/${planted.partnerId}`);
    await expect(page.getByTestId("statement-adjustment")).toHaveCount(0);
    // Rendered not-found copy, not a status: under cacheComponents notFound()
    // streams as 200 (see e2e/print.spec.ts).
    await expect(page.getByRole("heading", { name: /couldn.t find that/ })).toBeVisible();
  });
});
