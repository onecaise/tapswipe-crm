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
 * set_manager() — the only write path to profiles.manager_id, and the thing
 * that keeps the reporting graph one layer deep.
 *
 * Two different claims are under test here and they fail in opposite
 * directions, so they are kept in separate describes:
 *
 *   1. **The guards.** `security definer` over profiles means no RLS does any
 *      of the work — every restriction is written by hand inside the function,
 *      and a guard that gets deleted fails OPEN and silently. The same reason
 *      set-territory.test.ts exists, with more guards to lose: four beyond
 *      is_admin(), of which two are the one-hop rule read in its two
 *      directions. Dropping either one of that pair leaves the other looking
 *      sufficient while chains stay buildable from the side it does not watch.
 *   2. **What it does NOT do.** manager_id is a reporting label, not an access
 *      boundary. It makes data filterable BY AN ADMIN who already sees every
 *      row; it changes nothing about what a rep or a manager can see of their
 *      own accord. That is the same line territory holds, and it would be
 *      crossed the same way — wiring the column into a policy as a convenience
 *      would silently widen a book, and no existing policy test would notice,
 *      because their fixtures all share one manager (none).
 *
 * Not a third role, and nothing here should ever make it one: `role` stays
 * ('agent','admin') and every policy in the schema is a binary is_admin()
 * check. See the migration's header for why a third value is a rewrite of the
 * access-control design rather than a column.
 */

type ProfileRow = {
  id: string;
  manager_id: string | null;
};

type AuditRow = {
  actor_id: string | null;
  action: string;
  table_name: string;
  row_id: string;
};

const MISSING_USER = "44444444-4444-4444-4444-444444444444";

async function profile(db: TestDb, id: string): Promise<ProfileRow> {
  await asPlatform(db);
  const [row] = await rows<ProfileRow>(
    db,
    `select id, manager_id from profiles where id = '${id}'`,
  );
  return row;
}

async function auditRows(db: TestDb): Promise<AuditRow[]> {
  await asPlatform(db);
  return rows<AuditRow>(
    db,
    `select actor_id, action, table_name, row_id from audit_log order by id asc`,
  );
}

/** Sets a manager out of band, so a test can arrange a starting state. */
async function preset(
  db: TestDb,
  id: string,
  managerId: string | null,
): Promise<void> {
  await asPlatform(db);
  await db.exec(
    `update profiles set manager_id = ${
      managerId === null ? "null" : `'${managerId}'`
    } where id = '${id}'`,
  );
}

