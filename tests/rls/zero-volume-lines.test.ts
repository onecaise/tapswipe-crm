import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_ID,
  AGENT_ID,
  asPlatform,
  asUser,
  createTestDb,
  freeBatchMonth,
  insertBatch,
  migrationsBefore,
  readMigration,
  resetData,
  rows,
  type TestDb,
} from "../helpers/db";
import { rowWarnings } from "../../supabase/functions/_shared/residuals";

/**
 * 20261104120000: a zero-volume line is not a bad number.
 *
 * bad_numbers was `volume <= 0 or residual > volume`; it is now
 * `volume < 0 or (volume > 0 and residual > volume)`. A zero-volume line
 * (a monthly fee, a chargeback or closing fee on a closed merchant) commits
 * with NOTHING confirmed, whatever its residual; a negative volume still
 * needs the bad_numbers yes and is still marked. What this file pins:
 *
 *   1. The five shapes through the real v3: (a) volume 0 / residual < 0,
 *      (b) 0 / 0, (c) 0 / > 0 and (d) > 0 / 0 commit with nothing confirmed;
 *      (e) < 0 / < 0 is refused until bad_numbers is confirmed, then marked.
 *      And one zero-volume row no longer holds up a whole file.
 *   2. The parser's rowWarnings() and v3 agree on a grid of figures (the
 *      rule lives twice; the live parity test pins the pair end to end).
 *   3. The migration: its body is 20261102120000's with one line changed,
 *      and it refuses to run over a v3 that does not carry the old rule.
 *   4. Mutation proof: the old `<= 0` put back into a copy of v3 refuses
 *      (a), (b) and (c) again -- so section 1 is about the rule.
 */

const MIGRATION = "20261104120000_zero_volume_not_bad_numbers.sql";
const PREVIOUS = "20261102120000_merchant_overrides.sql";
const V3 = "commit_residual_import_v3";
const OLD_RULE = "('bad_numbers', r.volume <= 0 or r.residual_income > r.volume)";
const NEW_RULE = "('bad_numbers', r.volume < 0 or (r.volume > 0 and r.residual_income > r.volume))";

type DbError = { code?: string; message: string; detail?: string };

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

/** A merchant at 50, owned by the agent, TSYS and active: no other warning can fire. */
async function merchant(target: TestDb, mid: string): Promise<void> {
  await asPlatform(target);
  await target.exec(
    `insert into merchants (agent_id, mid, dba, status, processor, split_agent_pct, split_company_pct, city, state)
     values ('${AGENT_ID}', '${mid}', '${mid} Co', 'active', 'TSYS', 50, 50, 'Nashville', 'TN')`,
  );
}

/** A TSYS review batch in a free month, one staged row per figure pair, as the parser leaves it. */
async function batchWith(target: TestDb, staged: { mid: string; volume: string; residual: string }[]) {
  await asPlatform(target);
  const id = await insertBatch(target, {
    extra: { processor: "'TSYS'", period: freeBatchMonth("TSYS") },
  });
  const [{ period }] = await rows<{ period: string }>(
    target,
    `select period::text as period from rep_payout_batches where id = ${id}`,
  );
  for (const [i, row] of staged.entries()) {
    await target.exec(`
      insert into rep_payout_import_rows
        (batch_id, row_number, mid_raw, merchant_name_raw, processor_raw, income_type_raw,
         volume_raw, residual_income_raw, period, agent_id, merchant_id, volume, residual_income, blockers)
      values (${id}, ${i + 2}, '${row.mid}', 'File name', 'TSYS', 'Residuals', 'v', 'r', '${period}',
              (select agent_id from merchants where mid = '${row.mid}'),
              (select id from merchants where mid = '${row.mid}'),
              ${row.volume}, ${row.residual}, '{}')`);
  }
  return { id, period };
}

async function commit(target: TestDb, id: number, confirmed: string[] = []): Promise<Record<string, number>> {
  await asUser(target, ADMIN_ID);
  const list = confirmed.length === 0 ? "'{}'::text[]" : `array[${confirmed.map((c) => `'${c}'`).join(", ")}]`;
  try {
    const [{ result }] = await rows<{ result: Record<string, number> }>(target, `select ${V3}(${id}, ${list}) as result`);
    return result;
  } finally {
    await asPlatform(target);
  }
}

