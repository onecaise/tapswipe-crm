import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  BUSINESS_DOCUMENT_BODY,
  BUSINESS_DOCUMENT_FIXTURE,
  businessDocumentObjectExists,
  businessDocumentRows,
  clearBusinessDocuments,
  seedE2E,
  storageStateFor,
} from "./fixtures/seed";

/**
 * The Document Center (/documents) as a company library, in a real browser.
 *
 * What the other suites already prove is not repeated here: the policies are
 * in tests/rls/business-documents.test.ts, and the function's two modes, the
 * archive-on-failure path and a rep's refusal through a DIRECT function or
 * PostgREST call are in tests/live/business-documents.test.ts. This file is
 * the UI half of the same claims, which only a browser can check:
 *
 *   * an admin can add, rename/recategorise and delete through the pages, and a
 *     rep in a second session sees each change;
 *   * a rep can view and download, and is offered no way to add or delete --
 *     no form, no Delete button, and /documents/manage sends them away;
 *   * "Delete" asks first, and what it does underneath is archive: the row and
 *     the file stay, and every rep stops seeing it;
 *   * neither page scrolls sideways on a phone.
 */

const ADDED = "E2E added policy";
const RENAMED = "E2E renamed policy";

test.beforeAll(async () => {
  await seedE2E();
  await clearBusinessDocuments([ADDED, RENAMED]);
});

function libraryRow(scope: Page | Locator, title: string) {
  return scope.getByRole("listitem").filter({ hasText: title });
}

/** A row on the manage page, found by FILE NAME: the title there is an input
 *  value, which hasText cannot see. */
function manageRow(page: Page, fileName: string) {
  return page.getByRole("listitem").filter({ hasText: fileName });
}

test.describe("a rep in the Document Center", () => {
  test.use({ storageState: storageStateFor("agent") });

  test("sees the published library, grouped by category", async ({ page }) => {
    await page.goto("/documents");
    await expect(page.getByRole("heading", { name: "Document Center" })).toBeVisible();

    const section = page.getByRole("region", { name: BUSINESS_DOCUMENT_FIXTURE.category });
    await expect(section).toBeVisible();
    await expect(libraryRow(section, BUSINESS_DOCUMENT_FIXTURE.title)).toBeVisible();
  });

  test("downloads the real file, under its own name", async ({ page }) => {
    await page.goto("/documents");
    const downloaded = page.waitForEvent("download");
    await page
      .getByRole("button", { name: `Download ${BUSINESS_DOCUMENT_FIXTURE.title}` })
      .click();
    const download = await downloaded;

    expect(download.suggestedFilename()).toBe(BUSINESS_DOCUMENT_FIXTURE.fileName);
    const path = await download.path();
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(path, "utf8")).toBe(BUSINESS_DOCUMENT_BODY);
  });

  test("offers View and Print, and no error, on a live document", async ({ page }) => {
    // The tab-opening itself is not asserted -- see e2e/marketing.spec.ts on
    // why Playwright cannot tell the noopener bug from the fix. What is
    // asserted is that the request succeeds: a refused sign would render the
    // friendly error under the row.
    await page.goto("/documents");
    const row = libraryRow(page, BUSINESS_DOCUMENT_FIXTURE.title);
    const popup = page.waitForEvent("popup");
    await row.getByRole("button", { name: `View ${BUSINESS_DOCUMENT_FIXTURE.title}` }).click();
    await (await popup).close();
    await expect(row.getByRole("alert")).toHaveCount(0);
    await expect(
      row.getByRole("button", { name: `Print ${BUSINESS_DOCUMENT_FIXTURE.title}` }),
    ).toBeEnabled();
  });

  test("is offered no way to add or delete", async ({ page }) => {
    await page.goto("/documents");
    await expect(libraryRow(page, BUSINESS_DOCUMENT_FIXTURE.title)).toBeVisible();

    await expect(page.getByRole("link", { name: "Manage documents" })).toHaveCount(0);
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Delete/ })).toHaveCount(0);
  });

  test("is sent away from the manage page", async ({ page }) => {
    await page.goto("/documents/manage");
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole("heading", { name: "Add a document" })).toHaveCount(0);
  });

  test("no longer sees a documents panel on a record", async ({ page }) => {
    // The per-record upload path is gone from the UI as well as the database.
    const { docOwners } = await seedE2E();
    for (const path of [
      `/leads/${docOwners.agent.lead}`,
      `/merchants/${docOwners.agent.merchant}`,
      `/pre-apps/${docOwners.agent.pre_app}`,
      `/support-tickets/${docOwners.agent.support_ticket}`,
    ]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 }).first(), path).toBeVisible();
      await expect(page.getByRole("heading", { name: "Documents", exact: true }), path).toHaveCount(0);
      await expect(page.locator('input[type="file"]'), path).toHaveCount(0);
    }
  });
});

