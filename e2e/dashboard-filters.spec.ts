import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  PERSONAS,
  TASK_FIXTURE,
  TERRITORIES,
  seedE2E,
  storageStateFor,
} from "./fixtures/seed";

/**
 * The dashboard's filter bar, and the one thing it must not touch.
 *
 * ## What is covered here, and what is covered in tests/rls
 *
 * tests/rls/dashboard-filters.test.ts owns the SEMANTICS — that the filters add
 * no reach, that an agent passing another rep's id gets zeros, that a manager's
 * team and a territory are different sets, that prosecdef is false. Those are
 * faster and far more precise there, against three distinct fixture sets, and a
 * browser copy would be a slower, vaguer duplicate.
 *
 * What only a browser can answer is the WIRING:
 *
 *   * does the select actually submit the parameter the server parses,
 *   * does the page re-read it and re-render the figures,
 *   * do the stage chips preserve the other five filters rather than dropping
 *     them (a link-vs-form interaction that exists nowhere else in the app),
 *   * is the admin-only half of the bar genuinely absent for a rep,
 *   * and does the "Your tasks" digest stay put while every figure above it
 *     goes to zero.
 *
 * ## How the filters are checked without asserting a single hardcoded number
 *
 * Counts in the dev database move: the live suite writes to the same stack, and
 * other specs here create records. So nothing below says "expect 3". Each
 * filter is checked by CROSS-READING — an admin filtering by one rep must see
 * exactly what that rep sees on their own dashboard, which this suite can load,
 * because it holds a storage state for them. That is both robust and a sharper
 * claim than a constant: it says the filter selects the same rows the policy
 * would.
 */

/** The five (or six) figures on the stat row, label -> value, as rendered. */
async function statRow(page: Page): Promise<Record<string, string>> {
  const cards = page.locator('[data-slot="stat-card"]');
  await expect(cards.first()).toBeVisible();

  const entries = await cards.evaluateAll((nodes) =>
    nodes.map((node) => {
      const paragraphs = node.querySelectorAll("p");
      return [
        paragraphs[0]?.textContent?.trim() ?? "",
        paragraphs[paragraphs.length - 1]?.textContent?.trim() ?? "",
      ] as [string, string];
    }),
  );
  return Object.fromEntries(entries);
}

/** The filter bar, located by its heading rather than by position. */
function filterBar(page: Page): Locator {
  return page
    .getByRole("heading", { name: /^(Company|Your) overview$/ })
    .locator("xpath=ancestor::section[1]");
}

let ids: Record<string, string>;

test.beforeAll(async () => {
  ({ ids } = await seedE2E());
});

test.describe("only an admin gets the rep, manager and territory controls", () => {
  test.describe("as a rep", () => {
    test.use({ storageState: storageStateFor("agent") });

    test("sees the date range and the stage chips but no people controls", async ({
      page,
    }) => {
      await page.goto("/dashboard");
      const bar = filterBar(page);

      // Useful over their own book, so these are for everyone.
      await expect(bar.getByLabel("Created from")).toBeVisible();
      await expect(bar.getByLabel("Created to")).toBeVisible();
      await expect(bar.getByRole("link", { name: "Qualified" })).toBeVisible();

      // Not offered, because for a rep every setting of them is either their
      // own numbers again or an empty page — dashboard_counts() is security
      // invoker, so the filter cannot widen anything. tests/rls asserts that
      // directly; this asserts we do not show a control that can only disappoint.
      await expect(bar.getByLabel("Rep")).toHaveCount(0);
      await expect(bar.getByLabel("Manager")).toHaveCount(0);
      await expect(bar.getByLabel("Territory")).toHaveCount(0);
    });
  });

  test.describe("as an admin", () => {
    test.use({ storageState: storageStateFor("admin") });

    test("gets all three, populated from profiles", async ({ page }) => {
      await page.goto("/dashboard");
      const bar = filterBar(page);

      await expect(
        bar.getByLabel("Rep").getByRole("option", { name: PERSONAS.agent.fullName, exact: true }),
      ).toHaveCount(1);

      // The manager list is built from the manager_id values actually in use,
      // not from every profile: the agent reports to agent2, so agent2 is a
      // manager and the agent is not. A list of everyone would offer options
      // whose every result is zero.
      await expect(
        bar
          .getByLabel("Manager")
          .getByRole("option", { name: PERSONAS.agent2.fullName, exact: true }),
      ).toHaveCount(1);
      await expect(
        bar
          .getByLabel("Manager")
          .getByRole("option", { name: PERSONAS.agent.fullName, exact: true }),
      ).toHaveCount(0);

      await expect(
        bar
          .getByLabel("Territory")
          .getByRole("option", { name: TERRITORIES.agent2, exact: true }),
      ).toHaveCount(1);
    });
  });
});

