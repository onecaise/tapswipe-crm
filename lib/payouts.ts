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
  // A committed batch a later one replaced (20261030120000), and one whose
  // lines delete_payout_period removed (20261030190000). Only a definer
  // function sets either, and both are final.
  "replaced",
  "deleted",
] as const;

export type PayoutBatchStatus = (typeof PAYOUT_BATCH_STATUSES)[number];

/**
 * Why a row cannot be imported (rep_payout_import_rows.blocker / blockers,
 * 20261030140000), in the parser's precedence order. Any one of them refuses
 * the whole import (memo §2.4): nothing on the review screen edits a figure the
 * processor sent. `unknown_mid` is fixed in the CRM (add the merchant, then
 * Read again); every other one needs a corrected file (A27). The rule for each
 * lives once, in supabase/functions/_shared/residuals.ts; this is the UI's copy
 * of the vocabulary, which tests/unit/payouts.test.ts pins to that list and to
 * the migration's CHECK.
 */
export const PAYOUT_BLOCKERS = [
  "missing_mid",
  "duplicate_mid",
  "unknown_mid",
  "mid_in_other_batch",
  "wrong_income_type",
  "missing_figure",
  "unreadable_number",
] as const;

export type PayoutBlocker = (typeof PAYOUT_BLOCKERS)[number];

/**
 * The three confirmable warnings (rep_payout_import_rows.warnings,
 * 20261030120000), confirmed with one yes PER TYPE per import, never per line
 * (memo §0b.3). The yes is the review screen's; commit v3 (phase 8) recomputes
 * every warning and refuses a type the admin did not confirm.
 */
export const PAYOUT_WARNINGS = [
  "processor_mismatch",
  "inactive_merchant",
  "bad_numbers",
] as const;

