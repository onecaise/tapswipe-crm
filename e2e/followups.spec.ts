import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  TASK_FIXTURE,
  leadFollowupDate,
  seedE2E,
  storageStateFor,
  type TaskFixture,
} from "./fixtures/seed";

/**
 * The two surfaces that reconcile `leads.next_followup_date` with the generic
 * `tasks` table: the dashboard digest, and the one-click affordance on a lead.
 *
 * The two columns stay separate on purpose — `tasks.owner_id` carries no
 * foreign key, so a lead cannot embed its tasks, and collapsing them would cost
 * the leads list its single indexed query for "order by next follow-up, show
 * overdue". The accepted cost is that the two can drift. Both features here
 * exist to make that drift visible, which is the thing worth testing.
 *
 * ## Why either of them is in e2e rather than in one of the other three suites
 *
 * The digest's scoping is enforced by an `.eq("agent_id", …)` in application
 * code, NOT by a policy, so no RLS test can see it: RLS hands an admin every
 * task in the database and is right to. What the digest promises is NARROWER
 * than what the policy allows, and the rendered page is the only place that
 * promise exists to be checked at all.
 *
 * The affordance is a client write followed by `router.refresh()`. Whether the
 * click reaches the column, and whether the page then agrees with the column,
 * are two different questions — and a component that only ever re-rendered its
 * own optimistic state would answer the second one identically. Hence the two
 * assertions on every write below: one on the page, one on the row.
 */

/** The digest's own <section>, located by its heading rather than by position. */
function digestOf(page: Page): Locator {
  return page
    .getByRole("heading", { name: "Your tasks" })
    .locator("xpath=ancestor::section[1]");
}

let tasks: TaskFixture;

test.beforeAll(async () => {
  ({ tasks } = await seedE2E());
});

