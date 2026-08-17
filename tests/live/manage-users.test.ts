// The three admin Edge Functions, against a real running stack.
//
// These belong here rather than in tests/rls for reasons PGlite cannot work
// around: the functions are Deno, they authenticate the JWT themselves, they
// reach the database through PostgREST, and — the point of the whole suite — the
// deactivation test needs GoTrue to actually refuse a password sign-in. None of
// that exists in an in-process Postgres.
//
// Two assertions matter most, and they are the two the rest of the app cannot
// make on its own:
//
//   1. A non-admin calling any of the three directly is rejected. The UI hides
//      these controls, but hiding is not a boundary — anyone with a session can
//      POST to a function URL.
//   2. A deactivated rep cannot log in *even with the correct password*. That is
//      the difference between deactivation and a UI flag, and it is invisible to
//      any test that only checks profiles.is_active.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PASSWORD,
  PERSONA_EMAILS,
  adminClient,
  anonClient,
  deleteUserCompletely,
  functionsAreServed,
  invoke,
  provisionFixtures,
  warmFunctions,
  teardownFixtures,
  type Fixtures,
} from "./helpers/stack";

const FUNCTIONS = [
  "create-user",
  "deactivate-user",
  "admin-reset-password",
] as const;

/** A syntactically valid body per function, so a 403 is never a 400 in disguise. */
const VALID_BODY: Record<(typeof FUNCTIONS)[number], Record<string, unknown>> =
  {
    "create-user": {
      full_name: "Should Not Exist",
      email: "live-should-not-exist@tapswipe.test",
      role: "agent",
    },
    "deactivate-user": {
      user_id: "00000000-0000-4000-8000-000000000000",
      is_active: false,
    },
    "admin-reset-password": {
      user_id: "00000000-0000-4000-8000-000000000000",
    },
  };

let fixtures: Fixtures;

/** Ad-hoc accounts created by these tests, cleaned up in afterAll. */
const createdUserIds: string[] = [];

beforeAll(async () => {
  if (!(await functionsAreServed())) {
    throw new Error(
      "The local functions runtime is not answering. Run `supabase start` and " +
        "`supabase functions serve` before this suite. (Hard error rather than " +
        "skip: a suite that silently passes because every request failed to " +
        "connect is the false negative these tests exist to prevent.)",
    );
  }
  // Before any assertion about status codes — see warmFunctions. The first
  // invocation of a function makes the runtime restart, which 502s whatever is
  // in flight and would read as "the function returns 502 instead of 403".
  await warmFunctions(FUNCTIONS);
  fixtures = await provisionFixtures();
});

afterAll(async () => {
  for (const id of createdUserIds) {
    await deleteUserCompletely(id);
  }
  await teardownFixtures();
});

describe("every admin function rejects a caller who is not an active admin", () => {
  for (const name of FUNCTIONS) {
    it(`${name} rejects an agent's token with 403`, async () => {
      const response = await invoke(
        name,
        VALID_BODY[name],
        fixtures.tokens.owner,
      );

      expect(response.status, response.raw).toBe(403);
      expect(String(response.body.error)).toMatch(/admin/i);
    });

    it(`${name} rejects a deactivated agent's token with 403`, async () => {
      // A different rejection from the one above, and worth its own assertion:
      // this token is valid and its account exists, it is simply switched off.
      const response = await invoke(
        name,
        VALID_BODY[name],
        fixtures.tokens.deactivated,
      );

      expect(response.status, response.raw).toBe(403);
      expect(String(response.body.error)).toMatch(/not active/i);
    });

    it(`${name} rejects an unauthenticated caller with 401`, async () => {
      const response = await invoke(name, VALID_BODY[name]);

      expect(response.status, response.raw).toBe(401);
    });

    it(`${name} left nothing behind after refusing`, async () => {
      // The rejection has to happen *before* any privileged work. If a function
      // checked authorization after calling supabaseAdmin, the tests above would
      // still see a 403 while the side effect had already landed.
      const admin = adminClient();
      const { data } = await admin
        .from("audit_log")
        .select("id")
        .eq("row_id", "00000000-0000-4000-8000-000000000000");
      expect(data ?? []).toEqual([]);

      const { data: users } = await admin.auth.admin.listUsers({
        perPage: 1000,
      });
      expect(
        (users?.users ?? []).some(
          (user) => user.email === "live-should-not-exist@tapswipe.test",
        ),
      ).toBe(false);
    });
  }
});

