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

/**
 * The nine columns, by the key each maps to on a staging row, plus `line`,
 * which maps to nothing: it is read only to skip adjustment lines.
 */
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
  "line",
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
  line: "Line",
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
  // The export's own marker (phase 5 of docs/design/residual-splits.md): a row
  // whose Line says "Adjustment" is an adjustment line exported from the CRM,
  // and is skipped rather than staged. See isAdjustmentLine.
  "line",
];

/**
 * Whether a row's Line cell marks it as an exported adjustment line.
 *
 * An adjustment is entered in the CRM (post_share_correction) and only ever
 * there. Re-importing one would make it an IMPORT line -- or merge it into the
 * import line on the same key -- so the round trip would quietly turn a
 * correction into processor data. Only the export's exact word counts, in any
 * case; anything else in the column (blank, as the export writes for an
 * import line) imports normally.
 */
export function isAdjustmentLine(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "adjustment";
}

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
  /** Set only when the reason is worth naming to an admin (MISPLACED_COMMA). */
  problem?: string;
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

  // D-10. The commas were stripped wherever they were, so "12,99" — a decimal
  // comma — imported as 1299, a hundred times the figure. A comma now has to be
  // real thousands grouping. Checked only once the old path has produced a
  // number, so everything without a misplaced comma reads exactly as before.
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
 * Shared with nothing on purpose — parseFigureInput in lib/payouts.ts carries
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
  /**
   * Cell-level reasons behind a bad_number, worded for the review screen —
   * e.g. `Total cost "12,99" has a comma that is not a thousands separator…`.
   * Empty when a figure was simply unreadable; blockerMessage covers that.
   */
  number_problems: string[];
};

export type ParseResult =
  | { ok: false; error: string }
  | {
      ok: true;
      rows: ParsedResidualRow[];
      /** Rows marked Line = Adjustment, skipped rather than staged. */
      adjustments_ignored: number;
    };

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
  let adjustmentsIgnored = 0;

  for (let offset = 1; offset < sheet.length; offset += 1) {
    const raw = sheet[offset];
    // +1 because a spreadsheet's header is row 1, which is what an admin counts.
    const rowNumber = offset + 1;

    if (isBlankRow(raw)) continue;

    // Before anything else is read, and in particular before the duplicate
    // check: an exported adjustment shares its (period, agent, MID) with the
    // import line beside it, and would otherwise block that line as a
    // duplicate.
    if (isAdjustmentLine(cellAt(raw, "line"))) {
      adjustmentsIgnored += 1;
      continue;
    }

    const period = parsePeriodCell(cellAt(raw, "period"));
    const agentNumber = parseTextCell(cellAt(raw, "agent_number"));
    const mid = parseTextCell(cellAt(raw, "mid"));

    const volume = parseNumberCell(cellAt(raw, "volume"));
    const averageTicket = parseNumberCell(cellAt(raw, "average_ticket"));
    const totalCost = parseNumberCell(cellAt(raw, "total_cost"));
    const residualIncome = parseNumberCell(cellAt(raw, "residual_income"));
    const repSplit = parseNumberCell(cellAt(raw, "rep_split"));

    const numberProblems: string[] = [];
    for (const [column, cell] of [
      ["volume", volume],
      ["average_ticket", averageTicket],
      ["total_cost", totalCost],
      ["residual_income", residualIncome],
      ["rep_split", repSplit],
    ] as const) {
      if (cell.problem) {
        numberProblems.push(
          `${COLUMN_HEADERS[column]} "${rawText(cellAt(raw, column)) ?? ""}" ${cell.problem}.`,
        );
      }
    }

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
      number_problems: numberProblems,
    });
  }

  if (rows.length === 0) {
    return {
      ok: false,
      error:
        adjustmentsIgnored > 0
          ? "That file holds only adjustment lines. Adjustments are entered in the CRM, not imported."
          : "That file has a header but no data rows.",
    };
  }

  return { ok: true, rows, adjustments_ignored: adjustmentsIgnored };
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
// Shared-account preview flags (phase 4b of docs/design/residual-splits.md, §7)
// ---------------------------------------------------------------------------

