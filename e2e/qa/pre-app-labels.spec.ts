import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { PERSONAS, storageStateFor } from "../fixtures/seed";
import { idsFor } from "./qa-stack";

/**
 * QA-004. Every field on the pre-app wizard rendered its <Label> as a sibling
 * of the input with no htmlFor/id pairing, so no input had an accessible name:
 * a screen reader announced "edit text" for the DBA name, the SSN, the routing
 * number and the account number alike, and clicking a label focused nothing.
 * axe reports it as `label` (critical) and the billing-type <select> as
 * `select-name` (critical).
 *
 * The claim, per step: no `label` / `select-name` violations, and the fields a
 * person would look for by name are reachable by that name.
 */
test.use({ storageState: storageStateFor("agent") });

const STEPS = ["business", "owners", "terminal", "profile", "secrets"] as const;

test("QA-004 every pre-app wizard field has an accessible name", async ({ page }) => {
  const { preApp } = await idsFor(PERSONAS.agent.email, "agent");

  for (const step of STEPS) {
    await page.goto(`/pre-apps/${preApp}/edit?step=${step}`);
    await page.waitForLoadState("networkidle");
    const result = await new AxeBuilder({ page })
      .withRules(["label", "select-name"])
      .analyze();
    const where = result.violations.flatMap((v) =>
      v.nodes.map((n) => `${v.id}: ${n.target.join(" ")}`),
    );
    expect(where, `step ${step}`).toEqual([]);
  }

  await page.goto(`/pre-apps/${preApp}/edit?step=business`);
  await expect(page.getByRole("textbox", { name: "DBA name" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Billing type" })).toBeVisible();

  await page.goto(`/pre-apps/${preApp}/edit?step=secrets`);
  await expect(page.getByRole("textbox", { name: "ABA routing number" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Account number" })).toBeVisible();
  await expect(page.getByLabel("RP password")).toBeVisible();
});
