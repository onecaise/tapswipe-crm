import { expect, test, type Page } from "@playwright/test";

import { PERIODS, PERSONAS, storageStateFor } from "../fixtures/seed";
import { service } from "./qa-stack";

/**
 * Two printable pages broke the "no horizontal page scroll at 390px" rule.
 *
 * QA-009 — the screen-only control row on /pre-apps/blank-form (and the same
 * row on /merchants/[id]/print) is `flex justify-between` with a `shrink-0`
 * pair of controls, and nothing lets it wrap: at 390px the Print button sat
 * 32px past the viewport edge.
 *
 * QA-010 — the payout summary's six-column table has no horizontal scroll
 * container, so at 390px the Payout column — the figure the page exists to
 * show — was cut off at the card edge ("$247.5", with the 0 off screen).
 */
test.use({ storageState: storageStateFor("agent"), viewport: { width: 390, height: 844 } });

async function pageScroll(page: Page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
}

test("QA-009 the blank application's control row fits a phone", async ({ page }) => {
  await page.goto("/pre-apps/blank-form");
  await expect(page.getByRole("button", { name: /Print/ })).toBeVisible();
  const { scrollWidth, clientWidth } = await pageScroll(page);
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  const box = await page.getByRole("button", { name: /Print/ }).boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(clientWidth);
});

test("QA-010 the payout summary does not push the page or clip the Payout column", async ({ page }) => {
  const { data: agent } = await service().from("profiles").select("id").eq("email", PERSONAS.agent.email).single();
  await page.goto(`/payouts/${PERIODS.many}/summary/${agent!.id}`);
  await expect(page.getByRole("columnheader", { name: "Payout" })).toBeVisible();

  const { scrollWidth, clientWidth } = await pageScroll(page);
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);

  // The column can be reached: a cell scrolled into view is fully inside the
  // viewport rather than painted past the card edge with nowhere to scroll.
  const total = page.getByText("$1,980.00");
  await total.scrollIntoViewIfNeeded();
  const box = await total.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(clientWidth);
});
