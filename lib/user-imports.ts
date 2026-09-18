import type { StatusIntent } from "@/components/status-badge";

/**
 * The browser's half of the bulk rep import.
 *
 * WHY THE BLOCKER VOCABULARY IS DUPLICATED HERE rather than imported from
 * supabase/functions/_shared/user-imports.ts. Direction matters: Next CAN import
 * that module — it is dependency-free and resolves fine — but it imports
 * normalizeEmail/normalizeAgentNumber from _shared/provision-user.ts, which in
 * turn pulls in generateTempPassword, writeAudit and findAuthUserByEmail. None
 * of that belongs in a browser bundle, least of all a password generator on the
 * one screen whose whole point is that it never handles a password.
 *
 * So this is the same arrangement lib/payouts.ts has with _shared/residuals.ts:
 * the browser keeps its own labels and its own copy of the blocking rule.
 * Unlike that pair, the copy IS pinned — tests/unit/user-import-lib.test.ts
 * imports both and asserts the vocabularies and the skippable set match, so they
 * cannot drift silently.
 */

export type UserImportBatchStatus =
  | "review"
  | "provisioning"
  | "committed"
  | "abandoned";

export type UserImportBatch = {
  id: number;
  imported_by: string;
  file_name: string;
  status: UserImportBatchStatus;
  row_count: number;
  uploaded_at: string | null;
  committed_at: string | null;
};

/**
 * Deliberately WITHOUT source_text. The list and review screens never show the
 * raw file, and selecting it would pull the whole CSV of every batch into a page
 * render. It is read server-side by stage-user-import when a re-read needs it.
 */
export const USER_IMPORT_BATCH_COLUMNS =
  "id, imported_by, file_name, status, row_count, uploaded_at, committed_at";

export type UserImportOutcome =
  | "created"
  | "resumed"
  | "skipped_duplicate"
  | "failed";

export type UserImportRow = {
  id: number;
  row_number: number;
  full_name_raw: string | null;
  email_raw: string | null;
  role_raw: string | null;
  agent_number_raw: string | null;
  full_name: string | null;
  email: string | null;
  role: "agent" | "admin" | null;
  agent_number: string | null;
  blocker: string | null;
  error: string | null;
  outcome: UserImportOutcome | null;
  outcome_detail: string | null;
  user_id: string | null;
  orphaned_auth_user: string | null;
  provisioned_at: string | null;
};

/**
 * ONE STRING LITERAL, not a concatenation. supabase-js infers the row type from
 * this value at the type level, and `"a" + "b"` widens to `string` — which makes
 * the select() come back as GenericStringError[] and the cast at the call site a
 * type error. lib/payouts.ts keeps its column lists on one line for the same
 * reason, which is not obvious until it bites.
 */
export const USER_IMPORT_ROW_COLUMNS =
  "id, row_number, full_name_raw, email_raw, role_raw, agent_number_raw, full_name, email, role, agent_number, blocker, error, outcome, outcome_detail, user_id, orphaned_auth_user, provisioned_at";

/**
 * The two blockers that do NOT stop the import — the row is skipped and the rest
 * proceeds. Mirrors SKIPPABLE_BLOCKERS in the shared module.
 */
export const SKIPPABLE_BLOCKERS = ["email_exists", "agent_number_taken"];

/** True when this blocker must stop the import being run. */
export function isBlocking(blocker: string | null): boolean {
  return blocker !== null && !SKIPPABLE_BLOCKERS.includes(blocker);
}

/** Blocker codes as prose. One place where a code becomes English. */
const BLOCKER_LABELS: Record<string, string> = {
  missing_name: "No name",
  invalid_email: "Email could not be read",
  invalid_role: "Role not recognised",
  invalid_agent_number: "Agent # too long",
  duplicate_email_in_file: "Duplicate email in the file",
  duplicate_agent_number_in_file: "Duplicate agent # in the file",
  email_exists: "Already has an account",
  agent_number_taken: "Agent # belongs to another rep",
};

export function blockerLabel(blocker: string): string {
  return BLOCKER_LABELS[blocker] ?? blocker;
}

const OUTCOME_LABELS: Record<UserImportOutcome, string> = {
  created: "Created",
  resumed: "Finished a half-created account",
  skipped_duplicate: "Skipped",
  failed: "Failed",
};

export function outcomeLabel(outcome: UserImportOutcome): string {
  return OUTCOME_LABELS[outcome] ?? outcome;
}

export function outcomeIntent(outcome: UserImportOutcome): StatusIntent {
  // Created is the settled good outcome. Resumed worked but is worth noticing.
  // Skipped is inert — nothing happened and nothing was meant to. Failed is the
  // only one that needs action, and it still gets warning rather than a
  // destructive red: nothing was destroyed, a row just did not happen.
  if (outcome === "created") return "success";
  if (outcome === "skipped_duplicate") return "neutral";
  return "warning";
}

