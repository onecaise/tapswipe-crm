import { expect, test, type Page } from "@playwright/test";

import { freshWizardDraft, storageStateFor } from "./fixtures/seed";

/**
 * The one processor drop-down, in a browser (phase 1 of
 * docs/design/intake-and-reports.md).
 *
 * tests/rls/processors.test.ts owns the list, the grants and the foreign keys,
 * and tests/unit/processors.test.ts the option builder. What only a browser
 * shows is the wiring: that each form renders the TABLE's list (not a typed
 * field), and that the wizard's choice survives a reload, which means autosave
 * really wrote it to pre_apps.processor.
 */

const EXPECTED = ["Not set", "TSYS", "Red Fynn", "PayBright", "Netevia HQ", "Square"];

async function optionLabels(page: Page): Promise<string[]> {
  const select = page.getByRole("combobox", { name: "Processor", exact: true });
  await expect(select).toBeVisible();
  return select.locator("option").allTextContents();
}

test.describe("as a rep", () => {
  test.use({ storageState: storageStateFor("agent") });

  test("the wizard offers the list and keeps the choice across a reload", async ({ page }) => {
    const id = await freshWizardDraft({ city: "Nashville", state: "TN" });
    await page.goto(`/pre-apps/${id}/edit?step=business`);
    // Not decoration. Measured 23 Oct 2026, on this phase's code AND on the
    // code before it (billing type, with this phase stashed): a select changed
    // in the first moment after the step becomes visible is reset to its
    // loaded value and autosaved as NULL. Waiting for the network to settle
    // makes it hold, 3/3. Recorded as a pre-existing defect in the phase 1
    // notes of docs/design/intake-and-reports.md; this spec is not about it.
    // Fixed in phase 4 (the shell holds the step disabled until hydration);
    // e2e/qa/wizard-early-select.spec.ts is the regression test. The wait
    // stays, because this spec is still not about it.
    await page.waitForLoadState("networkidle");

    expect(await optionLabels(page)).toEqual(EXPECTED);
    const select = page.getByRole("combobox", { name: "Processor", exact: true });
    await expect(select).toHaveValue("");

    await select.selectOption("Square");
    await expect(page.getByText(/^Saved /)).toBeVisible({ timeout: 10_000 });

    await page.reload();
    await expect(
      page.getByRole("combobox", { name: "Processor", exact: true }),
    ).toHaveValue("Square");
  });
});

test.describe("as an admin", () => {
  test.use({ storageState: storageStateFor("admin") });

  test("the new-merchant form offers the same list, not a text box", async ({ page }) => {
    await page.goto("/merchants/new");
    expect(await optionLabels(page)).toEqual(EXPECTED);
    await expect(page.getByRole("textbox", { name: "Processor" })).toHaveCount(0);
  });
});
