import { expect, test, type Page } from "@playwright/test";

import {
  freshWizardDraft,
  missingFieldsAsAgent,
  personaSplitRate,
  preAppLocation,
  storageStateFor,
  submitAsAgent,
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
 *
 * Phase 4 (20261028120000): the review step's list IS pre_app_missing_fields(),
 * the function submit_pre_app() refuses with; the city and state are two
 * codes of it now ("A business city is required." / "A two-letter business
 * state is required."), where they used to be one combined sentence.
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
  const list = page.getByRole("list", { name: "Missing before submit" });
  await expect(list).toBeVisible();
  await expect(list.locator('[data-code="city"]')).toHaveCount(0);
  await expect(list.locator('[data-code="state"]')).toHaveCount(0);
  await expect(list.locator('[data-code="physical_address"]')).toHaveCount(0);

  expect(await preAppLocation(id)).toEqual({ city: "Chattanooga", state: "TN" });
});

test("the review step lists a missing address as a blocker", async ({ page }) => {
  const id = await freshWizardDraft({ city: null, state: null });
  await page.goto(`/pre-apps/${id}/edit?step=review`);
  await expect(page.getByText("A business city is required.")).toBeVisible();
  await expect(page.getByText("A two-letter business state is required.")).toBeVisible();
});

test("the review step shows exactly the list submit_pre_app() refuses with", async ({ page }) => {
  // The phase 4 property: one list. The page reads pre_app_missing_fields();
  // the refusal is built from the same call. So the codes on screen, the
  // function's codes and the refusal's DETAIL must be one list, in one order.
  const id = await freshWizardDraft({ city: null, state: "TN" });
  await page.goto(`/pre-apps/${id}/edit?step=review`);
  const items = page.getByRole("list", { name: "Missing before submit" }).locator("li");
  await expect(items.first()).toBeVisible();

  const onScreen = await items.evaluateAll((lis) =>
    lis.map((li) => li.getAttribute("data-code")),
  );
  const fromFunction = await missingFieldsAsAgent(id);
  expect(onScreen).toEqual(fromFunction.map((m) => m.code));
  for (const item of fromFunction) {
    await expect(page.getByText(item.label, { exact: false }).first()).toBeVisible();
  }

  const refusal = await submitAsAgent(id);
  expect(JSON.parse(refusal?.details ?? "[]")).toEqual(onScreen);
  for (const item of fromFunction) expect(refusal?.message).toContain(item.label);

  // And the button is held, with the same count in its heading.
  await expect(
    page.getByText(`${fromFunction.length} things are missing before this can be submitted:`),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Submit for review" })).toBeDisabled();
});

test("each step's link counts what is missing there", async ({ page }) => {
  const id = await freshWizardDraft({ city: null, state: "TN" });
  await page.goto(`/pre-apps/${id}/edit?step=business`);
  const fromFunction = await missingFieldsAsAgent(id);
  const business = fromFunction.filter((m) => m.step === "business").length;
  expect(business).toBeGreaterThan(0);
  await expect(
    page.getByRole("link", { name: `Business · ${business} missing` }),
  ).toBeVisible();
  // Terminal has no required item, so no badge.
  await expect(page.getByRole("link", { name: "Terminal", exact: true })).toBeVisible();
});

test("the business step fixes the country and shows the rep's split instead of asking", async ({ page }) => {
  const id = await freshWizardDraft({ city: "Nashville", state: "TN" });
  await openBusinessStep(page, id);
  await expect(page.getByText("United States", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Country" })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Agent split %" })).toHaveCount(0);

  const rate = await personaSplitRate("agent");
  await expect(
    page.getByText(`Rep ${rate}% · Company ${100 - rate}%`, { exact: true }),
  ).toBeVisible();
});

test("an owner SSN the SSA never issues is refused before it is sent", async ({ page }) => {
  // Phase 4: isSsn is the strict rule (000-00-0000 used to pass the shape).
  const id = await freshWizardDraft({ city: "Nashville", state: "TN" });
  await page.goto(`/pre-apps/${id}/edit?step=owners`);
  await page.getByRole("button", { name: "Add owner" }).click();
  await expect(page.getByText("Owner 1", { exact: true })).toBeVisible();
  await page.goto(`/pre-apps/${id}/edit?step=secrets`);

  const ssn = page.getByLabel(/^Owner #\d+$/);
  await ssn.fill("000000000");
  await expect(page.getByText("Nine digits, as 123-45-6789, in a range the SSA issues.")).toBeVisible();
  await expect(ssn).toHaveAttribute("aria-invalid", "true");
  await ssn.fill("123456789");
  await expect(page.getByText("Nine digits, as 123-45-6789, in a range the SSA issues.")).toHaveCount(0);
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
