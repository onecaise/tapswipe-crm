import type { StatusIntent } from "@/components/status-badge";

/**
 * Shared types, constants and arithmetic for the Rep Payouts / Residuals module.
 *
 * Spec: RESIDUALS_SPEC.md. The vocabularies below mirror check constraints in
 * supabase/migrations/20260817102000_rep_payouts.sql — if a constraint changes,
 * change this too. The database is the authority; these are copies for the UI's
 * benefit.
 *
 * Note what these types do NOT do: coerce money. Every numeric column arrives from
 * PostgREST as a **string**, because `numeric` is exact and a JS number is not, and
 * the types below say so. Declaring them `number` would type-check happily and
 * then produce "88.4088.40" the first time something added two of them. The
 * reducers here are the one place that converts, and they do it explicitly.
 */

/**
 * The private bucket holding uploaded import files.
 *
 * Mirrors RESIDUAL_BUCKET in supabase/functions/_shared/residual-imports.ts. Two
 * copies because the browser cannot import from `supabase/functions` (Deno import
 * maps, and tsconfig excludes the directory) — the same one-line duplication
 * lib/documents.ts carries for the `documents` bucket, and for the same reason.
 * The bucket has no storage policies, so a wrong name here fails loudly on the
 * signed-URL call rather than reaching anything it should not.
 */
export const RESIDUAL_BUCKET = "residual-imports";

export const PAYOUT_BATCH_STATUSES = [
  "review",
  "committed",
  "abandoned",
] as const;

export type PayoutBatchStatus = (typeof PAYOUT_BATCH_STATUSES)[number];

/**
 * Why a row could not be imported.
 *
 * Only `unknown_agent` is fixable from the review screen — a rep can be created or
 * given the number. The rest are problems with the file itself, and the fix is a
 * corrected upload rather than an edit here: letting someone retype a figure the
 * processor sent would quietly make this database disagree with the report it came
 * from.
 */
export const PAYOUT_BLOCKERS = [
  "unknown_agent",
  "unparseable_period",
  "bad_number",
  "missing_mid",
  "duplicate_in_file",
] as const;

export type PayoutBlocker = (typeof PAYOUT_BLOCKERS)[number];

/** The one blocker an admin can resolve without touching the spreadsheet. */
export const FIXABLE_BLOCKER: PayoutBlocker = "unknown_agent";

/** Numeric strings, as PostgREST sends `numeric`. See the note above. */
export type PayoutRow = {
  id: number;
  agent_id: string;
  period: string;
  mid: string;
  merchant_name: string | null;
  merchant_id: number | null;
  volume: string | null;
  average_ticket: string | null;
  total_cost: string | null;
  residual_income: string | null;
  rep_split_pct: string | null;
  /** Generated and stored; null whenever either input is null. Never written. */
  rep_payout: string | null;
  batch_id: number | null;
};

/**
 * Columns every payout read asks for.
 *
 * Kept in one place so a test can assert on the same set, the way
 * MERCHANT_LIST_COLUMNS is. `rep_payout` is included deliberately: it is generated
 * in the database, so reading it is always cheaper and always more correct than
 * recomputing it here from two strings.
 */
export const PAYOUT_ROW_COLUMNS =
  "id, agent_id, period, mid, merchant_name, merchant_id, volume, average_ticket, total_cost, residual_income, rep_split_pct, rep_payout, batch_id";

export type PayoutBatch = {
  id: number;
  imported_by: string;
  file_key: string;
  file_name: string;
  status: PayoutBatchStatus;
  row_count: number;
  uploaded_at: string | null;
  committed_at: string | null;
};

export const PAYOUT_BATCH_COLUMNS =
  "id, imported_by, file_key, file_name, status, row_count, uploaded_at, committed_at";

/**
 * A period as it appears in a route segment: `YYYY-MM`.
 *
 * Returns the stored `date` form (`YYYY-MM-01`) or null. Null means "not a period",
 * and every caller turns that into notFound() rather than falling back to a
 * default — a mistyped month must not silently show a different one's figures.
 *
 * The month range is checked, not just the shape: '2026-13' parses as a date in
 * Postgres terms only by rolling over into the next year, which would show January
 * 2027 under a URL saying 2026.
 */
export function parsePeriodParam(value: string | undefined): string | null {
  if (typeof value !== "string") return null;

  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (match === null) return null;

  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;

  return `${match[1]}-${match[2]}-01`;
}

export function batchStatusIntent(status: PayoutBatchStatus): StatusIntent {
  // Committed is the settled good outcome; review is waiting on someone;
  // abandoned is inert. Exactly the three things the intents mean elsewhere.
  if (status === "committed") return "success";
  if (status === "review") return "warning";
  return "neutral";
}

