import type { StatusIntent } from "@/components/status-badge";

/**
 * Shared types, constants and arithmetic for the Rep Payouts / Residuals module.
 *
 * Spec: RESIDUALS_SPEC.md. The vocabularies below mirror check constraints in
 * supabase/migrations/20260817102000_rep_payouts.sql — if a constraint changes,
 * change this too. The database is the authority; these are copies for the UI's
 * benefit.
 *
 * **The wire format, settled: PostgREST sends `numeric` as an unquoted JSON
 * number.** `{"volume":8000.00}`, and `typeof` is `number`. The six numeric
 * columns on PayoutRow are therefore typed `number | null`, and that is verified
 * against a running PostgREST rather than assumed — tests/live/residual-import
 * asserts the wire types directly, which is the only place the claim can be
 * checked.
 *
 * This paragraph used to assert the exact opposite ("arrives as a **string**,
 * because numeric is exact and a JS number is not") and warned that typing these
 * as `number` would produce "88.4088.40". That was backwards, and it is worth
 * knowing how much it cost, because the shape recurs: the types said `string`, the
 * pages cast with `as PayoutRow[]`, and `as` is an assertion rather than a check —
 * so tsc believed this file over the database and PayoutFigureCell shipped calling
 * `.trim()` on a number. It threw on a plain blur. Commit 0a4160d fixed the types
 * and the call sites but left this comment standing, still pointing the next
 * reader at the wrong conclusion, with line 60 below saying "see the note above".
 *
 * The lesson that generalises: with no generated database types, a comment like
 * this one *is* the schema as far as the compiler is concerned. Change it only
 * against evidence from a running stack.
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

/** One ledger row. The numeric columns are numbers — see the note above. */
export type PayoutRow = {
  id: number;
  agent_id: string;
  period: string;
  mid: string;
  merchant_name: string | null;
  merchant_id: number | null;
  volume: number | null;
  average_ticket: number | null;
  total_cost: number | null;
  residual_income: number | null;
  rep_split_pct: number | null;
  /** Generated and stored; null whenever either input is null. Never written. */
  rep_payout: number | null;
  batch_id: number | null;
  /**
   * 'import' for a line a residual file put there; 'adjustment' for one
   * post_share_correction() posted (20261016161000). An adjustment line pays
   * adjustment_amount, carries no residual, rate or volume, and sits outside
   * the merge key.
   */
  line_kind: PayoutLineKind;
  adjustment_amount: number | null;
  /** The month the adjustment corrects, YYYY-MM-01. */
  adjusts_period: string | null;
  adjustment_note: string | null;
  /**
   * The share this line is half of (20261014140000), or null on an unshared
   * line. A rep reads it on their own line; my_share_partners() keys its
   * answer by it, which is how a partner's NAME is put against the right line.
   */
  rep_share_id: number | null;
  /** 'primary' (the signer) or 'secondary' (the partner), or null. */
  share_role: ShareRole | null;
  /**
   * The share snapshot, read ONLY on admin pages (PAYOUT_SHARE_ADMIN_COLUMNS).
   * Absent on a rep's rows by construction: a rep page never selects them,
   * so the partner's share cannot be rendered there even by mistake.
   */
  account_residual_income?: number | null;
  primary_rep_pct?: number | null;
  secondary_rep_pct?: number | null;
};

export type ShareRole = "primary" | "secondary";

export type PayoutLineKind = "import" | "adjustment";

/** True for a line post_share_correction() wrote rather than a file. */
export function isAdjustment(row: { line_kind?: PayoutLineKind | null }): boolean {
  return row.line_kind === "adjustment";
}

/**
 * Lines split the way every payout page shows them: merchant lines in the
 * table, adjustment lines in their own block under it. Order is kept.
 */
export function splitPayoutLines<T extends { line_kind?: PayoutLineKind | null }>(
  rows: readonly T[],
): { imports: T[]; adjustments: T[] } {
  const imports: T[] = [];
  const adjustments: T[] = [];
  for (const row of rows) (isAdjustment(row) ? adjustments : imports).push(row);
  return { imports, adjustments };
}

/**
 * Columns every payout read asks for.
 *
 * Kept in one place so a test can assert on the same set, the way
 * MERCHANT_LIST_COLUMNS is. `rep_payout` is included deliberately: it is generated
 * in the database, so reading it is always cheaper and always more correct than
 * recomputing it here from two strings.
 */
