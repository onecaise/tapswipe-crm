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
 * set_agent_number() — the RPC behind the Agent # cell on Manage Users, and the
 * only write path to profiles.agent_number that a client can reach.
 *
 * `security definer`, so as with set_user_role there is no RLS doing any of the
 * work: every restriction is a guard written by hand inside the function, and a
 * guard that gets deleted fails open silently. Hence a test per guard.
 *
 * What makes this worth the same scrutiny as set_user_role, despite editing what
 * looks like a label: agent_number is a commission key. It is the only join
 * between a processor's residual report and this database, so whoever holds a
 * number is who gets paid for those merchants. Reassigning one silently moves
 * money.
 *
 * Note the fixtures start with every agent_number null. seed() deliberately does
 * not set them — it is also run against a migration subset that predates the
 * column (see tests/rls/deactivation.test.ts), so it may only touch columns from
 * the initial schema. Each test here sets what it needs.
 */

type ProfileRow = {
  id: string;
  agent_number: string | null;
  role: string;
  is_active: boolean;
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
    `select id, agent_number, role, is_active from profiles where id = '${id}'`,
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

/** Sets a number out of band, so a test can arrange a starting state. */
async function preset(
  db: TestDb,
  id: string,
  value: string | null,
): Promise<void> {
  await asPlatform(db);
  await db.exec(
    `update profiles
        set agent_number = ${value === null ? "null" : `'${value}'`}
      where id = '${id}'`,
  );
}

/**
 * Runs set_agent_number as `caller`, returning the error message or null.
 *
 * `value === null` passes a real SQL null rather than the string "null", which is
 * the difference between clearing a number and setting it to four letters.
 */
async function setNumber(
  db: TestDb,
  caller: string | null,
  target: string,
  value: string | null,
): Promise<string | null> {
  await asUser(db, caller);
  try {
    await db.exec(
      `select set_agent_number('${target}', ${
        value === null ? "null" : `'${value}'`
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

describe("set_agent_number rejects everyone who is not an active admin", () => {
  it("refuses an agent", async () => {
    const error = await setNumber(db, AGENT_ID, OTHER_AGENT_ID, "4471");

    expect(error).toMatch(/admin only/);
    expect((await profile(db, OTHER_AGENT_ID)).agent_number).toBeNull();
  });

  it("refuses an agent setting their own number", async () => {
    // The self-serve version of the escalation that matters here: a rep who could
    // claim an agent number could claim another rep's residuals.
    const error = await setNumber(db, AGENT_ID, AGENT_ID, "4471");

    expect(error).toMatch(/admin only/);
    expect((await profile(db, AGENT_ID)).agent_number).toBeNull();
  });

  it("refuses a caller with no JWT", async () => {
    const error = await setNumber(db, null, AGENT_ID, "4471");

    expect(error).toMatch(/admin only/);
    expect((await profile(db, AGENT_ID)).agent_number).toBeNull();
  });

  it("refuses a deactivated admin", async () => {
    // is_admin() requires is_active, so switching the admin off is enough. A
    // valid session belonging to a disabled admin must not still administer.
    await asPlatform(db);
    await db.exec(
      `update profiles set is_active = false where id = '${ADMIN_ID}'`,
    );

    const error = await setNumber(db, ADMIN_ID, AGENT_ID, "4471");

    expect(error).toMatch(/admin only/);
    expect((await profile(db, AGENT_ID)).agent_number).toBeNull();
  });

  it("writes no audit row when it refuses", async () => {
    await setNumber(db, AGENT_ID, OTHER_AGENT_ID, "4471");

    expect(await auditRows(db)).toEqual([]);
  });
});

describe("set_agent_number sets, changes and clears", () => {
  it("sets a number for an admin, and records who did it", async () => {
    expect(await setNumber(db, ADMIN_ID, AGENT_ID, "4471")).toBeNull();
    expect((await profile(db, AGENT_ID)).agent_number).toBe("4471");

    expect(await auditRows(db)).toEqual([
      {
        actor_id: ADMIN_ID,
        action: "set_agent_number",
        table_name: "profiles",
        row_id: AGENT_ID,
      },
    ]);
  });

  it("changes an existing number", async () => {
    await preset(db, AGENT_ID, "4471");

    expect(await setNumber(db, ADMIN_ID, AGENT_ID, "9902")).toBeNull();
    expect((await profile(db, AGENT_ID)).agent_number).toBe("9902");
  });

  it("clears a number when passed null, with its own verb", async () => {
    await preset(db, AGENT_ID, "4471");

    expect(await setNumber(db, ADMIN_ID, AGENT_ID, null)).toBeNull();
    expect((await profile(db, AGENT_ID)).agent_number).toBeNull();

    // Distinct verbs rather than one action plus a detail column, because
    // audit_log has no detail column and the direction is the point of the entry.
    expect((await auditRows(db)).map((r) => r.action)).toEqual([
      "clear_agent_number",
    ]);
  });

  it("stores null, not an empty string, when passed blank", async () => {
    await preset(db, AGENT_ID, "4471");

    expect(await setNumber(db, ADMIN_ID, AGENT_ID, "   ")).toBeNull();

    // The load-bearing half. '' is a value the partial unique index enforces, so
    // storing it would make the SECOND rep cleared this way collide with the
    // first — and the error would name a constraint nobody typed.
    expect((await profile(db, AGENT_ID)).agent_number).toBeNull();
    expect((await auditRows(db)).map((r) => r.action)).toEqual([
      "clear_agent_number",
    ]);
  });

  it("clears two reps in a row without them colliding", async () => {
    // The regression the normalisation above exists to prevent, asserted end to
    // end rather than by inspecting one column.
    await preset(db, AGENT_ID, "4471");
    await preset(db, OTHER_AGENT_ID, "9902");

    expect(await setNumber(db, ADMIN_ID, AGENT_ID, "")).toBeNull();
    expect(await setNumber(db, ADMIN_ID, OTHER_AGENT_ID, "")).toBeNull();

    expect((await profile(db, AGENT_ID)).agent_number).toBeNull();
    expect((await profile(db, OTHER_AGENT_ID)).agent_number).toBeNull();
  });

  it("trims surrounding whitespace", async () => {
    expect(await setNumber(db, ADMIN_ID, AGENT_ID, "  4471  ")).toBeNull();

    // Otherwise ' 4471' and '4471' are two different reps as far as the import's
    // lookup is concerned, and the file always wins that argument.
    expect((await profile(db, AGENT_ID)).agent_number).toBe("4471");
  });

  it("lets an admin set their own number", async () => {
    // Deliberately unguarded, unlike set_user_role's self-target block. An admin
    // who also carries a book has an agent number like anyone else, and setting
    // it removes no privilege and loses them no screen.
    expect(await setNumber(db, ADMIN_ID, ADMIN_ID, "0001")).toBeNull();
    expect((await profile(db, ADMIN_ID)).agent_number).toBe("0001");
  });
});

describe("set_agent_number keeps one number to one rep", () => {
  it("refuses a number another rep already holds", async () => {
    await preset(db, OTHER_AGENT_ID, "4471");

    const error = await setNumber(db, ADMIN_ID, AGENT_ID, "4471");

    expect(error).toMatch(/already assigned to another rep/);
    expect((await profile(db, AGENT_ID)).agent_number).toBeNull();
    // And it did not steal it from the holder either.
    expect((await profile(db, OTHER_AGENT_ID)).agent_number).toBe("4471");
  });

  it("writes no audit row when it refuses a duplicate", async () => {
    await preset(db, OTHER_AGENT_ID, "4471");
    await setNumber(db, ADMIN_ID, AGENT_ID, "4471");

    expect(await auditRows(db)).toEqual([]);
  });

  it("lets a rep keep the number they already have", async () => {
    // The duplicate check excludes the target, or re-saving an unchanged field
    // would report a clash with itself.
    await preset(db, AGENT_ID, "4471");

    expect(await setNumber(db, ADMIN_ID, AGENT_ID, "4471")).toBeNull();
    expect((await profile(db, AGENT_ID)).agent_number).toBe("4471");
  });

  it("is enforced by the index, not only by the function", async () => {
    // The function's check is for the message; this is the guarantee. Written as
    // the platform role so RLS and the RPC are both out of the way and only the
    // index can be what refuses.
    await preset(db, OTHER_AGENT_ID, "4471");
    await asPlatform(db);

    await expect(
      db.exec(
        `update profiles set agent_number = '4471' where id = '${AGENT_ID}'`,
      ),
    ).rejects.toThrow(/profiles_agent_number_key|unique/i);
  });

  it("allows many reps to have no number at all", async () => {
    // The reason the index is partial. Every existing profile is in this state,
    // so a plain unique constraint that treated nulls as equal would have made
    // the migration unappliable.
    await asPlatform(db);
    const [{ n }] = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from profiles where agent_number is null`,
    );
    expect(n).toBeGreaterThan(1);
  });
});

