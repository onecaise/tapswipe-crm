import { readFile } from "node:fs/promises";

import { afterAll, describe, expect, it } from "vitest";

import {
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
 * 20261111120000: the residual importer meets the real ISO Hub files (phase
 * 15 of docs/design/intake-and-reports.md). What commit v3 does with the new
 * rules is pinned in commit-residual-import-v3.test.ts (other_income_type,
 * the blank Processor cell, the aliases, processor_key and their mutation
 * proofs); this file pins the migration itself:
 *
 *   1. it passes over a populated database (a committed batch, a batch in
 *      review with staged warnings) and writes no row;
 *   2. the staging CHECK admits other_income_type and still refuses an
 *      unknown code;
 *   3. it refuses over a v3 that is not the 20261106140000 body, for each of
 *      the three fragments it replaces;
 *   4. the migration's block is the schema spec's, verbatim.
 */

const MIGRATION = "20261111120000_iso_hub_files.sql";
const V3 = "commit_residual_import_v3(int, text[])";

const opened: TestDb[] = [];
afterAll(async () => {
  await Promise.all(opened.map((d) => d.close()));
});

async function before(): Promise<TestDb> {
  const target = await createTestDb(await migrationsBefore(MIGRATION));
  opened.push(target);
  await resetData(target);
  return target;
}

async function attempt(target: TestDb, fn: () => Promise<unknown>): Promise<{ message: string } | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error as { message: string };
  } finally {
    await asPlatform(target);
  }
}

describe("the migration over existing rows", () => {
  it("passes over a populated database and writes no row", async () => {
    const target = await before();
    await seedPayouts(target);
    const committed = await insertBatch(target);
    await stageForCommit(target, committed, [{ mid: "MID-AGENT-1" }]);
    await commitV3(target, committed);
    const review = await insertBatch(target);
    await stageForCommit(target, review, [{ mid: "MID-OTHER-1" }]);
    await asPlatform(target);
    await target.exec(`update rep_payout_import_rows set warnings = array['processor_mismatch', 'bad_numbers']
                        where batch_id = ${review}`);
    const fingerprint = () =>
      rows(
        target,
        `select (select md5(string_agg(row(r.*)::text, '|' order by r.id)) from rep_payout_rows r) as ledger,
                (select md5(string_agg(row(b.*)::text, '|' order by b.id)) from rep_payout_batches b) as batches,
                (select md5(string_agg(row(s.*)::text, '|' order by s.id)) from rep_payout_import_rows s) as staged`,
      );
    const was = await fingerprint();
    await target.exec(await readMigration(MIGRATION));
    expect(await fingerprint()).toEqual(was);

    await target.exec(`update rep_payout_import_rows set warnings = array['other_income_type']
                        where batch_id = ${review}`);
    const unknown = await attempt(target, () =>
      target.exec(`update rep_payout_import_rows set warnings = array['looks_shared'] where batch_id = ${review}`),
    );
    expect(unknown?.message).toMatch(/rep_payout_import_rows_warnings_vocabulary/);
  });

  it("refuses over a v3 that is not the body it copied, for each fragment it replaces", async () => {
    for (const [from, to] of [
      ["Rows % have an Income Type other than Residuals.", "Rows % have an Income Type that is not Residuals."],
      ["r.processor_raw is null", "r.processor_raw is not distinct from null"],
      [
        "'Only processor_mismatch, inactive_merchant and bad_numbers can be confirmed.'",
        "'Only these can be confirmed.'",
      ],
    ] as const) {
      const target = await before();
      const [{ def }] = await rows<{ def: string }>(target, `select pg_get_functiondef('${V3}'::regprocedure) as def`);
      expect(def, from).toContain(from);
      await target.exec(def.replace(from, to));
      const error = await attempt(target, async () => target.exec(await readMigration(MIGRATION)));
      expect(error?.message, from).toMatch(/is not the 20261106140000 body here/);
      expect(
        await rows(target, `select count(*)::int as n from pg_proc where proname = 'processor_key'`),
        from,
      ).toEqual([{ n: 0 }]);
    }
  });
});

describe("the schema spec comes first", () => {
  it("carries the migration's block verbatim", async () => {
    const lf = (text: string) => text.replace(/\r\n/g, "\n");
    const migration = lf(await readMigration(MIGRATION));
    const spec = lf(await readFile("docs/tapswipe_crm_schema.sql", "utf8"));
    const block = migration.slice(migration.indexOf("-- =====================================================================\n-- ISO HUB FILES"));
    expect(block.length).toBeGreaterThan(1000);
    expect(spec).toContain(block);
  });
});
