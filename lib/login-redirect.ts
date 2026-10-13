import { safeNextPath } from "@/lib/safe-redirect";

/**
 * Return-to-page-after-login (D-03 / C1a), as two pure functions so each end
 * can be tested against QA-001's bypass table without a browser.
 *
 * The proxy puts a signed-out user's deep link into `/auth/login?next=`, and
 * the login form follows it after sign-in. BOTH ends go through safeNextPath():
 * the proxy because a request path can itself be hostile (`http://host//evil`
 * has the pathname `//evil`), and the form because `?next=` on the login page
 * is whatever a link says, regardless of who built it.
 */

/** Where a sign-in lands when there is nothing (safe) to return to. */
export const POST_LOGIN_FALLBACK = "/dashboard";

/**
 * The `next` value the proxy should carry, or null for none. Drops Next's
 * internal `_rsc` cache-busting parameter, which rides on client-navigation
 * requests and is meaningless as a destination.
 */
export function nextFromDeepLink(pathname: string, search: string): string | null {
  const params = new URLSearchParams(search);
  params.delete("_rsc");
  const query = params.toString();
  const candidate = `${pathname}${query ? `?${query}` : ""}`;
  const safe = safeNextPath(candidate, POST_LOGIN_FALLBACK);
  return safe === POST_LOGIN_FALLBACK ? null : safe;
}

/** Where the login form goes after a successful sign-in, from its own search. */
export function postLoginPath(search: string): string {
  return safeNextPath(new URLSearchParams(search).get("next"), POST_LOGIN_FALLBACK);
}
