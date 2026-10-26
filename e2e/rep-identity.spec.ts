import { expect, test, type Page } from "@playwright/test";

import {
  clearImportedUsers,
  importedProfiles,
  storageStateFor,
} from "./fixtures/seed";

/**
 * Rep identity (phase 2 of docs/design/intake-and-reports.md), in a browser.
 *
 * What only a browser can show: that the create-user form actually sends the
 * two fields, and that the Manage Users cell renders the pair, edits it in
 * place through set_rep_identity(), and drops the "can't submit pre-apps yet"
 * marker once both are set. The RPC's rules are tests/rls; the functions'
 * handling is tests/live.
 *
 * Each test makes its own account with a unique address, so no persona's
 * identity is changed for the specs that run after this one.
 */

test.use({ storageState: storageStateFor("admin") });

const stamp = Date.now();
const WITH_NAMES = `e2e-identity-a-${stamp}@tapswipe.test`;
const WITHOUT_NAMES = `e2e-identity-b-${stamp}@tapswipe.test`;

test.afterAll(async () => {
  await clearImportedUsers([WITH_NAMES, WITHOUT_NAMES], []);
});

async function createUser(
  page: Page,
  fullName: string,
  email: string,
  names?: { legal: string; llc: string },
) {
  await page.goto("/admin/users/new");
  await page.getByLabel("Full name").fill(fullName);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("One-time password").fill("e2e-identity-pass");
  if (names) {
    await page.getByLabel("Legal name (optional)", { exact: true }).fill(names.legal);
    await page.getByLabel("LLC legal name (optional)").fill(names.llc);
  }
  await page.getByRole("button", { name: "Create user" }).click();
  await expect(page.getByText(`Account created for ${email}`)).toBeVisible({
    timeout: 20_000,
  });
}

test("the create-user screen stores both legal names, and Manage Users shows them", async ({
  page,
}) => {
  const fullName = `E2E Identity A ${stamp}`;
  await createUser(page, fullName, WITH_NAMES, {
    legal: "  Ann Q. Ito ",
    llc: "Ito Payments LLC",
  });

  const [profile] = await importedProfiles([WITH_NAMES]);
  expect(profile).toMatchObject({
    legal_name: "Ann Q. Ito",
    llc_legal_name: "Ito Payments LLC",
  });

  await page.goto("/admin/users");
  const row = page.getByRole("row", { name: new RegExp(fullName) });
  await expect(row.getByText("Ann Q. Ito", { exact: true })).toBeVisible();
  await expect(row.getByText("Ito Payments LLC", { exact: true })).toBeVisible();
  await expect(row.getByText("can't submit pre-apps yet")).toHaveCount(0);
});

test("Manage Users sets a rep's legal names in place and clears the can't-submit marker", async ({
  page,
}) => {
  const fullName = `E2E Identity B ${stamp}`;
  await createUser(page, fullName, WITHOUT_NAMES);

  await page.goto("/admin/users");
  const row = page.getByRole("row", { name: new RegExp(fullName) });
  await expect(row.getByText("can't submit pre-apps yet")).toBeVisible();

  await row
    .getByRole("button", { name: `Set legal names for ${fullName}` })
    .click();
  await row.getByLabel(`Legal name for ${fullName}`, { exact: true }).fill("Bo Lee");
  await row.getByLabel(`LLC legal name for ${fullName}`).fill("Bo Lee");
  await row.getByRole("button", { name: "Save" }).click();

  // A rep with no LLC has their own legal name in both (memo A16).
  await expect(row.getByText("Bo Lee", { exact: true })).toHaveCount(2);
  await expect(row.getByText("can't submit pre-apps yet")).toHaveCount(0);

  const [profile] = await importedProfiles([WITHOUT_NAMES]);
  expect(profile).toMatchObject({
    legal_name: "Bo Lee",
    llc_legal_name: "Bo Lee",
  });
});
