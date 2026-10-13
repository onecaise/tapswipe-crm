import { expect, test } from "@playwright/test";

import { BUSINESS_DOCUMENT_FIXTURE, seedE2E, storageStateFor } from "../fixtures/seed";

/**
 * QA-008. When an Edge Function is down — the runtime answering 502/503 with a
 * plain-text body, or the request never reaching it — edgeFunctionErrorMessage()
 * found no `{ error }` JSON and fell back to supabase-js's own `.message`, so a
 * rep clicking Download read "Edge Function returned a non-2xx status code" or
 * "Failed to send a request to the Edge Function": the exact string
 * lib/edge-functions.ts exists to keep off the screen.
 *
 * Originally driven through the per-record documents panel and
 * create-download-url. Both were removed on 13 Oct 2026, so the same two
 * failures are now driven through the Document Center and
 * business-document-file-url, whose Download goes through the same
 * invokeEdgeFunction() and then friendlyLibraryError().
 */
test.use({ storageState: storageStateFor("agent") });

test.beforeAll(async () => {
  await seedE2E();
});

const RAW = /non-2xx|Failed to send a request|Edge Function|upstream/i;

for (const mode of ["503 with a plain-text body", "unreachable"] as const) {
  test(`QA-008 a download while the function is ${mode} reads as a sentence`, async ({ page }) => {
    await page.route("**/functions/v1/business-document-file-url", (route) =>
      mode === "unreachable"
        ? route.abort("connectionrefused")
        : route.fulfill({ status: 503, contentType: "text/plain", body: "upstream connect error" }),
    );
    await page.goto("/documents");
    await page
      .getByRole("button", { name: `Download ${BUSINESS_DOCUMENT_FIXTURE.title}` })
      .click();

    await expect(
      page.getByText("Could not open that document. Try again in a minute."),
    ).toBeVisible();
    await expect(page.getByText(RAW)).toHaveCount(0);
  });
}

test("QA-008 a deleted document reads as a sentence, not the function's own words", async ({ page }) => {
  // The function's 404 body is "Document not found", which is accurate and
  // written for a developer. friendlyLibraryError() turns it into something a
  // rep can act on. Driven with page.route so no real document is deleted.
  await page.route("**/functions/v1/business-document-file-url", (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: "Document not found" }),
    }),
  );
  await page.goto("/documents");
  await page
    .getByRole("button", { name: `View ${BUSINESS_DOCUMENT_FIXTURE.title}` })
    .click();

  await expect(
    page.getByText("That document is no longer in the library. Refresh the page to see what is."),
  ).toBeVisible();
  await expect(page.getByText("Document not found", { exact: true })).toHaveCount(0);
});
