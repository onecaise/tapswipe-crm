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
  seed,
  type TestDb,
} from "../helpers/db";
import { makeSubmittable as makeSubmittableShared } from "../helpers/pre-app-submittable";

/**
 * pre_app_tax_secrets -- the business tax ID (an EIN, or an SSN used as one) as
 * the FOURTH encrypted secrets table, and pre_apps.ein_number dropped
 * (20261026140000, phase 3 of docs/design/intake-and-reports.md, §5).
 *
 * The claims:
 *
 *   1. **Built exactly like the other three**: RLS on with zero policies, no
 *      grant of any kind to anon or authenticated (not even the privileges RLS
 *      cannot filter), everything to service_role, one row per pre-app, cascade
 *      from pre_apps, key_version 1.
 *   2. **No client reaches it**: not the owning rep, not an admin. Reading the
 *      number back (last four for a rep) is the Edge Function's job, asserted
 *      in tests/live/pre-app-secrets.test.ts.
 *   3. **The kind is EIN or SSN, and ein_type is too**; the plaintext
 *      ein_number column is gone.
 *   4. **submit_pre_app() requires a tax-ID row whose kind equals ein_type**,
 *      with one message per case (no type, none on file, wrong kind), and
 *      pre_app_secrets_presence() reports the same facts, never the number.
 *   5. **The migration refuses while any ein_number value exists**, naming the
 *      pre-app and not the number, and refuses an ein_type it cannot keep. It
 *      does NOT refuse merely because the tables hold rows.
 */

const MIGRATION = "20261026140000_pre_app_tax_secrets.sql";

type DbError = { code?: string; message: string };

let db: TestDb;
let draftId: number;

async function failure(target: TestDb, sql: string): Promise<DbError | null> {
  try {
    await target.exec(sql);
    return null;
  } catch (error) {
    return error as DbError;
  }
}

async function idOf(dba: string): Promise<number> {
  await asPlatform(db);
  const [row] = await rows<{ id: number }>(
    db,
    `select id from pre_apps where dba_name = '${dba}'`,
  );
  return row.id;
}

/**
 * The seeded agent draft, made submittable apart from whatever a test removes:
 * since phase 4, every item of pre_app_missing_fields() (the shared helper).
 * Leaves the session as the platform owner, as the old helper did.
 */
async function makeSubmittable(id: number): Promise<void> {
  await makeSubmittableShared(db, id, { keepOwners: true });
  await asPlatform(db);
}

async function statusOf(id: number): Promise<string> {
  await asPlatform(db);
  const [row] = await rows<{ status: string }>(
    db,
    `select status from pre_apps where id = ${id}`,
  );
  return row.status;
}

async function presence(id: number) {
  const [row] = await rows<{
    banking_on_file: boolean;
    owners_missing_ssn: number;
    tax_id_on_file: boolean;
    tax_id_type_on_file: string | null;
  }>(db, `select * from pre_app_secrets_presence(${id})`);
  return row;
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await resetData(db);
  draftId = await idOf("Agent Draft App");
});

