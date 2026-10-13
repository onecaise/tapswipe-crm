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
 * accounts_in_city() — check_duplicates()'s design applied to "do we already
 * have accounts in this city?".
 *
 * It is `security definer` and reads every rep's book ON PURPOSE, so — as in
 * check-duplicates.test.ts — there is no policy underneath to catch a mistake:
 * the return shape IS the boundary. Every shape assertion below is made over
 * rows the caller could NOT read directly, and each such test first proves
 * that (a direct SELECT returning nothing), so none of them can pass by
 * accident of the fixture being the caller's own.
 *
 * prosecdef must be TRUE here. dashboard-and-search.test.ts asserts the
 * opposite for search_crm; copying that assertion here would be asserting this
 * function is broken.
 */

type Result = { results: Record<string, unknown>[]; has_more: boolean };

const NON_ADMIN_KEYS = ["city", "dba", "legal_business_name", "state"];

let db: TestDb;

/** Calls the RPC as `caller`; state omitted means the one-argument form. */
async function search(
  caller: string | null,
  city: string | null,
  state?: string | null,
): Promise<Result> {
  await asUser(db, caller);
  const lit = (v: string | null) =>
    v === null ? "null" : `'${v.replace(/'/g, "''")}'`;
  const args =
    state === undefined ? lit(city) : `${lit(city)}, ${lit(state)}`;
  const [r] = await rows<{ r: Result }>(
    db,
    `select accounts_in_city(${args}) as r`,
  );
  return r.r;
}

async function searchError(
  caller: string | null,
  city: string | null,
  state?: string | null,
): Promise<string> {
  try {
    await search(caller, city, state);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`expected accounts_in_city(${city}, ${state}) to be refused`);
}

const dbas = (r: Result) => r.results.map((x) => x.dba as string).sort();

beforeAll(async () => {
  // Legacy first, exactly as merchant-location.test.ts does: seed() against
  // the pre-location schema writes four merchants with NO city, which nothing
  // after 20261013130000 can insert. They are the "no city never appears"
  // fixture.
  const MIGRATION = "20261013130000_merchant_location.sql";
  db = await createTestDb(await migrationsBefore(MIGRATION));
  await seed(db);
  await asPlatform(db);
  for (const file of await migrationsFrom(MIGRATION)) {
    await db.exec(await readMigration(file));
  }

  await db.exec(`
    insert into merchants (agent_id, dba, legal_business_name, status, street, city, state, zip)
    values
      ('${AGENT_ID}',       'Agent Nashville Diner',  'Agent Diner LLC',   'active',   null,          'Nashville',  'TN', null),
      ('${OTHER_AGENT_ID}', 'Other Nashville Grill',  'Other Grill LLC',   'active',   '5 Secret Rd', 'Nashville',  'TN', '37209'),
      ('${OTHER_AGENT_ID}', 'Other Nashville Misc',   'Other Misc LLC',    'other',    null,          'Nashville',  'TN', null),
      ('${OTHER_AGENT_ID}', 'Other Nashville Closed', 'Other Closed LLC',  'inactive', null,          'Nashville',  'TN', null),
      ('${OTHER_AGENT_ID}', 'Arkansas Nashville Feed','Ark Feed LLC',      'active',   null,          'Nashville',  'AR', null),
      ('${OTHER_AGENT_ID}', 'Gateway Pizza',          'Gateway Pizza LLC', 'active',   null,          'St. Louis',  'MO', null),
      ('${OTHER_AGENT_ID}', 'Twin City Tobacco',      null,                'active',   null,          'Winston-Salem', 'NC', null);

    -- 101 in one city for the cap, 100 in another for its boundary.
    insert into merchants (agent_id, dba, status, city, state)
    select '${OTHER_AGENT_ID}', 'Springfield Shop ' || lpad(g::text, 3, '0'), 'active', 'Springfield', 'IL'
      from generate_series(1, 101) g;
    insert into merchants (agent_id, dba, status, city, state)
    select '${OTHER_AGENT_ID}', 'Centerville Shop ' || lpad(g::text, 3, '0'), 'active', 'Centerville', 'OH'
      from generate_series(1, 100) g;
  `);
}, 120_000);

