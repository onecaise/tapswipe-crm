import { expect, test } from "@playwright/test";

import {
  CITY_FIXTURE,
  LEGACY_MERCHANT,
  merchantByMid,
  storageStateFor,
} from "./fixtures/seed";

/**
 * The merchant form around location, in a browser.
 *
 * tests/rls/merchant-location.test.ts owns the database rules — that a legacy
 * merchant stays editable, that a new one needs a location, that a location
 * cannot be removed. What only a browser shows is whether the FORM lets those
 * rules through: the first design's form demanded a city on every save, so
 * even with the database fixed, a legacy merchant would have been uneditable
 * from the only screen anyone uses.
 *
 * LEGACY_MERCHANT is written under the trigger by the seed (see
 * ensureLegacyMerchant) and put back to bare on every run, because nothing in
 * the app can make one any more.
 */

test.describe("an admin editing a merchant with no location", () => {
  // One shared row, put back to bare by the seed once per run: these three
  // walk it from bare to located, so they run in order.
  test.describe.configure({ mode: "serial" });
  test.use({ storageState: storageStateFor("admin") });

  test("says so prominently, and still saves other changes", async ({ page }) => {
    const before = await merchantByMid(LEGACY_MERCHANT.mid);
    expect(before).toMatchObject({ city: null, state: null, status: "active" });

    await page.goto(`/merchants/${before.id}/edit`);
    await expect(page.getByTestId("merchant-missing-location")).toBeVisible();
    // Optional here, so not marked required and not starred.
    await expect(page.getByLabel("City", { exact: true })).not.toHaveAttribute("required", "");
    await expect(page.getByLabel("State", { exact: true })).toBeVisible();

    await page.getByLabel("Status").selectOption("inactive");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(new RegExp(`/merchants/${before.id}$`));
    await expect(page.getByText("Not recorded — edit to add")).toBeVisible();

    const after = await merchantByMid(LEGACY_MERCHANT.mid);
    expect(after).toMatchObject({ city: null, state: null, status: "inactive" });
  });

  test("validates the location if one is started", async ({ page }) => {
    const { id } = await merchantByMid(LEGACY_MERCHANT.mid);
    await page.goto(`/merchants/${id}/edit`);

    await page.getByLabel("City", { exact: true }).fill("Burlington");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Pick the merchant's state, or clear the city.")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/merchants/${id}/edit$`));

    await page.getByLabel("City", { exact: true }).fill("..");
    await page.getByLabel("State", { exact: true }).selectOption("VT");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Enter a real city name.")).toBeVisible();

    expect(await merchantByMid(LEGACY_MERCHANT.mid)).toMatchObject({ city: null, state: null });
  });

  test("saves a location once both are given, and the notice goes", async ({ page }) => {
    const { id } = await merchantByMid(LEGACY_MERCHANT.mid);
    await page.goto(`/merchants/${id}/edit`);
    await page.getByLabel("City", { exact: true }).fill("Burlington");
    await page.getByLabel("State", { exact: true }).selectOption("VT");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(new RegExp(`/merchants/${id}$`));
    await expect(page.getByText("Burlington, VT")).toBeVisible();

    await page.goto(`/merchants/${id}/edit`);
    await expect(page.getByTestId("merchant-missing-location")).toHaveCount(0);
    await expect(page.getByLabel("City *")).toHaveAttribute("required", "");
  });
});

// The form rules below ran as the agent until 20261021120000 made merchants
// admin-only to change; the form only opens for an admin now, so they do too.
test.describe("an admin on the merchant form", () => {
  test.use({ storageState: storageStateFor("admin") });

  test("cannot create a merchant without a city and state", async ({ page }) => {
    await page.goto("/merchants/new");
    await expect(page.getByTestId("merchant-missing-location")).toHaveCount(0);
    await page.getByLabel("DBA *").fill("E2E Should Not Exist");
    await page.getByRole("button", { name: "Create merchant" }).click();
    // The browser's own required-field check stops it before any request.
    await expect(page).toHaveURL(/\/merchants\/new$/);
    expect(
      await page.getByLabel("City *").evaluate((el) => (el as HTMLInputElement).validity.valueMissing),
    ).toBe(true);
  });

  test("cannot clear the location of a merchant that has one", async ({ page }) => {
    const { id } = await merchantByMid(CITY_FIXTURE.own.mid);
    await page.goto(`/merchants/${id}/edit`);
    await page.getByLabel("City *").fill("   ");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Enter the merchant's city.")).toBeVisible();
    expect(await merchantByMid(CITY_FIXTURE.own.mid)).toMatchObject({
      city: CITY_FIXTURE.city,
      state: CITY_FIXTURE.state,
    });
  });
});

/**
 * Security fix phase 1 (docs/claude/security-fixes.md): a rep reads their
 * merchants and changes none of them. RLS is the boundary
 * (tests/rls/merchants-admin-only-writes.test.ts); what only a browser shows
 * is that the app does not offer a rep a form that could only fail.
 */
test.describe("an agent and their own merchant", () => {
  test.use({ storageState: storageStateFor("agent") });

  test("sees no Edit button, and is told to contact an admin", async ({ page }) => {
    const { id } = await merchantByMid(CITY_FIXTURE.own.mid);
    await page.goto(`/merchants/${id}`);
    await expect(page.getByText("To change this merchant, contact an admin.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Print" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Edit" })).toHaveCount(0);
  });

  test("is sent away from the edit and new-merchant routes", async ({ page }) => {
    const { id } = await merchantByMid(CITY_FIXTURE.own.mid);
    await page.goto(`/merchants/${id}/edit`);
    await expect(page).toHaveURL(/\/dashboard$/);

    await page.goto("/merchants/new");
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test("sees no New merchant button on the list", async ({ page }) => {
    await page.goto("/merchants");
    await expect(page.getByRole("heading", { name: "Merchants" })).toBeVisible();
    await expect(page.getByRole("link", { name: "New merchant" })).toHaveCount(0);
  });
});

test.describe("an admin on the merchant pages", () => {
  test.use({ storageState: storageStateFor("admin") });

  test("still gets Edit and New merchant, and no contact-an-admin line", async ({ page }) => {
    const { id } = await merchantByMid(CITY_FIXTURE.own.mid);
    await page.goto(`/merchants/${id}`);
    await expect(page.getByRole("link", { name: "Edit" })).toBeVisible();
    await expect(page.getByText("To change this merchant, contact an admin.")).toHaveCount(0);

    await page.goto("/merchants");
    await expect(page.getByRole("link", { name: "New merchant" })).toBeVisible();
  });
});
