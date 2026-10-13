import { beforeAll, describe, expect, it } from "vitest";

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
 * 20261013130000 — every merchant gets a city and a state.
 *
 * The constraint ships NOT VALID (the leads_status_vocabulary arrangement), so
 * this file builds its database the way a real project got there: the schema as
 * it was before the migration, seed() writing legacy merchants with no
 * location, THEN the migration and everything after it. A fixture inserted
 * after the migration could not be location-less at all — which is the point
 * of the constraint, and also why the legacy rows can only be made this way.
 */

const MIGRATION = "20261013130000_merchant_location.sql";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb(await migrationsBefore(MIGRATION));
  await seed(db); // legacy-shaped: the merchants table has no city column yet
  await asPlatform(db);
  for (const file of await migrationsFrom(MIGRATION)) {
    await db.exec(await readMigration(file));
  }
}, 120_000);

async function insertAs(
  userId: string,
  values: { city: string | null; state: string | null; dba?: string },
): Promise<void> {
  await asUser(db, userId);
  const lit = (v: string | null) =>
    v === null ? "null" : `'${v.replace(/'/g, "''")}'`;
  await db.exec(
    `insert into merchants (agent_id, dba, city, state)
     values ('${userId}', ${lit(values.dba ?? "Loc Test Co")}, ${lit(values.city)}, ${lit(values.state)})`,
  );
}

describe("merchants_location_required", () => {
  it("ships NOT VALID, so the legacy rows survive the migration untouched", async () => {
    await asPlatform(db);
    const [c] = await rows<{ convalidated: boolean }>(
      db,
      `select convalidated from pg_constraint
        where conname = 'merchants_location_required'`,
    );
    expect(c.convalidated).toBe(false);

    // Non-vacuity: the four seed() merchants are really there, really legacy.
    const legacy = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from merchants where city is null or state is null`,
    );
    expect(legacy[0].n).toBe(4);
  });

  it("accepts a new merchant with a city and a two-letter state", async () => {
    await expect(
      insertAs(AGENT_ID, { city: "St. Louis", state: "MO", dba: "Valid Loc Co" }),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["no city", null, "TN"],
    ["a blank city", "   ", "TN"],
    ["a city that is only punctuation", "...", "TN"],
    ["a one-letter city", "X", "TN"],
    ["a city over 60 characters", "A".repeat(61), "TN"],
    // The coalesce in the CHECK exists for this one: `state ~ ...` is NULL for
    // a NULL state, and a CHECK that evaluates to NULL passes.
    ["no state", "Nashville", null],
    ["a lower-case state", "Nashville", "tn"],
    ["a state name instead of a code", "Nashville", "Tennessee"],
  ])("refuses %s", async (_label, city, state) => {
    await expect(insertAs(AGENT_ID, { city, state })).rejects.toThrow(
      /merchants_location_required/,
    );
  });

  it("refuses an admin too — it is a constraint, not a policy", async () => {
    await expect(insertAs(ADMIN_ID, { city: null, state: "TN" })).rejects.toThrow(
      /merchants_location_required/,
    );
  });

  it("refuses an UPDATE to a legacy merchant that leaves it without a location", async () => {
    await asUser(db, AGENT_ID);
    await expect(
      db.exec(`update merchants set status = 'other' where dba = 'Agent Inactive Co'`),
    ).rejects.toThrow(/merchants_location_required/);
  });

  it("lets the same UPDATE through once it supplies the location", async () => {
    await asUser(db, AGENT_ID);
    await db.exec(
      `update merchants set city = 'Nashville', state = 'TN', street = '1 Main St', zip = '37201'
        where dba = 'Agent Inactive Co'`,
    );
    await asPlatform(db);
    const [m] = await rows<{ city: string; street: string }>(
      db,
      `select city, street from merchants where dba = 'Agent Inactive Co'`,
    );
    expect(m).toEqual({ city: "Nashville", street: "1 Main St" });
  });
});

describe("the missing-location list's query", () => {
  it("returns exactly the legacy rows, and an admin sees all of them", async () => {
    await asUser(db, ADMIN_ID);
    const r = await rows<{ dba: string }>(
      db,
      `select dba from merchants where city is null or state is null order by dba`,
    );
    // Agent Inactive Co was given a location above.
    expect(r.map((x) => x.dba)).toEqual([
      "Agent Active Co",
      "Other Active Co",
      "Other Other Co",
    ]);
  });

  it("is still RLS-scoped for an agent — the page is admin-only, the rows are not widened", async () => {
    await asUser(db, OTHER_AGENT_ID);
    const r = await rows<{ dba: string }>(
      db,
      `select dba from merchants where city is null or state is null order by dba`,
    );
    expect(r.map((x) => x.dba)).toEqual(["Other Active Co", "Other Other Co"]);
  });
});

describe("norm_city", () => {
  async function key(input: string | null): Promise<string | null> {
    await asUser(db, AGENT_ID);
    const lit = input === null ? "null" : `'${input.replace(/'/g, "''")}'`;
    const [r] = await rows<{ k: string | null }>(db, `select norm_city(${lit}) as k`);
    return r.k;
  }

  it.each([
    "St. Louis",
    "st louis",
    "ST.LOUIS",
    "  St   Louis  ",
    "St.-Louis",
    "St\tLouis",
  ])("normalises %j to 'st louis'", async (input) => {
    expect(await key(input)).toBe("st louis");
  });

  it("treats a hyphen as a space, so Winston-Salem meets Winston Salem", async () => {
    expect(await key("Winston-Salem")).toBe(await key("winston salem"));
  });

  it("does NOT expand abbreviations", async () => {
    expect(await key("St Louis")).not.toBe(await key("Saint Louis"));
    expect(await key("Ft Worth")).not.toBe(await key("Fort Worth"));
  });

  it("treats %, _ and * as punctuation rather than wildcards", async () => {
    expect(await key("St%Louis")).toBe("st louis");
    expect(await key("St_Louis")).toBe("st louis");
    expect(await key("St*Louis")).toBe("st louis");
    expect(await key("%")).toBeNull();
  });

  it("maps blank and null to NULL", async () => {
    expect(await key("")).toBeNull();
    expect(await key("   ")).toBeNull();
    expect(await key(null)).toBeNull();
  });

  it("is immutable and strict, which the expression index requires", async () => {
    await asPlatform(db);
    const [f] = await rows<{ provolatile: string; proisstrict: boolean }>(
      db,
      `select provolatile, proisstrict from pg_proc where proname = 'norm_city'`,
    );
    expect(f).toEqual({ provolatile: "i", proisstrict: true });
  });

  it("is indexed by exactly the expression accounts_in_city queries", async () => {
    await asPlatform(db);
    const [i] = await rows<{ indexdef: string }>(
      db,
      `select indexdef from pg_indexes where indexname = 'idx_merchants_norm_city'`,
    );
    expect(i.indexdef).toMatch(/norm_city\(city\)/);
  });

  it("is executable by authenticated and not by anon", async () => {
    await asPlatform(db);
    const [p] = await rows<{ auth_ok: boolean; anon_ok: boolean }>(
      db,
      `select has_function_privilege('authenticated', 'norm_city(text)', 'execute') as auth_ok,
              has_function_privilege('anon', 'norm_city(text)', 'execute') as anon_ok`,
    );
    expect(p).toEqual({ auth_ok: true, anon_ok: false });
  });
});

