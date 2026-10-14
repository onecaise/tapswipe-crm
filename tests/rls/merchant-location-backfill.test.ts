import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";

import {
  AGENT_ID,
  asPlatform,
  createTestDb,
  migrationsBefore,
  migrationsFrom,
  readMigration,
  rows,
  seed,
  type TestDb,
} from "../helpers/db";

/**
 * The hand-run SQL files for merchant location, executed against in-memory
 * databases — never against a project:
 *
 *   scripts/recon-merchant-location.sql              read-only, runs PRE-migration
 *   scripts/preview-merchant-location-backfill.sql   read-only
 *   scripts/backfill-merchant-location.sql           psql version, meta-commands removed
 *   scripts/backfill-merchant-location-editor.sql    SQL Editor version, one switch
 *
 * The fixture is built the way a real project got here: merchants written
 * before 20261013130000, some linked to a pre-app with a usable address, some
 * to one without, one with no pre-app at all, and one that already carries a
 * street of its own. Each describe that WRITES gets its own database, so the
 * psql and editor variants are each tested from the same starting state.
 */

const MIGRATION = "20261013130000_merchant_location.sql";
const EDITOR = "scripts/backfill-merchant-location-editor.sql";
const SWITCH_OFF = "select false as apply";
const SWITCH_ON = "select true as apply";

/** Every result set a multi-statement file produced that has columns. */
async function resultSets(
  db: TestDb,
  sql: string,
): Promise<Record<string, unknown>[][]> {
  const results = await db.exec(sql);
  return results
    .filter((r) => r.fields.length > 0)
    .map((r) => r.rows as Record<string, unknown>[]);
}

/** The psql backfill as psql would run it, meta-commands removed. */
async function psqlBackfill(apply: boolean): Promise<string> {
  const raw = await readFile("scripts/backfill-merchant-location.sql", "utf8");
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const ifAt = lines.findIndex((l) => l.startsWith("\\if"));
  const body = lines.slice(0, ifAt).filter((l) => !l.trimStart().startsWith("\\"));
  return `${body.join("\n")}\n${apply ? "commit;" : "rollback;"}`;
}

/** The editor backfill, with its one literal flipped the way Owen would. */
async function editorBackfill(apply: boolean): Promise<string> {
  const raw = await readFile(EDITOR, "utf8");
  return apply ? raw.replace(SWITCH_OFF, SWITCH_ON) : raw;
}

/** The legacy fixture on the PRE-migration schema. */
async function legacyDb(): Promise<TestDb> {
  const db = await createTestDb(await migrationsBefore(MIGRATION));
  await seed(db);
  await asPlatform(db);
  await db.exec(`
    select set_config('tapswipe.pre_app_transition', 'on', false);
    insert into pre_apps (agent_id, status, dba_name, legal_business_name,
                          physical_address, city, state, zip)
    values
      ('${AGENT_ID}', 'approved', 'Good Addr', 'Good Addr LLC', ' 1 Elm St ', ' Knoxville ', 'tn', '37902'),
      ('${AGENT_ID}', 'approved', 'Own Street', 'Own Street LLC', '9 Pre St', 'Franklin', 'TN', null),
      ('${AGENT_ID}', 'approved', 'No City', 'No City LLC', '2 Oak St', null, 'TN', '37000'),
      ('${AGENT_ID}', 'approved', 'Bad State', 'Bad State LLC', null, 'Jackson', 'Tennessee', null),
      ('${AGENT_ID}', 'submitted', 'Waiting Bare', 'Waiting Bare LLC', null, null, null, null);
    select set_config('tapswipe.pre_app_transition', '', false);

    insert into merchants (agent_id, dba, status, pre_app_id) values
      ('${AGENT_ID}', 'M Good',       'active', (select id from pre_apps where dba_name = 'Good Addr')),
      ('${AGENT_ID}', 'M Own Street', 'active', (select id from pre_apps where dba_name = 'Own Street')),
      ('${AGENT_ID}', 'M No City',    'active', (select id from pre_apps where dba_name = 'No City')),
      ('${AGENT_ID}', 'M Bad State',  'active', (select id from pre_apps where dba_name = 'Bad State')),
      ('${AGENT_ID}', 'M No Pre-App', 'active', null);
  `);
  return db;
}

/** The same fixture brought up to date, plus a merchant with its own street. */
async function migratedDb(): Promise<TestDb> {
  const db = await legacyDb();
  for (const file of await migrationsFrom(MIGRATION)) {
    await db.exec(await readMigration(file));
  }
  // Legal: the guard only requires city and state on INSERT.
  await db.exec(`update merchants set street = '5 Mine Rd' where dba = 'M Own Street'`);
  return db;
}

