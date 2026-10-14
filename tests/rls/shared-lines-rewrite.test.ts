import { afterAll, describe, expect, it } from "vitest";

import {
  ADMIN_ID,
  AGENT_ID,
  OTHER_AGENT_ID,
  asPlatform,
  asUser,
  createTestDb,
  migrationsBefore,
  migrationsThrough,
  readMigration,
  rows,
  seed,
  type TestDb,
} from "../helpers/db";

/**
 * 20261014140000 drops rep_payout_rows.rep_payout and re-adds it with three
 * more branches (phase 3 of docs/design/residual-splits.md). This file is the
 * proof that doing so changed NOTHING that already existed:
 *
 *   * every existing payout, to the cent, over 70,000+ awkward rows;
 *   * the same batches committed and edited before and after the migration
 *     produce identical ledgers, history and audit rows;
 *   * every privilege, index, policy and trigger that existed before is
 *     byte-identical after, and the only additions are the expected ones;
 *   * the migration's own guard refuses a rewrite that would move a value,
 *     even one that keeps the total, and leaves nothing half-applied;
 *   * it refuses to drop a column something hand-made depends on;
 *   * the copy it checks against is gone afterwards.
 *
 * The shared branch's behaviour is in tests/rls/shared-lines.test.ts.
 */

const MIGRATION = "20261014140000_shared_lines.sql";

/** The unshared branch exactly as the migration writes it. */
const UNSHARED_BRANCH =
  "      when share_role is null then\n        round(residual_income * rep_split_pct / 100, 2)";

const opened: TestDb[] = [];

async function dbBefore(): Promise<TestDb> {
  const db = await createTestDb(await migrationsBefore(MIGRATION));
  opened.push(db);
  return db;
}

/**
 * The schema exactly as this migration left it -- not every migration, because
 * later ones change this table on purpose (20261014150000 adds a constraint,
 * 20261014160000 narrows the UPDATE grant) and this file's claims are about
 * 20261014140000 alone.
 */
async function dbAfter(): Promise<TestDb> {
  const db = await createTestDb(await migrationsThrough(MIGRATION));
  opened.push(db);
  return db;
}

afterAll(async () => {
  await Promise.all(opened.map((db) => db.close()));
});

async function applyMigration(db: TestDb, sql?: string): Promise<void> {
  await asPlatform(db);
  await db.exec(sql ?? (await readMigration(MIGRATION)));
}

/** "70,007 rows" of the shapes most likely to move under a careless rewrite. */
async function insertAwkwardRows(db: TestDb): Promise<number> {
  await asPlatform(db);
  await db.exec(`
    -- Every cent from -$50.00 to $50.00 at seven rates, including NULL, 0, 100
    -- and the two that produce the most half-cent ties.
    insert into rep_payout_rows (agent_id, period, mid, residual_income, rep_split_pct)
    select case when g % 2 = 0 then '${AGENT_ID}'::uuid else '${OTHER_AGENT_ID}'::uuid end,
           '2026-07-01', 'SNAP-' || g || '-' || r.n, (g * 0.01)::numeric(14,2), r.pct
      from generate_series(-5000, 5000) as g
     cross join (values (1, 50.00::numeric(5,2)), (2, 33.33), (3, 0.00), (4, 100.00),
                        (5, 99.99), (6, null), (7, 60.00)) as r(n, pct);

    -- Blank residual against every rate; large values at the edges of
    -- numeric(14,2); zero.
    insert into rep_payout_rows (agent_id, period, mid, residual_income, rep_split_pct)
    values
      ('${AGENT_ID}', '2026-06-01', 'BLANK-1', null, 50.00),
      ('${AGENT_ID}', '2026-06-01', 'BLANK-2', null, null),
      ('${AGENT_ID}', '2026-06-01', 'BIG-1',  999999999999.99, 100.00),
      ('${AGENT_ID}', '2026-06-01', 'BIG-2', -999999999999.99, 100.00),
      ('${AGENT_ID}', '2026-06-01', 'BIG-3',  999999999999.99, 50.00),
      ('${AGENT_ID}', '2026-06-01', 'BIG-4', -999999999999.99, 0.01),
      ('${AGENT_ID}', '2026-06-01', 'ZERO-1', 0.00, 50.00),
      ('${AGENT_ID}', '2026-06-01', 'ZERO-2', 0.00, null);
  `);
  const [{ n }] = await rows<{ n: number }>(db, `select count(*)::int as n from rep_payout_rows`);
  return n;
}