/** Blocker codes as prose. One place where a code becomes English. */
const BLOCKER_LABELS: Record<PayoutBlocker, string> = {
  unknown_agent: "Agent # not recognised",
  unparseable_period: "Period could not be read",
  bad_number: "A figure could not be read",
  missing_mid: "No MID",
  duplicate_in_file: "Duplicate row in the file",
};

export function blockerLabel(blocker: string): string {
  return BLOCKER_LABELS[blocker as PayoutBlocker] ?? blocker;
}

export type PayoutTotals = {
  rows: number;
  volume: number;
  residualIncome: number;
  repPayout: number;
  /** Rows where residual income or split has not been filled in yet. */
  unfilled: number;
};

/**
 * Sums a set of payout rows.
 *
 * A pure reducer so the list page, the period page and the printed summary all do
 * the same arithmetic. Three things it is careful about, each of which was a real
 * decision rather than defensiveness:
 *
 *   1. **Strings in, numbers out.** `numeric` arrives as a string; `+` on two of
 *      those concatenates. Every value goes through Number() here.
 *   2. **Null is not zero.** A row with no residual income yet contributes nothing
 *      to the total AND increments `unfilled`, so a page can say "these figures are
 *      incomplete" rather than presenting a partial total as final. That
 *      distinction is the whole reason the columns are nullable.
 *   3. **Negatives are summed as-is.** Clawbacks reduce a total, which is what a
 *      clawback is. Nothing is clamped at zero.
 *
 * Totals are summed in floating point and rounded once at the end. Exactness lives
 * in Postgres, which is why rep_payout is a generated column rather than computed
 * here; this is a display total over at most a few hundred rows, where a rounding
 * pass at the cent is enough.
 */
export function payoutTotals(
  rows: readonly Pick<
    PayoutRow,
    "volume" | "residual_income" | "rep_split_pct" | "rep_payout"
  >[],
): PayoutTotals {
  let volume = 0;
  let residualIncome = 0;
  let repPayout = 0;
  let unfilled = 0;

  for (const row of rows) {
    volume += toNumber(row.volume);
    residualIncome += toNumber(row.residual_income);
    repPayout += toNumber(row.rep_payout);

    if (row.residual_income === null || row.rep_split_pct === null) {
      unfilled += 1;
    }
  }

  return {
    rows: rows.length,
    volume: round2(volume),
    residualIncome: round2(residualIncome),
    repPayout: round2(repPayout),
    unfilled,
  };
}

