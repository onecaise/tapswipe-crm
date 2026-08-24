import {
  existsSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import {
  DOC_OWNER_PATHS,
  DOC_OWNER_TYPES,
  clearDocuments,
  publicStackConfig,
  documentRows,
  seedE2E,
  storageObjectExists,
  storageStateFor,
  type DocOwnerType,
} from "./fixtures/seed";

/**
 * The document panel, in a real browser, on all four pages that carry it.
 *
 * What this suite is FOR, given three others already cover documents. The
 * policies are asserted as SQL in tests/rls/documents.test.ts; the Edge
 * Functions, Storage and the size ceiling are asserted over real HTTP in
 * tests/live/document-lifecycle.test.ts. Neither can see a file input. Every
 * assertion here needs one of three things a browser has and they do not:
 *
 *   * a real <input type="file"> and the change event it does or does not fire —
 *     the panel used not to clear the input after a failure, so re-picking the
 *     same file was silently a no-op and the retry looked like a dead control;
 *   * the error text a person actually reads. Every failure showed "Edge
 *     Function returned a non-2xx status code" because supabase-js does not read
 *     the function's response body, so a deactivated rep and a wrong record and
 *     a real fault were one indistinguishable sentence;
 *   * the browser's download machinery. `window.open` after an `await` is not a
 *     user gesture any more and a popup blocker may drop it, leaving a button
 *     that looks like it worked.
 *
 * And one structural thing: three of the four owner types had never been
 * uploaded to from a page, and support_ticket had no panel at all.
 */

/** File names this suite creates, cleared before and after so counts are stable. */
const FILE_NAMES = [
  "e2e-merchant.txt",
  "e2e-signfail.txt",
  "e2e-dlfail.txt",
  "e2e-lead.txt",
  "e2e-pre_app.txt",
  "e2e-support_ticket.txt",
  "e2e-download.txt",
  "e2e-delete.txt",
  "e2e-retry.txt",
  "e2e-admin-upload.txt",
  "e2e-tab-one.txt",
  "e2e-tab-two.txt",
  "e2e-orphan.txt",
  "e2e-dropped.txt",
  "e2e-other-rep.txt",
  "e2e-rapid-1.txt",
  "e2e-rapid-2.txt",
  "e2e-rapid-3.txt",
  // Names the panel REFUSES. Listed so a run that failed while a client-side
  // check was disabled — which is exactly what proving these specs non-vacuous
  // involves — does not leave a row that makes the next run's empty-state
  // assertion fail for an unrelated reason.
  "empty.txt",
  "tapswipe-e2e-oversize.bin",
];

let owners: Awaited<ReturnType<typeof seedE2E>>["docOwners"];
let profileIds: Awaited<ReturnType<typeof seedE2E>>["ids"];

test.beforeAll(async () => {
  ({ docOwners: owners, ids: profileIds } = await seedE2E());
  await clearDocuments(FILE_NAMES);
});

test.afterAll(async () => {
  await clearDocuments(FILE_NAMES);
});

/**
 * A 51 MiB file on disk, written once and reused.
 *
 * Has to be a real file: setInputFiles refuses an inline buffer over 50 MB,
 * which is just below the 50 MiB ceiling this suite needs to cross. Written to
 * the OS temp directory rather than into the repo, and truncated to size rather
 * than filled, so it costs a syscall instead of 51 MiB of memory.
 */
function oversizeFile(): string {
  const target = path.join(tmpdir(), "tapswipe-e2e-oversize.bin");
  if (!existsSync(target) || statSync(target).size !== 51 * 1024 * 1024) {
    writeFileSync(target, "");
    truncateSync(target, 51 * 1024 * 1024);
  }
  return target;
}

/** The detail page for one of a persona's document-owning records. */
function pathFor(
  ownerType: DocOwnerType,
  ids: Record<DocOwnerType, number>,
): string {
  return `${DOC_OWNER_PATHS[ownerType]}/${ids[ownerType]}`;
}

/** The panel's own heading, which is what proves the panel is on the page. */
const panel = (page: Page) => page.getByRole("heading", { name: "Documents" });

/**
 * Picks a file and waits for the upload to settle.
 *
 * Waits on the LIST rather than on the "Uploading…" text: the whole point of
 * driving this in a browser is the state after three network round trips, and
 * "Uploading…" can come and go between two polls.
 */
async function uploadFile(
  page: Page,
  file: { name: string; body: string; mimeType?: string },
): Promise<void> {
  await page.getByLabel("File").setInputFiles({
    name: file.name,
    mimeType: file.mimeType ?? "text/plain",
    buffer: Buffer.from(file.body),
  });
}

test.describe("upload and download from every owner type's page", () => {
  test.use({ storageState: storageStateFor("agent") });

  for (const ownerType of DOC_OWNER_TYPES) {
    test(`a rep can attach a file to their own ${ownerType}`, async ({
      page,
    }) => {
      await page.goto(pathFor(ownerType, owners.agent));
      await expect(panel(page)).toBeVisible();
      await expect(
        page.getByText("No documents attached yet."),
      ).toBeVisible();

      const fileName = `e2e-${ownerType}.txt`;
      await uploadFile(page, { name: fileName, body: `bytes for ${ownerType}` });

      // The row appearing is the whole three-step upload having worked: signed
      // URL, bytes into a private bucket, metadata row, then router.refresh()
      // re-reading it through RLS.
      await expect(page.getByText(fileName)).toBeVisible();
      await expect(
        page.getByText("No documents attached yet."),
      ).toBeHidden();

      // And it is a real object, not just a row. Read with the service role,
      // because the bucket is private and the browser only ever holds a signed
      // URL — an orphaned row is invisible from inside the page, which is how
      // that class of bug survives.
      const [row] = await documentRows(fileName);
      expect(row, "a metadata row should exist").toBeTruthy();
      expect(await storageObjectExists(row.fileKey)).toBe(true);
      // The key encodes the owner triple, which is what
      // documents_file_key_matches_owner enforces.
      expect(row.fileKey).toContain(`/${ownerType}/${owners.agent[ownerType]}/`);
    });
  }

  test("the download button actually downloads", async ({ page }) => {
    await page.goto(pathFor("merchant", owners.agent));
    await uploadFile(page, {
      name: "e2e-download.txt",
      body: "downloaded through the browser",
    });
    await expect(page.getByText("e2e-download.txt")).toBeVisible();

    // A download event, and no extra tab. This is the assertion that changes
    // behaviour when the click is turned back into window.open(): after an await
    // the click is no longer a user gesture, so the blocker is entitled to drop
    // it, and even when it isn't dropped it leaves a blank tab behind.
    const before = page.context().pages().length;
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 15_000 }),
      page.getByRole("button", { name: "Download e2e-download.txt" }).click(),
    ]);

    expect(download.suggestedFilename()).toBe("e2e-download.txt");
    expect(page.context().pages()).toHaveLength(before);
    // Still on the record afterwards. Content-Disposition: attachment is what
    // makes navigating the current tab safe; without it the rep would be dumped
    // on the storage origin.
    await expect(panel(page)).toBeVisible();
  });

  test("removing a document takes the stored file with it", async ({ page }) => {
    await page.goto(pathFor("merchant", owners.agent));
    await uploadFile(page, { name: "e2e-delete.txt", body: "to be removed" });
    await expect(page.getByText("e2e-delete.txt")).toBeVisible();

    // Captured before the removal: once the row is gone there is nothing left to
    // look the object up by, which is exactly why "delete" leaving the bytes
    // behind went unnoticed for so long.
    const [row] = await documentRows("e2e-delete.txt");
    expect(await storageObjectExists(row.fileKey)).toBe(true);

    await page
      .getByRole("button", { name: "Remove e2e-delete.txt" })
      .click();
    // Two steps on purpose — a destructive action behind a confirmation.
    await expect(page.getByText("Remove this document?")).toBeVisible();
    await page.getByRole("button", { name: "Remove", exact: true }).click();

    await expect(page.getByText("e2e-delete.txt")).toBeHidden();
    expect(await documentRows("e2e-delete.txt")).toHaveLength(0);
    expect(await storageObjectExists(row.fileKey)).toBe(false);
  });
});

