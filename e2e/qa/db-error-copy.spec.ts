import { expect, test } from "@playwright/test";

import { PERSONAS, storageStateFor } from "../fixtures/seed";
import { idsFor, service } from "./qa-stack";

/**
 * C2 (D-05), updated for D-12. The pre-app terminal step's tax rate is
 * numeric(5,3) — at most 99.999 — while the percent mask lets three whole
 * digits through. The validator used to allow 0 to 100, so "100" passed it,
 * autosave wrote it, and the database answered "numeric field overflow" (C2
 * turned that into "A number is too large for this field.").
 *
 * Since D-12 the validator's ceiling is the column's: "100" is refused in the
 * form with its own sentence, and autosave leaves a refused rate out of the
 * write, so no Postgres text and no database error appear at all. 22003's
 * plain wording is still pinned in tests/unit/db-errors.test.ts.
 *
 * The other five forms have no constraint a person can hit from the UI (their
 * inputs or client-side checks stop it first). See qa/QA-REPORT.md, C2.
 */
test.use({ storageState: storageStateFor("agent") });

test.afterAll(async () => {
  const { preApp } = await idsFor(PERSONAS.agent.email, "agent");
  await service().from("pre_app_terminal").update({ tax_rate: null }).eq("pre_app_id", preApp);
});

async function storedTaxRate(preApp: number) {
  const { data } = await service()
    .from("pre_app_terminal").select("tax_rate").eq("pre_app_id", preApp).maybeSingle();
  return data?.tax_rate ?? null;
}

test("C2/D-12 a tax rate of 100 is refused in the form, not by the database", async ({ page }) => {
  const { preApp } = await idsFor(PERSONAS.agent.email, "agent");
  await service().from("pre_app_terminal").update({ tax_rate: null }).eq("pre_app_id", preApp);
  await page.goto(`/pre-apps/${preApp}/edit?step=terminal`);
  const field = page.getByRole("textbox", { name: "Tax rate %" });
  await field.fill("100");

  await expect(page.getByText("Tax rate must be between 0 and 99.999")).toBeVisible();
  // Past the 2s autosave debounce, nothing reached the database.
  await page.waitForTimeout(3_500);
  await expect(page.locator("body")).not.toContainText("numeric field overflow");
  await expect(page.locator("body")).not.toContainText("A number is too large for this field.");
  expect(await storedTaxRate(preApp)).toBeNull();
});

// The form cannot enter 99.999: maskPercent keeps two decimals (left as it is,
// by instruction), so 99.99 is the largest rate a person can type and is the
// accepted edge here. 99.999 itself is pinned in tests/unit/tax-rate.test.ts.
test("D-12 the largest typeable tax rate below the ceiling is accepted and saved", async ({ page }) => {
  const { preApp } = await idsFor(PERSONAS.agent.email, "agent");
  await page.goto(`/pre-apps/${preApp}/edit?step=terminal`);
  const field = page.getByRole("textbox", { name: "Tax rate %" });
  await field.fill("99.99");

  await expect.poll(() => storedTaxRate(preApp), { timeout: 15_000 }).toBe(99.99);
  await expect(page.getByText("Tax rate must be between 0 and 99.999")).toHaveCount(0);
});
