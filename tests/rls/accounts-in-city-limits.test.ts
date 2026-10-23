import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_ID,
  AGENT_ID,
  OTHER_AGENT_ID,
  asPlatform,
  asUser,
  createTestDb,
  migrationsBefore,
  migrationsFrom,
  readMigration,
  rows,
  seed,
  type TestDb,
} from "../helpers/db";

/**
 * accounts_in_city(): every call audited, reps rate-limited (security review
 * phase 5, 20261023120000).
 *
 * The claim: the input is a public city name, so a rep can loop over a list of
 * cities and rebuild the company's merchant list, with nothing recorded and
 * nothing stopping them. Corrected in one detail: the function takes ONE city
 * per call (the "100" is the result cap), so the loop is one call per city.
 *
 * The rate limit's counter is the audit rows, so the clock is moved by
 * backdating those rows as the platform owner.
 */

const LIMIT = 30;
const FIX = "20261023120000_accounts_in_city_audit_and_limit.sql";
const LOCATION = "20261013130000_merchant_location.sql";

/** Legacy seed first, then every migration from `LOCATION` up to (not incl.) `stopBefore`. */
async function buildDb(stopBefore: string | null): Promise<TestDb> {
  const db = await createTestDb(await migrationsBefore(LOCATION));
  await seed(db);
  await asPlatform(db);
  for (const file of await migrationsFrom(LOCATION)) {
    if (stopBefore && file >= stopBefore) break;
    await db.exec(await readMigration(file));
  }
  await db.exec(`
    insert into merchants (agent_id, dba, legal_business_name, status, city, state)
    values ('${OTHER_AGENT_ID}', 'Other Nashville Grill', 'Other Grill LLC', 'active', 'Nashville', 'TN');
  `);
  return db;
}

type Outcome = { ok: true; n: number } | { ok: false; code: string; message: string };

async function call(db: TestDb, caller: string | null, city = "Nashville"): Promise<Outcome> {
  await asUser(db, caller);
  try {
    const [r] = await rows<{ r: { results: unknown[] } }>(
      db,
      `select accounts_in_city('${city.replace(/'/g, "''")}') as r`,
    );
    return { ok: true, n: r.r.results.length };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, code: err.code ?? "", message: err.message ?? String(e) };
  } finally {
    await asPlatform(db);
  }
}

async function callTimes(db: TestDb, caller: string, times: number): Promise<Outcome[]> {
  const out: Outcome[] = [];
  for (let i = 0; i < times; i++) out.push(await call(db, caller));
  return out;
}

async function auditRows(db: TestDb, actor?: string) {
  await asPlatform(db);
  return rows<{ actor_id: string | null; action: string; table_name: string | null; row_id: string | null }>(
    db,
    `select actor_id, action, table_name, row_id from audit_log
      where action like 'accounts_in_city%' ${actor ? `and actor_id = '${actor}'` : ""}
      order by id`,
  );
}

describe("reproduced: before the fix, a rep loops freely and nothing is recorded", () => {
  it("40 searches by one rep all answer, and audit_log holds nothing for them", async () => {
    const db = await buildDb(FIX);
    const before = await rows<{ n: number }>(db, `select count(*)::int as n from audit_log`);
    const out = await callTimes(db, AGENT_ID, 40);
    expect(out.every((o) => o.ok && o.n === 1)).toBe(true);
    const after = await rows<{ n: number }>(db, `select count(*)::int as n from audit_log`);
    expect(after[0].n).toBe(before[0].n);
  }, 60_000);
});

