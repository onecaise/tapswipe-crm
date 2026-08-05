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
  select id, full_name, role, is_active, created_at
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

    // profiles has no self-update policy, so this is refused outright rather
    // than silently filtered — there's no policy for UPDATE that an agent
    // satisfies, so zero rows match and nothing changes.
    await db.exec(
      `update profiles set role = 'admin' where id = '${AGENT_ID}';`,
    );

    await asPlatform(db);
    const [check] = await rows<ProfileRow>(
      db,
      `select id, full_name, role, is_active, created_at from profiles where id = '${AGENT_ID}'`,
    );
    expect(check.role).toBe("agent");
  });
});
