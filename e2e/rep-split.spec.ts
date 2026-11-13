import { expect, test } from "@playwright/test";

import {
  PERSONAS,
  personaSplitRate,
  restorePersonaSplitRate,
  storageStateFor,
} from "./fixtures/seed";

/**
 * The rep's split rate on Manage Users (phase 4 of
 * docs/design/intake-and-reports.md, §0b.4), in a browser.
 *
 * What only a browser can show: that the inline cell renders the rate, edits
 * it through set_rep_split(), shows the RPC's refusal in words, and that the
 * column is on an admin-only page. The RPC's rules (admin-only, audit, bounds,
 * grants) are tests/rls/set-rep-split.test.ts.
 *
 * Edits the agent persona's rate and puts it back afterwards, so the specs
 * that run later see the default.
 */

test.use({ storageState: storageStateFor("admin") });

let original = 50;

test.beforeAll(async () => {
  original = await personaSplitRate("agent");
});

test.afterAll(async () => {
  await restorePersonaSplitRate("agent", original);
});

test("an admin changes a rep's split rate in place, and an out-of-range one is refused", async ({
  page,
}) => {
  const name = PERSONAS.agent.fullName;
  await page.goto("/admin/users");
  // By email: "E2E Agent" is also the start of "E2E Agent Two".
  const row = page.getByRole("row", { name: new RegExp(PERSONAS.agent.email) });
  await expect(row.getByText(`${original}%`, { exact: true })).toBeVisible();

  await row.getByRole("button", { name: `Change split rate for ${name}` }).click();
  const input = row.getByLabel(`Split rate for ${name}`);
  await input.fill("60");
  await row.getByRole("button", { name: "Save" }).click();
  await expect(row.getByText("the split rate must be between 0 and 50")).toBeVisible();
  expect(await personaSplitRate("agent")).toBe(original);

  await input.fill("46.5");
  await row.getByRole("button", { name: "Save" }).click();
  await expect(row.getByText("46.5%", { exact: true })).toBeVisible();
  expect(await personaSplitRate("agent")).toBe(46.5);
});

test.describe("as a rep", () => {
  test.use({ storageState: storageStateFor("agent") });

  test("the page with the rate column is not reachable", async ({ page }) => {
    await page.goto("/admin/users");
    await expect(page).not.toHaveURL(/\/admin\/users$/);
    await expect(page.getByRole("columnheader", { name: "Split" })).toHaveCount(0);
  });
});
