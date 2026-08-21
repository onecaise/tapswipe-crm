import { expect, test } from "@playwright/test";

import { PERIODS, storageStateFor } from "./fixtures/seed";

/**
 * Editing the two hand-entered figures, and the bulk split.
 *
 * The first spec here is the one this whole suite justifies itself with. An
 * editable cell seeded its text from `useState`, whose initialiser runs once per
 * mount — and the cells are keyed on a stable row.id, so React reused the
 * instance and the text never re-synced. Editing a cell yourself looked fine,
 * because the text you typed already matched. It only broke when the value
 * changed from OUTSIDE the cell, which is precisely what the bulk split does.
 *
 * No other suite could see it. renderToStaticMarkup gives one render and a fresh
 * render always shows the right value; the DOM assertions in tests/unit pass
 * against the bug. It needs a live reconciler and a real refresh.
 *
 * These specs are admin-only because the controls are: the update policy on
 * rep_payout_rows is admin-only, and payouts-roles.spec.ts covers what a rep
 * sees instead.
 */

test.use({ storageState: storageStateFor("admin") });

const splitInput = (page: import("@playwright/test").Page, merchant: string) =>
  page.getByLabel(`Rep split for ${merchant}`);

const residualInput = (page: import("@playwright/test").Page, merchant: string) =>
  page.getByLabel(`Residual income for ${merchant}`);

/**
 * One rep's whole section, scoped by the bulk-split input only that section has.
 *
 * Necessary because every group renders an identically-labelled "Apply" button,
 * and filtering ancestors by visible text matches several nested divs — the page
 * is one long column, so an outer div contains every section's text. Scoping by a
 * uniquely-labelled control inside the section is unambiguous.
 */
const repSection = (page: import("@playwright/test").Page, repName: string) =>
  page.locator("section").filter({
    has: page.getByLabel(
      `Split percentage for all of ${repName}'s rows this period`,
    ),
  });

/** Type a split and confirm it, for one rep. */
async function applyBulkSplit(
  page: import("@playwright/test").Page,
  repName: string,
  value: string,
): Promise<void> {
  const section = repSection(page, repName);
  await section
    .getByLabel(`Split percentage for all of ${repName}'s rows this period`)
    .fill(value);
  await section.getByRole("button", { name: "Apply" }).click();
  await section.getByRole("button", { name: "Set split" }).click();
}

test.describe("bulk split", () => {
  test("updates every split input it wrote, not just the stored value", async ({
    page,
  }) => {
    await page.goto(`/payouts/${PERIODS.many}`);

    const first = splitInput(page, "E2E Agent Two Merchant 1");
    await expect(first).toHaveValue("50");

    // Apply a new split across the whole of agent two's book.
    await applyBulkSplit(page, "E2E Agent Two", "42.5");

    // THE REGRESSION. Before the fix these inputs kept showing 50 while the
    // Payout column recomputed from 42.5 — the page displaying 400 x 50% =
    // $170.00, two numbers that cannot both be true, on the screen an admin
    // reconciles a processor's report against.
    for (let i = 1; i <= 4; i += 1) {
      await expect(
        splitInput(page, `E2E Agent Two Merchant ${i}`),
        `merchant ${i}'s split input`,
      ).toHaveValue("42.5");
    }
  });

  test("the recomputed payout agrees with the split on screen", async ({
    page,
  }) => {
    await page.goto(`/payouts/${PERIODS.many}`);

    await applyBulkSplit(page, "E2E Agent Two", "25");

    // 400 residual at 25% is 100.00 — asserting the arithmetic the page shows
    // rather than each figure separately, which is what catches the two
    // disagreeing.
    //
    // Note where each number lives, because it is the shape of the bug: in the
    // admin view the two hand-entered figures are INPUTS, so their values are not
    // in the row's text at all, while the derived payout is plain text straight
    // from the server. That split is exactly why the stale-input bug could
    // survive — the text half refreshed and the input half did not.
    await expect(residualInput(page, "E2E Agent Two Merchant 1")).toHaveValue(
      "400",
    );
    await expect(splitInput(page, "E2E Agent Two Merchant 1")).toHaveValue("25");
    await expect(
      page.getByRole("row", { name: /E2E-B2000/ }),
    ).toContainText("$100.00");
  });

  test("asks before overwriting, and says that it overwrites", async ({
    page,
  }) => {
    await page.goto(`/payouts/${PERIODS.many}`);

    const section = repSection(page, "E2E Agent Two");
    await section
      .getByLabel("Split percentage for all of E2E Agent Two's rows this period")
      .fill("30");
    await section.getByRole("button", { name: "Apply" }).click();

    // The confirmation states the consequence rather than asking a bare
    // "are you sure": it replaces figures that are already there.
    await expect(
      page.getByText(/replacing any already entered/i),
    ).toBeVisible();

    // And cancelling writes nothing.
    await section.getByRole("button", { name: "Cancel" }).click();
    await expect(splitInput(page, "E2E Agent Two Merchant 1")).not.toHaveValue(
      "30",
    );
  });
});

