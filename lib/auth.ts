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
};

/**
 * The caller's own profile row, or null if they aren't signed in or have no
 * profile row at all.
 *
 * This is a Tier 1 read: the own-row branch of the `profiles` select policy
 * (`id = auth.uid()`) makes it work for agents and admins alike, so no service
 * role is involved. Note that branch is deliberately *not* gated on
 * `is_active` — which is what lets `requireUser()` below tell a deactivated
 * user why they're being turned away instead of showing them an empty app.
 */
export async function getCurrentProfile(): Promise<Profile | null> {
  const supabase = await createClient();

  const { data: claimsData, error: claimsError } =
    await supabase.auth.getClaims();
  const userId = claimsData?.claims?.sub;

  if (claimsError || !userId) {
    return null;
  }

  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, role, is_active, must_change_password")
    .eq("id", userId)
    .maybeSingle();

  if (error || !data) {
    // An auth.users row with no matching profiles row is the "ghost user"
    // state §8 of the master plan warns about. Return null rather than
    // throwing; callers decide how to handle it.
    return null;
  }

  return data as Profile;
}

/**
 * Signed-in, non-deactivated users only. Returns their profile.
 *
 * Three distinct failure cases, deliberately routed differently:
 *   - not signed in            -> /auth/login
 *   - signed in, no profile    -> /auth/error (redirecting to login would
 *                                 loop: they'd log in fine and bounce back)
 *   - signed in, deactivated   -> /auth/error, because RLS now returns zero
 *                                 rows for them and an unexplained empty app
 *                                 is a worse answer than being told why
 *
 * Wrapped in React's cache() so the (app) route-group layout and the page it
 * wraps share one lookup. Both need the profile — the layout for the sidebar's
 * identity and admin-only items, the page for its own role checks — and without
 * this that is two getClaims() calls plus two profiles selects on every single
 * page load. The memo is per-request, so it cannot leak one user's profile into
 * another's render.
 */
export const requireUser = cache(async function requireUser(): Promise<Profile> {
  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();

  if (!claimsData?.claims?.sub) {
    redirect("/auth/login");
  }

  const profile = await getCurrentProfile();

  if (!profile) {
    redirect("/auth/error?error=no-profile");
  }

  if (!profile.is_active) {
    redirect("/auth/error?error=account-deactivated");
  }

  return profile;
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
