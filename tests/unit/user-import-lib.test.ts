import { describe, expect, it } from "vitest";

import {
  SKIPPABLE_BLOCKERS as SHARED_SKIPPABLE,
  isBlocking as sharedIsBlocking,
} from "../../supabase/functions/_shared/user-imports";
import {
  SKIPPABLE_BLOCKERS,
  blockerLabel,
  isBlocking,
  reviewImportRows,
  summariseOutcomes,
  type UserImportRow,
} from "@/lib/user-imports";

/**
 * The browser half of the bulk import.
 *
 * Two jobs here, and the first matters more than it looks:
 *
 *   1. **Pin the duplication.** lib/user-imports.ts keeps its own copy of the
 *      blocking rule rather than importing the shared module, because that
 *      module reaches _shared/provision-user.ts and would drag a password
 *      generator and audit-write helpers into the browser bundle. The repo has
 *      one other pair like this (lib/pre-app-validation.ts against
 *      _shared/pre-app-secrets.ts) and it is pinned only by behaviour in a live
 *      test. This one is pinned directly: both are imported here and compared,
 *      so the copies cannot drift silently. If they did, a row the server skips
 *      would render as a row that blocks the import, or worse the reverse.
 *
 *   2. **Prove the grouping.** The review screen's whole job is to be
 *      unambiguous about which rows become accounts, which are passed over, and
 *      which stop the import — three answers with three different responses.
 */

const ALL_BLOCKERS = [
  "missing_name",
  "invalid_email",
  "invalid_role",
  "invalid_agent_number",
  "duplicate_email_in_file",
  "duplicate_agent_number_in_file",
  "email_exists",
  "agent_number_taken",
] as const;

/** A staged row, with only the fields under test filled in. */
function row(over: Partial<UserImportRow> = {}): UserImportRow {
  return {
    id: over.row_number ?? 1,
    row_number: 2,
    full_name_raw: "Avery Agent",
    email_raw: "avery@tapswipe.test",
    role_raw: "agent",
    agent_number_raw: null,
    full_name: "Avery Agent",
    email: "avery@tapswipe.test",
    role: "agent",
    agent_number: null,
    blocker: null,
    error: null,
    outcome: null,
    outcome_detail: null,
    user_id: null,
    orphaned_auth_user: null,
    provisioned_at: null,
    ...over,
  };
}

describe("the browser copy matches the shared module", () => {
  it("agrees on which blockers are skippable", () => {
    expect([...SKIPPABLE_BLOCKERS].sort()).toEqual([...SHARED_SKIPPABLE].sort());
  });

  it("agrees on isBlocking for every blocker in the vocabulary", () => {
    for (const blocker of ALL_BLOCKERS) {
      expect(isBlocking(blocker)).toBe(sharedIsBlocking(blocker));
    }
  });

  it("agrees that no blocker at all does not block", () => {
    expect(isBlocking(null)).toBe(sharedIsBlocking(null));
  });

  it("has a label for every blocker, so none renders as a raw code", () => {
    for (const blocker of ALL_BLOCKERS) {
      expect(blockerLabel(blocker)).not.toBe(blocker);
    }
  });
});

describe("reviewImportRows", () => {
  it("counts a clean file as all ready", () => {
    const review = reviewImportRows([row(), row({ row_number: 3 })]);
    expect(review.total).toBe(2);
    expect(review.ready).toBe(2);
    expect(review.willSkip).toBe(0);
    expect(review.blocked).toBe(0);
    expect(review.canProvision).toBe(true);
  });

  it("separates rows that will be skipped from rows that block", () => {
    const review = reviewImportRows([
      row({ row_number: 2 }),
      row({ row_number: 3, blocker: "email_exists", error: "Already has one." }),
      row({ row_number: 4, blocker: "missing_name", error: "No name." }),
    ]);

    expect(review.ready).toBe(1);
    expect(review.willSkip).toBe(1);
    expect(review.blocked).toBe(1);
    // A blocking row stops the run; a skippable one does not.
    expect(review.canProvision).toBe(false);
    expect(review.skipped.map((s) => s.rowNumber)).toEqual([3]);
    expect(review.fileProblems.map((p) => p.blocker)).toEqual(["missing_name"]);
  });

  it("still allows the run when the only problems are skippable", () => {
    // The decision the whole blocking/skippable split exists for: three people
    // who already have logins must not stop thirty-nine who do not.
    const review = reviewImportRows([
      row({ row_number: 2 }),
      row({ row_number: 3, blocker: "email_exists" }),
      row({ row_number: 4, blocker: "agent_number_taken" }),
    ]);

    expect(review.canProvision).toBe(true);
    expect(review.ready).toBe(1);
    expect(review.willSkip).toBe(2);
  });

  it("refuses to offer a run for an empty file", () => {
    // Flipping a batch to committed having created nothing reads as a
    // successful import of an empty file.
    expect(reviewImportRows([]).canProvision).toBe(false);
  });

  it("groups file problems by code but lists skipped rows individually", () => {
    // Different fixes: one corrected upload clears every row sharing a problem,
    // whereas "which three people are being skipped" names three people.
    const review = reviewImportRows([
      row({ row_number: 2, blocker: "missing_name", error: "No name." }),
      row({ row_number: 3, blocker: "missing_name", error: "No name." }),
      row({ row_number: 4, blocker: "email_exists", email: "a@t.test" }),
      row({ row_number: 5, blocker: "email_exists", email: "b@t.test" }),
    ]);

    expect(review.fileProblems).toHaveLength(1);
    expect(review.fileProblems[0].rows).toHaveLength(2);
    expect(review.skipped).toHaveLength(2);
    expect(review.skipped.map((s) => s.who)).toEqual(["a@t.test", "b@t.test"]);
  });
});

describe("summariseOutcomes", () => {
  it("counts each outcome and leaves unattempted rows pending", () => {
    const result = summariseOutcomes([
      row({ row_number: 2, outcome: "created" }),
      row({ row_number: 3, outcome: "resumed" }),
      row({ row_number: 4, outcome: "skipped_duplicate" }),
      row({ row_number: 5, outcome: "failed" }),
      row({ row_number: 6 }),
    ]);

    expect(result.created).toBe(1);
    expect(result.resumed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(1);
    // Null outcome is the work list, and the screen shows it as "left to do".
    expect(result.pending).toBe(1);
  });

  it("surfaces orphans separately, whatever their outcome", () => {
    // An auth user with no profile can log in and lands on an error page. It
    // must never be reachable only by reading a count.
    const result = summariseOutcomes([
      row({ row_number: 2, outcome: "created" }),
      row({
        row_number: 3,
        outcome: "failed",
        orphaned_auth_user: "99999999-9999-9999-9999-999999999999",
      }),
    ]);

    expect(result.orphans).toHaveLength(1);
    expect(result.orphans[0].row_number).toBe(3);
    expect(result.failures).toHaveLength(1);
  });

  it("reports nothing for a batch that has not run", () => {
    const result = summariseOutcomes([row(), row({ row_number: 3 })]);
    expect(result.pending).toBe(2);
    expect(result.created).toBe(0);
    expect(result.orphans).toHaveLength(0);
  });
});
