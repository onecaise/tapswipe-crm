import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  EMPTY,
  formatMoney,
  formatPeriod,
  periodParam,
} from "@/lib/format";
import {
  PAYOUT_BATCH_COLUMNS,
  PAYOUT_BLOCKERS,
  PAYOUT_ROW_COLUMNS,
  PAYOUT_WARNINGS,
  PAYOUT_SHARE_ADMIN_COLUMNS,
  isPartnerLine,
  batchStatusIntent,
  blockerLabel,
  importMonths,
  isAdjustment,
  isOverride,
  parsePeriodParam,
  payoutTotals,
  previewFlagLabel,
  splitPayoutLines,
  reviewImportRows,
  summarizeByPeriod,
  warningLabel,
  warningQuestion,
  warningsConfirmed,
  type PayoutImportRow,
} from "@/lib/payouts";
import {
  RESIDUAL_BLOCKERS,
  RESIDUAL_WARNINGS,
} from "../../supabase/functions/_shared/residuals";

/**
 * The pure logic behind the payouts pages.
 *
 * Two themes run through these, and both are about money rather than formatting.
 *
 * First: **`numeric` arrives from PostgREST as a string.** `"88.40" + "42.10"` is
 * `"88.4042.10"`, and it type-checks if the row type claims `number`. Every
 * reducer here takes strings, so the assertions use them.
 *
 * Second: **null is not zero.** A residual nobody has worked out yet must not sum
 * as zero *and* must be counted as outstanding, because a page that shows a
 * confident total over half-entered figures is worse than one that says the figures
 * are incomplete.
 */

describe("formatMoney", () => {
  it("formats a numeric string, which is what PostgREST sends", () => {
    expect(formatMoney("88.40")).toBe("$88.40");
    expect(formatMoney("12400")).toBe("$12,400.00");
  });

  it("formats a number too", () => {
    expect(formatMoney(53.04)).toBe("$53.04");
  });

  it("renders a negative with a sign, not parentheses", () => {
    // A clawback is a normal month here. The accounting-parentheses convention
    // reads as a typo in a web table.
    expect(formatMoney("-18.50")).toBe("-$18.50");
  });

  it("renders absent values as the em dash, per the file's contract", () => {
    expect(formatMoney(null)).toBe(EMPTY);
    expect(formatMoney(undefined)).toBe(EMPTY);
    expect(formatMoney("")).toBe(EMPTY);
  });

  it("renders an unparseable value as absent rather than $NaN", () => {
    // For a money column, looking absent is a better failure than looking like a
    // figure.
    expect(formatMoney("not a number")).toBe(EMPTY);
  });

  it("distinguishes zero from absent", () => {
    // The distinction the nullable columns exist for: "$0.00" is a figure someone
    // entered, the em dash is a figure nobody has.
    expect(formatMoney("0")).toBe("$0.00");
    expect(formatMoney("0.00")).toBe("$0.00");
    expect(formatMoney(null)).toBe(EMPTY);
  });
});

describe("formatPeriod", () => {
  it("names the month and year", () => {
    expect(formatPeriod("2026-07-01")).toBe("July 2026");
  });

  it("does not slip into the previous month in December", () => {
    // The case this function exists for. A period is always the FIRST of a month,
    // and `new Date("2026-12-01")` parses as UTC midnight — so anywhere west of
    // UTC it is 30 November, and December 2026 renders as "November 2026".
    expect(formatPeriod("2026-12-01")).toBe("December 2026");
  });

  it("does not slip into the previous YEAR in January", () => {
    // The same bug at the worst boundary: January 2027 would read "December 2026",
    // which is a plausible-looking heading on a commission statement for entirely
    // the wrong month.
    expect(formatPeriod("2027-01-01")).toBe("January 2027");
  });

  it("renders absent and unparseable values as the em dash", () => {
    expect(formatPeriod(null)).toBe(EMPTY);
    expect(formatPeriod("nonsense")).toBe(EMPTY);
  });
});

describe("periodParam", () => {
  it("round-trips through parsePeriodParam", () => {
    // The property that matters: a link built from a stored period must resolve
    // back to the same period, or every row on the list page points at a month
    // whose page then 404s or shows different figures.
    for (const stored of [
      "2026-01-01",
      "2026-07-01",
      "2026-10-01",
      "2026-12-01",
      "2027-01-01",
    ]) {
      expect(parsePeriodParam(periodParam(stored))).toBe(stored);
    }
  });

  it("zero-pads the month", () => {
    expect(periodParam("2026-07-01")).toBe("2026-07");
  });
});