describe("set_agent_number validates its input", () => {
  it("rejects a number longer than 32 characters", async () => {
    const error = await setNumber(db, ADMIN_ID, AGENT_ID, "x".repeat(33));

    expect(error).toMatch(/32 characters or fewer/);
    expect((await profile(db, AGENT_ID)).agent_number).toBeNull();
  });

  it("accepts exactly 32 characters", async () => {
    // The boundary in the other direction, so the cap cannot drift to 31 or 33
    // unnoticed. isAgentNumber() in _shared/admin-users.ts holds the same one.
    const value = "x".repeat(32);

    expect(await setNumber(db, ADMIN_ID, AGENT_ID, value)).toBeNull();
    expect((await profile(db, AGENT_ID)).agent_number).toBe(value);
  });

  it("accepts letters and hyphens, not just digits", async () => {
    // Processors issue codes in their own formats. A digits-only rule here would
    // reject a real agent number on the one screen that can record it.
    expect(await setNumber(db, ADMIN_ID, AGENT_ID, "A-2210")).toBeNull();
    expect((await profile(db, AGENT_ID)).agent_number).toBe("A-2210");
  });

  it("reports a user that does not exist", async () => {
    expect(await setNumber(db, ADMIN_ID, MISSING_USER, "4471")).toMatch(
      /user not found/,
    );
  });

  it("is a no-op, with no audit row, when the number already matches", async () => {
    await preset(db, AGENT_ID, "4471");

    expect(await setNumber(db, ADMIN_ID, AGENT_ID, "4471")).toBeNull();

    // An audit row here would claim a commission key moved when it did not,
    // which is worse than no row: it makes the trail lie.
    expect(await auditRows(db)).toEqual([]);
  });

  it("is a no-op when clearing a number that is already absent", async () => {
    // `is not distinct from` rather than `=`, or null-vs-null falls through and
    // writes a clear_agent_number row for a rep who never had one.
    expect(await setNumber(db, ADMIN_ID, AGENT_ID, null)).toBeNull();

    expect(await auditRows(db)).toEqual([]);
  });
});

