import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_ID,
  AGENT_ID,
  OTHER_AGENT_ID,
  asPlatform,
  asUser,
  createTestDb,
  resetData,
  rows,
  type TestDb,
} from "../helpers/db";

/**
 * The two RPCs behind the Manage Users screen that do not need the service-role
 * key: set_user_role() and clear_must_change_password().
 *
 * Both are `security definer`, so unlike the Tier 1 tables there is no RLS doing
 * the work — every restriction is a guard written by hand inside the function,
 * and a guard that gets deleted fails open silently. Hence a test per guard.
 *
 * set_user_role is the privilege-escalation surface of the whole app: it is the
 * only path by which anyone becomes an admin. The interesting assertions are the
 * negative ones.
 */

type ProfileRow = {
  id: string;
  role: string;
  is_active: boolean;
  must_change_password: boolean;
};

type AuditRow = {
  actor_id: string;
  action: string;
  table_name: string;
  row_id: string;
};

const MISSING_USER = "44444444-4444-4444-4444-444444444444";

async function profile(db: TestDb, id: string): Promise<ProfileRow> {
  await asPlatform(db);
  const [row] = await rows<ProfileRow>(
    db,
    `select id, role, is_active, must_change_password
       from profiles where id = '${id}'`,
  );
  return row;
}

async function auditRows(db: TestDb): Promise<AuditRow[]> {
  await asPlatform(db);
  return rows<AuditRow>(
    db,
    `select actor_id, action, table_name, row_id
       from audit_log order by id asc`,
  );
}

