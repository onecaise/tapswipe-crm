import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ADMIN_ID,
  AGENT_ID,
  OTHER_AGENT_ID,
  asPlatform,
  asUser,
  createTestDb,
  rows,
  seed,
  type TestDb,
} from "../helpers/db";

/**
 * The exact column list the Manage Users page fetches, kept in sync with
 * app/admin/users/page.tsx. If that select changes, change it here too — the
 * point of this test is that *that* query is safe, not some approximation.
 */
const MANAGE_USERS_QUERY = `
  select id, full_name, role, is_active, must_change_password, created_at
  from profiles
  order by created_at asc
`;

type ProfileRow = {
  id: string;
  full_name: string;
  role: string;
  is_active: boolean;
};

describe("Manage Users data fetch under RLS", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
    await seed(db);
  });

  afterAll(async () => {
    await db?.close();
  });

  it("does not leak other users' profiles to a non-admin", async () => {
    await asUser(db, AGENT_ID);

    const result = await rows<ProfileRow>(db, MANAGE_USERS_QUERY);

    // Note what this asserts and what it does not. RLS *filters*; it does not
    // reject. The query succeeds for an agent — it simply comes back containing
    // only the row they're allowed to see. Asserting an error here would be
    // asserting the opposite of how the policy works.
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(AGENT_ID);

    // The assertion that would actually catch a policy regression.
    const ids = result.map((r) => r.id);
    expect(ids).not.toContain(ADMIN_ID);
    expect(ids).not.toContain(OTHER_AGENT_ID);
  });

  it("returns every profile to an admin", async () => {
    await asUser(db, ADMIN_ID);

    const result = await rows<ProfileRow>(db, MANAGE_USERS_QUERY);
    const ids = result.map((r) => r.id);

    // Without this, the test above could pass against an empty table, a broken
    // connection, or a policy that denies everyone.
    expect(result).toHaveLength(3);
    expect(ids).toEqual(
      expect.arrayContaining([ADMIN_ID, AGENT_ID, OTHER_AGENT_ID]),
    );
  });

  it("returns nothing to an unauthenticated caller", async () => {
    await asUser(db, null);

    const result = await rows<ProfileRow>(db, MANAGE_USERS_QUERY);

    expect(result).toHaveLength(0);
  });

  it("still lets a deactivated user read their own profile", async () => {
    await asPlatform(db);
    await db.exec(`update profiles set is_active = false where id = '${AGENT_ID}';`);

    await asUser(db, AGENT_ID);
    const result = await rows<ProfileRow>(db, MANAGE_USERS_QUERY);

    // Deliberate exception to the is_active_agent() gating: the profiles select
    // policy's own-row branch stays ungated so the app can tell a deactivated
    // user why they're locked out instead of showing them an empty page.
    // lib/auth.ts requireUser() depends on this.
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(AGENT_ID);
    expect(result[0].is_active).toBe(false);

    await asPlatform(db);
    await db.exec(`update profiles set is_active = true where id = '${AGENT_ID}';`);
  });

  it("would catch a fail-open policy (mutation check)", async () => {
    // Deliberately break the policy, then confirm the assertions in the first
    // test actually trip. Without this, "agent sees exactly 1 row" could be
    // passing for an unrelated reason and we'd never know the test is inert.
    const broken = await createTestDb();
    await seed(broken);
    await asPlatform(broken);
    await broken.exec(`
      drop policy "read own profile or admin reads all" on profiles;
      create policy "read own profile or admin reads all" on profiles
        for select using (true);
    `);

    await asUser(broken, AGENT_ID);
    const leaked = await rows<ProfileRow>(broken, MANAGE_USERS_QUERY);

    expect(leaked).toHaveLength(3);
    expect(leaked.map((r) => r.id)).toContain(ADMIN_ID);

    await broken.close();
  });

  it("does not let a non-admin escalate their own role", async () => {
    await asUser(db, AGENT_ID);

    // profiles has no UPDATE policy for anyone, and since 20260811173000 no
    // UPDATE grant either — so this now raises rather than matching zero rows.
    // The distinction matters: the write is refused at the privilege layer,
    // before RLS is consulted at all. (It was already safe when only the policy
    // was missing; this asserts the stronger of the two states.)
    await expect(
      db.exec(`update profiles set role = 'admin' where id = '${AGENT_ID}';`),
    ).rejects.toThrow(/permission denied/i);

    await asPlatform(db);
    const [check] = await rows<ProfileRow>(
      db,
      `select id, full_name, role, is_active, created_at from profiles where id = '${AGENT_ID}'`,
    );
    expect(check.role).toBe("agent");
  });
});

