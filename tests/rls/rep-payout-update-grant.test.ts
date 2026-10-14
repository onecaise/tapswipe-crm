import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_ID,
  AGENT_ID,
  PAYOUT_PERIOD,
  asPlatform,
  asUser,
  createTestDb,
  migrationsBefore,
  migrationsThrough,
  resetData,
  rows,
  seedPayouts,
  type PayoutFixtures,
  type TestDb,
} from "../helpers/db";

/**
 * 20261014160000 (phase 3b of docs/design/residual-splits.md): authenticated's
 * UPDATE on rep_payout_rows narrows from the table to (residual_income,
 * rep_split_pct). What this file pins:
 *
 *   * the privilege catalog changes in EXACTLY that way -- authenticated loses
 *     UPDATE on every other column and the table-level UPDATE, and nothing
 *     else moves; service_role is byte-identical;
 *   * a signed-in admin writing any other column is refused with a permission
 *     error, including when the statement also writes an allowed column;
 *   * the two app paths -- the inline figure cell and the per-rep bulk split --
 *     send exactly the statements they always did and still work, and the
 *     paths that write other columns (FK SET NULL, the owner) still work.
 *
 * The definer paths are pinned on the full schema elsewhere and run after this
 * migration there: commit_residual_import's ON CONFLICT DO UPDATE in
 * commit-residual-import.test.ts, set_shared_residual and the invoker
 * partner-rate copy in shared-lines.test.ts.
 */

const MIGRATION = "20261014160000_rep_payout_rows_update_columns.sql";
const EDITABLE = ["rep_split_pct", "residual_income"];

type DbError = { code?: string; message: string };

type Privilege = {
  grantee: string;
  column_name?: string;
  privilege_type: string;
  is_grantable: string;
};

async function columnPrivileges(db: TestDb): Promise<Privilege[]> {
  await asPlatform(db);
  return rows<Privilege>(
    db,
    `select grantee, column_name, privilege_type, is_grantable
       from information_schema.column_privileges
      where table_schema = 'public' and table_name = 'rep_payout_rows'
      order by grantee, column_name, privilege_type`,
  );
}

async function tablePrivileges(db: TestDb): Promise<Privilege[]> {
  await asPlatform(db);
  return rows<Privilege>(
    db,
    `select grantee, privilege_type, is_grantable
       from information_schema.table_privileges
      where table_schema = 'public' and table_name = 'rep_payout_rows'
      order by grantee, privilege_type`,
  );
}

const key = (p: Privilege) =>
  [p.grantee, p.column_name ?? "", p.privilege_type, p.is_grantable].join("|");

describe("the privilege catalog, before and after 20261014160000", () => {
  let before: TestDb;
  let after: TestDb;

  beforeAll(async () => {
    before = await createTestDb(await migrationsBefore(MIGRATION));
    after = await createTestDb(await migrationsThrough(MIGRATION));
  });

  afterAll(async () => {
    await Promise.all([before.close(), after.close()]);
  });

  it("column privileges: only authenticated's UPDATE on the other columns goes; nothing is added", async () => {
    const was = (await columnPrivileges(before)).map(key);
    const is = (await columnPrivileges(after)).map(key);

    const columns = await rows<{ name: string }>(
      after,
      `select attname as name from pg_attribute
        where attrelid = 'rep_payout_rows'::regclass and attnum > 0 and not attisdropped
        order by attname`,
    );
    const expectedRemoved = columns
      .map((c) => c.name)
      .filter((name) => !EDITABLE.includes(name))
      .map((name) => `authenticated|${name}|UPDATE|NO`)
      .sort();

    // Non-vacuous: before, authenticated really held UPDATE on every column.
    expect(expectedRemoved.length).toBeGreaterThan(20);
    expect(expectedRemoved.every((k) => was.includes(k))).toBe(true);

    expect(was.filter((k) => !is.includes(k)).sort()).toEqual(expectedRemoved);
    expect(is.filter((k) => !was.includes(k))).toEqual([]);

    // The two editable columns keep it.
    for (const name of EDITABLE) {
      expect(is).toContain(`authenticated|${name}|UPDATE|NO`);
    }
  });

  it("service_role's column privileges are identical", async () => {
    const sr = (list: Privilege[]) => list.filter((p) => p.grantee === "service_role");
    const was = sr(await columnPrivileges(before));
    expect(was.length).toBeGreaterThan(0);
    expect(sr(await columnPrivileges(after))).toEqual(was);
  });

  it("table privileges: authenticated's table-level UPDATE goes and nothing else moves", async () => {
    const was = (await tablePrivileges(before)).map(key);
    const is = (await tablePrivileges(after)).map(key);
    expect(was.filter((k) => !is.includes(k))).toEqual(["authenticated||UPDATE|NO"]);
    expect(is.filter((k) => !was.includes(k))).toEqual([]);
    // anon never had anything, and still has nothing.
    expect(is.filter((k) => k.startsWith("anon|"))).toEqual([]);
  });
});

