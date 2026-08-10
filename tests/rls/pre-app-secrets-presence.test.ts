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
 * `pre_app_secrets_presence` — the two booleans the wizard's review step needs
 * from tables no client role may touch.
 *
 * The interesting property is not the counting, it is what the function is NOT
 * allowed to do. It holds definer privilege over three tables that have zero
 * policies and zero grants precisely so nothing can read them, so this suite
 * pins the constraints that make that privilege safe: no `*_encrypted` column
 * named anywhere in the body, the ownership guard identical to
 * `submit_pre_app`'s, `search_path` fixed, and no grant to `anon`.
 */

type PresenceRow = { banking_on_file: boolean; owners_missing_ssn: number };

let db: TestDb;
let draftId: number;
let otherDraftId: number;

async function presence(id: number): Promise<PresenceRow> {
  const r = await rows<PresenceRow>(
    db,
    `select banking_on_file, owners_missing_ssn from pre_app_secrets_presence(${id})`,
  );
  return r[0];
}

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(async () => {
  await resetData(db);
  await asPlatform(db);
  const preApps = await rows<{ id: number; dba_name: string }>(
    db,
    `select id, dba_name from pre_apps order by id`,
  );
  const byName = new Map(preApps.map((p) => [p.dba_name, p.id]));
  draftId = byName.get("Agent Draft App")!;
  otherDraftId = byName.get("Other Draft App")!;
});

afterAll(async () => {
  await db?.close();
});

describe("what it reports", () => {
  it("reports the fixture's half-finished state to the owning agent", async () => {
    // The seed gives 'Agent Draft App' banking ciphertext, two owners, and an
    // SSN for only one of them — so this is the shape the review step has to
    // turn into "one owner has no SSN on file".
    await asUser(db, AGENT_ID);

    expect(await presence(draftId)).toEqual({
      banking_on_file: true,
      owners_missing_ssn: 1,
    });
  });

  it("reports no banking and no owners for a bare pre-app", async () => {
    await asUser(db, ADMIN_ID);

    expect(await presence(otherDraftId)).toEqual({
      banking_on_file: false,
      // The other agent's draft has one owner in the fixture and no SSN row.
      owners_missing_ssn: 1,
    });
  });

  it("drops to zero missing once every owner has an SSN", async () => {
    await asPlatform(db);
    await db.exec(`
      insert into pre_app_owner_secrets (pre_app_owner_id, ssn_encrypted)
      values ((select id from pre_app_owners where owner_name = 'Ben Minor'),
              decode('0044', 'hex'));
    `);

    await asUser(db, AGENT_ID);
    expect(await presence(draftId)).toEqual({
      banking_on_file: true,
      owners_missing_ssn: 0,
    });
  });

  it("counts an owner with no SSN even when others have one", async () => {
    await asPlatform(db);
    await db.exec(`
      insert into pre_app_owners (pre_app_id, owner_name, percent_owned)
      values (${draftId}, 'Cara Third', 0.00);
    `);

    await asUser(db, AGENT_ID);
    expect((await presence(draftId)).owners_missing_ssn).toBe(2);
  });

  it("lets an admin read any pre-app's presence", async () => {
    await asUser(db, ADMIN_ID);
    expect((await presence(draftId)).banking_on_file).toBe(true);
  });
});

describe("it is not an id oracle", () => {
  it("gives another agent's pre-app and a nonexistent id the same message", async () => {
    await asUser(db, AGENT_ID);

    const notYours = await presence(otherDraftId).catch((e: Error) => e.message);
    const missing = await presence(999_999).catch((e: Error) => e.message);

    expect(notYours).toBe("pre-app not found");
    expect(missing).toBe("pre-app not found");
    expect(notYours).toBe(missing);
  });

  it("tells a deactivated OWNER that their account is off", async () => {
    // Same split as submit_pre_app: the owner learns why, a stranger does not.
    await asPlatform(db);
    await db.exec(
      `update profiles set is_active = false where id = '${AGENT_ID}'`,
    );

    await asUser(db, AGENT_ID);
    await expect(presence(draftId)).rejects.toThrow(/account is deactivated/i);
  });

  it("refuses an unauthenticated caller", async () => {
    await asUser(db, null);
    await expect(presence(draftId)).rejects.toThrow();
  });

  it("does not leak presence to a different agent", async () => {
    await asUser(db, OTHER_AGENT_ID);
    await expect(presence(draftId)).rejects.toThrow(/pre-app not found/i);
  });
});

