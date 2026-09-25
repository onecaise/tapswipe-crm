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

/**
 * The password these tests set on the accounts they create.
 *
 * create-user takes the admin's chosen password now rather than generating one,
 * so every body below has to carry one — and a body missing it is a 400, which
 * is exactly the "403 is really a 400 in disguise" failure VALID_BODY exists to
 * rule out. Deliberately not the fixtures' PASSWORD: these are different
 * accounts, and reusing it would let a sign-in assertion pass against the wrong
 * one.
 */
const CHOSEN_PASSWORD = "live-chosen-password-456";

/** A syntactically valid body per function, so a 403 is never a 400 in disguise. */
const VALID_BODY: Record<(typeof FUNCTIONS)[number], Record<string, unknown>> =
  {
    "create-user": {
      full_name: "Should Not Exist",
      email: "live-should-not-exist@tapswipe.test",
      role: "agent",
      password: CHOSEN_PASSWORD,
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

  it("creates an account whose password is the one the admin chose", async () => {
    const response = await invoke(
      "create-user",
      {
        full_name: "Live Created Rep",
        email,
        role: "agent",
        password: CHOSEN_PASSWORD,
      },
      fixtures.tokens.admin,
    );

    expect(response.status, response.raw).toBe(201);

    const userId = String(response.body.user_id);
    const temporaryPassword = String(response.body.temporary_password);
    createdUserIds.push(userId);

    // Echoed back unchanged. The response used to carry a generated password,
    // and asserting only its length would not notice the function quietly
    // ignoring the chosen one and setting something else — which is precisely
    // the failure that would leave an admin reading out a password that does
    // not work.
    expect(temporaryPassword).toBe(CHOSEN_PASSWORD);

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

    // The end-to-end point of the whole function: the credential signs in.
    // Asserting only the 201 would not catch a password that was returned but
    // never actually set on the account. Sent as the literal the admin typed
    // rather than as the echoed value, so a function that echoed the body back
    // while setting something else cannot pass this pair.
    const signIn = await anonClient().auth.signInWithPassword({
      email,
      password: CHOSEN_PASSWORD,
    });
    expect(signIn.error, "the chosen password should sign in").toBe(null);

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
      {
        full_name: "Duplicate Rep",
        email,
        role: "agent",
        password: CHOSEN_PASSWORD,
      },
      fixtures.tokens.admin,
    );

    expect(response.status, response.raw).toBe(409);
    // No second auth user, and no orphan: a failed create must leave nothing.
    expect(await countUsers()).toBe(1);
  });

  it("resumes a half-created account instead of refusing the address", async () => {
    // The orphan this simulates is what a create-user call leaves behind when
    // the process dies between createUser and the profiles insert — a timeout,
    // a recycled isolate, a redeploy mid-request. The rollback in the function
    // cannot fire for that, because there is no longer anything running to fire
    // it, so the leftover is built here directly: an auth.users row with the
    // right address and deliberately no profiles row.
    const orphanEmail = "live-orphaned-rep@tapswipe.test";
    const admin = adminClient();

    const { data: orphan, error: orphanError } =
      await admin.auth.admin.createUser({
        email: orphanEmail,
        password: PASSWORD,
        email_confirm: true,
      });
    expect(orphanError, "could not stage the orphan").toBe(null);

    const orphanId = String(orphan!.user!.id);
    createdUserIds.push(orphanId);

    // The precondition, asserted rather than assumed: staging an orphan that
    // already had a profile would make the resume below pass for the wrong
    // reason.
    const { data: before } = await admin
      .from("profiles")
      .select("id")
      .eq("id", orphanId)
      .maybeSingle();
    expect(before, "the staged orphan must have no profile").toBe(null);

    const response = await invoke(
      "create-user",
      {
        full_name: "Live Orphaned Rep",
        email: orphanEmail,
        role: "agent",
        password: CHOSEN_PASSWORD,
      },
      fixtures.tokens.admin,
    );

    // 201, not 409. A 409 here is the bug: the address is taken by a row that
    // is not a usable account, and answering "already exists" leaves a login
    // that reaches /auth/error?error=no-profile with no way back — profiles has
    // no insert policy, so nothing in the app can repair it.
    expect(response.status, response.raw).toBe(201);
    expect(response.body.resumedOrphanedAuthUser).toBe(true);

    // Adopted, not replaced. A second auth.users row for the same person would
    // be its own problem: the access model depends on agent_id naming one human.
    expect(response.body.user_id).toBe(orphanId);

    const { data: profile } = await admin
      .from("profiles")
      .select("full_name, role, is_active, must_change_password, email")
      .eq("id", orphanId)
      .single();

    expect(profile).toMatchObject({
      full_name: "Live Orphaned Rep",
      role: "agent",
      is_active: true,
      must_change_password: true,
      email: orphanEmail,
    });

    // The returned password has to be live, and the point of resetting it is
    // that the interrupted attempt's password was generated in a process that
    // died before returning it — so nobody has ever seen it, and reusing it
    // would make the response a lie.
    const temporaryPassword = String(response.body.temporary_password);
    const signIn = await anonClient().auth.signInWithPassword({
      email: orphanEmail,
      password: temporaryPassword,
    });
    expect(signIn.error, "the returned password should sign in").toBe(null);

    // And the password the orphan was staged with is gone, which is what makes
    // "shown once" true for the resumed account too.
    const stale = await anonClient().auth.signInWithPassword({
      email: orphanEmail,
      password: PASSWORD,
    });
    expect(stale.error, "the pre-resume password should no longer work").not.toBe(
      null,
    );

    // A distinct verb, so the log shows that an account was finished rather
    // than made — every occurrence of this is a create that failed half-way.
    const { data: audit } = await admin
      .from("audit_log")
      .select("action")
      .eq("row_id", orphanId);
    expect(audit).toEqual([{ action: "resume_create_user" }]);
  });

  it("still refuses an address whose account is complete", async () => {
    // The other half of the pair, and the one the resume path must not swallow.
    // `email` was created complete by the first test in this block, so this has
    // to stay a 409 — otherwise "resume" would reset a working rep's password
    // for any admin who retyped an address that already belonged to someone.
    const response = await invoke(
      "create-user",
      {
        full_name: "Not A Resume",
        email,
        role: "agent",
        password: CHOSEN_PASSWORD,
      },
      fixtures.tokens.admin,
    );

    expect(response.status, response.raw).toBe(409);
    expect(String(response.body.error)).toMatch(/already exists/i);
  });

  it("validates the body before touching anything", async () => {
    const p = CHOSEN_PASSWORD;
    for (const body of [
      { full_name: "", email: "a@b.co", role: "agent", password: p },
      { full_name: "No Email", email: "not-an-email", role: "agent", password: p },
      {
        full_name: "Bad Role",
        email: "live-bad-role@tapswipe.test",
        role: "superuser",
        password: p,
      },
      {
        full_name: "Long Number",
        email: "live-long-number@tapswipe.test",
        role: "agent",
        password: p,
        agent_number: "x".repeat(33),
      },
      // The password the admin chooses is validated here as well as in the
      // form, because the form is not a boundary — these two bodies are what an
      // admin session POSTing straight at the URL can send. Five characters is
      // one short of MIN_PASSWORD_LENGTH; omitted entirely is the other half,
      // and the one that would otherwise fall through to a generated password
      // nobody asked for.
      {
        full_name: "Short Password",
        email: "live-short-password@tapswipe.test",
        role: "agent",
        password: "12345",
      },
      {
        full_name: "No Password",
        email: "live-no-password@tapswipe.test",
        role: "agent",
      },
    ]) {
      const response = await invoke("create-user", body, fixtures.tokens.admin);
      expect(response.status, response.raw).toBe(400);
    }

    // And nothing was created for either password case. A 400 that still left an
    // account behind would be the failure worth catching: the refusal has to
    // land before auth.admin.createUser, not after it.
    const { data: users } = await adminClient().auth.admin.listUsers({
      perPage: 1000,
    });
    const leftBehind = (users?.users ?? []).filter(
      (user) =>
        user.email === "live-short-password@tapswipe.test" ||
        user.email === "live-no-password@tapswipe.test",
    );
    expect(leftBehind).toEqual([]);
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
        password: CHOSEN_PASSWORD,
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
        password: CHOSEN_PASSWORD,
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
        {
          full_name: "Live Blank Number",
          email,
          role: "agent",
          password: CHOSEN_PASSWORD,
          agent_number: "   ",
        },
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
      {
        full_name: "Live Reset Rep",
        email,
        role: "agent",
        password: CHOSEN_PASSWORD,
      },
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