export const PAYOUT_ROW_COLUMNS =
  "id, agent_id, period, mid, merchant_name, merchant_id, volume, average_ticket, total_cost, residual_income, rep_split_pct, rep_payout, batch_id, line_kind, adjustment_amount, adjusts_period, adjustment_note, rep_share_id, share_role";

/**
 * The shared-account snapshot, added to PAYOUT_ROW_COLUMNS on ADMIN pages
 * only. The rule (docs/design/residual-splits.md §8): a rep sees their own
 * share and the partner's name, never the partner's share or payout. The rep
 * can technically read these columns on their own line (design §8's "honest
 * caveat"), so the guarantee here is that no rep-facing page ASKS for them:
 * a rep's own share comes from my_share_partners() instead.
 */
export const PAYOUT_SHARE_ADMIN_COLUMNS =
  "account_residual_income, primary_rep_pct, secondary_rep_pct";

/**
 * True for the partner's half of a shared pair: its residual and rate are
 * set from the signer's line, never edited on it (guard_shared_line()), so
 * every surface shows it read-only.
 */
export function isPartnerLine(row: { share_role?: ShareRole | null }): boolean {
  return row.share_role === "secondary";
}

export type PayoutBatch = {
  id: number;
  imported_by: string;
  file_key: string;
  file_name: string;
  status: PayoutBatchStatus;
  row_count: number;
  uploaded_at: string | null;
  committed_at: string | null;
  /** What commit_residual_import_v2 did not apply, in sheet-row order. */
  skipped_rows: SkippedRow[];
  /** Null while skipped rows are still owed a review. */
  skips_acknowledged_at: string | null;
  /**
   * Rows the file marked `Line = Adjustment` that parse-residual-import did
   * not stage (20261016161000): adjustments are entered in the CRM, never
   * imported.
   */
  adjustment_rows_ignored: number;
};

export const PAYOUT_BATCH_COLUMNS =
  "id, imported_by, file_key, file_name, status, row_count, uploaded_at, committed_at, skipped_rows, skips_acknowledged_at, adjustment_rows_ignored";

/**
 * One row commit_residual_import_v2 did not apply, as it records it on the
 * batch (20261016120000). Identifiers from the admin's own file only -- no
 * figure, no name -- plus the period, because a batch can span months and each
 * period page lists the skips that touch it.
 */
export type SkippedRow = {
  row_number: number;
  period: string;
  mid: string;
  agent_number: string | null;
  reason: string;
};

const SKIP_REASONS: Record<string, string> = {
  partner_named: "Names the partner on a shared account",
  line_not_shared: "A line for this rep and MID is not part of the share",
};

export function skipReasonLabel(reason: string): string {
  return SKIP_REASONS[reason] ?? reason;
}

/**
 * Rows a committed batch skipped and nobody has reviewed yet. Zero for a batch
 * that skipped nothing, a reviewed one, and any batch not committed.
 */
export function skipsOwed(batch: Pick<PayoutBatch, "status" | "skipped_rows" | "skips_acknowledged_at">): number {
  if (batch.status !== "committed" || batch.skips_acknowledged_at !== null) return 0;
  return batch.skipped_rows.length;
}

/**
 * What the batch wrote. v2 returns {written, skipped} with written + skipped =
 * the staged rows, and row_count is the staged count, so the figure the commit
 * returned survives a reload. For a batch committed by the old function
 * skipped_rows is [] and this is row_count, which is what that returned.
 */
export function rowsWritten(batch: Pick<PayoutBatch, "row_count" | "skipped_rows">): number {
  return batch.row_count - batch.skipped_rows.length;
}

/** Shared-account preview flags (rep_payout_import_rows.preview_flag) as prose. */
const PREVIEW_FLAGS: Record<string, string> = {
  share_not_applied: "Share not applied",
  partner_named: "Partner row will be skipped",
  line_not_shared: "Will be skipped: existing line is not shared",
  share_not_in_force: "Share does not cover this month",
  looks_shared: "Looks shared, no share set",
};

export function previewFlagLabel(flag: string): string {
  return PREVIEW_FLAGS[flag] ?? flag;
}

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
  /** Merchant (import) lines. Adjustment lines are counted separately. */
  rows: number;
  /** Adjustment lines: in repPayout, never in rows or unfilled. */
  adjustments: number;
  volume: number;
  residualIncome: number;
  repPayout: number;
  /** Import lines where residual income or split has not been filled in yet. */
  unfilled: number;
};