describe("privileges", () => {
  it("is security definer ON PURPOSE, with a pinned search_path", async () => {
    await asPlatform(db);
    const [f] = await rows<{ prosecdef: boolean; proconfig: string[] }>(
      db,
      `select prosecdef, proconfig from pg_proc where proname = 'accounts_in_city'`,
    );
    expect(f.prosecdef).toBe(true);
    expect(f.proconfig).toContain("search_path=public");
  });

  it("exists exactly once, so a call cannot be ambiguous", async () => {
    await asPlatform(db);
    const r = await rows(db, `select 1 from pg_proc where proname = 'accounts_in_city'`);
    expect(r).toHaveLength(1);
  });

  it("is executable by authenticated and service_role, not by anon", async () => {
    await asPlatform(db);
    const sig = "accounts_in_city(text, text)";
    const [p] = await rows<Record<string, boolean>>(
      db,
      `select has_function_privilege('authenticated', '${sig}', 'execute') as auth,
              has_function_privilege('service_role',  '${sig}', 'execute') as svc,
              has_function_privilege('anon',          '${sig}', 'execute') as anon`,
    );
    expect(p).toEqual({ auth: true, svc: true, anon: false });
  });

  it("refuses an unauthenticated caller", async () => {
    expect(await searchError(null, "Nashville")).toMatch(/not authorised/);
  });

  it("refuses a deactivated rep whose JWT is still valid", async () => {
    await asPlatform(db);
    await db.exec(`update profiles set is_active = false where id = '${AGENT_ID}'`);
    try {
      expect(await searchError(AGENT_ID, "Nashville")).toMatch(/not authorised/);
    } finally {
      await asPlatform(db);
      await db.exec(`update profiles set is_active = true where id = '${AGENT_ID}'`);
    }
  });
});

