import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import {
  DEDUCTIONS_HEADER,
  FORMULA_TRIGGERS,
  MERCHANT_FIGURES,
  MERCHANT_TEXT_HEADERS,
  MONEY_FORMAT,
  REP_FIGURES,
  REP_TEXT_HEADERS,
  auditSelection,
  buildReportSheet,
  columnName,
  moneyCell,
  reportFileName,
  textCell,
  type MerchantSummaryRow,
  type PaidState,
  type RepSummaryRow,
  type ReportSelection,
} from "../../supabase/functions/_shared/report-sheets.ts";

/**
 * The Excel export's sheet builder (phase 12b of
 * docs/design/intake-and-reports.md). The figures are the SQL functions'
 * (tests/rls/reports.test.ts); the download against them is
 * tests/live/report-export.test.ts. This file pins the sheet: the page's
 * columns in the page's order, money as currency NUMBER cells, the MID and
 * agent code as TEXT, the totals rows as given (never recomputed), and the
 * formula-injection guard, each read back through a real SheetJS write.
 */

const JULY: ReportSelection = { report: "reps", from: "2026-07-01", to: "2026-07-01", processor: null };

function rep(over: Partial<RepSummaryRow>): RepSummaryRow {
  return {
    row_kind: "rep", period: "2026-07-01", agent_id: "a", agent_code: "9002", legal_name: "Ito Payments LLC",
    full_name: "Ann Ito", sales_volume: 50000, net_residual: 1234.56, agent_split: 557.9, deductions: -12.5,
    overrides_received: 0, total_commission: 557.9, ...over,
  };
}

function merchant(over: Partial<MerchantSummaryRow>): MerchantSummaryRow {
  return {
    row_kind: "merchant", period: "2026-07-01", processor: "TSYS", merchant_id: 1, mid: "000000000123",
    merchant_name: "Corner Cafe", owner_id: "a", owner_code: "9002", owner_name: "Ann Ito",
    volume: 50000, residual: 200, rep_side: 100, company_share: 100, ...over,
  };
}

/** Writes and re-reads the sheet as a file would be, so a cell is what Excel gets. */
function roundTrip(built: ReturnType<typeof buildReportSheet>) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, built.sheet as XLSX.WorkSheet, built.sheetName);
  const bytes = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const back = XLSX.read(bytes, { cellNF: true, cellFormula: true });
  const sheet = back.Sheets[built.sheetName];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null, blankrows: true });
  return { bytes, sheet, rows };
}

/** The row (0-based in `rows`) whose first cell is `label`. */
const rowStarting = (rows: unknown[][], label: string) => rows.find((r) => r[0] === label);

