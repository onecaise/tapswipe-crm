import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_ID,
  AGENT_ID,
  OTHER_AGENT_ID,
  asPlatform,
  asUser,
  createTestDb,
  migrationsBefore,
  readMigration,
  resetData,
  rows,
  seed,
  type TestDb,
} from "../helpers/db";

/**
 * processors -- the one processor vocabulary (20261023130000, phase 1 of
 * docs/design/intake-and-reports.md).
 *
 * The claims:
 *
 *   1. **Exactly the five processors Owen named, then 365 Pay** (phase 14), in
 *      his spelling and order.
 *   2. **Every active user reads it; nobody writes it from a client** -- not
 *      even an admin. Writes are `permission denied` (a grant refusal), not a
 *      filtered no-op, and the grant surface is SELECT and nothing else.
 *   3. **A deactivated rep loses it**, and anon has nothing at all.
 *   4. **merchants.processor and pre_apps.processor accept a listed code or
 *      NULL, and nothing else** -- for a rep, an admin and the platform
 *      owner alike, because it is a foreign key, not a UI rule.
 *   5. **A listed processor cannot be deleted or renamed while a row names it.**
 *   6. **approve_pre_app() copies the pre-app's processor onto the merchant**,
 *      NULL included.
 *   7. **The migration refuses to run over a merchant it would break**, naming
 *      the value, and changes nothing when it does; over valid rows it runs
 *      and leaves every value as it was.
 */

const MIGRATION = "20261023130000_processors.sql";
// The five Owen named (20261023130000), then 365 Pay (20261106120000, phase 14).
const EXPECTED = ["TSYS", "Red Fynn", "PayBright", "Netevia HQ", "Square", "365 Pay"];

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  // resetData() truncates and re-runs seed().
  await resetData(db);
});

