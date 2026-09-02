import { cache } from "react";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

export type Role = "agent" | "admin";

export type Profile = {
  id: string;
  full_name: string;
  role: Role;
  is_active: boolean;
  /**
   * Set when an admin issues a temporary password (create-user or
   * admin-reset-password) and cleared by the clear_must_change_password() RPC
   * once the rep sets their own. app/(app)/layout.tsx redirects to
   * /auth/update-password while it is true, which is what stops a password the
   * admin knows from staying usable.
   */
  must_change_password: boolean;
  /**
   * When this user last opened the notifications panel behind the topbar bell,
   * or null if they never have. Everything the bell reports is derived from
   * comparing it to created_at on support_tickets and ghost_sheets.
   *
   * Read it through notificationsFloor() in lib/notifications.ts rather than
   * directly -- null means "never opened", which has to fall back to the
   * profile's own creation date rather than to the beginning of time.
   *
   * Advanced only by the mark_notifications_viewed() RPC; profiles has no
   * update policy, so nothing else can write it.
   */
  last_viewed_notifications_at: string | null;
  /** Needed as the floor when last_viewed_notifications_at is null. */
  created_at: string | null;
};

/**
 * The columns getCurrentProfile() reads, as one exported string.
 *
 * Exported so tests/deployed/schema-drift.test.ts can probe the *real* query
 * against each deployed project rather than a copy of it that would quietly
 * fall out of step. That test exists because this select is what broke
 * production on 2026-09-02: it named last_viewed_notifications_at while the
 * deployed schema had not been migrated to have it, and every signed-in user
 * was turned away. Any column added here is automatically covered from then on.
 */
export const PROFILE_SELECT =
  "id, full_name, role, is_active, must_change_password, last_viewed_notifications_at, created_at";
/**
 * Why this returns a tagged result rather than `Profile | null`.
 *
 * It used to return null for three different things: no session, no profiles
 * row, and "the query failed". requireUser() mapped the last two onto the same
 * /auth/error?error=no-profile, and on 2026-09-02 that cost a production
 * outage — a migration adding profiles.last_viewed_notifications_at had not
 * been pushed, so the select 400'd with `column ... does not exist`, and every
 * signed-in user was told they had no profile while their row sat right there.
 * The error page named the one cause that was not the problem.
 *
 * A failed read is not evidence that a row is absent, so it no longer claims to
 * be. Each state below is a different thing to go and fix.
 */
export type ProfileLookup =
  /** Signed in, profile row read. */
  | { status: "ok"; profile: Profile }
  /** No usable session. */
  | { status: "anonymous" }
  /** Authenticated, but genuinely no profiles row — the ghost-user state. */
  | { status: "missing" }
  /**
   * The lookup itself failed. The row may well exist and be perfectly fine;
   * what is broken is our ability to read it. Carries the message, because the
   * cause is usually in it verbatim.
   */
  | { status: "unavailable"; message: string };

/**
 * The caller's own profile row, as one of the four states above.
 *
 * This is a Tier 1 read: the own-row branch of the `profiles` select policy
 * (`id = auth.uid()`) makes it work for agents and admins alike, so no service
 * role is involved. Note that branch is deliberately *not* gated on
 * `is_active` — which is what lets `requireUser()` below tell a deactivated
 * user why they're being turned away instead of showing them an empty app.
 */
export async function getCurrentProfile(): Promise<ProfileLookup> {
  const supabase = await createClient();

  const { data: claimsData, error: claimsError } =
    await supabase.auth.getClaims();
  const userId = claimsData?.claims?.sub;

  if (claimsError || !userId) {
    return { status: "anonymous" };
  }

  const { data, error } = await supabase
    .from("profiles")
    .select(PROFILE_SELECT)
    .eq("id", userId)
    .maybeSingle();

  // Checked before the row, and kept separate from it. A 400 here means the
  // query is wrong for this database — most often a column this build selects
  // that the deployed schema has not been migrated to yet — and reporting that
  // as an absent profile sends whoever is debugging it to auth.users, which is
  // the one place the answer is not.
  if (error) {
    return { status: "unavailable", message: error.message };
  }

  if (!data) {
    // An auth.users row with no matching profiles row is the "ghost user"
    // state §8 of the master plan warns about. Callers decide how to handle it;
    // nothing here throws.
    return { status: "missing" };
  }

  return { status: "ok", profile: data as Profile };
}

/**
 * Signed-in, non-deactivated users only. Returns their profile.
 *
 * Four distinct failure cases, deliberately routed differently:
 *   - not signed in            -> /auth/login
 *   - signed in, no profile    -> /auth/error?error=no-profile (redirecting to
 *                                 login would loop: they'd log in fine and
 *                                 bounce right back here)
 *   - profile unreadable       -> /auth/error?error=profile-unavailable, which
 *                                 is NOT the same answer as having no profile.
 *                                 See ProfileLookup above for what conflating
 *                                 the two cost.
 *   - signed in, deactivated   -> /auth/error?error=account-deactivated,
 *                                 because RLS now returns zero rows for them
 *                                 and an unexplained empty app is a worse
 *                                 answer than being told why
 *
 * The session check is getCurrentProfile's, not a second one here: it already
 * calls getClaims() and applies the identical test, so doing it again first
 * only meant every page load paid for two.
 *
 * Wrapped in React's cache() so the (app) route-group layout and the page it
 * wraps share one lookup. Both need the profile — the layout for the sidebar's
 * identity and admin-only items, the page for its own role checks — and without
 * this that is two getClaims() calls plus two profiles selects on every single
 * page load. The memo is per-request, so it cannot leak one user's profile into
 * another's render.
 */
export const requireUser = cache(async function requireUser(): Promise<Profile> {
  const lookup = await getCurrentProfile();

  if (lookup.status === "anonymous") {
    redirect("/auth/login");
  }

  if (lookup.status === "missing") {
    redirect("/auth/error?error=no-profile");
  }

  if (lookup.status === "unavailable") {
    // The message is deliberately not put in the URL: it is a database error
    // string on a page shown to whoever just failed to get in. It goes to the
    // server log, where the person who needs it is actually looking.
    console.error(
      `[requireUser] profile lookup failed, not an absent profile: ${lookup.message}`,
    );
    redirect("/auth/error?error=profile-unavailable");
  }

  if (!lookup.profile.is_active) {
    redirect("/auth/error?error=account-deactivated");
  }

  return lookup.profile;
});

/**
 * Active admins only. Sends everyone else to the dashboard.
 *
 * This is the application-level boundary. It is not the only one: even without
 * it, RLS would still return only the caller's own row from `profiles`. Both
 * layers are tested independently (see tests/rls/manage-users.test.ts).
 */
export async function requireAdmin(): Promise<Profile> {
  const profile = await requireUser();

  if (profile.role !== "admin") {
    redirect("/dashboard");
  }

  return profile;
}
