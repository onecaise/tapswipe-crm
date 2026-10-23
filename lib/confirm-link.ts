import { safeNextPath } from "@/lib/safe-redirect";

/**
 * The rules for an email link to `/auth/confirm` (phase 7, login CSRF).
 *
 * A `token_hash` signs in whoever presents it, in whatever browser presents it:
 * unlike a PKCE `code`, it needs no verifier from the browser that asked for
 * the email. So a rep could take the token out of their OWN email, send an
 * admin `/auth/confirm?token_hash=…`, and the old GET handler signed the admin
 * in as the rep without a click. Two rules here close it, with the Continue
 * page and its Server Action (`app/auth/confirm/continue/`):
 *
 * - **Only the types the app sends.** The one email the app itself asks for is
 *   a password reset (`resetPasswordForEmail` in forgot-password-form.tsx).
 *   Sign-up is off, nothing sends invites or magic links, and there is no
 *   email-change screen. A magic link is still something anyone can request
 *   for their own address straight from GoTrue's public API, which is exactly
 *   the attack, so it is refused here rather than "supported but unused".
 * - **The GET never verifies.** It only checks the link's shape and hands it to
 *   a page whose button POSTs; see the route for why that matters.
 *
 * Pure, so the route, the page, the action and `tests/unit/confirm-link.test.ts`
 * share one copy.
 */

export const CONFIRM_LINK_TYPES = ["recovery"] as const;
export type ConfirmLinkType = (typeof CONFIRM_LINK_TYPES)[number];

/** Where each type goes when the link names no (safe) `next`. */
const DEFAULT_NEXT: Record<ConfirmLinkType, string> = {
  recovery: "/auth/update-password",
};

/** The words on the Continue page, per type. */
export const CONFIRM_LINK_COPY: Record<
  ConfirmLinkType,
  { title: string; detail: string; button: string }
> = {
  recovery: {
    title: "Reset your password",
    detail:
      "Continue to choose a new password for the account this link was sent to.",
    button: "Continue",
  },
};

export type ConfirmLink = {
  tokenHash: string;
  type: ConfirmLinkType;
  next: string;
};

/** The `/auth/error` codes a bad link is sent to. */
export type ConfirmLinkError = "link-incomplete" | "link-unsupported";

export type ParsedConfirmLink =
  | { ok: true; link: ConfirmLink }
  | { ok: false; error: ConfirmLinkError };

function isConfirmLinkType(value: string): value is ConfirmLinkType {
  return (CONFIRM_LINK_TYPES as readonly string[]).includes(value);
}

/** Read from a URL's query or a form, whichever arrives. */
type Source = { get(name: string): unknown };

function text(source: Source, name: string): string | null {
  const value = source.get(name);
  return typeof value === "string" && value !== "" ? value : null;
}

export function parseConfirmLink(source: Source): ParsedConfirmLink {
  const tokenHash = text(source, "token_hash");
  const type = text(source, "type");
  if (!tokenHash || !type) return { ok: false, error: "link-incomplete" };
  if (!isConfirmLinkType(type)) return { ok: false, error: "link-unsupported" };
  return {
    ok: true,
    link: {
      tokenHash,
      type,
      // Followed after the token verifies, so it must be a path on this site
      // (QA-001).
      next: safeNextPath(text(source, "next"), DEFAULT_NEXT[type]),
    },
  };
}

/** The Continue page's URL for a link that parsed. */
export function continueUrl(link: ConfirmLink): string {
  const query = new URLSearchParams({
    token_hash: link.tokenHash,
    type: link.type,
    next: link.next,
  });
  return `/auth/confirm/continue?${query.toString()}`;
}