test.describe("an admin filtering a view they already had in full", () => {
  test.use({ storageState: storageStateFor("admin") });

  test("narrowing to one rep shows exactly what that rep sees", async ({
    page,
    browser,
  }) => {
    await page.goto("/dashboard");
    const unfiltered = await statRow(page);

    await filterBar(page).getByLabel("Rep").selectOption(ids.agent);
    await filterBar(page).getByRole("button", { name: "Apply" }).click();
    await expect(page).toHaveURL(new RegExp(`rep=${ids.agent}`));
    const filtered = await statRow(page);

    // The cross-read: the same rep's own dashboard, loaded as them. Equal
    // figures mean the filter selected the rows the policy would have, which no
    // hardcoded constant could claim.
    const repContext = await browser.newContext({
      storageState: storageStateFor("agent"),
    });
    const repPage = await repContext.newPage();
    await repPage.goto("/dashboard");
    const repOwn = await statRow(repPage);
    await repContext.close();

    expect(filtered).toEqual(repOwn);
    // And it actually narrowed something, so the assertion above is not two
    // identical readings of an unfiltered page.
    expect(filtered).not.toEqual(unfiltered);
  });

  test("narrowing to a territory shows that territory's rep", async ({
    page,
    browser,
  }) => {
    await page.goto("/dashboard");
    const unfiltered = await statRow(page);

    await filterBar(page)
      .getByLabel("Territory")
      .selectOption(TERRITORIES.agent2);
    await filterBar(page).getByRole("button", { name: "Apply" }).click();
    const filtered = await statRow(page);

    // agent2 is alone in that territory, so the same cross-read applies — and
    // this one cannot be satisfied by a page that quietly ignored the parameter,
    // because the unfiltered figures are a different set.
    const otherContext = await browser.newContext({
      storageState: storageStateFor("agent2"),
    });
    const otherPage = await otherContext.newPage();
    await otherPage.goto("/dashboard");
    const otherOwn = await statRow(otherPage);
    await otherContext.close();

    expect(filtered).toEqual(otherOwn);
    expect(filtered).not.toEqual(unfiltered);
  });

  test("narrowing to a manager shows their reports", async ({
    page,
    browser,
  }) => {
    await page.goto("/dashboard");
    const unfiltered = await statRow(page);

    await filterBar(page).getByLabel("Manager").selectOption(ids.agent2);
    await filterBar(page).getByRole("button", { name: "Apply" }).click();
    await expect(page).toHaveURL(new RegExp(`manager=${ids.agent2}`));
    const filtered = await statRow(page);

    // The agent is agent2's only report, so this reads as the agent's own book.
    // That makes it indistinguishable HERE from the rep filter — deliberately
    // not worked around, because the fixture would need a second report to
    // separate them and the separation is already proved three ways in
    // tests/rls/dashboard-filters.test.ts, against sets chosen so that the
    // manager, territory and rep filters produce different numbers. What this
    // spec is for is that the select submits `manager=` and the page reads it.
    const repContext = await browser.newContext({
      storageState: storageStateFor("agent"),
    });
    const repPage = await repContext.newPage();
    await repPage.goto("/dashboard");
    const repOwn = await statRow(repPage);
    await repContext.close();

    expect(filtered).toEqual(repOwn);
    expect(filtered).not.toEqual(unfiltered);
  });

  test("a date range in the past empties every figure", async ({ page }) => {
    await page.goto("/dashboard?from=2020-01-01&to=2020-01-02");

    const row = await statRow(page);
    // Every card, not just one: a date filter applied to the leads count and
    // forgotten on the other four would pass a narrower assertion.
    for (const [label, value] of Object.entries(row)) {
      expect(value, `${label} should be empty for a range before the fixtures`).toBe(
        "0",
      );
    }
  });

  test("keeps the other filters when a stage chip is clicked", async ({
    page,
  }) => {
    // The one interaction in the app where a link and a form share a filter
    // set. The chips are links built by dashboardHref, the selects are a GET
    // form — so a chip that forgot to carry `rep` would silently widen the page
    // back to the whole company while looking like it only changed the stage.
    await page.goto(`/dashboard?rep=${ids.agent}`);
    const repOnly = await statRow(page);

    await filterBar(page).getByRole("link", { name: "Qualified" }).click();
    await expect(page).toHaveURL(new RegExp(`rep=${ids.agent}`));
    await expect(page).toHaveURL(/stage=qualified/);

    // The five original cards are unchanged — a stage narrows leads_at_stage
    // and nothing else — which also proves the rep filter survived the hop.
    const withStage = await statRow(page);
    for (const label of Object.keys(repOnly)) {
      expect(withStage[label], `${label} moved when only the stage changed`).toBe(
        repOnly[label],
      );
    }
  });

  test("shows a stage card only when a stage was asked for", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    expect(Object.keys(await statRow(page))).not.toContain(
      "Leads at qualified",
    );

    await page.goto("/dashboard?stage=qualified");
    const row = await statRow(page);
    // Its own card rather than a filtered "Unconverted leads", because the two
    // are different facts — see the leads_at_stage note in the migration.
    expect(Object.keys(row)).toContain("Leads at qualified");
    expect(Object.keys(row)).toContain("Unconverted leads");
  });

  test("offers a way back out, and only while there is one", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    await expect(
      filterBar(page).getByRole("link", { name: "Clear filters" }),
    ).toHaveCount(0);

    await page.goto(`/dashboard?rep=${ids.agent}&stage=qualified`);
    await filterBar(page).getByRole("link", { name: "Clear filters" }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
  });
});

test.describe("the filters do not reach the task digest", () => {
  test.use({ storageState: storageStateFor("agent") });

  test("leaves 'Your tasks' alone while every figure above it goes to zero", async ({
    page,
  }) => {
    // The separation claim, made the only way that is worth anything: pick a
    // filter that demonstrably empties the overview, then show the digest did
    // not move. DashboardTasks reads profile.id and never searchParams, and
    // sits in its own Suspense boundary outside DashboardOverview — this is
    // what makes that structural rather than a promise in a comment.
    await page.goto("/dashboard");
    await expect(
      page.getByText(TASK_FIXTURE.overdue.title),
    ).toBeVisible();

    await page.goto("/dashboard?from=2020-01-01&to=2020-01-02");

    for (const [label, value] of Object.entries(await statRow(page))) {
      expect(value, `${label} should be empty`).toBe("0");
    }

    await expect(
      page.getByText(TASK_FIXTURE.overdue.title),
      "the digest emptied with the overview",
    ).toBeVisible();
    await expect(
      page.getByText("Not affected by the filters above"),
    ).toBeVisible();
  });
});
