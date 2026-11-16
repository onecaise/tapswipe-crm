// The two admin reports at /admin/reports as spreadsheet sheets (phase 12b of
// docs/design/intake-and-reports.md, §7.2).
//
// Dependency-free, like the rest of _shared: it builds a SheetJS-shaped
// worksheet object (`{"!ref", A1: {t, v}, ...}`) out of plain cells, and the
// export-report function hands that to SheetJS only to zip it. So every rule
// below is unit-tested in Node without a Deno runtime, and the Next app reads
// the column lists and the file name from here (lib/reports.ts re-exports
// them), so the page and the file cannot list different columns.
//
// THE FILE IS THE PAGE, NOT A SECOND REPORT. Every figure is a row of
// rep_payout_summary() / merchant_processor_summary() as it came back, totals
// rows included (the functions' GROUPING SETS rows): nothing here adds,
// rounds or recomputes, so the file cannot disagree with the page.
//
// Three cell rules, each pinned by tests/unit/report-sheets.test.ts:
//   - money is a NUMBER cell with MONEY_FORMAT (a minus sign on a negative,
//     as the page's formatMoney writes it);
//   - every text cell is typed string (t: "s") and never carries a formula
//     (`f`), so an MID or agent code keeps its leading zeros and all 12 digits;
//   - text from users or processor files whose first character is a formula
//     trigger (FORMULA_TRIGGERS) is ALSO prefixed with a single quote. A
//     string cell is not evaluated on open, but Excel re-parses it as a
//     formula when someone edits the cell, and a copy to CSV would carry it
//     raw. The quote is visible in the cell; that is the price of the guard.

export type ReportKind = "reps" | "merchants";

/** Report 1, one row: a rep in a month ('rep'), a month's total, or the grand total. */
export type RepSummaryRow = {
  row_kind: "rep" | "month" | "total";
  period: string | null;
  agent_id: string | null;
  agent_code: string | null;
  legal_name: string | null;
  full_name: string | null;
  sales_volume: number;
  net_residual: number;
  agent_split: number;
  deductions: number;
  overrides_received: number;
  total_commission: number;
};

/** Report 2, one row: a MID in a processor-month, a processor-month subtotal, or the grand total. */
export type MerchantSummaryRow = {
  row_kind: "merchant" | "processor" | "total";
  period: string | null;
  processor: string | null;
  merchant_id: number | null;
  mid: string | null;
  merchant_name: string | null;
  owner_id: string | null;
  owner_code: string | null;
  owner_name: string | null;
  volume: number;
  residual: number;
  rep_side: number;
  /**
   * The MID's committed company-funded override credits in the
   * processor-month (20261116120000): money out of the company's share.
   * residual = rep_side + company_overrides + company_share.
   */
  company_overrides: number;
  company_share: number;
};

/**
 * The column header for deductions, word for word from Owen's answer (§0c.1):
 * a reader must not take the column as part of the total.
 */
export const DEDUCTIONS_HEADER = "Deductions (info only, not in total)";

export const REPORT_TITLES: Record<ReportKind, string> = {
  reps: "Rep payout summary",
  merchants: "Merchants by processor",
};

/** Report 1's money columns, in Owen's order (§0b.7); the page renders these too. */
export const REP_FIGURES = [
  ["sales_volume", "Sales volume"],
  ["net_residual", "Net residual"],
  ["agent_split", "Agent split"],
  ["deductions", DEDUCTIONS_HEADER],
  ["overrides_received", "Override received"],
  ["total_commission", "Total agent commission"],
] as const satisfies readonly (readonly [keyof RepSummaryRow, string])[];

/** Report 2's money columns; the page renders these too. */
export const MERCHANT_FIGURES = [
  ["volume", "Volume"],
  ["residual", "Residual"],
  ["rep_side", "Rep side"],
  ["company_overrides", "Overrides from company"],
  ["company_share", "Company share"],
] as const satisfies readonly (readonly [keyof MerchantSummaryRow, string])[];

/** Report 1's text columns before the figures, as the page's table has them. */
export const REP_TEXT_HEADERS = ["Agent code", "Legal name", "Full name"] as const;

/**
 * Report 2's text columns before the figures. The page puts the MID under the
 * merchant's name and the owner as "code · name" in one cell; the file splits
 * them, so the MID and the owner's code are text columns of their own.
 */
export const MERCHANT_TEXT_HEADERS = ["Processor", "Merchant", "MID", "Owner code", "Owner name"] as const;

