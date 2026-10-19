import { expect, test, type Page } from "@playwright/test";

import {
  PERSONAS,
  SHARE_FIXTURE,
  seedE2E,
  storageStateFor,
  type SeedResult,
} from "./fixtures/seed";

/**
 * Shared accounts on the payout surfaces (phase 7 of
 * docs/design/residual-splits.md): the period page's markers and the
 * account-total control, the bulk split skipping the partner's line, and the
 * statement's marker and footnote.
 *
 * The privacy rule is the point: each rep sees the partner's NAME and their
 * OWN share, never the partner's share or payout. The fixture's figures are
 * chosen so a leak cannot hide in common digits -- the signer's payout is
 * $493.82 and the partner's $123.46, and the shares are 40 and 10.
 *
 * Four personas: the admin, the signer (agent), the partner (agent2) and a
 * third rep (agent3) paid on an ordinary line in the same month. Every page
 * is checked at 360, 768 and 1280px for sideways scroll, and every control
 * this phase adds for 44px.
 */

const f = SHARE_FIXTURE;
const PERIOD_URL = `/payouts/${f.period}`;
const WIDTHS = [360, 768, 1280] as const;

const markers = (page: Page) => page.getByTestId("payout-share-marker");

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }));
  expect(overflow.doc, "page scrolls sideways").toBeLessThanOrEqual(0);
  expect(overflow.body, "body scrolls sideways").toBeLessThanOrEqual(0);
}

/** Every button and input inside the shared-residual controls is >= 44px tall. */
async function expectShareControlTargets(page: Page): Promise<void> {
  const controls = page.getByTestId("shared-residual-control");
  expect(await controls.count()).toBeGreaterThan(0);
  const small = await controls.evaluateAll((roots) =>
    roots.flatMap((root) =>
      [...root.querySelectorAll("button, input")]
        .map((el) => ({ el, box: el.getBoundingClientRect() }))
        .filter(({ box }) => box.width > 0 && box.height < 44)
        .map(({ el, box }) => `${el.tagName} "${el.textContent?.trim()}" ${Math.round(box.height)}px`),
    ),
  );
  expect(small).toEqual([]);
}

/** The ledger rows naming a merchant, in page order. */
const ledgerRows = (page: Page, merchant: string) =>
  page.getByRole("row").filter({ hasText: merchant });

