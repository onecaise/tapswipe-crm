import { expect, test, type Page } from "@playwright/test";

import { createClient } from "@supabase/supabase-js";

import {
  E2E_PASSWORD,
  PERSONAS,
  createOverrideFixture,
  overrideCardMerchant,
  overridesOn,
  publicStackConfig,
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
 *
 * Funding (20261116120000, docs/design/override-funding.md): the form asks
 * who pays with neither choice made, says what each choice means in money,
 * and will not save without one; "Change who pays" is refused while a month
 * the override paid is marked paid, saved with a reason once it is reopened,
 * and the month then waits on Payouts for a replace; a company-funded
 * override shows nothing on its owner's statement.
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

const PAID_FROM = { owner: "The owner's side", company: "The company's share" } as const;

async function setOverride(
  page: Page,
  pct: string,
  month: string,
  funded: keyof typeof PAID_FROM = "owner",
): Promise<void> {
  await card(page).getByLabel("Percent of the full residual").fill(pct);
  await card(page).getByRole("radio", { name: PAID_FROM[funded] }).check();
  await card(page).getByLabel("First month it applies to").fill(month);
  await card(page).getByRole("button", { name: "Save override" }).click();
}

/** The admin persona's own session, for what a test arranges rather than tests. */
async function adminClient() {
  const { apiUrl, publishableKey } = publicStackConfig();
  const admin = createClient(apiUrl, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await admin.auth.signInWithPassword({ email: PERSONAS.admin.email, password: E2E_PASSWORD });
  if (error) throw new Error(error.message);
  return admin;
}

test.describe("as the admin", () => {
  test.use({ storageState: storageStateFor("admin") });

  test("sets one: the manager prefilled, who pays chosen with no default, the example per choice, saved, audited, in force", async ({ page }) => {
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
    await card(page).getByLabel("First month it applies to").fill(month.input);
    // "Paid from": neither choice made, and no save without one.
    for (const label of Object.values(PAID_FROM)) {
      await expect(card(page).getByRole("radio", { name: label })).not.toBeChecked();
    }
    await expect(card(page).getByTestId("override-problem")).toHaveText(
      "Choose who pays it: the owner's side or the company's share.",
    );
    await expect(card(page).getByRole("button", { name: "Save override" })).toBeDisabled();
    // The worked example follows the choice.
    await card(page).getByRole("radio", { name: PAID_FROM.owner }).check();
    await expect(card(page).getByTestId("override-problem")).toHaveText(
      "On a $100 residual: the recipient gets $10.00, the owner keeps $40.00 of the $50.00 rep side, and the company keeps $50.00.",
    );
    await card(page).getByRole("radio", { name: PAID_FROM.company }).check();
    await expect(card(page).getByTestId("override-problem")).toHaveText(
      "On a $100 residual: the recipient gets $10.00, the owner keeps the full $50.00 rep side, and the company keeps $40.00 of its $50.00.",
    );
    await card(page).getByRole("button", { name: "Save override" }).click();

    await expect(card(page).getByTestId("merchant-override-in-force")).toHaveText(
      `In force: 10% of residual to ${PERSONAS.agent2.fullName}, paid from the company's share, from ${month.words}.`,
    );
    await expect(card(page).getByTestId("merchant-override-row")).toHaveCount(1);
    await expect(card(page).getByTestId("merchant-override-funding")).toHaveText("Paid from the company's share");
    // The form starts blank again: the next override is chosen afresh.
    await expect(card(page).getByRole("radio", { name: PAID_FROM.company })).not.toBeChecked();
    expect(await overridesOn(id)).toEqual([
      { recipient_id: await personaId("agent2"), override_pct: 10, effective_from: month.period, effective_to: null, funded_by: "company" },
    ]);
    const { data: saved } = await service().from("merchant_overrides").select("id").eq("merchant_id", id).single();
    const { data: audit } = await service()
      .from("audit_log").select("action, actor_id, detail")
      .eq("table_name", "merchant_overrides").eq("row_id", String(saved!.id));
    expect(audit).toEqual([{ action: "set_merchant_override", actor_id: await personaId("admin"), detail: "funded_by=company" }]);
  });

  test("refuses above the merchant's rate before the round trip, and nothing is saved", async ({ page }) => {
    const id = await overrideCardMerchant("Cap");
    await page.goto(`/merchants/${id}`);
    await card(page).getByLabel("Percent of the full residual").fill("50.01");
    await card(page).getByLabel("First month it applies to").fill(thisMonth().input);
    await expect(card(page).getByTestId("override-problem")).toHaveText(
      "An override cannot be more than this merchant's rate: 50.",
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
    // The new one is paid by the company; the old one stays the owner's.
    await setOverride(page, "7.5", next.input, "company");
    await expect(card(page).getByTestId("merchant-override-row")).toHaveCount(2);
    expect(await overridesOn(id)).toEqual([
      { recipient_id: await personaId("agent2"), override_pct: 10, effective_from: now.period, effective_to: next.period, funded_by: "owner" },
      { recipient_id: await personaId("agent3"), override_pct: 7.5, effective_from: next.period, effective_to: null, funded_by: "company" },
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

  test("change who pays: refused while its month is paid, saved with a reason after Reopen; the month then waits for a replace", async ({ page }) => {
    const fx = await createOverrideFixture("funding");
    const period = `${fx.period}-01`;
    const words = new Date(`${period}T00:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
    const { data: batch } = await service().from("rep_payout_batches").select("processor").eq("id", fx.batchId).single();
    const processor = batch!.processor as string;
    const label = `${processor} ${words}`;
    const admin = await adminClient();
    const { error: paidError } = await admin.rpc("close_payout_period", {
      period_input: period, processor_input: processor, confirmation_input: label,
    });
    expect(paidError).toBeNull();
    try {
      await page.goto(`/merchants/${fx.plain.merchantId}`);
      const row = card(page).getByTestId("merchant-override-row");
      await expect(row.getByTestId("merchant-override-funding")).toHaveText("Paid from the owner's side");
      await row.getByRole("button", { name: "Change who pays" }).click();
      await expect(row.getByRole("alert")).toHaveText(
        `${label} is marked paid. Reopen it (with a reason) before changing who pays this override.`,
      );
      await expect(row.getByRole("button", { name: "Save who pays" })).toHaveCount(0);

      const { error: reopenError } = await admin.rpc("reopen_payout_period", {
        period_input: period, processor_input: processor, reason_input: "e2e: changing who pays an override",
      });
      expect(reopenError).toBeNull();
      await page.reload();
      await row.getByRole("button", { name: "Change who pays" }).click();
      await expect(row.getByText("Switch to: paid from the company's share.")).toBeVisible();
      await expect(row.getByText(`${label}: will need a replace to take effect.`)).toBeVisible();
      await expect(row.getByRole("button", { name: "Save who pays" })).toBeDisabled();
      await row.getByLabel("Reason").fill("Paid from the company's share, as ISO Hub pays it.");
      await row.getByRole("button", { name: "Save who pays" }).click();
      await expect(row.getByTestId("merchant-override-funding")).toHaveText("Paid from the company's share");
      await expect(row.getByTestId("merchant-override-stale")).toHaveText(
        `Who pays it changed after ${label} was committed. Replace that month on Payouts to apply it.`,
      );

      // Payouts: the month says so, and offers no Mark paid until it is replaced.
      await page.goto("/payouts");
      const month = page.getByTestId("processor-month")
        .filter({ has: page.getByRole("link", { name: "e2e-override-funding.xlsx" }) });
      await expect(month.getByText("Override funding changed: replace this month to apply (1 override)")).toBeVisible();
      await expect(month.getByRole("button", { name: `Mark paid: ${label}` })).toHaveCount(0);
    } finally {
      // Leave the month as other runs expect it: not paid, and its funding the lines'.
      const { data: open } = await service().from("payout_period_closures").select("period")
        .eq("processor", processor).eq("period", period);
      if ((open ?? []).length > 0) {
        await admin.rpc("reopen_payout_period", {
          period_input: period, processor_input: processor, reason_input: "e2e cleanup: reopening its own month",
        });
      }
      const { data: ov } = await service().from("merchant_overrides").select("id, funded_by")
        .eq("merchant_id", fx.plain.merchantId).single();
      if (ov && ov.funded_by !== "owner") {
        await admin.rpc("set_merchant_override_funding", {
          override_id_input: ov.id, funded_by_input: "owner", reason_input: "e2e cleanup: back to the owner",
        });
      }
    }
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

  test("a company-funded override shows nothing on the owner's statement", async ({ page }) => {
    const fx = await createOverrideFixture("company", "company");
    await page.goto(`/payouts/${fx.period}`);
    await expect(page.getByText(fx.plain.dba).filter({ visible: true }).first()).toBeVisible();
    // The fixture's three merchants are the owner's; with company funding none
    // carries a debit line, so the owner's Overrides block lists none of them.
    await expect(
      page.getByTestId("payout-override-line").filter({ visible: true })
        .filter({ hasText: /E2E Override (Plain|Shared|Clawback) company/ }),
    ).toHaveCount(0);
  });

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