test.describe("the dashboard task digest", () => {
  test.describe("as the owning rep", () => {
    test.use({ storageState: storageStateFor("agent") });

    test("splits the rep's own overdue and upcoming work", async ({ page }) => {
      await page.goto("/dashboard");

      const digest = digestOf(page);
      await expect(digest).toBeVisible();

      const overdueGroup = digest
        .getByRole("heading", { name: /^Overdue \(/ })
        .locator("xpath=following-sibling::ul[1]");
      const upcomingGroup = digest
        .getByRole("heading", { name: /^Due in the next 7 days \(/ })
        .locator("xpath=following-sibling::ul[1]");

      await expect(
        overdueGroup.getByText(TASK_FIXTURE.overdue.title),
      ).toBeVisible();
      await expect(
        upcomingGroup.getByText(TASK_FIXTURE.upcoming.title),
      ).toBeVisible();

      // And NOT in the other group, which is the half that makes this a test of
      // the SPLIT rather than of the two titles. The first draft stopped at the
      // two assertions above and passed with the split reverted: a digest that
      // files every row under Overdue still has the upcoming task under "Due in
      // the next 7 days" as well, so both lookups succeed while the Overdue
      // heading has quietly become a lie.
      await expect(
        overdueGroup.getByText(TASK_FIXTURE.upcoming.title),
        "a task due in two days is filed as overdue",
      ).toHaveCount(0);
      await expect(
        upcomingGroup.getByText(TASK_FIXTURE.overdue.title),
        "an overdue task is filed as merely upcoming",
      ).toHaveCount(0);
    });

    test("leaves out work that is neither overdue nor due this week", async ({
      page,
    }) => {
      await page.goto("/dashboard");
      const digest = digestOf(page);
      await expect(digest).toBeVisible();

      // Two rows, each failing a different filter. `distant` is open and dated
      // but sixty days out, so only the window excludes it; `done` is dated
      // nine days ago, so only the `completed` filter does. A digest that lost
      // either filter shows one of these and keeps passing the test above.
      await expect(
        digest.getByText(TASK_FIXTURE.distant.title),
        "a task due in 60 days is not 'upcoming'",
      ).toHaveCount(0);
      await expect(
        digest.getByText(TASK_FIXTURE.done.title),
        "a completed task is not outstanding work",
      ).toHaveCount(0);
    });

    test("links each task to the record that owns it", async ({ page }) => {
      await page.goto("/dashboard");

      // owner_id carries no foreign key, so this href is resolved in
      // application code off an (owner_type, owner_id) pair — and a lead and a
      // merchant really do share ids here, which is exactly how such a link
      // comes to point at the wrong record while looking perfectly healthy.
      const row = digestOf(page)
        .getByText(TASK_FIXTURE.overdue.title)
        .locator("xpath=ancestor::li[1]");
      await expect(row.getByRole("link", { name: /^Lead · / })).toHaveAttribute(
        "href",
        `/leads/${tasks.leadId}`,
      );
    });

    test("links out to /tasks under the same filter names it shows", async ({
      page,
    }) => {
      await page.goto("/dashboard");
      const digest = digestOf(page);

      // taskIndexHref/taskIndexLabel are shared with the /tasks tabs, so this
      // is what catches the two pages drifting into calling one filter two
      // different things, or linking at a param that has been renamed.
      await expect(
        digest.getByRole("link", { name: /^Overdue \(/ }),
      ).toHaveAttribute("href", "/tasks?status=overdue");

      await digest.getByRole("link", { name: "All open tasks" }).click();
      await expect(page).toHaveURL(/\/tasks\?status=open$/);
      // And it lands somewhere that actually holds what it promised.
      // .first(): ListTable renders a table row AND a stacked card for the
      // same row, so the title legitimately appears twice on /tasks.
      await expect(
        page.getByText(TASK_FIXTURE.overdue.title).first(),
      ).toBeVisible();
    });
  });

  test.describe("as an admin", () => {
    test.use({ storageState: storageStateFor("admin") });

    test("shows the admin's own tasks, not the company's", async ({ page }) => {
      await page.goto("/dashboard");
      const digest = digestOf(page);

      // Non-empty FIRST. Without this, the absence assertion below would pass
      // on a digest that was broken outright, or on an admin who simply has no
      // work — which is how a scoping test quietly stops testing anything.
      await expect(digest.getByText(TASK_FIXTURE.adminOwn.title)).toBeVisible();

      // The claim the agent_id narrowing exists to make. RLS lets an admin read
      // this row and the /tasks page shows it to them; the dashboard declines,
      // because a landing page listing everybody's work is not a digest.
      await expect(
        digest.getByText(TASK_FIXTURE.overdue.title),
        "the admin's own dashboard is showing a rep's task",
      ).toHaveCount(0);
    });

    test("still reaches the rep's task through /tasks", async ({ page }) => {
      // The other half of the pair above, and the reason it is here: it shows
      // the admin has NOT lost access to the row, so the dashboard assertion is
      // about the digest's choice rather than about a policy or a broken read.
      await page.goto("/tasks?status=overdue");
      // .first(): ListTable renders a table row AND a stacked card for the
      // same row, so the title legitimately appears twice on /tasks.
      await expect(
        page.getByText(TASK_FIXTURE.overdue.title).first(),
      ).toBeVisible();
    });
  });
});

test.describe("reconciling a lead's follow-up with its tasks", () => {
  test.use({ storageState: storageStateFor("agent") });

  test("offers the earliest open task's date, and writes it on one click", async ({
    page,
  }) => {
    // Re-seeded here rather than only in beforeAll, because this is the one
    // spec in the file that WRITES the column it asserts on: a re-run, or a
    // file added above this one, would otherwise find the lead already
    // reconciled and the button already gone.
    const { tasks: fresh } = await seedE2E();
    expect(await leadFollowupDate(fresh.leadId)).toBeNull();

    await page.goto(`/leads/${fresh.leadId}`);

    const block = page.locator('[data-slot="followup-reconcile"]');
    await expect(block).toBeVisible();

    // The date offered is the earliest OPEN task's — not the completed one
    // dated six days before it, which is the trap a bare min() over the panel's
    // rows falls into. Asserted on the machine-readable attribute, so this does
    // not quietly become a test of the browser's locale.
    await expect(block.locator("time")).toHaveAttribute(
      "datetime",
      fresh.earliestOpenDue,
    );
    await expect(block).toContainText("no follow-up date");

    await block.getByRole("button", { name: /^Set follow-up to / }).click();

    await expect(block).toContainText(
      "Follow-up matches the earliest open task",
    );
    await expect(
      page.getByRole("button", { name: /^Set follow-up to / }),
      "the prompt should be gone once there is nothing to reconcile",
    ).toHaveCount(0);

    // The second claim, and the one the page cannot make on its own.
    expect(await leadFollowupDate(fresh.leadId)).toBe(fresh.earliestOpenDue);
  });

  test("says nothing on a lead with no dated open task", async ({ page }) => {
    // The quiet lead carries no tasks at all. "Renders nothing" is worth
    // pinning: it is the branch that decides whether this component is a help
    // or a permanent banner on every lead in the book.
    await page.goto(`/leads/${tasks.quietLeadId}`);
    await expect(
      page.getByRole("heading", { name: /Tasks/ }),
      "precondition: the lead page rendered",
    ).toBeVisible();

    await expect(
      page.locator('[data-slot="followup-reconcile"]'),
    ).toHaveCount(0);
  });
});