describe("parsePeriodParam", () => {
  it("accepts YYYY-MM and returns the first of that month", () => {
    expect(parsePeriodParam("2026-07")).toBe("2026-07-01");
  });

  it("rejects untrusted input rather than falling back to a default", () => {
    // Every caller turns null into notFound(). A fallback would show one month's
    // figures under another month's URL, which is the kind of wrong that gets paid
    // out before anyone notices.
    for (const value of [
      undefined,
      "",
      "2026",
      "2026-7",
      "2026-07-01",
      "26-07",
      "abcd-ef",
      "2026-07; drop table",
    ]) {
      expect(parsePeriodParam(value), `should reject ${String(value)}`).toBeNull();
    }
  });

  it("rejects a month outside 1..12", () => {
    // '2026-13' would otherwise be handed to Postgres as '2026-13-01', which is
    // not a rollover it performs — but '2026-00' and '2026-13' are both nonsense
    // that should 404 rather than error at the database.
    expect(parsePeriodParam("2026-13")).toBeNull();
    expect(parsePeriodParam("2026-00")).toBeNull();
    expect(parsePeriodParam("2026-12")).toBe("2026-12-01");
    expect(parsePeriodParam("2026-01")).toBe("2026-01-01");
  });
});

describe("payoutTotals", () => {
  it("sums the numbers PostgREST sends", () => {
    const totals = payoutTotals([
      {
        volume: 12400.00,
        residual_income: 88.40,
        rep_split_pct: 60.00,
        rep_payout: 53.04,
      },
      {
        volume: 9900.00,
        residual_income: 71.20,
        rep_split_pct: 50.00,
        rep_payout: 35.60,
      },
    ]);

    // If these concatenated instead, volume would be 12400.009900.00.
    expect(totals).toEqual({
      rows: 2,
      adjustments: 0,
      overrides: 0,
      volume: 22300,
      residualIncome: 159.6,
      repPayout: 88.64,
      unfilled: 0,
    });
  });

  it("counts a row with no figures as unfilled, and adds nothing for it", () => {
    const totals = payoutTotals([
      {
        volume: 1000.00,
        residual_income: 10.00,
        rep_split_pct: 50.00,
        rep_payout: 5.00,
      },
      {
        volume: 2000.00,
        residual_income: null,
        rep_split_pct: null,
        rep_payout: null,
      },
    ]);

    // Volume still counts — it came from the processor. The money that has not
    // been worked out contributes nothing and is reported as outstanding instead.
    expect(totals.volume).toBe(3000);
    expect(totals.residualIncome).toBe(10);
    expect(totals.repPayout).toBe(5);
    expect(totals.unfilled).toBe(1);
  });

  it("counts a half-entered row as unfilled", () => {
    // A split with no residual, or a residual with no split, is not a payout — the
    // generated column is null for it, so treating it as complete would show a
    // total that silently excluded a row the page claimed was done.
    const totals = payoutTotals([
      {
        volume: 1000.00,
        residual_income: 10.00,
        rep_split_pct: null,
        rep_payout: null,
      },
    ]);

    expect(totals.unfilled).toBe(1);
    expect(totals.repPayout).toBe(0);
  });

  it("sums negatives as negatives", () => {
    // Clawbacks reduce a total, which is what a clawback is. Nothing is clamped.
    const totals = payoutTotals([
      {
        volume: 1000.00,
        residual_income: 50.00,
        rep_split_pct: 50.00,
        rep_payout: 25.00,
      },
      {
        volume: 0.00,
        residual_income: -18.50,
        rep_split_pct: 60.00,
        rep_payout: -11.10,
      },
    ]);

    expect(totals.residualIncome).toBe(31.5);
    expect(totals.repPayout).toBe(13.9);
  });

  it("rounds a negative total away from zero, matching Postgres", () => {
    // These display totals should agree with the generated column they are summing,
    // and Postgres's round() on numeric goes half-away-from-zero. JS
    // Math.round(-0.005 * 100) rounds toward +Infinity, which would disagree.
    const totals = payoutTotals([
      {
        volume: null,
        residual_income: null,
        rep_split_pct: 50.00,
        rep_payout: -0.005,
      },
    ]);

    expect(totals.repPayout).toBe(-0.01);
  });

  it("returns zeros for an empty set", () => {
    expect(payoutTotals([])).toEqual({
      rows: 0,
      adjustments: 0,
      overrides: 0,
      volume: 0,
      residualIncome: 0,
      repPayout: 0,
      unfilled: 0,
    });
  });
});