test.describe("client-side refusals happen before any upload", () => {
  test.use({ storageState: storageStateFor("agent") });

  test("an empty file is refused with a readable message", async ({ page }) => {
    await page.goto(pathFor("merchant", owners.agent));

    // Nothing server-side objects to a zero-byte file: it uploads, lists,
    // badges and offers a download exactly like a real one (asserted in
    // tests/live/document-lifecycle.test.ts), and the only way to notice is to
    // open it. So this has to be caught here or not at all.
    const requests: string[] = [];
    page.on("request", (request) => {
      if (/create-upload-url|\/storage\/v1\//.test(request.url())) {
        requests.push(request.url());
      }
    });

    await page.getByLabel("File").setInputFiles({
      name: "empty.txt",
      mimeType: "text/plain",
      buffer: Buffer.from([]),
    });

    await expect(page.getByText(/empty \(0 bytes\)/)).toBeVisible();
    // Before any network call, not after a failed one.
    expect(requests).toHaveLength(0);
    // Not a getByText on the file name: the message names the file, so that
    // would match the error itself and pass for the wrong reason.
    expect(await documentRows("empty.txt")).toHaveLength(0);
  });

  test("an oversized file is refused, naming the size and the limit", async ({
    page,
  }) => {
    await page.goto(pathFor("merchant", owners.agent));

    // 51 MiB against a 50 MiB cap. Refused in the browser so the rep gets a
    // sentence instead of a spinner: before this there was no ceiling anywhere,
    // and an accidental video sat on "Uploading…" with no progress and no error.
    //
    // From a path on disk, not an inline buffer — Playwright refuses a buffer
    // over 50 MB, which is (awkwardly) just under the boundary this test is
    // about.
    await page.getByLabel("File").setInputFiles(oversizeFile());

    // The numbers matter more than the wording: "too big" leaves the rep
    // guessing whether 40 MB would work.
    await expect(page.getByText(/is 51 MiB\. The limit is 50 MiB\./)).toBeVisible();
    expect(await documentRows("tapswipe-e2e-oversize.bin")).toHaveLength(0);
  });

  test("the same file can be re-picked after a failure", async ({ page }) => {
    await page.goto(pathFor("merchant", owners.agent));

    // Fail the first attempt at the signing call.
    let failNext = true;
    await page.route("**/functions/v1/create-upload-url", async (route) => {
      if (failNext) {
        failNext = false;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Storage is having a moment" }),
        });
        return;
      }
      await route.continue();
    });

    const file = {
      name: "e2e-retry.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("second time lucky"),
    };

    await page.getByLabel("File").setInputFiles(file);
    // The function's own message, which is the other half of this fix.
    await expect(page.getByText("Storage is having a moment")).toBeVisible();

    // The input is EMPTY afterwards, and that is the assertion — not the retry
    // below, which passes either way.
    //
    // The panel used to clear the input only on success, which left it showing
    // the file name after a failure. Two problems, one visible here and one not.
    // The visible one: the control reads as though the file is attached when
    // nothing was saved. The invisible one, which is why the clear moved into a
    // `finally`: a file input fires no change event when the user re-picks the
    // identical file, so the obvious retry was a no-op and the only ways out
    // were reloading the page or choosing a different file. Playwright cannot
    // reproduce that second half — setInputFiles dispatches `change`
    // unconditionally, so the retry below succeeds even with the fix reverted,
    // and asserting on it alone would be a spec that proves nothing.
    await expect(page.getByLabel("File")).toHaveValue("");

    await page.getByLabel("File").setInputFiles(file);
    await expect(page.getByText("e2e-retry.txt")).toBeVisible();
    // And cleared again on the way out of a success.
    await expect(page.getByLabel("File")).toHaveValue("");
  });
});

