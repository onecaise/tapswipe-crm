import { expect, test } from "@playwright/test";

import { PERSONAS, storageStateFor } from "../fixtures/seed";
import { idsFor, service } from "./qa-stack";

/**
 * C2 (D-05). The busiest forms showed Postgres's own text when a save hit a
 * constraint. The one such case a rep can reach by typing: the pre-app
 * terminal step's tax rate is numeric(5,3) — at most 99.999 — while the
 * percent mask lets three whole digits through, and autosave writes what is
 * typed. The validator allows 0 to 100, so "100" passes it and then comes
 * back from the database as "numeric field overflow".
 *
 * The other five forms have no constraint a person can hit from the UI (their
 * inputs or client-side checks stop it first); the helper's mappings are pinned
 * in tests/unit/db-errors.test.ts instead. See qa/QA-REPORT.md, C2.
 */
test.use({ storageState: storageStateFor("agent") });

test.afterAll(async () => {
  const { preApp } = await idsFor(PERSONAS.agent.email, "agent");
  await service().from("pre_app_terminal").update({ tax_rate: null }).eq("pre_app_id", preApp);
});

test("C2 an out-of-range tax rate reads as a sentence, not Postgres text", async ({ page }) => {
  const { preApp } = await idsFor(PERSONAS.agent.email, "agent");
  await page.goto(`/pre-apps/${preApp}/edit?step=terminal`);
  const field = page.getByRole("textbox", { name: "Tax rate %" });
  await field.fill("100");

  await expect(page.getByText("A number is too large for this field.")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("body")).not.toContainText("numeric field overflow");
});