describe("summarizeByPeriod", () => {
  const row = (period: string, payout: number | null) => ({
    period,
    volume: 1000,
    residual_income: payout === null ? null : 10,
    rep_split_pct: payout === null ? null : 50,
    rep_payout: payout,
  });

  it("groups by period, newest first", () => {
    const periods = summarizeByPeriod([
      row("2026-06-01", 5.00),
      row("2026-07-01", 6.00),
      row("2026-05-01", 4.00),
    ]);

    // Descending on the stored YYYY-MM-DD, which sorts lexicographically — the
    // reason the column is a normalised date rather than whatever label the file
    // used ("Jul-26" would sort before "Jun-26").
    expect(periods.map((p) => p.period)).toEqual([
      "2026-07-01",
      "2026-06-01",
      "2026-05-01",
    ]);
  });

  it("totals within each period independently", () => {
    const periods = summarizeByPeriod([
      row("2026-07-01", 6.00),
      row("2026-07-01", 4.00),
      row("2026-06-01", 1.00),
    ]);

    expect(periods[0]).toMatchObject({
      period: "2026-07-01",
      rows: 2,
      repPayout: 10,
    });
    expect(periods[1]).toMatchObject({ period: "2026-06-01", rows: 1 });
  });

  it("carries the unfilled count per period", () => {
    const periods = summarizeByPeriod([
      row("2026-07-01", 6.00),
      row("2026-07-01", null),
    ]);

    expect(periods[0].unfilled).toBe(1);
  });

  it("returns nothing for no rows", () => {
    expect(summarizeByPeriod([])).toEqual([]);
  });
});

describe("batchStatusIntent", () => {
  it("maps the three statuses onto the three intents", () => {
    // Committed is a settled good outcome, review is waiting on someone, abandoned
    // is inert — exactly what the intents mean on every other table, so no new
    // colour is introduced.
    expect(batchStatusIntent("committed")).toBe("success");
    expect(batchStatusIntent("review")).toBe("warning");
    expect(batchStatusIntent("abandoned")).toBe("neutral");
  });
});

