import { describe, expect, it } from "vitest";

import {
  COLUMN_HEADERS,
  blockerMessage,
  mapHeaders,
  parseNumberCell,
  parsePeriodCell,
  parseResidualSheet,
  pickBlocker,
} from "../../supabase/functions/_shared/residuals";

/**
 * The residual parser.
 *
 * Imported straight out of supabase/functions/_shared/ — which works, and is
 * deliberate. That module is dependency-free precisely so it needs no deno.json
 * import map, and the same property lets Node import it. So the rules where all
 * the judgement lives are testable under vitest, with no Deno, no Docker and no
 * running stack. (tsconfig excludes `supabase` from its ROOTS; a file reached by
 * an import is still type-checked, so `npx tsc --noEmit` covers this module too.)
 *
 * What these tests are really guarding, in order of how much a mistake would cost:
 *
 *   1. **Blank is not zero.** A residual nobody has filled in must stay null. If a
 *      blank coerced to 0 the row would read as a settled $0.00 payout instead of
 *      an outstanding one, and the period would look complete when it is not.
 *   2. **A period must not shift a month.** These are commission statements; a
 *      July row filed under June is money in the wrong month.
 *   3. **A wrong number must be refused, not approximated.** Number() accepts
 *      "0x10", "1e5" and "Infinity"; none of those is a figure anyone typed.
 */

const HEADER = [
  COLUMN_HEADERS.period,
  COLUMN_HEADERS.agent_number,
  COLUMN_HEADERS.mid,
  COLUMN_HEADERS.merchant_name,
  COLUMN_HEADERS.volume,
  COLUMN_HEADERS.average_ticket,
  COLUMN_HEADERS.total_cost,
];

/** A well-formed data row, so a test can vary one cell at a time. */
function row(overrides: Partial<Record<number, unknown>> = {}): unknown[] {
  const base: unknown[] = [
    "Jul-26",
    "4471",
    "MID-1",
    "Joe's Diner",
    "12,400.00",
    "62.00",
    "$310.00",
  ];
  for (const [position, value] of Object.entries(overrides)) {
    base[Number(position)] = value;
  }
  return base;
}

describe("mapHeaders", () => {
  it("matches the canonical names case- and space-insensitively", () => {
    const { index, missing } = mapHeaders([
      "  PERIOD ",
      "agent #",
      "mid",
      "Merchant   Name",
      "VOLUME",
      "average ticket",
      "Total Cost",
    ]);

    expect(missing).toEqual([]);
    expect(index.period).toBe(0);
    expect(index.merchant_name).toBe(3);
    expect(index.total_cost).toBe(6);
  });

  it("accepts the punctuation variants of Agent #", () => {
    // The one genuinely ambiguous bit of these names. Which of these a processor
    // emits is not worth failing an import over.
    for (const spelling of ["Agent #", "Agent#", "AGENT  #", "agent #:"]) {
      const { index, missing } = mapHeaders([...HEADER.slice(0, 1), spelling, ...HEADER.slice(2)]);
      expect(missing, `should accept ${spelling}`).toEqual([]);
      expect(index.agent_number).toBe(1);
    }
  });

  it("names the required columns a file is missing", () => {
    const { missing } = mapHeaders(["Period", "Agent #", "MID"]);

    // One message naming the columns, rather than forty identical per-row
    // blockers: a file with the wrong shape has no rows worth reviewing.
    expect(missing).toEqual(["Merchant name", "Volume", "Average ticket", "Total cost"]);
  });

  it("does not require the two money columns", () => {
    // Absent from every fresh processor file; present only in this app's own
    // round-trip export.
    const { missing, index } = mapHeaders(HEADER);
    expect(missing).toEqual([]);
    expect(index.residual_income).toBeUndefined();
    expect(index.rep_split).toBeUndefined();
  });

  it("takes the first of a duplicated header, not the last", () => {
    // A duplicated header is a malformed sheet. Preferring the last copy would
    // make which numbers got imported depend on column order.
    const { index } = mapHeaders([...HEADER, "Volume"]);
    expect(index.volume).toBe(4);
  });

  it("ignores columns it does not recognise", () => {
    const { index, missing } = mapHeaders([
      "Notes",
      ...HEADER,
      "Processor",
    ]);
    expect(missing).toEqual([]);
    expect(index.period).toBe(1);
  });
});

