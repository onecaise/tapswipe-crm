import { describe, expect, it } from "vitest";

import {
  CHOOSE_FUNDING,
  COMPANY_FUNDER,
  OVERRIDE_FUNDING_CHOICES,
  overrideExample,
  overrideFundingText,
  overrideIdsOf,
  overrideInForce,
  overrideLineLabel,
  overrideMonths,
  parseOverridePct,
  type MerchantOverride,
} from "@/lib/overrides";

/**
 * lib/overrides.ts: the form's courtesy checks (the database is the boundary,
 * tests/rls/merchant-overrides.test.ts) and what a statement line says.
 */

describe("parseOverridePct: the cap is the merchant's rate", () => {
  it.each([
    [50, "50", 5000],
    [50, "0.01", 1],
    [30, "30", 3000],
    [46.5, "46.5", 4650],
    [50, "10%", 1000],
  ])("at rate %s accepts %s", (rate, raw, hundredths) => {
    expect(parseOverridePct(raw, rate)).toEqual({ ok: true, hundredths });
  });

  it.each([
    [50, "50.01", /cannot be more than this merchant's rate: 50\./],
    [30, "30.01", /cannot be more than this merchant's rate: 30\./],
    [50, "0", /above 0/],
    [50, "-1", /above 0/],
    [50, "10.001", /at most two decimals/],
    [50, "ten", /above 0/],
    [0, "1", /rate is 0/],
    [null, "1", /no split rate yet/],
  ])("at rate %s refuses %s", (rate, raw, message) => {
    const result = parseOverridePct(raw, rate);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(message);
  });
});

describe('overrideExample: one sentence per "Paid from" choice', () => {
  it("before a choice is made, it asks for one instead of guessing", () => {
    expect(overrideExample(1000, 50, null)).toBe(CHOOSE_FUNDING);
    expect(CHOOSE_FUNDING).toBe("Choose who pays it: the owner's side or the company's share.");
  });

  it("owner-funded, the memo's example: rate 50, override 10", () => {
    expect(overrideExample(1000, 50, "owner")).toBe(
      "On a $100 residual: the recipient gets $10.00, the owner keeps $40.00 of the $50.00 rep side, and the company keeps $50.00.",
    );
  });

  it("owner-funded at the cap: the owner keeps nothing and the company's share is unchanged", () => {
    expect(overrideExample(3000, 30, "owner")).toMatch(/the owner keeps \$0\.00 of the \$30\.00 rep side, and the company keeps \$70\.00\.$/);
  });

  it("company-funded, the design's example: rate 50, override 5", () => {
    expect(overrideExample(500, 50, "company")).toBe(
      "On a $100 residual: the recipient gets $5.00, the owner keeps the full $50.00 rep side, and the company keeps $45.00 of its $50.00.",
    );
  });

  it("company-funded at a rate below 50 and a fractional percent", () => {
    expect(overrideExample(250, 30, "company")).toBe(
      "On a $100 residual: the recipient gets $2.50, the owner keeps the full $30.00 rep side, and the company keeps $67.50 of its $70.00.",
    );
  });

  it("the choices, in order, neither of them a default", () => {
    expect(OVERRIDE_FUNDING_CHOICES.map((c) => c.value)).toEqual(["owner", "company"]);
    expect(overrideFundingText("owner")).toBe("paid from the owner's side");
    expect(overrideFundingText("company")).toBe("paid from the company's share");
  });
});

describe("overrideLineLabel (memo A4c)", () => {
  const view = { override_id: 7, recipient_name: "Dana Cole", override_pct: 10 };

  it("a debit names the percent and who receives it", () => {
    expect(overrideLineLabel({ override_role: "debit" }, view, false)).toBe(
      "Override 10% of residual · to Dana Cole",
    );
  });

  it("a debit whose name could not load shows no name, never a guess", () => {
    expect(overrideLineLabel({ override_role: "debit" }, undefined, false)).toBe("Override");
  });

  it("a credit names nobody for the recipient; an admin sees the percent", () => {
    expect(overrideLineLabel({ override_role: "credit" }, view, false)).toBe("Override received");
    expect(overrideLineLabel({ override_role: "credit" }, undefined, false)).toBe("Override received");
    expect(overrideLineLabel({ override_role: "credit" }, view, true)).toBe(
      "Override received · 10% of residual",
    );
  });

  it("a company-funded credit says so to an admin only; the recipient's label is unchanged", () => {
    const line = { override_role: "credit" as const, override_funded_by: "company" as const };
    expect(overrideLineLabel(line, view, true)).toBe("Override received · 10% of residual · from the company's share");
    expect(overrideLineLabel(line, view, false)).toBe("Override received");
    expect(overrideLineLabel({ ...line, override_funded_by: "owner" }, view, true)).toBe("Override received · 10% of residual");
    expect(COMPANY_FUNDER).toBe("Tapswipe (company share)");
  });
});

describe("months and the override in force", () => {
  const o = (id: number, from: string, to: string | null): MerchantOverride => ({
    id, merchant_id: 1, recipient_id: "r", override_pct: 10, effective_from: from, effective_to: to, funded_by: "owner",
  });

  it("effective_to is exclusive", () => {
    expect(overrideMonths("2026-08-01", null)).toBe("from August 2026");
    expect(overrideMonths("2026-08-01", "2026-11-01")).toBe("August 2026 – October 2026");
  });

  it("finds the one covering a month, and none outside them", () => {
    const list = [o(2, "2026-11-01", null), o(1, "2026-08-01", "2026-11-01")];
    expect(overrideInForce(list, "2026-10-01")?.id).toBe(1);
    expect(overrideInForce(list, "2026-11-01")?.id).toBe(2);
    expect(overrideInForce(list, "2026-07-01")).toBeNull();
  });

  it("collects the distinct override ids a page's lines name", () => {
    expect(overrideIdsOf([{ override_id: 3 }, { override_id: null }, { override_id: 3 }, {}, { override_id: 4 }])).toEqual([3, 4]);
  });
});
