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

/**
 * set_territory() — the RPC behind the Territory cell on Manage Users, and the
 * only write path to profiles.territory a client can reach.
 *
 * `security definer`, so as with set_user_role and set_agent_number there is no
 * RLS doing any of the work: every restriction is a guard written by hand inside
 * the function, and a guard that gets deleted fails open silently. Hence a test
 * per guard.
 *
 * Territory is a reporting label and decides nothing, which is precisely why
 * this file exists rather than being skipped as low-stakes. The function is
 * `security definer` over `profiles` — the table that decides who is an admin —
 * so its blast radius is set by what it runs as, not by what it writes. An
 * is_admin() check quietly dropped from a function nobody thinks is important
 * is how a rep gets a write path into that table.
 *
 * Fixtures start with every territory null: seed() deliberately touches only
 * initial-schema columns, because it is also run against migration subsets that
 * predate this one (tests/rls/deactivation.test.ts).
 */

type ProfileRow = {
  id: string;
  territory: string | null;
  role: string;
  is_active: boolean;
};

type AuditRow = {
  actor_id: string | null;
  action: string;
  table_name: string;
  row_id: string;
};

const MISSING_USER = "44444444-4444-4444-4444-444444444444";

async function profile(db: TestDb, id: string): Promise<ProfileRow> {
  await asPlatform(db);
  const [row] = await rows<ProfileRow>(
    db,
    `select id, territory, role, is_active from profiles where id = '${id}'`,
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

/** Sets a territory out of band, so a test can arrange a starting state. */
async function preset(
  db: TestDb,
  id: string,
  value: string | null,
): Promise<void> {
  await asPlatform(db);
  await db.exec(
    `update profiles set territory = ${value === null ? "null" : `'${value}'`}
      where id = '${id}'`,
  );
}

/**
 * Runs set_territory as `caller`, returning the error message or null.
 *
 * `value === null` passes a real SQL null rather than the string "null", which
 * is the difference between clearing a territory and naming one after a keyword.
 */
async function setTerritory(
  db: TestDb,
  caller: string | null,
  target: string,
  value: string | null,
): Promise<string | null> {
  await asUser(db, caller);
  try {
    await db.exec(
      `select set_territory('${target}', ${
        value === null ? "null" : `'${value}'`
      })`,
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

describe("set_territory rejects everyone who is not an active admin", () => {
  it("refuses an agent", async () => {
    const error = await setTerritory(db, AGENT_ID, OTHER_AGENT_ID, "Southeast");

    expect(error).toMatch(/admin only/);
    expect((await profile(db, OTHER_AGENT_ID)).territory).toBeNull();
  });

  it("refuses an agent setting their own territory", async () => {
    // The guard is not about what territory DOES — it does nothing. It is about
    // what the function IS: `security definer` over profiles. A rep who can
    // reach one column of that table through a definer function is one deleted
    // line away from reaching the one that says who is an admin.
    const error = await setTerritory(db, AGENT_ID, AGENT_ID, "Southeast");

    expect(error).toMatch(/admin only/);
    expect((await profile(db, AGENT_ID)).territory).toBeNull();
  });

  it("refuses a caller with no JWT", async () => {
    const error = await setTerritory(db, null, AGENT_ID, "Southeast");

    expect(error).toMatch(/admin only/);
    expect((await profile(db, AGENT_ID)).territory).toBeNull();
  });

  it("refuses a deactivated admin", async () => {
    // is_admin() requires is_active, so switching the admin off is enough. A
    // valid session belonging to a disabled admin must not still administer —
    // the token stays valid for up to an hour after deactivation.
    await asPlatform(db);
    await db.exec(
      `update profiles set is_active = false where id = '${ADMIN_ID}'`,
    );

    const error = await setTerritory(db, ADMIN_ID, AGENT_ID, "Southeast");

    expect(error).toMatch(/admin only/);
    expect((await profile(db, AGENT_ID)).territory).toBeNull();
  });

  it("writes no audit row when it refuses", async () => {
    await setTerritory(db, AGENT_ID, OTHER_AGENT_ID, "Southeast");

    expect(await auditRows(db)).toEqual([]);
  });
});

describe("profiles.territory has no direct client write path", () => {
  it("refuses an admin's direct UPDATE", async () => {
    // The whole reason set_territory exists: even an admin cannot PATCH this
    // column, so the RPC's is_admin() guard, its blank normalisation and its
    // audit row are not optional.
    //
    // Note WHICH layer answers. `authenticated` holds SELECT and nothing else
    // on profiles, so this fails as "permission denied" at the GRANT layer —
    // the policy layer is never consulted. That matters because the two are
    // independent: restoring the UPDATE grant alone would turn this error into
    // a silent zero-row update (RLS filters, it does not raise), and restoring
    // a policy as well would make the RPC bypassable the way set_user_role was
    // before the 11 Aug audit removed the policy that walked past it. The next
    // test asserts the second lock directly, because this one cannot see it.
    await asUser(db, ADMIN_ID);

    await expect(
      db.exec(
        `update profiles set territory = 'Southeast' where id = '${AGENT_ID}'`,
      ),
    ).rejects.toThrow(/permission denied|row-level security/i);

    expect((await profile(db, AGENT_ID)).territory).toBeNull();
  });

  it("refuses an agent's direct UPDATE of their own row", async () => {
    await asUser(db, AGENT_ID);

    await expect(
      db.exec(
        `update profiles set territory = 'Southeast' where id = '${AGENT_ID}'`,
      ),
    ).rejects.toThrow(/permission denied|row-level security/i);

    expect((await profile(db, AGENT_ID)).territory).toBeNull();
  });

  it("has no UPDATE policy on profiles at all", async () => {
    // Asserted on the catalog, because the two failures above genuinely cannot
    // see it: they stop at the grant layer, so they would pass unchanged with
    // an "admin manages profiles" update policy sitting right here. This is the
    // assertion that notices one being added back.
    await asPlatform(db);
    const [{ n }] = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from pg_policies
        where tablename = 'profiles' and cmd <> 'SELECT'`,
    );
    expect(n).toBe(0);
  });

  it("grants authenticated nothing but SELECT on profiles", async () => {
    // The layer that actually produced the two errors above, pinned on its own.
    // A migration that grants UPDATE here — plausibly, to "let the admin UI
    // write a label" — flips those from an error to a silent no-op without
    // failing anything else in this file.
    await asPlatform(db);
    const privileges = await rows<{ privilege_type: string }>(
      db,
      `select privilege_type from information_schema.table_privileges
        where grantee = 'authenticated' and table_name = 'profiles'
        order by privilege_type`,
    );

    expect(privileges.map((p) => p.privilege_type)).toEqual(["SELECT"]);
  });
});

describe("set_territory sets, changes and clears", () => {
  it("sets a territory for an admin, and records who did it", async () => {
    expect(await setTerritory(db, ADMIN_ID, AGENT_ID, "Southeast")).toBeNull();
    expect((await profile(db, AGENT_ID)).territory).toBe("Southeast");

    expect(await auditRows(db)).toEqual([
      {
        actor_id: ADMIN_ID,
        action: "set_territory",
        table_name: "profiles",
        row_id: AGENT_ID,
      },
    ]);
  });

  it("changes an existing territory", async () => {
    await preset(db, AGENT_ID, "Southeast");

    expect(await setTerritory(db, ADMIN_ID, AGENT_ID, "Midwest")).toBeNull();
    expect((await profile(db, AGENT_ID)).territory).toBe("Midwest");
  });

  it("clears a territory when passed null, with its own verb", async () => {
    await preset(db, AGENT_ID, "Southeast");

    expect(await setTerritory(db, ADMIN_ID, AGENT_ID, null)).toBeNull();
    expect((await profile(db, AGENT_ID)).territory).toBeNull();

    expect((await auditRows(db)).map((r) => r.action)).toEqual([
      "clear_territory",
    ]);
  });

  it("stores null, not an empty string, when passed blank", async () => {
    await preset(db, AGENT_ID, "Southeast");

    expect(await setTerritory(db, ADMIN_ID, AGENT_ID, "   ")).toBeNull();

    // No unique index forces this the way it does for agent_number, but
    // "unassigned" having two representations that render identically and
    // compare unequal is its own bug — `where territory is null` is how any
    // report will ask the question, and '' would be invisible to it.
    expect((await profile(db, AGENT_ID)).territory).toBeNull();
    expect((await auditRows(db)).map((r) => r.action)).toEqual([
      "clear_territory",
    ]);
  });

  it("trims surrounding whitespace", async () => {
    expect(
      await setTerritory(db, ADMIN_ID, AGENT_ID, "  Southeast  "),
    ).toBeNull();
    expect((await profile(db, AGENT_ID)).territory).toBe("Southeast");
  });

  it("lets many reps share one territory", async () => {
    // The difference from agent_number in one assertion. That column carries a
    // partial unique index because it resolves a processor's file to one rep;
    // this one is a grouping label and a region with a single rep in it is the
    // unusual case, not the rule.
    expect(await setTerritory(db, ADMIN_ID, AGENT_ID, "Southeast")).toBeNull();
    expect(
      await setTerritory(db, ADMIN_ID, OTHER_AGENT_ID, "Southeast"),
    ).toBeNull();

    expect((await profile(db, AGENT_ID)).territory).toBe("Southeast");
    expect((await profile(db, OTHER_AGENT_ID)).territory).toBe("Southeast");
  });

  it("lets an admin set their own territory", async () => {
    // Deliberately NOT guarded against a self-target, unlike set_user_role. An
    // admin who also carries a book has a territory like anyone else, and
    // setting their own removes no privilege and loses them no screen. The
    // self-guard on set_user_role exists to make zero-active-admins
    // unreachable; there is no equivalent trap here.
    expect(await setTerritory(db, ADMIN_ID, ADMIN_ID, "Corporate")).toBeNull();
    expect((await profile(db, ADMIN_ID)).territory).toBe("Corporate");
  });

  it("writes no audit row when nothing changed", async () => {
    await preset(db, AGENT_ID, "Southeast");

    expect(await setTerritory(db, ADMIN_ID, AGENT_ID, "Southeast")).toBeNull();
    expect(await auditRows(db)).toEqual([]);

    // And clearing an already-empty one is the no-op it looks like, rather than
    // an audit row claiming something changed. `is not distinct from` is what
    // makes the null case behave like the non-null one.
    await preset(db, OTHER_AGENT_ID, null);
    expect(await setTerritory(db, ADMIN_ID, OTHER_AGENT_ID, null)).toBeNull();
    expect(await auditRows(db)).toEqual([]);
  });

  it("refuses a territory longer than 64 characters", async () => {
    const error = await setTerritory(db, ADMIN_ID, AGENT_ID, "T".repeat(65));

    expect(error).toMatch(/64 characters or fewer/);
    expect((await profile(db, AGENT_ID)).territory).toBeNull();
  });

  it("accepts exactly 64 characters", async () => {
    // The boundary in the direction that would otherwise go unnoticed: an
    // off-by-one here rejects a value the message says is fine.
    expect(
      await setTerritory(db, ADMIN_ID, AGENT_ID, "T".repeat(64)),
    ).toBeNull();
    expect((await profile(db, AGENT_ID)).territory).toHaveLength(64);
  });

  it("reports a missing user rather than silently doing nothing", async () => {
    const error = await setTerritory(db, ADMIN_ID, MISSING_USER, "Southeast");

    expect(error).toMatch(/user not found/);
    expect(await auditRows(db)).toEqual([]);
  });

  it("accepts any wording, because there is no vocabulary", async () => {
    // Free text on purpose. Territories are reference data an admin extends as
    // the company opens a region — the same reasoning support_tickets.category
    // stays unconstrained. A CHECK here would mean a migration per office.
    for (const value of ["Southeast", "TX — Gulf Coast", "Region 4", "EMEA"]) {
      expect(await setTerritory(db, ADMIN_ID, AGENT_ID, value)).toBeNull();
      expect((await profile(db, AGENT_ID)).territory).toBe(value);
    }
  });
});

describe("territory is not an access boundary", () => {
  it("appears in no policy expression anywhere in the schema", async () => {
    // The guard against the convenient version of "agents see their territory".
    // Adding territory to a policy without rewriting the own-row half of all
    // seven owner tables would silently widen every rep's book, and nothing
    // else in this suite would notice — the policies would still pass their own
    // tests, because those fixtures all share one territory (none).
    await asPlatform(db);
    const [{ n }] = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from pg_policies
        where coalesce(qual, '') || coalesce(with_check, '') like '%territory%'`,
    );
    expect(n).toBe(0);
  });

  it("does not change what an agent can see", async () => {
    // Two reps in the same territory still see only their own rows. If someone
    // ever wires territory into the policies, this is what should go red.
    await setTerritory(db, ADMIN_ID, AGENT_ID, "Southeast");
    await setTerritory(db, ADMIN_ID, OTHER_AGENT_ID, "Southeast");

    await asUser(db, AGENT_ID);
    const leads = await rows<{ agent_id: string }>(
      db,
      `select agent_id from leads`,
    );

    expect(leads.length).toBeGreaterThan(0);
    expect(leads.every((l) => l.agent_id === AGENT_ID)).toBe(true);
  });

  it("does not let one rep read another's profile row", async () => {
    await setTerritory(db, ADMIN_ID, OTHER_AGENT_ID, "Southeast");

    await asUser(db, AGENT_ID);
    const visible = await rows<{ id: string }>(db, `select id from profiles`);

    expect(visible.map((p) => p.id)).toEqual([AGENT_ID]);
  });
});

// ---------------------------------------------------------------------------
// 20261104150000: every ASCII whitespace character is trimmed, as
// set_rep_identity() trims (phase 13 of docs/design/intake-and-reports.md,
// carried over from phase 2). The characters are built with chr() in SQL, not
// written as escapes here.
// ---------------------------------------------------------------------------

const TRIM_MIGRATION = "20261104150000_set_territory_ascii_trim.sql";
const OLD_NORMALISE = "normalised := nullif(btrim(coalesce(new_territory, '')), '');";
const NEW_NORMALISE = "normalised := nullif(btrim(coalesce(new_territory, ''), E' \\t\\n\\r\\f\\x0b'), '');";
// Tab, newline, carriage return, form feed, vertical tab -- and space.
const ASCII_WHITESPACE = [9, 10, 13, 12, 11, 32];

/** set_territory as the admin, with `sql` as the value expression. */
async function setTerritorySql(target: TestDb, sql: string): Promise<void> {
  await asUser(target, ADMIN_ID);
  try {
    await target.exec(`select set_territory('${AGENT_ID}', ${sql})`);
  } finally {
    await asPlatform(target);
  }
}

describe("set_territory trims every ASCII whitespace character (20261104150000)", () => {
  it.each(ASCII_WHITESPACE)("strips chr(%i) from both ends", async (code) => {
    await setTerritorySql(db, `chr(${code}) || chr(${code}) || 'Southeast' || chr(${code})`);
    expect((await profile(db, AGENT_ID)).territory).toBe("Southeast");
  });

  it("strips a mix of them, and keeps whitespace inside the name", async () => {
    await setTerritorySql(db, `chr(9) || ' ' || chr(11) || 'South' || chr(9) || 'east' || chr(13) || chr(10) || chr(12)`);
    expect((await profile(db, AGENT_ID)).territory).toBe("South\teast");
  });

  it("clears a territory given only whitespace, with the clear verb", async () => {
    await preset(db, AGENT_ID, "Southeast");
    await setTerritorySql(db, `chr(9) || chr(10) || ' ' || chr(13)`);
    expect((await profile(db, AGENT_ID)).territory).toBeNull();
    expect((await auditRows(db)).map((r) => r.action)).toEqual(["clear_territory"]);
  });

  it("treats a padded copy of the stored value as no change: no write, no audit row", async () => {
    await preset(db, AGENT_ID, "Southeast");
    await setTerritorySql(db, `chr(9) || 'Southeast' || chr(10)`);
    expect(await auditRows(db)).toEqual([]);
  });

  it("measures the 64-character cap after trimming", async () => {
    await setTerritorySql(db, `chr(9) || repeat('a', 64) || chr(9)`);
    expect((await profile(db, AGENT_ID)).territory).toBe("a".repeat(64));
  });

  it("is the 20261002143000 function with only the normalising line changed", async () => {
    const extract = (sql: string) => {
      const text = sql.replace(/\r\n/g, "\n");
      const start = text.lastIndexOf("create or replace function set_territory(");
      return text.slice(start, text.indexOf("$$;", start));
    };
    const before = extract(await readMigration("20261002143000_profiles_territory.sql"));
    const after = extract(await readMigration(TRIM_MIGRATION));
    expect(before).toContain(OLD_NORMALISE);
    expect(after).toBe(before.replace(OLD_NORMALISE, NEW_NORMALISE));
  });

  it("keeps its privileges: authenticated and service_role, never anon or PUBLIC", async () => {
    await asPlatform(db);
    const [fn] = await rows<{ anon: boolean; authed: boolean; svc: boolean; acl: string; definer: boolean }>(
      db,
      `select has_function_privilege('anon', 'set_territory(uuid, text)', 'execute') as anon,
              has_function_privilege('authenticated', 'set_territory(uuid, text)', 'execute') as authed,
              has_function_privilege('service_role', 'set_territory(uuid, text)', 'execute') as svc,
              proacl::text as acl, prosecdef as definer
         from pg_proc where oid = 'set_territory(uuid, text)'::regprocedure`,
    );
    expect(fn).toMatchObject({ anon: false, authed: true, svc: true, definer: true });
    expect(fn.acl).not.toMatch(/(^|[{,])=X/);
  });
});

describe("the territory migration", () => {
  const opened: TestDb[] = [];
  afterAll(async () => {
    await Promise.all(opened.map((d) => d.close()));
  });
  async function before(): Promise<TestDb> {
    const target = await createTestDb(await migrationsBefore(TRIM_MIGRATION));
    opened.push(target);
    await resetData(target);
    return target;
  }

  it("passes over existing territories, a tab-padded one included, and rewrites none", async () => {
    const target = await before();
    await target.exec(`
      update profiles set territory = 'Southeast' where id = '${AGENT_ID}';
      update profiles set territory = chr(9) || 'Northwest' where id = '${OTHER_AGENT_ID}';`);
    const snapshot = () =>
      rows(target, `select id, territory from profiles order by id`);
    const was = await snapshot();
    await target.exec(await readMigration(TRIM_MIGRATION));
    await asPlatform(target);
    expect(await snapshot()).toEqual(was);
    // Setting the padded one again now trims it.
    await asUser(target, ADMIN_ID);
    await target.exec(`select set_territory('${OTHER_AGENT_ID}', chr(9) || 'Northwest')`);
    await asPlatform(target);
    expect(await rows(target, `select territory from profiles where id = '${OTHER_AGENT_ID}'`)).toEqual([
      { territory: "Northwest" },
    ]);
  });

  it("refuses, naming it, over a set_territory that is not the one it copied", async () => {
    const target = await before();
    const [{ def }] = await rows<{ def: string }>(
      target,
      `select pg_get_functiondef('set_territory(uuid, text)'::regprocedure) as def`,
    );
    expect(def).toContain(OLD_NORMALISE);
    await target.exec(def.replace(OLD_NORMALISE, "normalised := new_territory;"));
    const error = await (async () => {
      try {
        await target.exec(await readMigration(TRIM_MIGRATION));
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error?.message).toBe(
      "set_territory does not carry the 20261002143000 normalising line exactly once here. Inspect pg_get_functiondef before applying 20261104150000.",
    );
  });

  it("mutation proof: the old line put back stores the tab again", async () => {
    const mutant = await createTestDb();
    opened.push(mutant);
    await resetData(mutant);
    const [{ def }] = await rows<{ def: string }>(
      mutant,
      `select pg_get_functiondef('set_territory(uuid, text)'::regprocedure) as def`,
    );
    expect(def, "the new line must be in the function").toContain(NEW_NORMALISE);
    await mutant.exec(def.replace(NEW_NORMALISE, OLD_NORMALISE));
    await setTerritorySql(mutant, `chr(9) || 'Southeast'`);
    expect(await rows(mutant, `select territory from profiles where id = '${AGENT_ID}'`)).toEqual([
      { territory: "\tSoutheast" },
    ]);
  });
});