describe("through a signed-in session, on the full schema", () => {
  let db: TestDb;
  let fx: PayoutFixtures;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await resetData(db);
    fx = await seedPayouts(db);
  });

  async function attempt(userId: string, sql: string) {
    await asUser(db, userId);
    try {
      const result = await db.query(sql);
      return { error: null as DbError | null, affected: result.affectedRows ?? 0 };
    } catch (error) {
      return { error: error as DbError, affected: 0 };
    } finally {
      await asPlatform(db);
    }
  }

  async function snapshot(id: number): Promise<Record<string, unknown>> {
    await asPlatform(db);
    const [row] = await rows<Record<string, unknown>>(
      db,
      `select to_jsonb(r) as row from rep_payout_rows r where id = ${id}`,
    );
    return row;
  }

  it("refuses an admin writing any other column, with a permission error, and changes nothing", async () => {
    const others = (
      await rows<{ name: string; generated: string }>(
        db,
        `select attname as name, attgenerated as generated from pg_attribute
          where attrelid = 'rep_payout_rows'::regclass and attnum > 0 and not attisdropped
          order by attname`,
      )
    )
      // rep_payout is generated: Postgres refuses any assignment to it before
      // privileges are checked ("can only be updated to DEFAULT"), for every
      // role, which rep-payouts.test.ts pins.
      .filter((c) => c.generated === "" && !EDITABLE.includes(c.name))
      .map((c) => c.name);
    expect(others.length).toBeGreaterThan(20);

    const before = await snapshot(fx.rowIds.filled);
    for (const column of others) {
      // A self-assignment: type-correct for every column, and still a write
      // the privilege check has to admit.
      const { error } = await attempt(
        ADMIN_ID,
        `update rep_payout_rows set ${column} = ${column} where id = ${fx.rowIds.filled}`,
      );
      expect(error?.code, column).toBe("42501");
      expect(error?.message, column).toMatch(/permission denied for table rep_payout_rows/);
    }
    expect(await snapshot(fx.rowIds.filled)).toEqual(before);
  });

  it("refuses the whole statement when an allowed column rides with a refused one", async () => {
    const before = await snapshot(fx.rowIds.filled);
    const { error } = await attempt(
      ADMIN_ID,
      `update rep_payout_rows set residual_income = 1.00, merchant_name = 'Renamed'
        where id = ${fx.rowIds.filled}`,
    );
    expect(error?.code).toBe("42501");
    expect(await snapshot(fx.rowIds.filled)).toEqual(before);
  });

  it("the inline figure cell: one figure by id, exactly as the component sends it", async () => {
    for (const [sql, field] of [
      [`update rep_payout_rows set residual_income = 91.00 where id = ${fx.rowIds.filled}`, "residual_income"],
      [`update rep_payout_rows set rep_split_pct = 55 where id = ${fx.rowIds.filled}`, "rep_split_pct"],
    ]) {
      const { error, affected } = await attempt(ADMIN_ID, sql);
      expect(error, field).toBeNull();
      expect(affected, field).toBe(1);
    }
    const [row] = await rows<{ rep_payout: string; history: number }>(
      db,
      `select rep_payout::text,
              (select count(*)::int from rep_payout_row_history where row_id = ${fx.rowIds.filled}
                  and changed_by = '${ADMIN_ID}') as history
         from rep_payout_rows where id = ${fx.rowIds.filled}`,
    );
    // round(91.00 x 55 / 100, 2) = 50.05; one history row per edit, the admin's.
    expect(row).toEqual({ rep_payout: "50.05", history: 2 });
  });

  it("the bulk split: one rep's rate for one period, exactly as the component sends it", async () => {
    const { error, affected } = await attempt(
      ADMIN_ID,
      `update rep_payout_rows set rep_split_pct = 55.55
        where period = '${PAYOUT_PERIOD}' and agent_id = '${AGENT_ID}'`,
    );
    expect(error).toBeNull();
    // AGENT_ID's filled and blank rows in the current period, and nothing else.
    expect(affected).toBe(2);
    const rates = await rows<{ id: number; rep_split_pct: string }>(
      db,
      `select id, rep_split_pct::text from rep_payout_rows
        where rep_split_pct = 55.55 order by id`,
    );
    expect(rates.map((r) => r.id)).toEqual([fx.rowIds.filled, fx.rowIds.blank].sort((a, b) => a - b));
  });

  it("a rep still gets zero rows, not an error: the grant admits, the policy filters", async () => {
    const { error, affected } = await attempt(
      AGENT_ID,
      `update rep_payout_rows set residual_income = 1.00 where id = ${fx.rowIds.filled}`,
    );
    expect(error).toBeNull();
    expect(affected).toBe(0);
  });

  it("an admin deleting a merchant still clears merchant_id: FK actions run as the owner", async () => {
    await asPlatform(db);
    const [{ id: merchantId }] = await rows<{ id: number }>(
      db,
      `select id from merchants where mid = 'MID-OTHER-1'`,
    );
    // seed() files a support ticket against this merchant, and that FK is NO
    // ACTION; it has nothing to do with the ledger, so it goes first.
    await db.exec(`delete from support_tickets where merchant_id = ${merchantId}`);
    const { error } = await attempt(ADMIN_ID, `delete from merchants where id = ${merchantId}`);
    expect(error).toBeNull();
    const [row] = await rows<{ merchant_id: number | null }>(
      db,
      `select merchant_id from rep_payout_rows where id = ${fx.rowIds.other}`,
    );
    expect(row.merchant_id).toBeNull();
  });
});
