/**
 * Shared by every component that opens a signed Storage URL in the browser:
 * the marketing library and the business document library. Moved here from
 * lib/documents.ts when the per-record documents path was removed (13 Oct
 * 2026), because it was never about documents -- it is about the signing
 * function's origin.
 */

/**
 * Re-points a signed Storage URL at the API origin this client can actually
 * reach.
 *
 * The Edge Function signs with its own `SUPABASE_URL`, and that is not always
 * the URL the browser knows the project by. On the local stack it is
 * `http://kong:8000` — the container-internal hostname — so every signed URL the
 * function hands back is unresolvable from the browser, and the download button
 * did nothing at all in development. It failed silently, because navigating to
 * an unresolvable host is not an error the page can catch.
 *
 * A no-op in production, where the two are the same string. Only the ORIGIN is
 * replaced: the path and the `token` query parameter are the signature and are
 * left untouched, and the token is not bound to a hostname — the live suite has
 * always had to do this same rewrite to fetch a signed URL from the test
 * process, which is what made it clear the browser needed it too.
 *
 * Returns the URL unchanged if either side won't parse, on the principle that a
 * URL that might work beats one this function decided to mangle.
 */
export function reachableStorageUrl(
  signedUrl: string,
  apiUrl: string | undefined,
): string {
  if (!apiUrl) return signedUrl;
  try {
    const signed = new URL(signedUrl);
    const target = new URL(apiUrl);
    if (signed.origin === target.origin) return signedUrl;
    signed.protocol = target.protocol;
    signed.host = target.host;
    return signed.toString();
  } catch {
    return signedUrl;
  }
}
