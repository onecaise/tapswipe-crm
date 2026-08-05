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
    // tests/live needs `supabase start` + `supabase functions serve` running,
    // so it can't be part of the default suite — that suite has to stay
    // hermetic. It runs via `npm run test:live` (vitest.live.config.mts) and
    // hard-errors rather than skipping when the stack isn't up.
    exclude: [...configDefaults.exclude, "tests/live/**"],
    // Each RLS test file spins up its own in-memory Postgres. Cheap but not
    // free, and CPU-bound during WASM init, so don't oversubscribe.
    maxWorkers: 4,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
