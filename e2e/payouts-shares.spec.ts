import { expect, test, type Page } from "@playwright/test";

import {
  OVERRIDE_FIXTURE,
  PERSONAS,
  SHARE_FIXTURE,
  createOverrideFixture,
  overrideLines,
  seedE2E,
  storageStateFor,
  type SeedResult,
} from "./fixtures/seed";

/**
 * Shared accounts on the payout surfaces (phase 7 of
 * docs/design/residual-splits.md): the period page's markers and the
 * statement's marker and footnote. The account-total control and the bulk
 * split went with every other ledger edit in phase 11 of
 * docs/design/intake-and-reports.md (20261102140000); payouts-editing.spec.ts
 * asserts they are gone.
 *
 * The privacy rule is the point: each rep sees the partner's NAME and their
 * OWN share, never the partner's share or payout. The fixture's figures are
 * chosen so a leak cannot hide in common digits -- the signer's payout is
 * $493.82 and the partner's $123.46, and the shares are 40 and 10.
 *
 * Four personas: the admin, the signer (agent), the partner (agent2) and a
 * third rep (agent3) paid on an ordinary line in the same month. Every page
 * is checked at 360, 768 and 1280px for sideways scroll.
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

test.describe("as the admin", () => {
  test.use({ storageState: storageStateFor("admin") });
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    await seedE2E();
  });

  test("marks both lines of the pair with both parties, both shares and the account residual", async ({ page }) => {
    await page.goto(PERIOD_URL);
    await expect(markers(page)).toHaveCount(2);
    const expected = `Shared · ${PERSONAS.agent.fullName} 40% / ${PERSONAS.agent2.fullName} 10% · account residual $1,234.56`;
    await expect(markers(page).nth(0)).toContainText(expected);
    await expect(markers(page).nth(1)).toContainText(expected);

    // Read-only: the partner's line says where its figures come from.
    await expect(
      markers(page).filter({ hasText: "Partner's line: its residual and split follow the signer's line." }),
    ).toHaveCount(1);
    await expect(page.getByText(f.signerPayout).first()).toBeVisible();
    await expect(page.getByText(f.partnerPayout).first()).toBeVisible();
  });

  for (const width of WIDTHS) {
    test(`the period page fits ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(PERIOD_URL);
      await expect(markers(page)).toHaveCount(2);
      await expectNoSidewaysScroll(page);
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

/**
 * Overrides on a shared account (20261102120000; memo §4.3-4.4, A4c), from
 * createOverrideFixture(): a 5% override on a shared merchant (agent signs
 * 40, agent2 partners 10) and on a plain one of agent's, both paid to agent3,
 * committed through the real v3. The deduction divides between signer and
 * partner by the cent rule (49.38 + 12.35 = 61.73). Each rep sees their OWN
 * debit and who receives it; the recipient sees the credit with the
 * merchant's name as plain text, and nothing of the merchant, the percent or
 * either rep.
 */
