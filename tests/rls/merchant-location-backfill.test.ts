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
 * The three hand-run SQL files for merchant location, executed against an
 * in-memory database — never against a project:
 *
 *   scripts/recon-merchant-location.sql            read-only, runs PRE-migration
 *   scripts/preview-merchant-location-backfill.sql read-only
 *   scripts/backfill-merchant-location.sql         the writer, minus its psql
 *                                                  meta-commands
 *
 * The fixture is built the way a real project got here: merchants written
 * before 20261013130000, some linked to a pre-app with a usable address, some
 * to one without, one with no pre-app at all, and one that already carries a
 * street of its own.
 */

const MIGRATION = "20261013130000_merchant_location.sql";

let db: TestDb;

/** Every result set a multi-statement file produced that carried rows. */
async function resultSets(sql: string): Promise<Record<string, unknown>[][]> {
  const results = await db.exec(sql);
  return results.filter((r) => r.fields.length > 0).map((r) => r.rows as Record<string, unknown>[]);
}

/** The backfill as psql would run it with -v apply=1, meta-commands removed. */
async function backfillSql(apply: boolean): Promise<string> {
  const raw = await readFile("scripts/backfill-merchant-location.sql", "utf8");
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const ifAt = lines.findIndex((l) => l.startsWith("\\if"));
  const body = lines.slice(0, ifAt).filter((l) => !l.trimStart().startsWith("\\"));
  return `${body.join("\n")}\n${apply ? "commit;" : "rollback;"}`;
}

beforeAll(async () => {
  db = await createTestDb(await migrationsBefore(MIGRATION));
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
}, 120_000);

describe("the recon, on the schema BEFORE the migration (prod as it is today)", () => {
  it("runs without the location columns or norm_city, and reads nothing as a location", async () => {
    await asPlatform(db);
    const [a, , b, c] = await resultSets(await readFile("scripts/recon-merchant-location.sql", "utf8"));
    // seed()'s four plus the five above: none has a location on this schema.
    expect(Number(a[0].merchants_without_location)).toBe(9);
    // 'Agent Submitted App' has an address (seed); 'Waiting Bare' does not.
    expect(b.map((r) => r.dba_name)).toEqual(["Waiting Bare"]);
    // Good Addr and Own Street; No City, Bad State and no pre-app are not.
    expect(Number(c[0].backfillable_from_pre_app)).toBe(2);
  });

  it("is read-only: a write inside its transaction is refused", async () => {
    await asPlatform(db);
    const recon = await readFile("scripts/recon-merchant-location.sql", "utf8");
    const poisoned = recon.replace(
      "rollback;",
      "update merchants set dba = dba;\nrollback;",
    );
    await expect(db.exec(poisoned)).rejects.toThrow(/read-only transaction/);
    await db.exec("rollback");
  });
});

describe("after the migration", () => {
  beforeAll(async () => {
    await asPlatform(db);
    for (const file of await migrationsFrom(MIGRATION)) {
      await db.exec(await readMigration(file));
    }
    // A merchant that already has its own street (legal: the guard only
    // requires city and state on INSERT, and this row predates it).
    await db.exec(`update merchants set street = '5 Mine Rd' where dba = 'M Own Street'`);
  });

  it("the preview classifies every merchant with no location", async () => {
    await asPlatform(db);
    const sets = await resultSets(
      await readFile("scripts/preview-merchant-location-backfill.sql", "utf8"),
    );
    const byOutcome = Object.fromEntries(
      sets[0].map((r) => [r.outcome, Number(r.merchants)]),
    );
    expect(byOutcome).toEqual({
      fillable: 2,
      "no linked pre-app": 5, // seed()'s four, plus M No Pre-App
      "pre-app has no usable city": 1,
      "pre-app has no usable state": 1,
    });
  });

  it("the recon and the preview agree on how many can be filled", async () => {
    await asPlatform(db);
    const sets = await resultSets(await readFile("scripts/recon-merchant-location.sql", "utf8"));
    expect(Number(sets[3][0].backfillable_from_pre_app)).toBe(2);
  });

  it("the backfill's dry run reports the plan and changes nothing", async () => {
    await asPlatform(db);
    const sets = await resultSets(await backfillSql(false));
    expect(Number(sets[0][0].would_fill)).toBe(2);
    expect(sets[1].map((r) => r.dba)).toEqual(["M Good", "M Own Street"]);
    const [n] = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from merchants where city is not null`,
    );
    expect(n.n).toBe(0);
  });

  it("applied, it fills exactly the usable ones and never overwrites a merchant's own field", async () => {
    await asPlatform(db);
    await resultSets(await backfillSql(true));
    const after = await rows<Record<string, string | null>>(
      db,
      `select dba, street, city, state, zip from merchants
        where dba like 'M %' order by dba`,
    );
    expect(after).toEqual([
      { dba: "M Bad State", street: null, city: null, state: null, zip: null },
      { dba: "M Good", street: "1 Elm St", city: "Knoxville", state: "TN", zip: "37902" },
      { dba: "M No City", street: null, city: null, state: null, zip: null },
      { dba: "M No Pre-App", street: null, city: null, state: null, zip: null },
      { dba: "M Own Street", street: "5 Mine Rd", city: "Franklin", state: "TN", zip: null },
    ]);
  });

  it("is idempotent: a second run finds nothing to do", async () => {
    await asPlatform(db);
    const sets = await resultSets(await backfillSql(false));
    expect(Number(sets[0][0].would_fill)).toBe(0);
  });
});
