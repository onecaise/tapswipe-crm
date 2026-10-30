// Parsing a processor's monthly residual XLSX into staging rows, and the
// rules that decide each staged row's refusals, warnings and notes.
//
// Pure functions over already-extracted cell values and already-fetched
// lookups: this file never sees a workbook or a database. SheetJS and the
// queries live in parse-residual-import, so this stays dependency-free and
// needs no deno.json import map of its own -- the same arrangement
// _shared/documents.ts and _shared/admin-users.ts use.
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
// create one. (commit v3, phase 8, recomputes the three warnings and the MID
// refusals in SQL; that TS/SQL pair is pinned by the live suite, memo §2.4.)
//
// THE FILE (phase 7 of docs/design/intake-and-reports.md, §0b.1 and §1.G):
// six columns, Processor, Merchant Number, Merchant Name, Income Type, Volume,
// Residual. The month and the processor come from the BATCH (chosen on the
// upload page), never from a cell. The payee is the owner of the merchant whose
// MID the row names; the file names no rep.

/** The six columns, by the key each maps to on a staging row. */
export const RESIDUAL_COLUMNS = [
  "processor",
  "mid",
  "merchant_name",
  "income_type",
  "volume",
  "residual_income",
] as const;

export type ResidualColumn = (typeof RESIDUAL_COLUMNS)[number];

/**
 * The header text each column is recognised by, as Owen's real file spells it.
 *
 * Canonical spellings only -- deliberately no alias list. A processor that ships a
 * differently-named column should fail the whole parse with a message naming what
 * is missing, rather than being silently guessed at: mapping "Amount" onto the
 * residual, or "Merchant" onto the MID, produces a plausible-looking import of the
 * wrong numbers. Adding an alias is a decision someone should make while looking
 * at a real file. Matching is case- and space-insensitive (normalizeHeader).
 */
export const COLUMN_HEADERS: Record<ResidualColumn, string> = {
  processor: "Processor",
  mid: "Merchant Number",
  merchant_name: "Merchant Name",
  income_type: "Income Type",
  volume: "Volume",
  residual_income: "Residual",
};

/** All six are required (memo §1.G). */
export const REQUIRED_COLUMNS: readonly ResidualColumn[] = RESIDUAL_COLUMNS;

/**
 * The export's own header names (export-residuals). NOT an import format any
 * more (memo §2.6): the export keeps this header until phase 11 replaces it,
 * and the parser refuses a file carrying either CRM_EXPORT_MARKERS header.
 */
export const EXPORT_COLUMN_HEADERS = {
  period: "Period",
  agent_number: "Agent #",
  mid: "MID",
  merchant_name: "Merchant name",
  volume: "Volume",
  average_ticket: "Average ticket",
  total_cost: "Total cost",
  residual_income: "Residual income",
  rep_split: "Rep split",
  line: "Line",
} as const;

/**
 * Headers only the CRM's own export carries. A file with one is an export
 * being re-imported by mistake, which would count each shared account's volume
 * once per rep (memo §2.6), so it is refused with its own sentence rather than
 * "missing columns".
 */
export const CRM_EXPORT_MARKERS = ["Agent #", "Rep payout"] as const;

/** The one Income Type a residual file may carry (§0b.1). */
export const RESIDUAL_INCOME_TYPE = "Residuals";

/**
 * Why a row cannot be imported, in precedence order (memo §2.4). Every code a
 * row trips is kept (rep_payout_import_rows.blockers); `blocker` is the first of
 * them in this order. Identity first: a row with no readable MID cannot be
 * checked for anything else, and a repeated or unknown MID is what an admin
 * fixes before a figure.
 */
export const RESIDUAL_BLOCKERS = [
  "missing_mid",
  "duplicate_mid",
  "unknown_mid",
  "mid_in_other_batch",
  "wrong_income_type",
  "missing_figure",
  "unreadable_number",
] as const;

export type ResidualBlocker = (typeof RESIDUAL_BLOCKERS)[number];

/**
 * The three confirmable warnings (memo §2.4, §0b.3), stored on the staged row
 * (rep_payout_import_rows.warnings). Confirmed once per TYPE per import, never
 * per line; commit v3 (phase 8) recomputes them and refuses a type nobody
 * confirmed.
 */
export const RESIDUAL_WARNINGS = [
  "processor_mismatch",
  "inactive_merchant",
  "bad_numbers",
] as const;

