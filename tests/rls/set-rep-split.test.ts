import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_ID,
  AGENT_ID,
  OTHER_AGENT_ID,
  asPlatform,
  asUser,
  createTestDb,
  resetData,
  rows,
  type TestDb,
} from "../helpers/db";

/**
 * set_rep_split() — the only write path to profiles.split_rate_pct, the rep's
 * share of a merchant's residual (phase 4 of docs/design/intake-and-reports.md,
 * §0b.4). Built as set_rep_identity() is: security definer, is_admin() first,
 * audited in the same statement, no client UPDATE path, never in a policy.
 *
 * A definer function's guards are hand-written, so a deleted guard fails open
 * silently: one test per guard.
 */

type AuditRow = { actor_id: string | null; action: string; table_name: string; row_id: string };

const MISSING_USER = "44444444-4444-4444-4444-444444444444";
const SIG = "public.set_rep_split(uuid, numeric)";

async function rateOf(db: TestDb, id: string): Promise<string> {
  await asPlatform(db);
  const [row] = await rows<{ r: string }>(
    db,
    `select split_rate_pct::text as r from profiles where id = '${id}'`,
  );
  return row.r;
}

async function auditRows(db: TestDb): Promise<AuditRow[]> {
  await asPlatform(db);
  return rows<AuditRow>(
    db,
    `select actor_id, action, table_name, row_id from audit_log
      where action = 'set_rep_split' order by id`,
  );
}