/** Null, blank and unparseable all contribute nothing rather than NaN. */
function toNumber(value: string | null): number {
  if (value === null || value === "") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Rounds to the cent.
 *
 * Written as a scaled round rather than toFixed+Number because that is the shape
 * that survives a negative: Math.round(-11.105 * 100) is -1110 (round-half-up
 * toward +Infinity), which matches nothing in particular, so the sign is handled
 * explicitly instead. Postgres's round() on numeric goes half-away-from-zero, and
 * these display totals should agree with the column they are summing.
 */
function round2(value: number): number {
  const scaled = Math.round(Math.abs(value) * 100) / 100;
  return value < 0 ? -scaled : scaled;
}

export type FigureInput =
  | { ok: true; value: number | null }
  | { ok: false; message: string };

/**
 * Reads what an admin typed into one money or percentage cell.
 *
 * **Not a copy of parseNumberCell in `_shared/residuals.ts`, and not required to
 * agree with it.** That one reads whatever Excel emitted across a whole sheet —
 * serial dates, accounting parentheses, currency symbols, thousands separators.
 * This reads a single value a person just typed into one input, so it accepts far
 * less on purpose: a stray `(1,234)` in a hand-typed cell is more likely a mistake
 * than an intentional negative, and there is a human right there to correct it. A
 * leading `$` and separators are still tolerated, because pasting from the
 * spreadsheet is the obvious way to fill these in.
 *
 * Empty means null — "not worked out yet" — never zero.
 *
 * The database remains the authority on range: rep_split_pct has a 0..100 CHECK.
 * The bound is repeated here only so the admin gets a sentence instead of a raw
 * constraint-violation message on a screen where they cannot see the constraint.
 */
export function parseFigureInput(
  text: string,
  field: "residual_income" | "rep_split_pct",
): FigureInput {
  const cleaned = text.trim().replace(/[$,\s]/g, "").replace(/%$/, "");
  if (cleaned === "") return { ok: true, value: null };

  if (!/^-?\d*\.?\d+$/.test(cleaned)) {
    return { ok: false, message: "Enter a number, or leave it blank." };
  }

  const value = Number(cleaned);
  if (!Number.isFinite(value)) {
    return { ok: false, message: "Enter a number, or leave it blank." };
  }

  if (field === "rep_split_pct" && (value < 0 || value > 100)) {
    return { ok: false, message: "A split has to be between 0 and 100." };
  }

  // Rounded here as well as in the database, so the value the admin sees after a
  // save is the value they will see on reload.
  const scaled = Math.round(Math.abs(value) * 100) / 100;
  return { ok: true, value: value < 0 ? -scaled : scaled };
}

/** A staged row, as the review screen reads it. */
export type PayoutImportRow = {
  id: number;
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
  agent_id: string | null;
  merchant_id: number | null;
  blocker: string | null;
  error: string | null;
};

export const PAYOUT_IMPORT_ROW_COLUMNS =
  "id, row_number, period_raw, agent_number_raw, mid_raw, merchant_name_raw, volume_raw, average_ticket_raw, total_cost_raw, residual_income_raw, rep_split_raw, period, agent_id, merchant_id, blocker, error";

/** An unrecognised agent number, and what it would import if it resolved. */
export type UnknownAgentGroup = {
  agentNumber: string | null;
  rowCount: number;
  /** A few merchant names, as a hint for whose book this is. */
  sampleMerchants: string[];
};

/** A blocker that can only be fixed by correcting the file and re-uploading. */
export type FileProblem = {
  blocker: string;
  rows: { rowNumber: number; detail: string }[];
};

export type ImportReview = {
  total: number;
  clean: number;
  blocked: number;
  /** Fixable in place: create the rep, or give an existing one the number. */
  unknownAgents: UnknownAgentGroup[];
  /** Everything else — the fix is a corrected upload. */
  fileProblems: FileProblem[];
  /** True when nothing blocks the batch and it can be committed. */
  ready: boolean;
};

/** How many merchant names to show as a hint per unknown agent number. */
const SAMPLE_LIMIT = 3;

/**
 * Shapes staged rows into what the review screen renders.
 *
 * Pure, so the grouping is unit-testable without a database — and it is worth
 * testing, because the screen's whole job is to be unambiguous about which
 * problems an admin can fix here and which need the spreadsheet corrected.
 *
 * Unknown agent numbers are grouped and everything else is listed per row, which
 * reflects how each is actually resolved: one action fixes all twelve rows of an
 * unrecognised rep, whereas a bad figure on row 22 is its own edit in Excel.
 */
export function reviewImportRows(
  rows: readonly PayoutImportRow[],
): ImportReview {
  const unknown = new Map<string, UnknownAgentGroup>();
  const problems = new Map<string, FileProblem>();

  for (const row of rows) {
    if (row.blocker === null) continue;

    if (row.blocker === FIXABLE_BLOCKER) {
      // Keyed on the empty string when the cell was blank, so rows with no agent
      // number at all group together instead of each becoming its own entry.
      const key = row.agent_number_raw ?? "";
      const group = unknown.get(key) ?? {
        agentNumber: row.agent_number_raw,
        rowCount: 0,
        sampleMerchants: [],
      };
      group.rowCount += 1;
      if (
        group.sampleMerchants.length < SAMPLE_LIMIT &&
        row.merchant_name_raw !== null
      ) {
        group.sampleMerchants.push(row.merchant_name_raw);
      }
      unknown.set(key, group);
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
      // and not in blockerMessage should look raw, not blank.
      detail: row.error ?? row.blocker,
    });
    problems.set(row.blocker, problem);
  }

  const blocked = rows.filter((row) => row.blocker !== null).length;

  return {
    total: rows.length,
    clean: rows.length - blocked,
    blocked,
    unknownAgents: [...unknown.values()].sort(
      (a, b) => b.rowCount - a.rowCount,
    ),
    fileProblems: [...problems.values()].sort((a, b) =>
      a.blocker.localeCompare(b.blocker),
    ),
    // A batch with no rows at all is NOT ready. Committing it would flip a batch
    // to 'committed' having imported nothing, which reads as a successful import
    // of an empty month.
    ready: rows.length > 0 && blocked === 0,
  };
}

/** One period's worth of rows, as the periods list shows it. */
export type PeriodSummary = PayoutTotals & { period: string };

/**
 * Groups rows into periods, newest first.
 *
 * Done here rather than with a Postgres aggregate because the periods list and the
 * period page read the same rows under the same policy, and a second aggregated
 * query would be a second thing to keep in step with the first. Row counts here are
 * per rep for a rep and company-wide for an admin, which is RLS doing the work
 * rather than a role branch in this file.
 */
export function summarizeByPeriod(
  rows: readonly (Pick<
    PayoutRow,
    "volume" | "residual_income" | "rep_split_pct" | "rep_payout"
  > & { period: string })[],
): PeriodSummary[] {
  const byPeriod = new Map<string, (typeof rows)[number][]>();

  for (const row of rows) {
    const existing = byPeriod.get(row.period);
    if (existing) {
      existing.push(row);
    } else {
      byPeriod.set(row.period, [row]);
    }
  }

  return [...byPeriod.entries()]
    // Descending by the stored YYYY-MM-DD, which sorts lexicographically for
    // free — the reason the column is a date normalised to the first of the
    // month rather than the label the file used.
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([period, group]) => ({ period, ...payoutTotals(group) }));
}