describe("a deactivated user cannot log in, even with the right password", () => {
  it("refuses the correct password once deactivated, and accepts it again after", async () => {
    const email = PERSONA_EMAILS.owner;
    const signIn = () =>
      anonClient().auth.signInWithPassword({ email, password: PASSWORD });

    // 1. Baseline. Without this the later failure could be a wrong password, a
    //    wrong email, or a broken fixture — and the test would "pass" for a
    //    reason that has nothing to do with deactivation.
    const before = await signIn();
    expect(before.error, "the correct password should work to begin with").toBe(
      null,
    );
    expect(before.data.session).not.toBeNull();

    // 2. Deactivate through the function, not by writing is_active directly.
    //    Setting the flag alone would leave login working, which is the whole
    //    gap this function exists to close.
    const off = await invoke(
      "deactivate-user",
      { user_id: fixtures.userIds.owner, is_active: false },
      fixtures.tokens.admin,
    );
    expect(off.status, off.raw).toBe(200);

    // 3. The assertion. Same email, same correct password, now refused by
    //    GoTrue — not by RLS, not by the UI.
    const during = await signIn();
    expect(
      during.error,
      "a deactivated user must not be able to sign in",
    ).not.toBeNull();
    expect(during.data.session).toBeNull();

    // 4. And back. This is what proves step 3 was the ban rather than something
    //    that had broken the account permanently.
    const on = await invoke(
      "deactivate-user",
      { user_id: fixtures.userIds.owner, is_active: true },
      fixtures.tokens.admin,
    );
    expect(on.status, on.raw).toBe(200);

    const after = await signIn();
    expect(after.error, "reactivation should restore sign-in").toBe(null);
    expect(after.data.session).not.toBeNull();
  });

  it("sets and clears profiles.is_active alongside the ban", async () => {
    const admin = adminClient();
    const readFlag = async () => {
      const { data } = await admin
        .from("profiles")
        .select("is_active")
        .eq("id", fixtures.userIds.intruder)
        .single();
      return data?.is_active;
    };

    await invoke(
      "deactivate-user",
      { user_id: fixtures.userIds.intruder, is_active: false },
      fixtures.tokens.admin,
    );
    expect(await readFlag()).toBe(false);

    await invoke(
      "deactivate-user",
      { user_id: fixtures.userIds.intruder, is_active: true },
      fixtures.tokens.admin,
    );
    expect(await readFlag()).toBe(true);
  });

  it("refuses to deactivate the caller's own account", async () => {
    const response = await invoke(
      "deactivate-user",
      { user_id: fixtures.userIds.admin, is_active: false },
      fixtures.tokens.admin,
    );

    expect(response.status, response.raw).toBe(409);
    // The guard that keeps "zero active admins" unreachable.
    expect(String(response.body.error)).toMatch(/your own account/i);
  });

  it("404s on a user that does not exist", async () => {
    const response = await invoke(
      "deactivate-user",
      { user_id: "00000000-0000-4000-8000-000000000000", is_active: false },
      fixtures.tokens.admin,
    );

    expect(response.status, response.raw).toBe(404);
  });
});

