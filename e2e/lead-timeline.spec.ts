import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  TIMELINE_FIXTURE,
  seedE2E,
  storageStateFor,
  type TimelineFixture,
} from "./fixtures/seed";

/**
 * The lead timeline, and specifically WHAT EACH ROLE SEES OF IT.
 *
 * ## Why this is in e2e and not in tests/rls
 *
 * The merge and the ordering are pure and are tested in
 * tests/unit/timeline.test.ts, where ties and offsets can be constructed
 * exactly. The per-table policies are tested in tests/rls. Neither of those can
 * see the thing this file is about: the feed is assembled from SIX sources read
 * under SIX different policies and then flattened into one list, and whether
 * the flattening leaks is a question about the rendered page.
 *
 * Concretely, `audit_log`'s only select policy is:
 *
 *     create policy "admin reads audit log" on audit_log
 *       for select using (is_admin());
 *
 * No own-row branch, so an agent reads ZERO audit rows — on their own lead as
 * much as anyone else's — while `grant select on audit_log to authenticated`
 * means the query succeeds and simply returns nothing. An RLS test proves that
 * about the table. It cannot prove that the lead page, having merged five
 * readable sources with one unreadable one, does not reach past it: a
 * `security definer` helper, a service-role client or a `supabaseAdmin` slip
 * anywhere in the chain would make every assertion here fail and none of the
 * RLS tests notice.
 *
 * ## The claim, stated as the spec asserts it
 *
 * On ONE lead, loaded by two real sessions:
 *
 *   * the owning rep sees five kinds of event and no "Admin trail" row at all;
 *   * an admin sees the same five, in the same order, PLUS the admin trail,
 *     attributed by name;
 *   * and the five the rep sees are IDENTICAL to the five the admin sees.
 *
 * That last one is why the cross-read exists rather than two independent
 * assertions. "The admin sees more" is also true of a feed that showed the two
 * roles unrelated things, and a scoping bug that dropped one of the rep's own
 * rows would pass a test that only counted admin-trail entries.
 *
 * ## No hardcoded counts of anything the suite does not own
 *
 * Every number here is a count of rows this fixture creates — one per source,
 * on a lead nothing else in the suite touches. See TimelineFixture for why it
 * is a dedicated lead: the agent's main lead has a marketing-event clear in
 * another spec and an audit trail that grows by one row per run of the seed.
 */

let timeline: TimelineFixture;

test.beforeAll(async () => {
  ({ timeline } = await seedE2E());
});

/** The timeline's own <section>, located by its heading rather than position. */
function timelineOf(page: Page): Locator {
  return page
    .getByRole("heading", { name: "Timeline", exact: true })
    .locator("xpath=ancestor::section[1]");
}

/**
 * The source chip of every row, in rendered order.
 *
 * textContent, NOT innerText: the chip is styled `uppercase`, and innerText
 * reflects rendering, so it would come back "ADMIN TRAIL" and couple the
 * assertion to a CSS property that has nothing to do with the claim.
 */
async function sourcesIn(timeline: Locator): Promise<string[]> {
  return (await timeline.locator("li > span").allTextContents()).map((s) =>
    s.trim(),
  );
}

/** One row, found by the source chip and a string only that row carries. */
function row(timeline: Locator, source: string, text: string): Locator {
  return timeline.locator("li").filter({ hasText: source }).filter({ hasText: text });
}

/**
 * The five sources every reader of this lead can see, newest first.
 *
 * The order is the seed's write order read backwards, and it is asserted rather
 * than sampled because it is the one thing a merge can get wrong while every
 * individual row looks perfect.
 */
const SHARED_SOURCES = ["Quote", "Marketing", "Document", "Task", "Note"];

test.describe("as the owning rep", () => {
  test.use({ storageState: storageStateFor("agent") });

  test("shows every source the rep can read, newest first", async ({ page }) => {
    await page.goto(`/leads/${timeline.leadId}`);

    const feed = timelineOf(page);
    await expect(feed).toBeVisible();

    expect(await sourcesIn(feed)).toEqual(SHARED_SOURCES);

    // And the rows are the fixture's own, not five of something else.
    await expect(row(feed, "Note", TIMELINE_FIXTURE.noteBody)).toBeVisible();
    await expect(row(feed, "Task", TIMELINE_FIXTURE.taskTitle)).toBeVisible();
    await expect(
      row(feed, "Document", TIMELINE_FIXTURE.docFileName),
    ).toBeVisible();
    await expect(row(feed, "Quote", TIMELINE_FIXTURE.quoteTitle)).toBeVisible();
  });

  test("omits the admin trail entirely, and says nothing about the gap", async ({
    page,
  }) => {
    await page.goto(`/leads/${timeline.leadId}`);
    const feed = timelineOf(page);
    await expect(feed).toBeVisible();

    // The load-bearing assertion of this file. Two admin writes exist on this
    // lead and its quote — the seed makes them through a real admin JWT — and
    // the rep must see neither.
    await expect(feed.locator("li").filter({ hasText: "Admin trail" })).toHaveCount(
      0,
    );
    await expect(feed.getByText("Record updated")).toHaveCount(0);
    await expect(feed.getByText(TIMELINE_FIXTURE.adminLeadSource)).toHaveCount(0);

    // Nothing anywhere on the page advertises that something was withheld. A
    // permanent notice would be wallpaper on every lead; a conditional one
    // would announce that an admin had touched this record, which is exactly
    // what the admin-only policy conceals.
    await expect(page.getByText(/admin.{0,20}only/i)).toHaveCount(0);
    await expect(page.getByText(/hidden|withheld|not shown/i)).toHaveCount(0);
  });

  test("links a quote entry to THAT version, not to whatever is current", async ({
    page,
  }) => {
    await page.goto(`/leads/${timeline.leadId}`);
    const feed = timelineOf(page);

    // The bare group URL prints whatever is current now, so a v1 row pointing
    // at it would show a later version's figures under v1's date.
    await expect(
      row(feed, "Quote", TIMELINE_FIXTURE.quoteTitle).getByRole("link"),
    ).toHaveAttribute(
      "href",
      `/leads/${timeline.leadId}/quotes/${timeline.quoteGroupId}/print?quote=${timeline.quoteId}`,
    );
  });

  test("gives a rep their own byline, and none to a document", async ({
    page,
  }) => {
    await page.goto(`/leads/${timeline.leadId}`);
    const feed = timelineOf(page);

    // `profiles` is own-row-or-admin, so a rep resolves exactly one name:
    // their own. The note is theirs, so it is bylined.
    await expect(row(feed, "Note", TIMELINE_FIXTURE.noteBody)).toContainText(
      "E2E Agent",
    );

    // The document is NOT, and that is the design rather than a miss.
    // documents.agent_id is the parent record's owner, so an admin uploading
    // on a rep's lead lands a row stamped with the REP's id — printing it
    // would attribute somebody else's upload to this rep.
    await expect(
      row(feed, "Document", TIMELINE_FIXTURE.docFileName),
    ).not.toContainText("E2E Agent");
  });
});

