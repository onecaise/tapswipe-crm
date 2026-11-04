import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_ID,
  AGENT_ID,
  asPlatform,
  asUser,
  commitV3,
  createTestDb,
  insertBatch,
  migrationsBefore,
  migrationsThrough,
  OTHER_AGENT_ID,
  resetData,
  rows,
  seedPayouts,
  stageForCommit,
  type PayoutFixtures,
  type TestDb,
} from "../helpers/db";

/**
 * What stays of 20261016140000 (phase 4b of docs/design/residual-splits.md):
 * authenticated's UPDATE on rep_payout_batches narrowed to (status), and the
 * preview-flag columns on the staging rows.
 *
 * Was tests/rls/acknowledge-residual-skips.test.ts. The acknowledgement, the
 * skip record it reviewed and the old commit's reworded guard went in
 * 20261104140000 (phase 13 of docs/design/intake-and-reports.md), with their
 * tests; that migration's own file is tests/rls/retire-legacy-import.test.ts.
 *
 * What this file pins:
 *
 *   1. The grant: the catalog changed in exactly the way intended when it
 *      was narrowed; an admin's session can still abandon a batch and can
 *      PATCH no other column of it; no rep reads a batch at all.
 *   2. The staging columns' vocabulary, as 20261104140000 left it.
 */

const MIGRATION = "20261016140000_residual_skips_and_preview_flags.sql";

type DbError = { code?: string; message: string };

async function attempt(fn: () => Promise<unknown>): Promise<DbError | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error as DbError;
  }
}

type BatchState = { status: string; row_count: number; committed: boolean };

async function batchState(db: TestDb, batchId: number): Promise<BatchState> {
  await asPlatform(db);
  const [row] = await rows<BatchState>(
    db,
    `select status, row_count, committed_at is not null as committed
       from rep_payout_batches where id = ${batchId}`,
  );
  return row;
}

/** seedPayouts' batches, plus one committed through v3. */
async function scenario(db: TestDb): Promise<{ committedBatch: number; fx: PayoutFixtures }> {
  await resetData(db);
  const fx = await seedPayouts(db);
  await asPlatform(db);

  const committedBatch = await insertBatch(db);
  await stageForCommit(db, committedBatch, [{ mid: "MID-AGENT-2" }]);
  // MID-AGENT-2 is an inactive Square merchant: both warnings, confirmed.
  expect(await commitV3(db, committedBatch, ["inactive_merchant", "processor_mismatch"])).toMatchObject({ written: 1 });

  await db.exec(`delete from audit_log`);
  return { committedBatch, fx };
}

// -------------------------------------------------------------------------
// 1. The batch UPDATE grant.
// -------------------------------------------------------------------------

type Privilege = { grantee: string; column_name?: string; privilege_type: string; is_grantable: string };

async function batchPrivileges(db: TestDb, view: "column_privileges" | "table_privileges"): Promise<string[]> {
  await asPlatform(db);
  const columns = view === "column_privileges" ? "grantee, column_name, privilege_type, is_grantable" : "grantee, privilege_type, is_grantable";
  const list = await rows<Privilege>(
    db,
    `select ${columns} from information_schema.${view}
      where table_schema = 'public' and table_name = 'rep_payout_batches'
      order by 1, 2, 3`,
  );
  return list.map((p) => [p.grantee, p.column_name ?? "", p.privilege_type, p.is_grantable].join("|"));
}

describe("the rep_payout_batches privilege catalog, before and after", () => {
  let before: TestDb;
  let after: TestDb;

  beforeAll(async () => {
    before = await createTestDb(await migrationsBefore(MIGRATION));
    after = await createTestDb(await migrationsThrough(MIGRATION));
  });
  afterAll(async () => {
    await Promise.all([before.close(), after.close()]);
  });

  it("column privileges: authenticated's UPDATE goes from every column but status; nothing is added", async () => {
    const was = await batchPrivileges(before, "column_privileges");
    const is = await batchPrivileges(after, "column_privileges");

    const names = await rows<{ name: string }>(
      after,
      `select attname as name from pg_attribute
        where attrelid = 'rep_payout_batches'::regclass and attnum > 0 and not attisdropped`,
    );
    const expectedRemoved = names
      .map((c) => c.name)
      .filter((name) => name !== "status")
      .map((name) => `authenticated|${name}|UPDATE|NO`)
      .sort();

    // Non-vacuous: before, authenticated could PATCH the skip record (the
    // columns this migration added, dropped again by 20261104140000).
    expect(was).toContain("authenticated|skipped_rows|UPDATE|NO");
    expect(was).toContain("authenticated|skips_acknowledged_at|UPDATE|NO");
    expect(expectedRemoved.every((k) => was.includes(k))).toBe(true);

    expect(was.filter((k) => !is.includes(k)).sort()).toEqual(expectedRemoved);
    expect(is.filter((k) => !was.includes(k))).toEqual([]);
    expect(is).toContain("authenticated|status|UPDATE|NO");
  });

  it("table privileges: only authenticated's table-level UPDATE goes", async () => {
    const was = await batchPrivileges(before, "table_privileges");
    const is = await batchPrivileges(after, "table_privileges");
    expect(was.filter((k) => !is.includes(k))).toEqual(["authenticated||UPDATE|NO"]);
    expect(is.filter((k) => !was.includes(k))).toEqual([]);
    expect(is.filter((k) => k.startsWith("anon|"))).toEqual([]);
  });
});