describe("the privilege it holds cannot leak ciphertext", () => {
  it("names no *_encrypted column anywhere in its body", async () => {
    await asPlatform(db);
    const r = await rows<{ def: string }>(
      db,
      `select pg_get_functiondef('public.pre_app_secrets_presence(int)'::regprocedure) as def`,
    );
    // Comments are stripped first, exactly as the submit_pre_app version of
    // this assertion does: the body carries a comment saying it never names a
    // ciphertext column, and that sentence would otherwise fail the assertion
    // it describes. (It did, the first time this test ran.)
    const code = r[0].def
      .split("\n")
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n");

    // It must reach the secrets tables — otherwise it could not answer — but
    // only ever through exists()/count(). Naming a value column is the line.
    expect(code).toContain("pre_app_banking_secrets");
    expect(code).toContain("pre_app_owner_secrets");
    expect(code).not.toMatch(/_encrypted/);
  });

  it("pins search_path, so a temp-table shadow cannot redirect a read", async () => {
    await asPlatform(db);
    const r = await rows<{ config: string | null }>(
      db,
      `select array_to_string(proconfig, ',') as config
         from pg_proc where proname = 'pre_app_secrets_presence'`,
    );
    expect(r[0].config).toBe("search_path=public");
  });

  it("is security definer, which is what makes it work at all", async () => {
    await asPlatform(db);
    const r = await rows<{ prosecdef: boolean }>(
      db,
      `select prosecdef from pg_proc where proname = 'pre_app_secrets_presence'`,
    );
    expect(r[0].prosecdef).toBe(true);
  });

  it("leaves the secrets tables themselves ungranted, as ever", async () => {
    // The whole point: this function is the only door, and adding it must not
    // have quietly opened another.
    await asPlatform(db);
    for (const table of [
      "pre_app_owner_secrets",
      "pre_app_banking_secrets",
      "pre_app_terminal_secrets",
    ]) {
      const r = await rows<{ anon: boolean; auth: boolean }>(
        db,
        `select has_table_privilege('anon','${table}','select') as anon,
                has_table_privilege('authenticated','${table}','select') as auth`,
      );
      expect(r[0], table).toEqual({ anon: false, auth: false });
    }
  });
});

describe("grants", () => {
  it("is executable by authenticated and service_role, never anon", async () => {
    await asPlatform(db);
    const sig = "public.pre_app_secrets_presence(int)";
    const r = await rows<{ anon: boolean; auth: boolean; svc: boolean }>(
      db,
      `select has_function_privilege('anon','${sig}','execute') as anon,
              has_function_privilege('authenticated','${sig}','execute') as auth,
              has_function_privilege('service_role','${sig}','execute') as svc`,
    );
    expect(r[0]).toEqual({ anon: false, auth: true, svc: true });
  });
});

describe("the presence tests are load-bearing", () => {
  it("would notice if the ownership guard were dropped", async () => {
    await asPlatform(db);
    // Same body, minus the guard — the mistake this suite exists to catch.
    await db.exec(`
      create or replace function pre_app_secrets_presence(pre_app_id_input int)
      returns table (banking_on_file boolean, owners_missing_ssn int)
      language plpgsql
      security definer
      set search_path = public
      as $fn$
      begin
        return query
          select exists (select 1 from pre_app_banking_secrets b
                          where b.pre_app_id = pre_app_id_input),
                 0;
      end;
      $fn$;
    `);

    await asUser(db, OTHER_AGENT_ID);
    // With the guard gone, another agent reads presence for a pre-app they
    // cannot see — which the oracle tests above assert is impossible.
    expect((await presence(draftId)).banking_on_file).toBe(true);
  });
});
