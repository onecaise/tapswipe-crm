import { describe, expect, it } from "vitest";

import { parsePriceInput } from "@/lib/products";

describe("parsePriceInput — what the admin typed, or why not", () => {
  it("accepts a price as a price sheet writes it", () => {
    expect(parsePriceInput("$1,299.50")).toEqual({ value: 1299.5 });
    expect(parsePriceInput(" 349 ")).toEqual({ value: 349 });
    expect(parsePriceInput("0")).toEqual({ value: 0 });
    expect(parsePriceInput(".5")).toEqual({ value: 0.5 });
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
});
