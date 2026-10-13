import { expect, test, type Page } from "@playwright/test";

import { PERIODS, storageStateFor } from "../fixtures/seed";

/**
 * D-10, payout cell. parseFigureInput() stripped commas wherever they were, so
 * typing "12,99" into a residual cell saved 1299 — a hundred times the figure.
 * A comma now has to be thousands grouping; anything else is refused in the
 * cell with a sentence, and nothing is written.
 */
test.use({ storageState: storageStateFor("admin") });

const MERCHANT = "E2E Only Merchant";
const residualInput = (page: Page) => page.getByLabel(`Residual income for ${MERCHANT}`);

let before = "";

test.afterEach(async ({ page }) => {
  // Puts the figure back if a revert experiment let the bad value through.
  await page.goto(`/payouts/${PERIODS.single}`);
  const input = residualInput(page);
  if ((await input.inputValue()) !== before) {
    await input.fill(before);
    await input.press("Enter");
    await expect(page.getByText(/Commas can only/)).toHaveCount(0);
    await page.reload();
    await expect(residualInput(page)).toHaveValue(before);
  }
});

test("D-10 a decimal comma in a payout cell is refused, not read as thousands", async ({ page }) => {
  await page.goto(`/payouts/${PERIODS.single}`);
  const input = residualInput(page);
  before = await input.inputValue();

  await input.fill("12,99");
  await input.press("Enter");

  await expect(
    page.getByText(
      "Commas can only separate thousands, as in 1,299.00. Use a period for decimals, for example 12.99.",
    ),
  ).toBeVisible();

  await page.reload();
  await expect(residualInput(page)).toHaveValue(before);
});
