/**
 * Response headers on every route (security fix phase 3,
 * docs/claude/security-fixes.md). Applied by next.config.ts's headers().
 *
 * The finding: nothing set any of these, so every page could be framed by
 * any site -- clickjacking on /admin/users, pre-app approve, residual
 * commit. Nothing in the app is framed legitimately (no <iframe>, <embed> or
 * <object> anywhere; printing is window.print() on the top-level page; file
 * viewing opens a signed Storage URL in a new tab, on Supabase's origin,
 * which these headers do not govern), so framing is refused everywhere.
 *
 * The CSP is frame-ancestors ONLY. A script/style policy is a separate
 * piece of work (Next's inline bootstrap needs nonces under cacheComponents)
 * and must not ride along with this one.
 *
 * In lib/ rather than inline in next.config.ts so tests/unit can import it:
 * next.config.ts runs assertSupabaseEnv() at import. Imported there with a
 * relative path, like lib/env-guard.
 */
export const SECURITY_HEADERS: ReadonlyArray<{ key: string; value: string }> = [
  // Legacy, for browsers that predate CSP frame-ancestors. DENY, not
  // SAMEORIGIN: the app does not frame itself either.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
];