type Snapshot = { rows: number; total: string | null; values: string[] };

async function payoutSnapshot(db: TestDb): Promise<Snapshot> {
  await asPlatform(db);
  const values = await rows<{ v: string }>(
    db,
    `select id || ':' || coalesce(rep_payout::text, 'null') as v
       from rep_payout_rows order by id`,
  );
  const [{ total }] = await rows<{ total: string | null }>(
    db,
    `select sum(rep_payout)::text as total from rep_payout_rows`,
  );
  return { rows: values.length, total, values: values.map((row) => row.v) };
}

describe("every existing payout is unchanged to the cent", () => {
  it("over 70,000 awkward rows: blanks, negatives, exact half-cent ties, large values, zero", async () => {
    const db = await dbBefore();
    await seed(db);
    await asPlatform(db);
    await db.exec(`delete from rep_payout_rows`);
    const inserted = await insertAwkwardRows(db);
    expect(inserted).toBe(10_001 * 7 + 8);

    // Non-vacuous: the grid really contains exact half-cent ties (where
    // round() decides the cent) on both sides of zero, nulls and zeros.
    const [shape] = await rows<{
      ties_pos: number;
      ties_neg: number;
      nulls: number;
      zeros: number;
    }>(
      db,
      `select
         count(*) filter (where mod(abs(residual_income * rep_split_pct), 1) = 0.5
                            and residual_income > 0)::int as ties_pos,
         count(*) filter (where mod(abs(residual_income * rep_split_pct), 1) = 0.5
                            and residual_income < 0)::int as ties_neg,
         count(*) filter (where rep_payout is null)::int as nulls,
         count(*) filter (where rep_payout = 0)::int as zeros
         from rep_payout_rows`,
    );
    expect(shape.ties_pos).toBeGreaterThan(1000);
    expect(shape.ties_neg).toBeGreaterThan(1000);
    expect(shape.nulls).toBeGreaterThan(10_000);
    expect(shape.zeros).toBeGreaterThan(10_000);

    const before = await payoutSnapshot(db);
    await applyMigration(db);
    const after = await payoutSnapshot(db);

    expect(after.rows).toBe(before.rows);
    expect(after.total).toBe(before.total);
    // Compared value by value so a failure names the row, not just a count.
    const moved = before.values.filter((value, i) => after.values[i] !== value);
    expect(moved).toEqual([]);

    // And every new column is empty on every one of them.
    const [{ not_empty }] = await rows<{ not_empty: number }>(
      db,
      `select count(*)::int as not_empty from rep_payout_rows
        where line_kind <> 'import'
           or rep_share_id is not null or share_role is not null
           or account_residual_income is not null
           or primary_rep_pct is not null or secondary_rep_pct is not null
           or adjustment_amount is not null or adjusts_period is not null
           or adjustment_note is not null`,
    );
    expect(not_empty).toBe(0);
  });
});

