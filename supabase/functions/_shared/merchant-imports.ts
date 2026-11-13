// Parsing and checking the ISO Hub merchants export for the merchant bulk
// import (phase 14 of docs/design/intake-and-reports.md).
//
// Pure functions: no I/O, no client, dependency-free, so vitest imports it
// (tests/unit/merchant-import-parse.test.ts) and stage-merchant-import turns
// bytes into cells and does the lookups. SheetJS stays in the function, as in
// parse-residual-import.
//
// TWO DERIVATIONS, ON PURPOSE. validateMerchantRows() here marks the problems
// at staging, for the review page; commit_merchant_import() re-derives every
// refusal in SQL (merchant_import_findings) from the staged RAW cells, so a
// staged row that says "fine" commits nothing the database would refuse.
// tests/rls/merchant-import.test.ts pins the two against each other over a
// file that raises every code. Change one, change both.
//
// No browser twin: lib/merchant-imports.ts holds only labels and grouping.

import { detectDelimiter, parseDelimitedText } from "./user-imports.ts";

/** The columns the import reads, keyed. */
export const MERCHANT_IMPORT_COLUMNS = [
  "type",
  "mid",
  "name",
  "split",
  "agent",
  "processor",
  "status",
] as const;

export type MerchantImportColumn = (typeof MERCHANT_IMPORT_COLUMNS)[number];

/** The export's spelling of each column. All seven are required. */
export const COLUMN_HEADERS: Record<MerchantImportColumn, string> = {
  type: "Type",
  mid: "Merchant ID",
  name: "Merchant Name",
  split: "Split",
  agent: "Agent",
  processor: "Processor",
  status: "Status",
};

/**
 * In the export and deliberately not read. Override Agent holds no usable
 * names: an admin adds overrides on each merchant afterwards.
 */
export const IGNORED_HEADERS = ["#", "Added By", "Override Agent"] as const;

/** The most data rows one file may carry; the commit refuses more too. */
export const MAX_IMPORT_ROWS = 2000;

/** The largest file accepted (the batch's source_bytes CHECK says the same). */
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

/** The longest merchant name accepted. */
export const MAX_NAME_LENGTH = 200;

/** Every refusal, in the order the review page lists them. */
export const MERCHANT_IMPORT_BLOCKERS = [
  "invalid_type",
  "missing_mid",
  "invalid_mid",
  "mid_precision",
  "missing_name",
  "invalid_name",
  "missing_agent",
  "unknown_agent",
  "ambiguous_agent",
  "inactive_agent",
  "agent_not_rep",
  "invalid_split",
  "split_above_50",
  "unknown_processor",
  "invalid_status",
  "duplicate_mid_conflict",
  "duplicate_mid_processor",
  "mid_exists",
] as const;

export type MerchantImportBlocker = (typeof MERCHANT_IMPORT_BLOCKERS)[number];

/** Informational only; never refuses. */
export const MERCHANT_IMPORT_NOTES = [
  "mid_from_number",
  "rate_from_profile",
  "rate_differs",
  "merged",
  "name_differs",
] as const;

export type MerchantImportNote = (typeof MERCHANT_IMPORT_NOTES)[number];

/**
 * One normal form for a text cell, merchant_import_norm() in SQL: the
 * mojibake pair ("Â" + non-breaking space, UTF-8 read as Latin-1), a
 * non-breaking space and a BOM each become a space, runs of ASCII whitespace
 * collapse to one space, trimmed. Empty is null.
 */
export function normText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value)
    .replace(/Â /g, " ")
    .replace(/[ ﻿]/g, " ")
    .replace(/[ \t\n\r\f\v]+/g, " ")
    .trim();
  return text === "" ? null : text;
}

/** normText, lower case: how Agent, Processor and Status are compared. */
export function normKey(value: unknown): string | null {
  const text = normText(value);
  return text === null ? null : text.toLowerCase();
}

/** A header cell, compared case-insensitively after normText. */
export function normalizeHeader(value: unknown): string {
  return normKey(value) ?? "";
}