/** Runs set_rep_split as `caller`; the error message, or null. */
async function setSplit(
  db: TestDb,
  caller: string | null,
  target: string,
  rate: string,
): Promise<string | null> {
  await asUser(db, caller);
  try {
    await db.exec(`select set_rep_split('${target}', ${rate})`);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(async () => {
  await resetData(db);
});

afterAll(async () => {
  await db?.close();
});

describe("profiles.split_rate_pct", () => {
  it("defaults to 50 for every profile", async () => {
    await asPlatform(db);
    const r = await rows<{ r: string }>(
      db,
      `select distinct split_rate_pct::text as r from profiles`,
    );
    expect(r).toEqual([{ r: "50.00" }]);
  });

  for (const value of ["50.01", "-0.01", "100"]) {
    it(`profiles_split_rate_pct_range refuses ${value}, even for the table owner`, async () => {
      await asPlatform(db);
      await expect(
        db.exec(`update profiles set split_rate_pct = ${value} where id = '${AGENT_ID}'`),
      ).rejects.toThrow(/profiles_split_rate_pct_range/);
    });
  }
});

describe("set_rep_split rejects everyone who is not an active admin", () => {
  it("refuses an agent setting their own rate", async () => {
    expect(await setSplit(db, AGENT_ID, AGENT_ID, "50")).toMatch(/admin only/);
    expect(await setSplit(db, AGENT_ID, AGENT_ID, "40")).toMatch(/admin only/);
    expect(await rateOf(db, AGENT_ID)).toBe("50.00");
  });

  it("refuses an agent setting another rep's rate", async () => {
    expect(await setSplit(db, AGENT_ID, OTHER_AGENT_ID, "10")).toMatch(/admin only/);
    expect(await rateOf(db, OTHER_AGENT_ID)).toBe("50.00");
  });

  it("refuses a caller with no JWT", async () => {
    expect(await setSplit(db, null, AGENT_ID, "10")).toMatch(/admin only/);
    expect(await rateOf(db, AGENT_ID)).toBe("50.00");
  });

  it("refuses a deactivated admin", async () => {
    await asPlatform(db);
    await db.exec(`update profiles set is_active = false where id = '${ADMIN_ID}'`);
    expect(await setSplit(db, ADMIN_ID, AGENT_ID, "10")).toMatch(/admin only/);
    expect(await rateOf(db, AGENT_ID)).toBe("50.00");
  });

  it("checks the caller before the arguments", async () => {
    // An agent probing with a bad value learns "admin only", not which
    // values are valid.
    expect(await setSplit(db, AGENT_ID, AGENT_ID, "99")).toMatch(/admin only/);
  });

  it("writes no audit row when it refuses", async () => {
    await setSplit(db, AGENT_ID, AGENT_ID, "10");
    expect(await auditRows(db)).toEqual([]);
  });
});

describe("an admin sets the rate", () => {
  it("stores it and audits it, naming the admin and the rep", async () => {
    expect(await setSplit(db, ADMIN_ID, AGENT_ID, "46.5")).toBeNull();
    expect(await rateOf(db, AGENT_ID)).toBe("46.50");
    expect(await auditRows(db)).toEqual([
      { actor_id: ADMIN_ID, action: "set_rep_split", table_name: "profiles", row_id: AGENT_ID },
    ]);
  });

  it("accepts both bounds: 0 (the house profile) and 50", async () => {
    expect(await setSplit(db, ADMIN_ID, AGENT_ID, "0")).toBeNull();
    expect(await rateOf(db, AGENT_ID)).toBe("0.00");
    expect(await setSplit(db, ADMIN_ID, AGENT_ID, "50")).toBeNull();
    expect(await rateOf(db, AGENT_ID)).toBe("50.00");
  });

  it("writes no audit row when the rate does not change", async () => {
    expect(await setSplit(db, ADMIN_ID, AGENT_ID, "50.00")).toBeNull();
    expect(await auditRows(db)).toEqual([]);
  });

  it("lets an admin set their own", async () => {
    expect(await setSplit(db, ADMIN_ID, ADMIN_ID, "25")).toBeNull();
    expect(await rateOf(db, ADMIN_ID)).toBe("25.00");
  });

  it("reports a missing user rather than silently doing nothing", async () => {
    expect(await setSplit(db, ADMIN_ID, MISSING_USER, "25")).toMatch(/user not found/);
    expect(await auditRows(db)).toEqual([]);
  });

  for (const [label, value, message] of [
    ["a rate above 50", "50.01", /between 0 and 50/],
    ["a negative rate", "-0.01", /between 0 and 50/],
    ["a null rate", "null", /required/],
    ["three decimal places, rather than rounding", "46.555", /two decimal places/],
  ] as const) {
    it(`refuses ${label}, changing nothing and auditing nothing`, async () => {
      expect(await setSplit(db, ADMIN_ID, AGENT_ID, value)).toMatch(message);
      expect(await rateOf(db, AGENT_ID)).toBe("50.00");
      expect(await auditRows(db)).toEqual([]);
    });
  }

  it("fails closed: if the audit row cannot be written, the rate is not changed", async () => {
    // A CHECK that refuses this one verb stands in for any failure of the
    // audit insert. No exception handler wraps it, so the whole call rolls
    // back. Removed again after, whatever happens.
    await asPlatform(db);
    await db.exec(
      `alter table audit_log add constraint test_no_set_rep_split
         check (action <> 'set_rep_split') not valid`,
    );
    try {
      expect(await setSplit(db, ADMIN_ID, AGENT_ID, "30")).toMatch(/test_no_set_rep_split/);
      expect(await rateOf(db, AGENT_ID)).toBe("50.00");
    } finally {
      await asPlatform(db);
      await db.exec(`alter table audit_log drop constraint test_no_set_rep_split`);
    }
  });
});

describe("the rate has no direct client write path", () => {
  it("refuses an admin's direct UPDATE", async () => {
    await asUser(db, ADMIN_ID);
    await expect(
      db.exec(`update profiles set split_rate_pct = 30 where id = '${AGENT_ID}'`),
    ).rejects.toThrow(/permission denied/i);
    expect(await rateOf(db, AGENT_ID)).toBe("50.00");
  });

  it("refuses a rep's direct UPDATE of their own", async () => {
    await asUser(db, AGENT_ID);
    await expect(
      db.exec(`update profiles set split_rate_pct = 50 where id = '${AGENT_ID}'`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("grants authenticated no UPDATE or INSERT on the column", async () => {
    await asPlatform(db);
    const [row] = await rows<{ upd: boolean; ins: boolean }>(
      db,
      `select
         has_column_privilege('authenticated', 'profiles', 'split_rate_pct', 'UPDATE') as upd,
         has_column_privilege('authenticated', 'profiles', 'split_rate_pct', 'INSERT') as ins`,
    );
    expect(row).toEqual({ upd: false, ins: false });
  });

  it("names the column in no policy", async () => {
    await asPlatform(db);
    const [{ n }] = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from pg_policies
        where coalesce(qual, '') || coalesce(with_check, '') ~ 'split_rate_pct'`,
    );
    expect(n).toBe(0);
  });

  it("lets a rep read their own rate and nobody else's", async () => {
    await asUser(db, AGENT_ID);
    const visible = await rows<{ id: string }>(
      db,
      `select id from profiles where split_rate_pct is not null`,
    );
    expect(visible.map((r) => r.id)).toEqual([AGENT_ID]);
  });
});

describe("the function itself", () => {
  it("is security definer with a pinned search_path", async () => {
    await asPlatform(db);
    const [row] = await rows<{ prosecdef: boolean; proconfig: string[] | null }>(
      db,
      `select prosecdef, proconfig from pg_proc where oid = '${SIG}'::regprocedure`,
    );
    expect(row.prosecdef).toBe(true);
    expect(row.proconfig).toEqual(["search_path=public, pg_temp"]);
  });

  it("is executable by authenticated and service_role, never anon or PUBLIC", async () => {
    await asPlatform(db);
    const [row] = await rows<{
      anon: boolean;
      authenticated: boolean;
      service_role: boolean;
      public_acl: boolean;
    }>(
      db,
      `select
         has_function_privilege('anon', '${SIG}', 'execute') as anon,
         has_function_privilege('authenticated', '${SIG}', 'execute') as authenticated,
         has_function_privilege('service_role', '${SIG}', 'execute') as service_role,
         exists (
           select 1 from pg_proc p, aclexplode(p.proacl) a
            where p.oid = '${SIG}'::regprocedure and a.grantee = 0
         ) as public_acl`,
    );
    expect(row).toEqual({
      anon: false,
      authenticated: true,
      service_role: true,
      public_acl: false,
    });
  });
});