/** The whole merchants table, for "nothing changed" comparisons. */
async function snapshot(db: TestDb): Promise<string> {
  await asPlatform(db);
  const [r] = await rows<{ s: string }>(
    db,
    `select coalesce(jsonb_agg(to_jsonb(m) order by m.id), '[]')::text as s from merchants m`,
  );
  return r.s;
}

async function auditCount(db: TestDb): Promise<number> {
  const [r] = await rows<{ n: number }>(db, `select count(*)::int as n from audit_log`);
  return r.n;
}

const EXPECTED_AFTER_FILL = [
  { dba: "M Bad State", street: null, city: null, state: null, zip: null },
  { dba: "M Good", street: "1 Elm St", city: "Knoxville", state: "TN", zip: "37902" },
  { dba: "M No City", street: null, city: null, state: null, zip: null },
  { dba: "M No Pre-App", street: null, city: null, state: null, zip: null },
  { dba: "M Own Street", street: "5 Mine Rd", city: "Franklin", state: "TN", zip: null },
];

async function fixtureMerchants(db: TestDb) {
  await asPlatform(db);
  return rows<Record<string, string | null>>(
    db,
    `select dba, street, city, state, zip from merchants where dba like 'M %' order by dba`,
  );
}

describe("the recon, on the schema BEFORE the migration (prod as it is today)", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await legacyDb();
  }, 120_000);

  it("non-vacuity: this database really is pre-migration", async () => {
    await asPlatform(db);
    const [r] = await rows<{ cols: number; fns: number }>(
      db,
      `select (select count(*)::int from information_schema.columns
                where table_name = 'merchants' and column_name in ('city', 'state')) as cols,
              (select count(*)::int from pg_proc where proname = 'norm_city') as fns`,
    );
    expect(r).toEqual({ cols: 0, fns: 0 });
  });

  it("runs end to end as ONE script and returns exactly three labelled results", async () => {
    await asPlatform(db);
    const sets = await resultSets(db, await readFile("scripts/recon-merchant-location.sql", "utf8"));
    expect(sets).toHaveLength(3);
    expect(sets.map((s) => s.length)).toEqual([1, 1, 1]);
    const [[a], [b], [c]] = sets;

    expect(a.query).toBe("a: merchants with no city or state");
    // seed()'s four plus the five above: none has a location on this schema.
    expect(Number(a.total)).toBe(9);
    expect((a.merchants as unknown[]).length).toBe(9);

    expect(b.query).toBe("b: submitted pre-apps without a usable city or state");
    // 'Agent Submitted App' has an address (seed); 'Waiting Bare' does not.
    expect(Number(b.total)).toBe(1);
    expect((b.pre_apps as { dba_name: string }[]).map((p) => p.dba_name)).toEqual(["Waiting Bare"]);

    expect(c.query).toBe("c: merchants the backfill could fill");
    // Good Addr and Own Street; No City, Bad State and no pre-app are not.
    expect(Number(c.total)).toBe(2);
  });

  it("never calls norm_city() and never names the new columns directly", async () => {
    const sql = (await readFile("scripts/recon-merchant-location.sql", "utf8"))
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(sql).not.toMatch(/norm_city\s*\(/);
    expect(sql).not.toMatch(/\bm\.(city|state|street|zip)\b/);
  });

  it("each query still answers when nothing matches (a labelled zero, not no rows)", async () => {
    const empty = await createTestDb(await migrationsBefore(MIGRATION));
    const sets = await resultSets(empty, await readFile("scripts/recon-merchant-location.sql", "utf8"));
    expect(sets.map((s) => [s[0].query, Number(s[0].total)])).toEqual([
      ["a: merchants with no city or state", 0],
      ["b: submitted pre-apps without a usable city or state", 0],
      ["c: merchants the backfill could fill", 0],
    ]);
  });

  it("is read-only: a write inside its transaction is refused", async () => {
    await asPlatform(db);
    const recon = await readFile("scripts/recon-merchant-location.sql", "utf8");
    const poisoned = recon.replace("rollback;", "update merchants set dba = dba;\nrollback;");
    await expect(db.exec(poisoned)).rejects.toThrow(/read-only transaction/);
    await db.exec("rollback");
  });
});