describe("parseNumberCell", () => {
  it("reads what Excel emits", () => {
    expect(parseNumberCell("12,400.00")).toEqual({ value: 12400, ok: true });
    expect(parseNumberCell("$310.00")).toEqual({ value: 310, ok: true });
    expect(parseNumberCell("  62.5  ")).toEqual({ value: 62.5, ok: true });
    expect(parseNumberCell("60%")).toEqual({ value: 60, ok: true });
    expect(parseNumberCell("$1,234,567.89")).toEqual({
      value: 1234567.89,
      ok: true,
    });
  });

  it("passes a real number through without the text handling", () => {
    // SheetJS gives a number for a numeric cell. Running that through the string
    // cleanup would mangle exponent notation — String(1e21) is "1e+21".
    expect(parseNumberCell(310)).toEqual({ value: 310, ok: true });
    expect(parseNumberCell(-18.5)).toEqual({ value: -18.5, ok: true });
  });

  it("reads accounting parentheses as negative", () => {
    expect(parseNumberCell("(1,234.56)")).toEqual({ value: -1234.56, ok: true });
    expect(parseNumberCell("($42.00)")).toEqual({ value: -42, ok: true });
  });

  it("reads a leading minus as negative", () => {
    // Clawbacks are real, and the columns that carry them are signed on purpose.
    expect(parseNumberCell("-18.50")).toEqual({ value: -18.5, ok: true });
  });

  it("treats blank as null and NOT as zero", () => {
    // The most consequential rule in this file. "Earned nothing" and "nobody has
    // filled this in" are different facts, and every total downstream depends on
    // keeping them apart.
    for (const blank of [null, undefined, "", "   ", "-", "—", "n/a", "N/A"]) {
      expect(parseNumberCell(blank), `${String(blank)} should be null`).toEqual({
        value: null,
        ok: true,
      });
    }
  });

  it("keeps a real zero as zero", () => {
    // The other half of the same rule: a zero someone typed is a figure.
    expect(parseNumberCell("0")).toEqual({ value: 0, ok: true });
    expect(parseNumberCell("$0.00")).toEqual({ value: 0, ok: true });
    expect(parseNumberCell(0)).toEqual({ value: 0, ok: true });
  });

  it("refuses text that is not a number", () => {
    for (const bad of ["twelve", "12.3.4", "1,2x0", "--5"]) {
      expect(parseNumberCell(bad), `${bad} should not parse`).toEqual({
        value: null,
        ok: false,
      });
    }
  });

  it("refuses the values Number() would happily accept", () => {
    // Number("0x10") is 16, Number("1e5") is 100000, Number("Infinity") is
    // Infinity. None of those is a figure a processor typed, and each would import
    // a number nobody can trace to the report.
    for (const bad of ["0x10", "1e5", "Infinity", "-Infinity", "NaN"]) {
      expect(parseNumberCell(bad), `${bad} should not parse`).toMatchObject({
        ok: false,
      });
    }
  });

  it("rounds to the cent, away from zero on a negative", () => {
    // Matching Postgres's round() on numeric, so a parsed figure and the generated
    // column agree.
    expect(parseNumberCell("10.005")).toEqual({ value: 10.01, ok: true });
    expect(parseNumberCell("-10.005")).toEqual({ value: -10.01, ok: true });
  });
});

