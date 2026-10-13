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
    // Fails the whole run with one message if the Edge Functions runtime is
    // not serving every registered function, instead of letting files skip or
    // 503 their way to a result that looks normal. ALLOW_SKIPPED_FUNCTION_TESTS=1
    // opts into skipping the function-dependent files instead.
    globalSetup: ["tests/live/helpers/global-setup.ts"],
    // The default output plus one final "[live] skipped tests: N" line.
    reporters: ["default", "./tests/live/helpers/skip-reporter.ts"],
    // One stack, one set of fixture users. Two files provisioning the same
    // personas concurrently would delete each other's rows mid-run.
    fileParallelism: false,
    // Container cold-start on the first invocation, plus user provisioning.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