test.describe("failure states leave nothing behind", () => {
  test.use({ storageState: storageStateFor("agent") });

  test("a failed metadata write does not strand the uploaded file", async ({
    page,
  }) => {
    await page.goto(pathFor("merchant", owners.agent));

    // The one genuinely non-atomic window in the upload: sign, PUT the bytes,
    // insert the row. Killing the third step is what a dropped connection or a
    // closed laptop looks like, and it used to leave bytes in the bucket that no
    // page could see and nothing pointed at — so the rep uploads again and the
    // abandoned copy stays for the life of the project.
    let uploadedKey: string | null = null;
    await page.route("**/storage/v1/object/upload/sign/**", async (route) => {
      const url = new URL(route.request().url());
      uploadedKey = decodeURIComponent(
        url.pathname.split("/upload/sign/documents/")[1] ?? "",
      );
      await route.continue();
    });

    const cleanupCalls: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/functions/v1/delete-document")) {
        cleanupCalls.push(request.postData() ?? "");
      }
    });

    await page.route("**/rest/v1/documents*", async (route) => {
      if (route.request().method() === "POST") {
        await route.abort("connectionaborted");
        return;
      }
      await route.continue();
    });

    await page.getByLabel("File").setInputFiles({
      name: "e2e-orphan.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("bytes with no row"),
    });

    // The rep is told, rather than left looking at an empty list wondering.
    await expect(page.getByText(/Failed to fetch|Upload failed|Load failed|NetworkError/i)).toBeVisible();
    await expect(page.getByText("e2e-orphan.txt")).toBeHidden();

    // No row, and — the part that matters — no leftover object either. The panel
    // asks delete-document to clean up after itself, because deleting from a
    // private bucket needs the service role and the browser has none.
    expect(await documentRows("e2e-orphan.txt")).toHaveLength(0);
    expect(cleanupCalls.length, "should have asked for cleanup").toBeGreaterThan(
      0,
    );
    expect(uploadedKey, "the PUT should have happened").toBeTruthy();
    await expect
      .poll(async () => storageObjectExists(uploadedKey as string), {
        timeout: 10_000,
      })
      .toBe(false);
  });

  test("a rejected signing call reports the server's reason", async ({
    page,
  }) => {
    await page.goto(pathFor("merchant", owners.agent));

    // 403 with the real body create-upload-url sends a deactivated rep. The
    // panel showed "Edge Function returned a non-2xx status code" for this, for a
    // 404 on somebody else's record, and for a genuine fault — one sentence for
    // three different situations, none of them actionable.
    await page.route("**/functions/v1/create-upload-url", (route) =>
      route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: "Account is not active" }),
      }),
    );

    await page.getByLabel("File").setInputFiles({
      name: "e2e-signfail.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("x"),
    });

    await expect(page.getByText("Account is not active")).toBeVisible();
    await expect(
      page.getByText(/non-2xx status code/),
      "the generic invoke() message must not reach the rep",
    ).toBeHidden();
  });

  test("a failed download reports the server's reason", async ({ page }) => {
    await page.goto(pathFor("merchant", owners.agent));
    await uploadFile(page, {
      name: "e2e-dlfail.txt",
      body: "download will be blocked",
    });
    await expect(page.getByText("e2e-dlfail.txt")).toBeVisible();

    await page.route("**/functions/v1/create-download-url", (route) =>
      route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "Document not found" }),
      }),
    );

    await page
      .getByRole("button", { name: "Download e2e-dlfail.txt" })
      .click();

    await expect(page.getByText("Document not found")).toBeVisible();
    await expect(page.getByText(/non-2xx status code/)).toBeHidden();
    // Still usable afterwards — a failed download must not leave the button
    // stuck on "Opening…".
    await expect(
      page.getByRole("button", { name: "Download e2e-dlfail.txt" }),
    ).toBeEnabled();
  });
});

