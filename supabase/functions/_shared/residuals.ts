// Parsing a processor's monthly residual XLSX into staging rows.
//
// Pure functions over already-extracted cell values: this file never sees a
// workbook. SheetJS lives in the function that calls it, so this stays
// dependency-free and needs no deno.json import map of its own — the same
// arrangement _shared/documents.ts and _shared/admin-users.ts use.
//
// One useful consequence of being dependency-free: Node can import it, so
// tests/unit/residuals-parse.test.ts exercises every rule below under vitest
// without Deno or Docker. That is deliberate. The parsing rules are where the
// judgement lives, and they are the part most likely to be wrong.
//
// NOTE ON DUPLICATION, and why there is none here. The pre-app validators exist
// twice (lib/pre-app-validation.ts and _shared/pre-app-secrets.ts) because a
// shared file could not survive `functions deploy`. That does not apply to this
// module: parsing happens only server-side (RESIDUALS_SPEC decision 22), so there
// is exactly one copy of these rules and no browser twin to drift from. Do not
// create one.

/** The nine columns, by the key each maps to on a staging row. */
export const RESIDUAL_COLUMNS = [
  "period",
  "agent_number",
  "mid",
  "merchant_name",
  "volume",
  "average_ticket",
  "total_cost",
  "residual_income",
  "rep_split",
] as const;

export type ResidualColumn = (typeof RESIDUAL_COLUMNS)[number];

/**
 * The header text each column is recognised by, as it appears in the file.
 *
 * Canonical spellings only — deliberately no alias list. A processor that ships a
 * differently-named column should fail the whole parse with a message naming what
 * is missing, rather than being silently guessed at: mapping "Cost" onto
 * total_cost, or "Merchant" onto merchant_name instead of mid, produces a
 * plausible-looking import of the wrong numbers. Adding an alias is a decision
 * someone should make while looking at a real file.
 */
export const COLUMN_HEADERS: Record<ResidualColumn, string> = {
  period: "Period",
  agent_number: "Agent #",
  mid: "MID",
  merchant_name: "Merchant name",
  volume: "Volume",
  average_ticket: "Average ticket",
  total_cost: "Total cost",
  residual_income: "Residual income",
  rep_split: "Rep split",
};

/**
 * The two columns a fresh processor file will not have.
 *
 * They appear only in this app's own round-trip export, which is how a whole
 * period's figures get bulk-filled in Excel. Their absence is normal; their
 * presence is what tells the commit step to write the money columns.
 */
export const OPTIONAL_COLUMNS: ResidualColumn[] = [
  "residual_income",
  "rep_split",
];

export const REQUIRED_COLUMNS: ResidualColumn[] = RESIDUAL_COLUMNS.filter(
  (column) => !OPTIONAL_COLUMNS.includes(column),
);

/** Blocker codes, in the order rep_payout_import_rows.blocker allows. */
export type ResidualBlocker =
  | "unknown_agent"
  | "unparseable_period"
  | "bad_number"
  | "missing_mid"
  | "duplicate_in_file";

/**
 * Precedence when a row trips more than one.
 *
 * Ordered by what an admin should act on first. A missing MID means the row has
 * no identity at all, so nothing else about it can be checked. An unreadable
 * period means it cannot be filed. An unrecognised agent number comes next
 * because it is the ONLY blocker fixable without touching the spreadsheet — worth
 * surfacing ahead of a bad figure, since resolving it is a different kind of
 * action. Then bad figures, then a duplicate, which is only meaningful once the
 * key parts of both rows have been read.
 */
const BLOCKER_PRECEDENCE: ResidualBlocker[] = [
  "missing_mid",
  "unparseable_period",
  "unknown_agent",
  "bad_number",
  "duplicate_in_file",
];

/** The most important of a row's blockers, or null if it has none. */
export function pickBlocker(
  candidates: readonly (ResidualBlocker | null)[],
): ResidualBlocker | null {
  for (const blocker of BLOCKER_PRECEDENCE) {
    if (candidates.includes(blocker)) return blocker;
  }
  return null;
}

/** Human-readable text for each blocker, shown on the review screen. */
export function blockerMessage(
  blocker: ResidualBlocker,
  context: { agentNumber?: string; mid?: string; period?: string } = {},
): string {
  switch (blocker) {
    case "missing_mid":
      return "This row has no MID, so there is nothing to file it against.";
    case "unparseable_period":
      return `Could not read "${context.period ?? ""}" as a month.`;
    case "unknown_agent":
      return `No rep has agent # ${context.agentNumber ?? ""}.`;
    case "bad_number":
      return "One of the figures on this row could not be read as a number.";
    case "duplicate_in_file":
      return `The file has more than one row for MID ${
        context.mid ?? ""
      } in this period.`;
  }
}

