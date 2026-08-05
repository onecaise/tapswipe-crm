import path from "node:path";

import { defineConfig } from "vitest/config";

/**
 * Compliance checks against the deployed project named in .env.local.
 *
 * A third config rather than a flag on the other two, because the target is
 * different in kind: `npm test` asserts what the migrations do (hermetic,
 * PGlite), `npm run test:live` asserts what the local stack does, and this
 * asserts the state of production. Keeping them separate means production
 * checks can never run by accident in CI, and a red result here is
 * unambiguous — it means the deployed project drifted, not that code broke.
 */
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, ".") },
  },
  test: {
    environment: "node",
    include: ["tests/deployed/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
