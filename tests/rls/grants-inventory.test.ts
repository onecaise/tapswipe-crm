import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asPlatform, createTestDb, rows, type TestDb } from "../helpers/db";
import {
  EXPECTED,
  EXPECTED_SEQUENCES,
  inventoryQuery,
  tablesCreatedSinceCutoff,
} from "../helpers/grants-inventory";

/**
 * docs/claude/grants-inventory.md over the migrations (PGlite). Supabase
 * stopped auto-granting Data API access to new tables on 30 Oct 2026, so a
 * table has exactly the grants its migration writes. This runs the doc's own
 * read-only query and requires every row to match, and requires the doc to
 * list every table a migration has created since the cutoff.
 *
 * PGlite has no Supabase default ACL, so this proves what the migrations
 * grant. tests/live/grants-inventory.test.ts runs the same query on the local
 * stack, where the default ACL does add privileges to a table nobody revoked.
 */

type Result = {
  table_name: string;
  grantee: string;
  set_by: string;
  table_exists: boolean;
  expected: string;
  actual: string;
  matches: boolean;
};

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
  await asPlatform(db);
});
afterAll(async () => {
  await db?.close();
});

describe("the grants inventory over the migrations", () => {
  it("lists every table a migration has created since the cutoff, and no other", async () => {
    const listed = [...new Set(EXPECTED.map((r) => r.table_name))].sort();
    expect(await tablesCreatedSinceCutoff()).toEqual(listed);
    // Three Data API roles each.
    for (const table of listed) {
      expect(EXPECTED.filter((r) => r.table_name === table).map((r) => r.grantee).sort(), table).toEqual([
        "anon",
        "authenticated",
        "service_role",
      ]);
    }
  });

  it("the doc's query says every grant matches, and its expected column is EXPECTED", async () => {
    const result = await rows<Result>(db, await inventoryQuery());
    expect(result.map(({ table_name, grantee, set_by, expected }) => ({ table_name, grantee, set_by, expected }))).toEqual(EXPECTED);
    expect(result.filter((r) => !r.matches)).toEqual([]);
    expect(result.every((r) => r.table_exists)).toBe(true);
    expect(result.map((r) => r.actual)).toEqual(EXPECTED.map((r) => r.expected));
  });

  it("the query notices an extra grant and a missing one (so a pass is not vacuous)", async () => {
    await db.exec(`
      grant insert on processors to authenticated;
      revoke select on payout_period_closures from service_role;`);
    try {
      const result = await rows<Result>(db, await inventoryQuery());
      expect(
        result.filter((r) => !r.matches).map((r) => [r.table_name, r.grantee, r.expected, r.actual]),
      ).toEqual([
        ["payout_period_closures", "service_role", "SELECT", "none"],
        ["processors", "authenticated", "SELECT", "INSERT, SELECT"],
      ]);
    } finally {
      await db.exec(`
        revoke insert on processors from authenticated;
        grant select on payout_period_closures to service_role;`);
    }
    expect((await rows<Result>(db, await inventoryQuery())).every((r) => r.matches)).toBe(true);
  });

  it("the two sequences are granted as the doc says", async () => {
    for (const [sequence, role, usage] of EXPECTED_SEQUENCES) {
      const [{ ok }] = await rows<{ ok: boolean }>(
        db,
        `select has_sequence_privilege('${role}', 'public.${sequence}', 'usage') as ok`,
      );
      expect(ok, `${role} usage on ${sequence}`).toBe(usage);
    }
  });
});
