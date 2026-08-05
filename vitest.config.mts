import path from "node:path";

import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Mirrors the "@/*" path alias in tsconfig.json.
    alias: { "@": path.resolve(import.meta.dirname, ".") },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // This suite has to stay hermetic: no Docker, no network, no shared state.
    // Both other suites are therefore excluded by path, not by a skip guard —
    //   * tests/live needs `supabase start` + `supabase functions serve`
    //   * tests/deployed talks to the real hosted project over the network
    // Each runs through its own config (vitest.live.config.mts,
    // vitest.deployed.config.mts) so a failure there is unambiguous: the
    // environment drifted, not the code. Anything added under tests/ that
    // needs more than PGlite belongs in one of those directories, not here.
    exclude: [
      ...configDefaults.exclude,
      "tests/live/**",
      "tests/deployed/**",
    ],
    // Each RLS test file spins up its own in-memory Postgres. Cheap but not
    // free, and CPU-bound during WASM init, so don't oversubscribe.
    maxWorkers: 4,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