test.describe("editing one figure", () => {
  test("saves on Enter and recomputes the payout", async ({ page }) => {
    await page.goto(`/payouts/${PERIODS.single}`);

    const input = residualInput(page, "E2E Only Merchant");
    await expect(input).toHaveValue("250.5");

    await input.fill("400");
    await input.press("Enter");

    // 400 at 55% is 220.00, computed by the generated column and re-read from
    // the server — which is why the cell refreshes rather than patching locally.
    await expect(
      page.getByRole("row", { name: /E2E-SOLO/ }),
    ).toContainText("$220.00");
    await expect(residualInput(page, "E2E Only Merchant")).toHaveValue("400");
  });

  test("shows what the stored figure was while a new one is typed", async ({
    page,
  }) => {
    await page.goto(`/payouts/${PERIODS.single}`);

    const input = residualInput(page, "E2E Only Merchant");
    const stored = await input.inputValue();

    await input.fill("987.65");
    // The "was $X" indicator: this is the element whose render threw
    // `text.trim is not a function` when the column's type was wrong.
    await expect(page.getByText(/^was \$/)).toBeVisible();

    // Escape abandons the edit and the indicator goes with it.
    await input.press("Escape");
    await expect(input).toHaveValue(stored);
    await expect(page.getByText(/^was \$/)).toHaveCount(0);
  });

  test("refuses a split outside 0..100 and writes nothing", async ({ page }) => {
    await page.goto(`/payouts/${PERIODS.single}`);

    const input = splitInput(page, "E2E Only Merchant");
    const before = await input.inputValue();

    await input.fill("150");
    await input.press("Enter");

    // The message is written for a person, and the figure is untouched. The
    // database would also refuse it (numeric(5,2) with a 0..100 check), so this
    // is the client saying so first rather than instead.
    await expect(
      page.getByText("A split has to be between 0 and 100."),
    ).toBeVisible();

    await page.reload();
    await expect(splitInput(page, "E2E Only Merchant")).toHaveValue(before);
  });

  test("refuses text and writes nothing", async ({ page }) => {
    await page.goto(`/payouts/${PERIODS.single}`);

    const input = residualInput(page, "E2E Only Merchant");
    const before = await input.inputValue();

    await input.fill("not a number");
    await input.press("Enter");

    await expect(
      page.getByText("Enter a number, or leave it blank."),
    ).toBeVisible();

    await page.reload();
    await expect(residualInput(page, "E2E Only Merchant")).toHaveValue(before);
  });

  test("accepts a blank as null, which reads as not-worked-out-yet", async ({
    page,
  }) => {
    await page.goto(`/payouts/${PERIODS.single}`);

    await residualInput(page, "E2E Only Merchant").fill("");
    await residualInput(page, "E2E Only Merchant").press("Enter");

    // Null, not zero: the payout goes to an em dash rather than $0.00, and the
    // row starts counting as awaiting figures.
    const row = page.getByRole("row", { name: /E2E-SOLO/ });
    await expect(row).toContainText("—");
    await expect(page.getByText(/awaiting figures/)).toBeVisible();

    // Put it back so this spec leaves the period as it found it.
    await residualInput(page, "E2E Only Merchant").fill("250.5");
    await residualInput(page, "E2E Only Merchant").press("Enter");
    await expect(row).toContainText("$137.78");
  });

  test("a no-op blur writes nothing, so no history row is created", async ({
    page,
  }) => {
    await page.goto(`/payouts/${PERIODS.single}`);

    const input = residualInput(page, "E2E Only Merchant");
    const stored = await input.inputValue();

    // Focus and blur without changing anything. An inline editor gets blurred
    // constantly just by moving around a table, and every write to these two
    // columns records a rep_payout_row_history row — so a no-op UPDATE would
    // fill the trail that exists to say who changed a commission figure.
    await input.click();
    await input.blur();

    await expect(input).toHaveValue(stored);
    await expect(page.getByText(/^was \$/)).toHaveCount(0);
  });
});
