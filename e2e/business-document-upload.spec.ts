import { open } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";

import {
  businessDocumentRows,
  clearBusinessDocuments,
  seedE2E,
  storageStateFor,
} from "./fixtures/seed";

/**
 * The admin's "Add a document" form at /documents/manage, in a real browser.
 *
 * Only what a person could only find by looking: the form's own refusals,
 * whether the file input can be used again after one, and what sentence a
 * failed signing call puts on the screen. The server-side half (the bucket
 * limit, the empty file Storage happily stores) is in
 * tests/live/business-document-files.test.ts.
 *
 * Replaces the equivalent cases e2e/documents-panel.spec.ts had for the
 * removed per-record panel.
 */

const EMPTY = "E2E empty upload";
const HUGE = "E2E oversized upload";
const RETRY = "E2E retried upload";
const SIGNING = "E2E signing failure";

/** 50 MiB, the bucket's limit and MAX_BUSINESS_DOCUMENT_BYTES. */
const LIMIT = 50 * 1024 * 1024;

test.use({ storageState: storageStateFor("admin") });

test.beforeAll(async () => {
  await seedE2E();
  await clearBusinessDocuments([EMPTY, HUGE, RETRY, SIGNING]);
});

test.afterAll(async () => {
  await clearBusinessDocuments([EMPTY, HUGE, RETRY, SIGNING]);
});

/** The form's own controls, by id: the manage list below also has inputs
 *  labelled Category and Title, one per row. */
function form(page: Page) {
  return {
    category: page.locator("#business_document_category"),
    title: page.locator("#business_document_title"),
    file: page.locator("#business_document_file"),
  };
}

async function fillLabels(page: Page, title: string): Promise<void> {
  const f = form(page);
  await f.category.fill("E2E Upload checks");
  await f.title.fill(title);
}

test("an empty file is refused in the browser, and nothing is created", async ({ page }) => {
  await page.goto("/documents/manage");
  await fillLabels(page, EMPTY);
  await form(page).file.setInputFiles({
    name: "empty.txt",
    mimeType: "text/plain",
    buffer: Buffer.alloc(0),
  });

  await expect(page.getByRole("alert").filter({ hasText: "That file is empty." })).toBeVisible();
  expect(await businessDocumentRows(EMPTY)).toEqual([]);
});

test("an oversized file is refused in the browser, in a sentence that does not contradict itself", async ({ page }, testInfo) => {
  // On disk, not a buffer: Playwright refuses an in-memory file over 50 MB.
  // Sparse (ftruncate), so this costs no real disk.
  const hugePath = testInfo.outputPath("huge.bin");
  const handle = await open(hugePath, "w");
  await handle.truncate(LIMIT + 1);
  await handle.close();

  await page.goto("/documents/manage");
  await fillLabels(page, HUGE);
  await form(page).file.setInputFiles(hugePath);

  // 50 MiB + 1 byte rounds to "50 MiB", so quoting both numbers used to read
  // "That file is 50 MiB. The limit is 50 MiB." oversizeMessage() says
  // "slightly over" instead (lib/file-size.ts).
  await expect(
    page.getByRole("alert").filter({ hasText: "That file is slightly over the 50 MiB limit." }),
  ).toBeVisible();
  await expect(page.getByText("That file is 50 MiB. The limit is 50 MiB.")).toHaveCount(0);
  expect(await businessDocumentRows(HUGE)).toEqual([]);
});

test("the same file input works again after a refusal", async ({ page }) => {
  // setInputFiles dispatches `change` unconditionally, so Playwright cannot
  // reproduce "the same file re-picked fires no event" by re-picking. What it
  // CAN observe is the cause: the input's value is cleared after a refusal.
  // A browser fires no change event for a value that did not change, so an
  // uncleared input is a dead control for exactly the file the admin meant.
  await page.goto("/documents/manage");
  await fillLabels(page, RETRY);
  const file = form(page).file;

  await file.setInputFiles({ name: "retry.txt", mimeType: "text/plain", buffer: Buffer.alloc(0) });
  await expect(page.getByRole("alert").filter({ hasText: "That file is empty." })).toBeVisible();
  await expect(file).toHaveValue("");

  // And then the corrected file goes through on the same control.
  await file.setInputFiles({
    name: "retry.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("E2E retried body"),
  });
  await expect(page.getByRole("listitem").filter({ hasText: "retry.txt" })).toBeVisible();
  const [row] = await businessDocumentRows(RETRY);
  expect(row?.file_key).toBe(`${row?.id}/retry.txt`);
});

const RAW = /non-2xx|Failed to send a request|Edge Function|upstream|related resource|Could not create upload URL/i;

for (const [label, fulfil] of [
  ["503 with a plain-text body", { status: 503, contentType: "text/plain", body: "upstream connect error" }],
  [
    "500 carrying Storage's own text",
    {
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "Could not create upload URL: The related resource does not exist" }),
    },
  ],
] as const) {
  test(`a signing call failing with a ${label} reads as a sentence`, async ({ page }) => {
    // Routed, so the real function is never reached and nothing is created.
    await page.route("**/functions/v1/business-document-file-url", (route) => route.fulfill(fulfil));
    await page.goto("/documents/manage");
    await fillLabels(page, SIGNING);
    await form(page).file.setInputFiles({
      name: "signing.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("never sent"),
    });

    await expect(
      page.getByRole("alert").filter({
        hasText: "Could not start the upload. The library may be unavailable — try again in a minute.",
      }),
    ).toBeVisible();
    await expect(page.getByText(RAW)).toHaveCount(0);
    expect(await businessDocumentRows(SIGNING)).toEqual([]);
  });
}
