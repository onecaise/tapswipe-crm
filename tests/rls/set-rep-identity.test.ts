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
 * set_rep_identity() — the only write path to profiles.legal_name and
 * profiles.llc_legal_name (phase 2 of docs/design/intake-and-reports.md).
 *
 * `security definer` over profiles, so every restriction is a hand-written
 * guard and a deleted guard fails open silently: one test per guard, the
 * set_territory pattern. Phase 4 makes these two values gate pre-app submit
 * and print on the processor's paperwork, which is why blank and over-long are
 * refused rather than stored.
 */

type ProfileRow = {
  legal_name: string | null;
  llc_legal_name: string | null;
};

type AuditRow = {
  actor_id: string | null;
  action: string;
  table_name: string;
  row_id: string;
};

const MISSING_USER = "44444444-4444-4444-4444-444444444444";

function lit(value: string | null): string {
  return value === null ? "null" : `'${value.replace(/'/g, "''")}'`;
}

async function identity(db: TestDb, id: string): Promise<ProfileRow> {
  await asPlatform(db);
  const [row] = await rows<ProfileRow>(
    db,
    `select legal_name, llc_legal_name from profiles where id = '${id}'`,
  );
  return row;
}

async function auditRows(db: TestDb): Promise<AuditRow[]> {
  await asPlatform(db);
  return rows<AuditRow>(
    db,
    `select actor_id, action, table_name, row_id from audit_log order by id asc`,
  );
}

async function preset(
  db: TestDb,
  id: string,
  legal: string | null,
  llc: string | null,
): Promise<void> {
  await asPlatform(db);
  await db.exec(
    `update profiles set legal_name = ${lit(legal)}, llc_legal_name = ${lit(llc)}
      where id = '${id}'`,
  );
}