describe("what a non-admin gets back", () => {
  it("reads across books — accounts the caller cannot SELECT directly", async () => {
    // Non-vacuity for everything in this block: under RLS the agent sees none
    // of the other rep's Nashville merchants.
    await asUser(db, AGENT_ID);
    const direct = await rows(
      db,
      `select 1 from merchants where dba in ('Other Nashville Grill', 'Other Nashville Misc')`,
    );
    expect(direct).toHaveLength(0);

    const r = await search(AGENT_ID, "Nashville", "TN");
    expect(dbas(r)).toEqual([
      "Agent Nashville Diner",
      "Other Nashville Grill",
      "Other Nashville Misc",
    ]);
  });

  it("carries EXACTLY dba, legal_business_name, city and state — for every row, own and other", async () => {
    const r = await search(AGENT_ID, "Nashville", "TN");
    expect(r.results.length).toBeGreaterThan(0);
    for (const row of r.results) {
      expect(Object.keys(row).sort()).toEqual(NON_ADMIN_KEYS);
    }
  });

  it("leaks nothing of another rep's street, zip, id, rep or status, even as values", async () => {
    const r = await search(AGENT_ID, "Nashville", "TN");
    const grill = r.results.find((x) => x.dba === "Other Nashville Grill")!;
    expect(grill).toEqual({
      dba: "Other Nashville Grill",
      legal_business_name: "Other Grill LLC",
      city: "Nashville",
      state: "TN",
    });
    const text = JSON.stringify(r);
    for (const secret of ["5 Secret Rd", "37209", OTHER_AGENT_ID, "Other Agent", "active"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("gives the result wrapper only results and has_more", async () => {
    const r = await search(AGENT_ID, "Nashville");
    expect(Object.keys(r).sort()).toEqual(["has_more", "results"]);
  });
});

describe("what an admin gets back", () => {
  it("adds the link id, the owning rep, status, street and zip", async () => {
    const r = await search(ADMIN_ID, "Nashville", "TN");
    const grill = r.results.find((x) => x.dba === "Other Nashville Grill")!;
    expect(grill).toMatchObject({
      dba: "Other Nashville Grill",
      legal_business_name: "Other Grill LLC",
      city: "Nashville",
      state: "TN",
      street: "5 Secret Rd",
      zip: "37209",
      status: "active",
      agent_id: OTHER_AGENT_ID,
      agent_name: "Other Agent",
    });
    expect(typeof grill.merchant_id).toBe("number");
  });
});

describe("matching", () => {
  it.each([
    "Nashville",
    "nashville",
    "NASHVILLE",
    "  Nashville  ",
    "Nashville.",
    "nAsHvIlLe",
  ])("matches %j to Nashville", async (city) => {
    const r = await search(AGENT_ID, city, "TN");
    expect(r.results).toHaveLength(3);
  });

  it.each(["St. Louis", "st louis", "ST.LOUIS", "St   Louis", "st. louis,"])(
    "matches %j to St. Louis",
    async (city) => {
      expect(dbas(await search(AGENT_ID, city))).toEqual(["Gateway Pizza"]);
    },
  );

  it("matches Winston Salem to Winston-Salem", async () => {
    expect(dbas(await search(AGENT_ID, "winston salem"))).toEqual(["Twin City Tobacco"]);
  });

  it("is equality, not a prefix or a fuzzy match", async () => {
    for (const city of ["Nash", "Nashvill", "Nashvilles", "Nashvile", "Saint Louis"]) {
      expect((await search(AGENT_ID, city)).results, city).toEqual([]);
    }
  });

  it("returns an empty result — not an error — for a city with no accounts", async () => {
    expect(await search(AGENT_ID, "Atlantis")).toEqual({ results: [], has_more: false });
  });
});

describe("wildcards are not wildcards", () => {
  it("non-vacuity: under LIKE, the same patterns WOULD match", async () => {
    await asPlatform(db);
    const [r] = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from merchants
        where city like 'Nash%' or city like 'Nashvill_'`,
    );
    expect(r.n).toBeGreaterThan(0);
  });

  it.each(["Nash%", "Nashvill_", "Nash*", "%ville", "N%e", "Spring%"])(
    "%j matches nothing",
    async (city) => {
      expect((await search(AGENT_ID, city)).results).toEqual([]);
    },
  );

  it.each(["%", "_", "*", "%%%%", "%_*", "N%", "*N"])(
    "%j is refused as too short once normalised",
    async (city) => {
      expect(await searchError(AGENT_ID, city)).toMatch(/at least 2 letters/);
    },
  );
});

describe("input rules", () => {
  it.each([
    ["an empty city", ""],
    ["a blank city", "   "],
    ["a null city", null],
  ])("refuses %s", async (_label, city) => {
    expect(await searchError(AGENT_ID, city)).toMatch(/Enter a city/);
  });

  it.each(["X", " x ", "X.", ".x."])("refuses %j as too short", async (city) => {
    expect(await searchError(AGENT_ID, city)).toMatch(/at least 2 letters/);
  });

  it("refuses more than 60 characters, and accepts exactly 60", async () => {
    expect(await searchError(AGENT_ID, "A".repeat(61))).toMatch(/at most 60/);
    expect(await searchError(AGENT_ID, "A".repeat(5000))).toMatch(/at most 60/);
    expect(await search(AGENT_ID, "A".repeat(60))).toEqual({ results: [], has_more: false });
  });

  it("reports a bad input as 22023 (a 400 through PostgREST)", async () => {
    await asUser(db, AGENT_ID);
    try {
      await db.query(`select accounts_in_city('')`);
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("22023");
    }
  });
});

describe("the state filter", () => {
  it("narrows to one state", async () => {
    expect(dbas(await search(AGENT_ID, "Nashville", "AR"))).toEqual(["Arkansas Nashville Feed"]);
    expect(dbas(await search(AGENT_ID, "Nashville", "TN"))).not.toContain("Arkansas Nashville Feed");
  });

  it("is optional — no state means every state", async () => {
    expect(dbas(await search(AGENT_ID, "Nashville"))).toContain("Arkansas Nashville Feed");
    expect(dbas(await search(AGENT_ID, "Nashville", ""))).toContain("Arkansas Nashville Feed");
    expect(dbas(await search(AGENT_ID, "Nashville", null))).toContain("Arkansas Nashville Feed");
  });

  it("is case-insensitive on input and exact on value", async () => {
    expect(dbas(await search(AGENT_ID, "Nashville", " ar "))).toEqual(["Arkansas Nashville Feed"]);
    expect((await search(AGENT_ID, "Nashville", "KY")).results).toEqual([]);
  });

  it.each(["Tennessee", "T", "T%", "1N", "TNN"])("refuses %j", async (state) => {
    expect(await searchError(AGENT_ID, "Nashville", state)).toMatch(/two-letter/);
  });
});

describe("which merchants count", () => {
  it("excludes inactive (closed) merchants", async () => {
    // Non-vacuity: the closed one is really in Nashville, TN.
    await asPlatform(db);
    const [c] = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from merchants
        where dba = 'Other Nashville Closed' and norm_city(city) = 'nashville' and state = 'TN'`,
    );
    expect(c.n).toBe(1);

    for (const caller of [AGENT_ID, ADMIN_ID]) {
      expect(dbas(await search(caller, "Nashville"))).not.toContain("Other Nashville Closed");
    }
  });

  it("includes status 'other'", async () => {
    expect(dbas(await search(AGENT_ID, "Nashville"))).toContain("Other Nashville Misc");
  });

  it("never returns a merchant with no city, whatever is searched", async () => {
    // Non-vacuity: the legacy rows exist.
    await asPlatform(db);
    const legacy = await rows<{ dba: string }>(
      db,
      `select dba from merchants where city is null`,
    );
    expect(legacy.length).toBeGreaterThan(0);

    const cities = await rows<{ city: string }>(
      db,
      `select distinct city from merchants where city is not null`,
    );
    for (const { city } of cities) {
      const found = dbas(await search(ADMIN_ID, city));
      for (const { dba } of legacy) {
        expect(found).not.toContain(dba);
      }
    }
  });
});

describe("the cap", () => {
  it("returns 100 and says more exist when there are 101", async () => {
    const r = await search(AGENT_ID, "Springfield");
    expect(r.results).toHaveLength(100);
    expect(r.has_more).toBe(true);
    // Ordered, so the first hundred are a stable set.
    expect(r.results[0].dba).toBe("Springfield Shop 001");
    expect(r.results[99].dba).toBe("Springfield Shop 100");
  });

  it("returns 100 and says nothing more exists when there are exactly 100", async () => {
    const r = await search(AGENT_ID, "Centerville");
    expect(r.results).toHaveLength(100);
    expect(r.has_more).toBe(false);
  });

  it("caps an admin too", async () => {
    const r = await search(ADMIN_ID, "Springfield");
    expect(r.results).toHaveLength(100);
    expect(r.has_more).toBe(true);
  });
});

describe("nothing is written", () => {
  it("leaves audit_log untouched — neither precedent logs, so neither does this", async () => {
    await asPlatform(db);
    const before = await rows<{ n: number }>(db, `select count(*)::int as n from audit_log`);
    await search(AGENT_ID, "Nashville");
    await search(ADMIN_ID, "Nashville");
    await asPlatform(db);
    const after = await rows<{ n: number }>(db, `select count(*)::int as n from audit_log`);
    expect(after[0].n).toBe(before[0].n);
  });
});