const HEADER_LOOKUP = new Map<string, MerchantImportColumn>(
  MERCHANT_IMPORT_COLUMNS.map((column) => [
    normalizeHeader(COLUMN_HEADERS[column]),
    column,
  ]),
);

export type HeaderMap = {
  index: Partial<Record<MerchantImportColumn, number>>;
  missing: string[];
  repeated: string[];
};

/** Maps the header row; a missing or repeated column fails the file. */
export function mapHeaders(headerRow: readonly unknown[]): HeaderMap {
  const index: Partial<Record<MerchantImportColumn, number>> = {};
  const repeated = new Set<MerchantImportColumn>();
  headerRow.forEach((cell, position) => {
    const column = HEADER_LOOKUP.get(normalizeHeader(cell));
    if (column === undefined) return;
    if (index[column] === undefined) index[column] = position;
    else repeated.add(column);
  });
  return {
    index,
    missing: MERCHANT_IMPORT_COLUMNS.filter((c) => index[c] === undefined).map(
      (c) => COLUMN_HEADERS[c],
    ),
    repeated: MERCHANT_IMPORT_COLUMNS.filter((c) => repeated.has(c)).map(
      (c) => COLUMN_HEADERS[c],
    ),
  };
}

export type MidSource = "text" | "number" | "unsafe_number";

export type MidCell = { text: string | null; source: MidSource };

/**
 * A Merchant ID cell, read as TEXT.
 *
 * Text (every CSV cell, and a text cell in a spreadsheet) is kept as written,
 * trimmed. A NUMERIC spreadsheet cell may already have lost digits: Excel keeps
 * 15 significant digits, so a float, a number over 15 digits, or one shown in
 * exponent form is 'unsafe_number' and refuses (use the original CSV export).
 * A whole number of 15 digits or fewer is accepted as its digits, with a note
 * that leading zeros cannot be recovered from a spreadsheet.
 */
export function parseMidCell(raw: unknown, formatted?: unknown): MidCell {
  if (raw === null || raw === undefined) return { text: null, source: "text" };
  if (typeof raw === "number") {
    const shown = typeof formatted === "string" ? formatted.trim() : "";
    const digits = Number.isSafeInteger(raw) && raw >= 0 ? String(raw) : null;
    if (
      digits === null ||
      digits.length > 15 ||
      /e[+-]?\d/i.test(shown)
    ) {
      return { text: shown || String(raw), source: "unsafe_number" };
    }
    return { text: digits, source: "number" };
  }
  return { text: normText(raw), source: "text" };
}

/** Any other cell as text; a spreadsheet number as JavaScript writes it. */
export function cellText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "boolean") return raw ? "TRUE" : "FALSE";
  const text = String(raw);
  return text.trim() === "" ? null : text;
}

/** One data row as read, before any lookup. */
export type RawMerchantRow = {
  row_number: number;
  type_raw: string | null;
  mid_raw: string | null;
  mid_source: MidSource;
  name_raw: string | null;
  split_raw: string | null;
  agent_raw: string | null;
  processor_raw: string | null;
  status_raw: string | null;
};

export type SheetParseResult =
  | { ok: true; rows: RawMerchantRow[] }
  | { ok: false; error: string };

const CELL_LIMIT = 1000;

function clip(value: string | null): string | null {
  return value === null ? null : value.slice(0, CELL_LIMIT);
}

/**
 * Cells to raw rows. The first non-blank row is the header; blank rows are
 * skipped without renumbering, so "row 22" is the spreadsheet's row 22.
 * `formatted` is the spreadsheet's displayed text (SheetJS raw:false), used only
 * to see whether a numeric Merchant ID was shown in exponent form.
 */