/** Runs `sql` and returns the error message, or null if it succeeded. */
async function failure(sql: string): Promise<string | null> {
  try {
    await db.exec(sql);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Like failure(), inside a transaction that is always rolled back. For the
 * probes that, if the guard under test were missing, would really delete or
 * rename a processor -- resetData() does not restore this table, so a leaked
 * delete would fail every later test for a reason that has nothing to do with
 * them (measured, while mutation-checking the pre_apps foreign key).
 */
async function failureRolledBack(sql: string): Promise<string | null> {
  await db.exec("begin");
  try {
    return await failure(sql);
  } finally {
    await db.exec("rollback");
  }
}

async function codes(): Promise<string[]> {
  const found = await rows<{ code: string }>(
    db,
    `select code from processors order by sort_order`,
  );
  return found.map((r) => r.code);
}

async function idOf(table: "merchants" | "pre_apps", column: string, value: string) {
  await asPlatform(db);
  const [row] = await rows<{ id: number }>(
    db,
    `select id from ${table} where ${column} = '${value}'`,
  );
  return row.id;
}

describe("the processor list", () => {
  it("holds exactly the six processors, in drop-down order", async () => {
    await asPlatform(db);
    expect(await codes()).toEqual(EXPECTED);
    const labels = await rows<{ code: string; label: string }>(
      db,
      `select code, label from processors`,
    );
    // code = label until a display name is ever changed (memo A1).
    for (const { code, label } of labels) expect(label).toBe(code);
  });

  it("refuses a padded or blank code, and a tied sort order", async () => {
    await asPlatform(db);
    expect(
      await failureRolledBack(`insert into processors values (' TSYS', 'x', 99)`),
    ).toMatch(/processors_code_trimmed/);
    expect(await failureRolledBack(`insert into processors values ('', 'x', 99)`)).toMatch(
      /processors_code_trimmed/,
    );
    expect(
      await failureRolledBack(`insert into processors values ('Other', 'Other', 10)`),
    ).toMatch(/processors_sort_order_key/);
  });
});

describe("who can read and write processors", () => {
  it("an active rep and an admin each read all six", async () => {
    for (const user of [AGENT_ID, ADMIN_ID]) {
      await asUser(db, user);
      expect(await codes()).toEqual(EXPECTED);
    }
  });

  it("a deactivated rep reads nothing", async () => {
    await asPlatform(db);
    await db.exec(`update profiles set is_active = false where id = '${AGENT_ID}'`);
    await asUser(db, AGENT_ID);
    expect(await codes()).toEqual([]);
  });

  it("anon is refused outright", async () => {
    await asPlatform(db);
    await db.exec(`set role anon`);
    expect(await failure(`select code from processors`)).toMatch(
      /permission denied for table processors/,
    );
    await asPlatform(db);
  });

  it("refuses every client write, admin included, and changes nothing", async () => {
    for (const user of [AGENT_ID, ADMIN_ID]) {
      await asUser(db, user);
      for (const sql of [
        `insert into processors values ('Fake', 'Fake', 99)`,
        `update processors set label = 'Renamed' where code = 'TSYS'`,
        `delete from processors where code = 'Square'`,
      ]) {
        expect(await failureRolledBack(sql)).toMatch(/permission denied for table processors/);
      }
    }
    await asPlatform(db);
    expect(await codes()).toEqual(EXPECTED);
    const [tsys] = await rows<{ label: string }>(
      db,
      `select label from processors where code = 'TSYS'`,
    );
    expect(tsys.label).toBe("TSYS");
  });

  it("grants SELECT only: authenticated and service_role, nothing to anon", async () => {
    await asPlatform(db);
    const privileges = await rows<{ role: string; p: string }>(
      db,
      `select r as role, p
         from unnest(array['anon','authenticated','service_role']) r,
              unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
        where has_table_privilege(r, 'processors', p)
        order by r, p`,
    );
    expect(privileges).toEqual([
      { role: "authenticated", p: "SELECT" },
      { role: "service_role", p: "SELECT" },
    ]);
  });

  it("enables RLS itself rather than relying on the ensure_rls backstop", async () => {
    // 20260811150000 adopted the hosted project's ensure_rls event trigger, so
    // in this suite a table that forgets the line still comes up RLS-on and the
    // catalog check below cannot tell the difference -- measured: deleting the
    // line left every other test here green. CLAUDE.md says not to rely on that
    // backstop, so the migration's own text is what is pinned.
    expect(await readMigration(MIGRATION)).toMatch(
      /^alter table processors enable row level security;$/m,
    );
  });

  it("has RLS on and exactly one policy, a select", async () => {
    await asPlatform(db);
    const [table] = await rows<{ relrowsecurity: boolean }>(
      db,
      `select relrowsecurity from pg_class where oid = 'processors'::regclass`,
    );
    expect(table.relrowsecurity).toBe(true);
    const policies = await rows<{ cmd: string }>(
      db,
      `select cmd from pg_policies where tablename = 'processors'`,
    );
    expect(policies).toEqual([{ cmd: "SELECT" }]);
  });
});

describe("merchants.processor", () => {
  it("an admin sets a listed processor, clears it, and is refused free text", async () => {
    const id = await idOf("merchants", "dba", "Agent Active Co");
    await asUser(db, ADMIN_ID);
    await db.exec(`update merchants set processor = 'Netevia HQ' where id = ${id}`);
    await db.exec(`update merchants set processor = null where id = ${id}`);
    expect(
      await failure(`update merchants set processor = 'First Data' where id = ${id}`),
    ).toMatch(/merchants_processor_fkey/);
    // Case matters: the code is the value, so 'tsys' is not TSYS.
    expect(
      await failure(`update merchants set processor = 'tsys' where id = ${id}`),
    ).toMatch(/merchants_processor_fkey/);
    await asPlatform(db);
    const [m] = await rows<{ processor: string | null }>(
      db,
      `select processor from merchants where id = ${id}`,
    );
    expect(m.processor).toBeNull();
  });

  it("binds the platform owner too", async () => {
    const id = await idOf("merchants", "dba", "Agent Active Co");
    await asPlatform(db);
    expect(
      await failure(`update merchants set processor = 'Elavon' where id = ${id}`),
    ).toMatch(/merchants_processor_fkey/);
  });

  it("pins a listed processor a merchant names: no delete, no rename", async () => {
    await asPlatform(db);
    // TSYS is named by two seeded merchants.
    expect(await failureRolledBack(`delete from processors where code = 'TSYS'`)).toMatch(
      /merchants_processor_fkey/,
    );
    expect(
      await failureRolledBack(`update processors set code = 'TSYS Inc' where code = 'TSYS'`),
    ).toMatch(/merchants_processor_fkey/);
  });
});

describe("pre_apps.processor", () => {
  it("a rep sets a listed processor on their own draft, and is refused free text", async () => {
    const id = await idOf("pre_apps", "dba_name", "Agent Draft App");
    await asUser(db, AGENT_ID);
    await db.exec(`update pre_apps set processor = 'Red Fynn' where id = ${id}`);
    expect(
      await failure(`update pre_apps set processor = 'Red Fin' where id = ${id}`),
    ).toMatch(/pre_apps_processor_fkey/);
    await asPlatform(db);
    const [p] = await rows<{ processor: string }>(
      db,
      `select processor from pre_apps where id = ${id}`,
    );
    expect(p.processor).toBe("Red Fynn");
  });

  it("starts unset, and stays optional", async () => {
    await asPlatform(db);
    const found = await rows<{ processor: string | null }>(
      db,
      `select processor from pre_apps`,
    );
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((r) => r.processor === null)).toBe(true);
  });

  it("pins a processor a pre-app names", async () => {
    const id = await idOf("pre_apps", "dba_name", "Other Draft App");
    await asUser(db, OTHER_AGENT_ID);
    await db.exec(`update pre_apps set processor = 'PayBright' where id = ${id}`);
    await asPlatform(db);
    // PayBright is also on a seeded merchant; clear that one so only the
    // pre-app can be what refuses the delete.
    await db.exec(`update merchants set processor = null where processor = 'PayBright'`);
    expect(await failureRolledBack(`delete from processors where code = 'PayBright'`)).toMatch(
      /pre_apps_processor_fkey/,
    );
  });
});

describe("approve_pre_app copies the processor", () => {
  async function approveSubmitted(processor: string | null): Promise<string | null> {
    const id = await idOf("pre_apps", "dba_name", "Agent Submitted App");
    await asPlatform(db);
    // The seeded pre-app is already submitted, so it is frozen for everyone
    // but an admin or the state machine; the platform owner is neither, so
    // it borrows the state machine's flag, as seed() does.
    await db.exec(`select set_config('tapswipe.pre_app_transition', 'on', false)`);
    await db.exec(
      `update pre_apps set processor = ${processor === null ? "null" : `'${processor}'`}
        where id = ${id}`,
    );
    await db.exec(`select set_config('tapswipe.pre_app_transition', '', false)`);

    await asUser(db, ADMIN_ID);
    const [{ merchant_id }] = await rows<{ merchant_id: number }>(
      db,
      `select approve_pre_app(${id}) as merchant_id`,
    );
    await asPlatform(db);
    const [m] = await rows<{ processor: string | null }>(
      db,
      `select processor from merchants where id = ${merchant_id}`,
    );
    return m.processor;
  }

  it("carries a set processor across", async () => {
    expect(await approveSubmitted("Square")).toBe("Square");
  });

  it("carries an unset processor across as NULL", async () => {
    expect(await approveSubmitted(null)).toBeNull();
  });
});

describe("the migration's guard", () => {
  // A database exactly as it stood before this migration, with seed() data
  // in it: merchants.processor is still free text there.
  async function beforeProcessors(): Promise<TestDb> {
    const old = await createTestDb(await migrationsBefore(MIGRATION));
    await seed(old);
    await old.exec(`reset role; set request.jwt.claims = '';`);
    return old;
  }

  it("refuses a merchant processor outside the list, names it, and changes nothing", async () => {
    const old = await beforeProcessors();
    try {
      await old.exec(
        `update merchants set processor = 'First Data' where dba = 'Agent Active Co';
         update merchants set processor = 'Elavon' where dba = 'Other Active Co';`,
      );
      let message = "";
      try {
        await old.exec(await readMigration(MIGRATION));
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(/processors migration refuses to run/);
      expect(message).toContain(`'Elavon', 'First Data'`);

      // Nothing from the file landed: the guard runs first and the whole
      // file is one implicit transaction.
      const [state] = await old.query<{ t: string | null; c: string | null }>(
        `select to_regclass('public.processors')::text as t,
                (select column_name::text from information_schema.columns
                  where table_name = 'pre_apps' and column_name = 'processor') as c`,
      ).then((r) => r.rows);
      expect(state).toEqual({ t: null, c: null });
    } finally {
      await old.close();
    }
  });

  it("runs over valid and unset processors and leaves every value as it was", async () => {
    const old = await beforeProcessors();
    try {
      await old.exec(`update merchants set processor = null where dba = 'Other Active Co'`);
      const before = (
        await old.query<{ id: number; processor: string | null }>(
          `select id, processor from merchants order by id`,
        )
      ).rows;
      expect(before.some((m) => m.processor === null)).toBe(true);

      await old.exec(await readMigration(MIGRATION));

      const after = (
        await old.query<{ id: number; processor: string | null }>(
          `select id, processor from merchants order by id`,
        )
      ).rows;
      expect(after).toEqual(before);
    } finally {
      await old.close();
    }
  });
});
