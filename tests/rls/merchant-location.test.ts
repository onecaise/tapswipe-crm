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

/**
 * THE PRODUCTION PROBLEM the first design had, pinned. A NOT VALID CHECK skips
 * the rows that exist when it is added, but it is enforced on EVERY later
 * UPDATE of those rows — so with a table-wide "city and state required" CHECK,
 * an admin could not change a legacy merchant's status or MID without also
 * inventing a location. These ran red against that design (the as-pushed
 * 20261013130000) before the redesign, and are the proof it is gone.
 *
 * Each runs against a merchant seed() wrote BEFORE the migration (no city,
 * no state), and first asserts that is still true, so none can pass by
 * touching a row that happens to have a location.
 */
describe("an existing merchant with no location stays editable", () => {
  async function legacy(dba: string): Promise<{ city: string | null; state: string | null }> {
    await asPlatform(db);
    const [m] = await rows<{ city: string | null; state: string | null }>(
      db,
      `select city, state from merchants where dba = '${dba}'`,
    );
    return m;
  }

  it("lets an admin change its status", async () => {
    expect(await legacy("Other Other Co")).toEqual({ city: null, state: null });
    await asUser(db, ADMIN_ID);
    await db.exec(`update merchants set status = 'inactive' where dba = 'Other Other Co'`);
    await asPlatform(db);
    const [m] = await rows<{ status: string }>(
      db,
      `select status from merchants where dba = 'Other Other Co'`,
    );
    expect(m.status).toBe("inactive");
    await db.exec(`update merchants set status = 'other' where dba = 'Other Other Co'`);
  });

  it("lets an admin change its MID", async () => {
    expect(await legacy("Other Active Co")).toEqual({ city: null, state: null });
    await asUser(db, ADMIN_ID);
    await db.exec(`update merchants set mid = 'MID-OTHER-1B' where dba = 'Other Active Co'`);
    await asPlatform(db);
    const [m] = await rows<{ mid: string }>(
      db,
      `select mid from merchants where dba = 'Other Active Co'`,
    );
    expect(m.mid).toBe("MID-OTHER-1B");
    await db.exec(`update merchants set mid = 'MID-OTHER-1' where dba = 'Other Active Co'`);
  });

  it("lets an admin edit a rep's legacy merchant; the owning rep cannot (20261021120000)", async () => {
    expect(await legacy("Agent Active Co")).toEqual({ city: null, state: null });

    // Merchants are admin-only to change. The rep's update is filtered, not
    // refused, so the row count is the assertion.
    await asUser(db, AGENT_ID);
    const rep = await db.query(
      `update merchants set processor = 'Elavon' where dba = 'Agent Active Co'`,
    );
    expect(rep.affectedRows).toBe(0);

    await asUser(db, ADMIN_ID);
    const admin = await db.query(
      `update merchants set processor = 'Elavon' where dba = 'Agent Active Co'`,
    );
    expect(admin.affectedRows).toBe(1);
    await asPlatform(db);
    await db.exec(`update merchants set processor = 'TSYS' where dba = 'Agent Active Co'`);
  });
});