test.describe("a drop mid-upload", () => {
  test.use({ storageState: storageStateFor("agent") });

  test("leaves no row and no file when the bytes never land", async ({
    page,
  }) => {
    await page.goto(pathFor("merchant", owners.agent));

    // The PUT itself killed, rather than the metadata write. Distinguished from
    // the other failure test on purpose: nothing reached the bucket, so there is
    // nothing to clean up and the panel must NOT go asking — a cleanup call for
    // a key that was signed but never written would be a wasted round trip on
    // every failed upload, and worse, would look like the orphan path working
    // when it had not run.
    const cleanupCalls: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/functions/v1/delete-document")) {
        cleanupCalls.push(request.url());
      }
    });

    await page.route("**/storage/v1/object/upload/sign/**", (route) =>
      route.abort("connectionreset"),
    );

    await page.getByLabel("File").setInputFiles({
      name: "e2e-dropped.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("never arrives"),
    });

    await expect(
      page.getByText(/failed|error|fetch/i).first(),
      "the rep has to be told",
    ).toBeVisible();
    expect(await documentRows("e2e-dropped.txt")).toHaveLength(0);
    expect(cleanupCalls).toHaveLength(0);
    // And the control is usable again rather than stuck on "Uploading…".
    await expect(page.getByLabel("File")).toBeEnabled();
    await expect(page.getByText("Uploading…")).toBeHidden();
  });
});

