import path from "node:path";

import { defineConfig } from "vitest/config";

/**
 * The live suite: real HTTP against a running local Supabase stack.
 *
 * Separate from vitest.config.mts because these tests have external
 * dependencies (`supabase start` and `supabase functions serve`) and mutate
 * shared state — the local database and Storage bucket. Keeping them out of the
 * default `npm test` means that suite stays hermetic and parallel-safe.
 */
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, ".") },
  },
  test: {
    environment: "node",
    include: ["tests/live/**/*.test.ts"],
    // One stack, one set of fixture users. Two files provisioning the same
    // personas concurrently would delete each other's rows mid-run.
    fileParallelism: false,
    // Container cold-start on the first invocation, plus user provisioning.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