test.describe("overrides on a shared account", () => {
  const o = OVERRIDE_FIXTURE;
  let fx: Awaited<ReturnType<typeof createOverrideFixture>>;
  const block = (page: Page) => page.getByTestId("payout-overrides");
  const lines = (page: Page) => page.getByTestId("payout-override-line");
  const statementLines = (page: Page) => page.getByTestId("statement-override");

  test.beforeAll(async () => {
    const seeded = await seedE2E();
    fx = await createOverrideFixture("shares");
    // The commit wrote the pair the memo specifies, to the cent.
    expect(await overrideLines(fx.batchId)).toEqual([
      { agent_id: seeded.ids.agent, role: "debit", amount: -49.38 },
      { agent_id: seeded.ids.agent2, role: "debit", amount: -12.35 },
      { agent_id: seeded.ids.agent, role: "debit", amount: -10 },
      { agent_id: seeded.ids.agent3, role: "credit", amount: -0.59 },
      { agent_id: seeded.ids.agent, role: "debit", amount: 0.59 },
      { agent_id: seeded.ids.agent3, role: "credit", amount: 10 },
      { agent_id: seeded.ids.agent3, role: "credit", amount: 61.73 },
    ]);
  });

  test.describe("the signer", () => {
    test.use({ storageState: storageStateFor("agent") });

    test("reads their own two debits and who receives them; nothing of the partner's piece or the credit", async ({ page }) => {
      await page.goto(`/payouts/${fx.period}`);
      const mine = lines(page).filter({ hasText: fx.shared.dba });
      await expect(mine).toHaveCount(1);
      await expect(mine).toContainText(`Override ${o.pct}% of residual · to ${PERSONAS.agent3.fullName}`);
      await expect(mine).toContainText(o.shared.signerDebit);
      await expect(lines(page).filter({ hasText: fx.plain.dba })).toContainText(o.plain.debit);
      await expect(block(page).getByText(o.shared.partnerDebit)).toHaveCount(0);
      await expect(block(page).getByText(o.shared.credit)).toHaveCount(0);
      await expect(block(page).getByText("Override received")).toHaveCount(0);
    });

    test("the statement prints the same lines", async ({ page }) => {
      await page.goto(`/payouts/${fx.period}/summary/${fx.ids.agent}`);
      await expect(statementLines(page).filter({ hasText: fx.shared.dba })).toContainText(
        `Override ${o.pct}% of residual · to ${PERSONAS.agent3.fullName}`,
      );
      await expect(statementLines(page).filter({ hasText: fx.shared.dba })).toContainText(o.shared.signerDebit);
      await expect(page.getByText(o.shared.partnerDebit)).toHaveCount(0);
    });
  });

  test.describe("the partner", () => {
    test.use({ storageState: storageStateFor("agent2") });

    test("reads their own piece of the deduction and who receives it; nothing of the signer's", async ({ page }) => {
      await page.goto(`/payouts/${fx.period}`);
      // Scoped to this fixture: another spec's fixture may share the month.
      const mine = lines(page).filter({ hasText: fx.shared.dba });
      await expect(mine).toHaveCount(1);
      await expect(mine).toContainText(`Override ${o.pct}% of residual · to ${PERSONAS.agent3.fullName}`);
      await expect(mine).toContainText(o.shared.partnerDebit);
      await expect(page.getByText(o.shared.signerDebit)).toHaveCount(0);
      await expect(page.getByText(fx.plain.dba)).toHaveCount(0);
      // The merchant name in the override block is plain text for the partner.
      await expect(block(page).getByRole("link")).toHaveCount(0);
    });
  });

  test.describe("the recipient", () => {
    test.use({ storageState: storageStateFor("agent3") });

    test("reads the credits with the merchants' names as plain text, and nothing else of them", async ({ page }) => {
      await page.goto(`/payouts/${fx.period}`);
      const shared = lines(page).filter({ hasText: fx.shared.dba });
      await expect(shared).toHaveCount(1);
      await expect(lines(page).filter({ hasText: fx.plain.dba })).toHaveCount(1);
      await expect(shared).toContainText("Override received");
      await expect(shared).toContainText(o.shared.credit);
      await expect(lines(page).filter({ hasText: fx.plain.dba })).toContainText(o.plain.credit);
      await expect(block(page).getByRole("link")).toHaveCount(0);
      for (const leak of [
        `${o.pct}%`,
        o.shared.signerDebit,
        o.shared.partnerDebit,
        PERSONAS.agent.fullName,
        PERSONAS.agent2.fullName,
        "of residual",
      ]) {
        await expect(page.getByText(leak, { exact: true }), leak).toHaveCount(0);
        await expect(block(page).getByText(leak), leak).toHaveCount(0);
      }
    });

    test("the statement prints the credits with no MID, and no percent", async ({ page }) => {
      await page.goto(`/payouts/${fx.period}/summary/${fx.ids.agent3}`);
      await expect(statementLines(page).filter({ hasText: fx.shared.dba })).toContainText(o.shared.credit);
      await expect(statementLines(page).filter({ hasText: fx.plain.dba })).toContainText(o.plain.credit);
      await expect(page.getByText(fx.shared.mid)).toHaveCount(0);
      await expect(page.getByText(`${o.pct}%`)).toHaveCount(0);
    });

    test("cannot open the merchant behind a credit", async ({ page }) => {
      await page.goto(`/merchants/${fx.shared.merchantId}`);
      await expect(page.getByText(/We couldn.t find that/)).toBeVisible();
      await expect(page.getByRole("heading", { name: fx.shared.dba })).toHaveCount(0);
    });
  });

  test.describe("the admin", () => {
    test.use({ storageState: storageStateFor("admin") });

    test("sees every line, the credit with its percent", async ({ page }) => {
      await page.goto(`/payouts/${fx.period}`);
      for (const amount of [o.shared.signerDebit, o.shared.partnerDebit, o.shared.credit]) {
        await expect(block(page).getByText(amount).first(), amount).toBeVisible();
      }
      await expect(
        lines(page).filter({ hasText: fx.shared.dba }).filter({ hasText: "Override received" }),
      ).toContainText(`Override received · ${o.pct}% of residual`);
    });
  });
});
