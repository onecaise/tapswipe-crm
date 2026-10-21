import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_ID,
  AGENT_ID,
  asPlatform,
  asUser,
  createTestDb,
  migrationsBefore,
  resetData,
  rows,
  type TestDb,
} from "../helpers/db";

/**
 * Security fix, phase 2 (docs/claude/security-fixes.md): a pre-app's child
 * rows are frozen for a rep once it leaves draft.
 *
 * pre_apps itself has been frozen since 20260806141000
 * (pre_apps_guard_transitions: "agents edit drafts, admins edit anything").
 * Its three children -- pre_app_owners, pre_app_terminal,
 * pre_app_business_profile -- were not: their policies ask only whether the
 * PARENT is the rep's, never what state it is in. So after submitting, a rep
 * could rewrite the owners an admin was about to approve, insert a new one,
 * or delete one -- and deleting an owner cascades its SSN row away.
 */

const FIX_MIGRATION = "20261021130000_pre_app_children_draft_only.sql";

type DbError = { code?: string; message: string };

async function attempt(target: TestDb, sql: string): Promise<{ n: number; error: DbError | null }> {
  try {
    const result = await target.query(sql);
    return { n: result.affectedRows ?? 0, error: null };
  } catch (error) {
    return { n: 0, error: error as DbError };
  }
}

async function preAppId(target: TestDb, dba: string): Promise<number> {
  await asPlatform(target);
  const [{ id }] = await rows<{ id: number }>(
    target,
    `select id from pre_apps where dba_name = '${dba}'`,
  );
  return id;
}

/**
 * The agent's seeded draft, made submittable (its minority owner gets an SSN
 * stand-in) and submitted through the real RPC, as the rep.
 */
async function submittedByRep(target: TestDb): Promise<number> {
  const id = await preAppId(target, "Agent Draft App");
  await asPlatform(target);
  await target.exec(`
    insert into pre_app_owner_secrets (pre_app_owner_id, ssn_encrypted)
    values ((select id from pre_app_owners where owner_name = 'Ben Minor'), decode('0044', 'hex'));
  `);
  await asUser(target, AGENT_ID);
  await target.query(`select submit_pre_app(${id})`);
  await asPlatform(target);
  return id;
}

/** Every child write a rep could make, against one pre-app. */
function repWrites(id: number): Record<string, string> {
  return {
    "update an owner": `update pre_app_owners set owner_name = 'Mallory' where pre_app_id = ${id} and owner_name = 'Ada Owner'`,
    "insert an owner": `insert into pre_app_owners (pre_app_id, owner_name, percent_owned) values (${id}, 'Planted Owner', 10)`,
    "delete an owner": `delete from pre_app_owners where pre_app_id = ${id} and owner_name = 'Ben Minor'`,
    "update the terminal": `update pre_app_terminal set terminal_type = 'Swapped' where pre_app_id = ${id}`,
    "delete the terminal": `delete from pre_app_terminal where pre_app_id = ${id}`,
    "update the business profile": `update pre_app_business_profile set notes = 'rewritten' where pre_app_id = ${id}`,
    "delete the business profile": `delete from pre_app_business_profile where pre_app_id = ${id}`,
  };
}

async function runAll(target: TestDb, userId: string, id: number) {
  const out: Record<string, { n: number; error: DbError | null }> = {};
  for (const [label, sql] of Object.entries(repWrites(id))) {
    await asUser(target, userId);
    out[label] = await attempt(target, sql);
  }
  await asPlatform(target);
  return out;
}

async function ssnCount(target: TestDb, id: number): Promise<number> {
  await asPlatform(target);
  const [{ n }] = await rows<{ n: number }>(
    target,
    `select count(*)::int as n from pre_app_owner_secrets s
       join pre_app_owners o on o.id = s.pre_app_owner_id where o.pre_app_id = ${id}`,
  );
  return n;
}