describe("parsePeriodCell", () => {
  it("normalises every accepted spelling to the first of the month", () => {
    for (const spelling of [
      "2026-07",
      "2026-07-01",
      "2026-07-31",
      "7/2026",
      "07/2026",
      "7/26",
      "7/15/2026",
      "07/15/2026",
      "Jul-26",
      "Jul 2026",
      "July 2026",
      "July, 2026",
      "JULY 2026",
    ]) {
      expect(parsePeriodCell(spelling), `${spelling} should be July 2026`).toBe(
        "2026-07-01",
      );
    }
  });

  it("reads an Excel serial date", () => {
    // 46204 is 2026-07-01 on Excel's calendar. The epoch that makes real dates
    // come out right is 1899-12-30, because Excel believes 1900 was a leap year.
    expect(parsePeriodCell(46204)).toBe("2026-07-01");
  });

  it("refuses a serial inside Excel's 1900 fiction", () => {
    // Below 61 the leap-year bug means the epoch above is off by a day, so these
    // are refused rather than silently shifted.
    expect(parsePeriodCell(1)).toBeNull();
    expect(parsePeriodCell(60)).toBeNull();
  });

  it("reads a real Date as its UTC month", () => {
    expect(parsePeriodCell(new Date(Date.UTC(2026, 6, 1)))).toBe("2026-07-01");
    expect(parsePeriodCell(new Date("nonsense"))).toBeNull();
  });

  it("does not shift December or January", () => {
    // The failure this whole function is shaped to avoid. A period is always the
    // first of a month, so a timezone slip does not cost a day — it costs a month,
    // and at the year boundary a year too.
    expect(parsePeriodCell("2026-12")).toBe("2026-12-01");
    expect(parsePeriodCell("Dec-26")).toBe("2026-12-01");
    expect(parsePeriodCell("2027-01")).toBe("2027-01-01");
    expect(parsePeriodCell("Jan-27")).toBe("2027-01-01");
    // 46388 is 2027-01-01; 46387 is 31 December, and a serial one day either side
    // of a year boundary is exactly where an off-by-one epoch would show up.
    expect(parsePeriodCell(46387)).toBe("2026-12-01");
    expect(parsePeriodCell(46388)).toBe("2027-01-01");
  });

  it("reads a two-digit year as this century", () => {
    expect(parsePeriodCell("Jul-26")).toBe("2026-07-01");
    expect(parsePeriodCell("7/26")).toBe("2026-07-01");
  });

  it("refuses a bare month with no year", () => {
    // "July" could be any year, and picking one on a commission record is not a
    // guess worth making.
    expect(parsePeriodCell("July")).toBeNull();
    expect(parsePeriodCell("Jul")).toBeNull();
  });

  it("refuses a quarter or anything spanning more than a month", () => {
    // "Q3 2026" covers three months and this schema stores one. There is no honest
    // normalisation, so it blocks its row.
    for (const bad of ["Q3 2026", "Q3-26", "2026", "H1 2026", "Jul-Sep 2026"]) {
      expect(parsePeriodCell(bad), `${bad} should not parse`).toBeNull();
    }
  });

  it("refuses an ambiguous month abbreviation", () => {
    // "Ma" prefixes both March and May. Taking the first match would silently file
    // May as March — a whole month of residuals in the wrong period.
    expect(parsePeriodCell("Ma 2026")).toBeNull();
    // Unambiguous prefixes still work.
    expect(parsePeriodCell("Mar 2026")).toBe("2026-03-01");
    expect(parsePeriodCell("May 2026")).toBe("2026-05-01");
  });

  it("refuses an out-of-range month or an implausible year", () => {
    expect(parsePeriodCell("2026-13")).toBeNull();
    expect(parsePeriodCell("2026-00")).toBeNull();
    expect(parsePeriodCell("13/2026")).toBeNull();
    expect(parsePeriodCell("1999-07")).toBeNull();
  });

  it("refuses blank and rubbish", () => {
    for (const bad of [null, undefined, "", "   ", "not a date"]) {
      expect(parsePeriodCell(bad)).toBeNull();
    }
  });
});

describe("pickBlocker", () => {
  it("prefers the blocker an admin should act on first", () => {
    // missing_mid beats everything: a row with no MID has no identity, so nothing
    // else about it can be checked.
    expect(pickBlocker(["bad_number", "missing_mid"])).toBe("missing_mid");
    expect(pickBlocker(["bad_number", "unparseable_period"])).toBe(
      "unparseable_period",
    );
  });

  it("puts unknown_agent ahead of bad_number", () => {
    // The one blocker fixable without touching the spreadsheet, so it is worth
    // surfacing ahead of a bad figure — resolving it is a different kind of action
    // from re-uploading.
    expect(pickBlocker(["bad_number", "unknown_agent"])).toBe("unknown_agent");
  });

  it("returns null when a row is clean", () => {
    expect(pickBlocker([])).toBeNull();
    expect(pickBlocker([null, null])).toBeNull();
  });
});

describe("blockerMessage", () => {
  it("names the offending value so the admin can find it", () => {
    expect(blockerMessage("unparseable_period", { period: "Q3 2026" })).toContain(
      "Q3 2026",
    );
    expect(blockerMessage("unknown_agent", { agentNumber: "7788" })).toContain(
      "7788",
    );
    expect(blockerMessage("duplicate_in_file", { mid: "MID-9" })).toContain(
      "MID-9",
    );
  });
});

