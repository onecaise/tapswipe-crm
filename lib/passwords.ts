/**
 * The one password rule this app has, in the one place the browser reads it.
 *
 * Six is GoTrue's floor, not a number invented here: supabase/config.toml sets
 * `[auth].minimum_password_length = 6` for the local stack, and the hosted
 * projects carry the same setting on their own surface. Anything shorter is
 * refused by the Auth server whatever the UI thinks, so validating it here is
 * about saying so before the round trip rather than about being the authority.
 *
 * Two write paths reach a password and both use this:
 *   - components/update-password-form.tsx — a rep choosing their own.
 *   - components/new-user-form.tsx — an admin setting a new account's first one.
 *
 * DUPLICATED, deliberately, in supabase/functions/_shared/admin-users.ts, which
 * is where create-user enforces the same rule server-side. The Deno functions
 * cannot import from lib/ (no import-map specifier reaches above
 * supabase/functions/, the same wall lib/pre-app-validation.ts and
 * lib/user-imports.ts both sit behind), so the copy is pinned by a test instead:
 * tests/unit/password-rules.test.ts imports both and asserts they agree. Change
 * the two together.
 */
export const MIN_PASSWORD_LENGTH = 6;

/**
 * Whether a password is long enough to be worth sending.
 *
 * Length is measured on the raw string with no trimming — a leading or trailing
 * space is a legitimate character in a password, and silently dropping it here
 * would set an account's password to something other than what was typed.
 */
export function isAcceptablePassword(value: unknown): value is string {
  return typeof value === "string" && value.length >= MIN_PASSWORD_LENGTH;
}
