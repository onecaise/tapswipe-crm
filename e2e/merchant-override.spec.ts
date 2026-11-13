import { expect, test, type Page } from "@playwright/test";

import {
  PERSONAS,
  overrideCardMerchant,
  overridesOn,
  setOverrideAsAdmin,
  storageStateFor,
} from "./fixtures/seed";
import { service } from "./qa/qa-stack";

/**
 * The merchant page's Override card (phase 10 of
 * docs/design/intake-and-reports.md, 20261102120000).
 *
 * tests/rls/merchant-overrides.test.ts owns the rules (the cap, the
 * recipient, the month rule, the audit). What only a browser shows: that the
 * card offers an admin the owner's manager by default and the worked example
 * of what the percent means, saves through set_merchant_override, refuses an
 * override above the merchant's rate before the round trip, shows the
 * database's own sentence when it refuses, changes an override by starting a
 * new one (the old one ended at that month), cancels an unused one -- and
 * that the owner's page has no card and no action at all.
 */

/** This month (UTC) as an <input type="month"> value and as words. */
function thisMonth(): { input: string; period: string; words: string } {
  const now = new Date();
  const input = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const words = now.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  return { input, period: `${input}-01`, words };
}

/** The month after this one. */
function nextMonth(): { input: string; period: string; words: string } {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const input = next.toISOString().slice(0, 7);
  const words = next.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  return { input, period: `${input}-01`, words };
}

async function personaId(persona: keyof typeof PERSONAS): Promise<string> {
  const { data, error } = await service().from("profiles").select("id").eq("email", PERSONAS[persona].email).single();
  if (error) throw new Error(error.message);
  return data.id as string;
}

const card = (page: Page) => page.getByTestId("merchant-override-card");

async function setOverride(page: Page, pct: string, month: string): Promise<void> {
  await card(page).getByLabel("Percent of the full residual").fill(pct);
  await card(page).getByLabel("First month it applies to").fill(month);
  await card(page).getByRole("button", { name: "Save override" }).click();
}

