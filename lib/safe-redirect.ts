/**
 * The one check every user-controlled return target goes through before it is
 * followed (QA-001).
 *
 * `/auth/confirm?next=` used to be handed straight to `redirect()`, so a genuine
 * sign-in email with `&next=https://elsewhere` landed a freshly signed-in user
 * off-site — an open redirect delivered from our own domain. The rule here is
 * deliberately an allow-list of one shape: a same-origin path. Anything that is
 * not plainly that falls back, rather than being repaired, because a
 * "normalised" attacker string is still an attacker string.
 *
 * Kept free of Next and browser imports so the server route, client components
 * and the unit suite (`tests/unit/safe-redirect.test.ts`) all share this copy.
 */

/** A host that cannot exist, so a resolved URL keeping it proves "same origin". */
const PROBE_ORIGIN = "http://x.invalid";

/**
 * C0 controls (tab, newline, CR, NUL…), DEL and the C1 range. Browsers strip
 * tab/newline from URLs before parsing, which is how `/\t/evil.com` becomes
 * `//evil.com`; the rest have no business in a path.
 */
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;

/** How many rounds of percent-decoding to look through: raw, once, twice. */
const DECODE_ROUNDS = 2;

function hasSafeShape(value: string): boolean {
  return (
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\") &&
    !CONTROL_CHARS.test(value)
  );
}

/**
 * Returns `raw` only when it is a same-origin relative path; otherwise
 * `fallback`. `raw` is returned unchanged, never decoded — the decoding below
 * exists only to look for something hiding behind an escape.
 */
export function safeNextPath(
  raw: string | null | undefined,
  fallback: string,
): string {
  if (typeof raw !== "string" || raw === "") return fallback;

  let candidate = raw;
  for (let round = 0; round <= DECODE_ROUNDS; round++) {
    if (!hasSafeShape(candidate)) return fallback;
    if (round === DECODE_ROUNDS) break;
    let decoded: string;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      // A lone `%` (e.g. `?q=100%25` after one round) is not decodable any
      // further, so there is nothing more hiding behind it.
      break;
    }
    if (decoded === candidate) break;
    candidate = decoded;
  }

  // Belt and braces: let the URL parser have the final word on where this
  // actually goes. A parser quirk the shape check missed shows up here as a
  // changed origin.
  try {
    if (new URL(raw, PROBE_ORIGIN).origin !== PROBE_ORIGIN) return fallback;
  } catch {
    return fallback;
  }

  return raw;
}