describe("create-user", () => {
  const email = "live-created-rep@tapswipe.test";

  it("creates an account whose temporary password actually works", async () => {
    const response = await invoke(
      "create-user",
      { full_name: "Live Created Rep", email, role: "agent" },
      fixtures.tokens.admin,
    );

    expect(response.status, response.raw).toBe(201);

    const userId = String(response.body.user_id);
    const temporaryPassword = String(response.body.temporary_password);
    createdUserIds.push(userId);

    expect(temporaryPassword.length).toBeGreaterThanOrEqual(16);

    // The profile row is what makes the account usable at all — an auth user
    // without one lands on /auth/error?error=no-profile forever.
    const admin = adminClient();
    const { data: profile } = await admin
      .from("profiles")
      .select("full_name, role, is_active, must_change_password")
      .eq("id", userId)
      .single();

    expect(profile).toMatchObject({
      full_name: "Live Created Rep",
      role: "agent",
      is_active: true,
      // Set so the (app) layout diverts them until they choose their own.
      must_change_password: true,
    });

    // The end-to-end point of the whole function: the generated credential
    // signs in. Asserting only the 201 would not catch a password that was
    // returned but never actually set on the account.
    const signIn = await anonClient().auth.signInWithPassword({
      email,
      password: temporaryPassword,
    });
    expect(signIn.error, "the temporary password should sign in").toBe(null);

    const { data: audit } = await admin
      .from("audit_log")
      .select("actor_id, action, table_name, row_id")
      .eq("row_id", userId);
    expect(audit).toEqual([
      {
        actor_id: fixtures.userIds.admin,
        action: "create_user",
        table_name: "profiles",
        row_id: userId,
      },
    ]);
  });

  it("rejects a duplicate email with 409 and creates nothing", async () => {
    const admin = adminClient();
    const countUsers = async () => {
      const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
      return (data?.users ?? []).filter((user) => user.email === email).length;
    };

    expect(await countUsers()).toBe(1);

    const response = await invoke(
      "create-user",
      { full_name: "Duplicate Rep", email, role: "agent" },
      fixtures.tokens.admin,
    );

    expect(response.status, response.raw).toBe(409);
    // No second auth user, and no orphan: a failed create must leave nothing.
    expect(await countUsers()).toBe(1);
  });

  it("validates the body before touching anything", async () => {
    for (const body of [
      { full_name: "", email: "a@b.co", role: "agent" },
      { full_name: "No Email", email: "not-an-email", role: "agent" },
      { full_name: "Bad Role", email: "live-bad-role@tapswipe.test", role: "superuser" },
      {
        full_name: "Long Number",
        email: "live-long-number@tapswipe.test",
        role: "agent",
        agent_number: "x".repeat(33),
      },
    ]) {
      const response = await invoke("create-user", body, fixtures.tokens.admin);
      expect(response.status, response.raw).toBe(400);
    }
  });

  it("records an agent number, and refuses one already taken", async () => {
    const numbered = "live-agent-number@tapswipe.test";
    const clashing = "live-agent-number-clash@tapswipe.test";

    const created = await invoke(
      "create-user",
      {
        full_name: "Live Numbered Rep",
        email: numbered,
        role: "agent",
        // Deliberately not one of PERSONA_AGENT_NUMBERS. The personas now hold
        // LIVE-4471 and LIVE-9902 so the residual suite can name them in an import
        // file, and reusing one here made this test collide with the fixture — the
        // 409 fired for the right reason on the wrong row.
        agent_number: "LIVE-CU-0042",
      },
      fixtures.tokens.admin,
    );
    expect(created.status, created.raw).toBe(201);

    const userId = String(created.body.user_id);
    createdUserIds.push(userId);

    const admin = adminClient();
    const { data: profile } = await admin
      .from("profiles")
      .select("agent_number")
      .eq("id", userId)
      .single();
    expect(profile?.agent_number).toBe("LIVE-CU-0042");

    // The 409 must land BEFORE createUser. If it did not, the unique index would
    // catch the duplicate on the profiles insert instead — after the auth.users
    // row exists — sending a fixable mistake down the rollback path and
    // reporting it as "Could not create the profile: duplicate key value…".
    const duplicate = await invoke(
      "create-user",
      {
        full_name: "Live Clashing Rep",
        email: clashing,
        role: "agent",
        // Deliberately not one of PERSONA_AGENT_NUMBERS. The personas now hold
        // LIVE-4471 and LIVE-9902 so the residual suite can name them in an import
        // file, and reusing one here made this test collide with the fixture — the
        // 409 fired for the right reason on the wrong row.
        agent_number: "LIVE-CU-0042",
      },
      fixtures.tokens.admin,
    );

    expect(duplicate.status, duplicate.raw).toBe(409);
    expect(String(duplicate.body.error)).toMatch(/already assigned/i);

    // And nothing was left behind: no auth user for the rejected email at all,
    // which is what distinguishes "refused early" from "refused and rolled back".
    const { data: users } = await admin.auth.admin.listUsers({ perPage: 1000 });
    expect(
      (users?.users ?? []).some((user) => user.email === clashing),
    ).toBe(false);
  });

  it("stores null rather than '' for a blank agent number", async () => {
    // Two reps created with a blank field must not collide. They would if '' were
    // stored, because the partial unique index treats '' as an ordinary value —
    // so the second create would fail on a constraint nobody typed into.
    const ids: string[] = [];

    for (const email of [
      "live-blank-number-a@tapswipe.test",
      "live-blank-number-b@tapswipe.test",
    ]) {
      const response = await invoke(
        "create-user",
        { full_name: "Live Blank Number", email, role: "agent", agent_number: "   " },
        fixtures.tokens.admin,
      );
      expect(response.status, response.raw).toBe(201);

      const id = String(response.body.user_id);
      ids.push(id);
      createdUserIds.push(id);
    }

    const { data } = await adminClient()
      .from("profiles")
      .select("agent_number")
      .in("id", ids);

    expect(data ?? []).toHaveLength(2);
    expect(
      (data ?? []).every((row) => row.agent_number === null),
      "a blank agent number must be stored as null",
    ).toBe(true);
  });
});

