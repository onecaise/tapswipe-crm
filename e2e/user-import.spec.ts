import { expect, test } from "@playwright/test";

import {
  PERSONAS,
  clearImportedUsers,
  importedProfiles,
  storageStateFor,
} from "./fixtures/seed";

/**
 * Bulk rep import, driven in a real browser.
 *
 * What belongs here and nothing else: the parts a person could only find by
 * looking. The parsing rules are covered by 46 unit tests, the policies by 22
 * PGlite tests, and both Edge Functions by 32 live tests — a browser copy of any
 * of that would be a slower, flakier duplicate.
 *
 * Three things genuinely need the browser:
 *
 *   1. **<input type="file">.** The upload reads the CSV with File.text() in the
 *      browser and posts the string. Nothing below the browser exercises that.
 *   2. **The credential message.** "Accounts created, nobody can sign in yet"
 *      is a hard requirement of this feature, and a requirement that lives in
 *      rendered text can only be checked by rendering it.
 *   3. **That no password appears.** provision-user-batch returns none — a live
 *      test asserts that against the response body — but the UI could still
 *      reintroduce one. This asserts the rendered page, which is the layer the
 *      live test cannot see.
 */

test.use({ storageState: storageStateFor("admin") });

const FILE_NAME = "e2e-reps.csv";

/** Unique per run, so a leftover account from a failed run cannot mask a bug. */
const stamp = Date.now();
const NEW_ONE = `e2e-import-a-${stamp}@tapswipe.test`;
const NEW_TWO = `e2e-import-b-${stamp}@tapswipe.test`;

const CSV = [
  "Full name,Email,Role,Agent #",
  `Import One,${NEW_ONE},agent,`,
  `Import Two,${NEW_TWO},admin,`,
  // A rep who already exists: skipped, and the batch still runs.
  `Already Here,${PERSONAS.agent.email},agent,`,
].join("\n");

const ALL_EMAILS = [NEW_ONE, NEW_TWO];

test.afterAll(async () => {
  await clearImportedUsers(ALL_EMAILS, [FILE_NAME, "e2e-blocked.csv"]);
});

/** Picks a file without touching disk — setInputFiles accepts a buffer. */
async function upload(page: import("@playwright/test").Page, csv: string, name = FILE_NAME) {
  await page.goto("/admin/users/import");
  await page.setInputFiles('input[type="file"]', {
    name,
    mimeType: "text/csv",
    buffer: Buffer.from(csv, "utf8"),
  });
  await page.getByRole("button", { name: "Upload" }).click();
  await page.waitForURL(/\/admin\/users\/import\/\d+$/);
}

test("uploads a CSV, reviews it, creates the accounts, and says they cannot sign in yet", async ({
  page,
}) => {
  await upload(page, CSV);

  // --- review -------------------------------------------------------------
  await expect(page.getByText("Rows in the file")).toBeVisible();
  // Two new, one already has an account.
  await expect(page.getByText("Will be created")).toBeVisible();
  await expect(page.getByText("Already have accounts")).toBeVisible();
  // Scoped to the skipped-rows list rather than the bare address, which also
  // appears in the row table below it.
  await expect(
    page.getByText(new RegExp(`Row 4 — ${PERSONAS.agent.email} already has an account`)),
  ).toBeVisible();

  // --- run ----------------------------------------------------------------
  await page.getByRole("button", { name: "Create the accounts" }).click();
  await page.getByRole("button", { name: "Create accounts" }).click();

  // --- the credential message, which is a hard requirement -----------------
  const banner = page.getByText(/accounts? created — and nobody can sign in yet/i);
  await expect(banner).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Reset password/)).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Go to Manage Users/i }),
  ).toBeVisible();

  // --- and no credential anywhere on the page ------------------------------
  // Deliberately reads the whole rendered document rather than a region: the
  // claim is that nothing anywhere offers a password, so scoping it to a region
  // would be assuming the answer.
  const body = (await page.locator("body").innerText()).toLowerCase();
  expect(body).not.toContain("temporary password");
  expect(body).not.toContain("copy password");
  // NOT a check for the word "credentials": the page says "a list of
  // credentials is not something to hand out in bulk", which is the feature
  // explaining itself. Asserting on the word failed here, correctly, and the
  // lesson is that the requirement is about an AFFORDANCE rather than
  // vocabulary — so check for the affordance instead.
  await expect(page.getByRole("button", { name: /copy/i })).toHaveCount(0);
  // "Reset password" is the pointer to Manage Users and is expected; a password
  // VALUE is not. The generated alphabet is 20 characters of mixed case and
  // digits with no ambiguous glyphs, so a run of exactly that shape is the
  // thing to refuse.
  expect(body).not.toMatch(/\b[A-Za-z2-9]{20}\b/);

  // --- what actually landed in the database --------------------------------
  const profiles = await importedProfiles(ALL_EMAILS);
  expect(profiles).toHaveLength(2);
  // Every account is forced onto a password change, which is what makes the
  // "cannot sign in yet" claim true rather than a slogan.
  expect(profiles.every((p) => p.must_change_password)).toBe(true);
  expect(profiles.find((p) => p.email === NEW_TWO)?.role).toBe("admin");

  // --- the row table reports each outcome ----------------------------------
  await expect(page.getByText("What happened to each row")).toBeVisible();
  await expect(page.getByText("Skipped").first()).toBeVisible();
});

test("refuses to run while the file still has problems", async ({ page }) => {
  // A blocked row stops everything, so a file the admin must still correct is
  // never half-imported.
  const blocked = [
    "Full name,Email,Role,Agent #",
    `Fine Person,e2e-import-fine-${stamp}@tapswipe.test,agent,`,
    ",e2e-import-noname@tapswipe.test,agent,",
  ].join("\n");

  await upload(page, blocked, "e2e-blocked.csv");

  await expect(page.getByText("Problems in the file")).toBeVisible();
  // The per-row detail, not the group heading or the status pill -- all three
  // carry the same words.
  await expect(page.getByText("Row 3 — This row has no name.")).toBeVisible();
  // The run affordance is absent entirely rather than present-and-disabled: a
  // disabled button invites clicking and explains nothing.
  await expect(
    page.getByRole("button", { name: /Create the accounts/i }),
  ).toHaveCount(0);
});

test("reports a file it cannot read at all, without creating a batch", async ({
  page,
}) => {
  await page.goto("/admin/users/import");
  await page.setInputFiles('input[type="file"]', {
    name: "e2e-wrong-columns.csv",
    mimeType: "text/csv",
    // Omits Email but keeps Full name, so the message is the singular form.
    // Dropping both would report "missing columns: Full name, Email".
    buffer: Buffer.from("Full name,Role\nAvery,agent", "utf8"),
  });
  await page.getByRole("button", { name: "Upload" }).click();

  // The function's own message, naming the missing column — not the generic
  // "Edge Function returned a non-2xx status code".
  await expect(page.getByText(/missing a column: Email/i)).toBeVisible();
  // Still on the list page: a file that could not be parsed leaves no batch
  // behind, because the text IS the payload and a batch with nothing to review
  // is not worth keeping.
  await expect(page).toHaveURL(/\/admin\/users\/import$/);
});
