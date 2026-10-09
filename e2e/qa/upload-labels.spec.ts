import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { storageStateFor } from "../fixtures/seed";

/**
 * QA-005. The two admin import pages put a bare <input type="file"> beside a
 * paragraph of instructions, with no label — axe `label` (critical). A screen
 * reader announced it as "Choose File, button" with nothing saying which file
 * it wanted. The documents and marketing uploads already label theirs.
 */
test.use({ storageState: storageStateFor("admin") });

for (const [path, name] of [
  ["/payouts/import", "Residual report (XLSX)"],
  ["/admin/users/import", "Rep list (CSV)"],
] as const) {
  test(`QA-005 the file input on ${path} has an accessible name`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByLabel(name)).toHaveAttribute("type", "file");
    const result = await new AxeBuilder({ page }).withRules(["label"]).analyze();
    expect(result.violations.flatMap((v) => v.nodes.map((n) => n.target.join(" ")))).toEqual([]);
  });
}
