import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  PERSONAS,
  STORE_FIXTURE,
  clearProposalsTitled,
  proposalLines,
  seedE2E,
  storageStateFor,
  type MerchantProposalFixture,
  type SeedResult,
} from "./fixtures/seed";

/**
 * A NON-ADMIN REP builds a hardware proposal, on a lead and on a merchant.
 *
 * ## Why these are in e2e and not in one of the other three suites
 *
 * The cart arithmetic and the device/add-on grouping are pure and are tested
 * in tests/unit/quote-cart.test.ts, where ties and unpriced products can be
 * constructed exactly. The scoping, the exactly-one-owner constraint and the
 * price lock are in tests/rls/quote-owners-and-price-lock.test.ts, against
 * real policies — including a DIRECT insert with a forged unit_price, which is
 * the path the grant actually allows.
 *
 * What is left is the part only a browser can see, and it is most of the
 * feature:
 *
 *   * **Compatibility reaching the UI.** That the sleeve is not offered under
 *     the terminal is a claim about a join, two filters and a React render. An
 *     RLS test cannot see it: every row involved is readable by every active
 *     rep, so nothing is being denied — the store simply has to ask the right
 *     question.
 *   * **The archived product being absent.** Hidden by the QUERY and not by a
 *     policy (deliberately — see the schema doc), so no policy test can check
 *     it. tests/rls asserts the opposite, that a rep CAN still read the row.
 *   * **That a non-admin can do any of this at all.** Everything here runs as
 *     `agent`, whose role is 'agent'. A feature that silently needed admin
 *     would pass every other suite.
 *   * **The two totals, on screen and on paper.**
 *   * **Layout at 375/768/1440.** Reps use phones, and the payouts pass found
 *     three bugs no other suite could — including six money columns pushed off
 *     screen by one long name.
 *
 * ## Nothing here asserts a hardcoded catalog count
 *
 * The dev database moves (the live suite writes to the same stack, and
 * ensureQuote adds its own products), so every assertion is about the
 * FIXTURE's own named rows — present, absent, or a figure derived from
 * STORE_FIXTURE's prices. The one arithmetic claim is cross-read from the
 * database as well as the page.
 */

let seeded: SeedResult;
let agentLeadId = 0;
let merchant: MerchantProposalFixture;

test.beforeAll(async () => {
  seeded = await seedE2E();
  agentLeadId = seeded.docOwners.agent.lead;
  merchant = seeded.merchantProposal;
});

/** The proposals panel's own <section>, located by its heading. */
function panelOf(page: Page): Locator {
  return page
    .getByRole("heading", { name: "Hardware proposals", exact: true })
    .locator("xpath=ancestor::section[1]");
}

/** Opens the builder and returns the panel it lives in. */
async function openBuilder(page: Page, path: string): Promise<Locator> {
  await page.goto(path);
  const panel = panelOf(page);
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "New proposal" }).click();
  // The search box only exists once the store is rendered, so waiting for it
  // is waiting for the builder rather than for a timeout.
  await expect(panel.getByLabel("Search the catalog")).toBeVisible();
  return panel;
}

/** The cart row for one product, by the aria-label on its remove button. */
function cartRow(panel: Locator, name: string): Locator {
  return panel
    .getByRole("button", { name: `Remove ${name}` })
    .locator("xpath=ancestor::div[1]");
}