test.describe("as the admin", () => {
  test.use({ storageState: storageStateFor("admin") });
  test.describe.configure({ mode: "serial" });

  // Reset the fixture: the account total and bulk split tests below write.
  test.beforeAll(async () => {
    await seedE2E();
  });

  test("marks both lines of the pair with both parties, both shares and the account residual", async ({ page }) => {
    await page.goto(PERIOD_URL);
    await expect(markers(page)).toHaveCount(2);
    const expected = `Shared · ${PERSONAS.agent.fullName} 40% / ${PERSONAS.agent2.fullName} 10% · account residual $1,234.56`;
    await expect(markers(page).nth(0)).toContainText(expected);
    await expect(markers(page).nth(1)).toContainText(expected);

    // The control sits on the signer's line only; the partner's says why not.
    await expect(page.getByTestId("shared-residual-control")).toHaveCount(1);
    await expect(
      markers(page).filter({ hasText: "Partner's line: its residual and split follow the signer's line." }),
    ).toHaveCount(1);
    await expect(page.getByText(f.signerPayout).first()).toBeVisible();
    await expect(page.getByText(f.partnerPayout).first()).toBeVisible();
  });

  for (const width of WIDTHS) {
    test(`the period page fits ${width}px and the account-total control is 44px, closed and open`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(PERIOD_URL);
      await expectNoSidewaysScroll(page);
      await expectShareControlTargets(page);
      await page.getByRole("button", { name: /account total/ }).click();
      await expectNoSidewaysScroll(page);
      await expectShareControlTargets(page);
    });
  }

  test("sets the account total once and both lines are re-divided", async ({ page }) => {
    await page.goto(PERIOD_URL);
    await page.getByRole("button", { name: "Change account total ($1,234.56)" }).click();
    await page.getByLabel(`Account total residual for ${f.shared.dba}`).fill("2000");
    await page.getByRole("button", { name: "Save total" }).click();

    // $2,000 at 50 is $1,000 for the account: 10 of 50 is $200.00 for the
    // partner and $800.00 for the signer. Read after a reload, from the
    // database's own generated column.
    await page.reload();
    await expect(markers(page).nth(0)).toContainText("account residual $2,000.00");
    await expect(markers(page).nth(1)).toContainText("account residual $2,000.00");
    await expect(page.getByText("$800.00").first()).toBeVisible();
    await expect(page.getByText("$200.00").first()).toBeVisible();
    await expect(page.getByText(f.signerPayout)).toHaveCount(0);
  });

  /** One rep's bulk split: fill, Apply, confirm; returns the input. */
  async function bulkSplit(page: Page, repName: string, value: string) {
    const section = page.locator("section").filter({
      has: page.getByLabel(`Split percentage for all of ${repName}'s rows this period`),
    });
    const input = section.getByLabel(`Split percentage for all of ${repName}'s rows this period`);
    await input.fill(value);
    await section.getByRole("button", { name: "Apply" }).click();
    await section.getByRole("button", { name: "Set split" }).click();
    return { section, input };
  }

  test("the bulk split on the PARTNER's group skips their partner line and sets the rest", async ({ page }) => {
    // agent2's group this month is a mix: their half of the shared pair, and an
    // ordinary line of their own. The partner line takes the signer's rate and
    // guard_shared_line() refuses a direct change to it, so without the filter
    // the whole statement is refused and NOTHING is set.
    await page.goto(PERIOD_URL);
    const { section, input } = await bulkSplit(page, PERSONAS.agent2.fullName, "45");
    await expect(section.getByText("Set split for all 1 row")).toBeVisible();
    // Success clears the box; a refusal leaves "45" there with the error.
    await expect(input).toHaveValue("");

    await page.reload();
    // The ordinary line is an input for an admin, so its payout is the
    // evidence: $100 at 45 is $45.00. The partner line still reads the
    // signer's 50% -- the bulk split did not touch it.
    await expect(ledgerRows(page, f.partnerOwn.dba)).toContainText("$45.00");
    await expect(ledgerRows(page, f.shared.dba).last()).toContainText("50%");
  });

  test("the bulk split on the SIGNER's group carries the new rate to the partner's line", async ({ page }) => {
    await page.goto(PERIOD_URL);
    const { input } = await bulkSplit(page, PERSONAS.agent.fullName, "60");
    await expect(input).toHaveValue("");

    await page.reload();
    // Signer's line first (E2E Agent's group), partner's last; the partner's
    // split is read-only text and now reads the signer's 60 (copied across by
    // copy_signer_rate_to_partner()).
    const pair = ledgerRows(page, f.shared.dba);
    await expect(pair).toHaveCount(2);
    await expect(pair.last()).toContainText("60%");
  });
});