describe("a NEW merchant must have a location (merchants_location_guard)", () => {
  it("has no table-wide required CHECK left — only the NULL-tolerant format one", async () => {
    await asPlatform(db);
    const c = await rows<{ conname: string; convalidated: boolean }>(
      db,
      `select conname, convalidated from pg_constraint
        where conrelid = 'merchants'::regclass and conname like 'merchants_location%'
        order by conname`,
    );
    expect(c).toEqual([{ conname: "merchants_location_format", convalidated: true }]);

    // Non-vacuity: the legacy seed() merchants are really there, really bare.
    const legacy = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from merchants where city is null and state is null`,
    );
    expect(legacy[0].n).toBe(4);
  });

  it("accepts a new merchant with a city and a two-letter state", async () => {
    await expect(
      insertAs(ADMIN_ID, { city: "St. Louis", state: "MO", dba: "Valid Loc Co" }),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["no city", null, "TN"],
    ["no state", "Nashville", null],
    ["neither", null, null],
  ])("refuses a new merchant with %s, by name", async (_label, city, state) => {
    await expect(insertAs(ADMIN_ID, { city, state })).rejects.toThrow(
      /A new merchant needs a city and a two-letter state/,
    );
  });

  it("refuses an admin too — it is a trigger, not a policy", async () => {
    await expect(insertAs(ADMIN_ID, { city: null, state: "TN" })).rejects.toThrow(
      /needs a city/,
    );
  });

  it("refuses the platform owner too, so a fixture or a function cannot skip it", async () => {
    await asPlatform(db);
    await expect(
      db.exec(`insert into merchants (agent_id, dba) values ('${AGENT_ID}', 'Owner Bare Co')`),
    ).rejects.toThrow(/needs a city/);
  });

  it("reports PT422, which the forms show verbatim", async () => {
    await asUser(db, ADMIN_ID);
    try {
      await db.query(`insert into merchants (agent_id, dba) values ('${ADMIN_ID}', 'Code Co')`);
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("PT422");
    }
  });
});

describe("merchants_location_format — shape when present, on every row", () => {
  it.each([
    ["a blank city", "   ", "TN"],
    ["a city that is only punctuation", "...", "TN"],
    ["a one-letter city", "X", "TN"],
    ["a city over 60 characters", "A".repeat(61), "TN"],
    ["a lower-case state", "Nashville", "tn"],
    ["a state name instead of a code", "Nashville", "Tennessee"],
  ])("refuses %s on insert", async (_label, city, state) => {
    await expect(insertAs(ADMIN_ID, { city, state })).rejects.toThrow(
      /merchants_location_format/,
    );
  });

  it("refuses a malformed location on an UPDATE of a legacy merchant", async () => {
    await asUser(db, ADMIN_ID);
    await expect(
      db.exec(`update merchants set city = 'Nashville', state = 'Tenn' where dba = 'Other Other Co'`),
    ).rejects.toThrow(/merchants_location_format/);
  });

  it("accepts exactly 60 characters", async () => {
    await expect(
      insertAs(ADMIN_ID, { city: "B".repeat(60), state: "TN", dba: "Sixty Co" }),
    ).resolves.toBeUndefined();
  });
});

describe("once a merchant has a location", () => {
  it("lets an admin give a legacy merchant one", async () => {
    await asUser(db, ADMIN_ID);
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

  it("lets it be changed to another valid one", async () => {
    await asUser(db, ADMIN_ID);
    await db.exec(`update merchants set city = 'Memphis' where dba = 'Agent Inactive Co'`);
    await db.exec(`update merchants set city = 'Nashville' where dba = 'Agent Inactive Co'`);
  });

  it.each([
    ["city", "city = null"],
    ["state", "state = null"],
  ])("refuses removing its %s", async (_label, set) => {
    await asUser(db, ADMIN_ID);
    await expect(
      db.exec(`update merchants set ${set} where dba = 'Agent Inactive Co'`),
    ).rejects.toThrow(/can be changed but not removed/);
  });

  it("still lets an admin edit every other column", async () => {
    await asUser(db, ADMIN_ID);
    await db.exec(`update merchants set processor = 'FDMS' where dba = 'Agent Inactive Co'`);
    await asPlatform(db);
    const [m] = await rows<{ processor: string }>(
      db,
      `select processor from merchants where dba = 'Agent Inactive Co'`,
    );
    expect(m.processor).toBe("FDMS");
  });

  it("does not let the owning rep add or change a location (20261021120000)", async () => {
    // The detail page used to say "edit to add"; a rep now asks an admin.
    await asUser(db, AGENT_ID);
    const r = await db.query(
      `update merchants set city = 'Memphis', state = 'TN' where dba = 'Agent Active Co'`,
    );
    expect(r.affectedRows).toBe(0);
    await asPlatform(db);
    const [m] = await rows<{ city: string | null }>(
      db,
      `select city from merchants where dba = 'Agent Active Co'`,
    );
    expect(m.city).toBeNull();
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
