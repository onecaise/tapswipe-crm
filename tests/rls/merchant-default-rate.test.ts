import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_ID,
  AGENT_ID,
  OTHER_AGENT_ID,
  asPlatform,
  asUser,
  createTestDb,
  migrationsBefore,
  readMigration,
  resetData,
  rows,
  type TestDb,
} from "../helpers/db";
import { makeSubmittable } from "../helpers/pre-app-submittable";

/**
 * 20261030180000 -- decision A31 of docs/design/intake-and-reports.md: a
 * merchant created without a split rate takes its owner's CURRENT profile
 * rate, as a snapshot.
 *
 *   1. An admin's insert with no rate gets the owner's rate, the company half
 *      100 minus it; the house profile (rate 0) gives 0 / 100.
 *   2. A rate the insert carries is kept (approve_pre_app's snapshot), and a
 *      half-filled pair is left for the CHECK to refuse.
 *   3. A snapshot: a later set_rep_split changes merchants made after it,
 *      never one made before; moving a merchant does not re-rate it.
 *   4. No rate is invented: an owner with none refuses the insert.
 *   5. Catalog: definer (so RLS, not the trigger, refuses a rep), callable by
 *      no client, BEFORE INSERT only.
 *   6. The trigger is what does it (removed, the merchant has no rate), and
 *      the migration changes no existing merchant.
 */

const MIGRATION = "20261030180000_merchant_default_rate.sql";

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

/** An admin creates a merchant as the merchant form does: no rate. */
async function create(target: TestDb, owner: string, dba: string, extra = ""): Promise<number> {
  await asUser(target, ADMIN_ID);
  try {
    const [{ id }] = await rows<{ id: number }>(
      target,
      `insert into merchants (agent_id, dba, city, state${extra ? ", split_agent_pct, split_company_pct" : ""})
       values ('${owner}', '${dba}', 'Nashville', 'TN'${extra ? `, ${extra}` : ""}) returning id`,
    );
    return id;
  } finally {
    await asPlatform(target);
  }
}

async function splitOf(target: TestDb, id: number): Promise<{ a: string | null; c: string | null }> {
  await asPlatform(target);
  const [row] = await rows<{ a: string | null; c: string | null }>(
    target,
    `select split_agent_pct::text as a, split_company_pct::text as c from merchants where id = ${id}`,
  );
  return row;
}

async function setRepSplit(target: TestDb, rep: string, rate: string): Promise<void> {
  await asUser(target, ADMIN_ID);
  await target.exec(`select set_rep_split('${rep}', ${rate})`);
  await asPlatform(target);
}

let db: TestDb;

beforeAll(async () => {
  db = await open();
});

beforeEach(async () => {
  await resetData(db);
});

describe("a merchant created without a rate takes the owner's profile rate", () => {
  it("at the default 50", async () => {
    expect(await splitOf(db, await create(db, AGENT_ID, "Default Co"))).toEqual({ a: "50.00", c: "50.00" });
  });

  it("at the owner's own rate, not the default", async () => {
    await setRepSplit(db, OTHER_AGENT_ID, "37.25");
    expect(await splitOf(db, await create(db, OTHER_AGENT_ID, "Odd Rate Co"))).toEqual({ a: "37.25", c: "62.75" });
  });

  it("the house profile gives 0, the company keeping all of it", async () => {
    await setRepSplit(db, ADMIN_ID, "0");
    expect(await splitOf(db, await create(db, ADMIN_ID, "House Co"))).toEqual({ a: "0.00", c: "100.00" });
  });
});

describe("a rate the insert carries is not touched", () => {
  it("keeps an explicit pair, whatever the owner's rate", async () => {
    await setRepSplit(db, AGENT_ID, "20");
    expect(await splitOf(db, await create(db, AGENT_ID, "Explicit Co", "45, 55"))).toEqual({ a: "45.00", c: "55.00" });
  });

  it("leaves a half-filled pair for the CHECK to refuse", async () => {
    const error = await attempt(() => create(db, AGENT_ID, "Half Co", "null, 60"));
    // Whichever of the two split CHECKs Postgres evaluates first.
    expect(error?.message).toMatch(/merchants_split_(zero_to_fifty|totals_100)/);
    expect(await rows(db, `select count(*)::int as n from merchants where dba = 'Half Co'`)).toEqual([{ n: 0 }]);
  });

  it("approval keeps the pre-app's snapshot, not the owner's rate at approval", async () => {
    await asPlatform(db);
    const [{ id: draft }] = await rows<{ id: number }>(db, `select id from pre_apps where dba_name = 'Agent Draft App'`);
    await makeSubmittable(db, draft);
    await setRepSplit(db, AGENT_ID, "30");
    await asUser(db, AGENT_ID);
    await db.exec(`select submit_pre_app(${draft})`);
    await setRepSplit(db, AGENT_ID, "45");
    await asUser(db, ADMIN_ID);
    const [{ id }] = await rows<{ id: number }>(db, `select approve_pre_app(${draft}) as id`);
    expect(await splitOf(db, id)).toEqual({ a: "30.00", c: "70.00" });
  });
});