/** Collapses a header cell to a comparable form. */
function normalizeHeader(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    // Punctuation and spacing around "#" is the one genuinely ambiguous bit of
    // these names: "Agent #", "Agent#" and "AGENT  #" are the same column, and
    // which one a processor emits is not worth failing an import over.
    .replace(/\s+/g, " ")
    .replace(/\s*#\s*/g, "#")
    .replace(/[:.]+$/, "")
    .trim();
}

const HEADER_LOOKUP = new Map<string, ResidualColumn>(
  RESIDUAL_COLUMNS.map((column) => [
    normalizeHeader(COLUMN_HEADERS[column]),
    column,
  ]),
);

export type HeaderMap = {
  /** Column key -> zero-based index in the sheet's rows. */
  index: Partial<Record<ResidualColumn, number>>;
  /** Canonical names of required columns the file does not have. */
  missing: string[];
};

/**
 * Maps a sheet's header row onto column keys.
 *
 * A missing REQUIRED header fails the whole parse rather than blocking rows
 * individually: a file with the wrong shape has no rows worth reviewing, and forty
 * identical blockers is a worse message than one naming the column.
 */
export function mapHeaders(headerRow: readonly unknown[]): HeaderMap {
  const index: Partial<Record<ResidualColumn, number>> = {};

  headerRow.forEach((cell, position) => {
    const column = HEADER_LOOKUP.get(normalizeHeader(cell));
    // First occurrence wins. A duplicated header is a malformed sheet, and
    // silently preferring the last copy would make which numbers got imported
    // depend on column order.
    if (column !== undefined && index[column] === undefined) {
      index[column] = position;
    }
  });

  const missing = REQUIRED_COLUMNS.filter(
    (column) => index[column] === undefined,
  ).map((column) => COLUMN_HEADERS[column]);

  return { index, missing };
}

/** Values that mean "this cell is empty", as distinct from zero. */
const BLANK_CELLS = new Set(["", "-", "--", "—", "–", "n/a", "na", "null"]);

export type NumberCell = {
  /** Null when the cell is blank — which is NOT the same as zero. */
  value: number | null;
  /** False when there was text that could not be read as a number. */
  ok: boolean;
};

/**
 * Reads a money or percentage cell the way Excel actually emits them.
 *
 * Tolerates a leading currency symbol, thousands separators, surrounding
 * whitespace, a trailing percent sign, and accounting parentheses for negatives.
 *
 * The distinction that matters most: **blank is null, not zero.** "This merchant
 * earned nothing" and "nobody has filled this in" are different facts, and the
 * whole nullable-column design downstream depends on keeping them apart — a blank
 * coerced to 0 would show as a settled $0.00 payout instead of an outstanding row.
 */
export function parseNumberCell(value: unknown): NumberCell {
  if (value === null || value === undefined) return { value: null, ok: true };

  // SheetJS gives a real number for a numeric cell, which needs none of the
  // text handling below and must not be run through it — String(1e21) is
  // "1e+21", which the cleanup would mangle.
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? { value: round2(value), ok: true }
      : { value: null, ok: false };
  }

  const text = String(value).trim();
  if (BLANK_CELLS.has(text.toLowerCase())) return { value: null, ok: true };

  const negative = /^\(.*\)$/.test(text);
  const cleaned = text
    .replace(/^\((.*)\)$/, "$1")
    .replace(/[$\s,]/g, "")
    .replace(/%$/, "");

  if (cleaned === "" || cleaned === "-") return { value: null, ok: true };

  // Rejected explicitly rather than left to Number(), which accepts "0x10",
  // "1e5" and "Infinity" — none of which belongs in a residual report, and each
  // of which would import a figure nobody typed.
  if (!/^-?\d*\.?\d+$/.test(cleaned)) return { value: null, ok: false };

  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return { value: null, ok: false };

  return { value: round2(negative ? -parsed : parsed), ok: true };
}