async function childSnapshot(target: TestDb, id: number): Promise<string> {
  await asPlatform(target);
  const [{ s }] = await rows<{ s: string }>(
    target,
    `select jsonb_build_object(
       'owners',  (select coalesce(jsonb_agg(to_jsonb(o) order by o.id), '[]') from pre_app_owners o where o.pre_app_id = ${id}),
       'terminal',(select coalesce(jsonb_agg(to_jsonb(t)), '[]') from pre_app_terminal t where t.pre_app_id = ${id}),
       'profile', (select coalesce(jsonb_agg(to_jsonb(b)), '[]') from pre_app_business_profile b where b.pre_app_id = ${id}),
       'ssns',    (select count(*) from pre_app_owner_secrets s join pre_app_owners o on o.id = s.pre_app_owner_id where o.pre_app_id = ${id})
     )::text as s`,
  );
  return s;
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

describe("the claim, on the schema as it was before the fix", () => {
  it("lets the rep rewrite, add and delete children of a SUBMITTED pre-app, SSN row included", async () => {
    const before = await createTestDb(await migrationsBefore(FIX_MIGRATION));
    try {
      await resetData(before);
      const id = await submittedByRep(before);
      expect(await ssnCount(before, id)).toBe(2);

      const result = await runAll(before, AGENT_ID, id);
      for (const [label, r] of Object.entries(result)) {
        expect(r.error, label).toBeNull();
        expect(r.n, label).toBe(1);
      }
      // Deleting Ben took his SSN with it, on an application awaiting approval.
      expect(await ssnCount(before, id)).toBe(1);
    } finally {
      await before.close();
    }
  });
});

describe("children are frozen for a rep once the pre-app leaves draft", () => {
  it("refuses every child write on a submitted pre-app, and changes nothing", async () => {
    const id = await submittedByRep(db);
    const snapshot = await childSnapshot(db, id);

    const result = await runAll(db, AGENT_ID, id);
    for (const [label, r] of Object.entries(result)) {
      expect(r.error?.code, label).toBe("PT409");
      expect(r.error?.message, label).toMatch(/submitted pre-app can only be changed by an admin/);
    }
    expect(await childSnapshot(db, id)).toBe(snapshot);
    expect(await ssnCount(db, id)).toBe(2);
  });

  it("refuses them on an approved pre-app too", async () => {
    const id = await submittedByRep(db);
    await asUser(db, ADMIN_ID);
    await db.query(`select approve_pre_app(${id})`);
    const snapshot = await childSnapshot(db, id);

    const result = await runAll(db, AGENT_ID, id);
    for (const [label, r] of Object.entries(result)) {
      expect(r.error?.message, label).toMatch(/approved pre-app can only be changed by an admin/);
    }
    expect(await childSnapshot(db, id)).toBe(snapshot);
  });

  it("refuses them on a declined pre-app, until the rep reopens it", async () => {
    const id = await submittedByRep(db);
    await asUser(db, ADMIN_ID);
    await db.query(`select decline_pre_app(${id}, 'Need a voided check')`);

    const declined = await runAll(db, AGENT_ID, id);
    for (const [label, r] of Object.entries(declined)) {
      expect(r.error?.message, label).toMatch(/declined pre-app can only be changed by an admin/);
    }

    // reopen_pre_app() returns it to draft; the rep can fix it again.
    await asUser(db, AGENT_ID);
    await db.query(`select reopen_pre_app(${id})`);
    const reopened = await runAll(db, AGENT_ID, id);
    for (const [label, r] of Object.entries(reopened)) {
      expect(r.error, label).toBeNull();
      expect(r.n, label).toBe(1);
    }
  });

  it("refuses re-parenting a draft's owner onto a submitted pre-app, and back", async () => {
    // Two of the rep's own pre-apps: the submitted one, and a fresh draft.
    const submitted = await submittedByRep(db);
    await asUser(db, AGENT_ID);
    const [{ id: draft }] = await rows<{ id: number }>(
      db,
      `insert into pre_apps (agent_id, dba_name, legal_business_name)
       values ('${AGENT_ID}', 'Second Draft', 'Second Draft LLC') returning id`,
    );
    await db.query(
      `insert into pre_app_owners (pre_app_id, owner_name, percent_owned) values (${draft}, 'Draft Owner', 100)`,
    );

    const into = await attempt(
      db,
      `update pre_app_owners set pre_app_id = ${submitted} where owner_name = 'Draft Owner'`,
    );
    expect(into.error?.code).toBe("PT409");

    const outOf = await attempt(
      db,
      `update pre_app_owners set pre_app_id = ${draft} where owner_name = 'Ada Owner'`,
    );
    expect(outOf.error?.code).toBe("PT409");
  });

  it("an admin may still change children at any status", async () => {
    const id = await submittedByRep(db);
    const result = await runAll(db, ADMIN_ID, id);
    for (const [label, r] of Object.entries(result)) {
      expect(r.error, label).toBeNull();
    }
  });

  it("the rep still edits every child of their own draft", async () => {
    const id = await preAppId(db, "Agent Draft App");
    const result = await runAll(db, AGENT_ID, id);
    for (const [label, r] of Object.entries(result)) {
      expect(r.error, label).toBeNull();
      expect(r.n, label).toBe(1);
    }
  });

  it("deleting a non-draft pre-app still cascades its children (admin, and service role)", async () => {
    const id = await submittedByRep(db);
    await asUser(db, ADMIN_ID);
    await db.query(`delete from pre_apps where id = ${id}`);
    expect(await childSnapshot(db, id)).toBe('{"ssns": 0, "owners": [], "profile": [], "terminal": []}');

    // The platform owner has no auth.uid() and is not an admin; a cascade
    // from a parent it deletes must still go through. (The fixture write
    // uses the state machine's transition flag, as seed() does for pre_apps.)
    const other = await preAppId(db, "Agent Submitted App");
    await asPlatform(db);
    await db.exec(`
      select set_config('tapswipe.pre_app_transition', 'on', false);
      insert into pre_app_owners (pre_app_id, owner_name) values (${other}, 'Fixture Owner');
      select set_config('tapswipe.pre_app_transition', '', false);
    `);
    expect(await rows(db, `select 1 from pre_app_owners where pre_app_id = ${other}`)).toHaveLength(1);
    await db.query(`delete from pre_apps where id = ${other}`);
    await asPlatform(db);
    expect(await rows(db, `select 1 from pre_app_owners where pre_app_id = ${other}`)).toEqual([]);
  });
});

const TRIGGERS = [
  ["pre_app_owners", "pre_app_owners_draft_only", "update an owner"],
  ["pre_app_terminal", "pre_app_terminal_draft_only", "update the terminal"],
  ["pre_app_business_profile", "pre_app_business_profile_draft_only", "update the business profile"],
] as const;

describe("the guard itself", () => {
  it("is attached BEFORE INSERT, UPDATE and DELETE on all three tables", async () => {
    await asPlatform(db);
    const found = await rows<{ tgname: string; tbl: string; tgtype: number }>(
      db,
      `select t.tgname, c.relname as tbl, t.tgtype
         from pg_trigger t join pg_class c on c.oid = t.tgrelid
         join pg_proc p on p.oid = t.tgfoid
        where p.proname = 'pre_app_children_guard' and not t.tgisinternal
        order by c.relname`,
    );
    expect(found.map((t) => [t.tbl, t.tgname])).toEqual(
      [...TRIGGERS].map(([table, trigger]) => [table, trigger]).sort(),
    );
    // tgtype bits: ROW 1, BEFORE 2, INSERT 4, DELETE 8, UPDATE 16.
    for (const t of found) expect(t.tgtype & (1 | 2 | 4 | 8 | 16)).toBe(31);
  });

  it("is security definer with a pinned search_path and no EXECUTE for anyone", async () => {
    await asPlatform(db);
    const [fn] = await rows<{ prosecdef: boolean; proconfig: string[]; anon: boolean; auth: boolean }>(
      db,
      `select p.prosecdef, p.proconfig,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth
         from pg_proc p where p.proname = 'pre_app_children_guard'`,
    );
    expect(fn).toEqual({
      prosecdef: true,
      proconfig: ["search_path=public, pg_temp"],
      anon: false,
      auth: false,
    });
  });

  it.each(TRIGGERS)(
    "goes red with the trigger on %s dropped",
    async (table, trigger, label) => {
      const broken = await createTestDb();
      try {
        await resetData(broken);
        const id = await submittedByRep(broken);
        await asPlatform(broken);
        await broken.exec(`drop trigger ${trigger} on ${table}`);
        await asUser(broken, AGENT_ID);
        const r = await attempt(broken, repWrites(id)[label]);
        expect(r.error).toBeNull();
        expect(r.n).toBe(1);
      } finally {
        await broken.close();
      }
    },
  );
});