export function batchStatusIntent(status: UserImportBatchStatus): StatusIntent {
  // Committed is settled; review and provisioning are both waiting on someone;
  // abandoned is inert. The same three meanings the intents carry everywhere.
  if (status === "committed") return "success";
  if (status === "abandoned") return "neutral";
  return "warning";
}

/** A blocker that can only be fixed by correcting the file and reading again. */
export type FileProblem = {
  blocker: string;
  rows: { rowNumber: number; detail: string }[];
};

/** A row that will be passed over because the person already has an account. */
export type SkippedRow = {
  rowNumber: number;
  who: string;
  detail: string;
};

export type UserImportReview = {
  total: number;
  /** Rows that will create an account. */
  ready: number;
  /** Rows that will be passed over. */
  willSkip: number;
  /** Rows that stop the import until the file is corrected. */
  blocked: number;
  skipped: SkippedRow[];
  fileProblems: FileProblem[];
  /** True when the import can be run. */
  canProvision: boolean;
};

/**
 * Shapes staged rows into what the review screen renders.
 *
 * Pure, so the grouping is unit-testable without a database — and worth testing,
 * because the screen's whole job is to be unambiguous about which rows will
 * become accounts, which will be passed over, and which stop the import.
 *
 * Skipped rows are listed individually rather than grouped by code, because each
 * one names a different person and "which three people are being skipped" is the
 * question an admin actually has. File problems ARE grouped by code, because the
 * fix is one corrected upload regardless of how many rows share the problem.
 */
export function reviewImportRows(
  rows: readonly UserImportRow[],
): UserImportReview {
  const problems = new Map<string, FileProblem>();
  const skipped: SkippedRow[] = [];

  for (const row of rows) {
    if (row.blocker === null) continue;

    if (!isBlocking(row.blocker)) {
      skipped.push({
        rowNumber: row.row_number,
        // The address is the identity here; the name is a courtesy.
        who: row.email ?? row.email_raw ?? row.full_name_raw ?? "this row",
        detail: row.error ?? blockerLabel(row.blocker),
      });
      continue;
    }

    const problem = problems.get(row.blocker) ?? {
      blocker: row.blocker,
      rows: [],
    };
    problem.rows.push({
      rowNumber: row.row_number,
      // The message the parser wrote, which quotes the offending cell. Falling
      // back to the code rather than to an empty string: a blocker added in SQL
      // and not in BLOCKER_LABELS should look raw, not blank.
      detail: row.error ?? row.blocker,
    });
    problems.set(row.blocker, problem);
  }

  const blocked = rows.filter((row) => isBlocking(row.blocker)).length;
  const willSkip = skipped.length;

  return {
    total: rows.length,
    ready: rows.length - blocked - willSkip,
    willSkip,
    blocked,
    skipped: skipped.sort((a, b) => a.rowNumber - b.rowNumber),
    fileProblems: [...problems.values()].sort((a, b) =>
      a.blocker.localeCompare(b.blocker),
    ),
    // A batch with no rows at all is NOT runnable, and neither is one where every
    // row would be skipped — flipping it to committed having created nothing
    // reads as a successful import. The function refuses the first; this stops
    // the button being offered for either.
    canProvision: rows.length > 0 && blocked === 0,
  };
}

export type UserImportResult = {
  created: number;
  resumed: number;
  skipped: number;
  failed: number;
  /** Rows not yet attempted — non-zero only mid-run. */
  pending: number;
  /** Rows that finished an account an earlier attempt left half-built. */
  resumedRows: UserImportRow[];
  /** Rows that failed, with the function's own message. */
  failures: UserImportRow[];
  /** Rows that left an auth user with no profile. Must never be buried. */
  orphans: UserImportRow[];
};

/**
 * Summarises what provisioning actually did.
 *
 * The three lists are the whole point. Counts alone would let a resumed account,
 * a failure and an orphaned auth user all disappear into "40 created, 2 other".
 */
export function summariseOutcomes(
  rows: readonly UserImportRow[],
): UserImportResult {
  const counts = { created: 0, resumed: 0, skipped: 0, failed: 0, pending: 0 };

  for (const row of rows) {
    if (row.outcome === "created") counts.created += 1;
    else if (row.outcome === "resumed") counts.resumed += 1;
    else if (row.outcome === "skipped_duplicate") counts.skipped += 1;
    else if (row.outcome === "failed") counts.failed += 1;
    else counts.pending += 1;
  }

  return {
    ...counts,
    resumedRows: rows.filter((row) => row.outcome === "resumed"),
    failures: rows.filter((row) => row.outcome === "failed"),
    orphans: rows.filter((row) => row.orphaned_auth_user !== null),
  };
}

/** How a row is identified on screen when it has no account yet. */
export function rowLabel(row: UserImportRow): string {
  const name = row.full_name ?? row.full_name_raw;
  const email = row.email ?? row.email_raw;
  if (name && email) return `${name} — ${email}`;
  return name ?? email ?? `Row ${row.row_number}`;
}