/**
 * profiles has no client write path at all — the same treatment as the three
 * *_secrets tables, and for the same reason: it is the table that decides who
 * is an admin.
 *
 * The gap this closes. "admin manages profiles" was
 * `for update using (is_admin()) with check (is_admin())`, so any admin could
 * PATCH /rest/v1/profiles directly. That walked past every guard inside
 * set_user_role() — the role vocabulary, the no-self-demotion block that makes
 * zero-active-admins unreachable, the last-active-admin check — and wrote no
 * audit_log row, because audit_log has no INSERT policy and a plain client
 * write cannot log itself. It also allowed is_active = false without the
 * banned_until ban that deactivate-user writes first, which is the
 * shown-inactive-but-usable state that ordering exists to prevent.
 *
 * Two locks now, matching the *_secrets pattern: no UPDATE policy, and no
 * UPDATE grant. Either alone would deny the write; both means re-adding one by
 * mistake still opens nothing.
 */
describe("profiles has no client write path", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
    await seed(db);
  });

  afterAll(async () => {
    await db?.close();
  });

  async function roleOf(userId: string): Promise<string> {
    await asPlatform(db);
    const [row] = await rows<{ role: string }>(
      db,
      `select role from profiles where id = '${userId}'`,
    );
    return row.role;
  }

  it("refuses an admin's direct UPDATE instead of letting it past set_user_role", async () => {
    await asUser(db, ADMIN_ID);

    // Note this is an ADMIN, not an agent. The agent case above was always
    // safe; this one was the hole. Asserted as a raised error rather than as
    // zero rows changed, because the grant is gone too — the request now dies
    // at the privilege layer, before RLS is consulted at all.
    let failed = false;
    try {
      await db.exec(
        `update profiles set role = 'admin' where id = '${AGENT_ID}';`,
      );
    } catch {
      failed = true;
    }

    expect(
      failed,
      "an admin's direct UPDATE on profiles should be refused outright",
    ).toBe(true);

    // The assertion that separates "refused" from "refused, but only after it
    // worked". Without the fix the role really does change here.
    expect(await roleOf(AGENT_ID)).toBe("agent");

    // And nothing was recorded, which is the point: a write that leaves no
    // trail must not be possible, rather than possible and merely unlogged.
    const audit = await rows<{ action: string }>(
      db,
      `select action from audit_log`,
    );
    expect(audit).toEqual([]);

    // Defensive: pre-fix this test's UPDATE succeeds, so leave the fixture as
    // it was found regardless of which way the assertions went.
    await asPlatform(db);
    await db.exec(`update profiles set role = 'agent' where id = '${AGENT_ID}'`);
  });

  it("leaves no UPDATE policy on profiles for any role", async () => {
    // The structural half. The behavioural test above would still pass if the
    // policy came back but the grant stayed revoked; this one names the policy
    // itself, so restoring it fails here even though the write is still denied
    // one layer down.
    await asPlatform(db);
    const policies = await rows<{ policyname: string }>(
      db,
      `select policyname from pg_policies
        where schemaname = 'public' and tablename = 'profiles' and cmd = 'UPDATE'`,
    );

    expect(policies).toEqual([]);
  });

  it("still lets set_user_role change a role, with its audit row", async () => {
    // The other half of the same fix: closing the direct path is only correct
    // if the sanctioned one still works. Otherwise "no client write path"
    // would mean roles cannot be changed at all, and the admin screen breaks.
    await asUser(db, ADMIN_ID);
    await db.exec(
      `select set_user_role('${OTHER_AGENT_ID}'::uuid, 'admin')`,
    );

    expect(await roleOf(OTHER_AGENT_ID)).toBe("admin");

    const audit = await rows<{ action: string; row_id: string }>(
      db,
      `select action, row_id from audit_log order by id asc`,
    );
    expect(audit).toEqual([
      { action: "promote_user_to_admin", row_id: OTHER_AGENT_ID },
    ]);

    await asPlatform(db);
    await db.exec(`delete from audit_log`);
    await db.exec(
      `update profiles set role = 'agent' where id = '${OTHER_AGENT_ID}'`,
    );
  });
});