test.describe("who sees the panel", () => {
  test("a rep cannot reach another rep's record at all", async ({ browser }) => {
    const context = await browser.newContext({
      storageState: storageStateFor("agent"),
    });
    const page = await context.newPage();

    // Not "the panel is hidden" — the whole page 404s, because the detail page
    // reads the parent under RLS and notFound()s on zero rows. Asserted for
    // every owner type, since each page does its own lookup.
    for (const ownerType of DOC_OWNER_TYPES) {
      await page.goto(pathFor(ownerType, owners.agent2));
      await expect(
        panel(page),
        `${ownerType} should not render a panel for another rep's record`,
      ).toBeHidden();
      // The app's own notFound() page, which deliberately does not confirm the
      // id exists — see app/(app)/not-found.tsx.
      await expect(
        page.getByRole("heading", { name: /couldn’t find that/i }),
      ).toBeVisible();
    }

    await context.close();
  });

  test("an admin can attach a file to a rep's record, filed under the rep", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: storageStateFor("admin"),
    });
    const page = await context.newPage();

    await page.goto(pathFor("support_ticket", owners.agent));
    await expect(panel(page)).toBeVisible();

    await page.getByLabel("File").setInputFiles({
      name: "e2e-admin-upload.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("uploaded by an admin"),
    });
    await expect(page.getByText("e2e-admin-upload.txt")).toBeVisible();

    // Filed under the REP, not the admin. This is what makes an admin's upload
    // visible to the rep whose ticket it is — the opposite of the notes panel,
    // which this page deliberately omits for exactly that reason.
    const [row] = await documentRows("e2e-admin-upload.txt");
    expect(row.fileKey.startsWith(`${profileIds.agent}/`)).toBe(true);
    expect(row.fileKey.startsWith(`${profileIds.admin}/`)).toBe(false);
    expect(row.fileKey).toContain(
      `/support_ticket/${owners.agent.support_ticket}/`,
    );

    await context.close();

    // And the rep can see it on their own ticket.
    const repContext = await browser.newContext({
      storageState: storageStateFor("agent"),
    });
    const repPage = await repContext.newPage();
    await repPage.goto(pathFor("support_ticket", owners.agent));
    await expect(repPage.getByText("e2e-admin-upload.txt")).toBeVisible();
    await repContext.close();
  });
});