test.describe("a rep builds a proposal on a lead", () => {
  test.use({ storageState: storageStateFor("agent") });

  test("is a plain agent, which is what makes the rest of this file a claim", async () => {
    // Stated as its own assertion rather than left implicit in the storage
    // state. If this persona were ever given 'admin' the whole file would keep
    // passing while proving nothing about a rep.
    expect(PERSONAS.agent.role).toBe("agent");
  });

  test("browses by brand and type, and never offers an archived product", async ({
    page,
  }) => {
    const panel = await openBuilder(page, `/leads/${agentLeadId}`);

    // Both devices are there before any filtering.
    await expect(
      panel.getByRole("button", { name: `Add ${STORE_FIXTURE.device.name}` }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", {
        name: `Add ${STORE_FIXTURE.otherDevice.name}`,
      }),
    ).toBeVisible();

    // The archived one never is. Hidden by the query rather than by a policy —
    // tests/rls asserts a rep can still READ that row, which is what makes
    // this a UI claim and not a duplicate of it.
    await expect(
      panel.getByRole("button", {
        name: `Add ${STORE_FIXTURE.archivedDevice.name}`,
      }),
    ).toHaveCount(0);

    // Filtering by brand excludes the other vendor's device.
    await panel.getByLabel("Filter by brand").selectOption(STORE_FIXTURE.brand);
    await expect(
      panel.getByRole("button", { name: `Add ${STORE_FIXTURE.device.name}` }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", {
        name: `Add ${STORE_FIXTURE.otherDevice.name}`,
      }),
    ).toHaveCount(0);

    // And by type, which is `category` — a second column for it would be the
    // same fact twice.
    await panel.getByLabel("Filter by brand").selectOption("");
    await panel
      .getByLabel("Filter by device type")
      .selectOption(STORE_FIXTURE.otherDeviceType);
    await expect(
      panel.getByRole("button", {
        name: `Add ${STORE_FIXTURE.otherDevice.name}`,
      }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: `Add ${STORE_FIXTURE.device.name}` }),
    ).toHaveCount(0);
  });

  test("searches by name, model and brand", async ({ page }) => {
    const panel = await openBuilder(page, `/leads/${agentLeadId}`);
    const search = panel.getByLabel("Search the catalog");

    // By sku, which is what a rep reads off a price sheet.
    await search.fill(STORE_FIXTURE.device.sku);
    await expect(
      panel.getByRole("button", { name: `Add ${STORE_FIXTURE.device.name}` }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", {
        name: `Add ${STORE_FIXTURE.otherDevice.name}`,
      }),
    ).toHaveCount(0);

    // And something that matches nothing says so, rather than rendering an
    // empty list that reads as an empty catalog.
    await search.fill("zzzz-no-such-product");
    await expect(panel.getByText(/No devices match that/i)).toBeVisible();
  });

  test("offers only the add-ons that FIT the device in the cart", async ({
    page,
  }) => {
    // The central claim of the compatibility table. Both add-ons exist, both
    // are priced, and only one is linked to this device — so a store that
    // ignored product_compatibility entirely would offer both and pass any
    // test that only checked the fitting one appeared.
    const panel = await openBuilder(page, `/leads/${agentLeadId}`);

    await panel
      .getByRole("button", { name: `Add ${STORE_FIXTURE.device.name}` })
      .click();

    const offer = panel.getByRole("button", {
      name: `Add ${STORE_FIXTURE.fittingAddon.name} to ${STORE_FIXTURE.device.name}`,
    });
    await expect(offer).toBeVisible();

    await expect(
      panel.getByRole("button", {
        name: `Add ${STORE_FIXTURE.nonFittingAddon.name} to ${STORE_FIXTURE.device.name}`,
      }),
      "an add-on linked to a different device was offered",
    ).toHaveCount(0);

    // The non-fitting one is not browsable either: only devices are, which is
    // how an add-on stays reachable solely under something it fits.
    await expect(
      panel.getByRole("button", {
        name: `Add ${STORE_FIXTURE.nonFittingAddon.name}`,
        exact: true,
      }),
    ).toHaveCount(0);

    // Adding it moves it out of the offer row and into the cart, so a rep
    // cannot add the same add-on twice under one device.
    await offer.click();
    await expect(cartRow(panel, STORE_FIXTURE.fittingAddon.name)).toBeVisible();
    await expect(offer).toHaveCount(0);
  });

  test("totals one-time and monthly separately, and never sums them", async ({
    page,
  }) => {
    const panel = await openBuilder(page, `/leads/${agentLeadId}`);

    await panel
      .getByRole("button", { name: `Add ${STORE_FIXTURE.device.name}` })
      .click();
    await panel
      .getByRole("button", {
        name: `Add ${STORE_FIXTURE.fittingAddon.name} to ${STORE_FIXTURE.device.name}`,
      })
      .click();

    // One device at 400, one monthly add-on at 25.
    const totals = panel.locator("dl").last();
    await expect(totals).toContainText("$400.00");
    await expect(totals).toContainText("$25.00");

    // The stepper, which is the control a rep on a phone actually uses.
    await panel
      .getByRole("button", {
        name: `Increase quantity of ${STORE_FIXTURE.fittingAddon.name}`,
      })
      .click();
    await expect(totals).toContainText("$50.00");
    // The one-time figure did NOT move, which is what says the split is real
    // rather than one number rendered twice.
    await expect(totals).toContainText("$400.00");

    // And no combined figure anywhere: 400 + 50 is not a price.
    await expect(panel.getByText("$450.00")).toHaveCount(0);
  });

  test("saves a proposal, and the saved LINES come from the catalog", async ({
    page,
  }) => {
    await clearProposalsTitled(STORE_FIXTURE.proposalTitle);

    const panel = await openBuilder(page, `/leads/${agentLeadId}`);
    await panel.getByLabel("Title").fill(STORE_FIXTURE.proposalTitle);
    await panel
      .getByRole("button", { name: `Add ${STORE_FIXTURE.device.name}` })
      .click();
    await panel
      .getByRole("button", {
        name: `Add ${STORE_FIXTURE.fittingAddon.name} to ${STORE_FIXTURE.device.name}`,
      })
      .click();
    await panel
      .getByRole("button", {
        name: `Increase quantity of ${STORE_FIXTURE.fittingAddon.name}`,
      })
      .click();

    await panel.getByRole("button", { name: "Save proposal" }).click();

    // The row appearing is the whole RPC having worked through a rep's own
    // session: the insert policy's lead branch, enforce_quote_version
    // assigning v1, and the snapshot.
    await expect(
      panel.getByText(STORE_FIXTURE.proposalTitle).first(),
    ).toBeVisible();
    await expect(panel.getByText(/Version 1 of 1/)).toBeVisible();

    // And the rows, not just the page. A store that displayed the right figure
    // while saving a different one would look identical.
    const lines = await proposalLines(STORE_FIXTURE.proposalTitle);
    expect(lines).toHaveLength(2);

    // Order IS the grouping: device first, then its add-on.
    expect(lines[0].product_name).toBe(STORE_FIXTURE.device.name);
    expect(lines[0].product_kind).toBe("device");
    expect(lines[0].sort_order).toBe(0);
    expect(Number(lines[0].unit_price)).toBe(STORE_FIXTURE.device.price);

    expect(lines[1].product_name).toBe(STORE_FIXTURE.fittingAddon.name);
    expect(lines[1].product_kind).toBe("addon");
    expect(lines[1].product_billing).toBe("monthly");
    expect(lines[1].quantity).toBe(2);
    expect(Number(lines[1].unit_price)).toBe(STORE_FIXTURE.fittingAddon.price);
  });

  test("prints what it saved, as a Hardware Proposal", async ({ page }) => {
    await clearProposalsTitled(STORE_FIXTURE.proposalTitle);

    const panel = await openBuilder(page, `/leads/${agentLeadId}`);
    await panel.getByLabel("Title").fill(STORE_FIXTURE.proposalTitle);
    await panel
      .getByRole("button", { name: `Add ${STORE_FIXTURE.device.name}` })
      .click();
    await panel
      .getByRole("button", {
        name: `Add ${STORE_FIXTURE.fittingAddon.name} to ${STORE_FIXTURE.device.name}`,
      })
      .click();
    await panel.getByRole("button", { name: "Save proposal" }).click();
    await expect(
      panel.getByText(STORE_FIXTURE.proposalTitle).first(),
    ).toBeVisible();

    // Through the panel's own Print link rather than a hand-built URL — the
    // link is what a rep clicks, and the bare group URL is deliberately what
    // it points at so it keeps printing whatever is current.
    const row = panel
      .locator("> ul > li")
      .filter({ hasText: STORE_FIXTURE.proposalTitle });
    await row.getByRole("link", { name: "Print", exact: true }).click();

    // Waited for explicitly. Without it the assertions below race the
    // navigation, and every one of them has a false match back on the lead
    // page — which has both a "Hardware proposals" heading and the title in
    // two places (the panel row and the timeline entry).
    await page.waitForURL(/\/quotes\/.*\/print$/);

    // `exact` matters here: getByRole's name matching is a case-insensitive
    // SUBSTRING by default, so "Hardware Proposal" also matches the panel's
    // own "Hardware proposals" heading. That is what made the first draft of
    // this spec pass while still on the lead page.
    const sheet = page.getByRole("article");
    await expect(
      page.getByRole("heading", { name: "Hardware Proposal", exact: true }),
    ).toBeVisible();
    await expect(sheet.getByText(STORE_FIXTURE.proposalTitle)).toBeVisible();
    await expect(sheet.getByText(STORE_FIXTURE.device.name)).toBeVisible();
    await expect(sheet.getByText(STORE_FIXTURE.fittingAddon.name)).toBeVisible();

    // Both totals on the sheet, and the monthly one labelled as recurring.
    await expect(sheet.getByText("One-time total")).toBeVisible();
    await expect(sheet.getByText("Monthly total")).toBeVisible();

    // Prepared by the REP, whose proposal this is.
    await expect(sheet.getByText(PERSONAS.agent.fullName)).toBeVisible();

    // No invented terms. PROPOSAL_TERMS is empty, so no terms block renders —
    // not an empty heading and not placeholder legal wording.
    await expect(
      page.getByRole("heading", { name: "Terms", exact: true }),
    ).toHaveCount(0);
  });
});