export function parseMerchantSheet(
  cells: readonly (readonly unknown[])[],
  formatted?: readonly (readonly unknown[])[],
): SheetParseResult {
  const isBlank = (row: readonly unknown[] | undefined) =>
    !row || row.every((cell) => cellText(cell) === null);

  const headerAt = cells.findIndex((row) => !isBlank(row));
  if (headerAt === -1) return { ok: false, error: "That file is empty." };

  const headers = mapHeaders(cells[headerAt]);
  if (headers.missing.length > 0) {
    return {
      ok: false,
      error: `That file is missing the column${headers.missing.length === 1 ? "" : "s"} ${
        headers.missing.join(", ")
      }. Use the ISO Hub merchants export as it was downloaded.`,
    };
  }
  if (headers.repeated.length > 0) {
    return {
      ok: false,
      error: `That file has the column${headers.repeated.length === 1 ? "" : "s"} ${
        headers.repeated.join(", ")
      } more than once, so which one to read is not clear.`,
    };
  }

  const at = (row: readonly unknown[] | undefined, column: MerchantImportColumn) =>
    row?.[headers.index[column] as number] ?? null;

  const rows: RawMerchantRow[] = [];
  for (let i = headerAt + 1; i < cells.length; i += 1) {
    const row = cells[i];
    if (isBlank(row)) continue;
    const mid = parseMidCell(at(row, "mid"), at(formatted?.[i], "mid"));
    rows.push({
      row_number: i + 1,
      type_raw: clip(cellText(at(row, "type"))),
      mid_raw: clip(mid.text),
      mid_source: mid.source,
      name_raw: clip(cellText(at(row, "name"))),
      split_raw: clip(cellText(at(row, "split"))),
      agent_raw: clip(cellText(at(row, "agent"))),
      processor_raw: clip(cellText(at(row, "processor"))),
      status_raw: clip(cellText(at(row, "status"))),
    });
  }

  if (rows.length === 0) {
    return { ok: false, error: "That file has a header row and no merchants under it." };
  }
  if (rows.length > MAX_IMPORT_ROWS) {
    return {
      ok: false,
      error: `That file has ${rows.length} merchants; at most ${MAX_IMPORT_ROWS} can be imported at once. Split it into smaller files.`,
    };
  }
  return { ok: true, rows };
}

/** A CSV (or tab-separated) text as cells, every one of them text. */
export function csvCells(text: string): string[][] {
  const body = text.replace(/^﻿/, "");
  return parseDelimitedText(body, detectDelimiter(body));
}

export type SourceKind =
  | { kind: "xlsx" }
  | { kind: "xls" }
  | { kind: "csv"; text: string };

/**
 * What the uploaded bytes are. An XLSX is a ZIP ("PK\x03\x04"); the old binary
 * .xls is refused (save as .xlsx or CSV); anything else is text, UTF-8 if it
 * decodes as UTF-8, otherwise Windows-1252.
 */
export function sniffSource(bytes: Uint8Array): SourceKind {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return { kind: "xlsx" };
  }
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    return { kind: "xls" };
  }
  try {
    return { kind: "csv", text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { kind: "csv", text: new TextDecoder("windows-1252").decode(bytes) };
  }
}

/**
 * `value` is the percentage the text spells, whatever its validity (null when
 * it is not a fraction or a percentage at all): two rows of one MID are the
 * same merchant only if these agree, exactly as the SQL's `pct` decides.
 */
export type SplitReading =
  | { kind: "blank"; value: null }
  | { kind: "rate"; rate: number; value: number }
  | { kind: "invalid"; value: number | null }
  | { kind: "above_50"; rate: number; value: number };

/**
 * Exact decimal text to an integer number of 1/10^scale units, or null when it
 * has more decimals than that (after trailing zeros). No floating point.
 */
function scaled(text: string, scale: number): number | null {
  const [whole, fraction = ""] = text.split(".");
  const digits = fraction.replace(/0+$/, "");
  if (digits.length > scale) return null;
  return Number(whole || "0") * 10 ** scale + Number(digits.padEnd(scale, "0") || "0");
}

