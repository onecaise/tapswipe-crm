import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ADMIN_ID,
  asPlatform,
  commitV3,
  createTestDb,
  insertBatch,
  migrationsBefore,
  readMigration,
  resetData,
  rows,
  seedPayouts,
  stageForCommit,
  type TestDb,
} from "../helpers/db";

/**
 * 20261104140000 (phase 13 of docs/design/intake-and-reports.md): the old
 * commit and the skip record retired.
 *
 *   1. What is gone: commit_residual_import(int) and
 *      acknowledge_residual_skips(int), rep_payout_batches.skipped_rows and
 *      .skips_acknowledged_at; adjustment_rows_ignored stays (memo §2.1).
 *      The preview-flag CHECK allows the two notes the parser writes.
 *   2. v3 is 20261104120000's body with ONLY its skipped_rows line removed,
 *      still commits, and keeps its grants.
 *   3. The migration over existing rows: it refuses, naming them, a batch
 *      holding a skip record and a staged row with a retired flag, and a v3
 *      that is not the body it copied; it passes over a populated database
 *      and moves no row. Mutation proof: without its guard, the same
 *      migration silently drops a skip record.
 */

const MIGRATION = "20261104140000_retire_legacy_import.sql";
const PREVIOUS = "20261104120000_zero_volume_not_bad_numbers.sql";
const V3 = "commit_residual_import_v3";
const SKIP_LINE = "         skipped_rows = '[]'::jsonb,\n";
const SKIP_RECORD = `'[{"row_number": 2, "period": "2026-07-01", "mid": "MID-AGENT-2", "agent_number": null, "reason": "partner_named"}]'`;

type DbError = { code?: string; message: string };

const opened: TestDb[] = [];
afterAll(async () => {
  await Promise.all(opened.map((d) => d.close()));
});

async function open(files?: string[]): Promise<TestDb> {
  const created = await createTestDb(files);
  opened.push(created);
  return created;
}

async function attempt(fn: () => Promise<unknown>): Promise<DbError | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error as DbError;
  }
}

async function count(target: TestDb, sql: string): Promise<number> {
  await asPlatform(target);
  const [{ n }] = await rows<{ n: number }>(target, `select (${sql})::int as n`);
  return n;
}

const columnsOf = async (target: TestDb, table: string) =>
  (
    await rows<{ name: string }>(
      target,
      `select column_name as name from information_schema.columns
        where table_schema = 'public' and table_name = '${table}' order by 1`,
    )
  ).map((c) => c.name);

/** A database just before this migration, with seedPayouts and a v3 commit on it. */
async function populatedBefore(): Promise<TestDb> {
  const target = await open(await migrationsBefore(MIGRATION));
  await resetData(target);
  await seedPayouts(target);
  const id = await insertBatch(target);
  await stageForCommit(target, id, [{ mid: "MID-AGENT-1" }]);
  expect(await commitV3(target, id)).toMatchObject({ written: 1 });
  return target;
}

/** Everything a row-preserving migration must leave as it was. */
async function fingerprint(target: TestDb) {
  await asPlatform(target);
  return rows(
    target,
    `select (select count(*)::int from rep_payout_batches) as batches,
            (select string_agg(id || ':' || status || ':' || row_count, ',' order by id) from rep_payout_batches) as batch_rows,
            (select count(*)::int from rep_payout_import_rows) as staged,
            (select string_agg(id || ':' || coalesce(preview_flag, '-'), ',' order by id) from rep_payout_import_rows) as flags,
            (select count(*)::int from rep_payout_rows) as lines,
            (select md5(string_agg(row(r.*)::text, '|' order by r.id)) from rep_payout_rows r) as ledger`,
  );
}

// -------------------------------------------------------------------------
// 1 and 2. The schema after it.
// -------------------------------------------------------------------------

