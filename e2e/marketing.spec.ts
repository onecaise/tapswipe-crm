import { expect, test, type Page } from "@playwright/test";

// MARKETING_MATERIAL_BODY is not imported: asserting the opened tab's content
// is what Playwright cannot do here. See the note in the View test.
import {
  clearMarketingEvents,
  seedE2E,
  storageStateFor,
} from "./fixtures/seed";

/**
 * The marketing library, in a real browser.
 *
 * Deliberately NOT a copy of what the other suites already prove. RLS on both
 * tables is covered in tests/rls/marketing-materials.test.ts; the Edge
 * Function's two modes, its authorization asymmetry and the inline/attachment
 * split are covered in tests/live/marketing-materials.test.ts. A browser copy
 * of any of that would be a slower, flakier duplicate.
 *
 * What is here is only what a person could ONLY find by looking:
 *
 *   1. **The Email button's history is real and survives a reload.** Optimistic
 *      client state would pass a click-and-look assertion; only a reload
 *      proves the row reached the database and came back through a server
 *      render.
 *   2. **The Email button says nothing was sent.** The product claim is a
 *      sentence on a screen; it is only true if it is rendered, and nothing
 *      below the browser can check that it is.
 *   3. **A rep is offered no way to publish, and an admin is offered no way to
 *      delete.** The database refuses both either way — the insert policy is
 *      is_admin(), and marketing_materials has no DELETE policy or grant at
 *      all — so neither is a security assertion. They are about not rendering
 *      a control whose only possible outcome is a permission error.
 *
 * And see the long note below on the one thing that is NOT here.
 */

// No materialId here: the specs below find the material by its rendered text,
// and the only test that needed the id was the View one that could not be made
// to discriminate (see the note further down). seedE2E() still returns it, for
// the live suite and for whatever automates that behaviour next.
let agentLeadId: number;

test.beforeAll(async () => {
  const seeded = await seedE2E();
  agentLeadId = seeded.docOwners.agent.lead;
});

/** The rep-facing library row for the seeded material. */
function materialRow(page: Page) {
  return page.getByRole("listitem").filter({ hasText: "E2E rate card" });
}

/**
 * The same material's row on /marketing/manage, found by FILE NAME.
 *
 * Not by title, which is what the rep-facing list uses: on the admin page the
 * title lives in an `<input>` so an admin can rename it, and `hasText` matches
 * text content rather than a form value — it finds nothing. The file name is
 * the only thing about the row that is rendered as text.
 */
function adminMaterialRow(page: Page) {
  return page.getByRole("listitem").filter({ hasText: "e2e-rate-card.txt" });
}

test.describe("a rep using the library", () => {
  test.use({ storageState: storageStateFor("agent") });

  // THERE IS NO "View opens a new tab" TEST HERE, and the absence is deliberate
  // rather than an omission — it was written, it passed, and it was deleted.
  //
  // The bug it was meant to pin is real and shipped:
  // `window.open(url, "_blank", "noopener")` RETURNS NULL BY SPEC, so the
  // handle was always null, the fallback navigated the CURRENT tab, and the
  // blank tab the browser had already created sat orphaned. Found by hand in
  // Chrome. Fixed, and verified by hand in Chrome: the lead page stays put and
  // the new tab renders the file.
  //
  // Playwright cannot see any of it. The cross-origin assignment that drives
  // the popup never moves the page object — `waitForURL` dies with
  // `net::ERR_ABORTED; maybe frame was detached?`, polling `opened.url()` sits
  // on "about:blank" until it times out, and context.pages() never gains the
  // storage URL. Worse, the FALLBACK path does not navigate under Playwright
  // either, so the broken version looks identical to the fixed one from here.
  //
  // Two drafts were tried and both went green with `noopener` deliberately
  // restored — the first because it read page.url() before the fallback had
  // had time to run, the second because the fallback does not run at all in
  // this driver. A spec that is green for the bug AND for the fix is worse
  // than no spec: it is a claim of coverage that does not exist. Same call
  // documents-panel.spec.ts made about `setInputFiles` dispatching `change`
  // unconditionally, for the same reason.
  //
  // If this ever needs automating, it needs a driver that performs the
  // navigation — not a cleverer locator.

  test("Email logs the event, says nothing was sent, and shows it in the history", async ({
    page,
  }) => {
    // The View test above logs a 'viewed' event against this same lead, so the
    // empty state below is only true if this test makes it true. The table is
    // append-only by design — no UPDATE or DELETE grant — so nothing in the
    // browser can undo it, which is exactly why the helper runs as the service
    // role. Without this the spec passes or fails on test ORDER, which is the
    // worst kind of green.
    await clearMarketingEvents(agentLeadId);

    await page.goto(`/leads/${agentLeadId}`);
    const row = materialRow(page);

    await expect(page.getByText("Nothing sent to this lead yet.")).toBeVisible();

    await row.getByRole("button", { name: /^Email/ }).click();

    // The sentence is the product claim. An admin reading the history will see
    // "Emailed" against this lead, so a rep who was not told would reasonably
    // believe the merchant received something.
    await expect(
      page.getByText(/No email was sent — sending is not built yet/),
    ).toBeVisible();

    // And the event really landed, which is what makes the history real rather
    // than optimistic client state.
    await expect(
      page.getByRole("listitem").filter({ hasText: /Emailed/ }),
    ).toBeVisible();

    await page.reload();
    await expect(
      page.getByRole("listitem").filter({ hasText: /Emailed/ }),
    ).toBeVisible();
    await expect(
      page.getByText("Nothing sent to this lead yet."),
    ).toBeHidden();
  });

  test("is offered no way to publish or manage", async ({ page }) => {
    await page.goto("/marketing");

    await expect(materialRow(page)).toBeVisible();
    // Not a security assertion — the insert policy is is_admin() and the live
    // suite proves it. This is about not rendering a control whose only
    // possible outcome is a permission error.
    await expect(
      page.getByRole("link", { name: /Manage library/ }),
    ).toHaveCount(0);
    await expect(page.getByText("Publish a material")).toHaveCount(0);
  });

  test("is redirected away from the admin page", async ({ page }) => {
    await page.goto("/marketing/manage");
    // requireAdmin() sends them somewhere sensible rather than rendering a
    // page whose every write would be refused.
    await expect(page).not.toHaveURL(/\/marketing\/manage/);
  });
});

test.describe("an admin managing the library", () => {
  test.use({ storageState: storageStateFor("admin") });

  test("sees the manage link and the publish form", async ({ page }) => {
    await page.goto("/marketing");
    await expect(
      page.getByRole("link", { name: /Manage library/ }),
    ).toBeVisible();

    await page.getByRole("link", { name: /Manage library/ }).click();
    await expect(page).toHaveURL(/\/marketing\/manage/);
    await expect(page.getByText("Publish a material")).toBeVisible();
  });

  test("offers archive and no delete at all", async ({ page }) => {
    await page.goto("/marketing/manage");
    const row = adminMaterialRow(page);
    await expect(row).toBeVisible();

    await expect(row.getByRole("button", { name: "Archive" })).toBeVisible();
    // The absence is the point, and it is the one claim here a person could
    // only check by looking: the table has no DELETE policy and no DELETE
    // grant, so a delete button would be a control that cannot work. Pinning it
    // in the UI stops one being added back without the schema question being
    // asked again.
    await expect(row.getByRole("button", { name: /Delete|Remove/ })).toHaveCount(
      0,
    );
  });
});
