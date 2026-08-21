import { expect, test } from "@playwright/test";

import { LONG_MERCHANT_NAME, PERIODS, storageStateFor } from "./fixtures/seed";

/**
 * How the ledger LOOKS, which is the half no other suite can reach.
 *
 * Two of these lock regressions that were invisible to every other kind of test,
 * because in both cases the DOM was completely correct:
 *
 *   * a long merchant name pushed the six money columns out of a horizontally
 *     scrolling container. Every value was present and right in the accessibility
 *     tree; they were simply off screen.
 *   * a stat card's figure was clipped because the card overflowed its grid track
 *     and the NEXT card's opaque background painted over the overflow. The text
 *     node held the full number.
 *
 * So these assert on geometry — bounding boxes against the viewport and against
 * each other — rather than on text. That is unusual and worth the note: a spec
 * asserting `toContainText` would have passed against both bugs.
 */

test.use({ storageState: storageStateFor("agent") });

test.describe("the money columns stay visible", () => {
  // The `many` period: ordinary figures, plus one row whose merchant name is
  // absurdly long. So a column pushed off screen here can only be the name's
  // doing, which is the regression. (The edge period is a worse venue for this:
  // its trillion-dollar row makes that table wider than the viewport by itself.)
  test("a very long merchant name does not push the figures off screen", async ({
    page,
  }) => {
    await page.goto(`/payouts/${PERIODS.many}`);

    // Truncated rather than laid out at full width, with the full value still
    // reachable through the title attribute.
    const nameCell = page.getByTitle(LONG_MERCHANT_NAME);
    await expect(nameCell).toBeVisible();

    // The regression itself: unwrapped, this name put the Payout header outside
    // the scroll container's visible area.
    const payoutHeader = page.getByRole("columnheader", { name: "Payout" });
    await expect(payoutHeader).toBeInViewport();

    const box = await payoutHeader.boundingBox();
    const viewport = page.viewportSize();
    expect(box, "Payout header should have a box").not.toBeNull();
    expect(viewport, "viewport size should be known").not.toBeNull();
    // Fully inside, not merely intersecting by a pixel.
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width);
  });

  test("every column header is on screen at once", async ({ page }) => {
    await page.goto(`/payouts/${PERIODS.many}`);

    // All eight, in one viewport, without scrolling — the assertion that says
    // "the figures are the point of this page and they are readable".
    for (const header of [
      "MID",
      "Merchant",
      "Volume",
      "Avg ticket",
      "Total cost",
      "Residual income",
      "Split",
      "Payout",
    ]) {
      await expect(
        page.getByRole("columnheader", { name: header }).first(),
        `${header} column header`,
      ).toBeInViewport();
    }
  });

  test("the merchant column is bounded, however long the name", async ({
    page,
  }) => {
    await page.goto(`/payouts/${PERIODS.many}`);

    // The mechanism, asserted directly: the cell holding a 100-character name is
    // no wider than a sane share of the table. Without the cap it was ~1600px.
    const nameCell = page.getByTitle(LONG_MERCHANT_NAME);
    const box = await nameCell.boundingBox();
    expect(box, "the long name should have a box").not.toBeNull();
    expect(box!.width).toBeLessThan(320);
  });

  test("the truncated name still identifies its row by MID", async ({ page }) => {
    await page.goto(`/payouts/${PERIODS.many}`);

    // Truncation is only acceptable because the MID beside it is the row's real
    // identity. If the MID ever moved or was dropped, truncating would stop
    // being a safe trade.
    const row = page.getByRole("row", { name: /E2E-A-LONGNAME/ });
    await expect(row).toBeVisible();
    await expect(row).toContainText("$450.00");
  });
});

test.describe("stat cards do not hide digits", () => {
  /**
   * A whole stat card, by its label.
   *
   * Located through data-slot rather than by matching the figure's text: the
   * edge period's huge row pushes SEVERAL totals over a trillion, so a regex on
   * the number matched more than one card and tripped strict mode.
   */
  const statCard = (page: import("@playwright/test").Page, label: string) =>
    page.locator('[data-slot="stat-card"]').filter({ hasText: label });

  /**
   * scrollWidth vs clientWidth, NOT bounding boxes — and this distinction is the
   * whole reason these specs are worth reading.
   *
   * The first version of them compared the figure's bounding box to its card's
   * and PASSED against the reverted bug. Measured directly: with the clipping
   * styles restored, the <p> reported width 213 (identical to a card holding
   * "10") while its scrollWidth was 270. A block element's box is constrained by
   * its parent; it is the *ink* that overflows, not the geometry. So a box
   * comparison cannot see this class of bug at all, and neither can a text
   * assertion — which is exactly how it shipped.
   *
   * scrollWidth > clientWidth is the standard "content does not fit its box"
   * check, and it is the one thing here that fails when the fix is removed.
   */
  const overflowOf = (card: ReturnType<typeof statCard>) =>
    card.locator("p").last().evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));

  test("a trillion-dollar total fits inside its card rather than spilling", async ({
    page,
  }) => {
    await page.goto(`/payouts/${PERIODS.edge}`);

    const card = statCard(page, "Volume");
    await expect(card).toBeVisible();

    const { scrollWidth, clientWidth } = await overflowOf(card);
    // Equal means it fits (wrapped onto as many lines as it needs). Greater means
    // digits are being painted outside the card, where the next card's opaque
    // background hides them.
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });

  test("no stat card's figure overflows its box", async ({ page }) => {
    await page.goto(`/payouts/${PERIODS.edge}`);

    // Every card, not just the one that happened to break: the failure mode is
    // general to any figure wider than its grid track.
    const measured = await page
      .locator('[data-slot="stat-card"]')
      .evaluateAll((cards) =>
        cards.map((card) => {
          const paragraphs = card.querySelectorAll("p");
          const figure = paragraphs[paragraphs.length - 1];
          return {
            label: paragraphs[0]?.textContent ?? "",
            scrollWidth: figure.scrollWidth,
            clientWidth: figure.clientWidth,
          };
        }),
      );

    expect(measured.length).toBeGreaterThan(1);
    for (const card of measured) {
      expect(
        card.scrollWidth,
        `the ${card.label} figure should fit its card`,
      ).toBeLessThanOrEqual(card.clientWidth);
    }
  });

  test("the full figure is present in the text, digit for digit", async ({
    page,
  }) => {
    await page.goto(`/payouts/${PERIODS.edge}`);

    // The complement to the geometry: clipping was invisible to a text
    // assertion, and wrapping would be invisible to a geometry assertion if the
    // text had silently lost a digit. Both together say the number is whole AND
    // on screen. Two decimal places, always — a figure ending in one is the
    // shape the clipped card produced.
    const figure = statCard(page, "Volume").locator("p").last();
    await expect(figure).toHaveText(/^\$[\d,]+\.\d{2}$/);
  });
});