describe("reviewImportRows", () => {
  /** A staged row, varied one field at a time. */
  function staged(over: Partial<PayoutImportRow> = {}): PayoutImportRow {
    return {
      id: 1,
      row_number: 2,
      processor_raw: "TSYS",
      mid_raw: "012345678901",
      merchant_name_raw: "Joe's Diner",
      income_type_raw: "Residuals",
      volume_raw: "1000",
      residual_income_raw: "25",
      period: "2026-07-01",
      agent_id: "aaaa",
      merchant_id: 1,
      volume: 1000,
      residual_income: 25,
      blocker: null,
      blockers: [],
      warnings: [],
      error: null,
      preview_flag: null,
      preview_note: null,
      ...over,
    };
  }

  const refused = (code: string, over: Partial<PayoutImportRow> = {}) =>
    staged({ blocker: code, blockers: [code], error: `msg ${code}`, ...over });

  it("an advisory note never blocks: the row is still clean and the batch ready", () => {
    const review = reviewImportRows([
      staged({ preview_flag: "share_not_in_force", preview_note: "x" }),
      staged({ id: 2, mid_raw: "2", preview_flag: "payee_changed", preview_note: "x" }),
    ]);
    expect(review).toMatchObject({ total: 2, clean: 2, blocked: 0, ready: true });
  });

  it("reports a clean batch as ready, with nothing to list", () => {
    const review = reviewImportRows([staged(), staged({ id: 2, mid_raw: "2" })]);
    expect(review).toEqual({
      total: 2,
      clean: 2,
      blocked: 0,
      refusals: [],
      unknownMids: [],
      warnings: [],
      ready: true,
    });
  });

  it("is NOT ready when the batch has no rows", () => {
    // Committing an empty batch would flip it to 'committed' having imported
    // nothing, which reads as a successful import of an empty month.
    expect(reviewImportRows([])).toMatchObject({ total: 0, ready: false });
  });

  it("refuses the whole batch on any one refusal", () => {
    for (const code of PAYOUT_BLOCKERS) {
      const review = reviewImportRows([staged(), refused(code, { id: 2, row_number: 3 })]);
      expect(review, code).toMatchObject({ total: 2, clean: 1, blocked: 1, ready: false });
      expect(review.refusals.map((r) => r.blocker), code).toEqual([code]);
    }
  });

  it("lists every unknown MID once, in file order", () => {
    const review = reviewImportRows([
      refused("unknown_mid", { id: 1, row_number: 2, mid_raw: "4402" }),
      refused("unknown_mid", { id: 2, row_number: 3, mid_raw: "4400" }),
      staged({ id: 3, row_number: 4 }),
      refused("unknown_mid", { id: 4, row_number: 5, mid_raw: "4401" }),
    ]);
    expect(review.unknownMids).toEqual(["4402", "4400", "4401"]);
    expect(review.refusals[0].rows.map((r) => r.rowNumber)).toEqual([2, 3, 5]);
  });

  it("lists a row under EVERY refusal it trips, so none is hidden behind another", () => {
    const review = reviewImportRows([
      staged({
        blocker: "duplicate_mid",
        blockers: ["duplicate_mid", "unknown_mid", "wrong_income_type"],
        error: "repeated. unknown. fees.",
        mid_raw: "4400",
      }),
    ]);
    expect(review.refusals.map((r) => r.blocker)).toEqual([
      "duplicate_mid",
      "unknown_mid",
      "wrong_income_type",
    ]);
    expect(review.unknownMids).toEqual(["4400"]);
    expect(review.blocked).toBe(1);
  });

  it("orders refusals by the parser precedence", () => {
    const review = reviewImportRows([
      refused("unreadable_number", { id: 1 }),
      refused("wrong_income_type", { id: 2 }),
      refused("missing_mid", { id: 3 }),
    ]);
    expect(review.refusals.map((r) => r.blocker)).toEqual([
      "missing_mid",
      "wrong_income_type",
      "unreadable_number",
    ]);
  });

  it("carries the parser's sentence, and falls back to the code when there is none", () => {
    const review = reviewImportRows([
      refused("wrong_income_type", { row_number: 5, error: 'Income Type is "Fees", not Residuals.' }),
      staged({ id: 2, blocker: "something_new", blockers: ["something_new"], error: null }),
    ]);
    expect(review.refusals[0].rows).toEqual([
      { rowNumber: 5, mid: "012345678901", detail: 'Income Type is "Fees", not Residuals.' },
    ]);
    expect(review.refusals[1].rows[0].detail).toBe("something_new");
  });

  it("lists a row staged before 20261030140000 (a blocker, no blockers) under its blocker", () => {
    const review = reviewImportRows([staged({ blocker: "missing_mid", blockers: [], error: null })]);
    expect(review.refusals.map((r) => r.blocker)).toEqual(["missing_mid"]);
  });

  it("groups warnings by TYPE, one group per type present, listing every row", () => {
    const review = reviewImportRows([
      staged({ id: 1, row_number: 2, warnings: ["bad_numbers"] }),
      staged({ id: 2, row_number: 3, warnings: ["processor_mismatch", "bad_numbers"] }),
      staged({ id: 3, row_number: 4 }),
      staged({ id: 4, row_number: 5, warnings: ["bad_numbers"] }),
    ]);
    expect(review.warnings.map((w) => [w.warning, w.rows.map((r) => r.rowNumber)])).toEqual([
      ["processor_mismatch", [3]],
      ["bad_numbers", [2, 3, 5]],
    ]);
    // A warning is not a refusal.
    expect(review).toMatchObject({ blocked: 0, ready: true });
  });

  it("counts a mixed batch correctly", () => {
    const review = reviewImportRows([
      staged({ id: 1 }),
      refused("unknown_mid", { id: 2 }),
      refused("unreadable_number", { id: 3 }),
    ]);
    expect(review).toMatchObject({ total: 3, clean: 1, blocked: 2, ready: false });
  });
});

