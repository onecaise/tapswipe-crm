import { describe, expect, it } from "vitest";

import { adminClient } from "./helpers/stack";

/**
 * The three private buckets exist on the local stack, created by migration
 * 20261009170000 — and by nothing else.
 *
 * Until that migration, every suite created the buckets it needed in its own
 * helpers, so a bucket missing from a hosted project (marketing, on dev) was
 * invisible to all of them. The helpers no longer create buckets, and this
 * file deliberately does NOT call provisionFixtures(): it reads the state the
 * migration left, straight after a `supabase db reset`.
 *
 * EXISTENCE is the load-bearing claim here — nothing but the migration can
 * produce a bucket now. Privacy and the limit are also asserted, but the
 * helpers re-assert both on every run (updateBucket always sends `public`), so
 * on their own they could be the helper's work rather than the migration's.
 * tests/unit/storage-buckets-migration.test.ts pins what the MIGRATION itself
 * says about them.
 */

const EXPECTED = ["documents", "marketing", "residual-imports"] as const;
const LIMIT = 50 * 1024 * 1024;

describe("storage buckets from the migration", () => {
  for (const id of EXPECTED) {
    it(`${id} exists, is private and carries the 50 MiB limit`, async () => {
      const { data, error } = await adminClient().storage.getBucket(id);
      expect(error, `bucket ${id} is missing — migration 20261009170000 should create it`).toBeNull();
      expect(data?.public).toBe(false);
      expect(data?.file_size_limit).toBe(LIMIT);
    });
  }
});
