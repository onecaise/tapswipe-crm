import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * What migration 20261009170000 SAYS about the buckets, pinned without a stack.
 *
 * tests/live/storage-buckets.test.ts proves the buckets exist after a reset,
 * but the live helpers re-assert privacy and the size limit on every run, so
 * the live check alone cannot tell whether the MIGRATION made them private.
 * This can. It also pins the two properties that make the migration safe to
 * push at a hosted project that already has buckets made by hand.
 */

const sql = readFileSync(
  path.resolve(
    import.meta.dirname,
    "../../supabase/migrations/20261009170000_storage_buckets.sql",
  ),
  "utf8",
)
  // Comments out, so a sentence about a policy cannot satisfy or fail a check.
  .replace(/--.*$/gm, "");

describe("migration 20261009170000_storage_buckets", () => {
  for (const id of ["documents", "residual-imports", "marketing"]) {
    it(`creates ${id} private with the 52428800-byte limit`, () => {
      expect(sql).toMatch(
        new RegExp(`\\('${id}',\\s*'${id}',\\s*false,\\s*52428800\\)`),
      );
    });
  }

  it("never changes a bucket that already exists", () => {
    expect(sql).toMatch(/on conflict \(id\) do nothing/i);
    expect(sql).not.toMatch(/do update/i);
  });

  it("returns early where there is no storage schema (the PGlite suite)", () => {
    expect(sql).toMatch(
      /if to_regclass\('storage\.buckets'\) is null then\s+return;/i,
    );
  });

  it("adds no storage policy — access is signed URLs from the Edge Functions", () => {
    expect(sql).not.toMatch(/create policy|storage\.objects/i);
  });
});