test.describe("forging the call the UI would not make", () => {
  test.use({ storageState: storageStateFor("agent") });

  test("the rep's own session cannot sign against another rep's records", async ({
    page,
  }) => {
    await page.goto(pathFor("merchant", owners.agent));

    // The question somebody with devtools open is actually asking: not "is the
    // control hidden" but "what happens if I call it anyway". Issued from INSIDE
    // the page, so the credential is the one this browser is currently carrying
    // — the supabase-js client the app itself constructed, cookie session and
    // all. tests/live covers the same ground with a token from a password
    // sign-in; this is the version that cannot be dismissed as a different
    // credential.
    for (const ownerType of DOC_OWNER_TYPES) {
      const status = await page.evaluate(
        async ([type, id]) => {
          const response = await fetch(
            `${(window as unknown as { __sbUrl?: string }).__sbUrl ?? ""}/functions/v1/create-upload-url`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ owner_type: type, owner_id: id }),
              credentials: "include",
            },
          );
          return response.status;
        },
        [ownerType, owners.agent2[ownerType]] as const,
      );
      // 401 without an Authorization header, and that is the point: there is no
      // ambient credential a page script can spend. The browser's session lives
      // in a cookie the Functions gateway does not read, so a forged call is not
      // even authenticated, let alone authorized.
      expect([401, 404], `${ownerType} must not be signable`).toContain(status);
    }
  });

  test("a rep's access token is refused against another rep's record", async ({
    page,
  }) => {
    await page.goto(pathFor("merchant", owners.agent));

    // And with the token dug out of the cookie, which is the strongest form of
    // the question: this is exactly the credential the rep holds, presented the
    // way the app presents it.
    const cookies = await page.context().cookies();
    const authCookie = cookies.find((c) => c.name.endsWith("-auth-token"));
    expect(authCookie, "the session should be cookie-backed").toBeTruthy();
    const raw = (authCookie as { value: string }).value.startsWith("base64-")
      ? Buffer.from(
          (authCookie as { value: string }).value.slice("base64-".length),
          "base64",
        ).toString("utf8")
      : decodeURIComponent((authCookie as { value: string }).value);
    const accessToken = (JSON.parse(raw) as { access_token?: string })
      .access_token;
    expect(accessToken).toBeTruthy();

    const { apiUrl, publishableKey } = publicStackConfig();

    for (const ownerType of DOC_OWNER_TYPES) {
      const response = await fetch(`${apiUrl}/functions/v1/create-upload-url`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: publishableKey,
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          owner_type: ownerType,
          owner_id: owners.agent2[ownerType],
        }),
      });
      // 404, not 403 — "not yours" and "doesn't exist" are one answer, or the
      // endpoint becomes a way to enumerate which ids exist.
      expect(response.status, `${ownerType} must 404`).toBe(404);
      expect((await response.json()).error).toBe("Owner record not found");
    }

    // And the same token works on their OWN record, so the four 404s above are
    // about ownership and not about a broken token.
    const own = await fetch(`${apiUrl}/functions/v1/create-upload-url`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: publishableKey,
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        owner_type: "merchant",
        owner_id: owners.agent.merchant,
      }),
    });
    expect(own.status).toBe(200);
  });

  test("a rep cannot ask for a download URL for another rep's document", async ({
    page,
  }) => {
    // The other function, and the other direction. The document belongs to
    // agent2; the caller is agent. Set up through the second rep's own session so
    // nothing here writes a row as the service role.
    const otherContext = await page.context().browser()!.newContext({
      storageState: storageStateFor("agent2"),
    });
    const otherPage = await otherContext.newPage();
    await otherPage.goto(pathFor("merchant", owners.agent2));
    await otherPage.getByLabel("File").setInputFiles({
      name: "e2e-other-rep.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("belongs to agent two"),
    });
    await expect(otherPage.getByText("e2e-other-rep.txt")).toBeVisible();
    await otherContext.close();

    const [row] = await documentRows("e2e-other-rep.txt");
    expect(row).toBeTruthy();

    await page.goto(pathFor("merchant", owners.agent));
    const cookies = await page.context().cookies();
    const authCookie = cookies.find((c) => c.name.endsWith("-auth-token"));
    const raw = (authCookie as { value: string }).value.startsWith("base64-")
      ? Buffer.from(
          (authCookie as { value: string }).value.slice("base64-".length),
          "base64",
        ).toString("utf8")
      : decodeURIComponent((authCookie as { value: string }).value);
    const accessToken = (JSON.parse(raw) as { access_token?: string })
      .access_token;

    const { apiUrl, publishableKey } = publicStackConfig();
    const response = await fetch(`${apiUrl}/functions/v1/create-download-url`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: publishableKey,
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ document_id: row.id }),
    });
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("Document not found");

    // Still there afterwards — a refusal that had deleted something would be a
    // different bug.
    expect(await storageObjectExists(row.fileKey)).toBe(true);
  });
});

