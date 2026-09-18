// Parsing a CSV of reps into staging rows for the bulk user import.
//
// Pure functions over text: this file performs no I/O, holds no client, and
// makes no database decision. It stays dependency-free so it needs no deno.json
// import map of its own — the arrangement _shared/residuals.ts,
// _shared/documents.ts and _shared/admin-users.ts all use.
//
// One useful consequence of being dependency-free: Node can import it, so
// tests/unit/user-import-parse.test.ts exercises every rule below under vitest
// with no Deno, no Docker and no running stack. That is deliberate. The parsing
// rules are where the judgement lives and the part most likely to be wrong.
//
// NOTE ON DUPLICATION, and why there is none here. The pre-app validators exist
// twice (lib/pre-app-validation.ts and _shared/pre-app-secrets.ts) because a
// shared file could not survive `functions deploy`. That does not apply here:
// parsing happens only server-side, so there is exactly one copy of these rules
// and no browser twin to drift from. Do not create one.
//
// WHY CSV TEXT RATHER THAN A SPREADSHEET. A residual report is a binary XLSX
// that can be megabytes, so it needed a Storage bucket and SheetJS. A rep list
// is a few kilobytes of text, and a third private bucket is not free: no
// migration can create one, `db reset` silently drops them, and
// e2e/fixtures/seed.ts already fails to recreate `residual-imports`. So the
// submitted text is stored on the batch row instead and parsed here.

import {
  isAgentNumber,
  isEmail,
  isFullName,
  isRole,
  type Role,
} from "./admin-users.ts";
import {
  normalizeAgentNumber,
  normalizeEmail,
} from "./provision-user.ts";

/** The four columns, by the key each maps to on a staging row. */
export const USER_IMPORT_COLUMNS = [
  "full_name",
  "email",
  "role",
  "agent_number",
] as const;

export type UserImportColumn = (typeof USER_IMPORT_COLUMNS)[number];

/**
 * The header text each column is recognised by, as it appears in the file.
 *
 * Canonical spellings only — deliberately no alias list, for the reason
 * _shared/residuals.ts records: silently mapping a differently-named column
 * produces a plausible-looking import of the wrong values, and adding an alias
 * is a decision someone should make while looking at a real file.
 */
export const COLUMN_HEADERS: Record<UserImportColumn, string> = {
  full_name: "Full name",
  email: "Email",
  role: "Role",
  agent_number: "Agent #",
};

/**
 * The two columns a file need not carry.
 *
 * `Role` absent means every row is an agent — the least-privileged value, which
 * is the only safe direction for a default. A file that means to create an admin
 * has to say so. `Agent #` absent is ordinary: a rep can be created long before
 * anyone knows what the processor will call them.
 */
export const OPTIONAL_COLUMNS: UserImportColumn[] = ["role", "agent_number"];

export const REQUIRED_COLUMNS: UserImportColumn[] = USER_IMPORT_COLUMNS.filter(
  (column) => !OPTIONAL_COLUMNS.includes(column),
);

/**
 * The most rows one batch may carry.
 *
 * An over-size file is REFUSED, never truncated — a silent cap reads as "we
 * imported everything" when it did not. At the provisioning chunk size of 5 this
 * is roughly forty round trips, which is a tolerable progress bar for an
 * admin-watched operation and far above any realistic onboarding file.
 */
export const MAX_IMPORT_ROWS = 200;

/**
 * A positive integer, for a batch id arriving as JSON.
 *
 * Three lines duplicated from _shared/residual-imports.ts and
 * _shared/documents.ts rather than imported, for the reason both of those
 * record: a type guard is not worth making this module depend on a residuals-
 * or documents-named one. The duplication is self-evident and the rule cannot
 * drift meaningfully.
 */
export function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** Blocker codes, in the order user_import_rows.blocker allows. */
export type UserImportBlocker =
  | "missing_name"
  | "invalid_email"
  | "invalid_role"
  | "invalid_agent_number"
  | "duplicate_email_in_file"
  | "duplicate_agent_number_in_file"
  | "email_exists"
  | "agent_number_taken";

/**
 * The two blockers that do NOT stop the batch.
 *
 * A row colliding with an account that already exists is skipped and recorded;
 * the rest of the file still imports. Accounts are independent of one another,
 * unlike the rows of one period's ledger, so refusing forty onboardings because
 * three people already have logins is the wrong trade. The review screen lists
 * every skipped row, so the skip is never silent.
 *
 * Both are also only ever ADVISORY. They are decided by a lookup at parse time,
 * and profiles.email is a denormalised copy that is null for rows predating
 * 20260813171344 — so the authority remains provisionUser at commit time, which
 * returns a conflict and lands the row as skipped anyway.
 */
