import { expect, test, type Page } from "@playwright/test";

import {
  PERSONAS,
  STORE_FIXTURE,
  clearProposalsForCustomer,
  clearProposalsTitled,
  proposalRows,
  proposalsForLead,
  seedE2E,
  seedStandaloneProposal,
  storageStateFor,
  type SeedResult,
} from "./fixtures/seed";

/**
 * Proposals as their own page: /proposals, /proposals/new,
 * /proposals/[quoteGroupId] and its /print.
 *
 * The access rules (rep sees own, admin sees all, rep cannot create for
 * another rep, at most one link, a required customer name, one RPC overload)
 * are pinned in tests/rls/proposals.test.ts against real policies. What is
 * here is what only a browser shows: that the pages actually drive those
 * rules end to end, and that each claim is checked against the TABLES as well
 * as the page — a page that rendered the right proposal while writing another
 * would look identical.
 *
 * Customer names and titles are unique to this file and cleared before and
 * after, so an aborted run cannot leave a row the next run trips on.
 */

const STANDALONE = "E2E Walk-in Bakery";
const AGENT2_CUSTOMER = "E2E Agent2 Corner Shop";
const FROM_LEAD_TITLE = "E2E From-lead proposal";

/** A saved proposal's page, by its group uuid. */
const PROPOSAL_URL = /\/proposals\/[0-9a-f-]{36}$/;

let seeded: SeedResult;
let agent2Group = "";

test.beforeAll(async () => {
  seeded = await seedE2E();
  await clearProposalsForCustomer(STANDALONE);
  await clearProposalsForCustomer(AGENT2_CUSTOMER);
  await clearProposalsTitled(FROM_LEAD_TITLE);
  agent2Group = await seedStandaloneProposal(seeded.ids.agent2, AGENT2_CUSTOMER);
});

test.afterAll(async () => {
  await clearProposalsForCustomer(STANDALONE);
  await clearProposalsForCustomer(AGENT2_CUSTOMER);
  await clearProposalsTitled(FROM_LEAD_TITLE);
});

const builder = (page: Page) => page.getByTestId("proposal-builder");

async function addDeviceWithAddon(page: Page) {
  const b = builder(page);
  await b.getByRole("button", { name: `Add ${STORE_FIXTURE.device.name}` }).click();
  await b
    .getByRole("button", {
      name: `Add ${STORE_FIXTURE.fittingAddon.name} to ${STORE_FIXTURE.device.name}`,
    })
    .click();
}

const notFoundCopy = (page: Page) => page.getByText(/We couldn.t find that/);