describe("through a signed-in session", () => {
  let db: TestDb;
  let committedBatch: number;
  let fx: PayoutFixtures;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    ({ committedBatch, fx } = await scenario(db));
  });

  it("an admin still abandons a batch: lib/residual-batches.ts's exact statement", async () => {
    await asUser(db, ADMIN_ID);
    await db.query(`update rep_payout_batches set status = 'abandoned' where id = ${fx.batchIds.review}`);
    expect((await batchState(db, fx.batchIds.review)).status).toBe("abandoned");
  });

  it.each([
    ["row_count", "0"],
    ["committed_at", "null"],
    ["confirmed_warnings", `'{}'::jsonb`],
    ["file_key", `'elsewhere.xlsx'`],
  ])("an admin's session cannot write %s", async (column, value) => {
    await asUser(db, ADMIN_ID);
    const error = await attempt(() =>
      db.query(`update rep_payout_batches set ${column} = ${value} where id = ${committedBatch}`),
    );
    expect(error?.code).toBe("42501");
    expect(error?.message).toMatch(/permission denied/);
    expect(await batchState(db, committedBatch)).toEqual({ status: "committed", row_count: 1, committed: true });
  });

  it("refuses the column even when status rides along", async () => {
    await asUser(db, ADMIN_ID);
    const error = await attempt(() =>
      db.query(`update rep_payout_batches set status = 'committed', row_count = 0 where id = ${committedBatch}`),
    );
    expect(error?.code).toBe("42501");
    expect((await batchState(db, committedBatch)).row_count).toBe(1);
  });

  it("no rep can read a batch", async () => {
    for (const rep of [AGENT_ID, OTHER_AGENT_ID]) {
      await asUser(db, rep);
      expect(await rows(db, `select id, row_count, confirmed_warnings from rep_payout_batches`), rep).toEqual([]);
    }
    // Not vacuous: the admin reads them.
    await asUser(db, ADMIN_ID);
    expect(await rows(db, `select id from rep_payout_batches where id = ${committedBatch}`)).toHaveLength(1);
    await asPlatform(db);
  });

  it("a rep's status write reaches no batch", async () => {
    await asUser(db, AGENT_ID);
    await db.query(`update rep_payout_batches set status = 'abandoned'`);
    await asPlatform(db);
    expect((await batchState(db, fx.batchIds.review)).status).toBe("review");
  });
});

// -------------------------------------------------------------------------
// 2. The staging columns.
// -------------------------------------------------------------------------

describe("rep_payout_import_rows preview columns", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
    await resetData(db);
    await seedPayouts(db);
  });
  afterAll(async () => {
    await db.close();
  });

  it("accept the two notes the parser writes and null, and refuse anything else", async () => {
    await asPlatform(db);
    // share_not_in_force (20261016161000) and payee_changed (20261030140000);
    // the other four were retired by 20261104140000.
    for (const flag of ["share_not_in_force", "payee_changed"]) {
      await db.query(`update rep_payout_import_rows set preview_flag = '${flag}', preview_note = 'x'`);
    }
    await db.query(`update rep_payout_import_rows set preview_flag = null, preview_note = null`);
    for (const flag of ["non_standard_rate", "share_not_applied", "partner_named", "line_not_shared", "looks_shared"]) {
      const error = await attempt(() => db.query(`update rep_payout_import_rows set preview_flag = '${flag}'`));
      expect(error?.message, flag).toMatch(/preview_flag_check/);
    }
  });

  it("are readable by an admin and by no rep", async () => {
    await asUser(db, ADMIN_ID);
    expect((await rows(db, `select preview_flag, preview_note from rep_payout_import_rows`)).length).toBeGreaterThan(0);
    await asUser(db, AGENT_ID);
    expect(await rows(db, `select preview_flag from rep_payout_import_rows`)).toEqual([]);
    await asPlatform(db);
  });
});