async function refused(target: TestDb, id: number, confirmed: string[] = []): Promise<DbError> {
  const error = await attempt(() => commit(target, id, confirmed));
  await asPlatform(target);
  expect(error, "expected the commit to be refused").not.toBeNull();
  return error as DbError;
}

async function line(target: TestDb, mid: string) {
  await asPlatform(target);
  return rows<{ volume: string; residual_income: string; rep_payout: string; marked: boolean }>(
    target,
    `select volume::text, residual_income::text, rep_payout::text, volume_confirmed_negative as marked
       from rep_payout_rows where mid = '${mid}'`,
  );
}

const UNCONFIRMED = (rowsList: string) =>
  `These warnings were not confirmed: bad numbers (rows ${rowsList}). Confirm them on the review screen, or fix the data and read the file again.`;

/** The five shapes from the 4 Nov 2026 investigation, plus their payouts at 50. */
const SILENT: [string, string, string, string][] = [
  ["a: volume 0, residual negative (chargeback, closing fee)", "0.00", "-11.76", "-5.88"],
  ["b: volume 0, residual 0", "0.00", "0.00", "0.00"],
  ["c: volume 0, residual positive (a monthly fee, no sales)", "0.00", "25.00", "12.50"],
  ["d: volume positive, residual 0", "1000.00", "0.00", "0.00"],
];

let db: TestDb;

beforeAll(async () => {
  db = await open();
});

beforeEach(async () => {
  await resetData(db);
  await asPlatform(db);
});

describe("the five shapes through the real v3", () => {
  it.each(SILENT)("%s: commits with nothing confirmed, unmarked", async (_label, volume, residual, payout) => {
    await merchant(db, "ZV-1");
    const { id } = await batchWith(db, [{ mid: "ZV-1", volume, residual }]);
    expect((await commit(db, id)).written).toBe(1);
    expect(await line(db, "ZV-1")).toEqual([{ volume, residual_income: residual, rep_payout: payout, marked: false }]);
    const [{ confirmed }] = await rows<{ confirmed: unknown }>(
      db,
      `select confirmed_warnings as confirmed from rep_payout_batches where id = ${id}`,
    );
    expect(confirmed).toEqual({});
  });

  it("e: volume negative, residual negative (a refund month): refused until bad_numbers is confirmed, then marked", async () => {
    await merchant(db, "ZV-E");
    const { id } = await batchWith(db, [{ mid: "ZV-E", volume: "-500.00", residual: "-11.76" }]);
    const error = await refused(db, id);
    expect(error.code).toBe("PT409");
    expect(error.message).toBe(UNCONFIRMED("2"));
    expect(error.detail).toBe("bad_numbers");
    expect(await line(db, "ZV-E")).toEqual([]);
    expect((await commit(db, id, ["bad_numbers"])).written).toBe(1);
    expect(await line(db, "ZV-E")).toEqual([
      { volume: "-500.00", residual_income: "-11.76", rep_payout: "-5.88", marked: true },
    ]);
  });

  it("a file of normal and zero-volume rows commits whole with nothing confirmed", async () => {
    for (const mid of ["MIX-1", "MIX-2", "MIX-3", "MIX-4"]) await merchant(db, mid);
    const { id } = await batchWith(db, [
      { mid: "MIX-1", volume: "40000.00", residual: "200.00" },
      { mid: "MIX-2", volume: "0.00", residual: "-11.76" },
      { mid: "MIX-3", volume: "0.00", residual: "9.95" },
      { mid: "MIX-4", volume: "0.00", residual: "0.00" },
    ]);
    expect((await commit(db, id)).written).toBe(4);
  });

  it("a zero-volume row beside a real bad number: only the bad one is listed, and one yes covers it", async () => {
    for (const mid of ["BN-1", "BN-2", "BN-3"]) await merchant(db, mid);
    const { id } = await batchWith(db, [
      { mid: "BN-1", volume: "0.00", residual: "-11.76" },
      { mid: "BN-2", volume: "100.00", residual: "250.00" }, // residual over a positive volume
      { mid: "BN-3", volume: "-5.00", residual: "1.00" },
    ]);
    expect((await refused(db, id)).message).toBe(UNCONFIRMED("3, 4"));
    expect((await commit(db, id, ["bad_numbers"])).written).toBe(3);
    const [{ confirmed }] = await rows<{ confirmed: unknown }>(
      db,
      `select confirmed_warnings as confirmed from rep_payout_batches where id = ${id}`,
    );
    expect(confirmed).toEqual({ bad_numbers: [3, 4] });
  });
});

