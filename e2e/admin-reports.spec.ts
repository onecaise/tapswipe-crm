import { expect, test, type Page } from "@playwright/test";

import {
  PERSONAS,
  createOverrideFixture,
  freeBatchSlot,
  storageStateFor,
} from "./fixtures/seed";
import { service } from "./qa/qa-stack";

/**
 * /admin/reports, phase 12 of docs/design/intake-and-reports.md (§7.2).
 *
 * tests/rls/reports.test.ts owns the arithmetic and reconciles it over many
 * random months. What only a browser shows: that the page is reachable from
 * the Admin nav and nowhere else; that Report 1 prints Owen's columns with the
 * deductions header saying it is not in the total, a total per rep equal to
 * the rep's own ledger lines, and the plus that opens the override detail;
 * that Report 2 has the merchant rows, the processor subtotal with its paid
 * state and the grand total; that at 360px every amount is on screen with no
 * sideways scroll; and that a rep is sent away like every other admin page.
 *
 * The data is createOverrideFixture's committed batch, alone in its own
 * processor-month, so the page is filtered to exactly that slot.
 */

type Fixture = Awaited<ReturnType<typeof createOverrideFixture>>;
let fx: Fixture;
let processor: string;

const money = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);

/** The ledger's own sum of a rep's lines in the fixture's batch (the statement's total). */
async function ledgerTotal(agentId: string): Promise<number> {
  const { data } = await service()
    .from("rep_payout_rows")
    .select("rep_payout")
    .eq("batch_id", fx.batchId)
    .eq("agent_id", agentId);
  return Math.round((data ?? []).reduce((s, r) => s + Number(r.rep_payout), 0) * 100) / 100;
}

async function legalNameOf(agentId: string): Promise<string> {
  const { data } = await service().from("profiles").select("legal_name, llc_legal_name").eq("id", agentId).single();
  return (data?.llc_legal_name ?? data?.legal_name ?? "—") as string;
}

const reportUrl = (report?: "merchants") =>
  `/admin/reports?${report ? "report=merchants&" : ""}from=${fx.period}&processor=${encodeURIComponent(processor)}`;

const repRow = (page: Page, code: string) =>
  page.getByTestId("report-rep-row").and(page.locator(`[data-agent-code="${code}"]`));

