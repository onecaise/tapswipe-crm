import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  PERSONAS,
  SHARE_FIXTURE,
  adjustmentLines,
  clearAdjustments,
  expectedPostingPeriod,
  seedE2E,
  sharesOn,
  storageStateFor,
  type SeedResult,
} from "./fixtures/seed";

/**
 * The merchant page's shared-account surfaces (phase 6 of
 * docs/design/residual-splits.md): the admin's card, and the signer's notice.
 *
 * tests/rls owns what each RPC refuses and what my_share_partners() returns.
 * What only a browser shows is that the card asks in the admin's terms (40 +
 * 10), says what it will do BEFORE it does it, and renders a refusal as a
 * sentence; that a rep sees the partner's name and their own share and nothing
 * else; and that it all fits a 360px screen with 44px targets.
 */

const f = SHARE_FIXTURE;
const WIDTHS = [360, 768, 1280] as const;

function monthName(period: string): string {
  const [year, month] = period.split("-").map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
}

const card = (page: Page) => page.getByTestId("merchant-share-card");
const setForm = (page: Page) => page.getByRole("form", { name: "Set a shared account" });
const correctionForm = (page: Page) => page.getByRole("form", { name: "Post a correction" });

/** No horizontal page scroll, and no element inside `scope` clipping its ink. */
async function expectFits(page: Page, scope: Locator): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "page scrolls sideways").toBeLessThanOrEqual(0);
  const clipped = await scope.evaluate((root) =>
    [root, ...root.querySelectorAll("*")]
      .filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== "visible")
      .map((el) => (el as HTMLElement).outerHTML.slice(0, 80)),
  );
  expect(clipped).toEqual([]);
}

/** Every button, input and select inside `scope` is at least 44px tall. */
async function expectTapTargets(scope: Locator): Promise<void> {
  const small = await scope.evaluate((root) =>
    [...root.querySelectorAll("button, input, select")]
      .map((el) => ({ el, box: el.getBoundingClientRect() }))
      .filter(({ box }) => box.width > 0 && box.height < 44)
      .map(({ el, box }) => `${el.tagName} "${el.textContent?.trim() || el.id}" ${Math.round(box.height)}px`),
  );
  expect(small).toEqual([]);
}

