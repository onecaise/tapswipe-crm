/**
 * Words shown about an account's state, kept in one place so the two surfaces
 * that report the same state cannot drift apart (D-01 / B1).
 *
 * A deactivated rep reaches one of two screens depending on timing: the
 * /auth/error page (signed in, profile inactive) or the login form (GoTrue's
 * ban already in place, so sign-in itself is refused). They used to read
 * "This account has been deactivated…" and GoTrue's raw "User is banned".
 */
export const ACCOUNT_DEACTIVATED = {
  title: "This account has been deactivated",
  /** The one sentence that is true on both screens. */
  remedy: "An admin can turn it back on.",
} as const;
