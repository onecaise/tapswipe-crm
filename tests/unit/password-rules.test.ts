import { describe, expect, it } from "vitest";

import {
  MIN_PASSWORD_LENGTH as SHARED_MIN,
  isAcceptablePassword as sharedIsAcceptable,
} from "../../supabase/functions/_shared/admin-users";
import { MIN_PASSWORD_LENGTH, isAcceptablePassword } from "@/lib/passwords";

/**
 * Pins the second password-rule duplication in the repo.
 *
 * lib/passwords.ts is what the two browser forms enforce; the copy in
 * supabase/functions/_shared/admin-users.ts is what create-user enforces on a
 * request body. They cannot be one file — a Deno function has no import-map
 * specifier that reaches above supabase/functions/ — so they are compared here
 * instead, exactly as tests/unit/user-import-lib.test.ts does for isBlocking.
 *
 * Drift is one-directional and confusing either way round: raise the browser
 * number alone and the form refuses a password the server would have taken;
 * raise the server's alone and the form accepts one that comes back as a 400 the
 * admin has no way to interpret.
 *
 * This is the whole vitest coverage the rule can have. Whether the function
 * actually returns 400 for a short password, and whether a chosen one signs in,
 * are HTTP-and-GoTrue facts and live in tests/live/manage-users.test.ts.
 */
describe("the browser copy matches the shared module", () => {
  it("agrees on the minimum length", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(SHARED_MIN);
  });

  it("agrees on every password either side would be asked about", () => {
    const cases = [
      "",
      "a",
      "12345",
      "123456",
      "1234567",
      // Trailing and leading spaces count as characters on both sides. Trimming
      // in one copy only would be the worst version of this drift: the form
      // would send a password the function stores differently from what the
      // admin read out.
      "     ",
      "  a  ",
      "correct horse battery staple",
    ];

    for (const value of cases) {
      expect(
        isAcceptablePassword(value),
        `disagreement on ${JSON.stringify(value)}`,
      ).toBe(sharedIsAcceptable(value));
    }
  });

  it("agrees that a non-string is never acceptable", () => {
    // The function's copy is the one that meets these — a JSON body can carry
    // anything, and a missing key arrives as undefined.
    for (const value of [undefined, null, 123456789, {}, ["abcdef"]]) {
      expect(isAcceptablePassword(value)).toBe(sharedIsAcceptable(value));
      expect(isAcceptablePassword(value)).toBe(false);
    }
  });
});

describe("the rule itself", () => {
  it("accepts exactly the minimum and refuses one character less", () => {
    // The boundary, stated in the test rather than derived, so changing the
    // constant to something the forms and the function disagree about cannot
    // pass by being consistent with itself.
    expect(isAcceptablePassword("x".repeat(MIN_PASSWORD_LENGTH))).toBe(true);
    expect(isAcceptablePassword("x".repeat(MIN_PASSWORD_LENGTH - 1))).toBe(false);
  });

  it("is GoTrue's floor, which is 6", () => {
    // supabase/config.toml sets [auth].minimum_password_length = 6 for the local
    // stack and the hosted projects carry it on their own Auth surface. Raising
    // this constant above 6 is fine; lowering it below would let the form offer
    // a password the Auth server refuses no matter what these two files say.
    expect(MIN_PASSWORD_LENGTH).toBeGreaterThanOrEqual(6);
  });
});