test.describe("as the admin", () => {
  test.use({ storageState: storageStateFor("admin") });
  test.describe.configure({ mode: "serial" });

  let fx: SeedResult;
  test.beforeAll(async () => {
    fx = await seedE2E();
  });
  test.afterAll(async () => {
    await clearAdjustments(f.admin.mid);
  });

  test("enters the split in rep-percent terms: 40 + 15 is refused by its total, 40 + 10 saves", async ({ page }) => {
    await page.goto(`/merchants/${fx.shares.adminMerchantId}`);
    await expect(card(page).getByText("Not shared.")).toBeVisible();

    const form = setForm(page);
    await form.getByLabel("Partner", { exact: true }).selectOption({ label: PERSONAS.agent2.fullName });
    await form.getByLabel("Signer's share").fill("40");
    await form.getByLabel("Partner's share").fill("15");
    await expect(form.getByTestId("share-summary")).toHaveText(
      "Company 50% · Signer 40% · Partner 15%",
    );
    await expect(form.getByTestId("share-problem")).toHaveText(
      "The two shares must add up to 50. These add up to 55.",
    );
    await expect(form.getByRole("button", { name: "Save share" })).toBeDisabled();

    await form.getByLabel("Partner's share").fill("10");
    await expect(form.getByTestId("share-summary")).toHaveText(
      "Company 50% · Signer 40% · Partner 10%",
    );
    // The latest committed month for this MID is February, so March is the
    // first a share may start in, and that is what the form offers.
    await expect(form.getByLabel("First month it applies to")).toHaveValue("2027-03");
    await form.getByRole("button", { name: "Save share" }).click();

    const row = card(page).getByTestId("merchant-share-row");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(`${PERSONAS.agent.fullName} (signer) 40`);
    await expect(row).toContainText(`${PERSONAS.agent2.fullName} (partner) 10`);
    await expect(row).toContainText("from March 2027");
    expect(await sharesOn(fx.shares.adminMerchantId)).toEqual([
      { primary_rep_pct: 40, secondary_rep_pct: 10, effective_from: "2027-03-01", effective_to: null },
    ]);
  });

  test("ends the share, then cancels it, each behind a confirmation", async ({ page }) => {
    await page.goto(`/merchants/${fx.shares.adminMerchantId}`);
    const row = card(page).getByTestId("merchant-share-row");

    await row.getByRole("button", { name: "End share" }).click();
    await expect(row.getByLabel("First month it no longer applies")).toHaveValue("2027-04");
    await expect(row.getByText("The last month it pays is March 2027.")).toBeVisible();
    await row.getByRole("button", { name: "End share" }).click();
    await expect(row).toContainText("March 2027 – March 2027");
    expect((await sharesOn(fx.shares.adminMerchantId))[0].effective_to).toBe("2027-04-01");

    await row.getByRole("button", { name: "Cancel share" }).click();
    await expect(row.getByRole("button", { name: "Delete share" })).toBeVisible();
    await row.getByRole("button", { name: "Delete share" }).click();
    await expect(card(page).getByTestId("merchant-share-row")).toHaveCount(0);
    expect(await sharesOn(fx.shares.adminMerchantId)).toEqual([]);
  });

  test("shows the posting month BEFORE posting a correction, then refuses a second one for that month", async ({ page }) => {
    await page.goto(`/merchants/${fx.shares.adminMerchantId}`);
    const form = correctionForm(page);
    await expect(form.getByLabel("Month being corrected")).toHaveValue(`${f.period}-01`);
    await form.getByLabel("Partner", { exact: true }).selectOption({ label: PERSONAS.agent3.fullName });
    await form.getByLabel("Signer's share").fill("40");
    await form.getByLabel("Partner's share").fill("10");
    await form.getByLabel("Note (both reps see it)").fill("Agent Three worked this account from the start.");

    const posting = await expectedPostingPeriod();
    await form.getByRole("button", { name: "Review correction" }).click();
    const confirm = form.getByTestId("correction-confirm");
    await expect(confirm).toContainText(`This will post to ${monthName(posting)}`);
    // Nothing is written by reviewing.
    expect(await adjustmentLines(f.admin.mid)).toEqual([]);

    await confirm.getByRole("button", { name: "Post correction" }).click();
    // $200 at 50 is $100.00 for the month; 10 of 50 of that is $20.00.
    await expect(form.getByTestId("correction-done")).toHaveText(
      `Posted to ${monthName(posting)}: ${PERSONAS.agent3.fullName} receives $20.00 from ${PERSONAS.agent.fullName}.`,
    );
    const lines = await adjustmentLines(f.admin.mid);
    expect(lines.map((l) => [l.agent_id, l.period, l.adjustment_amount, l.adjusts_period])).toEqual([
      [fx.ids.agent3, posting, 20, `${f.period}-01`],
      [fx.ids.agent, posting, -20, `${f.period}-01`],
    ]);

    // After the refresh the month is marked, and choosing it says why not.
    await page.reload();
    await expect(form.getByLabel("Month being corrected")).toContainText("already corrected");
    await expect(form.getByTestId("correction-refused")).toHaveText(
      `${f.monthName} was already corrected, in ${monthName(posting)}. A month is corrected once.`,
    );
    await expect(form.getByRole("button", { name: "Review correction" })).toBeDisabled();
  });

  for (const width of WIDTHS) {
    test(`the card fits ${width}px with 44px targets`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/merchants/${fx.shares.sharedMerchantId}`);
      await expect(card(page).getByTestId("merchant-share-row")).toHaveCount(1);
      await card(page).getByRole("button", { name: "End share" }).click();
      await expectFits(page, card(page));
      await expectTapTargets(card(page));
    });
  }
});

test.describe("as the signer", () => {
  test.use({ storageState: storageStateFor("agent") });
  let fx: SeedResult;
  test.beforeAll(async () => {
    fx = await seedE2E();
  });

  for (const width of WIDTHS) {
    test(`sees the partner's name and their own share, and nothing else, at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/merchants/${fx.shares.sharedMerchantId}`);
      const notice = page.getByTestId("merchant-share-notice");
      await expect(notice).toHaveText(
        `Shared account with ${PERSONAS.agent2.fullName} from ${f.monthName} · your share 40%`,
      );
      await expect(card(page)).toHaveCount(0);
      // Nothing of the partner's side: their share, or either payout.
      await expect(page.getByText("10%")).toHaveCount(0);
      await expect(page.getByText(f.partnerPayout)).toHaveCount(0);
      await expectFits(page, notice);
    });
  }

  test("sees no notice on a merchant that is not shared", async ({ page }) => {
    await page.goto(`/merchants/${fx.shares.adminMerchantId}`);
    await expect(page.getByRole("heading", { name: f.admin.dba })).toBeVisible();
    await expect(page.getByTestId("merchant-share-notice")).toHaveCount(0);
  });
});

for (const persona of ["agent2", "agent3"] as const) {
  test.describe(`as ${persona === "agent2" ? "the partner" : "a third rep"}`, () => {
    test.use({ storageState: storageStateFor(persona) });

    test("cannot open the shared merchant: the same page as a merchant that does not exist", async ({ page }) => {
      const fx = await seedE2E();
      await page.goto(`/merchants/${fx.shares.sharedMerchantId}`);
      await expect(page.getByText(/We couldn.t find that/)).toBeVisible();
      await expect(page.getByText(f.shared.dba)).toHaveCount(0);
      await expect(page.getByTestId("merchant-share-notice")).toHaveCount(0);
    });
  });
}
