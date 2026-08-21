import { describe, expect, it } from "vitest";

import {
  EMPTY,
  formatMoney,
  formatPeriod,
  periodParam,
} from "@/lib/format";
import {
  batchStatusIntent,
  blockerLabel,
  parsePeriodParam,
  payoutTotals,
  reviewImportRows,
  summarizeByPeriod,
  type PayoutImportRow,
} from "@/lib/payouts";

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
      period_raw: "Jul-26",
      agent_number_raw: "4471",
      mid_raw: "MID-1",
      merchant_name_raw: "Joe's Diner",
      volume_raw: "1000",
      average_ticket_raw: "10",
      total_cost_raw: "25",
      residual_income_raw: null,
      rep_split_raw: null,
      period: "2026-07-01",
      agent_id: "aaaa",
      merchant_id: null,
      blocker: null,
      error: null,
      ...over,
    };
  }

  it("reports a clean batch as ready", () => {
    const review = reviewImportRows([staged(), staged({ id: 2, mid_raw: "MID-2" })]);

    expect(review).toMatchObject({
      total: 2,
      clean: 2,
      blocked: 0,
      ready: true,
    });
    expect(review.unknownAgents).toEqual([]);
    expect(review.fileProblems).toEqual([]);
  });

  it("is NOT ready when the batch has no rows", () => {
    // Committing an empty batch would flip it to 'committed' having imported
    // nothing, which reads as a successful import of an empty month.
    expect(reviewImportRows([])).toMatchObject({ total: 0, ready: false });
  });

  it("groups unknown agent numbers, because one action fixes all their rows", () => {
    const review = reviewImportRows([
      staged({
        id: 1,
        agent_number_raw: "7788",
        agent_id: null,
        blocker: "unknown_agent",
        merchant_name_raw: "Bayside Auto",
      }),
      staged({
        id: 2,
        row_number: 3,
        agent_number_raw: "7788",
        agent_id: null,
        blocker: "unknown_agent",
        merchant_name_raw: "Bayside Tyres",
      }),
    ]);

    expect(review.unknownAgents).toHaveLength(1);
    expect(review.unknownAgents[0]).toMatchObject({
      agentNumber: "7788",
      rowCount: 2,
      sampleMerchants: ["Bayside Auto", "Bayside Tyres"],
    });
    expect(review.ready).toBe(false);
  });

  it("orders unknown agents by how many rows they hold", () => {
    const review = reviewImportRows([
      staged({ id: 1, agent_number_raw: "1", agent_id: null, blocker: "unknown_agent" }),
      staged({ id: 2, agent_number_raw: "2", agent_id: null, blocker: "unknown_agent" }),
      staged({ id: 3, agent_number_raw: "2", agent_id: null, blocker: "unknown_agent" }),
    ]);

    expect(review.unknownAgents.map((g) => g.agentNumber)).toEqual(["2", "1"]);
  });

  it("caps the merchant hint at three names", () => {
    const rows = Array.from({ length: 6 }, (_, i) =>
      staged({
        id: i + 1,
        agent_number_raw: "7788",
        agent_id: null,
        blocker: "unknown_agent",
        merchant_name_raw: `Shop ${i}`,
      }),
    );

    const review = reviewImportRows(rows);
    expect(review.unknownAgents[0].sampleMerchants).toEqual([
      "Shop 0",
      "Shop 1",
      "Shop 2",
    ]);
    expect(review.unknownAgents[0].rowCount).toBe(6);
  });

  it("groups rows with a blank agent number together", () => {
    // Keyed on the empty string rather than on null, or each blank row becomes its
    // own entry and a file missing the column entirely renders forty groups.
    const review = reviewImportRows([
      staged({ id: 1, agent_number_raw: null, agent_id: null, blocker: "unknown_agent" }),
      staged({ id: 2, agent_number_raw: null, agent_id: null, blocker: "unknown_agent" }),
    ]);

    expect(review.unknownAgents).toHaveLength(1);
    expect(review.unknownAgents[0].agentNumber).toBeNull();
  });

  it("lists other blockers per row, because each needs its own fix in the file", () => {
    const review = reviewImportRows([
      staged({
        id: 1,
        row_number: 5,
        blocker: "unparseable_period",
        error: 'Could not read "Q3 2026" as a month.',
      }),
      staged({
        id: 2,
        row_number: 9,
        blocker: "bad_number",
        error: "One of the figures on this row could not be read as a number.",
      }),
    ]);

    expect(review.fileProblems).toHaveLength(2);
    const periods = review.fileProblems.find(
      (p) => p.blocker === "unparseable_period",
    );
    expect(periods?.rows).toEqual([
      { rowNumber: 5, detail: 'Could not read "Q3 2026" as a month.' },
    ]);
  });

  it("falls back to the code when a blocker has no message", () => {
    // A blocker added in SQL but not in blockerMessage should look raw, not blank.
    const review = reviewImportRows([
      staged({ blocker: "something_new", error: null }),
    ]);

    expect(review.fileProblems[0].rows[0].detail).toBe("something_new");
  });

  it("counts a mixed batch correctly", () => {
    const review = reviewImportRows([
      staged({ id: 1 }),
      staged({ id: 2, agent_id: null, blocker: "unknown_agent" }),
      staged({ id: 3, blocker: "bad_number" }),
    ]);

    expect(review).toMatchObject({ total: 3, clean: 1, blocked: 2, ready: false });
  });
});

describe("blockerLabel", () => {
  it("turns a code into prose", () => {
    expect(blockerLabel("unknown_agent")).toBe("Agent # not recognised");
    expect(blockerLabel("duplicate_in_file")).toBe("Duplicate row in the file");
  });

  it("passes an unrecognised code through rather than rendering undefined", () => {
    // The review screen reads these straight from the database. A blocker added in
    // SQL and not here should look raw, not blank.
    expect(blockerLabel("something_new")).toBe("something_new");
  });
});