/** Currency with a minus sign, as formatMoney writes it: -$5.41. */
export const MONEY_FORMAT = '"$"#,##0.00;-"$"#,##0.00';

/** A first character Excel, LibreOffice or Sheets may read as the start of a formula. */
export const FORMULA_TRIGGERS = ["=", "+", "-", "@", "\t", "\r"] as const;

export type TextCell = { t: "s"; v: string };
export type MoneyCell = { t: "n"; v: number; z: string };
export type Cell = TextCell | MoneyCell;

/**
 * A text cell: typed string whatever it looks like, so "000123" stays
 * "000123", and quoted when it starts like a formula. Blank for null or "".
 */
export function textCell(value: string | null | undefined): TextCell | null {
  if (value === null || value === undefined || value === "") return null;
  const triggered = (FORMULA_TRIGGERS as readonly string[]).includes(value[0]);
  return { t: "s", v: triggered ? `'${value}` : value };
}

/**
 * A money cell: the figure as it came back, never rounded or re-added. A value
 * that is not a finite number throws, so a broken row stops the export rather
 * than writing NaN into a commission sheet. Blank for null.
 */
export function moneyCell(value: number | string | null | undefined): MoneyCell | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  if (typeof value === "string" && value.trim() === "") {
    throw new Error("A report figure came back blank.");
  }
  if (!Number.isFinite(n)) throw new Error(`A report figure is not a number: ${String(value)}`);
  return { t: "n", v: n, z: MONEY_FORMAT };
}

/** YYYY-MM-DD (first of month) to the text "2026-07". */
export const monthText = (period: string) => period.slice(0, 7);

export type ReportSelection = {
  report: ReportKind;
  /** First of the first month, YYYY-MM-DD. */
  from: string;
  /** First of the last month, YYYY-MM-DD. */
  to: string;
  /** A processor code, or null for every processor. */
  processor: string | null;
};

/** One processor-month the selection covers, and when it was marked paid. */
export type PaidState = { processor: string; period: string; closed_at: string | null };

const monthsText = (s: ReportSelection) =>
  s.from === s.to ? monthText(s.from) : `${monthText(s.from)} to ${monthText(s.to)}`;

const processorText = (s: ReportSelection) => s.processor ?? "All processors";

/**
 * The download's name: residual-report-1-2026-07-all-processors.xlsx, or
 * residual-report-2-2026-06-to-2026-07-netevia-hq.xlsx. The browser names the
 * file from this (a Blob URL carries no Content-Disposition) and the function
 * sends it in the header, so both read it here.
 */
export function reportFileName(s: ReportSelection): string {
  const number = s.report === "reps" ? 1 : 2;
  const months = s.from === s.to ? monthText(s.from) : `${monthText(s.from)}-to-${monthText(s.to)}`;
  const scope = s.processor === null
    ? "all-processors"
    : s.processor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "processor";
  return `residual-report-${number}-${months}-${scope}.xlsx`;
}

/** The audit row's row_id: which months and which processor were exported. */
export function auditSelection(s: ReportSelection): string {
  return `${s.from}..${s.to} ${s.processor ?? "all processors"}`;
}

type Grid = (Cell | null)[][];

/** The rows above the table: the report, the months, the processor, each covered month's paid state. */
function headerBlock(s: ReportSelection, paid: readonly PaidState[]): Grid {
  const grid: Grid = [
    [textCell(REPORT_TITLES[s.report])],
    [textCell("Months"), textCell(monthsText(s))],
    [textCell("Processor"), textCell(processorText(s))],
  ];
  paid.forEach((state, index) => {
    grid.push([
      textCell(index === 0 ? "Paid state" : null),
      textCell(`${state.processor} ${monthText(state.period)}`),
      textCell(state.closed_at ? `paid ${state.closed_at.slice(0, 10)}` : "not marked paid"),
    ]);
  });
  grid.push([textCell("Committed months only. Every figure is read from the payout ledger.")]);
  grid.push([]);
  return grid;
}

