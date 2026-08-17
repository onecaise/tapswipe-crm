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
