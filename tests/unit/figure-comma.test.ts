import { describe, expect, it } from "vitest";

import { parseFigureInput } from "@/lib/payouts";
import {
  COLUMN_HEADERS,
  MISPLACED_COMMA,
  parseNumberCell,
  parseResidualSheet,
} from "../../supabase/functions/_shared/residuals.ts";

/**
 * D-10. Both money parsers on the payouts side stripped commas wherever they
 * were, so "12,99" — a decimal comma — was read as 1299, a hundred times the
 * figure typed. A comma is now accepted only as thousands grouping
 * (`^\d{1,3}(,\d{3})+(\.\d+)?$`). Everything else they accepted is unchanged;
 * the existing suites (residuals-parse, payouts-editing) pin that, and the
 * "still accepted" block below repeats the edges closest to the change.
 */

const ACCEPTED: [string, number][] = [
  ["1,299.00", 1299],
  ["12,345", 12345],
  ["1299.5", 1299.5],
];

const REJECTED = ["12,99", "1,29", "12,9999", ",100", "1,,000"];

describe("parseFigureInput — commas (payout cells)", () => {
  for (const [text, value] of ACCEPTED) {
    it(`accepts ${text}`, () => {
      expect(parseFigureInput(text, "residual_income")).toEqual({ ok: true, value });
    });
  }

  for (const text of REJECTED) {
    it(`refuses ${text} with the comma message`, () => {
      const result = parseFigureInput(text, "residual_income");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).toMatch(/Commas can only separate thousands/);
      expect(result.message).toMatch(/12\.99/);
    });
  }

  it("still accepts what it accepted before around the digits", () => {
    expect(parseFigureInput("$1,234.56", "residual_income")).toEqual({ ok: true, value: 1234.56 });
    expect(parseFigureInput("-1,234.5", "residual_income")).toEqual({ ok: true, value: -1234.5 });
    expect(parseFigureInput(" 1,234 ", "residual_income")).toEqual({ ok: true, value: 1234 });
    expect(parseFigureInput("1 234", "residual_income")).toEqual({ ok: true, value: 1234 });
    expect(parseFigureInput("1,234,567.891", "residual_income")).toEqual({ ok: true, value: 1234567.89 });
    expect(parseFigureInput("42.5%", "rep_split_pct")).toEqual({ ok: true, value: 42.5 });
    expect(parseFigureInput(".5", "residual_income")).toEqual({ ok: true, value: 0.5 });
    expect(parseFigureInput("", "residual_income")).toEqual({ ok: true, value: null });
  });

  it("keeps the old message for text that was never a number", () => {
    expect(parseFigureInput("1,2x0", "residual_income")).toEqual({
      ok: false,
      message: "Enter a number, or leave it blank.",
    });
  });

  it("a misplaced comma in a split is refused before the range check", () => {
    // "50,5" used to read as 505 and report the 0..100 range — the wrong reason.
    const result = parseFigureInput("50,5", "rep_split_pct");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/Commas can only separate thousands/);
  });
});

describe("parseNumberCell — commas (residual import)", () => {
  for (const [text, value] of ACCEPTED) {
    it(`accepts ${text}`, () => {
      expect(parseNumberCell(text)).toEqual({ value, ok: true });
    });
  }

  for (const text of REJECTED) {
    it(`refuses ${text}, naming why`, () => {
      expect(parseNumberCell(text)).toEqual({ value: null, ok: false, problem: MISPLACED_COMMA });
    });
  }

  it("still accepts the wrappers it accepted before", () => {
    expect(parseNumberCell("$1,234,567.89")).toEqual({ value: 1234567.89, ok: true });
    expect(parseNumberCell("(1,234.56)")).toEqual({ value: -1234.56, ok: true });
    expect(parseNumberCell("-1,234")).toEqual({ value: -1234, ok: true });
    expect(parseNumberCell("1,234%")).toEqual({ value: 1234, ok: true });
    expect(parseNumberCell("$ 1,234")).toEqual({ value: 1234, ok: true });
    // A lone comma was read as blank before and still is.
    expect(parseNumberCell(",")).toEqual({ value: null, ok: true });
    // A numeric cell never had text handling and still has none.
    expect(parseNumberCell(1299)).toEqual({ value: 1299, ok: true });
  });

  it("leaves other unreadable text exactly as it was", () => {
    expect(parseNumberCell("1,2x0")).toEqual({ value: null, ok: false });
  });
});

describe("parseResidualSheet — a misplaced comma blocks the row and names the cell", () => {
  const HEADER = [
    COLUMN_HEADERS.period,
    COLUMN_HEADERS.agent_number,
    COLUMN_HEADERS.mid,
    COLUMN_HEADERS.merchant_name,
    COLUMN_HEADERS.volume,
    COLUMN_HEADERS.average_ticket,
    COLUMN_HEADERS.total_cost,
  ];

  it("blocks as bad_number with a cell-level reason", () => {
    const result = parseResidualSheet([
      HEADER,
      ["Jul-26", "4471", "MID-1", "Joe's Diner", "12,400.00", "62.00", "12,99"],
    ]);
    if (!result.ok) throw new Error("expected a parse");
    const [row] = result.rows;
    expect(row.blockers).toContain("bad_number");
    expect(row.total_cost).toBeNull();
    expect(row.volume).toBe(12400);
    expect(row.number_problems).toEqual([`Total cost "12,99" ${MISPLACED_COMMA}.`]);
  });

  it("has no number problems on a clean row", () => {
    const result = parseResidualSheet([
      HEADER,
      ["Jul-26", "4471", "MID-1", "Joe's Diner", "12,400.00", "62.00", "$310.00"],
    ]);
    if (!result.ok) throw new Error("expected a parse");
    expect(result.rows[0].blockers).toEqual([]);
    expect(result.rows[0].number_problems).toEqual([]);
  });
});