describe("Report 1 (rep payout summary)", () => {
  const rows: RepSummaryRow[] = [
    rep({}),
    rep({ agent_id: "b", agent_code: "0122", legal_name: null, full_name: "House Account", sales_volume: 20000,
      net_residual: 500, agent_split: 0, deductions: 0, total_commission: 0 }),
    rep({ row_kind: "total", agent_id: null, agent_code: null, legal_name: null, full_name: null,
      sales_volume: 70000, net_residual: 1734.56, agent_split: 557.9, deductions: -12.5, total_commission: 557.9 }),
  ];
  const paid: PaidState[] = [{ processor: "TSYS", period: "2026-07-01", closed_at: "2026-08-03T10:00:00Z" }];

  it("has the selection above the table and the page's columns in the page's order", () => {
    const built = buildReportSheet(JULY, rows, paid);
    const { rows: grid } = roundTrip(built);
    expect(built.sheetName).toBe("Rep payout summary");
    expect(grid[0][0]).toBe("Rep payout summary");
    expect(rowStarting(grid, "Months")!.slice(0, 2)).toEqual(["Months", "2026-07"]);
    expect(rowStarting(grid, "Processor")!.slice(0, 2)).toEqual(["Processor", "All processors"]);
    expect(rowStarting(grid, "Paid state")!.slice(0, 3)).toEqual(["Paid state", "TSYS 2026-07", "paid 2026-08-03"]);
    expect(grid[built.headerRow - 1]).toEqual([
      "Agent code", "Legal name", "Full name", "Sales volume", "Net residual", "Agent split",
      "Deductions (info only, not in total)", "Override received", "Total agent commission",
    ]);
    expect(grid[built.headerRow - 1]).toContain(DEDUCTIONS_HEADER);
    expect([...REP_TEXT_HEADERS, ...REP_FIGURES.map(([, label]) => label)]).toEqual(grid[built.headerRow - 1]);
  });

  it("writes money as currency number cells, negatives with a minus sign", () => {
    const built = buildReportSheet(JULY, rows, paid);
    const { sheet } = roundTrip(built);
    const r = built.headerRow + 1; // the first rep
    for (const [c, value] of [[3, 50000], [4, 1234.56], [5, 557.9], [6, -12.5], [7, 0], [8, 557.9]] as const) {
      const cell = sheet[`${columnName(c)}${r}`];
      expect(cell.t, `${columnName(c)}${r}`).toBe("n");
      expect(cell.v).toBe(value);
      expect(cell.z).toBe(MONEY_FORMAT);
    }
    expect(sheet[`G${r}`].w).toBe("-$12.50");
    expect(sheet[`E${r}`].w).toBe("$1,234.56");
  });

  it("keeps the agent code as text, leading zeros and all", () => {
    const built = buildReportSheet(JULY, rows, paid);
    const { sheet } = roundTrip(built);
    const cell = sheet[`A${built.headerRow + 2}`];
    expect(cell).toMatchObject({ t: "s", v: "0122" });
  });

  it("writes the totals row the function returned, and does not add the reps up itself", () => {
    // A total that is NOT the sum of the rep rows: the file must carry it as given.
    const odd = rows.map((r) => (r.row_kind === "total" ? { ...r, total_commission: 999.99 } : r));
    const { rows: grid } = roundTrip(buildReportSheet(JULY, odd, paid));
    expect(rowStarting(grid, "Total")![8]).toBe(999.99);
    // One month: the grand total once, no month total.
    expect(grid.filter((r) => r[0] === "Total")).toHaveLength(1);
    expect(grid.some((r) => typeof r[0] === "string" && (r[0] as string).endsWith(" total"))).toBe(false);
  });

  it("over a range: a row per month heading its reps, each month's total, then the grand total", () => {
    const range: ReportSelection = { ...JULY, from: "2026-06-01" };
    const multi: RepSummaryRow[] = [
      rep({ period: "2026-06-01", total_commission: 10 }),
      rep({ period: "2026-07-01", total_commission: 20 }),
      rep({ row_kind: "month", period: "2026-06-01", agent_id: null, agent_code: null, total_commission: 10 }),
      rep({ row_kind: "month", period: "2026-07-01", agent_id: null, agent_code: null, total_commission: 20 }),
      rep({ row_kind: "total", period: null, agent_id: null, agent_code: null, total_commission: 30 }),
    ];
    const built = buildReportSheet(range, multi, []);
    const { rows: grid } = roundTrip(built);
    expect(rowStarting(grid, "Months")![1]).toBe("2026-06 to 2026-07");
    const body = grid.slice(built.headerRow).map((r) => [r[0], r[8]]);
    expect(body).toEqual([
      ["2026-06", null], ["9002", 10], ["2026-07", null], ["9002", 20],
      ["2026-06 total", 10], ["2026-07 total", 20], ["Total", 30],
    ]);
  });
});

