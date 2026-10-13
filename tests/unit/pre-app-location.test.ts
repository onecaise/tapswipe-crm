import { describe, expect, it } from "vitest";

import { businessStepSchema } from "@/lib/pre-app-validation";

/**
 * The business step requires a city and a state (20261013132000), because
 * submit_pre_app() refuses a pre-app without them. These pin the client half;
 * tests/rls/merchant-location.test.ts drives the RPC.
 */
const { city, state } = businessStepSchema.shape;

describe("business step: city", () => {
  it.each(["Nashville", "St. Louis", "Winston-Salem", "  Memphis  "])(
    "accepts %j",
    (value) => {
      expect(city.safeParse(value).success).toBe(true);
    },
  );

  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["only punctuation", "..."],
    ["a single letter", "X"],
    ["over 60 characters", "A".repeat(61)],
  ])("refuses %s", (_label, value) => {
    expect(city.safeParse(value).success).toBe(false);
  });

  it("says the city is required when it is empty", () => {
    const r = city.safeParse("");
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].message).toBe("A business city is required");
  });
});

describe("business step: state", () => {
  it("accepts a listed code", () => {
    expect(state.safeParse("TN").success).toBe(true);
  });

  it.each(["", "Tennessee", "tn", "ZZ"])("refuses %j", (value) => {
    expect(state.safeParse(value).success).toBe(false);
  });
});
