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
 *   * on the FULL schema, since 20261102140000 (phase 11 of
 *     docs/design/intake-and-reports.md) the two columns went too: NO client
 *     role -- a rep, an admin, anon -- updates a ledger line at all, not even
 *     with the statements the removed inline cell and bulk split sent; the
 *     paths that are not clients (FK SET NULL, the owner) still work.
 *
 * The lock itself (the trigger behind the grant, the migration's refusals, and
 * that replace and adjustment still work) is tests/rls/lock-residuals.test.ts.
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

describe("through a signed-in session, on the full schema (no client UPDATE since 20261102140000)", () => {
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

  async function attempt(userId: string | null, sql: string, anon = false) {
    await asUser(db, userId);
    if (anon) await db.exec(`set role anon`);
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

  it("refuses an admin writing ANY column -- the two figures included -- with a permission error, and changes nothing", async () => {
    const columns = (
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
      .filter((c) => c.generated === "")
      .map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(EDITABLE));
    expect(columns.length).toBeGreaterThan(20);

    const before = await snapshot(fx.rowIds.filled);
    for (const column of columns) {
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

  it("the removed inline figure cell's statements are refused, and write no history", async () => {
    for (const sql of [
      `update rep_payout_rows set residual_income = 91.00 where id = ${fx.rowIds.filled}`,
      `update rep_payout_rows set rep_split_pct = 55 where id = ${fx.rowIds.filled}`,
    ]) {
      const { error, affected } = await attempt(ADMIN_ID, sql);
      expect(error?.code, sql).toBe("42501");
      expect(affected).toBe(0);
    }
    expect(await rows(db, `select count(*)::int as n from rep_payout_row_history`)).toEqual([{ n: 0 }]);
  });

  it("the removed bulk split's statement is refused, and no rate moves", async () => {
    const { error } = await attempt(
      ADMIN_ID,
      `update rep_payout_rows set rep_split_pct = 55.55
        where period = '${PAYOUT_PERIOD}' and agent_id = '${AGENT_ID}'`,
    );
    expect(error?.code).toBe("42501");
    expect(await rows(db, `select count(*)::int as n from rep_payout_rows where rep_split_pct = 55.55`)).toEqual([{ n: 0 }]);
  });

  it("a rep is refused outright (it was filtered to zero rows while the grant existed); so is anon", async () => {
    const rep = await attempt(AGENT_ID, `update rep_payout_rows set residual_income = 1.00 where id = ${fx.rowIds.filled}`);
    expect(rep.error?.code).toBe("42501");
    const anon = await attempt(null, `update rep_payout_rows set residual_income = 1.00 where id = ${fx.rowIds.filled}`, true);
    expect(anon.error?.code).toBe("42501");
    expect((await snapshot(fx.rowIds.filled)).row).toMatchObject({ residual_income: 88.4 });
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