describe("Report 2 (merchants by processor)", () => {
  const selection: ReportSelection = { report: "merchants", from: "2026-07-01", to: "2026-07-01", processor: "TSYS" };
  const rows: MerchantSummaryRow[] = [
    merchant({}),
    merchant({ mid: "4445550001", merchant_name: "Clawback Co", residual: -11.76, rep_side: -5.88, company_share: -5.88 }),
    merchant({ row_kind: "processor", merchant_id: null, mid: null, merchant_name: null, owner_id: null,
      owner_code: null, owner_name: null, residual: 188.24, rep_side: 94.12, company_share: 94.12 }),
    merchant({ row_kind: "total", period: null, processor: null, merchant_id: null, mid: null, merchant_name: null,
      owner_id: null, owner_code: null, owner_name: null, residual: 188.24, rep_side: 94.12, company_share: 94.12 }),
  ];

  it("has the page's columns, the MID and owner code as their own text columns", () => {
    const built = buildReportSheet(selection, rows, [{ processor: "TSYS", period: "2026-07-01", closed_at: null }]);
    const { rows: grid, sheet } = roundTrip(built);
    expect(built.sheetName).toBe("Merchants by processor");
    expect(grid[built.headerRow - 1]).toEqual([
      "Processor", "Merchant", "MID", "Owner code", "Owner name", "Volume", "Residual", "Rep side", "Company share",
    ]);
    expect([...MERCHANT_TEXT_HEADERS, ...MERCHANT_FIGURES.map(([, l]) => l)]).toEqual(grid[built.headerRow - 1]);
    const first = built.headerRow + 1;
    expect(sheet[`C${first}`]).toMatchObject({ t: "s", v: "000000000123" });
    expect(sheet[`D${first}`]).toMatchObject({ t: "s", v: "9002" });
    expect(sheet[`G${first + 1}`]).toMatchObject({ t: "n", v: -11.76, w: "-$11.76" });
  });

  it("writes each processor-month's subtotal with its paid state, and the grand total", () => {
    const { rows: grid } = roundTrip(buildReportSheet(selection, rows, [{ processor: "TSYS", period: "2026-07-01", closed_at: null }]));
    expect(rowStarting(grid, "TSYS subtotal (not marked paid)")!.slice(5)).toEqual([50000, 188.24, 94.12, 94.12]);
    expect(rowStarting(grid, "Grand total")!.slice(5)).toEqual([50000, 188.24, 94.12, 94.12]);
    const paidGrid = roundTrip(buildReportSheet(selection, rows,
      [{ processor: "TSYS", period: "2026-07-01", closed_at: "2026-08-01T00:00:00Z" }])).rows;
    expect(rowStarting(paidGrid, "TSYS subtotal (paid)")).toBeDefined();
  });

  it("names the month in each subtotal over a range", () => {
    const range = { ...selection, from: "2026-06-01" };
    const { rows: grid } = roundTrip(buildReportSheet(range, rows, []));
    expect(rowStarting(grid, "TSYS · 2026-07 subtotal (not marked paid)")).toBeDefined();
  });
});

describe("text cells", () => {
  it("are typed string whatever they look like, so a 12-digit MID keeps its zeros", () => {
    for (const value of ["000000000123", "0122", "1e5", "2026-07", "TRUE", "12.50"]) {
      expect(textCell(value)).toEqual({ t: "s", v: value });
    }
    expect(textCell(null)).toBeNull();
    expect(textCell("")).toBeNull();
  });
});