describe("after the fix", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await buildDb(null);
  }, 120_000);

  beforeEach(async () => {
    await asPlatform(db);
    await db.exec(`delete from audit_log where action like 'accounts_in_city%'`);
  });

  describe("the function", () => {
    it("still takes exactly one city per call (the cap of 5 is met by signature)", async () => {
      const r = await rows<{ args: string }>(
        db,
        `select pg_get_function_identity_arguments(oid) as args from pg_proc where proname = 'accounts_in_city'`,
      );
      expect(r).toEqual([{ args: "city text, state text" }]);
    });

    it("is volatile (it writes), definer, search_path public, pg_temp, and serialises a caller", async () => {
      const [f] = await rows<{ provolatile: string; prosecdef: boolean; proconfig: string[]; src: string }>(
        db,
        `select provolatile, prosecdef, proconfig, prosrc as src from pg_proc where proname = 'accounts_in_city'`,
      );
      expect(f.provolatile).toBe("v");
      expect(f.prosecdef).toBe(true);
      expect(f.proconfig).toEqual(["search_path=public, pg_temp"]);
      // One rep's concurrent calls must not both pass at 29. PGlite has one
      // connection and cannot race; the local-stack check is in
      // tests/live/accounts-in-city-limit.test.ts.
      expect(f.src).toMatch(/pg_advisory_xact_lock\(hashtextextended\('accounts_in_city:' \|\| auth\.uid\(\)::text, 0\)\)/);
    });

    it("has the partial index the count uses", async () => {
      const r = await rows<{ def: string }>(
        db,
        `select indexdef as def from pg_indexes where indexname = 'audit_log_city_search_idx'`,
      );
      expect(r).toHaveLength(1);
      expect(r[0].def).toMatch(/\(actor_id, created_at\) WHERE \(action ~~ 'accounts_in_city:%'::text\)/);
    });
  });

  describe("audit", () => {
    it("a rep's call writes one row: the caller, the number of cities, and nothing about the query or results", async () => {
      expect(await call(db, AGENT_ID)).toEqual({ ok: true, n: 1 });
      expect(await auditRows(db)).toEqual([
        { actor_id: AGENT_ID, action: "accounts_in_city:1", table_name: "merchants", row_id: null },
      ]);
      const leaks = await rows(db, `select 1 from audit_log where (action || coalesce(row_id, '')) ilike '%nashville%'`);
      expect(leaks).toHaveLength(0);
    });

    it("an admin's call is audited too", async () => {
      expect((await call(db, ADMIN_ID)).ok).toBe(true);
      expect(await auditRows(db)).toEqual([
        { actor_id: ADMIN_ID, action: "accounts_in_city:1", table_name: "merchants", row_id: null },
      ]);
    });

    it("a city with no accounts is still a call, and still audited", async () => {
      expect(await call(db, AGENT_ID, "Nowhereville")).toEqual({ ok: true, n: 0 });
      expect(await auditRows(db, AGENT_ID)).toHaveLength(1);
    });

    it("a refused call (bad input, unauthenticated, deactivated) answers nothing and leaves no row", async () => {
      expect((await call(db, AGENT_ID, "x")).ok).toBe(false);
      expect((await call(db, null)).ok).toBe(false);
      await db.exec(`update profiles set is_active = false where id = '${AGENT_ID}'`);
      try {
        expect((await call(db, AGENT_ID)).ok).toBe(false);
      } finally {
        await asPlatform(db);
        await db.exec(`update profiles set is_active = true where id = '${AGENT_ID}'`);
      }
      expect(await auditRows(db)).toEqual([]);
    });

    it("a rep cannot read, delete or forge the rows that count against them", async () => {
      await callTimes(db, AGENT_ID, 3);
      await asUser(db, AGENT_ID);
      expect(await rows(db, `select 1 from audit_log`)).toHaveLength(0);
      await expect(db.exec(`delete from audit_log`)).rejects.toThrow(/permission denied/);
      await expect(
        db.exec(`insert into audit_log (actor_id, action) values ('${OTHER_AGENT_ID}', 'accounts_in_city:1')`),
      ).rejects.toThrow(/permission denied/);
      expect(await auditRows(db, AGENT_ID)).toHaveLength(3);
    });
  });

  describe("rate limit", () => {
    it(`a rep gets ${LIMIT} calls an hour; the next is PT429 with a showable sentence, and leaves no row`, async () => {
      const out = await callTimes(db, AGENT_ID, LIMIT);
      expect(out.every((o) => o.ok)).toBe(true);
      const over = await call(db, AGENT_ID);
      expect(over).toEqual({
        ok: false,
        code: "PT429",
        message: "You have reached the limit of 30 city searches an hour. Try again in 60 minutes.",
      });
      expect(await auditRows(db, AGENT_ID)).toHaveLength(LIMIT);
    }, 60_000);

    it("says how long until the oldest call in the window ages out", async () => {
      await callTimes(db, AGENT_ID, LIMIT);
      await db.exec(`update audit_log set created_at = now() - interval '50 minutes 30 seconds'
                      where actor_id = '${AGENT_ID}' and action like 'accounts_in_city:%'`);
      const over = await call(db, AGENT_ID);
      expect(over.ok).toBe(false);
      expect(!over.ok && over.message).toMatch(/Try again in 10 minutes\.$/);

      await db.exec(`update audit_log set created_at = now() - interval '59 minutes 30 seconds'
                      where actor_id = '${AGENT_ID}' and action like 'accounts_in_city:%'`);
      const last = await call(db, AGENT_ID);
      expect(!last.ok && last.message).toMatch(/Try again in 1 minute\.$/);
    }, 60_000);

    it("is a rolling hour: calls older than an hour stop counting", async () => {
      await callTimes(db, AGENT_ID, LIMIT);
      await db.exec(`update audit_log set created_at = now() - interval '61 minutes'
                      where actor_id = '${AGENT_ID}' and action like 'accounts_in_city:%'`);
      expect((await call(db, AGENT_ID)).ok).toBe(true);
    }, 60_000);

    it("counts per rep: one rep at the limit does not block another", async () => {
      await callTimes(db, AGENT_ID, LIMIT);
      expect((await call(db, AGENT_ID)).ok).toBe(false);
      expect((await call(db, OTHER_AGENT_ID)).ok).toBe(true);
    }, 60_000);

    it("admins are exempt from the limit but every call is still audited", async () => {
      const out = await callTimes(db, ADMIN_ID, LIMIT + 5);
      expect(out.every((o) => o.ok)).toBe(true);
      expect(await auditRows(db, ADMIN_ID)).toHaveLength(LIMIT + 5);
    }, 60_000);

    it("other audit rows by the rep do not count against the limit", async () => {
      await db.exec(`insert into audit_log (actor_id, action, table_name)
                     select '${AGENT_ID}', 'cross_agent_update', 'leads' from generate_series(1, 40)`);
      try {
        expect((await call(db, AGENT_ID)).ok).toBe(true);
      } finally {
        await asPlatform(db);
        await db.exec(`delete from audit_log where actor_id = '${AGENT_ID}' and action = 'cross_agent_update'`);
      }
    });
  });
});