test.describe("an admin managing the library", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ storageState: storageStateFor("admin") });

  test("adds a document that a rep then sees", async ({ page, browser }) => {
    await page.goto("/documents/manage");

    await page.getByLabel("Category").first().fill("E2E Forms");
    await page.getByLabel("Title").first().fill(ADDED);
    await page.getByLabel("File").setInputFiles({
      name: "e2e-added.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("E2E added body"),
    });

    await expect(manageRow(page, "e2e-added.txt")).toBeVisible();

    const [row] = await businessDocumentRows(ADDED);
    expect(row.archived_at).toBeNull();
    expect(row.file_key).toBe(`${row.id}/e2e-added.txt`);
    await expect.poll(() => businessDocumentObjectExists(row.file_key!)).toBe(true);

    const rep = await browser.newContext({ storageState: storageStateFor("agent") });
    try {
      const repPage = await rep.newPage();
      await repPage.goto("/documents");
      await expect(libraryRow(repPage, ADDED)).toBeVisible();
    } finally {
      await rep.close();
    }
  });

  test("renames and recategorises it", async ({ page, browser }) => {
    await page.goto("/documents/manage");
    const row = manageRow(page, "e2e-added.txt");
    await row.getByLabel("Title").fill(RENAMED);
    await row.getByLabel("Category").fill("E2E Procedures");
    await row.getByRole("button", { name: "Save" }).click();
    await expect(row.getByRole("button", { name: "Save" })).toHaveCount(0);

    // A reload, so this is the database talking rather than client state.
    await page.reload();
    await expect(manageRow(page, "e2e-added.txt").getByLabel("Title")).toHaveValue(RENAMED);

    const rep = await browser.newContext({ storageState: storageStateFor("agent") });
    try {
      const repPage = await rep.newPage();
      await repPage.goto("/documents");
      const section = repPage.getByRole("region", { name: "E2E Procedures" });
      await expect(section.getByText(RENAMED)).toBeVisible();
      await expect(repPage.getByText(ADDED, { exact: true })).toHaveCount(0);
    } finally {
      await rep.close();
    }
  });

  test("deletes it only after confirming, and every rep stops seeing it", async ({
    page,
    browser,
  }) => {
    await page.goto("/documents/manage");
    const row = manageRow(page, "e2e-added.txt");

    // First click only asks.
    await row.getByRole("button", { name: `Delete ${RENAMED}` }).click();
    await expect(row.getByText("Delete for every rep?")).toBeVisible();
    await row.getByRole("button", { name: "Cancel" }).click();
    await expect(row).toBeVisible();
    expect((await businessDocumentRows(RENAMED))[0].archived_at).toBeNull();

    await row.getByRole("button", { name: `Delete ${RENAMED}` }).click();
    await row.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(manageRow(page, "e2e-added.txt")).toHaveCount(0);

    // Archive under the hood: the row and its file are both still there.
    const [stored] = await businessDocumentRows(RENAMED);
    expect(stored.archived_at).not.toBeNull();
    expect(await businessDocumentObjectExists(stored.file_key!)).toBe(true);

    const rep = await browser.newContext({ storageState: storageStateFor("agent") });
    try {
      const repPage = await rep.newPage();
      await repPage.goto("/documents");
      await expect(libraryRow(repPage, BUSINESS_DOCUMENT_FIXTURE.title)).toBeVisible();
      await expect(repPage.getByText(RENAMED)).toHaveCount(0);
    } finally {
      await rep.close();
    }
  });
});

test.describe("on a phone", () => {
  for (const [persona, path] of [
    ["agent", "/documents"],
    ["admin", "/documents/manage"],
  ] as const) {
    test(`${path} does not scroll sideways at 375px as ${persona}`, async ({ browser }) => {
      const context = await browser.newContext({
        storageState: storageStateFor(persona),
        viewport: { width: 375, height: 812 },
      });
      try {
        const page = await context.newPage();
        await page.goto(path);
        await expect(page.getByText(/E2E chargeback policy|e2e-chargeback-policy\.txt/).first()).toBeVisible();
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);
      } finally {
        await context.close();
      }
    });
  }
});