/**
 * The Split column as the merchant's own rate (merchant_import_findings).
 *
 *   - blank: the owner's profile rate (A31);
 *   - a number from 0 to 1 is a fraction: 0.5 is 50, 0.25 is 25;
 *   - a number with a percent sign is a percentage: "30%" is 30;
 *   - anything else refuses, as does a rate not in hundredths of a percent;
 *   - above 50 refuses.
 */
export function parseSplit(raw: unknown): SplitReading {
  const text = normText(raw);
  if (text === null) return { kind: "blank", value: null };

  let hundredths: number | null = null;
  let value: number;
  const percent = text.match(/^(\d+(?:\.\d+)?) ?%$/);
  if (percent) {
    value = Number(percent[1]);
    hundredths = scaled(percent[1], 2);
  } else if (/^(?:[01](?:\.\d+)?|\.\d+)$/.test(text)) {
    // 1.0 is the largest fraction; 1.5 is not a fraction (and spells no rate).
    if (Number(text) > 1) return { kind: "invalid", value: null };
    value = Number((Number(text) * 100).toFixed(10));
    hundredths = scaled(text, 4);
  } else {
    return { kind: "invalid", value: null };
  }

  if (hundredths === null) return { kind: "invalid", value };
  const rate = hundredths / 100;
  return hundredths > 5000
    ? { kind: "above_50", rate, value: rate }
    : { kind: "rate", rate, value: rate };
}

export type ImportProfile = {
  id: string;
  full_name: string;
  llc_legal_name: string | null;
  role: string;
  is_active: boolean;
  split_rate_pct: number | null;
};

export type ImportProcessor = { code: string; label: string };

export type Lookups = {
  profiles: readonly ImportProfile[];
  processors: readonly ImportProcessor[];
  /** Every MID already on a merchant, as written. */
  existingMids: readonly string[];
};

/** A staged row: the raw cells, the reading, and what was found. */
export type StagedMerchantRow = RawMerchantRow & {
  mid: string | null;
  name: string | null;
  owner_id: string | null;
  rate: number | null;
  processor: string | null;
  status: "active" | "inactive" | null;
  merged_into: number | null;
  blockers: MerchantImportBlocker[];
  notes: MerchantImportNote[];
};

function midProblem(text: string | null, source: MidSource): MerchantImportBlocker | null {
  if (source === "unsafe_number") return "mid_precision";
  if (text === null) return "missing_mid";
  if (/^\d*\.\d*$/.test(text) || /^\d*\.?\d+e[+-]?\d+$/i.test(text)) return "mid_precision";
  if (!/^[A-Za-z0-9]{6,20}$/.test(text)) return "invalid_mid";
  return null;
}

/**
 * Every check, row by row and then across rows: the same rules, in the same
 * order, as merchant_import_findings().
 */