/** Half-away-from-zero, matching Postgres's round() on numeric. */
function round2(value: number): number {
  const scaled = Math.round(Math.abs(value) * 100) / 100;
  return value < 0 ? -scaled : scaled;
}

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/** Builds 'YYYY-MM-01' arithmetically. Never via Date#toISOString. */
function firstOfMonth(year: number, month: number): string | null {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

/**
 * A two-digit year, read as this century.
 *
 * "Jul-26" is 2026. There is no residual data from 1926 and none of this app will
 * be running in 2126, so the window is not worth making cleverer than the
 * `year < 2000` guard in firstOfMonth.
 */
function expandYear(text: string): number {
  const year = Number(text);
  return text.length === 2 ? 2000 + year : year;
}

/**
 * Normalises whatever the Period column contains to the first of that month.
 *
 * Returns null for anything it cannot read, which blocks the row. Two things it
 * deliberately refuses rather than guesses:
 *
 *   - **A bare month with no year.** "July" could be any year, and picking one on
 *     a commission record is not a guess worth making.
 *   - **A quarter or range.** "Q3 2026" spans three months and this schema stores
 *     one; there is no honest normalisation.
 *
 * Everything is computed in UTC components. Formatting a locally-constructed Date
 * would reintroduce the timezone shift lib/format.ts documents — and on the first
 * of a month that lands in the previous month, so July would be filed as June.
 */
export function parsePeriodCell(value: unknown): string | null {
  if (value === null || value === undefined) return null;

  // A real Date, which SheetJS produces with cellDates: true.
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return firstOfMonth(value.getUTCFullYear(), value.getUTCMonth() + 1);
  }

  // An Excel serial date. Day 1 is 1900-01-01 and Excel believes 1900 was a leap
  // year, so the epoch that makes every real-world date come out right is
  // 1899-12-30. Serials below 61 fall inside that fiction and are refused rather
  // than silently shifted by a day.
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 61) return null;
    const ms = Date.UTC(1899, 11, 30) + Math.floor(value) * 86_400_000;
    const date = new Date(ms);
    return firstOfMonth(date.getUTCFullYear(), date.getUTCMonth() + 1);
  }

  const text = String(value).trim();
  if (text === "") return null;

  // YYYY-MM or YYYY-MM-DD
  const iso = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(text);
  if (iso) return firstOfMonth(Number(iso[1]), Number(iso[2]));

  // M/YYYY, MM/YYYY, M/D/YYYY, MM/DD/YYYY — and the two-digit-year forms. Told
  // apart by how many segments there are, not by guessing which number is which:
  // with two, it is month and year; with three, US month/day/year, which is what
  // Excel emits in this locale.
  const slashed = /^(\d{1,2})\/(\d{1,4})(?:\/(\d{2,4}))?$/.exec(text);
  if (slashed) {
    const month = Number(slashed[1]);
    const year =
      slashed[3] === undefined
        ? expandYear(slashed[2])
        : expandYear(slashed[3]);
    return firstOfMonth(year, month);
  }

  // "Jul-26", "Jul 2026", "July 2026", "July, 2026"
  const named = /^([a-z]{3,9})[\s,-]+(\d{2,4})$/i.exec(text);
  if (named) {
    const prefix = named[1].toLowerCase();
    const month = MONTH_NAMES.findIndex((name) => name.startsWith(prefix));
    if (month === -1) return null;
    // "ma" would match both March and May, so a prefix has to be unambiguous.
    // findIndex takes the first, which would silently file May as March.
    if (
      MONTH_NAMES.filter((name) => name.startsWith(prefix)).length > 1
    ) {
      return null;
    }
    return firstOfMonth(expandYear(named[2]), month + 1);
  }

  return null;
}

/** Reads a cell as trimmed text, or null when it is empty. */
export function parseTextCell(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === "number" ? String(value) : String(value).trim();
  return text === "" ? null : text;
}

/** One staging row, before the agent-number lookup. */
export type ParsedResidualRow = {
  /** 1-based spreadsheet row, so an error can name where to look. */
  row_number: number;
  period_raw: string | null;
  agent_number_raw: string | null;
  mid_raw: string | null;
  merchant_name_raw: string | null;
  volume_raw: string | null;
  average_ticket_raw: string | null;
  total_cost_raw: string | null;
  residual_income_raw: string | null;
  rep_split_raw: string | null;
  period: string | null;
  volume: number | null;
  average_ticket: number | null;
  total_cost: number | null;
  residual_income: number | null;
  rep_split_pct: number | null;
  /** Everything the parser found wrong, before unknown_agent is considered. */
  blockers: ResidualBlocker[];
};

