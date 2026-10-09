import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { storageStateFor } from "../fixtures/seed";

/**
 * QA-007. `--muted-foreground` (#8A8A93) is the colour of every label, hint,
 * table header and secondary line in the app, and it measures 3.4:1 on a card,
 * 3.3:1 on the page background and 3.0:1 on the muted chips — under the 4.5:1
 * WCAG AA asks for normal-size text. axe flagged `color-contrast` (serious) on
 * every route in the crawl, signed in or not.
 *
 * Pages chosen because muted text is most of what is on them: the login form
 * (seen by everyone), a list page with filter chips, and a form full of labels.
 */
const pages: { path: string; who: "agent" | null }[] = [
  { path: "/auth/login", who: null },
  { path: "/leads", who: "agent" },
  { path: "/tasks", who: "agent" },
  { path: "/leads/new", who: "agent" },
];

for (const { path, who } of pages) {
  test.describe(path, () => {
    test.use({ storageState: who ? storageStateFor(who) : { cookies: [], origins: [] } });

    test(`QA-007 muted text on ${path} meets AA contrast`, async ({ page }) => {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const result = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze();
      const failures = result.violations.flatMap((v) =>
        v.nodes.map((n) => `${n.target.join(" ")} — ${n.any[0]?.message ?? ""}`),
      );
      expect(failures).toEqual([]);
    });
  });
}