export function validateMerchantRows(
  rows: readonly RawMerchantRow[],
  lookups: Lookups,
): StagedMerchantRow[] {
  const byLlc = new Map<string, ImportProfile[]>();
  for (const profile of lookups.profiles) {
    const key = normKey(profile.llc_legal_name);
    if (key === null) continue;
    byLlc.set(key, [...(byLlc.get(key) ?? []), profile]);
  }
  const processorByKey = new Map<string, string>();
  for (const p of lookups.processors) {
    for (const name of [p.code, p.label]) {
      const key = normKey(name);
      if (key !== null && !processorByKey.has(key)) processorByKey.set(key, p.code);
    }
  }
  const existing = new Set(
    lookups.existingMids.map((m) => normText(m)?.toUpperCase()).filter(Boolean),
  );

  type Working = StagedMerchantRow & {
    key: string | null;
    agentKey: string | null;
    statusKey: string | null;
    effectiveRate: number | null;
    ownerRate: number | null;
  };

  const working: Working[] = rows.map((row) => {
    const blockers: MerchantImportBlocker[] = [];
    const notes: MerchantImportNote[] = [];

    const type = normText(row.type_raw);
    if (type === null || type.toUpperCase() !== "MERCHANT") blockers.push("invalid_type");

    const midText = normText(row.mid_raw);
    const problem = midProblem(midText, row.mid_source);
    if (problem) blockers.push(problem);
    if (row.mid_source === "number" && problem === null) notes.push("mid_from_number");

    const name = normText(row.name_raw);
    if (name === null) blockers.push("missing_name");
    else if (name.length > MAX_NAME_LENGTH) blockers.push("invalid_name");

    const agentKey = normKey(row.agent_raw);
    const matches = agentKey === null ? [] : byLlc.get(agentKey) ?? [];
    let owner: ImportProfile | null = null;
    if (agentKey === null) blockers.push("missing_agent");
    else if (matches.length === 0) blockers.push("unknown_agent");
    else if (matches.length > 1) blockers.push("ambiguous_agent");
    else if (!matches[0].is_active) blockers.push("inactive_agent");
    else if (matches[0].role !== "agent") blockers.push("agent_not_rep");
    if (matches.length === 1) owner = matches[0];

    const split = parseSplit(row.split_raw);
    let rate: number | null = null;
    if (split.kind === "invalid") blockers.push("invalid_split");
    else if (split.kind === "above_50") blockers.push("split_above_50");
    else if (split.kind === "rate") rate = split.rate;
    const ownerRate = owner?.split_rate_pct ?? null;
    if (split.kind === "blank" && owner !== null) notes.push("rate_from_profile");
    if (split.kind === "rate" && ownerRate !== null && rate !== ownerRate) {
      notes.push("rate_differs");
    }
    // The SQL's coalesce(pct, owner rate).
    const effectiveRate = split.value ?? ownerRate;

    const processorKey = normKey(row.processor_raw);
    const processor = processorKey === null ? null : processorByKey.get(processorKey) ?? null;
    if (processorKey !== null && processor === null) blockers.push("unknown_processor");

    const statusKey = normKey(row.status_raw);
    const status =
      statusKey === "active" ? "active" : statusKey === "inactive" ? "inactive" : null;
    if (status === null) blockers.push("invalid_status");

    return {
      ...row,
      mid: midText,
      name,
      owner_id: owner?.id ?? null,
      rate,
      processor,
      status,
      merged_into: null,
      blockers,
      notes,
      key: problem === null && midText !== null ? midText.toUpperCase() : null,
      agentKey,
      statusKey,
      effectiveRate,
      ownerRate,
    };
  });

  // Across rows: one merchant per MID.
  const groups = new Map<string, Working[]>();
  for (const row of working) {
    if (row.key === null) continue;
    groups.set(row.key, [...(groups.get(row.key) ?? []), row]);
  }

  for (const [key, group] of groups) {
    const first = group[0];
    const distinct = <T,>(values: T[]) => new Set(values).size;
    const rates = group.map((r) => r.effectiveRate);
    const conflict =
      distinct(group.map((r) => r.agentKey ?? "")) > 1 ||
      distinct(rates.filter((r) => r !== null)) > 1 ||
      (rates.some((r) => r === null) && rates.some((r) => r !== null)) ||
      distinct(group.map((r) => r.statusKey ?? "")) > 1;
    const processors = group.map((r) => r.processor).filter((p) => p !== null);
    const processorConflict = distinct(processors) > 1;
    const firstProcessor = processors[0] ?? null;
    const exists = existing.has(key);

    for (const row of group) {
      if (conflict) row.blockers.push("duplicate_mid_conflict");
      if (processorConflict) row.blockers.push("duplicate_mid_processor");
      if (exists) row.blockers.push("mid_exists");
      row.processor = row.processor ?? firstProcessor;
      if (row !== first) {
        row.merged_into = first.row_number;
        if (!conflict) row.notes.push("merged");
        if (normKey(row.name) !== normKey(first.name)) row.notes.push("name_differs");
      } else {
        row.processor = firstProcessor;
      }
    }
  }

  return working.map(
    ({ key: _key, agentKey: _a, statusKey: _s, effectiveRate: _e, ownerRate: _o, ...row }) => row,
  );
}
