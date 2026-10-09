import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { storageStateFor } from "../fixtures/seed";

/**
 * QA-006. The cart's totals are a <dl>, and the "Prices are taken from the
 * catalog when the proposal is saved" note sat inside it as a bare <p>. A <dl>
 * may only hold dt/dd groups, so assistive tech that walks the list as
 * term/definition pairs meets an orphan — axe `definition-list` (serious) on
 * /proposals/new for every rep.
 */
test.use({ storageState: storageStateFor("agent") });

test("QA-006 the cart totals are a well-formed definition list", async ({ page }) => {
  await page.goto("/proposals/new");
  await expect(page.getByText("Prices are taken from the catalog")).toBeVisible();
  const result = await new AxeBuilder({ page })
    .withRules(["definition-list", "dlitem"])
    .analyze();
  expect(result.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(" ")}`))).toEqual([]);
});