describe("built exactly like the other three secrets tables", () => {
  it("enables RLS itself rather than relying on the ensure_rls backstop", async () => {
    expect(await readMigration(MIGRATION)).toMatch(
      /^alter table pre_app_tax_secrets enable row level security;$/m,
    );
    await asPlatform(db);
    const [table] = await rows<{ relrowsecurity: boolean }>(
      db,
      `select relrowsecurity from pg_class where oid = 'pre_app_tax_secrets'::regclass`,
    );
    expect(table.relrowsecurity).toBe(true);
  });

  it("has zero policies", async () => {
    await asPlatform(db);
    const [{ n }] = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from pg_policy where polrelid = 'pre_app_tax_secrets'::regclass`,
    );
    expect(n).toBe(0);
  });

  it("grants anon and authenticated nothing, on the table or its sequence", async () => {
    await asPlatform(db);
    for (const role of ["anon", "authenticated"]) {
      const [table] = await rows<{ privs: string[] }>(
        db,
        `select array(
           select p from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
            where has_table_privilege('${role}', 'pre_app_tax_secrets', p)
         ) as privs`,
      );
      expect(table.privs, role).toEqual([]);
      const [seq] = await rows<{ privs: string[] }>(
        db,
        `select array(
           select p from unnest(array['USAGE','SELECT','UPDATE']) p
            where has_sequence_privilege('${role}', 'pre_app_tax_secrets_id_seq', p)
         ) as privs`,
      );
      expect(seq.privs, `${role} on the sequence`).toEqual([]);
    }
  });

  it("gives service_role what it holds on the other three", async () => {
    await asPlatform(db);
    const all = `array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']`;
    const surface = await rows<{ t: string; privs: string[] }>(
      db,
      `select t, array(select p from unnest(${all}) p
                        where has_table_privilege('service_role', t, p)) as privs
         from unnest(array['pre_app_banking_secrets', 'pre_app_tax_secrets']) t`,
    );
    expect(surface[1].privs).toEqual(surface[0].privs);
    expect(surface[1].privs).toEqual(expect.arrayContaining(["SELECT", "INSERT", "UPDATE"]));
  });

  it("holds one row per pre-app, with key_version 1", async () => {
    await asPlatform(db);
    const [row] = await rows<{ key_version: number; tax_id_type: string }>(
      db,
      `select key_version, tax_id_type from pre_app_tax_secrets where pre_app_id = ${draftId}`,
    );
    expect(row).toEqual({ key_version: 1, tax_id_type: "EIN" });

    const error = await failure(
      db,
      `insert into pre_app_tax_secrets (pre_app_id, tax_id_type, tax_id_encrypted)
       values (${draftId}, 'SSN', decode('0066', 'hex'))`,
    );
    expect(error?.message).toMatch(/pre_app_tax_secrets_pre_app_id_key/);
  });

  it("holds only EIN or SSN as the kind", async () => {
    await asPlatform(db);
    const otherId = await idOf("Other Draft App");
    for (const kind of ["ein", "ITIN", ""]) {
      const error = await failure(
        db,
        `insert into pre_app_tax_secrets (pre_app_id, tax_id_type, tax_id_encrypted)
         values (${otherId}, '${kind}', decode('0066', 'hex'))`,
      );
      expect(error?.message, kind).toMatch(/pre_app_tax_secrets_tax_id_type_check/);
    }
  });

  it("goes with its pre-app when an admin deletes it", async () => {
    await asUser(db, ADMIN_ID);
    await db.exec(`delete from pre_apps where id = ${draftId}`);
    await asPlatform(db);
    const [{ n }] = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from pre_app_tax_secrets`,
    );
    expect(n).toBe(0);
  });
});

describe("no client reaches it", () => {
  for (const [who, id] of [
    ["the owning rep", AGENT_ID],
    ["an admin", ADMIN_ID],
    ["anon", null],
  ] as const) {
    it(`${who}: refused on read and write, before RLS is consulted`, async () => {
      if (id === null) {
        await asUser(db, null);
        await db.exec(`set role anon`);
      } else {
        await asUser(db, id);
      }
      for (const sql of [
        `select tax_id_type from pre_app_tax_secrets`,
        `insert into pre_app_tax_secrets (pre_app_id, tax_id_type, tax_id_encrypted)
           values (${draftId}, 'SSN', decode('0066', 'hex'))`,
        `update pre_app_tax_secrets set tax_id_type = 'SSN'`,
        `delete from pre_app_tax_secrets`,
      ]) {
        const error = await failure(db, sql);
        expect(error?.message, sql).toMatch(/permission denied/i);
      }
      await asPlatform(db);
      const [row] = await rows<{ tax_id_type: string }>(
        db,
        `select tax_id_type from pre_app_tax_secrets where pre_app_id = ${draftId}`,
      );
      expect(row.tax_id_type).toBe("EIN");
    });
  }
});

describe("ein_type and the dropped column", () => {
  it("drops pre_apps.ein_number", async () => {
    await asPlatform(db);
    const found = await rows(
      db,
      `select 1 from information_schema.columns
        where table_name = 'pre_apps' and column_name = 'ein_number'`,
    );
    expect(found).toEqual([]);
  });

  it("lets a rep set EIN, SSN or nothing on their draft, and refuses anything else", async () => {
    await asUser(db, AGENT_ID);
    for (const value of ["'SSN'", "null", "'EIN'"]) {
      expect(
        await failure(db, `update pre_apps set ein_type = ${value} where id = ${draftId}`),
        value,
      ).toBeNull();
    }
    for (const value of ["'ein'", "'ITIN'", "''"]) {
      const error = await failure(
        db,
        `update pre_apps set ein_type = ${value} where id = ${draftId}`,
      );
      expect(error?.message, value).toMatch(/pre_apps_ein_type_check/);
    }
  });
});

// Since phase 4 (20261028120000) the rule is the 'tax_id' code of
// pre_app_missing_fields(), and submit_pre_app() refuses with the whole list:
// the label is inside the message, the code in DETAIL. The three cases and
// their wording are unchanged apart from the leading capital.
function refusesWith(error: { code?: string; message: string; detail?: string } | null, label: string) {
  expect(error?.code).toBe("PT422");
  expect(error?.message).toContain(label);
  expect(JSON.parse(error?.detail ?? "[]")).toEqual(["tax_id"]);
}

describe("submit_pre_app requires the tax ID of the chosen kind", () => {
  it("submits when the stored kind matches ein_type", async () => {
    await makeSubmittable(draftId);
    await asUser(db, AGENT_ID);
    await db.exec(`select submit_pre_app(${draftId})`);
    expect(await statusOf(draftId)).toBe("submitted");
  });

  it("refuses with no tax ID on file, naming the kind", async () => {
    await makeSubmittable(draftId);
    await db.exec(`delete from pre_app_tax_secrets where pre_app_id = ${draftId}`);
    await asUser(db, AGENT_ID);
    const error = await failure(db, `select submit_pre_app(${draftId})`);
    refusesWith(error, "The EIN (tax ID) has not been entered.");
    expect(await statusOf(draftId)).toBe("draft");
  });

  it("refuses with no EIN type", async () => {
    await makeSubmittable(draftId);
    await asUser(db, AGENT_ID);
    await db.exec(`update pre_apps set ein_type = null where id = ${draftId}`);
    const error = await failure(db, `select submit_pre_app(${draftId})`);
    refusesWith(error, "Choose an EIN type (EIN or SSN), then enter the tax ID.");
    expect(await statusOf(draftId)).toBe("draft");
  });

  it("refuses when the EIN type was switched after the number was entered", async () => {
    // The rep saved an EIN, then changed EIN type to SSN. The stored row is
    // still an EIN, so it no longer counts: the SSN must be entered.
    await makeSubmittable(draftId);
    await asUser(db, AGENT_ID);
    await db.exec(`update pre_apps set ein_type = 'SSN' where id = ${draftId}`);
    const error = await failure(db, `select submit_pre_app(${draftId})`);
    refusesWith(error, "The tax ID on file is an EIN, but EIN type says SSN. Enter the SSN.");
    expect(await statusOf(draftId)).toBe("draft");

    // Entering the SSN (the Edge Function's upsert, stood in for here) clears it.
    await asPlatform(db);
    await db.exec(
      `update pre_app_tax_secrets set tax_id_type = 'SSN', tax_id_encrypted = decode('0077', 'hex')
        where pre_app_id = ${draftId}`,
    );
    await asUser(db, AGENT_ID);
    await db.exec(`select submit_pre_app(${draftId})`);
    expect(await statusOf(draftId)).toBe("submitted");
  });

  it("holds an admin submitting on a rep's behalf to the same rule", async () => {
    await makeSubmittable(draftId);
    await db.exec(`delete from pre_app_tax_secrets where pre_app_id = ${draftId}`);
    await asUser(db, ADMIN_ID);
    const error = await failure(db, `select submit_pre_app(${draftId})`);
    refusesWith(error, "The EIN (tax ID) has not been entered.");
  });

  it("checks existence and kind only: no *_encrypted column is named", async () => {
    await asPlatform(db);
    for (const fn of ["pre_app_missing_fields", "pre_app_secrets_presence"]) {
      const [{ def }] = await rows<{ def: string }>(
        db,
        `select pg_get_functiondef(p.oid) as def from pg_proc p where p.proname = '${fn}'`,
      );
      // Comments stripped first, so a sentence about the column cannot hide a
      // read of it, nor a read hide behind a sentence.
      const code = def.replace(/--[^\n]*/g, "");
      expect(code, fn).toMatch(/pre_app_tax_secrets/);
      expect(code, fn).not.toMatch(/_encrypted/);
    }
  });
});

describe("pre_app_secrets_presence reports the tax ID's kind, never the number", () => {
  it("on file and matching", async () => {
    await asUser(db, AGENT_ID);
    expect(await presence(draftId)).toMatchObject({
      tax_id_on_file: true,
      tax_id_type_on_file: "EIN",
    });
  });

  it("on file but the wrong kind: not counted, and the stored kind is named", async () => {
    await asUser(db, AGENT_ID);
    await db.exec(`update pre_apps set ein_type = 'SSN' where id = ${draftId}`);
    expect(await presence(draftId)).toMatchObject({
      tax_id_on_file: false,
      tax_id_type_on_file: "EIN",
    });
  });

  it("not on file", async () => {
    await asPlatform(db);
    await db.exec(`delete from pre_app_tax_secrets where pre_app_id = ${draftId}`);
    await asUser(db, AGENT_ID);
    expect(await presence(draftId)).toMatchObject({
      tax_id_on_file: false,
      tax_id_type_on_file: null,
    });
  });

  it("gives another agent the same not-found as a missing pre-app", async () => {
    await asUser(db, OTHER_AGENT_ID);
    const notYours = await failure(db, `select * from pre_app_secrets_presence(${draftId})`);
    const missing = await failure(db, `select * from pre_app_secrets_presence(999999)`);
    expect(notYours?.code).toBe("PT404");
    expect(notYours?.message).toBe(missing?.message);
  });
});

describe("the migration's guard", () => {
  // A database exactly as it stood before this migration, with seed() data in
  // it: pre_apps still has ein_number, and pre_app_tax_secrets does not exist.
  async function beforeTaxSecrets(): Promise<TestDb> {
    const old = await createTestDb(await migrationsBefore(MIGRATION));
    await seed(old);
    await old.exec(`reset role; set request.jwt.claims = '';`);
    // Edits to seeded drafts below are the platform's, not a transition.
    await old.exec(`select set_config('tapswipe.pre_app_transition', 'on', false)`);
    return old;
  }

  async function applyMigration(old: TestDb): Promise<string> {
    try {
      await old.exec(await readMigration(MIGRATION));
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async function nothingLanded(old: TestDb): Promise<void> {
    // The guard runs first and the file is one implicit transaction, so a
    // refusal leaves the column, and no table.
    const [state] = (
      await old.query<{ t: string | null; c: string | null }>(
        `select to_regclass('public.pre_app_tax_secrets')::text as t,
                (select column_name::text from information_schema.columns
                  where table_name = 'pre_apps' and column_name = 'ein_number') as c`,
      )
    ).rows;
    expect(state).toEqual({ t: null, c: "ein_number" });
  }

  it("refuses while any pre-app holds an EIN, names the pre-app and not the number", async () => {
    const old = await beforeTaxSecrets();
    try {
      const [{ id }] = (
        await old.query<{ id: number }>(
          `update pre_apps set ein_number = '07-1234567'
            where dba_name = 'Other Draft App' returning id`,
        )
      ).rows;
      const message = await applyMigration(old);
      expect(message).toMatch(/pre_app_tax_secrets migration refuses to run/);
      expect(message).toMatch(/pre_apps\.ein_number holds a value/);
      expect(message).toContain(`pre-app(s) ${id}.`);
      expect(message).not.toContain("1234567");
      await nothingLanded(old);
    } finally {
      await old.close();
    }
  });

  it("refuses over a blank-but-present ein_number too: the memo's test is IS NOT NULL", async () => {
    const old = await beforeTaxSecrets();
    try {
      await old.exec(`update pre_apps set ein_number = '' where dba_name = 'Agent Draft App'`);
      expect(await applyMigration(old)).toMatch(/ein_number holds a value/);
      await nothingLanded(old);
    } finally {
      await old.close();
    }
  });

  it("refuses an ein_type outside EIN/SSN, naming the value", async () => {
    const old = await beforeTaxSecrets();
    try {
      await old.exec(`update pre_apps set ein_type = 'ein' where dba_name = 'Other Draft App'`);
      const message = await applyMigration(old);
      expect(message).toMatch(/pre_apps\.ein_type holds values outside \(EIN, SSN\): 'ein'/);
      await nothingLanded(old);
    } finally {
      await old.close();
    }
  });

  it("runs over pre-apps that hold no EIN, and leaves every row as it was", async () => {
    const old = await beforeTaxSecrets();
    try {
      // Rows exist (seed() writes three pre-apps with owners and secrets), and
      // ein_type covers all three allowed states. Rows alone are no reason to
      // refuse.
      await old.exec(`update pre_apps set ein_type = 'SSN' where dba_name = 'Other Draft App'`);
      const snapshot = `select id, status, dba_name, ein_type from pre_apps order by id`;
      const before = (await old.query(snapshot)).rows;
      expect(before.length).toBeGreaterThan(0);

      expect(await applyMigration(old)).toBe("");

      expect((await old.query(snapshot)).rows).toEqual(before);
      const owners = await old.query<{ n: number }>(
        `select count(*)::int as n from pre_app_owner_secrets`,
      );
      expect(owners.rows[0].n).toBe(1);
    } finally {
      await old.close();
    }
  });

  it("runs on an empty database", async () => {
    const old = await createTestDb(await migrationsBefore(MIGRATION));
    try {
      expect(await applyMigration(old)).toBe("");
    } finally {
      await old.close();
    }
  });
});