describe("approve_pre_app carries the business address across", () => {
  /** A submitted pre-app with the given location, written as the platform. */
  async function submittedPreApp(
    dba: string,
    loc: { address: string | null; city: string | null; state: string | null; zip: string | null },
  ): Promise<number> {
    await asPlatform(db);
    const lit = (v: string | null) => (v === null ? "null" : `'${v}'`);
    // Session-level GUC rather than seed()'s transaction-local one: these are
    // two round trips, and the guard trigger only admits a non-draft insert
    // while it is on.
    await db.exec(`select set_config('tapswipe.pre_app_transition', 'on', false)`);
    const [r] = await rows<{ id: number }>(
      db,
      `insert into pre_apps (agent_id, status, dba_name, legal_business_name,
                             physical_address, city, state, zip)
       values ('${AGENT_ID}', 'submitted', '${dba}', '${dba} LLC',
               ${lit(loc.address)}, ${lit(loc.city)}, ${lit(loc.state)}, ${lit(loc.zip)})
       returning id`,
    );
    await db.exec(`select set_config('tapswipe.pre_app_transition', '', false)`);
    return r.id;
  }

  it("copies street, city, state (upper-cased) and zip onto the merchant", async () => {
    const id = await submittedPreApp("Carry Co", {
      address: " 42 Elm St ",
      city: " Chattanooga ",
      state: "tn",
      zip: "37402",
    });
    await asUser(db, ADMIN_ID);
    const [{ merchant_id }] = await rows<{ merchant_id: number }>(
      db,
      `select approve_pre_app(${id}) as merchant_id`,
    );
    await asPlatform(db);
    const [m] = await rows<Record<string, string>>(
      db,
      `select street, city, state, zip from merchants where id = ${merchant_id}`,
    );
    expect(m).toEqual({
      street: "42 Elm St",
      city: "Chattanooga",
      state: "TN",
      zip: "37402",
    });
  });

  it("leaves street and zip null when the pre-app has none", async () => {
    const id = await submittedPreApp("Bare Co", {
      address: null,
      city: "Knoxville",
      state: "TN",
      zip: "  ",
    });
    await asUser(db, ADMIN_ID);
    const [{ merchant_id }] = await rows<{ merchant_id: number }>(
      db,
      `select approve_pre_app(${id}) as merchant_id`,
    );
    await asPlatform(db);
    const [m] = await rows<Record<string, string | null>>(
      db,
      `select street, zip from merchants where id = ${merchant_id}`,
    );
    expect(m).toEqual({ street: null, zip: null });
  });

  it.each([
    ["no city", null, "TN"],
    ["no state", "Knoxville", null],
    ["a state that is not a code", "Knoxville", "Tennessee"],
  ])(
    "refuses by name, before any write, a pre-app with %s",
    async (_label, city, state) => {
      const id = await submittedPreApp(`Refused ${_label}`, {
        address: null,
        city,
        state,
        zip: null,
      });
      await asUser(db, ADMIN_ID);
      await expect(db.exec(`select approve_pre_app(${id})`)).rejects.toThrow(
        /needs a city and a two-letter state/,
      );
      await asPlatform(db);
      const [p] = await rows<{ status: string; merchants: number }>(
        db,
        `select status, (select count(*)::int from merchants where pre_app_id = ${id}) as merchants
           from pre_apps where id = ${id}`,
      );
      expect(p).toEqual({ status: "submitted", merchants: 0 });
    },
  );
});