describe("the import vocabularies match the parser and the database", () => {
  it("PAYOUT_BLOCKERS is the parser's list, in its order", () => {
    expect([...PAYOUT_BLOCKERS]).toEqual([...RESIDUAL_BLOCKERS]);
  });

  it("PAYOUT_WARNINGS is the parser's list, in its order", () => {
    expect([...PAYOUT_WARNINGS]).toEqual([...RESIDUAL_WARNINGS]);
  });

  it("both match the CHECKs in the migrations", async () => {
    const parser = await readFile(
      new URL("../../supabase/migrations/20261030140000_import_parser.sql", import.meta.url),
      "utf8",
    );
    const blockerCheck = /rep_payout_import_rows_blocker_check check \(blocker in \(([^)]*)\)/.exec(parser);
    expect(blockerCheck).not.toBeNull();
    const codes = [...blockerCheck![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(new Set(codes)).toEqual(new Set(PAYOUT_BLOCKERS));
    expect(codes).toHaveLength(PAYOUT_BLOCKERS.length);

    const blockersCheck = /check \(blockers <@ array\[([^\]]*)\]/.exec(parser);
    expect(blockersCheck).not.toBeNull();
    expect(new Set([...blockersCheck![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]))).toEqual(
      new Set(PAYOUT_BLOCKERS),
    );

    const schema = await readFile(
      new URL("../../supabase/migrations/20261030120000_import_schema.sql", import.meta.url),
      "utf8",
    );
    const warningCheck = /check \(warnings <@ array\[([^\]]*)\]/.exec(schema);
    expect(warningCheck).not.toBeNull();
    expect([...warningCheck![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual([...PAYOUT_WARNINGS]);
  });
});

describe("blockerLabel and warning prose", () => {
  it("has prose for every blocker and every warning", () => {
    for (const code of PAYOUT_BLOCKERS) expect(blockerLabel(code), code).not.toBe(code);
    for (const warning of PAYOUT_WARNINGS) {
      expect(warningLabel(warning), warning).not.toBe(warning);
      expect(warningQuestion(warning), warning).toMatch(/\?$/);
    }
    expect(blockerLabel("unknown_mid")).toBe("MID is not a merchant in the CRM");
  });

  it("passes an unrecognised code through rather than rendering undefined", () => {
    // The review screen reads these straight from the database. A code added in
    // SQL and not here should look raw, not blank.
    expect(blockerLabel("something_new")).toBe("something_new");
    expect(warningLabel("something_new")).toBe("something_new");
  });
});

describe("warningsConfirmed: one yes per warning TYPE per import (memo §0b.3)", () => {
  it("is true with no warnings at all", () => {
    expect(warningsConfirmed([], {})).toBe(true);
  });

  it("needs a yes for every type present, and one yes covers the type", () => {
    const present = ["processor_mismatch", "bad_numbers"];
    expect(warningsConfirmed(present, {})).toBe(false);
    expect(warningsConfirmed(present, { bad_numbers: "yes" })).toBe(false);
    expect(warningsConfirmed(present, { bad_numbers: "yes", processor_mismatch: "yes" })).toBe(true);
  });

  it("a no on any type keeps the commit closed", () => {
    expect(warningsConfirmed(["bad_numbers"], { bad_numbers: "no" })).toBe(false);
  });

  it("an answer for a type that is not present opens nothing", () => {
    expect(warningsConfirmed(["inactive_merchant"], { bad_numbers: "yes" })).toBe(false);
  });
});

describe("importMonths: the upload page's months (memo A11)", () => {
  it("offers this month and the 24 before it, newest first", () => {
    const months = importMonths(new Date("2026-10-30T12:00:00Z"));
    expect(months).toHaveLength(25);
    expect(months[0]).toBe("2026-10-01");
    expect(months[24]).toBe("2024-10-01");
    expect(months).not.toContain("2026-11-01");
    expect(months).not.toContain("2024-09-01");
  });

  it("takes the month in UTC, as the database does", () => {
    // 00:30 UTC on 1 November is still 31 October west of UTC.
    expect(importMonths(new Date("2026-11-01T00:30:00Z"))[0]).toBe("2026-11-01");
    expect(importMonths(new Date("2026-01-15T00:00:00Z"))[1]).toBe("2025-12-01");
  });

  it("is the database's window: nothing future, 24 back the last accepted", async () => {
    const schema = await readFile(
      new URL("../../supabase/migrations/20261030120000_import_schema.sql", import.meta.url),
      "utf8",
    );
    expect(schema).toContain("this_month date := date_trunc('month', now() at time zone 'UTC')::date;");
    expect(schema).toContain("if new.period > this_month then");
    expect(schema).toContain("if new.period < (this_month - interval '24 months')::date then");
  });
});

describe("adjustment lines (phase 5)", () => {
  const importLine = (over: Partial<{ volume: number | null; residual_income: number | null; rep_split_pct: number | null; rep_payout: number | null }> = {}) => ({
    line_kind: "import" as const,
    volume: 1000,
    residual_income: 100,
    rep_split_pct: 50,
    rep_payout: 50,
    ...over,
  });
  // As post_share_correction writes one: no volume, residual or rate, by
  // rep_payout_rows_adjustment_no_figures; the payout is the amount.
  const adjustmentLine = (amount: number) => ({
    line_kind: "adjustment" as const,
    volume: null,
    residual_income: null,
    rep_split_pct: null,
    rep_payout: amount,
  });

  it("counts an adjustment in the payout, and never as a merchant or as awaiting figures", () => {
    expect(
      payoutTotals([importLine(), importLine({ residual_income: null, rep_payout: null }), adjustmentLine(10.61), adjustmentLine(-0.01)]),
    ).toEqual({
      rows: 2,
      adjustments: 2,
      overrides: 0,
      volume: 2000,
      residualIncome: 100,
      repPayout: 60.6,
      unfilled: 1,
    });
  });

  it("a period of adjustments only is complete, not awaiting figures", () => {
    expect(payoutTotals([adjustmentLine(10.61), adjustmentLine(-10.61)])).toEqual({
      rows: 0,
      adjustments: 2,
      overrides: 0,
      volume: 0,
      residualIncome: 0,
      repPayout: 0,
      unfilled: 0,
    });
  });

  it("treats a row with no line_kind as an import line", () => {
    const { line_kind: _drop, ...bare } = importLine({ residual_income: null });
    void _drop;
    expect(isAdjustment({ line_kind: undefined })).toBe(false);
    expect(isAdjustment({ line_kind: null })).toBe(false);
    expect(payoutTotals([bare]).unfilled).toBe(1);
  });

  it("splits lines into imports and adjustments, keeping order", () => {
    const rows = [
      { id: 1, line_kind: "import" as const },
      { id: 2, line_kind: "adjustment" as const },
      { id: 3, line_kind: "import" as const },
      { id: 4, line_kind: "adjustment" as const },
    ];
    const { imports, adjustments } = splitPayoutLines(rows);
    expect(imports.map((r) => r.id)).toEqual([1, 3]);
    expect(adjustments.map((r) => r.id)).toEqual([2, 4]);
  });

  it("summarizeByPeriod carries the adjustment count per period", () => {
    const periods = summarizeByPeriod([
      { period: "2026-08-01", ...adjustmentLine(5) },
      { period: "2026-07-01", ...importLine() },
    ]);
    expect(periods.map((p) => [p.period, p.rows, p.adjustments, p.repPayout])).toEqual([
      ["2026-08-01", 0, 1, 5],
      ["2026-07-01", 1, 0, 50],
    ]);
  });

  it("reads the line kind and the adjustment columns on every payout read", () => {
    const columns = PAYOUT_ROW_COLUMNS.split(", ");
    for (const column of ["line_kind", "adjustment_amount", "adjusts_period", "adjustment_note", "rep_payout"]) {
      expect(columns).toContain(column);
    }
    // Not on a batch read: only the retired Line = Adjustment parser wrote a
    // non-zero count, and the skip record went in 20261104140000.
    for (const column of ["adjustment_rows_ignored", "skipped_rows", "skips_acknowledged_at"]) {
      expect(PAYOUT_BATCH_COLUMNS.split(", ")).not.toContain(column);
    }
  });

  it("reads a line's own share key on every payout read, and the partner's figures on none a rep sees", () => {
    // Phase 7. The statement and a rep's period page select PAYOUT_ROW_COLUMNS
    // alone; the snapshot (both parties' shares, the account residual) is added
    // only on an admin's read. A rep's own share comes from my_share_partners().
    const columns = PAYOUT_ROW_COLUMNS.split(", ");
    expect(columns).toContain("rep_share_id");
    expect(columns).toContain("share_role");
    for (const column of PAYOUT_SHARE_ADMIN_COLUMNS.split(", ")) {
      expect(columns, column).not.toContain(column);
    }
    expect(PAYOUT_SHARE_ADMIN_COLUMNS.split(", ").sort()).toEqual([
      "account_residual_income",
      "primary_rep_pct",
      "secondary_rep_pct",
    ]);
    expect(isPartnerLine({ share_role: "secondary" })).toBe(true);
    expect(isPartnerLine({ share_role: "primary" })).toBe(false);
    expect(isPartnerLine({ share_role: null })).toBe(false);
  });

  it("labels the two notes the parser writes, and only those", async () => {
    expect(previewFlagLabel("share_not_in_force")).toBe("Share does not cover this month");
    expect(previewFlagLabel("payee_changed")).toBe("Pays a different rep than last month");
    // The CHECK (20261104140000) allows exactly these two; a retired flag has
    // no label left and passes through as its code.
    const migration = await readFile(
      new URL("../../supabase/migrations/20261104140000_retire_legacy_import.sql", import.meta.url),
      "utf8",
    );
    const check = /rep_payout_import_rows_preview_flag_check check \(\s*preview_flag in \(([^)]*)\)/.exec(migration);
    expect(check).not.toBeNull();
    const codes = [...check![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(codes).toEqual(["share_not_in_force", "payee_changed"]);
    for (const code of codes) expect(previewFlagLabel(code)).not.toBe(code);
    for (const retired of ["share_not_applied", "partner_named", "line_not_shared", "looks_shared"]) {
      expect(previewFlagLabel(retired)).toBe(retired);
    }
  });
});

describe("override lines (20261102120000)", () => {
  // As commit v3 writes them: no volume, residual or rate; the payout is the
  // signed override amount (negative on the rep, positive on the recipient).
  const overrideLine = (amount: number) => ({
    line_kind: "override" as const,
    volume: null,
    residual_income: null,
    rep_split_pct: null,
    rep_payout: amount,
  });
  const importLine = { line_kind: "import" as const, volume: 1000, residual_income: 100, rep_split_pct: 50, rep_payout: 50 };

  it("counts an override line in the payout, never as a merchant, volume, residual or awaiting figures", () => {
    expect(payoutTotals([importLine, overrideLine(-10), { ...importLine, residual_income: null, rep_payout: null }])).toEqual({
      rows: 2,
      adjustments: 0,
      overrides: 1,
      volume: 2000,
      residualIncome: 100,
      repPayout: 40,
      unfilled: 1,
    });
  });

  it("a recipient holding only credits has a complete period: no merchants, nothing awaiting", () => {
    expect(payoutTotals([overrideLine(10), overrideLine(-1.18)])).toEqual({
      rows: 0,
      adjustments: 0,
      overrides: 2,
      volume: 0,
      residualIncome: 0,
      repPayout: 8.82,
      unfilled: 0,
    });
  });

  it("splits lines three ways, keeping order", () => {
    const rows = [
      { id: 1, line_kind: "import" as const },
      { id: 2, line_kind: "override" as const },
      { id: 3, line_kind: "adjustment" as const },
      { id: 4, line_kind: "override" as const },
      { id: 5, line_kind: "import" as const },
    ];
    const { imports, overrides, adjustments } = splitPayoutLines(rows);
    expect(imports.map((r) => r.id)).toEqual([1, 5]);
    expect(overrides.map((r) => r.id)).toEqual([2, 4]);
    expect(adjustments.map((r) => r.id)).toEqual([3]);
    expect(isOverride({ line_kind: "override" })).toBe(true);
    expect(isOverride({ line_kind: "import" })).toBe(false);
    expect(isOverride({ line_kind: null })).toBe(false);
  });

  it("reads the override columns on every payout read", () => {
    const columns = PAYOUT_ROW_COLUMNS.split(", ");
    for (const column of ["override_id", "override_role", "override_amount"]) {
      expect(columns).toContain(column);
    }
  });
});