test.describe("a rep builds a proposal on a merchant", () => {
  test.use({ storageState: storageStateFor("agent") });

  test("has the same panel on a merchant, and saves against it", async ({
    page,
  }) => {
    // The whole point of quotes.merchant_id. A rep sells hardware to win a
    // deal and sells more to the same business two years later, when it is a
    // merchant on the books.
    const title = `${STORE_FIXTURE.proposalTitle} (merchant)`;
    await clearProposalsTitled(title);

    const panel = await openBuilder(page, `/merchants/${merchant.merchantId}`);
    await panel.getByLabel("Title").fill(title);
    await panel
      .getByRole("button", { name: `Add ${STORE_FIXTURE.device.name}` })
      .click();
    await panel
      .getByRole("button", {
        name: `Add ${STORE_FIXTURE.fittingAddon.name} to ${STORE_FIXTURE.device.name}`,
      })
      .click();
    await panel.getByRole("button", { name: "Save proposal" }).click();

    await expect(panel.getByText(title).first()).toBeVisible();

    const lines = await proposalLines(title);
    expect(lines.map((line) => line.product_name)).toEqual([
      STORE_FIXTURE.device.name,
      STORE_FIXTURE.fittingAddon.name,
    ]);

    await clearProposalsTitled(title);
  });

  test("prints the merchant proposal through the second route", async ({
    page,
  }) => {
    await page.goto(
      `/merchants/${merchant.merchantId}/quotes/${merchant.groupId}/print`,
    );

    const sheet = page.getByRole("article");
    await expect(
      page.getByRole("heading", { name: "Hardware Proposal", exact: true }),
    ).toBeVisible();
    // The SEEDED proposal's own title, which is deliberately not the one the
    // saving specs use — they clear by title first, and sharing one made this
    // test pass in isolation and fail in the file run.
    await expect(
      sheet.getByText(STORE_FIXTURE.merchantProposalTitle),
    ).toBeVisible();

    // One device and two monthly add-ons: $400.00 one-time, $50.00 monthly.
    // Derived from STORE_FIXTURE rather than hardcoded, so repricing the
    // fixture cannot leave this silently wrong.
    const oneTime = STORE_FIXTURE.device.price;
    const monthly = STORE_FIXTURE.fittingAddon.price * 2;
    await expect(sheet.getByText("One-time total")).toBeVisible();
    await expect(
      sheet.getByText(`$${oneTime.toFixed(2)}`).first(),
    ).toBeVisible();
    await expect(sheet.getByText("Monthly total")).toBeVisible();
    await expect(
      sheet.getByText(`$${monthly.toFixed(2)}`).first(),
    ).toBeVisible();

    // The business name, from `merchants.dba` rather than a lead's — and no
    // contact line, because `merchants` has no contact columns and nothing
    // reaches into the originating pre-app to invent one.
    await expect(sheet.getByText("Prepared for")).toBeVisible();
    await expect(sheet.getByText("Prepared by")).toBeVisible();
    await expect(sheet.getByText(PERSONAS.agent.fullName)).toBeVisible();
  });
});