/**
 * Sums a set of payout rows.
 *
 * A pure reducer so the list page, the period page and the printed summary all do
 * the same arithmetic. Three things it is careful about, each of which was a real
 * decision rather than defensiveness:
 *
 *   1. **Non-numbers in, numbers out.** The columns arrive as JSON numbers (see
 *      the module header — they are NOT strings, whatever this comment used to
 *      claim), so the coercion in toNumber() is not about the wire format. It is
 *      there because this reducer is also fed by hand-written fixtures, and
 *      because null must contribute 0 rather than NaN. One NaN anywhere makes the
 *      whole period total read NaN, which is a worse failure than one coercion.
 *   2. **Null is not zero.** A row with no residual income yet contributes nothing
 *      to the total AND increments `unfilled`, so a page can say "these figures are
 *      incomplete" rather than presenting a partial total as final. That
 *      distinction is the whole reason the columns are nullable.
 *   3. **Negatives are summed as-is.** Clawbacks reduce a total, which is what a
 *      clawback is. Nothing is clamped at zero.
 *   4. **An adjustment line is money but not a merchant.** Its residual and rate
 *      are NULL by design (rep_payout_rows_adjustment_no_figures) -- it pays
 *      adjustment_amount -- so it counts in repPayout and in `adjustments`, and
 *      never in `rows` or `unfilled`: a period holding a correction is not
 *      "awaiting figures" because of it. A row with no line_kind (a hand-written
 *      fixture) is an import line.
 *
 * Totals are summed in floating point and rounded once at the end. Exactness lives
 * in Postgres, which is why rep_payout is a generated column rather than computed
 * here; this is a display total over at most a few hundred rows, where a rounding
 * pass at the cent is enough.
 */
export function payoutTotals(
  rows: readonly (Pick<
    PayoutRow,
    "volume" | "residual_income" | "rep_split_pct" | "rep_payout"
  > &
    Partial<Pick<PayoutRow, "line_kind">>)[],
): PayoutTotals {
  let volume = 0;
  let residualIncome = 0;
  let repPayout = 0;
  let unfilled = 0;
  let adjustments = 0;

  for (const row of rows) {
    repPayout += toNumber(row.rep_payout);

    if (isAdjustment(row)) {
      adjustments += 1;
      continue;
    }

    volume += toNumber(row.volume);
    residualIncome += toNumber(row.residual_income);

    if (row.residual_income === null || row.rep_split_pct === null) {
      unfilled += 1;
    }
  }

  return {
    rows: rows.length - adjustments,
    adjustments,
    volume: round2(volume),
    residualIncome: round2(residualIncome),
    repPayout: round2(repPayout),
    unfilled,
  };
}

/**
 * Null, blank and unparseable all contribute nothing rather than NaN.
 *
 * Accepts a string as well as a number even though PayoutRow now correctly says
 * these columns are numbers. Not hedging about the wire format — that is settled
 * (see the header) — but this reducer is also fed by hand-written fixtures and
 * tests, and a total that silently became NaN because one caller passed "60.00"
 * is a worse failure than one extra coercion.
 */
function toNumber(value: number | string | null): number {
  if (value === null || value === "") return 0;
  const parsed = typeof value === "number" ? value : Number(value);
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

  // D-10. Commas used to be stripped wherever they were, so "12,99" — a decimal
  // comma — was saved as 1299. A comma now has to be real thousands grouping
  // (`1,299.00`, `12,345`). Checked only after the old path has read a number,
  // so anything without a misplaced comma behaves exactly as before. The same
  // shape as isThousandsGrouped() in `_shared/residuals.ts`; deliberately a copy
  // (see above), so change both together.
  if (text.includes(",")) {
    const body = text
      .trim()
      .replace(/[$\s]/g, "")
      .replace(/%$/, "")
      .replace(/^-/, "");
    if (!/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(body)) {
      return {
        ok: false,
        message:
          "Commas can only separate thousands, as in 1,299.00. Use a period for decimals, for example 12.99.",
      };
    }
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
  /** Advisory, never a blocker: see previewFlagLabel. */
  preview_flag: string | null;
  preview_note: string | null;
};

export const PAYOUT_IMPORT_ROW_COLUMNS =
  "id, row_number, period_raw, agent_number_raw, mid_raw, merchant_name_raw, volume_raw, average_ticket_raw, total_cost_raw, residual_income_raw, rep_split_raw, period, agent_id, merchant_id, blocker, error, preview_flag, preview_note";

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
  > &
    Partial<Pick<PayoutRow, "line_kind">> & { period: string })[],
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