describe("after 20261104140000", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await open();
    await resetData(db);
    await seedPayouts(db);
  });

  it("drops the old commit and the acknowledgement, and no other overload of either survives", async () => {
    for (const name of ["commit_residual_import", "acknowledge_residual_skips"]) {
      expect(await count(db, `select count(*) from pg_proc where proname = '${name}'`), name).toBe(0);
    }
    // The commit that stays.
    expect(await count(db, `select count(*) from pg_proc where proname = '${V3}'`)).toBe(1);
  });

  it("drops the skip record's two columns and keeps adjustment_rows_ignored", async () => {
    const columns = await columnsOf(db, "rep_payout_batches");
    expect(columns).not.toContain("skipped_rows");
    expect(columns).not.toContain("skips_acknowledged_at");
    expect(columns).toContain("adjustment_rows_ignored");
    expect(
      await count(db, `select count(*) from pg_constraint where conname = 'rep_payout_batches_skipped_rows_array'`),
    ).toBe(0);
  });

  it("narrows the preview-flag CHECK to the two notes the parser writes", async () => {
    await asPlatform(db);
    const [{ def }] = await rows<{ def: string }>(
      db,
      `select pg_get_constraintdef(oid) as def from pg_constraint
        where conname = 'rep_payout_import_rows_preview_flag_check'`,
    );
    const codes = [...def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(codes).toEqual(["payee_changed", "share_not_in_force"]);
  });

  it("re-creates v3 as 20261104120000's body with only its skipped_rows line removed", async () => {
    const extract = (sql: string) => {
      const start = sql.lastIndexOf(`create or replace function ${V3}(`);
      const end = sql.indexOf("$$;", start);
      return sql.slice(start, end).replace(/\r\n/g, "\n");
    };
    const before = extract(await readMigration(PREVIOUS));
    const after = extract(await readMigration(MIGRATION));
    expect(before.split(SKIP_LINE).length - 1).toBe(1);
    expect(after).toBe(before.replace(SKIP_LINE, ""));
    // And the deployed function is that body.
    await asPlatform(db);
    const [{ def }] = await rows<{ def: string }>(db, `select pg_get_functiondef('${V3}(int, text[])'::regprocedure) as def`);
    expect(def).not.toContain("skipped_rows");
    expect(def).toContain("confirmed_warnings = coalesce(covered, '{}'::jsonb)");
  });

  it("keeps v3's grants: authenticated and service_role, never anon or PUBLIC", async () => {
    for (const [role, ok] of [["authenticated", 1], ["service_role", 1], ["anon", 0]] as const) {
      expect(
        await count(db, `select has_function_privilege('${role}', '${V3}(int, text[])', 'execute')::int`),
        role,
      ).toBe(ok);
    }
    await asPlatform(db);
    const [{ acl }] = await rows<{ acl: string }>(
      db,
      `select proacl::text as acl from pg_proc where oid = '${V3}(int, text[])'::regprocedure`,
    );
    expect(acl).not.toMatch(/(^|[{,])=X/);
  });

  it("still commits, and the batch records the commit as before", async () => {
    const id = await insertBatch(db);
    // MID-AGENT-2 is an inactive Square merchant: two warnings, both confirmed.
    await stageForCommit(db, id, [{ mid: "MID-AGENT-2" }]);
    expect(await commitV3(db, id, ["inactive_merchant", "processor_mismatch"])).toEqual({
      written: 1,
      rows: 1,
      shared: 0,
      overrides: 0,
      company_overrides: 0,
      replaced_lines: 0,
    });
    await asPlatform(db);
    const [batch] = await rows<{ status: string; row_count: number; confirmed_warnings: Record<string, unknown> }>(
      db,
      `select status, row_count, confirmed_warnings from rep_payout_batches where id = ${id}`,
    );
    expect(batch).toMatchObject({ status: "committed", row_count: 1 });
    expect(Object.keys(batch.confirmed_warnings).sort()).toEqual(["inactive_merchant", "processor_mismatch"]);
    expect(
      await count(db, `select count(*) from audit_log where action = 'commit_residual_import' and row_id = '${id}' and actor_id = '${ADMIN_ID}'`),
    ).toBe(1);
  });
});

// -------------------------------------------------------------------------
// 3. The migration over existing rows.
// -------------------------------------------------------------------------