test.describe("as the admin", () => {
  test.use({ storageState: storageStateFor("admin") });
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    fx = await createOverrideFixture("reports");
    const { data } = await service().from("rep_payout_batches").select("processor").eq("id", fx.batchId).single();
    processor = data!.processor as string;
  });

  test("the Admin nav links to Reports", async ({ page }) => {
    await page.goto("/dashboard");
    await page.getByRole("link", { name: "Reports", exact: true }).first().click();
    await expect(page).toHaveURL(/\/admin\/reports/);
    await expect(page.getByRole("heading", { name: "Reports", level: 1 })).toBeVisible();
  });

  test("Report 1: Owen's columns, each rep's total equals their ledger lines, deductions labelled out of the total", async ({ page }) => {
    await page.goto(reportUrl());
    const table = page.getByRole("table", { name: "Rep payout summary" });
    await expect(table).toBeVisible();
    for (const header of ["Agent code", "Legal name", "Full name", "Sales volume", "Net residual",
      "Agent split", "Deductions (info only, not in total)", "Override received", "Total agent commission"]) {
      await expect(table.getByRole("columnheader", { name: header, exact: true })).toBeVisible();
    }
    await expect(page.getByTestId("report-paid-states")).toContainText("not marked paid");

    const reps = [
      { persona: PERSONAS.agent, id: fx.ids.agent },
      { persona: PERSONAS.agent2, id: fx.ids.agent2 },
      { persona: PERSONAS.agent3, id: fx.ids.agent3 },
    ];
    for (const { persona, id } of reps) {
      const row = repRow(page, persona.agentNumber);
      await expect(row).toHaveCount(1);
      const cells = row.getByRole("cell");
      await expect(cells.nth(1)).toHaveText(persona.agentNumber);
      await expect(cells.nth(2)).toHaveText(await legalNameOf(id));
      await expect(cells.nth(3)).toHaveText(persona.fullName);
      // Total agent commission, the last column: the rep's lines in the ledger.
      await expect(cells.nth(9)).toHaveText(money(await ledgerTotal(id)));
    }
    // The recipient: no volume, no split, the override received is the total.
    const three = repRow(page, PERSONAS.agent3.agentNumber).getByRole("cell");
    await expect(three.nth(4)).toHaveText("$0.00");
    await expect(three.nth(8)).toHaveText(money(61.73 + 10 - 0.59));
    // Only reps with lines in this processor-month.
    await expect(page.getByTestId("report-rep-row")).toHaveCount(3);
    await expect(page.getByTestId("report-total-row")).toContainText(
      money(await ledgerTotal(fx.ids.agent) + await ledgerTotal(fx.ids.agent2) + await ledgerTotal(fx.ids.agent3)));
    // One month: one totals row, not a month total as well.
    await expect(page.getByTestId("report-month-row")).toHaveCount(0);
  });

  test("Report 1's plus opens the override detail: percent, merchant and recipient", async ({ page }) => {
    await page.goto(reportUrl());
    const signer = repRow(page, PERSONAS.agent.agentNumber);
    await expect(page.getByTestId("report-override-detail")).toHaveCount(0);
    await signer.getByRole("button", { name: `Show override detail for ${PERSONAS.agent.fullName}` }).click();
    const detail = page.getByTestId("report-override-detail");
    await expect(detail).toContainText(`Override 5% on ${fx.plain.dba} (${fx.plain.mid}) · to ${PERSONAS.agent3.fullName}`);
    await expect(detail).toContainText("-$10.00");

    await repRow(page, PERSONAS.agent3.agentNumber)
      .getByRole("button", { name: `Show override detail for ${PERSONAS.agent3.fullName}` }).click();
    await expect(page.getByTestId("report-override-detail").nth(1))
      .toContainText(`Received 5% on ${fx.shared.dba} (${fx.shared.mid}) · from ${PERSONAS.agent.fullName} and ${PERSONAS.agent2.fullName}`);
  });

  test("Report 2: a row per merchant, the subtotal with its paid state, the grand total", async ({ page }) => {
    await page.goto(reportUrl("merchants"));
    const table = page.getByRole("table", { name: "Merchants by processor" });
    await expect(table).toBeVisible();
    await expect(page.getByTestId("report-merchant-row")).toHaveCount(3);

    const rowFor = (mid: string) => page.getByTestId("report-merchant-row").filter({ hasText: mid });
    // Residual, rep side (50%), company share: the shared account once, under its signer.
    await expect(rowFor(fx.shared.mid)).toContainText(`${PERSONAS.agent.agentNumber} · ${PERSONAS.agent.fullName}`);
    await expect(rowFor(fx.shared.mid)).toContainText("$1,234.56");
    await expect(rowFor(fx.shared.mid)).toContainText("$617.28");
    await expect(rowFor(fx.plain.mid)).toContainText("$200.00");
    await expect(rowFor(fx.clawback.mid)).toContainText("-$11.76");
    await expect(rowFor(fx.clawback.mid)).toContainText("-$5.88");

    const subtotal = page.getByTestId("report-processor-row");
    await expect(subtotal).toContainText(`${processor} subtotal`);
    await expect(subtotal).toContainText("not marked paid");
    await expect(subtotal).toContainText("$1,422.80");
    const total = page.getByTestId("report-total-row");
    // 1422.80 residual; rep side 617.28 + 100 - 5.88 = 711.40; company the rest.
    await expect(total).toContainText("$1,422.80");
    await expect(total).toContainText("$711.40");
    await expect(total).toContainText("$711.40");
  });

  test("at 360px every amount is on screen with no sideways scroll", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    for (const url of [reportUrl(), reportUrl("merchants")]) {
      await page.goto(url);
      const cards = page.getByTestId("report-cards");
      await expect(cards).toBeVisible();
      await expect(page.getByRole("table")).toBeHidden();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, url).toBeLessThanOrEqual(0);
      // Every figure inside the viewport's width.
      const boxes = await cards.locator("dd").evaluateAll((els) =>
        els.map((el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, text: el.textContent }; }));
      expect(boxes.length).toBeGreaterThan(0);
      for (const box of boxes) {
        expect(box.left, box.text ?? "").toBeGreaterThanOrEqual(0);
        expect(box.right, box.text ?? "").toBeLessThanOrEqual(360);
      }
    }
  });

  test("an empty selection and an unreadable month each say so", async ({ page }) => {
    const free = await freeBatchSlot(service());
    await page.goto(`/admin/reports?from=${free.period.slice(0, 7)}&processor=${encodeURIComponent(free.processor)}`);
    await expect(page.getByTestId("reports-empty")).toContainText("Nothing is committed for");
    await expect(page.getByRole("table")).toHaveCount(0);

    await page.goto("/admin/reports?from=2026-13");
    await expect(page.getByText("The first month in the address is not a month.")).toBeVisible();
    await expect(page.getByRole("table")).toHaveCount(0);
  });
});

test.describe("as a rep", () => {
  test.use({ storageState: storageStateFor("agent") });

  test("has no Reports link and is sent away from the address, as from every admin page", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByRole("link", { name: "Payouts", exact: true }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Reports", exact: true })).toHaveCount(0);

    await page.goto("/admin/reports");
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.goto("/admin/reports?report=merchants&from=2026-07");
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole("table", { name: /Rep payout summary|Merchants by processor/ })).toHaveCount(0);
  });
});