export type ParseResult =
  | { ok: false; error: string }
  | { ok: true; rows: ParsedResidualRow[] };

/**
 * Turns a sheet — a header row followed by data rows — into staging rows.
 *
 * `rows[0]` is the header. Entirely blank rows are skipped rather than blocked:
 * processor exports routinely carry trailing empties and a footer gap, and forty
 * "this row has no MID" blockers over blank lines would bury the one that matters.
 */
export function parseResidualSheet(
  sheet: readonly (readonly unknown[])[],
): ParseResult {
  if (sheet.length === 0) {
    return { ok: false, error: "That file has no rows." };
  }

  const headers = mapHeaders(sheet[0]);
  if (headers.missing.length > 0) {
    return {
      ok: false,
      error: `That file is missing ${
        headers.missing.length === 1 ? "a column" : "columns"
      }: ${headers.missing.join(", ")}.`,
    };
  }

  const cellAt = (row: readonly unknown[], column: ResidualColumn): unknown => {
    const position = headers.index[column];
    return position === undefined ? null : row[position];
  };

  const rows: ParsedResidualRow[] = [];
  /** (period, agent number, mid) already seen, for duplicate_in_file. */
  const seen = new Map<string, number>();

  for (let offset = 1; offset < sheet.length; offset += 1) {
    const raw = sheet[offset];
    // +1 because a spreadsheet's header is row 1, which is what an admin counts.
    const rowNumber = offset + 1;

    if (isBlankRow(raw)) continue;

    const period = parsePeriodCell(cellAt(raw, "period"));
    const agentNumber = parseTextCell(cellAt(raw, "agent_number"));
    const mid = parseTextCell(cellAt(raw, "mid"));

    const volume = parseNumberCell(cellAt(raw, "volume"));
    const averageTicket = parseNumberCell(cellAt(raw, "average_ticket"));
    const totalCost = parseNumberCell(cellAt(raw, "total_cost"));
    const residualIncome = parseNumberCell(cellAt(raw, "residual_income"));
    const repSplit = parseNumberCell(cellAt(raw, "rep_split"));

    const blockers: ResidualBlocker[] = [];
    if (mid === null) blockers.push("missing_mid");
    if (period === null) blockers.push("unparseable_period");
    if (
      !volume.ok ||
      !averageTicket.ok ||
      !totalCost.ok ||
      !residualIncome.ok ||
      !repSplit.ok
    ) {
      blockers.push("bad_number");
    }

    // The ledger's merge key, so the same duplicate the unique index would refuse
    // is caught here with a message instead. Keyed on the agent NUMBER because the
    // uuid is not known until resolution.
    if (period !== null && mid !== null) {
      const key = `${period}|${agentNumber ?? ""}|${mid}`;
      if (seen.has(key)) {
        blockers.push("duplicate_in_file");
      } else {
        seen.set(key, rowNumber);
      }
    }

    rows.push({
      row_number: rowNumber,
      // The raw text is kept for every cell, so the review screen can show what
      // the file said next to what it was read as. It is also what makes offering
      // a re-parse safe: nothing has been interpreted destructively.
      period_raw: rawText(cellAt(raw, "period")),
      agent_number_raw: agentNumber,
      mid_raw: mid,
      merchant_name_raw: parseTextCell(cellAt(raw, "merchant_name")),
      volume_raw: rawText(cellAt(raw, "volume")),
      average_ticket_raw: rawText(cellAt(raw, "average_ticket")),
      total_cost_raw: rawText(cellAt(raw, "total_cost")),
      residual_income_raw: rawText(cellAt(raw, "residual_income")),
      rep_split_raw: rawText(cellAt(raw, "rep_split")),
      period,
      volume: volume.value,
      average_ticket: averageTicket.value,
      total_cost: totalCost.value,
      residual_income: residualIncome.value,
      rep_split_pct: repSplit.value,
      blockers,
    });
  }

  if (rows.length === 0) {
    return { ok: false, error: "That file has a header but no data rows." };
  }

  return { ok: true, rows };
}

/** A Date has to be rendered deliberately, or the raw column reads "[object Date]". */
function rawText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const text = String(value).trim();
  return text === "" ? null : text;
}

function isBlankRow(row: readonly unknown[]): boolean {
  return row.every(
    (cell) =>
      cell === null || cell === undefined || String(cell).trim() === "",
  );
}