describe("parseResidualSheet", () => {
  it("parses a clean sheet", () => {
    const result = parseResidualSheet([HEADER, row()]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      // Row 2, because a spreadsheet's header is row 1 — which is what an admin
      // counts when they open the file to fix something.
      row_number: 2,
      period: "2026-07-01",
      agent_number_raw: "4471",
      mid_raw: "MID-1",
      merchant_name_raw: "Joe's Diner",
      volume: 12400,
      average_ticket: 62,
      total_cost: 310,
      // Absent from the file, so null rather than zero. This is what tells the
      // commit step to leave any hand-entered figure alone.
      residual_income: null,
      rep_split_pct: null,
      blockers: [],
    });
  });

  it("keeps the raw text of every cell alongside the parsed value", () => {
    const result = parseResidualSheet([HEADER, row()]);
    if (!result.ok) throw new Error("expected a parse");

    // The review screen shows both, because "Q3 2026" is only explicable next to
    // the cell it came from. It is also what makes offering a re-parse safe.
    expect(result.rows[0].period_raw).toBe("Jul-26");
    expect(result.rows[0].volume_raw).toBe("12,400.00");
    expect(result.rows[0].total_cost_raw).toBe("$310.00");
  });

  it("fails the whole parse when a required column is missing", () => {
    const result = parseResidualSheet([
      ["Period", "Agent #", "MID"],
      ["Jul-26", "4471", "MID-1"],
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Merchant name");
    expect(result.error).toContain("Total cost");
  });

  it("blocks a row with no MID", () => {
    const result = parseResidualSheet([HEADER, row({ 2: "" })]);
    if (!result.ok) throw new Error("expected a parse");

    expect(result.rows[0].blockers).toContain("missing_mid");
  });

  it("blocks a row whose period cannot be read", () => {
    const result = parseResidualSheet([HEADER, row({ 0: "Q3 2026" })]);
    if (!result.ok) throw new Error("expected a parse");

    expect(result.rows[0].blockers).toContain("unparseable_period");
    // And the raw text survives, so the review screen can quote it.
    expect(result.rows[0].period_raw).toBe("Q3 2026");
  });

  it("blocks a row with an unreadable figure", () => {
    const result = parseResidualSheet([HEADER, row({ 4: "twelve thousand" })]);
    if (!result.ok) throw new Error("expected a parse");

    expect(result.rows[0].blockers).toContain("bad_number");
  });

  it("does NOT block a row whose optional money columns are blank", () => {
    // A fresh processor file has neither column. Blocking on that would make every
    // real import unimportable.
    const result = parseResidualSheet([
      [...HEADER, COLUMN_HEADERS.residual_income, COLUMN_HEADERS.rep_split],
      [...row(), "", ""],
    ]);
    if (!result.ok) throw new Error("expected a parse");

    expect(result.rows[0].blockers).toEqual([]);
    expect(result.rows[0].residual_income).toBeNull();
    expect(result.rows[0].rep_split_pct).toBeNull();
  });

  it("reads the money columns when a round-trip export supplies them", () => {
    const result = parseResidualSheet([
      [...HEADER, COLUMN_HEADERS.residual_income, COLUMN_HEADERS.rep_split],
      [...row(), "88.40", "60"],
    ]);
    if (!result.ok) throw new Error("expected a parse");

    expect(result.rows[0]).toMatchObject({
      residual_income: 88.4,
      rep_split_pct: 60,
      blockers: [],
    });
  });

  it("blocks the second row for the same period, agent and MID", () => {
    const result = parseResidualSheet([HEADER, row(), row()]);
    if (!result.ok) throw new Error("expected a parse");

    // The ledger's merge key would refuse this at the unique index; catching it
    // here turns a constraint violation into a message naming the row.
    expect(result.rows[0].blockers).toEqual([]);
    expect(result.rows[1].blockers).toContain("duplicate_in_file");
  });

  it("does not treat the same MID in two periods as a duplicate", () => {
    // The normal case: a merchant earns residuals every month.
    const result = parseResidualSheet([
      HEADER,
      row(),
      row({ 0: "Jun-26" }),
    ]);
    if (!result.ok) throw new Error("expected a parse");

    expect(result.rows[1].blockers).toEqual([]);
  });

  it("does not treat the same MID under two reps as a duplicate", () => {
    // A MID can change hands, and the month it moves names it twice.
    const result = parseResidualSheet([HEADER, row(), row({ 1: "9902" })]);
    if (!result.ok) throw new Error("expected a parse");

    expect(result.rows[1].blockers).toEqual([]);
  });

  it("skips entirely blank rows instead of blocking them", () => {
    // Processor exports routinely carry trailing empties and a footer gap. Forty
    // "this row has no MID" blockers over blank lines would bury the one that
    // matters.
    const result = parseResidualSheet([
      HEADER,
      row(),
      ["", "", "", "", "", "", ""],
      [null, null, null, null, null, null, null],
      row({ 2: "MID-2" }),
    ]);
    if (!result.ok) throw new Error("expected a parse");

    expect(result.rows).toHaveLength(2);
    // Row numbers still refer to the real spreadsheet lines, so the second data
    // row is line 5 rather than line 3.
    expect(result.rows.map((r) => r.row_number)).toEqual([2, 5]);
  });

  it("reports a header-only file rather than committing nothing", () => {
    const result = parseResidualSheet([HEADER]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/no data rows/i);
  });

  it("reports an empty file", () => {
    const result = parseResidualSheet([]);
    expect(result.ok).toBe(false);
  });
});