describe("the parser and the commit agree", () => {
  it("rowWarnings() flags exactly the rows v3 refuses, over a grid of figures", async () => {
    const volumes = [-500, -0.01, 0, 0.01, 100];
    const residuals = [-11.76, 0, 0.01, 25, 100, 100.01, 600];
    const grid = volumes.flatMap((volume) => residuals.map((residual) => ({ volume, residual })));
    for (const [i] of grid.entries()) await merchant(db, `GRID-${i}`);
    const { id } = await batchWith(
      db,
      grid.map((g, i) => ({ mid: `GRID-${i}`, volume: g.volume.toFixed(2), residual: g.residual.toFixed(2) })),
    );

    const expected = grid
      .map((g, i) => ({ row: i + 2, flagged: rowWarnings({
        fileProcessor: "TSYS", batchProcessor: "TSYS", merchant: { status: "active", processor: "TSYS" },
        volume: g.volume, residual: g.residual,
      }).includes("bad_numbers") }))
      .filter((r) => r.flagged)
      .map((r) => r.row);
    // Non-vacuity: the grid has rows on both sides, zero volume among the silent ones.
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThan(grid.length);
    expect(grid.some((g, i) => g.volume === 0 && !expected.includes(i + 2))).toBe(true);

    expect((await refused(db, id)).message).toBe(UNCONFIRMED(expected.join(", ")));
    expect((await commit(db, id, ["bad_numbers"])).written).toBe(grid.length);
  });
});

describe("the migration", () => {
  it("is 20261102120000's v3 with only the bad_numbers line changed", async () => {
    const extract = (sql: string) => {
      const start = sql.lastIndexOf(`create or replace function ${V3}(`);
      const end = sql.indexOf("$$;", start);
      return sql.slice(start, end).replace(/\r\n/g, "\n");
    };
    const before = extract(await readMigration(PREVIOUS));
    const after = extract(await readMigration(MIGRATION));
    expect(before).toContain(OLD_RULE);
    expect(after).toBe(before.replace(OLD_RULE, NEW_RULE));
  });

  it("leaves the deployed v3 with the new rule once and the old one nowhere, its grants intact", async () => {
    const [{ def, anon, authed }] = await rows<{ def: string; anon: boolean; authed: boolean }>(
      db,
      `select pg_get_functiondef('${V3}(int, text[])'::regprocedure) as def,
              has_function_privilege('anon', '${V3}(int, text[])', 'execute') as anon,
              has_function_privilege('authenticated', '${V3}(int, text[])', 'execute') as authed`,
    );
    expect(def.split(NEW_RULE).length - 1).toBe(1);
    expect(def).not.toContain(OLD_RULE);
    expect(anon).toBe(false);
    expect(authed).toBe(true);
  });

  it("refuses, naming it, over a v3 that does not carry the old rule", async () => {
    const before = await open(await migrationsBefore(MIGRATION));
    await asPlatform(before);
    const [{ def }] = await rows<{ def: string }>(
      before,
      `select pg_get_functiondef('${V3}(int, text[])'::regprocedure) as def`,
    );
    await before.exec(def.replace(OLD_RULE, "('bad_numbers', false)"));
    const error = await attempt(async () => before.exec(await readMigration(MIGRATION)));
    expect(error?.message).toBe(
      "commit_residual_import_v3 does not carry the 20261102120000 bad_numbers rule exactly once here. Inspect pg_get_functiondef before applying 20261104120000.",
    );
  });
});

describe("mutation proof: the old rule put back refuses the zero-volume shapes again", () => {
  let mutant: TestDb;

  beforeAll(async () => {
    mutant = await open();
    await asPlatform(mutant);
    const [{ def }] = await rows<{ def: string }>(
      mutant,
      `select pg_get_functiondef('${V3}(int, text[])'::regprocedure) as def`,
    );
    expect(def, "the new rule must be in the function").toContain(NEW_RULE);
    await mutant.exec(def.replace(NEW_RULE, OLD_RULE));
  });

  beforeEach(async () => {
    await resetData(mutant);
    await asPlatform(mutant);
  });

  it.each(SILENT.slice(0, 3))("%s: refused by the old rule", async (_label, volume, residual) => {
    await merchant(mutant, "ZV-M");
    const { id } = await batchWith(mutant, [{ mid: "ZV-M", volume, residual }]);
    expect((await refused(mutant, id)).message).toBe(UNCONFIRMED("2"));
  });
});