/** Runs set_user_role as `caller`, returning the error message or null. */
async function setRole(
  db: TestDb,
  caller: string | null,
  target: string,
  role: string,
): Promise<string | null> {
  await asUser(db, caller);
  try {
    await db.exec(`select set_user_role('${target}', '${role}')`);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(async () => {
  await resetData(db);
});

afterAll(async () => {
  await db?.close();
});

describe("set_user_role rejects everyone who is not an active admin", () => {
  it("refuses an agent", async () => {
    const error = await setRole(db, AGENT_ID, OTHER_AGENT_ID, "admin");

    expect(error).toMatch(/admin only/);
    expect((await profile(db, OTHER_AGENT_ID)).role).toBe("agent");
  });

  it("refuses an agent trying to promote themselves", async () => {
    // The escalation that matters. Blocked twice over — by is_admin() and by the
    // self-target guard — but this asserts the outcome, not which guard fired.
    const error = await setRole(db, AGENT_ID, AGENT_ID, "admin");

    expect(error).not.toBeNull();
    expect((await profile(db, AGENT_ID)).role).toBe("agent");
  });

  it("refuses a caller with no JWT", async () => {
    const error = await setRole(db, null, AGENT_ID, "admin");

    expect(error).toMatch(/admin only/);
    expect((await profile(db, AGENT_ID)).role).toBe("agent");
  });

  it("refuses a deactivated admin", async () => {
    // is_admin() requires `is_active`, so switching the admin off is enough.
    // A valid session belonging to a disabled admin must not still administer.
    await asPlatform(db);
    await db.exec(
      `update profiles set is_active = false where id = '${ADMIN_ID}'`,
    );

    const error = await setRole(db, ADMIN_ID, AGENT_ID, "admin");

    expect(error).toMatch(/admin only/);
    expect((await profile(db, AGENT_ID)).role).toBe("agent");
  });

  it("writes no audit row when it refuses", async () => {
    await setRole(db, AGENT_ID, OTHER_AGENT_ID, "admin");

    expect(await auditRows(db)).toEqual([]);
  });
});

describe("set_user_role guards the admin role itself", () => {
  it("promotes an agent for an admin, and records who did it", async () => {
    expect(await setRole(db, ADMIN_ID, AGENT_ID, "admin")).toBeNull();
    expect((await profile(db, AGENT_ID)).role).toBe("admin");

    expect(await auditRows(db)).toEqual([
      {
        actor_id: ADMIN_ID,
        action: "promote_user_to_admin",
        table_name: "profiles",
        row_id: AGENT_ID,
      },
    ]);
  });

  it("demotes an admin back to agent", async () => {
    await setRole(db, ADMIN_ID, AGENT_ID, "admin");
    expect(await setRole(db, ADMIN_ID, AGENT_ID, "agent")).toBeNull();

    expect((await profile(db, AGENT_ID)).role).toBe("agent");
    expect((await auditRows(db)).map((r) => r.action)).toEqual([
      "promote_user_to_admin",
      "demote_user_to_agent",
    ]);
  });

  it("refuses to change the caller's own role", async () => {
    // An admin demoting themselves loses the screen they are standing on,
    // mid-session, with no way back.
    const error = await setRole(db, ADMIN_ID, ADMIN_ID, "agent");

    expect(error).toMatch(/cannot change your own role/);
    expect((await profile(db, ADMIN_ID)).role).toBe("admin");
  });

  it("cannot be used to reach zero active admins", async () => {
    // The property that actually matters, asserted as a property rather than by
    // pretending to exercise the function's last-active-admin branch.
    //
    // That branch is unreachable, and a test aimed at it would really be testing
    // the self-guard: is_admin() means the caller is an active admin and the
    // self-guard means the caller is not the target, so an active admin other
    // than the target always survives a demotion. See the note in the migration.
    await setRole(db, ADMIN_ID, AGENT_ID, "admin");
    await setRole(db, ADMIN_ID, OTHER_AGENT_ID, "admin");

    // Demote every admin the caller is allowed to demote — i.e. everyone but
    // themselves — and an active admin still remains.
    expect(await setRole(db, ADMIN_ID, AGENT_ID, "agent")).toBeNull();
    expect(await setRole(db, ADMIN_ID, OTHER_AGENT_ID, "agent")).toBeNull();

    await asPlatform(db);
    const [{ n }] = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from profiles where role = 'admin' and is_active`,
    );
    expect(n).toBeGreaterThan(0);
  });

  it("allows a demotion while another active admin remains", async () => {
    // The permissive half: an admin must actually be demotable, or the screen's
    // role dropdown is decorative.
    await setRole(db, ADMIN_ID, AGENT_ID, "admin");

    expect(await setRole(db, ADMIN_ID, AGENT_ID, "agent")).toBeNull();
    expect((await profile(db, AGENT_ID)).role).toBe("agent");
  });

  it("rejects a role outside the vocabulary", async () => {
    const error = await setRole(db, ADMIN_ID, AGENT_ID, "superuser");

    expect(error).toMatch(/role must be agent or admin/);
    expect((await profile(db, AGENT_ID)).role).toBe("agent");
  });

  it("reports a user that does not exist", async () => {
    expect(await setRole(db, ADMIN_ID, MISSING_USER, "admin")).toMatch(
      /user not found/,
    );
  });

  it("is a no-op, with no audit row, when the role already matches", async () => {
    expect(await setRole(db, ADMIN_ID, AGENT_ID, "agent")).toBeNull();

    // An audit row here would claim a change that did not happen, which is worse
    // than no row at all — it makes the trail lie.
    expect(await auditRows(db)).toEqual([]);
  });
});

describe("clear_must_change_password touches one column on one row", () => {
  beforeEach(async () => {
    await asPlatform(db);
    await db.exec(`update profiles set must_change_password = true`);
  });

  it("clears the caller's own flag", async () => {
    await asUser(db, AGENT_ID);
    await db.exec(`select clear_must_change_password()`);

    expect((await profile(db, AGENT_ID)).must_change_password).toBe(false);
  });

  it("leaves everyone else's flag alone", async () => {
    await asUser(db, AGENT_ID);
    await db.exec(`select clear_must_change_password()`);

    expect((await profile(db, ADMIN_ID)).must_change_password).toBe(true);
    expect((await profile(db, OTHER_AGENT_ID)).must_change_password).toBe(true);
  });

  it("cannot be used to change a role or reactivate an account", async () => {
    // The reason this is its own narrow RPC rather than a profiles update
    // policy: whatever the caller does, only this column can move.
    await asPlatform(db);
    await db.exec(
      `update profiles set is_active = false where id = '${AGENT_ID}'`,
    );

    await asUser(db, AGENT_ID);
    await db.exec(`select clear_must_change_password()`);

    const after = await profile(db, AGENT_ID);
    expect(after.must_change_password).toBe(false);
    expect(after.role).toBe("agent");
    expect(after.is_active).toBe(false);
  });

  it("does nothing for a caller with no JWT", async () => {
    await asUser(db, null);
    await db.exec(`select clear_must_change_password()`);

    expect((await profile(db, AGENT_ID)).must_change_password).toBe(true);
    expect((await profile(db, ADMIN_ID)).must_change_password).toBe(true);
  });
});

describe("both RPCs are locked down like every other function", () => {
  const SIGNATURES = [
    "set_user_role(uuid, text)",
    "clear_must_change_password()",
  ];

  it("is not executable by anon", async () => {
    // Postgres grants EXECUTE to PUBLIC on every new function and there is no
    // declarative backstop, so this is the per-function revoke doing the work.
    await asPlatform(db);
    for (const signature of SIGNATURES) {
      const [{ ok }] = await rows<{ ok: boolean }>(
        db,
        `select has_function_privilege('anon', '${signature}', 'execute') as ok`,
      );
      expect(ok, `anon should not execute ${signature}`).toBe(false);
    }
  });

  it("is executable by authenticated and service_role", async () => {
    await asPlatform(db);
    for (const signature of SIGNATURES) {
      for (const role of ["authenticated", "service_role"]) {
        const [{ ok }] = await rows<{ ok: boolean }>(
          db,
          `select has_function_privilege('${role}', '${signature}', 'execute') as ok`,
        );
        expect(ok, `${role} should execute ${signature}`).toBe(true);
      }
    }
  });
});