describe("set_agent_number is locked down like every other function", () => {
  const SIGNATURE = "set_agent_number(uuid, text)";

  it("is not executable by anon", async () => {
    // Postgres grants EXECUTE to PUBLIC on every new function and there is no
    // declarative backstop, so this is the per-function revoke doing the work.
    await asPlatform(db);
    const [{ ok }] = await rows<{ ok: boolean }>(
      db,
      `select has_function_privilege('anon', '${SIGNATURE}', 'execute') as ok`,
    );
    expect(ok).toBe(false);
  });

  it("is executable by authenticated and service_role", async () => {
    await asPlatform(db);
    for (const role of ["authenticated", "service_role"]) {
      const [{ ok }] = await rows<{ ok: boolean }>(
        db,
        `select has_function_privilege('${role}', '${SIGNATURE}', 'execute') as ok`,
      );
      expect(ok, `${role} should execute ${SIGNATURE}`).toBe(true);
    }
  });

  it("is security definer and still checks is_admin() itself", async () => {
    // These two facts are only safe together. `security definer` is what lets the
    // function write profiles (no UPDATE policy) and audit_log (no INSERT policy);
    // the is_admin() call is the only thing standing between that privilege and
    // any authenticated caller. Dropping the check while keeping definer would
    // hand every rep the ability to reassign commission keys, and no other test
    // in this file would notice if the behavioural cases above were relaxed too.
    await asPlatform(db);
    const [row] = await rows<{ prosecdef: boolean; def: string }>(
      db,
      `select p.prosecdef, pg_get_functiondef(p.oid) as def
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'set_agent_number'`,
    );

    expect(row.prosecdef).toBe(true);
    expect(row.def).toMatch(/is_admin\(\)/);
    expect(row.def).toMatch(/search_path/);
  });
});