test.describe("as the admin", () => {
  test.use({ storageState: storageStateFor("admin") });

  test("sets one: the manager prefilled, the worked example shown, saved, audited and in force", async ({ page }) => {
    const id = await overrideCardMerchant("Set");
    const month = thisMonth();
    await page.goto(`/merchants/${id}`);

    await expect(card(page)).toBeVisible();
    await expect(card(page).getByTestId("merchant-override-in-force")).toHaveText("No override in force this month.");
    // The owner (E2E Agent) reports to E2E Agent Two: the default recipient.
    await expect(card(page).getByLabel("Paid to")).toHaveValue(await personaId("agent2"));
    await expect(card(page).getByRole("option", { name: "E2E Agent Two (manager)" })).toHaveCount(1);
    // Never the owner.
    await expect(card(page).getByRole("option", { name: PERSONAS.agent.fullName, exact: true })).toHaveCount(0);

    await card(page).getByLabel("Percent of the full residual").fill("10");
    await expect(card(page).getByTestId("override-problem")).toHaveText(
      "On a $100 residual: the recipient gets $10.00, the rep keeps $40.00 of the $50.00 rep side, and the company keeps $50.00.",
    );
    await setOverride(page, "10", month.input);

    await expect(card(page).getByTestId("merchant-override-in-force")).toHaveText(
      `In force: 10% of residual to ${PERSONAS.agent2.fullName}, from ${month.words}.`,
    );
    await expect(card(page).getByTestId("merchant-override-row")).toHaveCount(1);
    expect(await overridesOn(id)).toEqual([
      { recipient_id: await personaId("agent2"), override_pct: 10, effective_from: month.period, effective_to: null },
    ]);
    const { data: saved } = await service().from("merchant_overrides").select("id").eq("merchant_id", id).single();
    const { data: audit } = await service()
      .from("audit_log").select("action, actor_id")
      .eq("table_name", "merchant_overrides").eq("row_id", String(saved!.id));
    expect(audit).toEqual([{ action: "set_merchant_override", actor_id: await personaId("admin") }]);
  });

  test("refuses above the merchant's rate before the round trip, and nothing is saved", async ({ page }) => {
    const id = await overrideCardMerchant("Cap");
    await page.goto(`/merchants/${id}`);
    await card(page).getByLabel("Percent of the full residual").fill("50.01");
    await card(page).getByLabel("First month it applies to").fill(thisMonth().input);
    await expect(card(page).getByTestId("override-problem")).toHaveText(
      "An override comes out of the rep side, so it cannot be more than this merchant's rate: 50.",
    );
    await expect(card(page).getByRole("button", { name: "Save override" })).toBeDisabled();
    expect(await overridesOn(id)).toEqual([]);
  });

  test("changes it by starting a new one (the old one ends that month); the database's refusal is shown as said", async ({ page }) => {
    const id = await overrideCardMerchant("Change");
    const now = thisMonth();
    const next = nextMonth();
    await page.goto(`/merchants/${id}`);
    await setOverride(page, "10", now.input);
    await expect(card(page).getByTestId("merchant-override-row")).toHaveCount(1);

    // The form now says "Change"; a new start ends the open override.
    await expect(card(page).getByRole("heading", { name: "Change the override" })).toBeVisible();
    await card(page).getByLabel("Paid to").selectOption({ label: PERSONAS.agent3.fullName });
    await setOverride(page, "7.5", next.input);
    await expect(card(page).getByTestId("merchant-override-row")).toHaveCount(2);
    expect(await overridesOn(id)).toEqual([
      { recipient_id: await personaId("agent2"), override_pct: 10, effective_from: now.period, effective_to: next.period },
      { recipient_id: await personaId("agent3"), override_pct: 7.5, effective_from: next.period, effective_to: null },
    ]);

    // Starting another one in the same month as the open one: refused by the
    // database, its sentence shown, nothing changed.
    await setOverride(page, "5", next.input);
    await expect(
      card(page).getByText(`This merchant already has an override starting ${next.words}. Cancel or end that one first.`),
    ).toBeVisible();
    expect(await overridesOn(id)).toHaveLength(2);
  });

  test("cancels one that never applied to a committed month", async ({ page }) => {
    const id = await overrideCardMerchant("Cancel");
    await page.goto(`/merchants/${id}`);
    await setOverride(page, "10", nextMonth().input);
    await expect(card(page).getByTestId("merchant-override-row")).toHaveCount(1);
    await card(page).getByRole("button", { name: "Cancel override" }).click();
    await card(page).getByRole("button", { name: "Delete override" }).click();
    await expect(card(page).getByTestId("merchant-override-row")).toHaveCount(0);
    expect(await overridesOn(id)).toEqual([]);
  });

  test("fits a 360px phone, every control 44px tall", async ({ page }) => {
    const id = await overrideCardMerchant("Phone");
    await page.setViewportSize({ width: 360, height: 900 });
    await page.goto(`/merchants/${id}`);
    await setOverride(page, "10", nextMonth().input);
    await expect(card(page).getByTestId("merchant-override-row")).toHaveCount(1);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const small = await card(page).evaluate((root) =>
      [...root.querySelectorAll("button, input, select")]
        .map((el) => ({ el, box: el.getBoundingClientRect() }))
        .filter(({ box }) => box.width > 0 && box.height < 44)
        .map(({ el, box }) => `${el.tagName} "${el.textContent?.trim()}" ${Math.round(box.height)}px`),
    );
    expect(small).toEqual([]);
  });
});

test.describe("as the owner", () => {
  test.use({ storageState: storageStateFor("agent") });

  test("the merchant page has no override card and no override action, even with one in force", async ({ page }) => {
    const id = await overrideCardMerchant("Rep View");
    // An override in force, set the only way one can be: as an admin.
    await setOverrideAsAdmin(id, "agent2", 10, thisMonth().period);

    await page.goto(`/merchants/${id}`);
    await expect(page.getByRole("heading", { name: "E2E Override Card Rep View" })).toBeVisible();
    await expect(card(page)).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Override", exact: true })).toHaveCount(0);
    for (const name of ["Save override", "End override", "Cancel override", "Change end"]) {
      await expect(page.getByRole("button", { name }), name).toHaveCount(0);
    }
    await expect(page.getByText(/of residual/)).toHaveCount(0);
    await expect(page.getByText(PERSONAS.agent2.fullName)).toHaveCount(0);
  });
});
