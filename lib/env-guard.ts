/**
 * Guard against developing against the hosted Supabase project by accident.
 *
 * This exists because it already happened. `.env.local` holds the hosted
 * project, and for a while nothing else set the URL, so `npm run dev` pointed
 * the whole app at production. The symptoms were indirect and easy to
 * misdiagnose: an admin-only column appearing for what should have been a rep,
 * and a list reporting "no pre-apps yet" because the row existed in the other
 * database. Nothing said "you are talking to production" — that had to be
 * worked out backwards from the rendered HTML.
 *
 * `.env.development.local` now supplies the local stack in dev and wins over
 * `.env.local`, so the default is correct without anyone remembering. This is
 * the second line of defence for when that file is missing, stale, or
 * overridden by a shell variable.
 */

/** Set to "1" to develop against a remote project on purpose. */
export const ALLOW_REMOTE_ENV_VAR = "ALLOW_REMOTE_SUPABASE_IN_DEV";

export type EnvCheckResult =
  | { ok: true }
  | { ok: false; reason: "missing" | "remote"; message: string };

/**
 * Decides whether a Supabase URL is acceptable for the given environment.
 *
 * Pure and parameterised rather than reading `process.env` directly, so the
 * rules are testable without mutating global state — which in turn is why the
 * message wording can be asserted rather than hoped for.
 */
export function checkSupabaseEnv({
  url,
  nodeEnv,
  allowRemote,
}: {
  url: string | undefined;
  nodeEnv: string | undefined;
  allowRemote: boolean;
}): EnvCheckResult {
  // Only development is constrained. A production build is *supposed* to point
  // at the hosted project, and the test suites target their own stacks
  // explicitly rather than through these variables.
  if (nodeEnv !== "development") return { ok: true };
  if (allowRemote) return { ok: true };

  if (!url || url.trim() === "") {
    return {
      ok: false,
      reason: "missing",
      message:
        "NEXT_PUBLIC_SUPABASE_URL is not set. In development it should point at " +
        "the local stack — run `npx supabase start` and make sure " +
        ".env.development.local exists (see .env.example).",
    };
  }

  if (isLocalSupabaseUrl(url)) return { ok: true };

  return {
    ok: false,
    reason: "remote",
    message:
      `NEXT_PUBLIC_SUPABASE_URL is ${url}, which is not the local stack.\n\n` +
      "Running `next dev` against the hosted project means every edit in the " +
      "app writes to real merchant data, and the failure mode is silence " +
      "rather than an error.\n\n" +
      "Fix: run `npx supabase start`, then recreate .env.development.local " +
      "pointing at the URL it prints (Next reads that file ahead of " +
      ".env.local in development).\n\n" +
      `If this is deliberate, set ${ALLOW_REMOTE_ENV_VAR}=1.`,
  };
}

/**
 * Whether a URL addresses a locally-running Supabase stack.
 *
 * Host-based rather than a substring search: `https://localhost.example.com`
 * contains "localhost" and is emphatically not local, and a hosted project
 * reached through a tunnel would not match either. An unparseable URL is
 * treated as non-local — the safe direction, since the point is to catch
 * mistakes rather than to be permissive.
 */
export function isLocalSupabaseUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return (
    host === "127.0.0.1" ||
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "[::1]" ||
    host === "::1" ||
    host === "host.docker.internal"
  );
}

/**
 * Runs the check against the real environment and reports the outcome.
 *
 * Throws on the server so a misconfigured `next dev` fails at boot rather than
 * on whichever page happens to be loaded first, and warns in the browser, where
 * throwing would replace the app with an error overlay for a problem the page
 * itself cannot fix. Either way it is said out loud, once, at the earliest
 * moment the information exists.
 */
export function assertSupabaseEnv(
  options: { throwOnFailure?: boolean } = {},
): void {
  const result = checkSupabaseEnv({
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    nodeEnv: process.env.NODE_ENV,
    allowRemote: process.env[ALLOW_REMOTE_ENV_VAR] === "1",
  });

  if (result.ok) return;

  // Plain text, no ANSI: colour codes are control bytes in source, they are
  // meaningless in a browser console, and this file is not worth that risk.
  const banner = `
WRONG SUPABASE PROJECT

${result.message}
`;

  if (options.throwOnFailure) {
    throw new Error(banner);
  }
  console.warn(banner);
}
