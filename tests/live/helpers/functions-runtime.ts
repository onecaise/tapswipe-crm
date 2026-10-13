import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Is the local Edge Functions runtime actually serving the functions?
 *
 * "The suite ran" and "the functions ran" are different facts, and the live
 * suite used to confuse them two ways:
 *
 *   * functionsAreServed() probed `create-upload-url` and accepted ANY HTTP
 *     status. With the runtime down, Kong still answers -- 503 `{"message":
 *     "name resolution failed"}` -- so the check passed and every test then
 *     failed on a 503 that named nothing. (It also probed a function removed on
 *     13 Oct 2026; a 404 for a missing slug counted as "served" too.)
 *   * A file whose beforeAll threw reported all its tests as SKIPPED, which in
 *     a long run reads like a normal result.
 *
 * So the rule now: every function registered in supabase/config.toml must
 * answer an unauthenticated POST with ITS OWN 401 (the withSupabase guard).
 * That is the only answer that proves the code is running -- CLAUDE.md's
 * 401-vs-404 deploy check, applied locally.
 */

export const FUNCTIONS_DOWN_MESSAGE =
  "functions runtime not reachable: restart `npx supabase functions serve`";

/** The opt-in that turns "fail the run" into "skip the tests that need it". */
export const ALLOW_SKIP_ENV = "ALLOW_SKIPPED_FUNCTION_TESTS";

export function skipAllowed(): boolean {
  return process.env[ALLOW_SKIP_ENV] === "1";
}

/** Every [functions.<name>] block in supabase/config.toml, in file order. */
export function registeredFunctions(): string[] {
  const toml = readFileSync(
    path.resolve(import.meta.dirname, "../../../supabase/config.toml"),
    "utf8",
  );
  return [...toml.matchAll(/^\[functions\.([A-Za-z0-9_-]+)\]\s*$/gm)].map((m) => m[1]);
}

export type ProbeResult = { name: string; status: number; body: string };

/** One unauthenticated POST. status 0 means the request never got an answer. */
export async function probeFunction(apiUrl: string, name: string): Promise<ProbeResult> {
  try {
    const response = await fetch(`${apiUrl}/functions/v1/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    return { name, status: response.status, body: (await response.text()).slice(0, 120) };
  } catch (err) {
    return { name, status: 0, body: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Probes every registered function until all answer 401, or the deadline
 * passes. Retries because the FIRST call to a function makes the CLI write a
 * .npmrc and restart the runtime (502s, briefly), which is a warm-up rather
 * than an outage -- see warmFunctions() in stack.ts.
 */
export async function functionsRuntimeHealthy(
  apiUrl: string,
  { deadlineMs = 30_000, intervalMs = 2_000 } = {},
): Promise<{ ok: boolean; bad: ProbeResult[] }> {
  const names = registeredFunctions();
  const deadline = Date.now() + deadlineMs;
  let bad: ProbeResult[] = [];
  do {
    const results = await Promise.all(names.map((name) => probeFunction(apiUrl, name)));
    bad = results.filter((r) => r.status !== 401);
    if (bad.length === 0) return { ok: true, bad };
    if (Date.now() + intervalMs > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (Date.now() < deadline);
  return { ok: false, bad };
}

/**
 * True when a response is Kong talking about the runtime rather than a
 * function answering. Two shapes, both measured on the local stack:
 *
 *   503 "name resolution failed"       the edge runtime container is GONE
 *   502 "An invalid response was received from the upstream server"
 *                                      the container is stopped, OR restarting
 *                                      (the first-call .npmrc restart)
 *
 * No function in this repo returns either itself. The 502 is ambiguous on its
 * own -- a restart lasts seconds, an outage does not -- which is why invoke()
 * retries before calling it an outage.
 */
export function isRuntimeDownResponse(status: number, body: string): boolean {
  return (
    (status === 503 && /name resolution failed/i.test(body)) ||
    (status === 502 && /invalid response was received from the upstream server/i.test(body))
  );
}
