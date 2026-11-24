import { readFile } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";

import {
  E2E_PASSWORD,
  PERSONAS,
  createOverrideFixture,
  freeBatchSlot,
  publicStackConfig,
  storageStateFor,
} from "./fixtures/seed";
import { service } from "./qa/qa-stack";

/**
 * Export Excel on /admin/reports, phase 12b of docs/design/intake-and-reports.md.
 *
 * tests/unit/report-sheets.test.ts owns the sheet's cell rules and
 * tests/live/report-export.test.ts the function (two months, the house
 * profile, every refusal). What only a browser shows: that the button on the
 * page downloads a file under the selection's name whose columns are the
 * table's and whose every figure reads exactly as the page prints it, totals
 * included, and equal to the SQL function to the cent; that there is no button
 * on an empty selection; and that a rep, who cannot reach the page, is refused
 * by the function when they call it with their own session.
 *
 * The data is createOverrideFixture's committed batch (a shared account, a
 * plain merchant and a clawback, each with an override), alone in its own
 * processor-month.
 */

type Fixture = Awaited<ReturnType<typeof createOverrideFixture>>;
let fx: Fixture;
let processor: string;

const money = (value: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
/** What the page prints for a missing value (lib/format EMPTY). */
const EMPTY = "—";
const cents = (value: unknown) => Math.round(Number(value) * 100);
const slug = (code: string) => code.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const reportUrl = (report?: "merchants") =>
  `/admin/reports?${report ? "report=merchants&" : ""}from=${fx.period}&processor=${encodeURIComponent(processor)}`;

/** A persona's own session, for calling the functions as them. persistSession off and no signOut. */
async function sessionOf(persona: "admin" | "agent") {
  const { apiUrl, publishableKey } = publicStackConfig();
  const client = createClient(apiUrl, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.signInWithPassword({ email: PERSONAS[persona].email, password: E2E_PASSWORD });
  if (error || !data.session) throw new Error(`sign-in ${persona}: ${error?.message}`);
  return { client, token: data.session.access_token };
}

/** Clicks Export Excel and opens what arrives. */
async function exportFromPage(page: Page) {
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export Excel" }).click();
  const download = await downloaded;
  const book = XLSX.read(await readFile(await download.path()), { cellNF: true, cellFormula: true });
  const sheet = book.Sheets[book.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null, blankrows: true });
  return { name: download.suggestedFilename(), sheet, rows };
}

/** The file's rows after the column-header row that starts with `first`, `second`. */
function bodyAfter(rows: unknown[][], first: string, second: string) {
  const at = rows.findIndex((r) => r[0] === first && r[1] === second);
  expect(at, "the file's column headers").toBeGreaterThan(0);
  return { header: rows[at], lines: rows.slice(at + 1) };
}

const rpcArgs = () => ({
  period_from_input: `${fx.period}-01`,
  period_to_input: `${fx.period}-01`,
  processor_input: processor,
});

test.describe("as the admin", () => {
  test.use({ storageState: storageStateFor("admin") });
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    fx = await createOverrideFixture("reports-export");
    const { data } = await service().from("rep_payout_batches").select("processor").eq("id", fx.batchId).single();
    processor = data!.processor as string;
  });

  test("Report 1: the file is the page -- its name, its columns, every rep and the total, to the cent", async ({ page }) => {
    await page.goto(reportUrl());
    const table = page.getByRole("table", { name: "Rep payout summary" });
    await expect(table).toBeVisible();
    const file = await exportFromPage(page);
    expect(file.name).toBe(`residual-report-1-${fx.period}-${slug(processor)}.xlsx`);
    expect(file.rows.find((r) => r[0] === "Months")?.[1]).toBe(fx.period);
    expect(file.rows.find((r) => r[0] === "Processor")?.[1]).toBe(processor);

    // The table's own headers, in order (the first is the plus column's).
    const pageHeaders = (await table.getByRole("columnheader").allTextContents()).slice(1).map((t) => t.trim());
    const { header, lines } = bodyAfter(file.rows, "Agent code", "Legal name");
    expect(header).toEqual(pageHeaders);
    expect(header).toContain("Deductions (info only, not in total)");

    // Every rep row: the code and names as text, each figure as the page prints it.
    const pageRows = page.getByTestId("report-rep-row");
    const count = await pageRows.count();
    expect(count).toBe(3);
    for (let i = 0; i < count; i += 1) {
      const cells = (await pageRows.nth(i).getByRole("cell").allInnerTexts()).slice(1).map((t) => t.trim());
      const code = cells[0];
      const line = lines.find((r) => r[0] === code);
      expect(line, `file row for ${code}`).toBeDefined();
      // A missing name is a blank cell in the file and a dash on the page.
      expect(line!.slice(0, 3).map((v) => v ?? EMPTY)).toEqual(cells.slice(0, 3));
      expect(line!.slice(3, 9).map((v) => money(Number(v)))).toEqual(cells.slice(3, 9));
    }
    const totalCells = (await page.getByTestId("report-total-row").getByRole("cell").allInnerTexts()).map((t) => t.trim());
    const fileTotal = lines.find((r) => r[0] === "Total")!;
    expect(fileTotal.slice(3, 9).map((v) => money(Number(v)))).toEqual(totalCells.slice(-6));
    // One month: one totals row in the file, as on the page.
    expect(lines.filter((r) => typeof r[0] === "string" && (r[0] as string).endsWith("total"))).toHaveLength(0);

    // And the function itself, to the cent.
    const { client } = await sessionOf("admin");
    const { data, error } = await client.rpc("rep_payout_summary", rpcArgs());
    expect(error).toBeNull();
    const fnTotal = (data as Record<string, unknown>[]).find((r) => r.row_kind === "total")!;
    expect(fileTotal.slice(3, 9).map(cents)).toEqual(
      ["sales_volume", "net_residual", "agent_split", "deductions", "overrides_received", "total_commission"].map((k) => cents(fnTotal[k])));
    // Money is a currency number cell; the agent code a text cell.
    const firstLine = file.rows.indexOf(lines[0]) + 1;
    expect(file.sheet[`A${firstLine}`].t).toBe("s");
    expect(file.sheet[`I${firstLine}`]).toMatchObject({ t: "n", z: '"$"#,##0.00;-"$"#,##0.00' });
  });

  test("Report 2: merchants, the subtotal with its paid state and the grand total, as the page and the function have them", async ({ page }) => {
    await page.goto(reportUrl("merchants"));
    await expect(page.getByRole("table", { name: "Merchants by processor" })).toBeVisible();
    const file = await exportFromPage(page);
    expect(file.name).toBe(`residual-report-2-${fx.period}-${slug(processor)}.xlsx`);
    const { header, lines } = bodyAfter(file.rows, "Processor", "Merchant");
    expect(header).toEqual(["Processor", "Merchant", "MID", "Owner code", "Owner name", "Volume", "Residual", "Rep side", "Overrides from company", "Company share"]);

    for (const merchant of [fx.shared, fx.plain, fx.clawback]) {
      const pageRow = page.getByTestId("report-merchant-row").filter({ hasText: merchant.mid });
      const cells = (await pageRow.getByRole("cell").allInnerTexts()).map((t) => t.trim());
      const line = lines.find((r) => r[2] === merchant.mid)!;
      expect(line, merchant.mid).toBeDefined();
      expect(line[1]).toBe(merchant.dba);
      expect(`${line[3]} · ${line[4]}`).toBe(cells[2]);
      expect(line.slice(5, 10).map((v) => money(Number(v)))).toEqual(cells.slice(3, 8));
    }
    expect(lines.find((r) => r[2] === fx.clawback.mid)!.slice(6, 8)).toEqual([-11.76, -5.88]);

    const subtotal = lines.find((r) => r[0] === `${processor} subtotal (not marked paid)`)!;
    const pageSubtotal = (await page.getByTestId("report-processor-row").getByRole("cell").allInnerTexts()).map((t) => t.trim());
    expect(subtotal.slice(5, 10).map((v) => money(Number(v)))).toEqual(pageSubtotal.slice(-5));
    const grand = lines.find((r) => r[0] === "Grand total")!;
    const pageGrand = (await page.getByTestId("report-total-row").getByRole("cell").allInnerTexts()).map((t) => t.trim());
    expect(grand.slice(5, 10).map((v) => money(Number(v)))).toEqual(pageGrand.slice(-5));

    const { client } = await sessionOf("admin");
    const { data } = await client.rpc("merchant_processor_summary", rpcArgs());
    const fnGrand = (data as Record<string, unknown>[]).find((r) => r.row_kind === "total")!;
    expect(grand.slice(5, 10).map(cents)).toEqual(["volume", "residual", "rep_side", "company_overrides", "company_share"].map((k) => cents(fnGrand[k])));
    expect(cents(grand[6])).toBe(142280);
  });

  test("an empty selection offers no export", async ({ page }) => {
    const free = await freeBatchSlot(service());
    await page.goto(`/admin/reports?from=${free.period.slice(0, 7)}&processor=${encodeURIComponent(free.processor)}`);
    await expect(page.getByTestId("reports-empty")).toBeVisible();
    await expect(page.getByRole("button", { name: "Export Excel" })).toHaveCount(0);
  });
});

test.describe("as a rep", () => {
  test.use({ storageState: storageStateFor("agent") });

  test("sees no Export Excel, and the function refuses their own session (403) and no session (401), writing no audit row", async ({ page, request }) => {
    await page.goto("/admin/reports");
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole("button", { name: "Export Excel" })).toHaveCount(0);

    const { apiUrl, publishableKey } = publicStackConfig();
    const count = async () =>
      (await service().from("audit_log").select("id", { count: "exact", head: true }).eq("action", "export_report")).count ?? 0;
    const before = await count();
    const body = { report: "reps", from: "2026-07-01", to: "2026-07-01", processor: null };
    const { token } = await sessionOf("agent");
    const asRep = await request.post(`${apiUrl}/functions/v1/export-report`, {
      headers: { apikey: publishableKey, Authorization: `Bearer ${token}` },
      data: body,
    });
    expect(asRep.status()).toBe(403);
    expect(await asRep.json()).toEqual({ error: "Admin only" });
    const anonymous = await request.post(`${apiUrl}/functions/v1/export-report`, {
      headers: { apikey: publishableKey },
      data: body,
    });
    expect(anonymous.status()).toBe(401);
    expect(await count()).toBe(before);
  });
});
