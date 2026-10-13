import { describe, expect, it } from "vitest";

import {
  TAX_RATE_MESSAGE,
  isTaxRate,
  terminalStepSchema,
} from "@/lib/pre-app-validation";

/**
 * D-12. pre_app_terminal.tax_rate is numeric(5,3), so it holds at most 99.999.
 * The validator allowed 100, which passed here and then failed at the database
 * as "numeric field overflow". The app-side limit is now the column's.
 */
const taxRateError = (tax_rate: string) => {
  const result = terminalStepSchema.shape.tax_rate.safeParse(tax_rate);
  return result.success ? null : result.error.issues[0]?.message;
};

describe("tax rate limit (D-12)", () => {
  it("accepts 99.999, the largest value the column holds", () => {
    expect(isTaxRate("99.999")).toBe(true);
    expect(taxRateError("99.999")).toBeNull();
  });

  it("refuses 100 with a clear message", () => {
    expect(isTaxRate("100")).toBe(false);
    expect(taxRateError("100")).toBe(TAX_RATE_MESSAGE);
    expect(TAX_RATE_MESSAGE).toBe("Tax rate must be between 0 and 99.999");
  });

  it("keeps everything else it accepted before", () => {
    for (const ok of ["", "0", "8.25", "7.125", "99", "99.99"]) {
      expect(taxRateError(ok), ok).toBeNull();
    }
    for (const bad of ["100.000", "101", "8.2525", "-1", "abc"]) {
      expect(taxRateError(bad), bad).toBe(TAX_RATE_MESSAGE);
    }
  });
});
