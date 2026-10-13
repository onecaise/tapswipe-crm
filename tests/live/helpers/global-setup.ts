import type { TestProject } from "vitest/node";

import { getStackConfig } from "./stack";
import {
  ALLOW_SKIP_ENV,
  FUNCTIONS_DOWN_MESSAGE,
  functionsRuntimeHealthy,
  skipAllowed,
} from "./functions-runtime";

declare module "vitest" {
  export interface ProvidedContext {
    /** True only when the runtime is down AND ALLOW_SKIPPED_FUNCTION_TESTS=1. */
    functionsDown: boolean;
  }
}

/**
 * Runs once, before any live test file.
 *
 * If the functions runtime is not serving every registered function, the RUN
 * fails here with one message -- not a column of skipped tests, and not dozens
 * of 503s that each look like a broken function. Set
 * ALLOW_SKIPPED_FUNCTION_TESTS=1 to run what does not need functions instead;
 * the function-dependent files then skip, and the reporter counts them.
 */
export default async function setup(project: TestProject): Promise<void> {
  const { apiUrl } = getStackConfig();
  const { ok, bad } = await functionsRuntimeHealthy(apiUrl);

  if (ok) {
    project.provide("functionsDown", false);
    return;
  }

  const detail = bad
    .map((r) => `  ${r.name}: ${r.status === 0 ? "no answer" : r.status} ${r.body}`)
    .join("\n");

  if (skipAllowed()) {
    console.warn(
      `\n[live] ${FUNCTIONS_DOWN_MESSAGE}\n${detail}\n` +
        `[live] ${ALLOW_SKIP_ENV}=1 is set: tests that need functions will be SKIPPED.\n`,
    );
    project.provide("functionsDown", true);
    return;
  }

  throw new Error(
    `${FUNCTIONS_DOWN_MESSAGE}\n` +
      `Expected every function in supabase/config.toml to answer an unauthenticated POST with its own 401. Not answering:\n` +
      `${detail}\n` +
      `(Set ${ALLOW_SKIP_ENV}=1 to run without functions; those tests will be skipped and counted.)`,
  );
}
