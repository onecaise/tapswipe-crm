import { describe, expect, it } from "vitest";

import { parsePriceInput } from "@/lib/products";

describe("parsePriceInput — what the admin typed, or why not", () => {
  it("accepts a price as a price sheet writes it", () => {
    expect(parsePriceInput("$1,299.50")).toEqual({ value: 1299.5 });
    expect(parsePriceInput(" 349 ")).toEqual({ value: 349 });
    expect(parsePriceInput("0")).toEqual({ value: 0 });
  });

  it("keeps blank as not-priced (null), never zero", () => {
    expect(parsePriceInput("   ")).toEqual({ value: null });
  });

  it("refuses JavaScript numeric literals rather than reinterpreting them (QA-003)", () => {
    for (const typed of ["0x10", "1e3", "0b11", "0o7", "Infinity", "12abc", "1.2.3"]) {
      expect(parsePriceInput(typed), typed).toEqual({ error: "That is not a number." });
    }
  });

  it("still says why for negatives, extra decimals and the column ceiling", () => {
    expect(parsePriceInput("-5").error).toMatch(/negative/);
    expect(parsePriceInput("1.234").error).toMatch(/two decimal/);
    expect(parsePriceInput("10000000000").error).toMatch(/too large/);
  });

  it("accepts plain digits or valid thousands grouping, with an optional $ (A1)", () => {
    const cases: Array<[string, number]> = [
      ["1,299", 1299],
      ["1,299.00", 1299],
      ["$1,299.00", 1299],
      ["12,345", 12345],
      ["1299", 1299],
      ["1299.5", 1299.5],
      ["  $1,234,567.89  ", 1234567.89],
      ["$ 12.99", 12.99],
    ];
    for (const [typed, value] of cases) {
      expect(parsePriceInput(typed), typed).toEqual({ value });
    }
  });

  it("refuses a misplaced comma and says to use a period (A1)", () => {
    for (const typed of ["12,99", "1,29", "12,9999", "1,2345.00", ",100", "1,,000", "1299,"]) {
      expect(parsePriceInput(typed), typed).toEqual({
        error: "Use a period for decimals, for example 12.99",
      });
    }
  });

  it("refuses other shapes, including a foreign currency symbol and a bare leading point (A1)", () => {
    // ".5" was accepted before A1. Owen's rule is digits first, so it now errors
    // like any other shape outside the two patterns.
    for (const typed of ["€12,99", ".5", "12.", "1 299", "$$12", "12$"]) {
      expect(parsePriceInput(typed), typed).toEqual({ error: "That is not a number." });
    }
  });
});