/**
 * What commit_residual_import_v2 would do with a row about a shared account,
 * stored on the staging row as rep_payout_import_rows.preview_flag. The codes
 * are v2's own plan names, so a flag and the skip it predicts read the same.
 *
 *   share_not_applied  the file names a rep outside the pair: imported as an
 *                      ordinary line for that rep; the share pays nothing.
 *   partner_named      the file names the partner: v2 skips the row.
 *   line_not_shared    the file names the signer, but a key of the pair
 *                      already holds a line that is not this share's: skipped.
 *
 * A flag never blocks. The commit recomputes all of this from the shares in
 * force when it runs, so this is advisory by construction.
 *
 * THIS MIRRORS v2's PLAN, and nothing type-checks the pair: the CASE in
 * commit_residual_import_v2 (20261016120000) is the authority. Change both
 * together. tests/live/residual-import.test.ts runs a file through this
 * preview and then through v2 and requires the flags to predict exactly the
 * rows v2 skipped.
 */
export type SharePreviewFlag =
  | "share_not_applied"
  | "partner_named"
  | "line_not_shared";

export type PreviewShare = {
  id: number;
  /** The share's merchant's CURRENT mid, as v2 joins it. */
  mid: string;
  primaryAgentId: string;
  secondaryAgentId: string;
  /** YYYY-MM-DD, first of a month. */
  effectiveFrom: string;
  /** YYYY-MM-DD, exclusive; null = open-ended. */
  effectiveTo: string | null;
};

export type PreviewLedgerLine = {
  period: string;
  mid: string;
  agentId: string;
  repShareId: number | null;
  shareRole: string | null;
  /**
   * 'import' or 'adjustment'. v2's line_not_shared looks at IMPORT lines only
   * (20261016160000): an adjustment posted into the month must not make the
   * signer's row look blocked. Absent means an import line.
   */
  lineKind?: string;
};

export type PreviewRow = {
  period: string | null;
  agentId: string | null;
  mid: string | null;
  /** A blocked row is never flagged: it cannot be committed as it stands. */
  blocked: boolean;
};

export type SharePreview = { flag: SharePreviewFlag; share: PreviewShare };

/** The share covering this MID in this month, as v2's join finds it. */
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