export const SKIPPABLE_BLOCKERS: UserImportBlocker[] = [
  "email_exists",
  "agent_number_taken",
];

/** True when this blocker must stop the batch being committed. */
export function isBlocking(blocker: UserImportBlocker | null): boolean {
  return blocker !== null && !SKIPPABLE_BLOCKERS.includes(blocker);
}

/**
 * Precedence when a row trips more than one.
 *
 * Structural problems first — a row with no name or no readable address cannot
 * become an account at all, so nothing else about it is worth reporting. Then
 * contradictions within the file, whose fix is a corrected upload. Then
 * collisions with what already exists, whose fix is outside the file entirely
 * and which do not block. Reporting them the other way round would tell an admin
 * to go and look at an existing account over a row that was never valid.
 */
const BLOCKER_PRECEDENCE: UserImportBlocker[] = [
  "missing_name",
  "invalid_email",
  "invalid_role",
  "invalid_agent_number",
  "duplicate_email_in_file",
  "duplicate_agent_number_in_file",
  "email_exists",
  "agent_number_taken",
];

/** The most important of a row's blockers, or null if it has none. */
export function pickBlocker(
  candidates: readonly (UserImportBlocker | null)[],
): UserImportBlocker | null {
  for (const blocker of BLOCKER_PRECEDENCE) {
    if (candidates.includes(blocker)) return blocker;
  }
  return null;
}

export type BlockerContext = {
  email?: string;
  role?: string;
  agentNumber?: string;
  /** For the in-file duplicates: the row that used the value first. */
  duplicateOfRow?: number;
};

/** Human-readable text for each blocker, shown on the review screen. */
export function blockerMessage(
  blocker: UserImportBlocker,
  context: BlockerContext = {},
): string {
  switch (blocker) {
    case "missing_name":
      return "This row has no name.";
    case "invalid_email":
      return `Could not read "${context.email ?? ""}" as an email address.`;
    case "invalid_role":
      return `"${context.role ?? ""}" is not a role — use agent or admin.`;
    case "invalid_agent_number":
      return "Agent # must be 32 characters or fewer.";
    case "duplicate_email_in_file":
      return `The file already used ${context.email ?? ""} on row ${
        context.duplicateOfRow ?? ""
      }.`;
    case "duplicate_agent_number_in_file":
      return `The file already used agent # ${context.agentNumber ?? ""} on row ${
        context.duplicateOfRow ?? ""
      }.`;
    case "email_exists":
      return `${context.email ?? ""} already has an account, so this row is skipped.`;
    case "agent_number_taken":
      return `Agent # ${
        context.agentNumber ?? ""
      } already belongs to another rep, so this row is skipped.`;
  }
}

// ---------------------------------------------------------------------------
// Delimited text
// ---------------------------------------------------------------------------

/**
 * Splits CSV/TSV text into rows of cells, RFC4180-style.
 *
 * Handles quoted fields, doubled quotes as an escaped quote, delimiters and
 * newlines inside quotes, and all three line endings. Written out rather than
 * taken from a library because this module is dependency-free on purpose, and
 * because the rules are small enough to test exhaustively — which
 * tests/unit/user-import-parse.test.ts does.
 *
 * A quoted field is the case worth being careful about: a rep called
 * `Smith, Jr.` is exactly the kind of row that would otherwise shift every
 * column after it by one and produce a plausible import of nonsense.
 */
export function parseDelimitedText(
  text: string,
  delimiter: string,
): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let index = 0;

  while (index < text.length) {
    const char = text[index];

    if (inQuotes) {
      if (char === '"') {
        // A doubled quote is a literal quote; a lone one ends the field.
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      // Normalise a CRLF inside a quoted field, so a multi-line cell does not
      // carry a stray carriage return into the database.
      if (char === "\r" && text[index + 1] === "\n") {
        field += "\n";
        index += 2;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      index += 1;
      continue;
    }
    if (char === delimiter) {
      row.push(field);
      field = "";
      index += 1;
      continue;
    }
    if (char === "\r" || char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      // CRLF is one line ending, not two.
      index += char === "\r" && text[index + 1] === "\n" ? 2 : 1;
      continue;
    }

    field += char;
    index += 1;
  }

  row.push(field);
  rows.push(row);

  return rows;
}

/**
 * Comma or tab, whichever the first line actually uses.
 *
 * Tab matters because pasting a block of cells straight out of Excel produces
 * TSV, and an admin who does that would otherwise get one column containing the
 * whole row and a "missing columns" error naming every column in the file.
 * Comma wins a tie, including when neither appears.
 */
export function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r\n|\r|\n/, 1)[0] ?? "";
  const commas = (firstLine.match(/,/g) ?? []).length;
  const tabs = (firstLine.match(/\t/g) ?? []).length;
  return tabs > commas ? "\t" : ",";
}