export type ResidualWarning = (typeof RESIDUAL_WARNINGS)[number];

/** Sorts a row's codes into precedence order, without repeats. */
export function orderBlockers(
  codes: readonly ResidualBlocker[],
): ResidualBlocker[] {
  return RESIDUAL_BLOCKERS.filter((code) => codes.includes(code));
}

/** The most important of a row's blockers, or null if it has none. */
export function pickBlocker(
  codes: readonly ResidualBlocker[],
): ResidualBlocker | null {
  return orderBlockers(codes)[0] ?? null;
}

/** "2026-07-01" -> "July 2026". */
export function monthLabel(period: string): string {
  const [year, month] = period.split("-");
  return `${MONTHS[Number(month) - 1] ?? month} ${year}`;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Human-readable text for each blocker, shown on the review screen. */
export function blockerMessage(
  blocker: ResidualBlocker,
  context: {
    mid?: string | null;
    midCell?: string | null;
    rows?: readonly number[];
    incomeType?: string | null;
    period?: string;
  } = {},
): string {
  const mid = context.mid ?? "";
  switch (blocker) {
    case "missing_mid":
      return context.midCell
        ? `Merchant Number "${context.midCell}" is not a number made of digits only, so there is nothing to file it against.`
        : "This row has no Merchant Number, so there is nothing to file it against.";
    case "duplicate_mid":
      return `MID ${mid} appears on rows ${(context.rows ?? []).join(", ")}. Fix the file and upload it again.`;
    case "unknown_mid":
      return `MID ${mid} is not a merchant in the CRM. Add the merchant (or correct its MID), then Read again.`;
    case "mid_in_other_batch":
      return `MID ${mid} already has a line for ${
        context.period ? monthLabel(context.period) : "this month"
      } from another processor's import. Two processors cannot both pay one MID for one month.`;
    case "wrong_income_type":
      return `Income Type is "${context.incomeType ?? ""}", not ${RESIDUAL_INCOME_TYPE}. A residual file holds residuals only.`;
    case "missing_figure":
      return "The Volume or the Residual on this row is blank.";
    case "unreadable_number":
      return "The Volume or the Residual on this row could not be read as a number.";
  }
}

/**
 * Collapses a header cell to a comparable form: a leading BOM and a leading
 * apostrophe (Excel's text marker) dropped, every kind of whitespace removed
 * (so "Merchant  Number", " merchant number " and a non-breaking space all
 * match), lower case. A trailing colon or period is dropped too.
 */
export function normalizeHeader(value: unknown): string {
  return String(value ?? "")
    .replace(/^[\s\uFEFF]+/, "")
    .replace(/^'/, "")
    .replace(/[\s\uFEFF]+/g, "")
    .replace(/[:.]+$/, "")
    .toLowerCase();
}

const HEADER_LOOKUP = new Map<string, ResidualColumn>(
  RESIDUAL_COLUMNS.map((column) => [
    normalizeHeader(COLUMN_HEADERS[column]),
    column,
  ]),
);

const EXPORT_MARKER_LOOKUP = new Set(CRM_EXPORT_MARKERS.map(normalizeHeader));

export type HeaderMap = {
  /** Column key -> zero-based index in the sheet's rows. */
  index: Partial<Record<ResidualColumn, number>>;
  /** Canonical names of required columns the file does not have. */
  missing: string[];
  /** Canonical names of columns the header row carries more than once. */
  repeated: string[];
  /** True when the header row has a column only the CRM's export carries. */
  crmExport: boolean;
};

/**
 * Maps a sheet's header row onto column keys.
 *
 * A missing REQUIRED header fails the whole parse rather than blocking rows
 * individually: a file with the wrong shape has no rows worth reviewing, and
 * forty identical blockers is a worse message than one naming the column. A
 * column given twice fails it too: which copy holds the real figures is not
 * something to guess.
 */
export function mapHeaders(headerRow: readonly unknown[]): HeaderMap {
  const index: Partial<Record<ResidualColumn, number>> = {};
  const repeated = new Set<ResidualColumn>();
  let crmExport = false;

  headerRow.forEach((cell, position) => {
    const normalized = normalizeHeader(cell);
    if (EXPORT_MARKER_LOOKUP.has(normalized)) crmExport = true;
    const column = HEADER_LOOKUP.get(normalized);
    if (column === undefined) return;
    if (index[column] === undefined) {
      index[column] = position;
    } else {
      repeated.add(column);
    }
  });

  const missing = REQUIRED_COLUMNS.filter(
    (column) => index[column] === undefined,
  ).map((column) => COLUMN_HEADERS[column]);

  return {
    index,
    missing,
    repeated: RESIDUAL_COLUMNS.filter((c) => repeated.has(c)).map(
      (c) => COLUMN_HEADERS[c],
    ),
    crmExport,
  };
}

/** Values that mean "this cell is empty", as distinct from zero. */
const BLANK_CELLS = new Set(["", "-", "--", "—", "–", "n/a", "na", "null"]);

export type NumberCell = {
  /** Null when the cell is blank -- which is NOT the same as zero. */
  value: number | null;
  /** False when there was text that could not be read as a number. */
  ok: boolean;
  /** Set only when the reason is worth naming to an admin (MISPLACED_COMMA). */
  problem?: string;
};

/**
 * Reads a money cell the way Excel and processors actually emit them.
 *
 * Tolerates a currency symbol before or after the minus sign ("-$11.76",
 * "$-11.76"), thousands separators ("$76,877.18"), surrounding whitespace, a
 * trailing percent sign, and accounting parentheses for negatives.
 *
 * Blank is null, not zero. On a residual file a blank Volume or Residual is the
 * missing_figure refusal (memo §1.G): "this merchant earned nothing" and "the
 * cell is empty" are different facts, and committing the second would write a
 * line with no payout.
 */
export function parseNumberCell(value: unknown): NumberCell {
  if (value === null || value === undefined) return { value: null, ok: true };

  // SheetJS gives a real number for a numeric cell, which needs none of the
  // text handling below and must not be run through it -- String(1e21) is
  // "1e+21", which the cleanup would mangle.
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? { value: round2(value), ok: true }
      : { value: null, ok: false };
  }

  const text = String(value).replace(/\uFEFF/g, "").trim();
  if (BLANK_CELLS.has(text.toLowerCase())) return { value: null, ok: true };

  const negative = /^\(.*\)$/.test(text);
  const cleaned = text
    .replace(/^\((.*)\)$/, "$1")
    .replace(/[$\s,]/g, "")
    .replace(/%$/, "");

  if (cleaned === "" || cleaned === "-") return { value: null, ok: true };

  // Rejected explicitly rather than left to Number(), which accepts "0x10",
  // "1e5" and "Infinity" -- none of which belongs in a residual report, and each
  // of which would import a figure nobody typed.
  if (!/^-?\d*\.?\d+$/.test(cleaned)) return { value: null, ok: false };

  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return { value: null, ok: false };

  // D-10. The commas were stripped wherever they were, so "12,99" -- a decimal
  // comma -- imported as 1299, a hundred times the figure. A comma now has to be
  // real thousands grouping.
  if (text.includes(",") && !isThousandsGrouped(text)) {
    return { value: null, ok: false, problem: MISPLACED_COMMA };
  }

  return { value: round2(negative ? -parsed : parsed), ok: true };
}

/** Why a figure with a misplaced comma was refused, for the review screen. */
export const MISPLACED_COMMA =
  "has a comma that is not a thousands separator — use a period for decimals, for example 12.99";

/**
 * Whether every comma in a cell is a thousands separator: `1,299.00`, `12,345`.
 * The currency sign, whitespace, percent, accounting parentheses and minus are
 * peeled off first, matching what parseNumberCell tolerates around the digits.
 * Shared with nothing on purpose -- parseFigureInput in lib/payouts.ts carries
 * its own copy of the same shape (see the note above that function).
 */
function isThousandsGrouped(text: string): boolean {
  const body = text
    .replace(/^\((.*)\)$/, "$1")
    .replace(/[$\s]/g, "")
    .replace(/%$/, "")
    .replace(/^-/, "");
  return /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(body);
}

/** Half-away-from-zero, matching Postgres's round() on numeric. */
function round2(value: number): number {
  const scaled = Math.round(Math.abs(value) * 100) / 100;
  return value < 0 ? -scaled : scaled;
}

/** Reads a cell as trimmed text, or null when it is empty. */
export function parseTextCell(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\uFEFF/g, "").trim();
  return text === "" ? null : text;
}

