import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AGENT_ID,
  asPlatform,
  asUser,
  createTestDb,
  rows,
  seed,
  type TestDb,
} from "../helpers/db";

const INITIAL_MIGRATION = "20260804201300_initial_schema.sql";
const GATING_MIGRATION =
  "20260805103000_add_is_active_agent_and_profile_self_service.sql";

type LeadRow = { id: number; dba: string };
type CountRow = { n: number };

async function deactivate(db: TestDb, userId: string) {
  await asPlatform(db);
  await db.exec(`update profiles set is_active = false where id = '${userId}';`);
}

describe("deactivated agents lose own-row access (current schema)", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
    await seed(db);
  });

  afterAll(async () => {
    await db?.close();
  });

  it("sees their own leads while active", async () => {
    await asUser(db, AGENT_ID);
    const result = await rows<LeadRow>(db, `select id, dba from leads`);

    // Baseline: the gating must not break the normal case.
    expect(result).toHaveLength(2);
  });

  it("sees no leads once deactivated", async () => {
    await deactivate(db, AGENT_ID);
    await asUser(db, AGENT_ID);

    const result = await rows<LeadRow>(db, `select id, dba from leads`);
    expect(result).toHaveLength(0);
  });

  it("cannot insert a lead once deactivated", async () => {
    await asUser(db, AGENT_ID);

    await expect(
      db.exec(
        `insert into leads (agent_id, dba) values ('${AGENT_ID}', 'Sneaky Lead');`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("cannot update their existing leads once deactivated", async () => {
    await asUser(db, AGENT_ID);

    // Filtered, not refused: the USING clause hides the rows, so the update
    // matches nothing rather than erroring.
    await db.exec(`update leads set dba = 'Renamed' where dba = 'Agent Lead A';`);

    await asPlatform(db);
    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from leads where dba = 'Agent Lead A'`,
    );
    expect(n).toBe(1);
  });

  it("cannot rename themselves via update_own_full_name() once deactivated", async () => {
    await asUser(db, AGENT_ID);

    // The RPC is security definer, so it's the one write path to profiles that
    // doesn't pass through RLS. Its explicit guard is what closes that gap.
    await expect(
      db.exec(`select update_own_full_name('Hacked Name');`),
    ).rejects.toThrow(/account is deactivated/i);

    await asPlatform(db);
    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from profiles where full_name = 'Agent User'`,
    );
    expect(n).toBe(1);
  });

  it("can rename themselves via update_own_full_name() while active", async () => {
    await asPlatform(db);
    await db.exec(`update profiles set is_active = true where id = '${AGENT_ID}';`);

    await asUser(db, AGENT_ID);
    await db.exec(`select update_own_full_name('Renamed Agent');`);

    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from profiles
       where id = '${AGENT_ID}' and full_name = 'Renamed Agent' and role = 'agent'`,
    );
    // role unchanged too: the RPC only ever touches full_name.
    expect(n).toBe(1);
  });
});

/**
 * Proves the gating migration actually changes behavior.
 *
 * Without this, the suite above could be passing for an unrelated reason and
 * we'd have no evidence the migration fixed anything. Applying only the initial
 * schema reproduces the original hole: a deactivated agent keeps full access to
 * their own rows. If someone later reverts the gating, the suite above fails and
 * this one still passes, which points straight at the cause.
 */
describe("regression: the hole the gating migration closes", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb([INITIAL_MIGRATION]);
    await seed(db);
  });

  afterAll(async () => {
    await db?.close();
  });

  it("initial schema alone lets a deactivated agent still read their leads", async () => {
    await deactivate(db, AGENT_ID);
    await asUser(db, AGENT_ID);

    const result = await rows<LeadRow>(db, `select id, dba from leads`);

    // This is the bug. It is asserted here so the fix above is demonstrably
    // load-bearing rather than assumed.
    expect(result).toHaveLength(2);
  });

  it("initial schema alone lets a deactivated agent still insert leads", async () => {
    await asUser(db, AGENT_ID);

    await db.exec(
      `insert into leads (agent_id, dba) values ('${AGENT_ID}', 'Written While Deactivated');`,
    );

    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from leads where dba = 'Written While Deactivated'`,
    );
    expect(n).toBe(1);
  });

  it("has no is_active_agent() function at all", async () => {
    await asPlatform(db);
    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from pg_proc where proname = 'is_active_agent'`,
    );
    expect(n).toBe(0);
  });
});

describe("the gating migration is what introduces the helpers", () => {
  it("defines is_active_agent() and update_own_full_name() as security definer", async () => {
    const db = await createTestDb([INITIAL_MIGRATION, GATING_MIGRATION]);
    await asPlatform(db);

    const result = await rows<{ proname: string; prosecdef: boolean }>(
      db,
      `select proname, prosecdef from pg_proc
       where proname in ('is_admin', 'is_active_agent', 'update_own_full_name')
       order by proname`,
    );

    expect(result.map((r) => r.proname)).toEqual([
      "is_active_agent",
      "is_admin",
      "update_own_full_name",
    ]);
    // All three bypass RLS by design; if any lost security definer, policies on
    // profiles would recurse and the RPC would stop working entirely.
    expect(result.every((r) => r.prosecdef)).toBe(true);

    await db.close();
  });

  it("leaves the three secrets tables with zero policies", async () => {
    const db = await createTestDb();
    await asPlatform(db);

    const result = await rows<{ tablename: string; n: number }>(
      db,
      `select c.relname as tablename, count(p.polname)::int as n
       from pg_class c
       left join pg_policy p on p.polrelid = c.oid
       where c.relname in (
         'pre_app_owner_secrets', 'pre_app_banking_secrets', 'pre_app_terminal_secrets'
       )
       group by c.relname
       order by c.relname`,
    );

    expect(result).toHaveLength(3);
    expect(result.every((r) => r.n === 0)).toBe(true);

    await db.close();
  });
});