test.describe("as an admin on the same lead", () => {
  test.use({ storageState: storageStateFor("admin") });

  test("sees the rep's five sources and the admin trail as well", async ({
    page,
  }) => {
    await page.goto(`/leads/${timeline.leadId}`);

    const feed = timelineOf(page);
    await expect(feed).toBeVisible();

    // Two admin writes, both newer than everything the seed wrote as the
    // service role, so they lead the feed. The quote edit is last-written and
    // therefore first.
    expect(await sourcesIn(feed)).toEqual([
      "Admin trail",
      "Admin trail",
      ...SHARED_SOURCES,
    ]);
  });

  test("resolves the audit row's table, so a quote edit is not filed as a lead edit", async ({
    page,
  }) => {
    await page.goto(`/leads/${timeline.leadId}`);
    const feed = timelineOf(page);

    // audit_log.row_id is TEXT and ids collide across tables, so the pair is
    // what identifies a row. Two admin-trail entries, each naming the record
    // it is actually about.
    await expect(row(feed, "Admin trail", "This lead")).toBeVisible();
    await expect(row(feed, "Admin trail", "Quote version 1")).toBeVisible();

    // The quote one links to the version it is about, like the quote entry.
    await expect(
      row(feed, "Admin trail", "Quote version 1").getByRole("link"),
    ).toHaveAttribute(
      "href",
      `/leads/${timeline.leadId}/quotes/${timeline.quoteGroupId}/print?quote=${timeline.quoteId}`,
    );
  });

  test("attributes the trail by name, and states the act without naming a role", async ({
    page,
  }) => {
    await page.goto(`/leads/${timeline.leadId}`);
    const feed = timelineOf(page);

    const adminRows = feed.locator("li").filter({ hasText: "Admin trail" });
    await expect(adminRows).toHaveCount(2);

    for (const text of ["This lead", "Quote version 1"]) {
      const entry = row(feed, "Admin trail", text);
      // The byline carries WHO. An admin resolves every name, because the
      // profiles select policy is own-row plus admin.
      await expect(entry).toContainText("E2E Admin");
      // The title carries WHAT, and deliberately does not say "by an
      // administrator": the trigger fires whenever the actor is not the row's
      // owner, which includes a service-role write with no actor at all.
      await expect(entry).toContainText("Record updated");
    }
  });

  test("shows the rep EXACTLY the same five rows it shows itself", async ({
    page,
    browser,
  }) => {
    // The cross-read, and the reason this is one test rather than two. "The
    // admin sees more" is also true of a feed that showed the two roles
    // unrelated things, and a bug that dropped one of the rep's own rows would
    // pass any assertion that only counted admin-trail entries.
    await page.goto(`/leads/${timeline.leadId}`);
    const adminFeed = timelineOf(page);
    await expect(adminFeed).toBeVisible();

    const repContext = await browser.newContext({
      storageState: storageStateFor("agent"),
    });
    try {
      const repPage = await repContext.newPage();
      await repPage.goto(`/leads/${timeline.leadId}`);
      const repFeed = timelineOf(repPage);
      await expect(repFeed).toBeVisible();

      const adminSources = await sourcesIn(adminFeed);
      const repSources = await sourcesIn(repFeed);

      // Identical once the admin-only rows are removed: same sources, same
      // order, nothing of the rep's own missing from either view.
      expect(adminSources.filter((s) => s !== "Admin trail")).toEqual(
        repSources,
      );
      expect(repSources).not.toContain("Admin trail");
      expect(adminSources.length).toBe(repSources.length + 2);

      // And the shared rows carry the same text in both, which a feed that
      // merely happened to produce five chips each would not.
      for (const text of [
        TIMELINE_FIXTURE.noteBody,
        TIMELINE_FIXTURE.taskTitle,
        TIMELINE_FIXTURE.docFileName,
        TIMELINE_FIXTURE.quoteTitle,
      ]) {
        await expect(repFeed.getByText(text, { exact: false })).toBeVisible();
        await expect(adminFeed.getByText(text, { exact: false })).toBeVisible();
      }
    } finally {
      await repContext.close();
    }
  });
});