describe("formula injection", () => {
  const HOSTILE = [
    '=HYPERLINK("http://evil.example","x")',
    "+cmd|' /C calc'!A0",
    "+cmd",
    "-2+3",
    "@SUM(A1:A2)",
    "\t=1+1",
    "\r=1+1",
  ];

  it("covers exactly the triggers it says it does", () => {
    expect([...FORMULA_TRIGGERS]).toEqual(["=", "+", "-", "@", "\t", "\r"]);
  });

  it("quotes a text that starts like a formula, and leaves the rest alone", () => {
    for (const value of HOSTILE) {
      expect(textCell(value), JSON.stringify(value)).toEqual({ t: "s", v: `'${value}` });
    }
    for (const value of ["Joe's Pizza", "A-1 Diner", "Cafe = good", " =padded", "x@example.com"]) {
      expect(textCell(value)).toEqual({ t: "s", v: value });
    }
  });

  it("writes no formula into the file from any user text, in either report", () => {
    const evil = HOSTILE[0];
    const repRows: RepSummaryRow[] = [
      rep({ agent_code: "+cmd", legal_name: evil, full_name: "@SUM(A1:A2)" }),
      rep({ row_kind: "total", agent_id: null, agent_code: null, legal_name: null, full_name: null }),
    ];
    const merchantRows: MerchantSummaryRow[] = [
      merchant({ merchant_name: evil, mid: "-1", owner_code: "\t=1+1", owner_name: "\r=1+1", processor: "=TSYS" }),
      merchant({ row_kind: "total", period: null, processor: null, merchant_id: null, mid: null }),
    ];
    const builtReps = buildReportSheet({ ...JULY, processor: "+cmd" }, repRows,
      [{ processor: "=TSYS", period: "2026-07-01", closed_at: null }]);
    const builtMerchants = buildReportSheet({ ...JULY, report: "merchants", processor: "=TSYS" }, merchantRows, []);

    for (const built of [builtReps, builtMerchants]) {
      const { sheet, bytes } = roundTrip(built);
      const cells = Object.entries(sheet).filter(([key]) => !key.startsWith("!"));
      expect(cells.length).toBeGreaterThan(10);
      for (const [address, cell] of cells as [string, XLSX.CellObject][]) {
        expect(cell.f, address).toBeUndefined();
        if (cell.t === "s") {
          expect((FORMULA_TRIGGERS as readonly string[]).includes(String(cell.v)[0]), `${address}: ${cell.v}`).toBe(false);
        }
      }
      // And no formula element anywhere in the zip's XML (SheetJS stores it
      // uncompressed: the sheet XML is readable, so a <f> would be too).
      expect(bytes.includes(Buffer.from("<sheetData"))).toBe(true);
      expect(bytes.includes(Buffer.from("<f>"))).toBe(false);
      expect(bytes.includes(Buffer.from("<f "))).toBe(false);
    }
    // The hostile text itself survived, as text, behind the quote.
    const { sheet } = roundTrip(builtMerchants);
    expect(sheet[`B${builtMerchants.headerRow + 1}`]).toMatchObject({ t: "s", v: `'${evil}` });
  });
});

describe("money cells", () => {
  it("carry the figure as given, and refuse anything that is not a number", () => {
    expect(moneyCell(-5.41)).toEqual({ t: "n", v: -5.41, z: MONEY_FORMAT });
    expect(moneyCell("1234.56")).toEqual({ t: "n", v: 1234.56, z: MONEY_FORMAT });
    expect(moneyCell(null)).toBeNull();
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, "abc", "", " "]) {
      expect(() => moneyCell(bad), String(bad)).toThrow();
    }
  });
});

describe("the file name and the audit row", () => {
  it("says the report, the months and the processor", () => {
    expect(reportFileName(JULY)).toBe("residual-report-1-2026-07-all-processors.xlsx");
    expect(reportFileName({ report: "merchants", from: "2026-06-01", to: "2026-07-01", processor: "Netevia HQ" }))
      .toBe("residual-report-2-2026-06-to-2026-07-netevia-hq.xlsx");
    expect(reportFileName({ ...JULY, processor: '../"x"' })).toBe("residual-report-1-2026-07-x.xlsx");
    expect(reportFileName({ ...JULY, processor: "%%" })).toBe("residual-report-1-2026-07-processor.xlsx");
  });

  it("names the selection in the audit row", () => {
    expect(auditSelection(JULY)).toBe("2026-07-01..2026-07-01 all processors");
    expect(auditSelection({ ...JULY, from: "2026-06-01", processor: "TSYS" })).toBe("2026-06-01..2026-07-01 TSYS");
  });

  it("spells columns past Z", () => {
    expect([0, 8, 25, 26, 27, 51, 52].map(columnName)).toEqual(["A", "I", "Z", "AA", "AB", "AZ", "BA"]);
  });
});
