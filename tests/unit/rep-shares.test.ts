import { describe, expect, it } from "vitest";

import {
  monthInputToPeriod,
  nextPeriod,
  parseRepPct,
  periodToMonthInput,
  previousPeriod,
  shareMonths,
  shareSplitProblem,
  shareSummary,
} from "@/lib/rep-shares";

/**
 * The merchant page's share input rules (lib/rep-shares.ts). These are a
 * courtesy -- set_merchant_rep_share() and post_share_correction() refuse the
 * same things -- but a courtesy that disagrees with the database is worse than
 * none: the form would grey out a pair the RPC accepts, or offer one it
 * refuses. So the cases here are the RPC's own rule: each side above 0, at
 * most two decimals, totalling exactly 50.
 */

describe("parseRepPct", () => {
  it("reads whole and two-decimal figures as hundredths", () => {
    expect(parseRepPct("40")).toBe(4000);
    expect(parseRepPct(" 33.33 ")).toBe(3333);
    expect(parseRepPct("16.5")).toBe(1650);
    expect(parseRepPct("0.01")).toBe(1);
    expect(parseRepPct("50")).toBe(5000);
  });

  it("refuses zero, negatives, three decimals, over 50 and text", () => {
    for (const bad of ["0", "0.00", "-10", "10.001", "50.01", "60", "ten", "", "1e1", "40%"]) {
      expect(parseRepPct(bad), bad).toBeNull();
    }
  });
});

describe("shareSplitProblem", () => {
  it("accepts any pair totalling exactly 50", () => {
    for (const [a, b] of [
      ["40", "10"],
      ["25", "25"],
      ["30", "20"],
      ["33.33", "16.67"],
      ["0.01", "49.99"],
    ]) {
      expect(shareSplitProblem(a, b), `${a}+${b}`).toBeNull();
    }
  });

  it("refuses 40 + 15 by naming the total", () => {
    expect(shareSplitProblem("40", "15")).toBe(
      "The two shares must add up to 50. These add up to 55.",
    );
  });

  it("does not let float addition pass 33.33 + 16.66", () => {
    expect(shareSplitProblem("33.33", "16.66")).toBe(
      "The two shares must add up to 50. These add up to 49.99.",
    );
  });

  it("asks for both before judging, and explains a malformed figure", () => {
    expect(shareSplitProblem("", "10")).toBe("Enter both shares.");
    expect(shareSplitProblem("50", "0")).toMatch(/above 0/);
  });
});

describe("shareSummary", () => {
  it("is the live 'Company 50% · Signer 40% · Partner 10%' line", () => {
    expect(shareSummary("40", "10")).toBe("Company 50% · Signer 40% · Partner 10%");
    expect(shareSummary("40", "")).toBe("Company 50% · Signer 40% · Partner ?");
  });
});

describe("months", () => {
  it("round-trips a month input and steps across a year", () => {
    expect(monthInputToPeriod("2026-08")).toBe("2026-08-01");
    expect(monthInputToPeriod("2026-13")).toBeNull();
    expect(monthInputToPeriod("")).toBeNull();
    expect(periodToMonthInput("2026-08-01")).toBe("2026-08");
    expect(nextPeriod("2026-12-01")).toBe("2027-01-01");
    expect(previousPeriod("2027-01-01")).toBe("2026-12-01");
  });

  it("shows an exclusive end as the last month paid", () => {
    expect(shareMonths("2026-08-01", null)).toBe("from August 2026");
    expect(shareMonths("2026-08-01", "2026-11-01")).toBe("August 2026 – October 2026");
  });
});
