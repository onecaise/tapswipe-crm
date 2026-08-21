import { describe, expect, it } from "vitest";

import {
  EMPTY,
  formatDate,
  formatMoney,
  formatPct,
  formatText,
  parseDisplayDate,
} from "@/lib/format";
import { taskIsOverdue } from "@/lib/annotations";

/**
 * The formatters, and specifically the date-only vs instant distinction.
 *
 * These assert **local calendar components** rather than a formatted string,
 * because `toLocaleDateString()` output depends on the runner's locale. Local
 * components are exact: a bare date must mean that day, wherever it is read.
 *
 * Honest limit: on a machine set to UTC the old UTC-midnight parsing produced the
 * same components, so these tests would have passed against the bug there. They
 * fail against it in every zone west of UTC, which is where this app is used.
 */
describe("parseDisplayDate", () => {
  it("reads a bare date as that local calendar day", () => {
    const date = parseDisplayDate("2026-08-07");

    expect(date).not.toBeNull();
    expect(date?.getFullYear()).toBe(2026);
    expect(date?.getMonth()).toBe(7); // zero-based: August
    expect(date?.getDate()).toBe(7); // was 6 west of UTC before the fix
  });

  it("does not shift a date at a month boundary", () => {
    // The worst-looking form of the bug: the 1st rendering as the last day of
    // the previous month, so a follow-up looked a month stale.
    const date = parseDisplayDate("2026-09-01");

    expect(date?.getMonth()).toBe(8); // September
    expect(date?.getDate()).toBe(1);
  });

  it("still treats a timestamp as an instant", () => {
    // Carries a zone, so it names a moment rather than a day and must convert to
    // the viewer's zone. Compared against the platform's own parse.
    const value = "2026-08-07T15:30:00Z";
    expect(parseDisplayDate(value)?.getTime()).toBe(new Date(value).getTime());
  });

  it("returns null for an unparseable value", () => {
    expect(parseDisplayDate("not a date")).toBeNull();
  });
});

describe("formatDate", () => {
  it("renders a bare date as the same local day", () => {
    expect(formatDate("2026-08-07")).toBe(
      new Date(2026, 7, 7).toLocaleDateString(),
    );
  });

  it("renders absent and unparseable values as the em dash", () => {
    expect(formatDate(null)).toBe(EMPTY);
    expect(formatDate(undefined)).toBe(EMPTY);
    expect(formatDate("")).toBe(EMPTY);
    expect(formatDate("not a date")).toBe(EMPTY);
  });
});

describe("formatText", () => {
  it("treats whitespace-only as absent", () => {
    expect(formatText("   ")).toBe(EMPTY);
    expect(formatText(null)).toBe(EMPTY);
    expect(formatText("Dot's Diner")).toBe("Dot's Diner");
  });
});

describe("taskIsOverdue", () => {
  const today = new Date();
  const iso = (offsetDays: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() + offsetDays);
    return d.toISOString().slice(0, 10);
  };

  it("is false for a task due today", () => {
    // The boundary that matters: due_date is a `date`, so "today" must not read
    // as overdue at one minute past midnight.
    expect(taskIsOverdue({ due_date: iso(0), completed: false })).toBe(false);
  });

  it("is true for an open task due yesterday", () => {
    expect(taskIsOverdue({ due_date: iso(-1), completed: false })).toBe(true);
  });

  it("is false once completed, however late", () => {
    expect(taskIsOverdue({ due_date: iso(-30), completed: true })).toBe(false);
  });

  it("is false with no due date", () => {
    expect(taskIsOverdue({ due_date: null, completed: false })).toBe(false);
  });
});

/**
 * formatPct and formatMoney, over the payout ledger's real value range.
 *
 * These two render every figure on the residual pages, and the money columns are
 * signed numeric(14,2) while the split is numeric(5,2) bounded 0..100 — so the
 * cases below are what the database can actually hand them, not invented extremes.
 *
 * The absent-vs-zero distinction is the one that matters most here and is asserted
 * in both directions: a null residual means "not worked out yet" and must render as
 * the em dash, while a real 0.00 must render as a figure. Collapsing those would
 * turn an unfinished period into one that looks complete and paying nothing.
 */
describe("formatPct", () => {
  it("renders a whole and a fractional split as stored", () => {
    // Not padded to 2dp: these are stored at 2dp and should read as typed.
    expect(formatPct(55)).toBe("55%");
    expect(formatPct(33.33)).toBe("33.33%");
  });

  it("renders the constraint's bounds", () => {
    expect(formatPct(0)).toBe("0%");
    expect(formatPct(100)).toBe("100%");
  });

  it("renders zero as a figure, not as absent", () => {
    // A 0% split is a real state — it produces a $0.00 payout rather than a null
    // one — so it must not collapse into the em dash.
    expect(formatPct(0)).not.toBe(EMPTY);
  });

  it("renders null and undefined as the em dash", () => {
    expect(formatPct(null)).toBe(EMPTY);
    expect(formatPct(undefined)).toBe(EMPTY);
  });

  it("renders NaN and Infinity as the em dash, not as 'NaN%'", () => {
    // The guard added alongside the payouts pass. Unreachable from the column
    // today, but this used to interpolate whatever it was handed, and "NaN%"
    // beside a dollar figure reads as a broken page rather than a missing value.
    expect(formatPct(Number.NaN)).toBe(EMPTY);
    expect(formatPct(Number.POSITIVE_INFINITY)).toBe(EMPTY);
    expect(formatPct(Number.NEGATIVE_INFINITY)).toBe(EMPTY);
  });
});

describe("formatMoney over the ledger's range", () => {
  it("renders zero as a figure and null as the em dash", () => {
    expect(formatMoney(0)).toBe("$0.00");
    expect(formatMoney(null)).toBe(EMPTY);
    expect(formatMoney(undefined)).toBe(EMPTY);
  });

  it("renders a negative as -$X, not in accounting parentheses", () => {
    expect(formatMoney(-820.4)).toBe("-$820.40");
    expect(formatMoney(-820.4)).not.toContain("(");
  });

  it("renders the column's largest value in full, with separators", () => {
    // numeric(14,2)'s ceiling. Must not fall back to scientific notation, and
    // must keep both cents digits.
    expect(formatMoney(999999999999.99)).toBe("$999,999,999,999.99");
    expect(formatMoney(-999999999999.99)).toBe("-$999,999,999,999.99");
  });

  it("pads to two decimals so a column of figures aligns", () => {
    expect(formatMoney(60)).toBe("$60.00");
    expect(formatMoney(88.4)).toBe("$88.40");
  });

  it("renders NaN and a non-numeric string as the em dash", () => {
    // Looking absent is a better failure than looking like a figure.
    expect(formatMoney(Number.NaN)).toBe(EMPTY);
    expect(formatMoney("not money")).toBe(EMPTY);
    expect(formatMoney("")).toBe(EMPTY);
  });
});