function repGrid(rows: readonly RepSummaryRow[], multiMonth: boolean): Grid {
  const figures = (row: RepSummaryRow) => REP_FIGURES.map(([key]) => moneyCell(row[key]));
  const grid: Grid = [[...REP_TEXT_HEADERS, ...REP_FIGURES.map(([, label]) => label)].map(textCell)];

  const reps = rows.filter((r) => r.row_kind === "rep");
  const months = [...new Set(reps.map((r) => r.period!))];
  for (const month of months) {
    if (multiMonth) grid.push([textCell(monthText(month))]);
    for (const row of reps.filter((r) => r.period === month)) {
      grid.push([textCell(row.agent_code), textCell(row.legal_name), textCell(row.full_name), ...figures(row)]);
    }
  }
  // As the page's footer: one month's total is the grand total, so it is written once.
  for (const row of rows.filter((r) => r.row_kind === "total" || (multiMonth && r.row_kind === "month"))) {
    const label = row.row_kind === "month" ? `${monthText(row.period!)} total` : "Total";
    grid.push([textCell(label), null, null, ...figures(row)]);
  }
  return grid;
}

function merchantGrid(rows: readonly MerchantSummaryRow[], paid: readonly PaidState[], multiMonth: boolean): Grid {
  const figures = (row: MerchantSummaryRow) => MERCHANT_FIGURES.map(([key]) => moneyCell(row[key]));
  const grid: Grid = [[...MERCHANT_TEXT_HEADERS, ...MERCHANT_FIGURES.map(([, label]) => label)].map(textCell)];
  const paidAt = new Map(paid.map((p) => [`${p.processor}|${p.period}`, p.closed_at]));

  // The page's groups, in the functions' order: each processor-month's lines, then its subtotal.
  type Group = { period: string; processor: string | null; lines: MerchantSummaryRow[]; subtotal?: MerchantSummaryRow };
  const groups = new Map<string, Group>();
  for (const row of rows) {
    if (row.row_kind === "total") continue;
    const key = `${row.period}|${row.processor ?? ""}`;
    const group = groups.get(key) ?? { period: row.period!, processor: row.processor, lines: [] };
    if (row.row_kind === "merchant") group.lines.push(row);
    else group.subtotal = row;
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    for (const row of group.lines) {
      grid.push([
        textCell(group.processor),
        textCell(row.merchant_name),
        textCell(row.mid),
        textCell(row.owner_code),
        textCell(row.owner_name),
        ...figures(row),
      ]);
    }
    if (group.subtotal) {
      const name = group.processor ?? "No processor";
      const label = multiMonth ? `${name} · ${monthText(group.period)}` : name;
      const state = paidAt.get(`${group.processor}|${group.period}`) ? "paid" : "not marked paid";
      grid.push([textCell(`${label} subtotal (${state})`), null, null, null, null, ...figures(group.subtotal)]);
    }
  }
  const total = rows.find((r) => r.row_kind === "total");
  if (total) grid.push([textCell("Grand total"), null, null, null, null, ...figures(total)]);
  return grid;
}

/** A1-style column letters: 0 -> A, 25 -> Z, 26 -> AA. */
export function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

export type ReportSheet = {
  sheetName: string;
  fileName: string;
  /** A SheetJS worksheet: cells keyed A1, B1, ..., plus "!ref" and "!cols". */
  sheet: Record<string, unknown>;
  /** The 1-based row of the column headers, for tests and readers. */
  headerRow: number;
};

/**
 * The selection's sheet: the header block, the page's columns in the page's
 * order, its rows, subtotals and totals. `rows` are the SQL function's rows,
 * unchanged; `paid` the covered processor-months, as the page lists them.
 */
export function buildReportSheet(
  selection: ReportSelection,
  rows: readonly RepSummaryRow[] | readonly MerchantSummaryRow[],
  paid: readonly PaidState[],
): ReportSheet {
  const multiMonth = selection.from !== selection.to;
  const head = headerBlock(selection, paid);
  const body = selection.report === "reps"
    ? repGrid(rows as readonly RepSummaryRow[], multiMonth)
    : merchantGrid(rows as readonly MerchantSummaryRow[], paid, multiMonth);
  const grid = [...head, ...body];

  const sheet: Record<string, unknown> = {};
  let width = 1;
  grid.forEach((cells, r) => {
    width = Math.max(width, cells.length);
    cells.forEach((cell, c) => {
      if (cell !== null) sheet[`${columnName(c)}${r + 1}`] = cell;
    });
  });
  sheet["!ref"] = `A1:${columnName(width - 1)}${Math.max(grid.length, 1)}`;
  const textColumns = selection.report === "reps" ? REP_TEXT_HEADERS.length : MERCHANT_TEXT_HEADERS.length;
  sheet["!cols"] = Array.from({ length: width }, (_, c) => ({ wch: c < textColumns ? 28 : 18 }));

  return {
    sheetName: REPORT_TITLES[selection.report],
    fileName: reportFileName(selection),
    sheet,
    headerRow: head.length + 1,
  };
}