describe("the migration over existing rows", () => {
  it("passes over a populated database and moves no row it keeps", async () => {
    const target = await populatedBefore();
    // The notes that stay, on staged rows.
    await target.exec(
      `update rep_payout_import_rows set preview_flag = 'payee_changed', preview_note = 'x' where row_number = 2`,
    );
    const before = await fingerprint(target);
    expect(await count(target, `select count(*) from rep_payout_rows`)).toBeGreaterThan(0);
    expect(await count(target, `select count(*) from rep_payout_import_rows where preview_flag is not null`)).toBeGreaterThan(0);

    await asPlatform(target);
    await target.exec(await readMigration(MIGRATION));
    expect(await fingerprint(target)).toEqual(before);
    expect(await columnsOf(target, "rep_payout_batches")).not.toContain("skipped_rows");
  });

  it("refuses, naming each batch, a skip record it would lose", async () => {
    const target = await populatedBefore();
    const ids: number[] = [];
    for (const name of ["v2-a.xlsx", "v2-b.xlsx"]) {
      ids.push(
        await insertBatch(target, {
          status: "committed",
          fileName: name,
          extra: { committed_at: "now()", row_count: "1", skipped_rows: SKIP_RECORD },
        }),
      );
    }
    const before = await fingerprint(target);

    await asPlatform(target);
    const error = await attempt(async () => target.exec(await readMigration(MIGRATION)));
    expect(error?.message).toBe(
      `retire_legacy_import refuses to run: rep_payout_batches ${ids.join(", ")} carry a skip record (rows commit_residual_import_v2 did not import), which dropping skipped_rows would lose. Copy each record out (select id, skipped_rows from rep_payout_batches where id in (${ids.join(", ")})) and clear it before applying 20261104140000.`,
    );
    // Nothing applied: the old commit and the record are both still there.
    expect(await count(target, `select count(*) from pg_proc where proname = 'commit_residual_import'`)).toBe(1);
    expect(await fingerprint(target)).toEqual(before);
    expect(await count(target, `select count(*) from rep_payout_batches where jsonb_array_length(skipped_rows) > 0`)).toBe(2);
  });

  it("refuses, naming the batch, a staged row carrying a retired flag; one flag at a time", async () => {
    for (const flag of ["share_not_applied", "partner_named", "line_not_shared", "looks_shared"]) {
      const target = await populatedBefore();
      const id = await insertBatch(target, { fileName: `${flag}.xlsx` });
      await stageForCommit(target, id, [{ mid: "MID-AGENT-1" }]);
      await target.exec(`update rep_payout_import_rows set preview_flag = '${flag}', preview_note = 'x' where batch_id = ${id}`);

      await asPlatform(target);
      const error = await attempt(async () => target.exec(await readMigration(MIGRATION)));
      expect(error?.message, flag).toBe(
        `retire_legacy_import refuses to run: staged rows of residual import batch(es) ${id} carry a retired preview flag (share_not_applied, partner_named, line_not_shared or looks_shared). Read the batch again (parse-residual-import clears and restages its rows), or, for one that cannot be read again, delete its staged rows (delete from rep_payout_import_rows where batch_id = ...), then apply 20261104140000.`,
      );
      expect(await count(target, `select count(*) from pg_proc where proname = 'acknowledge_residual_skips'`), flag).toBe(1);
    }
  });

  it("refuses over a v3 that is not the body it copied", async () => {
    const target = await open(await migrationsBefore(MIGRATION));
    await asPlatform(target);
    const [{ def }] = await rows<{ def: string }>(target, `select pg_get_functiondef('${V3}(int, text[])'::regprocedure) as def`);
    expect(def).toContain("skipped_rows = '[]'::jsonb,");
    await target.exec(def.replace("skipped_rows = '[]'::jsonb,", ""));
    const error = await attempt(async () => target.exec(await readMigration(MIGRATION)));
    expect(error?.message).toBe(
      "commit_residual_import_v3 is not the 20261104120000 body here (its skipped_rows line and its bad_numbers rule, each exactly once). Inspect pg_get_functiondef before applying 20261104140000.",
    );
  });

  it("mutation proof: without its guard the same migration drops the skip record silently", async () => {
    const target = await populatedBefore();
    await insertBatch(target, {
      status: "committed",
      fileName: "v2-lost.xlsx",
      extra: { committed_at: "now()", row_count: "1", skipped_rows: SKIP_RECORD },
    });
    const sql = (await readMigration(MIGRATION)).replace(/\r\n/g, "\n");
    const guard = /\ndo \$\$\n[\s\S]*?\nend \$\$;\n/.exec(sql);
    expect(guard?.[0]).toContain("retire_legacy_import refuses to run");
    await asPlatform(target);
    expect(await attempt(async () => target.exec(sql.replace(guard![0], "\n")))).toBeNull();
    // Applied, and the record is gone with its column.
    expect(await columnsOf(target, "rep_payout_batches")).not.toContain("skipped_rows");
  });
});