export type MidCell = {
  /** The MID as text, digits only; null when blank or unreadable. */
  mid: string | null;
  /** What the cell held, when it held something that is not a MID. */
  unreadable: string | null;
};

/**
 * Reads a Merchant Number as TEXT, never as a number (memo §0b.1).
 *
 * Real MIDs are 11 to 12 digits with leading zeros possible. `raw` is the
 * cell's value, `formatted` its displayed text (SheetJS `w`):
 *
 *   - a text cell is used as written, after a leading apostrophe (Excel's text
 *     marker), a BOM and surrounding whitespace are stripped;
 *   - a NUMERIC cell is read from its formatted text when that is all digits --
 *     a "000000000000" number format is the only place a stored-as-number MID's
 *     leading zeros survive -- and otherwise from the integer itself, written
 *     out digit for digit (never through exponent notation: Excel's General
 *     format shows a 12-digit number as "1.23457E+11");
 *   - anything that is not all digits after that (a fraction, a negative, a
 *     number beyond 2^53, "4400-1234") is unreadable, which is missing_mid with
 *     the cell quoted. The length is not checked: the unknown_mid refusal is
 *     what catches a MID the CRM does not hold.
 */
export function parseMidCell(raw: unknown, formatted?: unknown): MidCell {
  if (raw === null || raw === undefined) return { mid: null, unreadable: null };

  if (typeof raw === "number") {
    const shown = typeof formatted === "string" ? formatted.trim() : "";
    if (/^\d+$/.test(shown)) return { mid: shown, unreadable: null };
    // String() of a safe integer is its digits: exponent notation starts at
    // 1e21, far beyond Number.MAX_SAFE_INTEGER.
    if (Number.isSafeInteger(raw) && raw >= 0) {
      return { mid: String(raw), unreadable: null };
    }
    return { mid: null, unreadable: shown || String(raw) };
  }

  const text = String(raw)
    .replace(/\uFEFF/g, "")
    .trim()
    .replace(/^'/, "")
    .trim();
  if (text === "") return { mid: null, unreadable: null };
  if (/^\d+$/.test(text)) return { mid: text, unreadable: null };
  return { mid: null, unreadable: text };
}

/** True when an Income Type cell says Residuals (case-insensitive, trimmed). */
export function isResidualIncomeType(value: string | null): boolean {
  return (
    value !== null &&
    value.trim().toLowerCase() === RESIDUAL_INCOME_TYPE.toLowerCase()
  );
}

/** One staging row, before the database lookups. */
export type ParsedResidualRow = {
  /** 1-based spreadsheet row, so an error can name where to look. */
  row_number: number;
  processor_raw: string | null;
  mid_raw: string | null;
  merchant_name_raw: string | null;
  income_type_raw: string | null;
  volume_raw: string | null;
  residual_income_raw: string | null;
  volume: number | null;
  residual_income: number | null;
  /** The refusals the file alone shows, before the MID lookup. */
  blockers: ResidualBlocker[];
  /** One sentence per blocker, worded for the review screen. */
  messages: Partial<Record<ResidualBlocker, string>>;
};

export type ParseResult =
  | { ok: false; error: string }
  | { ok: true; rows: ParsedResidualRow[] };

/**
 * Turns a sheet -- a header row followed by data rows -- into staging rows.
 *
 * `sheet` holds each cell's value (SheetJS raw); `formatted`, when given, the
 * same grid as displayed text (SheetJS `w`), which is only read for the
 * Merchant Number (parseMidCell).
 *
 * `rows[0]` is the header. Entirely blank rows are skipped rather than blocked:
 * processor exports routinely carry trailing empties and a footer gap, and forty
 * "this row has no MID" blockers over blank lines would bury the one that matters.
 */
export function parseResidualSheet(
  sheet: readonly (readonly unknown[])[],
  formatted?: readonly (readonly unknown[])[],
): ParseResult {
  if (sheet.length === 0) {
    return { ok: false, error: "That file has no rows." };
  }

  const headers = mapHeaders(sheet[0]);
  if (headers.crmExport) {
    return {
      ok: false,
      error:
        "This looks like a CRM export, not a processor file: it has an Agent # or Rep payout column. Upload the processor's own residual report.",
    };
  }
  if (headers.missing.length > 0) {
    return {
      ok: false,
      error: `That file is missing ${
        headers.missing.length === 1 ? "a column" : "columns"
      }: ${headers.missing.join(", ")}. A residual file has six: ${RESIDUAL_COLUMNS.map(
        (c) => COLUMN_HEADERS[c],
      ).join(", ")}.`,
    };
  }
  if (headers.repeated.length > 0) {
    return {
      ok: false,
      error: `That file has ${
        headers.repeated.length === 1 ? "a column" : "columns"
      } more than once: ${headers.repeated.join(", ")}.`,
    };
  }

  const at = (
    grid: readonly (readonly unknown[])[] | undefined,
    offset: number,
    column: ResidualColumn,
  ): unknown => {
    const position = headers.index[column];
    return position === undefined ? null : (grid?.[offset]?.[position] ?? null);
  };

  const rows: ParsedResidualRow[] = [];
  /** MID -> every sheet row it is on, for duplicate_mid. */
  const seen = new Map<string, number[]>();

  for (let offset = 1; offset < sheet.length; offset += 1) {
    const raw = sheet[offset];
    // +1 because a spreadsheet's header is row 1, which is what an admin counts.
    const rowNumber = offset + 1;

    if (isBlankRow(raw)) continue;

    const midCell = parseMidCell(at(sheet, offset, "mid"), at(formatted, offset, "mid"));
    const incomeType = parseTextCell(at(sheet, offset, "income_type"));
    const volume = parseNumberCell(at(sheet, offset, "volume"));
    const residual = parseNumberCell(at(sheet, offset, "residual_income"));

    const blockers: ResidualBlocker[] = [];
    const messages: Partial<Record<ResidualBlocker, string>> = {};
    const block = (code: ResidualBlocker, message: string) => {
      if (!blockers.includes(code)) blockers.push(code);
      messages[code] = message;
    };

    if (midCell.mid === null) {
      block("missing_mid", blockerMessage("missing_mid", { midCell: midCell.unreadable }));
    } else {
      seen.set(midCell.mid, [...(seen.get(midCell.mid) ?? []), rowNumber]);
    }

    if (!isResidualIncomeType(incomeType)) {
      block("wrong_income_type", blockerMessage("wrong_income_type", { incomeType }));
    }

    const unreadable: string[] = [];
    for (const [column, cell] of [
      ["volume", volume],
      ["residual_income", residual],
    ] as const) {
      if (!cell.ok) {
        const text = rawText(at(sheet, offset, column)) ?? "";
        unreadable.push(
          cell.problem
            ? `${COLUMN_HEADERS[column]} "${text}" ${cell.problem}.`
            : `${COLUMN_HEADERS[column]} "${text}" could not be read as a number.`,
        );
      }
    }
    if (unreadable.length > 0) block("unreadable_number", unreadable.join(" "));

    const blank = (
      [
        ["volume", volume],
        ["residual_income", residual],
      ] as const
    )
      .filter(([, cell]) => cell.ok && cell.value === null)
      .map(([column]) => COLUMN_HEADERS[column]);
    if (blank.length > 0) {
      block(
        "missing_figure",
        `${blank.join(" and ")} ${blank.length === 1 ? "is" : "are"} blank on this row.`,
      );
    }

    rows.push({
      row_number: rowNumber,
      // The raw text is kept for every cell, so the review screen can show what
      // the file said next to what it was read as, and "Read again" is safe:
      // nothing has been interpreted destructively.
      processor_raw: parseTextCell(at(sheet, offset, "processor")),
      mid_raw: midCell.mid ?? midCell.unreadable,
      merchant_name_raw: parseTextCell(at(sheet, offset, "merchant_name")),
      income_type_raw: incomeType,
      volume_raw: rawText(at(sheet, offset, "volume")),
      residual_income_raw: rawText(at(sheet, offset, "residual_income")),
      volume: volume.value,
      residual_income: residual.value,
      blockers,
      messages,
    });
  }

  if (rows.length === 0) {
    return { ok: false, error: "That file has a header but no data rows." };
  }

  // Every row of a repeated MID is refused, the first one included: which copy
  // is right is not something to guess (memo §0.4).
  for (const row of rows) {
    if (row.blockers.includes("missing_mid") || row.mid_raw === null) continue;
    const onRows = seen.get(row.mid_raw) ?? [];
    if (onRows.length > 1) {
      row.blockers.push("duplicate_mid");
      row.messages.duplicate_mid = blockerMessage("duplicate_mid", {
        mid: row.mid_raw,
        rows: onRows,
      });
    }
  }
  for (const row of rows) row.blockers = orderBlockers(row.blockers);

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

// ---------------------------------------------------------------------------
// The lookups: payee by MID, the refusals that need the database, warnings
// ---------------------------------------------------------------------------

/** The CRM merchant a MID names, as the parser reads it. */
export type MerchantByMid = {
  id: number;
  mid: string;
  /** The owner: the row's payee (memo headline 1). */
  agentId: string;
  status: string | null;
  processor: string | null;
};

/** An import line already in the ledger for the batch's month. */
export type MonthLine = { mid: string; processor: string | null };

/**
 * The MIDs that already have an import line this month from ANOTHER
 * processor's batch: mid_in_other_batch (memo §2.4). A line with no processor
 * -- everything committed before phase 7 -- counts as another processor's
 * (phase 6 build notes): it cannot be told apart from one, and a second line
 * for the MID would pay it twice.
 */
export function midsInOtherBatches(
  lines: readonly MonthLine[],
  batchProcessor: string,
): Set<string> {
  return new Set(
    lines
      .filter((line) => line.processor === null || line.processor !== batchProcessor)
      .map((line) => line.mid),
  );
}

/** Compares two processor names: case, and runs of whitespace, ignored. */
export function sameProcessor(a: string | null, b: string | null): boolean {
  const norm = (value: string | null) =>
    (value ?? "").replace(/[\s\uFEFF]+/g, " ").trim().toLowerCase();
  return a !== null && b !== null && norm(a) === norm(b);
}

/**
 * The three confirmable warnings for one row (memo §2.4):
 *
 *   processor_mismatch  the file's Processor cell is not the batch's processor
 *                       (a blank cell included), or the merchant has a saved
 *                       processor that is not it. A merchant with NO saved
 *                       processor is not a mismatch (A6). Confirming never
 *                       changes the merchant's processor.
 *   inactive_merchant   merchants.status = 'inactive'; 'other' is not (A26).
 *   bad_numbers         volume <= 0, or residual > volume. A negative residual
 *                       on a positive volume is a clawback, not a bad number
 *                       (A25), and imports with no warning; a zero-volume row
 *                       is common (fees, clawbacks), which is why one "yes" per
 *                       import covers every such row (§0b.3).
 *
 * A figure that is blank or unreadable is a blocker, not a bad number, so
 * bad_numbers needs both figures read.
 */
export function rowWarnings(input: {
  fileProcessor: string | null;
  batchProcessor: string;
  merchant: Pick<MerchantByMid, "status" | "processor"> | null;
  volume: number | null;
  residual: number | null;
}): ResidualWarning[] {
  const warnings: ResidualWarning[] = [];
  const merchantDiffers =
    input.merchant !== null &&
    input.merchant.processor !== null &&
    input.merchant.processor !== input.batchProcessor;
  if (!sameProcessor(input.fileProcessor, input.batchProcessor) || merchantDiffers) {
    warnings.push("processor_mismatch");
  }
  if (input.merchant?.status === "inactive") warnings.push("inactive_merchant");
  if (
    input.volume !== null &&
    input.residual !== null &&
    (input.volume <= 0 || input.residual > input.volume)
  ) {
    warnings.push("bad_numbers");
  }
  return warnings;
}

/** "2026-07-01" minus n months, as YYYY-MM-01. Arithmetic, never Date. */
export function monthsBefore(period: string, n: number): string {
  const [year, month] = period.split("-").map(Number);
  const index = year * 12 + (month - 1) - n;
  const y = Math.floor(index / 12);
  const m = index - y * 12 + 1;
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

/** Who a MID paid last month: an import line, signer or unshared only. */
export type LastMonthLine = {
  mid: string;
  agentId: string;
  /** 'secondary' is a partner's half of a shared pair, never "the payee". */
  shareRole: string | null;
};

/**
 * payee_changed (memo A10): last month this MID paid someone, and the
 * merchant's owner -- this month's payee -- is not among them. Informational,
 * never a blocker: it is the only signal that a merchant reassignment moved
 * money. A partner's line is not "who it paid", so a shared MID compares its
 * signer; a MID with no line last month has nothing to compare.
 */
export function previousPayees(
  lines: readonly LastMonthLine[],
  mid: string,
  ownerId: string,
): string[] | null {
  const payees = [
    ...new Set(
      lines
        .filter((line) => line.mid === mid && line.shareRole !== "secondary")
        .map((line) => line.agentId),
    ),
  ];
  if (payees.length === 0 || payees.includes(ownerId)) return null;
  return payees;
}

export function payeeChangedNote(context: {
  mid: string;
  period: string;
  previousNames: readonly string[];
  ownerName: string;
}): string {
  return `Last month (${monthLabel(monthsBefore(context.period, 1))}) MID ${
    context.mid
  } paid ${[...context.previousNames].sort().join(", ")}; this month it pays ${
    context.ownerName
  }, the merchant's current owner. If moving the merchant was not meant to change who is paid, correct its owner before committing.`;
}

// ---------------------------------------------------------------------------
// Shared accounts in the preview (phase 4b of docs/design/residual-splits.md)
// ---------------------------------------------------------------------------
//
// The three share flags v2 needed (share_not_applied, partner_named,
// line_not_shared) went with v2 in phase 8 of docs/design/intake-and-reports.md.
// Under v3 a share's signer IS the merchant's owner (set_merchant_rep_share
// refuses anything else, and an owner cannot be moved while a share is live),
// and a MID with a line already in the month is refused, so none of the three
// can happen; v3 refuses the import if an older share breaks the rule. What
// remains here is share_not_in_force.

export type PreviewShare = {
  id: number;
  /** The share's merchant's CURRENT mid, as the commit joins it. */
  mid: string;
  primaryAgentId: string;
  secondaryAgentId: string;
  /** YYYY-MM-DD, first of a month. */
  effectiveFrom: string;
  /** YYYY-MM-DD, exclusive; null = open-ended. */
  effectiveTo: string | null;
};

export type PreviewRow = {
  period: string | null;
  agentId: string | null;
  mid: string | null;
  /** A blocked row is never flagged: it cannot be committed as it stands. */
  blocked: boolean;
};

/** The share covering this MID in this month, as the commit's join finds it. */
export function shareCovering(
  shares: readonly PreviewShare[],
  mid: string,
  period: string,
): PreviewShare | null {
  return (
    shares.find(
      (share) =>
        share.mid === mid &&
        period >= share.effectiveFrom &&
        (share.effectiveTo === null || period < share.effectiveTo),
    ) ?? null
  );
}

/**
 * share_not_in_force (phase 5 of docs/design/residual-splits.md): the MID's
 * merchant has a share, but none covers this month (it ended, or starts
 * later), so the commit pays the owner the whole rep side of a month the
 * admin may believe is shared. Advisory. Applied only where no share covers
 * the month. (`looks_shared`, the other phase 5 flag, read who the FILE named;
 * the file names nobody now, and payee_changed replaces it.)
 */
export type UnsharedPreview = {
  flag: "share_not_in_force";
  shares: PreviewShare[];
};

export function previewUnsharedRow(
  row: PreviewRow,
  shares: readonly PreviewShare[],
): UnsharedPreview | null {
  if (row.blocked) return null;
  if (row.period === null || row.agentId === null || row.mid === null) {
    return null;
  }
  if (shareCovering(shares, row.mid, row.period) !== null) return null;
  const onMid = shares.filter((share) => share.mid === row.mid);
  return onMid.length > 0 ? { flag: "share_not_in_force", shares: onMid } : null;
}

/** "July 2026" to "September 2026", or "from November 2026". */
function shareRange(share: PreviewShare): string {
  const start = monthLabel(share.effectiveFrom);
  if (share.effectiveTo === null) return `from ${start}`;
  return `${start} to ${monthLabel(monthsBefore(share.effectiveTo, 1))}`;
}

export function unsharedPreviewNote(
  preview: UnsharedPreview,
  context: {
    mid: string;
    period: string;
    ownerName: string;
    nameOf: (agentId: string) => string;
  },
): string {
  const ranges = preview.shares
    .map(
      (share) =>
        `${context.nameOf(share.primaryAgentId)} / ${context.nameOf(share.secondaryAgentId)}, ${shareRange(share)}`,
    )
    .join("; ");
  return `MID ${context.mid} has a share (${ranges}), but it does not cover ${monthLabel(context.period)}. This row imports as an ordinary line paying ${context.ownerName} the whole rep side.`;
}
