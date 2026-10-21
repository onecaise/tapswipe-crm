import { expect, test } from "@playwright/test";

import { PERSONAS, storageStateFor } from "./fixtures/seed";
import { service } from "./qa/qa-stack";

/**
 * The owner picker on the admin's merchant form (security fix phase 1
 * follow-up). tests/rls/merchants-admin-only-writes.test.ts owns the rules --
 * who may set agent_id, the audit row, that payouts and shares are untouched.
 * What only a browser shows: that the form makes the admin choose, offers
 * reps by name and Agent #, and that the merchant really changes book.
 */

const DBA = "E2E Owner Picker Co";

async function profileId(email: string): Promise<string> {
  const { data, error } = await service().from("profiles").select("id").eq("email", email).single();
  if (error) throw new Error(error.message);
  return data.id as string;
}

async function picked(): Promise<{ id: number; agent_id: string } | null> {
  const { data } = await service().from("merchants").select("id, agent_id").eq("dba", DBA).maybeSingle();
  return (data as { id: number; agent_id: string } | null) ?? null;
}

async function clear(): Promise<void> {
  await service().from("merchants").delete().eq("dba", DBA);
}

test.describe("an admin chooses who owns a merchant", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ storageState: storageStateFor("admin") });

  test.beforeAll(clear);
  test.afterAll(clear);

  test("New merchant makes the admin pick an owner; there is no default", async ({ page }) => {
    await page.goto("/merchants/new");
    const owner = page.getByLabel("Owner *");
    await expect(owner).toHaveValue("");
    await expect(owner.locator("option", { hasText: "E2E Agent Two (Agent # 9003)" })).toHaveCount(1);
    await expect(owner.locator("option", { hasText: "E2E Admin (you)" })).toHaveCount(1);

    await page.getByLabel("DBA *").fill(DBA);
    await page.getByLabel("City *").fill("Nashville");
    await page.getByLabel("State *").selectOption("TN");
    await page.getByRole("button", { name: "Create merchant" }).click();
    await expect(page).toHaveURL(/\/merchants\/new$/);
    expect(await owner.evaluate((el) => (el as HTMLSelectElement).validity.valueMissing)).toBe(true);
    expect(await picked()).toBeNull();
  });

  test("creates the merchant in the chosen rep's book", async ({ page }) => {
    await page.goto("/merchants/new");
    await page.getByLabel("Owner *").selectOption({ label: "E2E Agent Two (Agent # 9003)" });
    await page.getByLabel("DBA *").fill(DBA);
    await page.getByLabel("City *").fill("Nashville");
    await page.getByLabel("State *").selectOption("TN");
    await page.getByRole("button", { name: "Create merchant" }).click();
    await expect(page).toHaveURL(/\/merchants\/\d+$/);

    expect((await picked())?.agent_id).toBe(await profileId(PERSONAS.agent2.email));
  });

  test("reassigns it on Edit; the old owner loses it and the new owner gains it", async ({ page, browser }) => {
    const before = await picked();
    await page.goto(`/merchants/${before!.id}/edit`);
    const owner = page.getByLabel("Owner *");
    await expect(owner).toHaveValue(before!.agent_id);
    await owner.selectOption({ label: "E2E Agent (Agent # 9002)" });
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page).toHaveURL(new RegExp(`/merchants/${before!.id}$`));

    expect((await picked())?.agent_id).toBe(await profileId(PERSONAS.agent.email));

    for (const [persona, sees] of [["agent", true], ["agent2", false]] as const) {
      const context = await browser.newContext({ storageState: storageStateFor(persona) });
      const view = await context.newPage();
      await view.goto(`/merchants/${before!.id}`);
      await expect(view.getByRole("heading", { name: DBA })).toHaveCount(sees ? 1 : 0);
      await context.close();
    }
  });
});