describe("the same batches give the same results before and after", () => {
  /**
   * A scenario run identically on a database before 20261014140000 and on one
   * after it: two committed batches (a fresh processor file, then a corrected
   * one that also carries round-trip figures), an inline edit and a per-rep
   * bulk split. Everything the existing code writes is compared.
   */
  async function runScenario(db: TestDb) {
    await seed(db);
    await asPlatform(db);
    await db.exec(`
      update profiles set agent_number = '4471' where id = '${AGENT_ID}';
      update profiles set agent_number = '9902' where id = '${OTHER_AGENT_ID}';
      insert into rep_payout_batches (imported_by, file_key, file_name, status)
      values ('${ADMIN_ID}', 'g/a.xlsx', 'a.xlsx', 'review'),
             ('${ADMIN_ID}', 'g/b.xlsx', 'b.xlsx', 'review');
    `);
    const batches = await rows<{ id: number }>(db, `select id from rep_payout_batches order by id`);
    const [a, b] = batches.map((batch) => batch.id);

    const staged = (batch: number, rowsSql: string) => `
      insert into rep_payout_import_rows
        (batch_id, row_number, mid_raw, merchant_name_raw, period, agent_id, merchant_id,
         volume, average_ticket, total_cost, residual_income, rep_split_pct)
      select ${batch}, n, mid, name, '2026-07-01', agent, (select id from merchants m where m.mid = v.mid),
             volume, ticket, cost, residual, split
        from (values ${rowsSql}) as v(n, mid, name, agent, volume, ticket, cost, residual, split);`;

    // Batch A: a fresh processor file -- no residual, no split.
    await db.exec(
      staged(
        a,
        `(2, 'MID-AGENT-1', 'Agent Active Co', '${AGENT_ID}'::uuid, 12400.00, 62.00, 310.00, null::numeric, null::numeric),
         (3, 'MID-AGENT-2', 'Agent Inactive Co', '${AGENT_ID}'::uuid, 5100.00, 34.00, -128.00, null, null),
         (4, 'MID-OTHER-1', 'Other Active Co', '${OTHER_AGENT_ID}'::uuid, 9900.00, 45.00, 250.00, null, null),
         (5, 'MID-SHARED-SOMEDAY', 'Two Rep Co', '${AGENT_ID}'::uuid, 100.00, 1.00, 1.00, null, null),
         (6, 'MID-SHARED-SOMEDAY', 'Two Rep Co', '${OTHER_AGENT_ID}'::uuid, 100.00, 1.00, 1.00, null, null)`,
      ),
    );
    // Batch B: corrected volumes, plus round-trip figures -- a negative, an
    // exact half-cent tie, a large value, a zero, and one row left blank so the
    // coalesce keeps whatever is there.
    await db.exec(
      staged(
        b,
        `(2, 'MID-AGENT-1', 'Agent Active Co RENAMED', '${AGENT_ID}'::uuid, 13100.00, 63.00, 300.00, -100.01::numeric, 50.00::numeric),
         (3, 'MID-AGENT-2', 'Agent Inactive Co', '${AGENT_ID}'::uuid, 5200.00, 34.00, -128.00, 0.03, 50.00),
         (4, 'MID-OTHER-1', 'Other Active Co', '${OTHER_AGENT_ID}'::uuid, 9900.00, 45.00, 250.00, 999999999.99, 33.33),
         (5, 'MID-SHARED-SOMEDAY', 'Two Rep Co', '${AGENT_ID}'::uuid, 100.00, 1.00, 1.00, 0.00, 60.00),
         (6, 'MID-SHARED-SOMEDAY', 'Two Rep Co', '${OTHER_AGENT_ID}'::uuid, 100.00, 1.00, 1.00, null, null)`,
      ),
    );

    await asUser(db, ADMIN_ID);
    const [{ ra }] = await rows<{ ra: number }>(db, `select commit_residual_import(${a}) as ra`);
    const [{ rb }] = await rows<{ rb: number }>(db, `select commit_residual_import(${b}) as rb`);

    // The inline edit and the bulk split, exactly as the two components send them.
    await db.query(
      `update rep_payout_rows set residual_income = 88.45
        where mid = 'MID-SHARED-SOMEDAY' and agent_id = '${OTHER_AGENT_ID}'`,
    );
    await db.query(
      `update rep_payout_rows set rep_split_pct = 55.55
        where agent_id = '${AGENT_ID}' and period = '2026-07-01'`,
    );
    await asPlatform(db);

    return {
      returned: [ra, rb],
      ledger: await rows(
        db,
        `select id, agent_id, period::text, mid, merchant_name, merchant_id,
                volume::text, average_ticket::text, total_cost::text,
                residual_income::text, rep_split_pct::text, rep_payout::text, batch_id
           from rep_payout_rows order by id`,
      ),
      history: await rows(
        db,
        `select row_id, period::text, agent_id, mid, field,
                old_value::text, new_value::text, changed_by
           from rep_payout_row_history order by id`,
      ),
      audit: await rows(
        db,
        `select actor_id, action, table_name, row_id from audit_log
          where table_name in ('rep_payout_batches', 'rep_payout_rows') order by id`,
      ),
      batches: await rows(
        db,
        `select id, status, row_count from rep_payout_batches order by id`,
      ),
      staging: await rows(db, `select count(*)::int as n from rep_payout_import_rows`),
    };
  }

  it("commits, edits and audits identically", async () => {
    const before = await runScenario(await dbBefore());
    const after = await runScenario(await dbAfter());

    // Non-vacuous: the scenario really wrote figures, history and audit rows.
    // seed() writes no ledger rows, so these are exactly batch A's five lines,
    // updated in place by batch B.
    expect(before.ledger.length).toBe(5);
    expect(before.history.length).toBeGreaterThan(5);
    expect(before.audit.length).toBe(2);

    expect(after).toEqual(before);
  });
});