/** Runs set_manager as `caller`, returning the error message or null. */
async function setManager(
  db: TestDb,
  caller: string | null,
  target: string,
  managerId: string | null,
): Promise<string | null> {
  await asUser(db, caller);
  try {
    await db.exec(
      `select set_manager('${target}', ${
        managerId === null ? "null" : `'${managerId}'`
      })`,
    );
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

describe("set_manager rejects everyone who is not an active admin", () => {
  it("refuses an agent", async () => {
    const error = await setManager(db, AGENT_ID, OTHER_AGENT_ID, ADMIN_ID);

    expect(error).toMatch(/admin only/);
    expect((await profile(db, OTHER_AGENT_ID)).manager_id).toBeNull();
  });

  it("refuses an agent naming their own manager", async () => {
    // Not a hypothetical shape of abuse: "let a rep pick who they report to"
    // is the first convenience anyone would reach for, and it hands a rep a
    // write path into profiles through a `security definer` function. The
    // column it reaches today is harmless; the table it reaches is the one
    // that says who is an admin.
    const error = await setManager(db, AGENT_ID, AGENT_ID, OTHER_AGENT_ID);

    expect(error).toMatch(/admin only/);
    expect((await profile(db, AGENT_ID)).manager_id).toBeNull();
  });

  it("refuses a caller with no JWT", async () => {
    const error = await setManager(db, null, AGENT_ID, ADMIN_ID);

    expect(error).toMatch(/admin only/);
    expect((await profile(db, AGENT_ID)).manager_id).toBeNull();
  });

  it("refuses a deactivated admin", async () => {
    // is_admin() requires is_active, so switching the admin off is enough. A
    // token belonging to a disabled admin stays valid for up to an hour.
    await asPlatform(db);
    await db.exec(
      `update profiles set is_active = false where id = '${ADMIN_ID}'`,
    );

    const error = await setManager(db, ADMIN_ID, AGENT_ID, OTHER_AGENT_ID);

    expect(error).toMatch(/admin only/);
    expect((await profile(db, AGENT_ID)).manager_id).toBeNull();
  });

  it("writes no audit row when it refuses", async () => {
    await setManager(db, AGENT_ID, OTHER_AGENT_ID, ADMIN_ID);

    expect(await auditRows(db)).toEqual([]);
  });
});

describe("profiles.manager_id has no direct client write path", () => {
  it("refuses an admin's direct UPDATE", async () => {
    // Why the RPC exists at all. `authenticated` holds SELECT and nothing else
    // on profiles, so this stops at the GRANT layer — which means the one-hop
    // guards inside set_manager are the only thing enforcing the shape of the
    // graph, and a restored UPDATE grant would walk straight past all four of
    // them. set-territory.test.ts pins the grant and the absent policy on the
    // catalog; this asserts the consequence for the new column.
    await asUser(db, ADMIN_ID);

    await expect(
      db.exec(
        `update profiles set manager_id = '${ADMIN_ID}' where id = '${AGENT_ID}'`,
      ),
    ).rejects.toThrow(/permission denied|row-level security/i);

    expect((await profile(db, AGENT_ID)).manager_id).toBeNull();
  });

  it("refuses an agent's direct UPDATE of their own row", async () => {
    await asUser(db, AGENT_ID);

    await expect(
      db.exec(
        `update profiles set manager_id = '${ADMIN_ID}' where id = '${AGENT_ID}'`,
      ),
    ).rejects.toThrow(/permission denied|row-level security/i);

    expect((await profile(db, AGENT_ID)).manager_id).toBeNull();
  });
});

describe("set_manager sets, changes and clears", () => {
  it("sets a manager for an admin, and records who did it", async () => {
    expect(await setManager(db, ADMIN_ID, AGENT_ID, OTHER_AGENT_ID)).toBeNull();
    expect((await profile(db, AGENT_ID)).manager_id).toBe(OTHER_AGENT_ID);

    expect(await auditRows(db)).toEqual([
      {
        actor_id: ADMIN_ID,
        action: "set_manager",
        table_name: "profiles",
        row_id: AGENT_ID,
      },
    ]);
  });

  it("changes an existing manager", async () => {
    await preset(db, AGENT_ID, OTHER_AGENT_ID);

    expect(await setManager(db, ADMIN_ID, AGENT_ID, ADMIN_ID)).toBeNull();
    expect((await profile(db, AGENT_ID)).manager_id).toBe(ADMIN_ID);
  });

  it("clears a manager when passed null, with its own verb", async () => {
    await preset(db, AGENT_ID, OTHER_AGENT_ID);

    expect(await setManager(db, ADMIN_ID, AGENT_ID, null)).toBeNull();
    expect((await profile(db, AGENT_ID)).manager_id).toBeNull();

    expect((await auditRows(db)).map((r) => r.action)).toEqual([
      "clear_manager",
    ]);
  });

  it("lets many reps report to one manager", async () => {
    // The difference from agent_number in one assertion: a manager with a
    // single report is the unusual case, not the rule, so there is no
    // uniqueness anywhere on this column.
    expect(await setManager(db, ADMIN_ID, AGENT_ID, ADMIN_ID)).toBeNull();
    expect(await setManager(db, ADMIN_ID, OTHER_AGENT_ID, ADMIN_ID)).toBeNull();

    expect((await profile(db, AGENT_ID)).manager_id).toBe(ADMIN_ID);
    expect((await profile(db, OTHER_AGENT_ID)).manager_id).toBe(ADMIN_ID);
  });

  it("writes no audit row when nothing changed", async () => {
    await preset(db, AGENT_ID, OTHER_AGENT_ID);

    expect(await setManager(db, ADMIN_ID, AGENT_ID, OTHER_AGENT_ID)).toBeNull();
    expect(await auditRows(db)).toEqual([]);

    // And clearing a manager nobody had is the no-op it looks like rather than
    // an audit row claiming something changed. `is not distinct from` is what
    // makes the null case behave like the non-null one.
    expect(await setManager(db, ADMIN_ID, ADMIN_ID, null)).toBeNull();
    expect(await auditRows(db)).toEqual([]);
  });

  it("reports a missing target rather than silently doing nothing", async () => {
    const error = await setManager(db, ADMIN_ID, MISSING_USER, ADMIN_ID);

    expect(error).toMatch(/user not found/);
    expect(await auditRows(db)).toEqual([]);
  });

  it("reports a missing manager as such, not as a constraint violation", async () => {
    // The foreign key would catch this anyway, but as a constraint name rather
    // than as a sentence — and the RPC has to read the proposed manager's row
    // for the one-hop check regardless, so the readable error is free.
    const error = await setManager(db, ADMIN_ID, AGENT_ID, MISSING_USER);

    expect(error).toMatch(/manager not found/);
    expect(error).not.toMatch(/foreign key|violates/i);
    expect((await profile(db, AGENT_ID)).manager_id).toBeNull();
    expect(await auditRows(db)).toEqual([]);
  });
});

describe("the graph is exactly one hop — no self, no chains, no cycles", () => {
  it("refuses self-management", async () => {
    const error = await setManager(db, ADMIN_ID, AGENT_ID, AGENT_ID);

    expect(error).toMatch(/cannot manage themselves/);
    expect((await profile(db, AGENT_ID)).manager_id).toBeNull();
    expect(await auditRows(db)).toEqual([]);
  });

  it("refuses a manager who already has a manager (downward)", async () => {
    // Guard 3. OTHER_AGENT reports to ADMIN, so nobody may be made to report
    // to OTHER_AGENT — that would be two hops.
    await preset(db, OTHER_AGENT_ID, ADMIN_ID);

    const error = await setManager(db, ADMIN_ID, AGENT_ID, OTHER_AGENT_ID);

    expect(error).toMatch(/one level deep/);
    expect((await profile(db, AGENT_ID)).manager_id).toBeNull();
  });

  it("refuses giving a manager to someone who already manages (upward)", async () => {
    // Guard 4, and the half guard 3 alone does not cover — this is the test
    // that goes red if someone decides one direction is enough. AGENT reports
    // to OTHER_AGENT; giving OTHER_AGENT a manager of their own builds the
    // identical two-hop chain from the other end, and guard 3 would be
    // perfectly happy, because ADMIN reports to nobody.
    await preset(db, AGENT_ID, OTHER_AGENT_ID);

    const error = await setManager(db, ADMIN_ID, OTHER_AGENT_ID, ADMIN_ID);

    expect(error).toMatch(/one level deep/);
    expect((await profile(db, OTHER_AGENT_ID)).manager_id).toBeNull();
  });

  it("refuses a two-person cycle", async () => {
    // Needs no rule of its own, which is the point: with both directions
    // watched there is no cycle of any length left to write, so nothing has to
    // walk the graph looking for one. Measured by reverting each guard in
    // turn — guard 3 is what refuses this one as the function stands (it runs
    // first, and AGENT already reports to somebody), and with guard 3 deleted
    // guard 4 catches the same call. Redundant on purpose: this is the
    // assertion that should survive either half being rewritten.
    expect(await setManager(db, ADMIN_ID, AGENT_ID, OTHER_AGENT_ID)).toBeNull();

    const error = await setManager(db, ADMIN_ID, OTHER_AGENT_ID, AGENT_ID);

    expect(error).toMatch(/one level deep/);
    expect((await profile(db, OTHER_AGENT_ID)).manager_id).toBeNull();
  });

  it("is not a latch — clearing the first hop frees the second", async () => {
    // The guards describe the current shape of the graph, not a decision that
    // can never be revisited. Without this, a refusal would be
    // indistinguishable from a column that can only be written once.
    expect(await setManager(db, ADMIN_ID, AGENT_ID, OTHER_AGENT_ID)).toBeNull();
    expect(await setManager(db, ADMIN_ID, OTHER_AGENT_ID, ADMIN_ID)).toMatch(
      /one level deep/,
    );

    expect(await setManager(db, ADMIN_ID, AGENT_ID, null)).toBeNull();
    expect(await setManager(db, ADMIN_ID, OTHER_AGENT_ID, ADMIN_ID)).toBeNull();
    expect((await profile(db, OTHER_AGENT_ID)).manager_id).toBe(ADMIN_ID);
  });

  it("lets an admin manage reps, and lets an admin be managed", async () => {
    // Deliberately NOT guarded against either, unlike set_user_role's
    // self-guard. An admin who also carries a book reports to somebody like
    // anyone else, and naming a manager grants and removes no privilege —
    // which is the whole claim of the next describe.
    expect(await setManager(db, ADMIN_ID, AGENT_ID, ADMIN_ID)).toBeNull();

    await preset(db, AGENT_ID, null);
    expect(await setManager(db, ADMIN_ID, ADMIN_ID, AGENT_ID)).toBeNull();
    expect((await profile(db, ADMIN_ID)).manager_id).toBe(AGENT_ID);
  });
});

describe("manager_id is not an access boundary", () => {
  it("appears in no policy expression anywhere in the schema", async () => {
    // The guard against the convenient version of "a manager sees their reps".
    // Wiring this column into a policy without rewriting the own-row half of
    // all seven owner tables would silently widen a book, and nothing else in
    // this suite would notice — the policy tests would still pass, because
    // their fixtures all share one manager (none).
    await asPlatform(db);
    const [{ n }] = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from pg_policies
        where coalesce(qual, '') || coalesce(with_check, '') like '%manager%'`,
    );
    expect(n).toBe(0);
  });

  it("shows a manager no more of their report's records than before", async () => {
    await setManager(db, ADMIN_ID, OTHER_AGENT_ID, AGENT_ID);

    await asUser(db, AGENT_ID);
    const leads = await rows<{ agent_id: string }>(
      db,
      `select agent_id from leads`,
    );

    expect(leads.length).toBeGreaterThan(0);
    expect(leads.every((l) => l.agent_id === AGENT_ID)).toBe(true);
  });

  it("does not let a manager read their report's profile row", async () => {
    await setManager(db, ADMIN_ID, OTHER_AGENT_ID, AGENT_ID);

    await asUser(db, AGENT_ID);
    const visible = await rows<{ id: string }>(db, `select id from profiles`);

    expect(visible.map((p) => p.id)).toEqual([AGENT_ID]);
  });

  it("does not let a rep read who manages whom", async () => {
    // A rep can see their own manager — that is their own profile row, which
    // they could always read. What they cannot do is assemble the org chart.
    await setManager(db, ADMIN_ID, AGENT_ID, ADMIN_ID);
    await setManager(db, ADMIN_ID, OTHER_AGENT_ID, ADMIN_ID);

    await asUser(db, AGENT_ID);
    const visible = await rows<ProfileRow>(
      db,
      `select id, manager_id from profiles`,
    );

    expect(visible).toEqual([{ id: AGENT_ID, manager_id: ADMIN_ID }]);
  });

  it("lets an admin filter records by a manager's reports", async () => {
    // The use the column exists for, asserted so "makes data filterable" is a
    // demonstrated claim rather than an aspiration. The subquery is the shape
    // a dashboard would run, and it works because the caller is an admin who
    // could already see every one of these rows.
    await setManager(db, ADMIN_ID, OTHER_AGENT_ID, AGENT_ID);

    await asUser(db, ADMIN_ID);
    const leads = await rows<{ agent_id: string }>(
      db,
      `select agent_id from leads
        where agent_id in (
          select id from profiles where manager_id = '${AGENT_ID}'
        )`,
    );

    expect(leads.length).toBeGreaterThan(0);
    expect(leads.every((l) => l.agent_id === OTHER_AGENT_ID)).toBe(true);
  });
});