export type PayoutWarning = (typeof PAYOUT_WARNINGS)[number];

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
   * The processor the line was paid under (the batch's, 20261030120000); on
   * an adjustment, the paid month's it corrects; null on a line committed
   * before processors were recorded, and on a share correction.
   */
  processor: string | null;
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
   * An override line's override (20261102120000), its side and its signed
   * amount: a 'debit' on the rep(s) whose merchant carries it, a 'credit' on
   * its recipient. Null on every other line. Who receives a rep's override
   * comes from my_override_recipients(), never from these.
   */
  override_id: number | null;
  override_role: OverrideRole | null;
  override_amount: number | null;
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

export type PayoutLineKind = "import" | "adjustment" | "override";

export type OverrideRole = "debit" | "credit";

/** True for a line post_share_correction() wrote rather than a file. */
export function isAdjustment(row: { line_kind?: PayoutLineKind | null }): boolean {
  return row.line_kind === "adjustment";
}

/** True for an override line commit v3 wrote (20261102120000). */
export function isOverride(row: { line_kind?: PayoutLineKind | null }): boolean {
  return row.line_kind === "override";
}

/**
 * Lines split the way every payout page shows them: merchant lines in the
 * table, override lines and adjustment lines each in their own block under
 * it. Order is kept.
 */
export function splitPayoutLines<T extends { line_kind?: PayoutLineKind | null }>(
  rows: readonly T[],
): { imports: T[]; overrides: T[]; adjustments: T[] } {
  const imports: T[] = [];
  const overrides: T[] = [];
  const adjustments: T[] = [];
  for (const row of rows) {
    (isAdjustment(row) ? adjustments : isOverride(row) ? overrides : imports).push(row);
  }
  return { imports, overrides, adjustments };
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
  "id, agent_id, period, mid, merchant_name, merchant_id, volume, average_ticket, total_cost, residual_income, rep_split_pct, rep_payout, batch_id, processor, line_kind, adjustment_amount, adjusts_period, adjustment_note, rep_share_id, share_role, override_id, override_role, override_amount";

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
  /**
   * What commit_residual_import_v2 did not apply, in sheet-row order. v3
   * (20261030160000) skips nothing and writes [], so only a batch an earlier
   * commit wrote carries one.
   */
  skipped_rows: SkippedRow[];
  /** Null while skipped rows are still owed a review. */
  skips_acknowledged_at: string | null;
  /**
   * Rows the file marked `Line = Adjustment` that parse-residual-import did
   * not stage (20261016161000): adjustments are entered in the CRM, never
   * imported.
   */
  adjustment_rows_ignored: number;
  /**
   * The processor and month chosen at upload (20261030120000). Required on
   * every batch since 20261030140000; null only on one started before.
   */
  processor: string | null;
  /** YYYY-MM-01. */
  period: string | null;
  /** The committed batch this one replaces at commit (phase 9), or null. */
  replaces_batch_id: number | null;
  /** Set when a later batch replaced this one (status 'replaced'). */
  replaced_by_batch_id: number | null;
};

export const PAYOUT_BATCH_COLUMNS =
  "id, imported_by, file_key, file_name, status, row_count, uploaded_at, committed_at, skipped_rows, skips_acknowledged_at, adjustment_rows_ignored, processor, period, replaces_batch_id, replaced_by_batch_id";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * A processor-month as close_payout_period() expects it typed, e.g.
 * "TSYS July 2026": the processor code, then Postgres's
 * to_char(period, 'FMMonth YYYY'). English and from the date's own digits,
 * never the browser's locale or time zone, or the phrase shown would not be
 * the phrase the database accepts.
 */
export function payoutMonthLabel(processor: string, period: string): string {
  const [year, month] = period.split("-");
  return `${processor} ${MONTH_NAMES[Number(month) - 1]} ${year}`;
}

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
 * The file rows the batch imported. row_count is the staged count; v2
 * recorded what it skipped, so its rows written were row_count less those. v3
 * and the old function skip nothing (skipped_rows is []), so this is
 * row_count. (v3's partner lines are extra LINES, not extra file rows.)
 */
export function rowsWritten(batch: Pick<PayoutBatch, "row_count" | "skipped_rows">): number {
  return batch.row_count - batch.skipped_rows.length;
}

/** The advisory notes (rep_payout_import_rows.preview_flag) as prose. */
const PREVIEW_FLAGS: Record<string, string> = {
  share_not_applied: "Share not applied",
  partner_named: "Partner row will be skipped",
  line_not_shared: "Will be skipped: existing line is not shared",
  share_not_in_force: "Share does not cover this month",
  // Written by the parser before 20261030140000 only (it read who the file
  // named); kept so a row staged then still renders.
  looks_shared: "Looks shared, no share set",
  payee_changed: "Pays a different rep than last month",
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
  missing_mid: "No readable Merchant Number",
  duplicate_mid: "MID repeated in the file",
  unknown_mid: "MID is not a merchant in the CRM",
  mid_in_other_batch: "MID already paid this month by another processor",
  wrong_income_type: "Income Type is not Residuals",
  missing_figure: "Volume or Residual is blank",
  unreadable_number: "A figure could not be read",
};

export function blockerLabel(blocker: string): string {
  return BLOCKER_LABELS[blocker as PayoutBlocker] ?? blocker;
}

const WARNING_LABELS: Record<PayoutWarning, string> = {
  processor_mismatch: "Processor does not match",
  inactive_merchant: "Merchant is inactive",
  bad_numbers: "Volume is negative, or the residual is more than the volume",
};

/** Warning types as the question the review screen asks, once per import. */
const WARNING_QUESTIONS: Record<PayoutWarning, string> = {
  processor_mismatch:
    "Import these lines under the processor chosen for this import?",
  inactive_merchant: "Pay these inactive merchants' lines to their owners?",
  bad_numbers: "Import these figures exactly as the file has them?",
};

export function warningLabel(warning: string): string {
  return WARNING_LABELS[warning as PayoutWarning] ?? warning;
}

export function warningQuestion(warning: string): string {
  return WARNING_QUESTIONS[warning as PayoutWarning] ?? `Accept "${warning}"?`;
}

/**
 * Whether the commit may be offered: every warning TYPE present in the import
 * has a yes (memo §0b.3). One answer per type, never per line; a no, or a type
 * not yet answered, keeps the commit closed. The yes answers go to
 * commit_residual_import_v3, which recomputes the warnings and refuses any
 * type not among them: the database enforces this, not the page.
 */
export function warningsConfirmed(
  present: readonly string[],
  answers: Readonly<Record<string, "yes" | "no" | undefined>>,
): boolean {
  return present.every((warning) => answers[warning] === "yes");
}

/**
 * The months the upload page offers: this month (UTC) and the 24 before it,
 * newest first, as `YYYY-MM-01`. A courtesy list only -- the import window is
 * guard_payout_batch_period()'s (memo A11), and residual-import-file-url passes
 * its refusal back -- pinned to that trigger by tests/unit/payouts.test.ts.
 */
export function importMonths(now: Date): string[] {
  const index = now.getUTCFullYear() * 12 + now.getUTCMonth();
  return Array.from({ length: 25 }, (_, back) => {
    const at = index - back;
    const year = Math.floor(at / 12);
    const month = at - year * 12 + 1;
    return `${year}-${String(month).padStart(2, "0")}-01`;
  });
}

export type PayoutTotals = {
  /** Merchant (import) lines. Adjustment and override lines are counted separately. */
  rows: number;
  /** Adjustment lines: in repPayout, never in rows or unfilled. */
  adjustments: number;
  /** Override lines (debits and credits): in repPayout, never in rows or unfilled. */
  overrides: number;
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
 *   5. **An override line is the same: money, not a merchant.** It carries no
 *      residual, rate or volume either (20261102120000) and pays
 *      override_amount -- negative on the rep whose merchant carries it,
 *      positive on its recipient -- so it counts in repPayout and in
 *      `overrides`, never in `rows`, the volume, the residual or `unfilled`.
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
  let overrides = 0;

  for (const row of rows) {
    repPayout += toNumber(row.rep_payout);

    if (isAdjustment(row)) {
      adjustments += 1;
      continue;
    }
    if (isOverride(row)) {
      overrides += 1;
      continue;
    }

    volume += toNumber(row.volume);
    residualIncome += toNumber(row.residual_income);

    if (row.residual_income === null || row.rep_split_pct === null) {
      unfilled += 1;
    }
  }

  return {
    rows: rows.length - adjustments - overrides,
    adjustments,
    overrides,
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

/** A staged row, as the review screen reads it. */
export type PayoutImportRow = {
  id: number;
  row_number: number;
  processor_raw: string | null;
  mid_raw: string | null;
  merchant_name_raw: string | null;
  income_type_raw: string | null;
  volume_raw: string | null;
  residual_income_raw: string | null;
  period: string | null;
  /** The merchant's owner: the payee (phase 7). */
  agent_id: string | null;
  merchant_id: number | null;
  volume: number | null;
  residual_income: number | null;
  /** The first of `blockers` by precedence; what the commit tests. */
  blocker: string | null;
  /** Every refusal the row trips (20261030140000). */
  blockers: string[];
  /** The confirmable warnings (20261030120000). */
  warnings: string[];
  error: string | null;
  /** Advisory, never a blocker: see previewFlagLabel. */
  preview_flag: string | null;
  preview_note: string | null;
};

export const PAYOUT_IMPORT_ROW_COLUMNS =
  "id, row_number, processor_raw, mid_raw, merchant_name_raw, income_type_raw, volume_raw, residual_income_raw, period, agent_id, merchant_id, volume, residual_income, blocker, blockers, warnings, error, preview_flag, preview_note";

/** One row named under a refusal or a warning. */
export type ReviewLine = {
  rowNumber: number;
  mid: string | null;
  /** What the parser wrote about the row (the refusal's own sentence). */
  detail: string;
};

/** Every row a refusal code covers. */
export type ImportRefusal = { blocker: string; rows: ReviewLine[] };

/** Every row a warning type covers: one yes/no for all of them. */
export type ImportWarningGroup = { warning: string; rows: ReviewLine[] };

export type ImportReview = {
  total: number;
  clean: number;
  blocked: number;
  /**
   * The refusals, one entry per code in precedence order, each listing every
   * row that trips it. A row that trips two codes is under both, so every
   * unknown MID, every repeat and every wrong Income Type is listed even when
   * a row has several problems.
   */
  refusals: ImportRefusal[];
  /** The MIDs no merchant has, each once, in file order (the A9 alert). */
  unknownMids: string[];
  /** One group per warning type present, in PAYOUT_WARNINGS order. */
  warnings: ImportWarningGroup[];
  /** True when nothing refuses the batch. Warnings still need their yes. */
  ready: boolean;
};

/**
 * Shapes staged rows into what the review screen renders.
 *
 * Pure, so the grouping is unit-testable without a database. A staged row from
 * before 20261030140000 has a `blocker` and no `blockers`; it is listed under
 * that one code.
 */
export function reviewImportRows(
  rows: readonly PayoutImportRow[],
): ImportReview {
  const refusals = new Map<string, ReviewLine[]>();
  const warnings = new Map<string, ReviewLine[]>();
  const unknownMids: string[] = [];

  for (const row of rows) {
    const codes =
      (row.blockers ?? []).length > 0
        ? row.blockers
        : row.blocker !== null
          ? [row.blocker]
          : [];
    for (const code of codes) {
      const list = refusals.get(code) ?? [];
      list.push({
        rowNumber: row.row_number,
        mid: row.mid_raw,
        // Falling back to the code rather than to an empty string: a blocker
        // added in SQL and not in the parser should look raw, not blank.
        detail: row.error ?? code,
      });
      refusals.set(code, list);
      if (code === "unknown_mid" && row.mid_raw !== null && !unknownMids.includes(row.mid_raw)) {
        unknownMids.push(row.mid_raw);
      }
    }
    for (const warning of row.warnings ?? []) {
      const list = warnings.get(warning) ?? [];
      list.push({ rowNumber: row.row_number, mid: row.mid_raw, detail: warning });
      warnings.set(warning, list);
    }
  }

  const blocked = rows.filter((row) => row.blocker !== null).length;
  const order = (known: readonly string[]) => (a: string, b: string) => {
    const ia = known.indexOf(a);
    const ib = known.indexOf(b);
    return (ia === -1 ? known.length : ia) - (ib === -1 ? known.length : ib) || a.localeCompare(b);
  };

  return {
    total: rows.length,
    clean: rows.length - blocked,
    blocked,
    refusals: [...refusals.keys()]
      .sort(order(PAYOUT_BLOCKERS))
      .map((blocker) => ({ blocker, rows: refusals.get(blocker)! })),
    unknownMids,
    warnings: [...warnings.keys()]
      .sort(order(PAYOUT_WARNINGS))
      .map((warning) => ({ warning, rows: warnings.get(warning)! })),
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
