import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Profile } from "@/lib/auth";

/**
 * The page-level boundary, tested in isolation from the database.
 *
 * This is the half that genuinely *rejects* a non-admin, as opposed to RLS,
 * which filters (see tests/rls/manage-users.test.ts). Together they're the two
 * independent layers guarding /admin/users; either one alone would keep another
 * user's profile data out of an agent's hands.
 *
 * The Supabase client is stubbed rather than run for real, because what's under
 * test here is the branching in lib/auth.ts — which of the three failure cases
 * routes where — not query behavior.
 */

// Stand in for Next's redirect(), which throws to unwind rendering.
class RedirectError extends Error {
  constructor(public url: string) {
    super(`NEXT_REDIRECT:${url}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectError(url);
  },
}));

/** Mutable fixture state, set per test before calling into lib/auth. */
let claimsSub: string | null = null;
let profileRow: Profile | null = null;
let profileError: { message: string } | null = null;

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getClaims: async () => ({
        data: claimsSub ? { claims: { sub: claimsSub } } : null,
        error: null,
      }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: profileRow, error: profileError }),
        }),
      }),
    }),
  }),
}));

const { getCurrentProfile, requireAdmin, requireUser } = await import(
  "@/lib/auth"
);

const ADMIN: Profile = {
  id: "11111111-1111-1111-1111-111111111111",
  full_name: "Admin User",
  role: "admin",
  is_active: true,
  must_change_password: false,
  // Both added with the notifications watermark (20260821154500). null here
  // means "has never opened the panel", which is the state these redirect
  // tests care nothing about — they assert routing, not the bell.
  last_viewed_notifications_at: null,
  created_at: "2026-08-01T00:00:00Z",
};

const AGENT: Profile = {
  id: "22222222-2222-2222-2222-222222222222",
  full_name: "Agent User",
  role: "agent",
  is_active: true,
  must_change_password: false,
  last_viewed_notifications_at: null,
  created_at: "2026-08-01T00:00:00Z",
};

async function expectRedirect(fn: () => Promise<unknown>, url: string) {
  await expect(fn()).rejects.toThrow(RedirectError);
  await fn().catch((e: unknown) => {
    expect((e as RedirectError).url).toBe(url);
  });
}

beforeEach(() => {
  claimsSub = null;
  profileRow = null;
  profileError = null;
});

describe("getCurrentProfile", () => {
  it("reports anonymous when there is no session", async () => {
    expect(await getCurrentProfile()).toEqual({ status: "anonymous" });
  });

  it("reports missing for a signed-in user with no profile row", async () => {
    claimsSub = AGENT.id;
    profileRow = null;

    // The ghost-user state: an auth.users row with no profiles row.
    expect(await getCurrentProfile()).toEqual({ status: "missing" });
  });

  it("reports unavailable — not missing — when the query itself fails", async () => {
    claimsSub = AGENT.id;
    profileRow = null;
    profileError = {
      message: "column profiles.last_viewed_notifications_at does not exist",
    };

    // The exact shape of the 2026-09-02 outage: the row existed, the select
    // named a column the deployed schema had not been migrated to, and the old
    // code reported it as an absent profile. `missing` here would be a lie,
    // and it is a lie that sends whoever is debugging to the wrong database.
    expect(await getCurrentProfile()).toEqual({
      status: "unavailable",
      message: "column profiles.last_viewed_notifications_at does not exist",
    });
  });

  it("returns the profile for a signed-in user", async () => {
    claimsSub = AGENT.id;
    profileRow = AGENT;

    expect(await getCurrentProfile()).toEqual({
      status: "ok",
      profile: AGENT,
    });
  });
});

describe("requireUser", () => {
  it("redirects an anonymous caller to login", async () => {
    await expectRedirect(requireUser, "/auth/login");
  });

  it("redirects a ghost user to the error page, not back to login", async () => {
    claimsSub = AGENT.id;
    profileRow = null;

    // Sending them to /auth/login would loop: they're already authenticated, so
    // logging in again succeeds and lands them right back here.
    await expectRedirect(requireUser, "/auth/error?error=no-profile");
  });

  it("routes an unreadable profile somewhere else entirely", async () => {
    claimsSub = AGENT.id;
    profileRow = null;
    profileError = { message: "column profiles.nope does not exist" };

    // The distinction this whole pair exists for. Both users are signed in and
    // neither gets a profile back, but only one of them actually lacks a row —
    // and only one of them is fixed by an admin creating an account. Sending
    // both to no-profile is what made the 2026-09-02 outage read as an
    // account-provisioning problem for as long as it did.
    await expectRedirect(requireUser, "/auth/error?error=profile-unavailable");
  });

  it("redirects a deactivated user to the error page", async () => {
    claimsSub = AGENT.id;
    profileRow = { ...AGENT, is_active: false };

    await expectRedirect(
      requireUser,
      "/auth/error?error=account-deactivated",
    );
  });

  it("returns an active agent's profile", async () => {
    claimsSub = AGENT.id;
    profileRow = AGENT;

    expect(await requireUser()).toEqual(AGENT);
  });
});

describe("requireAdmin", () => {
  it("rejects an agent by redirecting to the dashboard", async () => {
    claimsSub = AGENT.id;
    profileRow = AGENT;

    // This is the "Manage Users is rejected for a non-admin" case.
    await expectRedirect(requireAdmin, "/dashboard");
  });

  it("rejects a deactivated admin", async () => {
    claimsSub = ADMIN.id;
    profileRow = { ...ADMIN, is_active: false };

    // Caught by requireUser before the role check — a deactivated admin is not
    // an admin, matching is_admin()'s own `and is_active` clause.
    await expectRedirect(
      requireAdmin,
      "/auth/error?error=account-deactivated",
    );
  });

  it("rejects an anonymous caller", async () => {
    await expectRedirect(requireAdmin, "/auth/login");
  });

  it("allows an active admin", async () => {
    claimsSub = ADMIN.id;
    profileRow = ADMIN;

    expect(await requireAdmin()).toEqual(ADMIN);
  });
});