test.describe("as the signer", () => {
  test.use({ storageState: storageStateFor("agent") });
  let fx: SeedResult;
  test.beforeAll(async () => {
    fx = await seedE2E();
  });

  for (const width of WIDTHS) {
    test(`period page at ${width}px: the partner's name and their own 40%, nothing of the partner's`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(PERIOD_URL);
      await expect(markers(page)).toHaveCount(1);
      await expect(markers(page)).toHaveText(
        `Shared account with ${PERSONAS.agent2.fullName} · your share 40%`,
      );
      await expect(page.getByText(f.signerPayout).first()).toBeVisible();
      await expect(page.getByText(f.partnerPayout)).toHaveCount(0);
      await expect(page.getByText("10%")).toHaveCount(0);
      await expect(page.getByText(/account residual/i)).toHaveCount(0);
      await expect(page.getByTestId("shared-residual-control")).toHaveCount(0);
      // The signer can open the merchant, so it stays a link.
      await expect(page.getByRole("link", { name: f.shared.dba })).toHaveCount(1);
      await expectNoSidewaysScroll(page);
    });

    test(`statement at ${width}px: marker and footnote, nothing of the partner's`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${PERIOD_URL}/summary/${fx.ids.agent}`);
      await expect(page.getByTestId("statement-share-marker")).toHaveText(
        `Shared account with ${PERSONAS.agent2.fullName} · your share 40% †`,
      );
      await expect(page.getByTestId("statement-share-footnote")).toContainText(
        "Shared account: the payout is your share of the account’s rep payout",
      );
      await expect(page.getByText(f.signerPayout).first()).toBeVisible();
      await expect(page.getByText(f.partnerPayout)).toHaveCount(0);
      await expect(page.getByText("10%")).toHaveCount(0);
      await expectNoSidewaysScroll(page);
    });
  }
});

test.describe("as the partner", () => {
  test.use({ storageState: storageStateFor("agent2") });
  let fx: SeedResult;
  test.beforeAll(async () => {
    fx = await seedE2E();
  });

  for (const width of WIDTHS) {
    test(`period page at ${width}px: the signer's name and their own 10%, the merchant as plain text`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(PERIOD_URL);
      await expect(markers(page)).toHaveText(
        `Shared account with ${PERSONAS.agent.fullName} · your share 10% · The account's volume is reported on the signer's line.`,
      );
      await expect(page.getByText(f.partnerPayout).first()).toBeVisible();
      await expect(page.getByText(f.signerPayout)).toHaveCount(0);
      await expect(page.getByText("40%")).toHaveCount(0);
      // The partner has no access to the merchant record: no link to a 404.
      await expect(page.getByText(f.shared.dba)).toBeVisible();
      await expect(page.getByRole("link", { name: f.shared.dba })).toHaveCount(0);
      await expectNoSidewaysScroll(page);
    });

    test(`statement at ${width}px: marker and footnote, nothing of the signer's`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${PERIOD_URL}/summary/${fx.ids.agent2}`);
      await expect(page.getByTestId("statement-share-marker")).toHaveText(
        `Shared account with ${PERSONAS.agent.fullName} · your share 10% †`,
      );
      await expect(page.getByTestId("statement-share-footnote")).toBeVisible();
      await expect(page.getByText(f.signerPayout)).toHaveCount(0);
      await expect(page.getByText("40%")).toHaveCount(0);
      await expectNoSidewaysScroll(page);
    });
  }

  test("cannot open the signer's statement", async ({ page }) => {
    await page.goto(`${PERIOD_URL}/summary/${fx.ids.agent}`);
    await expect(page.getByText(/We couldn.t find that/)).toBeVisible();
    await expect(page.getByText(f.signerPayout)).toHaveCount(0);
  });
});

test.describe("as a third rep", () => {
  test.use({ storageState: storageStateFor("agent3") });
  let fx: SeedResult;
  test.beforeAll(async () => {
    fx = await seedE2E();
  });

  for (const width of WIDTHS) {
    test(`sees only their own ordinary line, and nothing of the share, at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(PERIOD_URL);
      await expect(page.getByText(f.third.dba)).toBeVisible();
      await expect(markers(page)).toHaveCount(0);
      for (const leak of [
        f.shared.dba,
        f.signerPayout,
        f.partnerPayout,
        PERSONAS.agent.fullName,
        PERSONAS.agent2.fullName,
      ]) {
        // exact: "E2E Agent" is a prefix of this persona's own name.
        await expect(page.getByText(leak, { exact: true }), leak).toHaveCount(0);
      }
      await expect(page.getByText(/Shared/)).toHaveCount(0);
      await expectNoSidewaysScroll(page);

      await page.goto(`${PERIOD_URL}/summary/${fx.ids.agent3}`);
      await expect(page.getByTestId("statement-share-marker")).toHaveCount(0);
      await expect(page.getByTestId("statement-share-footnote")).toHaveCount(0);
      await expectNoSidewaysScroll(page);
    });
  }
});
