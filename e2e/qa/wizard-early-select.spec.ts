import { expect, test, type Request } from "@playwright/test";

import { freshWizardDraft, storageStateFor } from "../fixtures/seed";
import { service } from "./qa-stack";

/**
 * A wizard select changed in the first moment after a step loads must keep
 * the choice (phase 1 build note in docs/design/intake-and-reports.md, fixed in
 * phase 4).
 *
 * The defect: the step is server-rendered, so its controls are on screen and
 * usable BEFORE React hydrates. A select changed in that window was then reset
 * by react-hook-form's register() ref, which writes the loaded value back into
 * the DOM as it registers; React's replay of the early change event then read
 * that reset value and autosave PATCHed it -- billing_type: null.
 *
 * Deliberately NO waitForLoadState here: the whole point is to act as early as
 * Playwright can, which is what e2e/processor-select.spec.ts had to avoid.
 */

test.use({ storageState: storageStateFor("agent") });

async function billingType(id: number): Promise<string | null> {
  const { data, error } = await service()
    .from("pre_apps")
    .select("billing_type")
    .eq("id", id)
    .single();
  if (error) throw new Error(error.message);
  return data.billing_type as string | null;
}

for (const attempt of [1, 2, 3]) {
  test(`a select changed straight after the step loads keeps the choice (${attempt})`, async ({
    page,
  }) => {
    const id = await freshWizardDraft({ city: "Nashville", state: "TN" });
    const patches: string[] = [];
    page.on("request", (request: Request) => {
      if (request.method() === "PATCH" && request.url().includes("/rest/v1/pre_apps")) {
        patches.push(request.postData() ?? "");
      }
    });

    await page.goto(`/pre-apps/${id}/edit?step=business`, { waitUntil: "commit" });
    const select = page.getByRole("combobox", { name: "Billing type", exact: true });
    await select.selectOption("net");

    // The choice holds on screen and reaches the database, and no save ever
    // wrote it back as null.
    await expect(select).toHaveValue("net");
    await expect(page.getByText(/^Saved /)).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => billingType(id)).toBe("net");
    expect(patches.some((body) => body.includes('"billing_type":null'))).toBe(false);

    await page.reload();
    await expect(
      page.getByRole("combobox", { name: "Billing type", exact: true }),
    ).toHaveValue("net");
  });
}