test.describe("another rep's merchant proposal", () => {
  test.use({ storageState: storageStateFor("agent2") });

  test("refuses rather than admitting the proposal exists", async ({ page }) => {
    await page.goto(
      `/merchants/${merchant.merchantId}/quotes/${merchant.groupId}/print`,
    );

    /**
     * Asserted on what RENDERS, not on the HTTP status — and the first draft
     * of this spec got that wrong.
     *
     * Under `cacheComponents` the static shell is flushed before the Suspense
     * boundary streams, so the headers are long gone by the time notFound()
     * runs: this returns **200** with not-found content in the body. Measured
     * here, and already written up in e2e/print.spec.ts for the lead route and
     * for /merchants/[id]/print — so it is the existing behaviour of every
     * record page rather than something this route introduced.
     *
     * The claim the route actually owes is 404 SEMANTICS: "not yours" and
     * "does not exist" must be the same answer. That is what the copy below
     * checks, and it matters more here than on the lead route — merchant ids
     * are sequential and a rep knows their own, so "does merchant 41 exist" is
     * exactly the question a distinguishable response would answer.
     */
    await expect(page.getByText(/We couldn.t find that/)).toBeVisible();
    await expect(
      page.getByText(/belong to another rep/i),
      "the copy should not distinguish absent from not-yours",
    ).toBeVisible();

    // And nothing of the document leaked past the guard — not the type
    // heading, not the title, not a figure.
    await expect(
      page.getByRole("heading", { name: "Hardware Proposal", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText(STORE_FIXTURE.merchantProposalTitle),
    ).toHaveCount(0);
    await expect(
      page.getByText(`$${STORE_FIXTURE.device.price.toFixed(2)}`),
    ).toHaveCount(0);
  });

  test("cannot reach the merchant's page, so cannot build one either", async ({
    page,
  }) => {
    await page.goto(`/merchants/${merchant.merchantId}`);
    await expect(page.getByText(/We couldn.t find that/)).toBeVisible();
    // No panel, so no builder. The database would refuse the write anyway —
    // the insert policy's merchant branch mirrors the merchants select policy
    // — but the page never offers it.
    await expect(
      page.getByRole("heading", { name: "Hardware proposals", exact: true }),
    ).toHaveCount(0);
  });
});

test.describe("the store at every width a rep uses", () => {
  test.use({ storageState: storageStateFor("agent") });

  // 375 is a phone, 768 is the breakpoint where the pinned sidebar takes its
  // 248px back (so the content is NARROWER than at 767 — see list-table.tsx),
  // and 1440 is a desk.
  for (const width of [375, 768, 1440]) {
    test(`does not overflow horizontally at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const panel = await openBuilder(page, `/leads/${agentLeadId}`);

      // A cart with a device and an add-on, which is the widest the component
      // gets: two rows of controls plus a money column.
      await panel
        .getByRole("button", { name: `Add ${STORE_FIXTURE.device.name}` })
        .click();
      await panel
        .getByRole("button", {
          name: `Add ${STORE_FIXTURE.fittingAddon.name} to ${STORE_FIXTURE.device.name}`,
        })
        .click();
      await expect(cartRow(panel, STORE_FIXTURE.fittingAddon.name)).toBeVisible();

      // scrollWidth > clientWidth on the DOCUMENT, which is the assertion the
      // StatCard clipping bug taught: a bounding box is constrained by its
      // parent, so the ink overflows while getBoundingClientRect reports the
      // parent's width unchanged. The page body must never scroll sideways.
      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(
        overflow.scrollWidth,
        `the page scrolls sideways at ${width}px`,
      ).toBeLessThanOrEqual(overflow.clientWidth);

      // And every control is reachable, which is the thing a stacked layout
      // can get wrong while the page itself fits.
      await expect(
        panel.getByRole("button", {
          name: `Increase quantity of ${STORE_FIXTURE.device.name}`,
        }),
      ).toBeVisible();
      await expect(
        panel.getByRole("button", { name: "Save proposal" }),
      ).toBeVisible();
    });
  }
});