describe("admin-reset-password", () => {
  it("replaces the password and forces another change", async () => {
    const email = "live-reset-rep@tapswipe.test";

    const created = await invoke(
      "create-user",
      { full_name: "Live Reset Rep", email, role: "agent" },
      fixtures.tokens.admin,
    );
    expect(created.status, created.raw).toBe(201);
    const userId = String(created.body.user_id);
    const firstPassword = String(created.body.temporary_password);
    createdUserIds.push(userId);

    // The rep sets their own, which clears the forced-change flag the way the
    // update-password form does.
    const admin = adminClient();
    await admin.auth.admin.updateUserById(userId, {
      password: "rep-chosen-password-456",
    });
    await admin
      .from("profiles")
      .update({ must_change_password: false })
      .eq("id", userId);

    const response = await invoke(
      "admin-reset-password",
      { user_id: userId },
      fixtures.tokens.admin,
    );
    expect(response.status, response.raw).toBe(200);
    const newPassword = String(response.body.temporary_password);

    // A fresh password, not the one from creation and not the rep's own.
    expect(newPassword).not.toBe(firstPassword);
    expect(newPassword).not.toBe("rep-chosen-password-456");

    // The rep's chosen password no longer works — the reset genuinely replaced
    // it rather than adding an alternative.
    const withOld = await anonClient().auth.signInWithPassword({
      email,
      password: "rep-chosen-password-456",
    });
    expect(withOld.error).not.toBeNull();

    const withNew = await anonClient().auth.signInWithPassword({
      email,
      password: newPassword,
    });
    expect(withNew.error, "the new temporary password should sign in").toBe(
      null,
    );

    // And they are prompted again, so an admin-known password cannot persist.
    const { data: profile } = await admin
      .from("profiles")
      .select("must_change_password")
      .eq("id", userId)
      .single();
    expect(profile?.must_change_password).toBe(true);

    const { data: audit } = await admin
      .from("audit_log")
      .select("action")
      .eq("row_id", userId)
      .order("id", { ascending: true });
    expect((audit ?? []).map((row) => row.action)).toEqual([
      "create_user",
      "admin_reset_password",
    ]);
  });
});

describe("set_user_role through PostgREST", () => {
  // The RPC's logic is covered exhaustively in tests/rls/set-user-role.test.ts.
  // What only this suite can prove is that it is reachable over the Data API with
  // a real JWT and that `authenticated` actually holds EXECUTE on it — a missing
  // grant is invisible below PostgREST.
  it("lets an admin promote and demote over HTTP", async () => {
    const { userClient } = await import("./helpers/stack");
    const asAdmin = userClient(fixtures.tokens.admin);

    const promote = await asAdmin.rpc("set_user_role", {
      target_user_id: fixtures.userIds.intruder,
      new_role: "admin",
    });
    expect(promote.error).toBeNull();

    const demote = await asAdmin.rpc("set_user_role", {
      target_user_id: fixtures.userIds.intruder,
      new_role: "agent",
    });
    expect(demote.error).toBeNull();
  });

  it("refuses an agent over HTTP", async () => {
    const { userClient } = await import("./helpers/stack");
    const asAgent = userClient(fixtures.tokens.owner);

    const { error } = await asAgent.rpc("set_user_role", {
      target_user_id: fixtures.userIds.intruder,
      new_role: "admin",
    });

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/admin only/i);
  });
});

describe("set_agent_number through PostgREST", () => {
  // Same division of labour as set_user_role above: the guards are covered
  // exhaustively in tests/rls/set-agent-number.test.ts, and what only this suite
  // can prove is that the RPC is reachable over the Data API with a real JWT and
  // that `authenticated` actually holds EXECUTE on it. A missing grant is
  // invisible below PostgREST — which is exactly how this repo once shipped with
  // no Data API grants at all.
  it("lets an admin set and clear a number over HTTP", async () => {
    const { userClient } = await import("./helpers/stack");
    const asAdmin = userClient(fixtures.tokens.admin);
    const admin = adminClient();

    const readNumber = async () => {
      const { data } = await admin
        .from("profiles")
        .select("agent_number")
        .eq("id", fixtures.userIds.intruder)
        .single();
      return data?.agent_number ?? null;
    };

    const set = await asAdmin.rpc("set_agent_number", {
      target_user_id: fixtures.userIds.intruder,
      new_agent_number: "LIVE-9902",
    });
    expect(set.error).toBeNull();
    expect(await readNumber()).toBe("LIVE-9902");

    // Blank clears, and stores null rather than '' — the same normalisation
    // create-user applies, asserted here against the RPC's own copy of it.
    const cleared = await asAdmin.rpc("set_agent_number", {
      target_user_id: fixtures.userIds.intruder,
      new_agent_number: "",
    });
    expect(cleared.error).toBeNull();
    expect(await readNumber()).toBeNull();
  });

  it("refuses an agent over HTTP", async () => {
    const { userClient } = await import("./helpers/stack");
    const asAgent = userClient(fixtures.tokens.owner);

    const { error } = await asAgent.rpc("set_agent_number", {
      target_user_id: fixtures.userIds.intruder,
      new_agent_number: "LIVE-0001",
    });

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/admin only/i);
  });
});
