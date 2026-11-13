import { expect, test, type Page } from "@playwright/test";

import { PERSONAS, storageStateFor } from "./fixtures/seed";
import { service } from "./qa/qa-stack";

/**
 * The merchant's split rate in the browser (phase 8 of
 * docs/design/intake-and-reports.md, covered in phase 9), and the default
 * rate a hand-made merchant takes (A31).
 *
 * tests/rls/commit-residual-import-v3.test.ts and
 * tests/rls/merchant-default-rate.test.ts own the rules. What only a browser
 * shows: that the Split control saves through set_merchant_split and shows
 * its refusals as sentences -- a rate out of range, and a rate change while a
 * shared-account split is live -- that a rep reads the rate and is offered no
 * control, that the owner picker shows the refusal to move a merchant with a
 * live share, and that a merchant made on the form shows its owner's rate.
 */

const PREFIX = "E2E Split ";

async function personaId(persona: keyof typeof PERSONAS): Promise<string> {
  const { data, error } = await service().from("profiles").select("id").eq("email", PERSONAS[persona].email).single();
  if (error) throw new Error(error.message);
  return data.id as string;
}

/** A merchant owned by the agent, made as the form makes one (no rate: it takes the owner's). */
async function makeMerchant(name: string): Promise<number> {
  const { data, error } = await service()
    .from("merchants")
    .insert({ agent_id: await personaId("agent"), dba: `${PREFIX}${name}`, city: "Nashville", state: "TN" })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return data.id as number;
}

/** A share starting next month: live, so it holds the rate and the owner. */
async function liveShare(merchantId: number): Promise<void> {
  const db = service();
  await db.from("merchants").update({ mid: `E2E-SPLIT-${merchantId}` }).eq("id", merchantId);
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  const { error } = await db.from("merchant_rep_shares").insert({
    merchant_id: merchantId,
    primary_agent_id: await personaId("agent"),
    secondary_agent_id: await personaId("agent2"),
    primary_rep_pct: 25,
    secondary_rep_pct: 25,
    effective_from: next,
  });
  if (error) throw new Error(error.message);
}

async function splitOf(merchantId: number): Promise<{ a: number | null; c: number | null; owner: string }> {
  const { data } = await service()
    .from("merchants")
    .select("split_agent_pct, split_company_pct, agent_id")
    .eq("id", merchantId)
    .single();
  return { a: data!.split_agent_pct, c: data!.split_company_pct, owner: data!.agent_id };
}

async function clear(): Promise<void> {
  const db = service();
  const { data } = await db.from("merchants").select("id").like("dba", `${PREFIX}%`);
  const ids = (data ?? []).map((m) => m.id as number);
  if (ids.length === 0) return;
  await db.from("merchant_rep_shares").delete().in("merchant_id", ids);
  await db.from("audit_log").delete().eq("table_name", "merchants").in("row_id", ids.map(String));
  await db.from("merchants").delete().in("id", ids);
}

const field = (page: Page, dba: string) => page.getByRole("button", { name: `Change split rate for ${dba}` });

test.beforeAll(clear);
test.afterAll(clear);

test.describe("as the admin", () => {
  test.use({ storageState: storageStateFor("admin") });

  test("a merchant made without a rate shows its owner's rate; the Split control changes it and audits it", async ({ page }) => {
    const id = await makeMerchant("Saves");
    const dba = `${PREFIX}Saves`;
    // The agent persona's profile rate, snapshotted at creation (A31).
    const { data: agent } = await service().from("profiles").select("split_rate_pct").eq("email", PERSONAS.agent.email).single();
    expect(await splitOf(id)).toMatchObject({ a: agent!.split_rate_pct, c: 100 - agent!.split_rate_pct });

    await page.goto(`/merchants/${id}`);
    await expect(field(page, dba)).toBeVisible();
    await field(page, dba).click();
    const input = page.getByLabel(`Split rate for ${dba}`);
    await input.fill("35.5");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(field(page, dba)).toBeVisible();
    await expect(page.getByText("35.5%", { exact: true })).toBeVisible();
    expect(await splitOf(id)).toMatchObject({ a: 35.5, c: 64.5 });
    const { data: audit } = await service()
      .from("audit_log").select("action").eq("table_name", "merchants").eq("row_id", String(id)).eq("action", "set_merchant_split");
    expect(audit).toHaveLength(1);
  });

  test("an out-of-range rate is refused with the database's sentence, and nothing changes", async ({ page }) => {
    const id = await makeMerchant("Range");
    const dba = `${PREFIX}Range`;
    const before = await splitOf(id);
    await page.goto(`/merchants/${id}`);
    await field(page, dba).click();
    await page.getByLabel(`Split rate for ${dba}`).fill("60");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("the split rate must be between 0 and 50")).toBeVisible();
    expect(await splitOf(id)).toEqual(before);
  });

  test("while a shared-account split is live, the rate change is refused with its sentence", async ({ page }) => {
    const id = await makeMerchant("Shared");
    const dba = `${PREFIX}Shared`;
    await liveShare(id);
    const before = await splitOf(id);
    await page.goto(`/merchants/${id}`);
    await field(page, dba).click();
    await page.getByLabel(`Split rate for ${dba}`).fill("40");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      page.getByText("This merchant has a shared-account split, which divides its current rate. End the share before changing the rate."),
    ).toBeVisible();
    expect(await splitOf(id)).toEqual(before);
  });

  test("the owner picker shows the refusal to move a merchant with a live share, and the owner stays", async ({ page }) => {
    const id = await makeMerchant("Moves");
    await liveShare(id);
    const before = await splitOf(id);
    await page.goto(`/merchants/${id}/edit`);
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Owner *").selectOption({ label: "E2E Agent Two (Agent # 9003)" });
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("This merchant has a shared-account split. End it before moving the merchant.")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/merchants/${id}/edit$`));
    expect((await splitOf(id)).owner).toBe(before.owner);
  });
});

test.describe("as the owner", () => {
  test.use({ storageState: storageStateFor("agent") });

  test("reads the rate as text, with no control", async ({ page }) => {
    const id = await makeMerchant("Rep View");
    await page.goto(`/merchants/${id}`);
    await expect(page.getByRole("heading", { name: `${PREFIX}Rep View` })).toBeVisible();
    await expect(page.getByRole("button", { name: /Change split rate/ })).toHaveCount(0);
    await expect(page.getByLabel(/Split rate for/)).toHaveCount(0);
  });
});
