import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * What the bucket migrations SAY, pinned without a stack.
 *
 * tests/live/storage-buckets.test.ts proves the buckets exist after a reset,
 * but the live helpers re-assert privacy and the size limit on every run, so
 * the live check alone cannot tell whether the MIGRATION made them private.
 * This can. It also pins the two properties that make each migration safe to
 * push at a hosted project that already has buckets made by hand.
 *
 * Two files, the same four properties each: 20261009170000 made the first
 * three buckets, and 20261013120500 adds `business-documents` in its own file
 * because an applied migration is never edited.
 */

function migration(name: string): string {
  return (
    readFileSync(
      path.resolve(import.meta.dirname, "../../supabase/migrations", name),
      "utf8",
    )
      // Comments out, so a sentence about a policy cannot satisfy or fail a check.
      .replace(/--.*$/gm, "")
  );
}

const MIGRATIONS = [
  {
    file: "20261009170000_storage_buckets.sql",
    buckets: ["documents", "residual-imports", "marketing"],
  },
  {
    file: "20261013120500_business_documents_bucket.sql",
    buckets: ["business-documents"],
  },
] as const;

for (const { file, buckets } of MIGRATIONS) {
  describe(`migration ${file}`, () => {
    const sql = migration(file);

    for (const id of buckets) {
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
}