/** Runs set_rep_identity as `caller`, returning the error message or null. */
async function setIdentity(
  db: TestDb,
  caller: string | null,
  target: string,
  legal: string | null,
  llc: string | null,
): Promise<string | null> {
  await asUser(db, caller);
  try {
    await db.exec(
      `select set_rep_identity('${target}', ${lit(legal)}, ${lit(llc)})`,
    );
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

describe("set_rep_identity rejects everyone who is not an active admin", () => {
  it("refuses an agent setting another rep's identity", async () => {
    const error = await setIdentity(
      db, AGENT_ID, OTHER_AGENT_ID, "Bo Lee", "Lee LLC",
    );
    expect(error).toMatch(/admin only/);
    expect(await identity(db, OTHER_AGENT_ID)).toEqual({
      legal_name: null,
      llc_legal_name: null,
    });
  });

  it("refuses an agent setting their own identity", async () => {
    // Admin-set only (memo §0.6): no self-service, or the submit gate in
    // phase 4 would be a gate the rep opens themselves.
    const error = await setIdentity(
      db, AGENT_ID, AGENT_ID, "Ann Ito", "Ito Payments LLC",
    );
    expect(error).toMatch(/admin only/);
    expect((await identity(db, AGENT_ID)).legal_name).toBeNull();
  });

  it("refuses a caller with no JWT", async () => {
    const error = await setIdentity(db, null, AGENT_ID, "Ann Ito", "Ito LLC");
    expect(error).toMatch(/admin only/);
    expect((await identity(db, AGENT_ID)).legal_name).toBeNull();
  });

  it("refuses a deactivated admin", async () => {
    await asPlatform(db);
    await db.exec(
      `update profiles set is_active = false where id = '${ADMIN_ID}'`,
    );
    const error = await setIdentity(db, ADMIN_ID, AGENT_ID, "Ann Ito", "Ito LLC");
    expect(error).toMatch(/admin only/);
    expect((await identity(db, AGENT_ID)).legal_name).toBeNull();
  });

  it("checks the caller before the arguments", async () => {
    // A rep probing with a blank value must get "admin only", not a validation
    // message that confirms the function would otherwise have run.
    const error = await setIdentity(db, AGENT_ID, AGENT_ID, "   ", "x");
    expect(error).toMatch(/admin only/);
  });

  it("writes no audit row when it refuses", async () => {
    await setIdentity(db, AGENT_ID, OTHER_AGENT_ID, "Bo Lee", "Lee LLC");
    expect(await auditRows(db)).toEqual([]);
  });
});

describe("the two columns have no direct client write path", () => {
  for (const column of ["legal_name", "llc_legal_name"]) {
    it(`refuses an admin's direct UPDATE of ${column}`, async () => {
      await asUser(db, ADMIN_ID);
      await expect(
        db.exec(`update profiles set ${column} = 'X' where id = '${AGENT_ID}'`),
      ).rejects.toThrow(/permission denied/i);
      expect((await identity(db, AGENT_ID))[column as keyof ProfileRow]).toBeNull();
    });

    it(`refuses a rep's direct UPDATE of their own ${column}`, async () => {
      await asUser(db, AGENT_ID);
      await expect(
        db.exec(`update profiles set ${column} = 'X' where id = '${AGENT_ID}'`),
      ).rejects.toThrow(/permission denied/i);
      expect((await identity(db, AGENT_ID))[column as keyof ProfileRow]).toBeNull();
    });
  }

  it("grants authenticated no UPDATE on either column", async () => {
    // Column-level as well as table-level: a column grant would open the
    // column even with the table grant absent.
    await asPlatform(db);
    const [row] = await rows<{ legal: boolean; llc: boolean }>(
      db,
      `select
         has_column_privilege('authenticated', 'profiles', 'legal_name', 'UPDATE') as legal,
         has_column_privilege('authenticated', 'profiles', 'llc_legal_name', 'UPDATE') as llc`,
    );
    expect(row).toEqual({ legal: false, llc: false });
  });

  it("names neither column in any policy", async () => {
    await asPlatform(db);
    const [{ n }] = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from pg_policies
        where coalesce(qual, '') || coalesce(with_check, '')
              ~ '(legal_name|llc_legal_name)'`,
    );
    expect(n).toBe(0);
  });
});

describe("who can read the two values", () => {
  beforeEach(async () => {
    await preset(db, AGENT_ID, "Ann Ito", "Ito Payments LLC");
    await preset(db, OTHER_AGENT_ID, "Bo Lee", "Lee Merchant Services LLC");
  });

  it("lets a rep read their own", async () => {
    await asUser(db, AGENT_ID);
    const visible = await rows<ProfileRow & { id: string }>(
      db,
      `select id, legal_name, llc_legal_name from profiles`,
    );
    expect(visible).toEqual([
      { id: AGENT_ID, legal_name: "Ann Ito", llc_legal_name: "Ito Payments LLC" },
    ]);
  });

  it("lets an admin read everyone's", async () => {
    await asUser(db, ADMIN_ID);
    const visible = await rows<{ id: string; legal_name: string | null }>(
      db,
      `select id, legal_name from profiles where legal_name is not null order by legal_name`,
    );
    expect(visible.map((r) => r.id)).toEqual([AGENT_ID, OTHER_AGENT_ID]);
  });

  it("shows a rep nobody else's", async () => {
    await asUser(db, AGENT_ID);
    const others = await rows<{ id: string }>(
      db,
      `select id from profiles where id <> '${AGENT_ID}'`,
    );
    expect(others).toEqual([]);
  });
});

describe("set_rep_identity sets, trims and audits", () => {
  it("sets both values and records who did it", async () => {
    expect(
      await setIdentity(db, ADMIN_ID, AGENT_ID, "Ann Ito", "Ito Payments LLC"),
    ).toBeNull();
    expect(await identity(db, AGENT_ID)).toEqual({
      legal_name: "Ann Ito",
      llc_legal_name: "Ito Payments LLC",
    });
    expect(await auditRows(db)).toEqual([
      {
        actor_id: ADMIN_ID,
        action: "set_rep_identity",
        table_name: "profiles",
        row_id: AGENT_ID,
      },
    ]);
  });

  it("trims surrounding whitespace from both", async () => {
    expect(
      await setIdentity(db, ADMIN_ID, AGENT_ID, "  Ann Ito ", "\tIto LLC  "),
    ).toBeNull();
    expect(await identity(db, AGENT_ID)).toEqual({
      legal_name: "Ann Ito",
      llc_legal_name: "Ito LLC",
    });
  });

  it("trims tabs and newlines, not only spaces, from both", async () => {
    // Plain btrim(x) strips spaces only. Each field is tested separately so
    // dropping the whitespace set from either one goes red.
    expect(
      await setIdentity(db, ADMIN_ID, AGENT_ID, "\tAnn Ito\n", " Ito LLC\t"),
    ).toBeNull();
    expect(await identity(db, AGENT_ID)).toEqual({
      legal_name: "Ann Ito",
      llc_legal_name: "Ito LLC",
    });
  });

  it("allows the LLC name to equal the legal name (a rep with no LLC)", async () => {
    // Memo §9 A16: the admin enters the rep's own legal name, never "N/A".
    expect(
      await setIdentity(db, ADMIN_ID, AGENT_ID, "Ann Ito", "Ann Ito"),
    ).toBeNull();
    expect(await identity(db, AGENT_ID)).toEqual({
      legal_name: "Ann Ito",
      llc_legal_name: "Ann Ito",
    });
  });

  it("sets one and leaves the other unset when passed null for it", async () => {
    expect(await setIdentity(db, ADMIN_ID, AGENT_ID, "Ann Ito", null)).toBeNull();
    expect(await identity(db, AGENT_ID)).toEqual({
      legal_name: "Ann Ito",
      llc_legal_name: null,
    });
  });

  it("clears a value when passed null, and audits it", async () => {
    await preset(db, AGENT_ID, "Ann Ito", "Ito LLC");
    expect(await setIdentity(db, ADMIN_ID, AGENT_ID, "Ann Ito", null)).toBeNull();
    expect((await identity(db, AGENT_ID)).llc_legal_name).toBeNull();
    expect((await auditRows(db)).map((r) => r.action)).toEqual([
      "set_rep_identity",
    ]);
  });

  it("writes no audit row when nothing changed", async () => {
    await preset(db, AGENT_ID, "Ann Ito", "Ito LLC");
    expect(
      await setIdentity(db, ADMIN_ID, AGENT_ID, " Ann Ito ", "Ito LLC"),
    ).toBeNull();
    expect(await setIdentity(db, ADMIN_ID, OTHER_AGENT_ID, null, null)).toBeNull();
    expect(await auditRows(db)).toEqual([]);
  });

  it("lets an admin set their own", async () => {
    expect(
      await setIdentity(db, ADMIN_ID, ADMIN_ID, "Dana Cole", "Cole Holdings LLC"),
    ).toBeNull();
    expect((await identity(db, ADMIN_ID)).legal_name).toBe("Dana Cole");
  });

  it("reports a missing user rather than silently doing nothing", async () => {
    const error = await setIdentity(db, ADMIN_ID, MISSING_USER, "A", "B");
    expect(error).toMatch(/user not found/);
    expect(await auditRows(db)).toEqual([]);
  });
});

describe("set_rep_identity refuses blank and over-long values", () => {
  for (const [label, legal, llc, message] of [
    ["an empty legal name", "", "Ito LLC", /legal name cannot be blank/],
    ["a whitespace legal name", "   ", "Ito LLC", /legal name cannot be blank/],
    ["a tab-only legal name", " \t ", "Ito LLC", /legal name cannot be blank/],
    ["an empty LLC name", "Ann Ito", "", /LLC legal name cannot be blank/],
    ["a whitespace LLC name", "Ann Ito", " \t ", /LLC legal name cannot be blank/],
    ["a 201-character legal name", "L".repeat(201), "Ito LLC", /legal name must be 200 characters or fewer/],
    ["a 201-character LLC name", "Ann Ito", "C".repeat(201), /LLC legal name must be 200 characters or fewer/],
  ] as const) {
    it(`refuses ${label}, changing nothing and auditing nothing`, async () => {
      await preset(db, AGENT_ID, "Old Name", "Old LLC");
      const error = await setIdentity(db, ADMIN_ID, AGENT_ID, legal, llc);
      expect(error).toMatch(message);
      expect(await identity(db, AGENT_ID)).toEqual({
        legal_name: "Old Name",
        llc_legal_name: "Old LLC",
      });
      expect(await auditRows(db)).toEqual([]);
    });
  }

  it("accepts exactly 200 characters, after trimming", async () => {
    expect(
      await setIdentity(
        db, ADMIN_ID, AGENT_ID, ` ${"L".repeat(200)} `, "C".repeat(200),
      ),
    ).toBeNull();
    const row = await identity(db, AGENT_ID);
    expect(row.legal_name).toHaveLength(200);
    expect(row.llc_legal_name).toHaveLength(200);
  });
});

describe("the CHECKs hold the same rules below the RPC", () => {
  // The service role bypasses RLS and holds every grant, so the RPC's rules
  // would not bind it. The CHECKs do, and are named so this pins them.
  for (const [column, value, constraint] of [
    ["legal_name", "''", "profiles_legal_name_format"],
    ["legal_name", "' padded '", "profiles_legal_name_format"],
    // A tab, not a space: plain btrim() would have let this through.
    ["legal_name", "chr(9) || 'Ann'", "profiles_legal_name_format"],
    ["legal_name", `'${"L".repeat(201)}'`, "profiles_legal_name_format"],
    ["llc_legal_name", "''", "profiles_llc_legal_name_format"],
    ["llc_legal_name", "' padded '", "profiles_llc_legal_name_format"],
    ["llc_legal_name", "'Ito LLC' || chr(10)", "profiles_llc_legal_name_format"],
    ["llc_legal_name", `'${"C".repeat(201)}'`, "profiles_llc_legal_name_format"],
  ] as const) {
    it(`${constraint} refuses ${value.length > 20 ? "201 characters" : value}`, async () => {
      await asPlatform(db);
      await expect(
        db.exec(`update profiles set ${column} = ${value} where id = '${AGENT_ID}'`),
      ).rejects.toThrow(new RegExp(constraint));
    });
  }
});

describe("set_rep_identity's own privileges", () => {
  it("is security definer with a pinned search_path", async () => {
    await asPlatform(db);
    const [row] = await rows<{ prosecdef: boolean; proconfig: string[] | null }>(
      db,
      `select prosecdef, proconfig from pg_proc
        where oid = 'public.set_rep_identity(uuid, text, text)'::regprocedure`,
    );
    expect(row.prosecdef).toBe(true);
    expect(row.proconfig).toEqual(["search_path=public"]);
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
         has_function_privilege('anon', 'public.set_rep_identity(uuid, text, text)', 'execute') as anon,
         has_function_privilege('authenticated', 'public.set_rep_identity(uuid, text, text)', 'execute') as authenticated,
         has_function_privilege('service_role', 'public.set_rep_identity(uuid, text, text)', 'execute') as service_role,
         exists (
           select 1 from pg_proc p, aclexplode(p.proacl) a
            where p.oid = 'public.set_rep_identity(uuid, text, text)'::regprocedure
              and a.grantee = 0
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