describe("nothing that existed before the migration differs after it", () => {
  async function catalog(db: TestDb) {
    await asPlatform(db);
    return {
      columnPrivileges: await rows<{ column_name: string }>(
        db,
        `select grantee, column_name, privilege_type, is_grantable
           from information_schema.column_privileges
          where table_schema = 'public' and table_name = 'rep_payout_rows'
          order by column_name, grantee, privilege_type`,
      ),
      tablePrivileges: await rows(
        db,
        `select grantee, privilege_type, is_grantable
           from information_schema.table_privileges
          where table_schema = 'public' and table_name = 'rep_payout_rows'
          order by grantee, privilege_type`,
      ),
      indexes: await rows<{ indexname: string }>(
        db,
        `select indexname, indexdef from pg_indexes
          where schemaname = 'public' and tablename = 'rep_payout_rows'
          order by indexname`,
      ),
      policies: await rows(
        db,
        `select policyname, permissive, roles::text, cmd, qual, with_check
           from pg_policies where tablename = 'rep_payout_rows' order by policyname`,
      ),
      triggers: await rows<{ tgname: string }>(
        db,
        `select tgname, pg_get_triggerdef(oid) as def from pg_trigger
          where tgrelid = 'rep_payout_rows'::regclass and not tgisinternal
          order by tgname`,
      ),
      columns: await rows<{ column_name: string }>(
        db,
        `select column_name, data_type, numeric_precision, numeric_scale, is_nullable
           from information_schema.columns
          where table_schema = 'public' and table_name = 'rep_payout_rows'
          order by column_name`,
      ),
    };
  }

  const NEW_COLUMNS = [
    "account_residual_income",
    "adjustment_amount",
    "adjustment_note",
    "adjusts_period",
    "line_kind",
    "primary_rep_pct",
    "rep_share_id",
    "secondary_rep_pct",
    "share_role",
  ];

  it("column and table privileges, indexes, policies, triggers and column types", async () => {
    const before = await catalog(await dbBefore());
    const after = await catalog(await dbAfter());

    // Privileges on every column that existed before -- rep_payout included,
    // which is the one the drop-and-re-add could have lost -- are identical.
    const oldColumnPrivileges = after.columnPrivileges.filter(
      (row) => !NEW_COLUMNS.includes(row.column_name),
    );
    expect(oldColumnPrivileges).toEqual(before.columnPrivileges);
    expect(before.columnPrivileges.some((row) => row.column_name === "rep_payout")).toBe(true);
    expect(after.tablePrivileges).toEqual(before.tablePrivileges);

    // Every pre-existing index, policy and trigger, byte for byte.
    const kept = <T extends Record<string, unknown>>(
      list: T[],
      key: keyof T,
      names: unknown[],
    ) => list.filter((row) => names.includes(row[key]));
    expect(kept(after.indexes, "indexname", before.indexes.map((i) => i.indexname))).toEqual(
      before.indexes,
    );
    expect(after.policies).toEqual(before.policies);
    expect(kept(after.triggers, "tgname", before.triggers.map((t) => t.tgname))).toEqual(
      before.triggers,
    );

    // Pre-existing columns keep their types; rep_payout is still numeric(14,2).
    expect(
      after.columns.filter((column) => !NEW_COLUMNS.includes(column.column_name)),
    ).toEqual(before.columns);

    // And the only additions are the ones the migration means to make.
    expect(
      after.indexes.map((i) => i.indexname).filter(
        (name) => !before.indexes.some((i) => i.indexname === name),
      ),
    ).toEqual(["idx_rep_payout_rows_rep_share"]);
    expect(
      after.triggers.map((t) => t.tgname).filter(
        (name) => !before.triggers.some((t) => t.tgname === name),
      ),
    ).toEqual(["rep_payout_rows_copy_signer_rate", "rep_payout_rows_guard_shared"]);
    expect(
      after.columns.map((c) => c.column_name).filter(
        (name) => !before.columns.some((c) => c.column_name === name),
      ),
    ).toEqual(NEW_COLUMNS);
  });

  it("leaves no copy of the payouts behind", async () => {
    const db = await dbAfter();
    await asPlatform(db);
    const found = await rows(
      db,
      `select relname from pg_class where relname = 'rep_payout_rewrite_before'`,
    );
    expect(found).toEqual([]);
  });
});