test.describe("the value edge cases render honestly", () => {
  const cellsOf = (page: import("@playwright/test").Page, mid: string) =>
    page.getByRole("row", { name: new RegExp(mid) }).getByRole("cell");

  test("a null figure is an em dash, never $0.00", async ({ page }) => {
    await page.goto(`/payouts/${PERIODS.edge}`);

    // The distinction the whole module protects: null means "not worked out yet",
    // zero means "worked out, and it is zero". Collapsing them would make an
    // unfinished period look complete and paying nothing.
    const row = cellsOf(page, "E2E-NULL-BOTH");
    await expect(row.nth(5)).toHaveText("—"); // residual income
    await expect(row.nth(6)).toHaveText("—"); // split
    await expect(row.nth(7)).toHaveText("—"); // payout
  });

  test("a real zero is $0.00, never an em dash", async ({ page }) => {
    await page.goto(`/payouts/${PERIODS.edge}`);

    const row = cellsOf(page, "E2E-ZERO");
    await expect(row.nth(5)).toHaveText("$0.00");
    await expect(row.nth(7)).toHaveText("$0.00");
  });

  test("a zero split against a real residual pays exactly zero", async ({
    page,
  }) => {
    await page.goto(`/payouts/${PERIODS.edge}`);

    // Not null: both inputs are present, so rep_payout is computed and is 0.00.
    const row = cellsOf(page, "E2E-ZERO-SPLIT");
    await expect(row.nth(5)).toHaveText("$750.25");
    await expect(row.nth(6)).toHaveText("0%");
    await expect(row.nth(7)).toHaveText("$0.00");
  });

  test("a clawback shows a negative and is marked", async ({ page }) => {
    await page.goto(`/payouts/${PERIODS.edge}`);

    const row = cellsOf(page, "E2E-CLAWBACK");
    // -$X rather than accounting parentheses, which read as a typo in a table.
    await expect(row.nth(4)).toHaveText("-$450.75");
    await expect(row.nth(5)).toHaveText("-$820.40");
    await expect(row.nth(7)).toHaveText("-$451.22");
  });

  test("the column's largest value renders in full, not in scientific notation", async ({
    page,
  }) => {
    await page.goto(`/payouts/${PERIODS.edge}`);

    const row = cellsOf(page, "E2E-HUGE");
    await expect(row.nth(2)).toHaveText("$999,999,999,999.99");
    await expect(row.nth(7)).toHaveText("$999,999,999,999.99");
    await expect(row.nth(2)).not.toContainText("e+");
  });

  test("precision beyond the column's scale is already rounded away", async ({
    page,
  }) => {
    await page.goto(`/payouts/${PERIODS.edge}`);

    // Seeded as 88.4567 / 33.333 / 1234.5678. numeric(14,2) and numeric(5,2)
    // round on the way in, which is what makes "more precision than the UI
    // expects" unreachable from the database rather than merely unhandled.
    const row = cellsOf(page, "E2E-PRECISION");
    await expect(row.nth(2)).toHaveText("$1,234.57");
    await expect(row.nth(5)).toHaveText("$88.46");
    await expect(row.nth(6)).toHaveText("33.33%");
  });

  test("a null merchant name renders an em dash and stays unlinked", async ({
    page,
  }) => {
    await page.goto(`/payouts/${PERIODS.edge}`);

    // An unmatched MID is ordinary — a residual report legitimately names
    // merchants nobody entered — so this must not be a dead link.
    const row = page.getByRole("row", { name: /E2E-NULL-NAME/ });
    await expect(row.getByRole("cell").nth(1)).toHaveText("—");
    await expect(row.getByRole("link")).toHaveCount(0);
  });

  test("a merchant name containing markup is escaped, not interpreted", async ({
    page,
  }) => {
    await page.goto(`/payouts/${PERIODS.edge}`);

    // merchant_name is free text out of a processor's spreadsheet. Rendered as
    // text by React; this pins that it stays text.
    await expect(
      page.getByRole("cell", { name: "<script>alert('xss')</script>" }),
    ).toBeVisible();
    // And no element was actually created from it.
    expect(await page.locator("script:has-text(\"alert('xss')\")").count()).toBe(0);
  });
});