describe("the preview, the recon and the psql backfill, after the migration", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await migratedDb();
  }, 120_000);

  it("the preview classifies every merchant with no location", async () => {
    await asPlatform(db);
    const sets = await resultSets(
      db,
      await readFile("scripts/preview-merchant-location-backfill.sql", "utf8"),
    );
    const byOutcome = Object.fromEntries(sets[0].map((r) => [r.outcome, Number(r.merchants)]));
    expect(byOutcome).toEqual({
      fillable: 2,
      "no linked pre-app": 5, // seed()'s four, plus M No Pre-App
      "pre-app has no usable city": 1,
      "pre-app has no usable state": 1,
    });
  });

  it("the recon and the preview agree on how many can be filled", async () => {
    await asPlatform(db);
    const sets = await resultSets(db, await readFile("scripts/recon-merchant-location.sql", "utf8"));
    expect(Number(sets[2][0].total)).toBe(2);
  });

  it("the psql dry run reports the plan and changes nothing", async () => {
    const before = await snapshot(db);
    const sets = await resultSets(db, await psqlBackfill(false));
    expect(Number(sets[0][0].would_fill)).toBe(2);
    expect(sets[1].map((r) => r.dba)).toEqual(["M Good", "M Own Street"]);
    expect(await snapshot(db)).toBe(before);
  });

  it("applied, it fills exactly the usable ones and never overwrites a merchant's own field", async () => {
    await asPlatform(db);
    await resultSets(db, await psqlBackfill(true));
    expect(await fixtureMerchants(db)).toEqual(EXPECTED_AFTER_FILL);
  });

  it("is idempotent: a second run finds nothing to do", async () => {
    await asPlatform(db);
    const sets = await resultSets(db, await psqlBackfill(false));
    expect(Number(sets[0][0].would_fill)).toBe(0);
  });
});

describe("the SQL Editor backfill variant", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await migratedDb();
  }, 120_000);

  it("ships in PREVIEW mode, with exactly one switch", async () => {
    const raw = await readFile(EDITOR, "utf8");
    expect(raw.split(SWITCH_OFF).length - 1).toBe(1);
    expect(raw).not.toContain(SWITCH_ON);
  });

  it("is a single statement, so it is one transaction in any editor", async () => {
    const code = (await readFile(EDITOR, "utf8"))
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n")
      .trim();
    expect(code.match(/;/g)).toHaveLength(1);
    expect(code.endsWith(";")).toBe(true);
  });

  it("preview: returns the summary and the first merchants, and changes NOTHING", async () => {
    const before = await snapshot(db);
    const auditBefore = await auditCount(db);

    const sets = await resultSets(db, await editorBackfill(false));
    expect(sets).toHaveLength(1);
    const [summary, ...merchants] = sets[0];
    expect(summary).toMatchObject({
      row_kind: "summary",
      mode: "PREVIEW: nothing written",
    });
    expect(Number(summary.merchants_without_location)).toBe(9);
    expect(Number(summary.would_fill)).toBe(2);
    expect(Number(summary.rows_changed)).toBe(0);
    expect(Number(summary.would_also_get_street)).toBe(1); // M Own Street keeps its own
    expect(Number(summary.would_also_get_zip)).toBe(1);
    expect(merchants.map((m) => [m.row_kind, m.dba, m.new_city, m.new_state, m.new_street])).toEqual([
      ["merchant", "M Good", "Knoxville", "TN", "1 Elm St"],
      ["merchant", "M Own Street", "Franklin", "TN", null],
    ]);

    expect(await snapshot(db)).toBe(before);
    expect(await auditCount(db)).toBe(auditBefore);
  });

  it("caps the merchant rows at 20", async () => {
    const big = await migratedDb();
    await big.exec(`
      select set_config('tapswipe.pre_app_transition', 'on', false);
      insert into pre_apps (agent_id, status, dba_name, legal_business_name, city, state)
      select '${AGENT_ID}', 'approved', 'Bulk ' || g, 'Bulk ' || g || ' LLC', 'Bulkton', 'OH'
        from generate_series(1, 25) g;
      select set_config('tapswipe.pre_app_transition', '', false);
      alter table merchants disable trigger merchants_location_guard;
      insert into merchants (agent_id, dba, status, pre_app_id)
      select '${AGENT_ID}', 'Bulk M ' || g, 'active',
             (select id from pre_apps where dba_name = 'Bulk ' || g)
        from generate_series(1, 25) g;
      alter table merchants enable trigger merchants_location_guard;
    `);
    const [set] = await resultSets(big, await editorBackfill(false));
    expect(Number(set[0].would_fill)).toBe(27);
    expect(set.filter((r) => r.row_kind === "merchant")).toHaveLength(20);
  });

  it("apply: fills exactly the usable ones in one statement and reports the rows changed", async () => {
    const auditBefore = await auditCount(db);
    const [set] = await resultSets(db, await editorBackfill(true));
    expect(set[0]).toMatchObject({ row_kind: "summary", mode: "APPLIED" });
    expect(Number(set[0].rows_changed)).toBe(2);
    expect(await fixtureMerchants(db)).toEqual(EXPECTED_AFTER_FILL);
    // The cross-agent audit trigger records each write (a platform write has
    // no auth.uid(), so it is "cross agent" by definition).
    expect(await auditCount(db)).toBe(auditBefore + 2);
  });

  it("is idempotent: a second apply changes nothing", async () => {
    const [set] = await resultSets(db, await editorBackfill(true));
    expect(Number(set[0].would_fill)).toBe(0);
    expect(Number(set[0].rows_changed)).toBe(0);
  });
});