describe("the migration refuses a rewrite that would move anything", () => {
  async function seededBefore(): Promise<{ db: TestDb; before: Snapshot }> {
    const db = await dbBefore();
    await seed(db);
    await asPlatform(db);
    await db.exec(`
      insert into rep_payout_rows (agent_id, period, mid, residual_income, rep_split_pct)
      values ('${AGENT_ID}', '2026-07-01', 'BREAK-1', 0.03, 50.00),
             ('${AGENT_ID}', '2026-07-01', 'BREAK-2', 88.40, 60.00),
             ('${AGENT_ID}', '2026-07-01', 'BREAK-3', -100.01, 50.00),
             ('${AGENT_ID}', '2026-07-01', 'BREAK-4', null, 50.00),
             -- 0.025 at a half-cent: round gives 0.03, trunc 0.02. Without this
             -- row trunc happens to move one cent up (BREAK-3) and one down
             -- (BREAK-1), leaving the TOTAL unchanged.
             ('${AGENT_ID}', '2026-07-01', 'BREAK-5', 0.05, 50.00);
    `);
    return { db, before: await payoutSnapshot(db) };
  }

  async function expectRolledBack(db: TestDb, before: Snapshot): Promise<void> {
    // Nothing half-applied: no new column, the old values intact.
    const [{ has }] = await rows<{ has: boolean }>(
      db,
      `select exists (select 1 from information_schema.columns
                       where table_name = 'rep_payout_rows'
                         and column_name = 'line_kind') as has`,
    );
    expect(has).toBe(false);
    expect(await payoutSnapshot(db)).toEqual(before);
  }

  it("aborts when the unshared branch rounds differently (trunc instead of round)", async () => {
    const { db, before } = await seededBefore();
    const sql = await readMigration(MIGRATION);
    expect(sql).toContain(UNSHARED_BRANCH);
    const broken = sql.replace(
      UNSHARED_BRANCH,
      "      when share_role is null then\n        trunc(residual_income * rep_split_pct / 100, 2)",
    );

    await expect(applyMigration(db, broken)).rejects.toThrow(
      /rep_payout rewrite changed existing payouts .*total DIFFERS, per-row checksum DIFFERS/,
    );
    await expectRolledBack(db, before);
  });

  it("aborts on a change the TOTAL cannot see — a cent moved from one row to another", async () => {
    const { db, before } = await seededBefore();
    const [{ a, b }] = await rows<{ a: number; b: number }>(
      db,
      `select (select id from rep_payout_rows where mid = 'BREAK-2') as a,
              (select id from rep_payout_rows where mid = 'BREAK-3') as b`,
    );
    const sql = await readMigration(MIGRATION);
    const broken = sql.replace(
      UNSHARED_BRANCH,
      `      when share_role is null then\n        round(residual_income * rep_split_pct / 100, 2)
          + case id when ${a} then 0.01 when ${b} then -0.01 else 0 end`,
    );

    // Same row count, same total: only the per-row checksum catches it.
    await expect(applyMigration(db, broken)).rejects.toThrow(
      /total matches, per-row checksum DIFFERS/,
    );
    await expectRolledBack(db, before);
  });

  it("refuses to drop a column an index depends on", async () => {
    const { db, before } = await seededBefore();
    await db.exec(`create index hand_made_payout_idx on rep_payout_rows (rep_payout)`);
    await expect(applyMigration(db)).rejects.toThrow(/dependent object/);
    await expectRolledBack(db, before);
    // The hand-made index survives.
    expect(
      await rows(db, `select indexname from pg_indexes where indexname = 'hand_made_payout_idx'`),
    ).toHaveLength(1);
  });

  it("refuses to drop a column that carries its own grant", async () => {
    const { db, before } = await seededBefore();
    await db.exec(`grant select (rep_payout) on rep_payout_rows to service_role`);
    await expect(applyMigration(db)).rejects.toThrow(/column-level privileges/);
    await expectRolledBack(db, before);
  });
});