/** Collapses a header cell to a comparable form. */
function normalizeHeader(value: string): string {
  return value
    .toLowerCase()
    // Punctuation and spacing around "#" is the one genuinely ambiguous bit of
    // these names: "Agent #", "Agent#" and "AGENT  #" are the same column.
    .replace(/\s+/g, " ")
    .replace(/\s*#\s*/g, "#")
    .replace(/[:.]+$/, "")
    .trim();
}

const HEADER_LOOKUP = new Map<string, UserImportColumn>(
  USER_IMPORT_COLUMNS.map((column) => [
    normalizeHeader(COLUMN_HEADERS[column]),
    column,
  ]),
);

export type HeaderMap = {
  /** Column key -> zero-based index in the parsed rows. */
  index: Partial<Record<UserImportColumn, number>>;
  /** Canonical names of required columns the file does not have. */
  missing: string[];
};

/**
 * Maps a header row onto column keys.
 *
 * A missing REQUIRED header fails the whole parse rather than blocking rows
 * individually: a file with the wrong shape has no rows worth reviewing, and
 * forty identical blockers is a worse message than one naming the column.
 */
export function mapHeaders(headerRow: readonly string[]): HeaderMap {
  const index: Partial<Record<UserImportColumn, number>> = {};

  headerRow.forEach((cell, position) => {
    const column = HEADER_LOOKUP.get(normalizeHeader(cell));
    // First occurrence wins. A duplicated header is a malformed file, and
    // silently preferring the last copy would make which values got imported
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

/** Reads a cell as trimmed text, or null when it is empty. */
export function parseTextCell(value: string | undefined): string | null {
  if (value === undefined) return null;
  const text = value.trim();
  return text === "" ? null : text;
}

export type RoleCell = {
  role: Role;
  /** False when there was text that is not a role. */
  ok: boolean;
};

/**
 * Reads a role cell, defaulting to the least-privileged value.
 *
 * Blank or absent is `agent`, and that asymmetry is deliberate: defaulting the
 * other way would turn a missing column into a file full of admins. Unreadable
 * text is NOT defaulted — it blocks the row, because "Manger" silently becoming
 * an agent is the kind of quiet wrong answer this whole staged flow exists to
 * prevent.
 */
export function parseRoleCell(value: string | undefined): RoleCell {
  const text = parseTextCell(value);
  if (text === null) return { role: "agent", ok: true };

  const lowered = text.toLowerCase();
  if (isRole(lowered)) return { role: lowered, ok: true };

  return { role: "agent", ok: false };
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** One staging row, before the two database lookups. */
export type ParsedUserRow = {
  /** 1-based file row, so an error can name where to look. */
  row_number: number;
  full_name_raw: string | null;
  email_raw: string | null;
  role_raw: string | null;
  agent_number_raw: string | null;
  /** Resolved values, null wherever the raw text could not be resolved. */
  full_name: string | null;
  email: string | null;
  role: Role | null;
  agent_number: string | null;
  /** Everything the parser found wrong, before the lookups are considered. */
  blockers: UserImportBlocker[];
  /** Context for blockerMessage — carries the row a duplicate collides with. */
  context: BlockerContext;
};

export type UserImportParseResult =
  | { ok: false; error: string }
  | { ok: true; rows: ParsedUserRow[] };

/** True when every cell in the row is blank. */
function isBlankRow(row: readonly string[]): boolean {
  return row.every((cell) => cell.trim() === "");
}

/**
 * Turns CSV text — a header row followed by data rows — into staging rows.
 *
 * Entirely blank rows are skipped rather than blocked: a trailing newline is
 * normal, and "this row has no name" over an empty line would bury the blockers
 * that matter.
 *
 * Duplicate detection is FIRST-OCCURRENCE-WINS, and the message names the row
 * the value was first used on. Deterministic and explicable beats clever: the
 * admin opens the file, goes to the row named, and can see both.
 */
export function parseUserImport(text: string): UserImportParseResult {
  // A byte-order mark on the first header cell would stop "Full name" matching,
  // and Excel writes one on every CSV it saves as UTF-8. This has to happen
  // before anything looks at the text.
  const cleaned = text.replace(/^﻿/, "");

  if (cleaned.trim() === "") {
    return { ok: false, error: "That file is empty." };
  }

  const grid = parseDelimitedText(cleaned, detectDelimiter(cleaned));
  if (grid.length === 0) {
    return { ok: false, error: "That file has no rows." };
  }

  const headers = mapHeaders(grid[0]);
  if (headers.missing.length > 0) {
    return {
      ok: false,
      error: `That file is missing ${
        headers.missing.length === 1 ? "a column" : "columns"
      }: ${headers.missing.join(", ")}.`,
    };
  }

  const cellAt = (
    row: readonly string[],
    column: UserImportColumn,
  ): string | undefined => {
    const position = headers.index[column];
    return position === undefined ? undefined : row[position];
  };

  const dataRows = grid.slice(1).filter((row) => !isBlankRow(row));
  if (dataRows.length === 0) {
    return { ok: false, error: "That file has a header but no rows." };
  }
  if (dataRows.length > MAX_IMPORT_ROWS) {
    // Refused, not truncated. A silent cap reads as a complete import.
    return {
      ok: false,
      error:
        `That file has ${dataRows.length} rows, and one import can carry at ` +
        `most ${MAX_IMPORT_ROWS}. Split it and upload the parts separately.`,
    };
  }

  const rows: ParsedUserRow[] = [];
  /** Normalised email -> the row that used it first. */
  const seenEmails = new Map<string, number>();
  /** Normalised agent number -> the row that used it first. */
  const seenAgentNumbers = new Map<string, number>();

  for (let offset = 1; offset < grid.length; offset += 1) {
    const raw = grid[offset];
    // +1 because a file's header is row 1, which is what an admin counts.
    const rowNumber = offset + 1;

    if (isBlankRow(raw)) continue;

    const fullNameRaw = parseTextCell(cellAt(raw, "full_name"));
    const emailRaw = parseTextCell(cellAt(raw, "email"));
    const roleRaw = parseTextCell(cellAt(raw, "role"));
    const agentNumberRaw = parseTextCell(cellAt(raw, "agent_number"));

    const blockers: UserImportBlocker[] = [];
    const context: BlockerContext = {};

    // --- name ---
    const fullName = isFullName(fullNameRaw) ? fullNameRaw.trim() : null;
    if (fullName === null) blockers.push("missing_name");

    // --- email ---
    // Normalised with the same helper provisionUser uses, so the two paths
    // cannot disagree about what counts as the same address.
    let email: string | null = null;
    if (emailRaw !== null && isEmail(emailRaw)) {
      email = normalizeEmail(emailRaw);
    } else {
      blockers.push("invalid_email");
      context.email = emailRaw ?? "";
    }

    // --- role ---
    const roleCell = parseRoleCell(cellAt(raw, "role"));
    const role = roleCell.ok ? roleCell.role : null;
    if (!roleCell.ok) {
      blockers.push("invalid_role");
      context.role = roleRaw ?? "";
    }

    // --- agent number ---
    // normalizeAgentNumber is shared with provisionUser: blank becomes null,
    // because '' is a value the partial unique index enforces and two reps
    // cleared that way would collide.
    const agentNumber = normalizeAgentNumber(agentNumberRaw);
    if (agentNumber !== null && !isAgentNumber(agentNumber)) {
      blockers.push("invalid_agent_number");
    }

    // --- duplicates within the file ---
    if (email !== null) {
      const first = seenEmails.get(email);
      if (first !== undefined) {
        blockers.push("duplicate_email_in_file");
        context.email = email;
        context.duplicateOfRow = first;
      } else {
        seenEmails.set(email, rowNumber);
      }
    }

    if (agentNumber !== null && isAgentNumber(agentNumber)) {
      const first = seenAgentNumbers.get(agentNumber);
      if (first !== undefined) {
        blockers.push("duplicate_agent_number_in_file");
        context.agentNumber = agentNumber;
        // Only set when the email did not already claim it — the precedence
        // order decides which blocker is reported, and the context has to match
        // whichever one wins.
        if (!blockers.includes("duplicate_email_in_file")) {
          context.duplicateOfRow = first;
        }
      } else {
        seenAgentNumbers.set(agentNumber, rowNumber);
      }
    }

    rows.push({
      row_number: rowNumber,
      // The raw text is kept for every cell, so the review screen can show what
      // the file said next to what it was read as. It is also what makes
      // offering a re-parse safe: nothing has been interpreted destructively.
      full_name_raw: fullNameRaw,
      email_raw: emailRaw,
      role_raw: roleRaw,
      agent_number_raw: agentNumberRaw,
      full_name: fullName,
      email,
      role,
      agent_number: agentNumber !== null && isAgentNumber(agentNumber)
        ? agentNumber
        : null,
      blockers,
      context,
    });
  }

  return { ok: true, rows };
}