test.describe("two sessions on one record", () => {
  test.use({ storageState: storageStateFor("agent") });

  test("uploads from two tabs both land", async ({ browser }) => {
    const context = await browser.newContext({
      storageState: storageStateFor("agent"),
    });
    const one = await context.newPage();
    const two = await context.newPage();
    const path = pathFor("lead", owners.agent);

    await one.goto(path);
    await two.goto(path);

    // Started together on purpose. Each upload gets its own signed key with a
    // fresh uuid, so nothing should collide — but the failure mode is silent
    // (one object overwriting the other, two rows resolving to the same bytes),
    // and only a second session can produce it: the panel disables its own input
    // while an upload is in flight, so a single tab cannot overlap two.
    await Promise.all([
      one.getByLabel("File").setInputFiles({
        name: "e2e-tab-one.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("from tab one"),
      }),
      two.getByLabel("File").setInputFiles({
        name: "e2e-tab-two.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("from tab two"),
      }),
    ]);

    // Settled means the spinner is gone and no error is showing — an observable
    // state, unlike "my row has appeared", which is the first thing this spec
    // asserted and the reason it was flaky. Two concurrent router.refresh()
    // calls against `next dev` are not guaranteed to land within any particular
    // window, and asserting that they do makes the spec about Next's refresh
    // timing rather than about two sessions colliding. It failed roughly one run
    // in three that way, and passed three for three in isolation, which is
    // exactly the shape of a spec measuring the wrong thing.
    for (const tab of [one, two]) {
      await expect(tab.getByText("Uploading…")).toBeHidden();
      await expect(tab.locator("p.text-destructive")).toHaveCount(0);
    }

    // Reloaded, so each tab is a fresh server render rather than a refresh
    // racing another tab's. This is the claim that matters: both uploads
    // survived, and neither tab is missing the other's work.
    for (const tab of [one, two]) {
      await tab.reload();
      await expect(tab.getByText("e2e-tab-one.txt")).toBeVisible();
      await expect(tab.getByText("e2e-tab-two.txt")).toBeVisible();
    }

    const [rowOne] = await documentRows("e2e-tab-one.txt");
    const [rowTwo] = await documentRows("e2e-tab-two.txt");
    // Distinct keys is the collision check: the file NAME is not part of the
    // storage key (the key ends in a uuid), so two uploads must never resolve to
    // one object.
    expect(rowOne.fileKey).not.toBe(rowTwo.fileKey);

    // Polled rather than read once. A list() on a prefix immediately after a PUT
    // is a read-after-write question about Storage, not about this panel, and a
    // single read turned that into a failure indistinguishable from a lost file.
    for (const row of [rowOne, rowTwo]) {
      await expect
        .poll(async () => storageObjectExists(row.fileKey), { timeout: 10_000 })
        .toBe(true);
    }

    await context.close();
  });

  test("three uploads in quick succession all land", async ({ page }) => {
    await page.goto(pathFor("pre_app", owners.agent));

    // Sequential rather than concurrent, because that is what the UI allows —
    // the input is disabled while an upload is in flight. What is being checked
    // is that the panel comes back ready each time: an input left with a stale
    // value, or an isUploading flag that never clears, breaks the second upload
    // and not the first.
    for (const n of [1, 2, 3]) {
      await expect(page.getByLabel("File")).toBeEnabled();
      await page.getByLabel("File").setInputFiles({
        name: `e2e-rapid-${n}.txt`,
        mimeType: "text/plain",
        buffer: Buffer.from(`rapid ${n}`),
      });
      await expect(page.getByText(`e2e-rapid-${n}.txt`)).toBeVisible();
    }

    await page.reload();
    for (const n of [1, 2, 3]) {
      await expect(page.getByText(`e2e-rapid-${n}.txt`)).toBeVisible();
    }
  });
});