describe("a snapshot, never a link", () => {
  it("a later change to the rep's rate does not change existing merchants", async () => {
    const before = await create(db, AGENT_ID, "Before Co");
    await setRepSplit(db, AGENT_ID, "12.5");
    const after = await create(db, AGENT_ID, "After Co");
    expect(await splitOf(db, before)).toEqual({ a: "50.00", c: "50.00" });
    expect(await splitOf(db, after)).toEqual({ a: "12.50", c: "87.50" });
    await setRepSplit(db, AGENT_ID, "0");
    expect(await splitOf(db, before)).toEqual({ a: "50.00", c: "50.00" });
    expect(await splitOf(db, after)).toEqual({ a: "12.50", c: "87.50" });
  });

  it("moving a merchant to another rep does not re-rate it", async () => {
    await setRepSplit(db, OTHER_AGENT_ID, "10");
    const id = await create(db, AGENT_ID, "Moved Co");
    await asUser(db, ADMIN_ID);
    await db.exec(`update merchants set agent_id = '${OTHER_AGENT_ID}' where id = ${id}`);
    expect(await splitOf(db, id)).toEqual({ a: "50.00", c: "50.00" });
  });
});

describe("no rate is invented", () => {
  const REFUSAL =
    "This merchant's owner has no split rate on their profile, so the merchant has none to take. Set the rep's rate in Manage Users, then create the merchant.";

  it("refuses when the owner's profile has no rate (PT409), and creates nothing", async () => {
    // split_rate_pct is NOT NULL today; this is the backstop for the day it
    // is not, proved on a copy of the schema where it can be NULL.
    const target = await open();
    await resetData(target);
    await target.exec(`alter table profiles alter column split_rate_pct drop not null;
                       update profiles set split_rate_pct = null where id = '${OTHER_AGENT_ID}'`);
    const error = await attempt(() => create(target, OTHER_AGENT_ID, "No Rate Co"));
    expect(error?.code).toBe("PT409");
    expect(error?.message).toBe(REFUSAL);
    expect(await rows(target, `select count(*)::int as n from merchants where dba = 'No Rate Co'`)).toEqual([{ n: 0 }]);
  });

  it("refuses an owner that does not exist, before the foreign key would", async () => {
    const error = await attempt(() => create(db, "44444444-4444-4444-4444-444444444444", "Nobody Co"));
    expect(error?.code).toBe("PT409");
    expect(error?.message).toBe(REFUSAL);
  });
});

describe("catalog", () => {
  it("a rep's insert into another rep's book is still refused by RLS, not by a sentence about that rep's rate", async () => {
    // A BEFORE trigger runs before RLS's WITH CHECK; an invoker trigger could
    // not see the other rep's profile and would answer for it. Definer reads
    // the true rate, so the policy is what refuses, as it always did.
    await asUser(db, AGENT_ID);
    const error = await attempt(() =>
      db.exec(`insert into merchants (agent_id, dba, city, state) values ('${OTHER_AGENT_ID}', 'Not Mine Co', 'Nashville', 'TN')`),
    );
    await asPlatform(db);
    expect(error?.message).toMatch(/row-level security/);
    expect(error?.message).not.toMatch(/split rate/);
  });

  it("is a BEFORE INSERT row trigger whose function is definer, pinned, and callable by no client", async () => {
    await asPlatform(db);
    expect(
      await rows(
        db,
        `select tgname, pg_get_triggerdef(t.oid) like '%BEFORE INSERT ON public.merchants FOR EACH ROW%' as shape
           from pg_trigger t where tgrelid = 'public.merchants'::regclass and tgname = 'merchants_default_split'`,
      ),
    ).toEqual([{ tgname: "merchants_default_split", shape: true }]);
    expect(
      await rows(db, `select prosecdef as definer, proconfig as config from pg_proc where proname = 'default_merchant_split'`),
    ).toEqual([{ definer: true, config: ["search_path=public, pg_temp"] }]);
    expect(
      await rows(
        db,
        `select r as role, has_function_privilege(r, 'default_merchant_split()', 'execute') as ok
           from unnest(array['anon', 'authenticated']) as r`,
      ),
    ).toEqual([{ role: "anon", ok: false }, { role: "authenticated", ok: false }]);
  });
});

describe("the trigger is what does it, and the migration moves nothing", () => {
  it("without it, a merchant created without a rate has none (the gap A31 closes)", async () => {
    const target = await open();
    await resetData(target);
    await target.exec(`drop trigger merchants_default_split on merchants`);
    expect(await splitOf(target, await create(target, AGENT_ID, "Gap Co"))).toEqual({ a: null, c: null });
  });

  it("as INVOKER it would answer a rep's refused insert with a false sentence about the other rep", async () => {
    const target = await open();
    await resetData(target);
    await target.exec(`alter function default_merchant_split() security invoker`);
    await asUser(target, AGENT_ID);
    let message = "";
    try {
      await target.exec(`insert into merchants (agent_id, dba, city, state) values ('${OTHER_AGENT_ID}', 'Not Mine Co', 'Nashville', 'TN')`);
    } catch (error) {
      message = (error as Error).message;
    }
    await asPlatform(target);
    expect(message).toMatch(/has no split rate on their profile/);
  });

  it("applies over merchants with and without a rate, changing none of them", async () => {
    const target = await open(await migrationsBefore(MIGRATION));
    await resetData(target);
    await asPlatform(target);
    await target.exec(`insert into merchants (agent_id, mid, dba, split_agent_pct, split_company_pct, city, state)
                       values ('${AGENT_ID}', 'LEGACY-NONE', 'Legacy Co', null, null, 'Nashville', 'TN'),
                              ('${AGENT_ID}', 'LEGACY-30', 'Thirty Co', 30, 70, 'Nashville', 'TN')`);
    const snapshot = () => rows(target, `select to_jsonb(m) as j from merchants m order by id`);
    const before = await snapshot();
    await target.exec(await readMigration(MIGRATION));
    expect(await snapshot()).toEqual(before);
    // No backfill: the rate-less merchant stays rate-less.
    expect(await rows(target, `select split_agent_pct from merchants where mid = 'LEGACY-NONE'`)).toEqual([{ split_agent_pct: null }]);
  });
});