test.describe("a rep", () => {
  test.use({ storageState: storageStateFor("agent") });
  test.describe.configure({ mode: "serial" });

  test("has Proposals in the Sales nav", async ({ page }) => {
    await page.goto("/dashboard");
    await page.getByRole("link", { name: "Proposals", exact: true }).click();
    await expect(page).toHaveURL(/\/proposals$/);
    await expect(
      page.getByRole("heading", { name: "Proposals", level: 1 }),
    ).toBeVisible();
  });

  test("makes a standalone proposal for a typed customer, revises it to v2, and prints it", async ({
    page,
  }) => {
    await page.goto("/proposals");
    await page.getByRole("link", { name: "New proposal" }).click();
    await expect(page).toHaveURL(/\/proposals\/new$/);

    await page.getByLabel("Not in the CRM — type a name").check();
    await page.getByLabel("Customer name", { exact: true }).fill(STANDALONE);
    await addDeviceWithAddon(page);
    await builder(page).getByRole("button", { name: "Save proposal" }).click();

    await page.waitForURL(PROPOSAL_URL);
    const proposalUrl = page.url();
    await expect(page.getByRole("heading", { name: STANDALONE, level: 1 })).toBeVisible();
    await expect(page.getByText("Not linked to a lead or merchant")).toBeVisible();
    await expect(page.getByText("Version 1 of 1")).toBeVisible();
    const totals = page.getByTestId("proposal-totals");
    await expect(totals).toContainText("$400.00");
    await expect(totals).toContainText("$25.00");

    // Revise: a NEW version, the old one untouched.
    await page.getByRole("button", { name: "Revise" }).click();
    await builder(page)
      .getByRole("button", {
        name: `Increase quantity of ${STORE_FIXTURE.device.name}`,
      })
      .click();
    await builder(page).getByRole("button", { name: "Save new version" }).click();
    await expect(page.getByText("Version 2 of 2")).toBeVisible();
    await expect(totals).toContainText("$800.00");

    // The tables, not just the page: two versions of one group, unlinked,
    // named as typed, and the rep's own.
    const rows = await proposalRows(STANDALONE);
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
    expect(new Set(rows.map((r) => r.quote_group_id)).size).toBe(1);
    for (const row of rows) {
      expect(row.lead_id).toBeNull();
      expect(row.merchant_id).toBeNull();
      expect(row.agent_id).toBe(seeded.ids.agent);
    }
    expect(proposalUrl).toContain(rows[0].quote_group_id);

    // Print the current version through the page's own link.
    await page.getByRole("link", { name: "Print", exact: true }).click();
    await page.waitForURL(/\/proposals\/[0-9a-f-]{36}\/print$/);
    const sheet = page.getByRole("article");
    await expect(
      page.getByRole("heading", { name: "Hardware Proposal", exact: true }),
    ).toBeVisible();
    await expect(sheet.getByText("Prepared for")).toBeVisible();
    await expect(sheet.getByText(STANDALONE)).toBeVisible();
    await expect(sheet.getByText(/Version 2 of 2/)).toBeVisible();
    await expect(sheet.getByText(PERSONAS.agent.fullName)).toBeVisible();

    // And the past version, from the history, marked superseded.
    await page.goto(proposalUrl);
    await page
      .getByTestId("proposal-version-1")
      .getByRole("link", { name: "Print this version" })
      .click();
    await expect(page).toHaveURL(new RegExp(`/print\\?quote=${rows[0].id}$`));
    await expect(page.getByText(/Version 1 of 2/)).toBeVisible();
    await expect(page.getByText(/Superseded/)).toBeVisible();
  });

  test("starts one from a lead's New proposal button, with the customer prefilled", async ({
    page,
  }) => {
    const leadId = seeded.docOwners.agent.lead;
    await page.goto(`/leads/${leadId}`);
    const leadName = (
      await page.getByRole("heading", { level: 1 }).textContent()
    )?.trim();
    expect(leadName).toBeTruthy();

    await page.getByRole("link", { name: "New proposal" }).click();
    await expect(page).toHaveURL(new RegExp(`/proposals/new\\?lead=${leadId}$`));
    await expect(page.getByTestId("chosen-customer")).toHaveText(leadName!);

    await builder(page).getByLabel("Title").fill(FROM_LEAD_TITLE);
    await addDeviceWithAddon(page);
    await builder(page).getByRole("button", { name: "Save proposal" }).click();
    await page.waitForURL(PROPOSAL_URL);
    const proposalUrl = page.url();
    await expect(page.getByRole("link", { name: `Lead: ${leadName}` })).toBeVisible();

    // Linked to that lead, named from it, and the rep's.
    const linked = (await proposalsForLead(leadId)).filter(
      (p) => p.title === FROM_LEAD_TITLE,
    );
    expect(linked).toHaveLength(1);
    expect(linked[0].customer_name).toBe(leadName);
    expect(linked[0].agent_id).toBe(seeded.ids.agent);

    // And it appears in the lead's compact list, linking back to /proposals.
    await page.goto(`/leads/${leadId}`);
    await page.getByRole("link", { name: new RegExp(FROM_LEAD_TITLE) }).click();
    await expect(page).toHaveURL(proposalUrl);
  });

  test("lists only their own proposals, with no rep filter", async ({ page }) => {
    await page.goto("/proposals");
    await expect(page.getByRole("link", { name: STANDALONE })).toBeVisible();
    await expect(page.getByText(AGENT2_CUSTOMER)).toHaveCount(0);
    await expect(page.getByLabel("Rep", { exact: true })).toHaveCount(0);

    // The search narrows by customer.
    await page.getByLabel("Search", { exact: true }).fill("walk-in bakery");
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByRole("link", { name: STANDALONE })).toBeVisible();
    await page.getByLabel("Search", { exact: true }).fill("zzzz-nothing");
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByText("No proposal matches that search.")).toBeVisible();
  });

  test("gets the not-found page for another rep's proposal, on both routes", async ({
    page,
  }) => {
    for (const path of [
      `/proposals/${agent2Group}`,
      `/proposals/${agent2Group}/print`,
    ]) {
      await page.goto(path);
      // Asserted on what renders: under cacheComponents a streamed notFound()
      // arrives as 200 with not-found content (see e2e/print.spec.ts).
      await expect(notFoundCopy(page)).toBeVisible();
      await expect(page.getByText(AGENT2_CUSTOMER)).toHaveCount(0);
      await expect(
        page.getByRole("heading", { name: "Hardware Proposal", exact: true }),
      ).toHaveCount(0);
    }
  });

  test("is redirected from the old per-record print URLs, version param kept", async ({
    page,
  }) => {
    const { quote, merchantProposal } = seeded;
    await page.goto(
      `/leads/${quote.leadId}/quotes/${quote.groupId}/print?quote=${quote.firstId}`,
    );
    await expect(page).toHaveURL(
      new RegExp(`/proposals/${quote.groupId}/print\\?quote=${quote.firstId}$`),
    );
    await expect(page.getByText(/Version 1 of 2/)).toBeVisible();

    await page.goto(
      `/merchants/${merchantProposal.merchantId}/quotes/${merchantProposal.groupId}/print`,
    );
    await expect(page).toHaveURL(
      new RegExp(`/proposals/${merchantProposal.groupId}/print$`),
    );
    await expect(
      page.getByRole("heading", { name: "Hardware Proposal", exact: true }),
    ).toBeVisible();
  });
});

test.describe("an admin", () => {
  test.use({ storageState: storageStateFor("admin") });

  test("sees every rep's proposals and filters by rep", async ({ page }) => {
    // Its own unlinked proposal for the agent, so this does not depend on the
    // rep describe having run first.
    const mine = "E2E Admin-view Agent Shop";
    await clearProposalsForCustomer(mine);
    await seedStandaloneProposal(seeded.ids.agent, mine);
    try {
      await page.goto("/proposals");
      await expect(page.getByRole("link", { name: mine })).toBeVisible();
      await expect(page.getByRole("link", { name: AGENT2_CUSTOMER })).toBeVisible();
      // The Rep column names who each is for.
      await expect(
        page.getByRole("row", { name: new RegExp(AGENT2_CUSTOMER) }),
      ).toContainText(PERSONAS.agent2.fullName);

      await page.getByLabel("Rep", { exact: true }).selectOption({ label: PERSONAS.agent2.fullName });
      await page.getByRole("button", { name: "Apply" }).click();
      await expect(page).toHaveURL(new RegExp(`rep=${seeded.ids.agent2}`));
      await expect(page.getByRole("link", { name: AGENT2_CUSTOMER })).toBeVisible();
      await expect(page.getByRole("link", { name: mine })).toHaveCount(0);
    } finally {
      await clearProposalsForCustomer(mine);
    }
  });
});