export function previewSharedRow(
  row: PreviewRow,
  shares: readonly PreviewShare[],
  ledger: readonly PreviewLedgerLine[],
): SharePreview | null {
  if (row.blocked) return null;
  if (row.period === null || row.agentId === null || row.mid === null) {
    return null;
  }

  const share = shareCovering(shares, row.mid, row.period);
  if (share === null) return null;

  if (row.agentId === share.secondaryAgentId) {
    return { flag: "partner_named", share };
  }
  if (row.agentId !== share.primaryAgentId) {
    return { flag: "share_not_applied", share };
  }

  const foreign = ledger.some(
    (line) =>
      line.lineKind !== "adjustment" &&
      line.period === row.period &&
      line.mid === row.mid &&
      (line.agentId === share.primaryAgentId ||
        line.agentId === share.secondaryAgentId) &&
      (line.repShareId !== share.id ||
        line.shareRole !==
          (line.agentId === share.primaryAgentId ? "primary" : "secondary")),
  );
  return foreign ? { flag: "line_not_shared", share } : null;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-07-01" -> "July 2026". */
export function monthLabel(period: string): string {
  const [year, month] = period.split("-");
  return `${MONTHS[Number(month) - 1] ?? month} ${year}`;
}

/** The sentence the review screen shows beside a flagged row. */
export function sharePreviewNote(
  preview: SharePreview,
  context: {
    mid: string;
    period: string;
    signerName: string;
    partnerName: string;
    fileRepName: string;
  },
): string {
  const pair = `${context.signerName} / ${context.partnerName}`;
  const when = monthLabel(context.period);
  switch (preview.flag) {
    case "share_not_applied":
      return `Share ${pair} not applied to MID ${context.mid} for ${when}: the file names ${context.fileRepName}. This row imports as an ordinary line for ${context.fileRepName}.`;
    case "partner_named":
      return `MID ${context.mid} is shared by ${pair} for ${when}, and the file names the partner. This row will be skipped: a shared account is imported on the signer's row.`;
    case "line_not_shared":
      return `MID ${context.mid} is shared by ${pair} for ${when}, but the ledger already holds a line for one of them on this MID that is not part of the share. This row will be skipped.`;
  }
}

// ---------------------------------------------------------------------------
// Unshared-row preview flags (phase 5 of docs/design/residual-splits.md, §7)
// ---------------------------------------------------------------------------

/**
 * Two warnings about a row NO share covers, so v2 imports it as an ordinary
 * line paying the rep the file names the whole rep side. Neither predicts a
 * skip -- v2 skips nothing here -- so unlike the three above they mirror no
 * plan; they are heuristics, advisory by construction.
 *
 *   share_not_in_force  the MID's merchant has a share, but none covers this
 *                       month (it ended, or starts later). Without this, v2
 *                       pays the signer 100% of a month the admin may believe
 *                       is shared.
 *   looks_shared        no share exists on the MID, and another rep is paid on
 *                       it within LOOKS_SHARED_MONTHS before this row's month
 *                       or in that month itself -- a committed import line, or
 *                       another row of the same file. (The CRM owner is not a
 *                       signal: merchants.agent_id is often not the payee.)
 *
 * Applied only where previewSharedRow found nothing, so a row carries at most
 * one flag, in that precedence: covered-share flags, then share_not_in_force,
 * then looks_shared.
 */
export type UnsharedPreviewFlag = "share_not_in_force" | "looks_shared";

/** The design's six-month lookback (design §7, §14). */
export const LOOKS_SHARED_MONTHS = 6;

/** A rep paid on a MID in a month: a committed import line, or a file row. */
export type PaidLine = { period: string; mid: string; agentId: string };

export type UnsharedPreview =
  | { flag: "share_not_in_force"; shares: PreviewShare[] }
  | { flag: "looks_shared"; others: PaidLine[] };

/** "2026-07-01" minus n months, as YYYY-MM-01. Arithmetic, never Date. */
export function monthsBefore(period: string, n: number): string {
  const [year, month] = period.split("-").map(Number);
  const index = year * 12 + (month - 1) - n;
  const y = Math.floor(index / 12);
  const m = index - y * 12 + 1;
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

/** The first month of the lookback window for a row in `period`. */
export function lookbackStart(period: string): string {
  return monthsBefore(period, LOOKS_SHARED_MONTHS);
}

export function previewUnsharedRow(
  row: PreviewRow,
  shares: readonly PreviewShare[],
  paid: readonly PaidLine[],
): UnsharedPreview | null {
  if (row.blocked) return null;
  if (row.period === null || row.agentId === null || row.mid === null) {
    return null;
  }
  const { period, agentId, mid } = row;

  if (shareCovering(shares, mid, period) !== null) return null;

  const onMid = shares.filter((share) => share.mid === mid);
  if (onMid.length > 0) {
    return { flag: "share_not_in_force", shares: onMid };
  }

  const from = lookbackStart(period);
  const others = paid.filter(
    (line) =>
      line.mid === mid &&
      line.agentId !== agentId &&
      line.period >= from &&
      line.period <= period,
  );
  return others.length > 0 ? { flag: "looks_shared", others } : null;
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
    fileRepName: string;
    /** False when no merchant in the CRM has this MID. */
    hasMerchant: boolean;
    nameOf: (agentId: string) => string;
  },
): string {
  const when = monthLabel(context.period);
  if (preview.flag === "share_not_in_force") {
    const ranges = preview.shares
      .map(
        (share) =>
          `${context.nameOf(share.primaryAgentId)} / ${context.nameOf(share.secondaryAgentId)}, ${shareRange(share)}`,
      )
      .join("; ");
    return `MID ${context.mid} has a share (${ranges}), but it does not cover ${when}. This row imports as an ordinary line paying ${context.fileRepName} the whole rep side.`;
  }
  const names = [...new Set(preview.others.map((line) => context.nameOf(line.agentId)))]
    .sort()
    .join(", ");
  const advice = context.hasMerchant
    ? "If two reps share this account, set it on the merchant page before committing."
    : "No merchant in the CRM has this MID, so a share cannot be set on it until one is added.";
  return `MID ${context.mid} is also paid to ${names} within the six months to ${when}, and no share is set on it. This row imports for ${context.fileRepName} alone. ${advice}`;
}
