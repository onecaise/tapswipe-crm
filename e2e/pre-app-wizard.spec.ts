import { expect, test, type Page } from "@playwright/test";

import {
  freshWizardDraft,
  preAppLocation,
  storageStateFor,
} from "./fixtures/seed";

/**
 * The pre-app wizard's address step, in a browser.
 *
 * submit_pre_app() refuses a pre-app with no business city and state
 * (20261013132000) — tests/rls/pre-app-state-machine.test.ts owns that, and
 * tests/unit/pre-app-location.test.ts owns the step schema's rules. What only a
 * browser shows is the WIRING: that the step's Next really greys out for each
 * missing or bad field, that it comes back when the address is complete, that
 * the rep can then walk the wizard to the submit step, and that a half-typed
 * address is still autosaved rather than held hostage by validation.
 *
 * Next is a link when the step is valid and a disabled <button> when it is not
 * (components/pre-app-wizard-shell.tsx), so "blocked" and "open" are two
 * different roles, not one element with an attribute.
 *
 * Each test starts from its own fresh draft (freshWizardDraft).
 */

test.use({ storageState: storageStateFor("agent") });

const city = (page: Page) => page.getByRole("textbox", { name: "City", exact: true });
const state = (page: Page) => page.getByRole("combobox", { name: "State", exact: true });
const nextBlocked = (page: Page) => page.getByRole("button", { name: "Next", exact: true });
const nextOpen = (page: Page) => page.getByRole("link", { name: "Next", exact: true });

async function openBusinessStep(page: Page, id: number): Promise<void> {
  await page.goto(`/pre-apps/${id}/edit?step=business`);
  await expect(city(page)).toBeVisible();
}

async function pickState(page: Page, code: string): Promise<void> {
  await state(page).fill(code);
  await state(page).press("Enter");
  await expect(state(page)).toHaveValue(code);
}

test("Next is disabled while the city is empty", async ({ page }) => {
  const id = await freshWizardDraft({ city: null, state: "TN" });
  await openBusinessStep(page, id);
  await expect(nextBlocked(page)).toBeDisabled();
  await expect(nextOpen(page)).toHaveCount(0);
});

test("Next is disabled while the state is empty", async ({ page }) => {
  const id = await freshWizardDraft({ city: "Nashville", state: null });
  await openBusinessStep(page, id);
  await expect(nextBlocked(page)).toBeDisabled();
  await expect(nextOpen(page)).toHaveCount(0);
});

test("Next is disabled while the city is a single character", async ({ page }) => {
  const id = await freshWizardDraft({ city: null, state: "TN" });
  await openBusinessStep(page, id);
  await city(page).fill("X");
  await expect(page.getByText("Enter a real city name")).toBeVisible();
  await expect(nextBlocked(page)).toBeDisabled();
});

test("a rep completes the address and walks the wizard to the submit step", async ({ page }) => {
  const id = await freshWizardDraft({ city: null, state: null });
  await openBusinessStep(page, id);
  await expect(nextBlocked(page)).toBeDisabled();

  await page.getByRole("textbox", { name: "Street address" }).fill("100 Market St");
  await city(page).fill("Chattanooga");
  await pickState(page, "TN");
  await expect(nextOpen(page)).toBeVisible();

  // Next through every step to review; each must be passable with the
  // business step complete, or this is not "reaching submit".
  for (const step of ["owners", "terminal", "profile", "secrets", "review"]) {
    await nextOpen(page).click();
    await expect(page).toHaveURL(new RegExp(`step=${step}`));
  }

  await expect(page.getByRole("button", { name: "Submit for review" })).toBeVisible();
  // Other things are still missing on a bare draft (owners, banking), but the
  // address is not one of them.
  await expect(page.getByText("A business city and state are required.")).toHaveCount(0);

  expect(await preAppLocation(id)).toEqual({ city: "Chattanooga", state: "TN" });
});

test("the review step lists a missing address as a blocker", async ({ page }) => {
  const id = await freshWizardDraft({ city: null, state: null });
  await page.goto(`/pre-apps/${id}/edit?step=review`);
  await expect(page.getByText("A business city and state are required.")).toBeVisible();
});

test("a half-finished address is still autosaved", async ({ page }) => {
  const id = await freshWizardDraft({ city: null, state: null });
  await openBusinessStep(page, id);

  await city(page).fill("Memphis");
  await expect(page.getByText(/^Saved /)).toBeVisible({ timeout: 10_000 });
  await expect(nextBlocked(page)).toBeDisabled();
  expect(await preAppLocation(id)).toEqual({ city: "Memphis", state: null });

  await page.reload();
  await expect(city(page)).toHaveValue("Memphis");
  await expect(nextBlocked(page)).toBeDisabled();
});
