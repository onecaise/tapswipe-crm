import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

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
  resetData,
  rows,
  type TestDb,
} from "../helpers/db";
import {
  MERCHANT_IMPORT_BLOCKERS,
  MERCHANT_IMPORT_NOTES,
  validateMerchantRows,
  type ImportProfile,
  type RawMerchantRow,
} from "../../supabase/functions/_shared/merchant-imports.ts";

/**
 * The merchant bulk import's database half (20261106120000; phase 14 of
 * docs/design/intake-and-reports.md). Every merchant, MID and rep name here is
 * invented.
 *
 *   1. The two staging tables: admin-only to read, no client insert, the one
 *      client write is a batch's status, a batch moves only review ->
 *      abandoned (client) or -> committed (the commit), RLS stated in the
 *      migration, no reference to profiles.
 *   2. commit_merchant_import(): admin-only, all or nothing, one merchant per
 *      MID, the rate through the insert (explicit) or A31 (blank), location
 *      left empty under the import's own flag only, the merchant audit
 *      triggers firing, one audit row of its own.
 *   3. Every refusal RE-DERIVED at commit from the raw cells, even when the
 *      staged row says it is fine; the parser's own staged blockers refuse
 *      too.
 *   4. Parity: the TS staging checks and the SQL re-derivation agree on a file
 *      that raises every code.
 *   5. Mutation proofs: each protection, removed from a copy of the function,
 *      lets its case through (or, where a constraint is the backstop, leaves
 *      only that constraint's error).
 *   6. The migration's guards: refusal and pass.
 */

const MIGRATION = "20261106120000_merchant_import.sql";
const AGENT_LLC = "Agent User Payments LLC";
const OTHER_LLC = "Other Agent";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await prepare(db);
});

async function prepare(target: TestDb): Promise<void> {
  await resetData(target);
  await asPlatform(target);
  await target.exec(`
    truncate merchant_import_batches, merchant_import_rows restart identity cascade;
    truncate audit_log restart identity;
    update profiles set llc_legal_name = '${AGENT_LLC}' where id = '${AGENT_ID}';
    -- No LLC: the rep's own legal name, with a stray double space (A16).
    update profiles set llc_legal_name = 'Other  Agent', split_rate_pct = 40 where id = '${OTHER_AGENT_ID}';
    update profiles set llc_legal_name = 'Admin Holdings' where id = '${ADMIN_ID}';
  `);
}

function raw(overrides: Partial<RawMerchantRow> = {}, n = 2): RawMerchantRow {
  return {
    row_number: n,
    type_raw: "MERCHANT",
    mid_raw: `4001002003${String(n).padStart(2, "0")}`,
    mid_source: "text",
    name_raw: `Invented Merchant ${n}`,
    split_raw: "0.5",
    agent_raw: AGENT_LLC,
    processor_raw: "TSYS",
    status_raw: "Active",
    ...overrides,
  };
}

const lit = (value: unknown) =>
  value === null || value === undefined ? "null" : `'${String(value).replace(/'/g, "''")}'`;

const arr = (values: readonly string[]) =>
  `array[${values.map(lit).join(", ")}]::text[]`;

/** The TS checks, with lookups read from this database. */
async function tsValidate(target: TestDb, cells: RawMerchantRow[]) {
  await asPlatform(target);
  const profiles = (
    await rows<ImportProfile & { split_rate_pct: string | null }>(
      target,
      `select id, full_name, llc_legal_name, role, is_active, split_rate_pct from profiles`,
    )
  ).map((p) => ({ ...p, split_rate_pct: p.split_rate_pct === null ? null : Number(p.split_rate_pct) }));
  const processors = await rows<{ code: string; label: string }>(target, `select code, label from processors`);
  const existingMids = (
    await rows<{ mid: string }>(target, `select mid from merchants where mid is not null`)
  ).map((m) => m.mid);
  return validateMerchantRows(cells, { profiles, processors, existingMids });
}

/**
 * A staged batch, as stage-merchant-import writes it. `clean` stages every row
 * as the parser would say "no problem" -- the tampered case the commit must
 * still refuse.
 */
async function stage(
  target: TestDb,
  cells: RawMerchantRow[],
  { clean = false }: { clean?: boolean } = {},
): Promise<number> {
  const staged = await tsValidate(target, cells);
  await asPlatform(target);
  const [{ id }] = await rows<{ id: number }>(
    target,
    `insert into merchant_import_batches (file_name, file_kind, source_bytes, row_count)
     values ('invented-merchants.csv', 'csv', '\\x41', ${cells.length}) returning id`,
  );
  for (const r of staged) {
    await target.exec(`
      insert into merchant_import_rows (batch_id, row_number, type_raw, mid_raw, mid_source, name_raw,
        split_raw, agent_raw, processor_raw, status_raw, mid, name, owner_id, rate, processor, status,
        merged_into, blockers, notes)
      values (${id}, ${r.row_number}, ${lit(r.type_raw)}, ${lit(r.mid_raw)}, ${lit(r.mid_source)},
        ${lit(r.name_raw)}, ${lit(r.split_raw)}, ${lit(r.agent_raw)}, ${lit(r.processor_raw)},
        ${lit(r.status_raw)}, ${lit(r.mid)}, ${lit(r.name)}, ${lit(r.owner_id)}, ${lit(r.rate)},
        ${lit(r.processor)}, ${lit(r.status)}, ${lit(r.merged_into)},
        ${clean ? "'{}'" : arr(r.blockers)}, ${arr(r.notes)})`);
  }
  return id;
}

async function commit(target: TestDb, batchId: number, as: string | null = ADMIN_ID) {
  await asUser(target, as);
  try {
    const [{ result }] = await rows<{ result: { created: number; rows: number; merged: number } }>(
      target,
      `select commit_merchant_import(${batchId}) as result`,
    );
    return result;
  } finally {
    await asPlatform(target);
  }
}

async function commitError(target: TestDb, batchId: number, as: string | null = ADMIN_ID): Promise<string> {
  try {
    await commit(target, batchId, as);
  } catch (error) {
    return String(error);
  }
  throw new Error("the commit went through");
}

async function count(target: TestDb, sql: string): Promise<number> {
  await asPlatform(target);
  const [{ n }] = await rows<{ n: number }>(target, `select (${sql})::int as n`);
  return n;
}

const importedMerchants = (target: TestDb) =>
  count(target, `select count(*) from merchants where mid like '4001002003%' or mid like 'NEW%'`);

// -------------------------------------------------------------------------
// 1. The tables
// -------------------------------------------------------------------------

describe("the staging tables", () => {
  it("state row level security in the migration text, not leaving it to ensure_rls", async () => {
    const sql = await readMigration(MIGRATION);
    expect(sql).toMatch(/^alter table merchant_import_batches enable row level security;$/m);
    expect(sql).toMatch(/^alter table merchant_import_rows enable row level security;$/m);
  });

  it("are read by an admin only; a rep reads nothing and anon is refused", async () => {
    const id = await stage(db, [raw()]);
    await asUser(db, ADMIN_ID);
    expect(await rows(db, `select id from merchant_import_batches`)).toEqual([{ id }]);
    expect((await rows(db, `select id from merchant_import_rows`)).length).toBe(1);
    await asUser(db, AGENT_ID);
    expect(await rows(db, `select id from merchant_import_batches`)).toEqual([]);
    expect(await rows(db, `select id from merchant_import_rows`)).toEqual([]);
    await asUser(db, null);
    await db.exec(`set role anon`);
    await expect(db.query(`select id from merchant_import_batches`)).rejects.toThrow(/permission denied/);
    await expect(db.query(`select id from merchant_import_rows`)).rejects.toThrow(/permission denied/);
    await asPlatform(db);
  });

  it("take no client insert, and no client update but a batch's status", async () => {
    const id = await stage(db, [raw()]);
    await asUser(db, ADMIN_ID);
    await expect(
      db.query(`insert into merchant_import_batches (file_name, file_kind, source_bytes) values ('x', 'csv', '\\x41')`),
    ).rejects.toThrow(/permission denied/);
    await expect(db.query(`insert into merchant_import_rows (batch_id, row_number) values (${id}, 9)`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(db.query(`update merchant_import_batches set file_name = 'y' where id = ${id}`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(db.query(`update merchant_import_rows set blockers = '{}'`)).rejects.toThrow(/permission denied/);
    await expect(db.query(`delete from merchant_import_rows`)).rejects.toThrow(/permission denied/);
    await asPlatform(db);
  });

  it("lets an admin abandon a batch, not commit it by hand; a rep changes nothing; a settled batch never changes", async () => {
    const id = await stage(db, [raw()]);
    await asUser(db, AGENT_ID);
    expect((await db.query(`update merchant_import_batches set status = 'abandoned' where id = ${id}`)).affectedRows).toBe(0);
    await asUser(db, ADMIN_ID);
    await expect(db.query(`update merchant_import_batches set status = 'committed' where id = ${id}`)).rejects.toThrow(
      /committed only by its Commit button/,
    );
    await db.query(`update merchant_import_batches set status = 'abandoned' where id = ${id}`);
    await expect(db.query(`update merchant_import_batches set status = 'review' where id = ${id}`)).rejects.toThrow(
      /abandoned and can no longer change/,
    );
    await asPlatform(db);
    // The owner too: the trigger binds every writer.
    await expect(db.query(`update merchant_import_batches set row_count = 0 where id = ${id}`)).rejects.toThrow(
      /can no longer change/,
    );
  });

  it("reference no profiles row, so no profiles FK or teardown list grows", async () => {
    expect(
      await count(
        db,
        `select count(*) from pg_constraint where contype = 'f' and confrelid = 'profiles'::regclass
           and conrelid in ('merchant_import_batches'::regclass, 'merchant_import_rows'::regclass)`,
      ),
    ).toBe(0);
    expect(await count(db, `select count(*) from pg_constraint where contype = 'f' and confrelid = 'profiles'::regclass`)).toBe(26);
  });

  it("keep their blocker and note vocabularies identical to the parser's", async () => {
    const def = async (name: string) =>
      (
        await rows<{ d: string }>(
          db,
          `select pg_get_constraintdef(oid) as d from pg_constraint where conname = '${name}'`,
        )
      )[0].d;
    const codes = (d: string) => [...d.matchAll(/'([a-z_0-9]+)'::text/g)].map((m) => m[1]);
    expect(codes(await def("merchant_import_rows_blockers"))).toEqual([...MERCHANT_IMPORT_BLOCKERS]);
    expect(codes(await def("merchant_import_rows_notes"))).toEqual([...MERCHANT_IMPORT_NOTES]);
  });
});

describe("the functions' privileges", () => {
  const can = async (role: string, fn: string) =>
    (
      await rows<{ ok: boolean }>(db, `select has_function_privilege('${role}', '${fn}', 'execute') as ok`)
    )[0].ok;

  it("commit_merchant_import: authenticated and service_role may call it, anon may not", async () => {
    expect(await can("authenticated", "commit_merchant_import(int)")).toBe(true);
    expect(await can("service_role", "commit_merchant_import(int)")).toBe(true);
    expect(await can("anon", "commit_merchant_import(int)")).toBe(false);
  });

  it("the re-derivation, the normaliser and the triggers are callable by no client", async () => {
    for (const fn of [
      "merchant_import_findings(int)",
      "merchant_import_norm(text)",
      "guard_merchant_import_batch()",
      "enforce_merchant_location()",
    ]) {
      expect(await can("authenticated", fn), fn).toBe(false);
      expect(await can("anon", fn), fn).toBe(false);
    }
  });

  it("the commit is security definer with a pinned search_path", async () => {
    const [f] = await rows<{ prosecdef: boolean; proconfig: string[] }>(
      db,
      `select prosecdef, proconfig from pg_proc where oid = 'commit_merchant_import(int)'::regprocedure`,
    );
    expect(f).toEqual({ prosecdef: true, proconfig: ["search_path=public, pg_temp"] });
  });
});

// -------------------------------------------------------------------------
// 2. The commit
// -------------------------------------------------------------------------

describe("commit_merchant_import", () => {
  it("creates every merchant: owner, name, status, processor, the rate given or the owner's", async () => {
    const id = await stage(db, [
      raw({ mid_raw: "NEW0000001", name_raw: "  Fernwood  Bakery ", split_raw: "0.3" }, 2),
      raw({ mid_raw: "NEW0000002", agent_raw: "other agent ", split_raw: null, processor_raw: null, status_raw: "inactive" }, 3),
      raw({ mid_raw: "NEW0000003", split_raw: "25%", processor_raw: "365 pay" }, 4),
    ]);
    expect(await commit(db, id)).toEqual({ created: 3, rows: 3, merged: 0 });
    expect(
      await rows(
        db,
        `select mid, agent_id, dba, status, processor, split_agent_pct::text, split_company_pct::text, city, state, street, zip
           from merchants where mid like 'NEW%' order by mid`,
      ),
    ).toEqual([
      { mid: "NEW0000001", agent_id: AGENT_ID, dba: "Fernwood Bakery", status: "active", processor: "TSYS", split_agent_pct: "30.00", split_company_pct: "70.00", city: null, state: null, street: null, zip: null },
      // Blank Split: the owner's profile rate, 40 (A31).
      { mid: "NEW0000002", agent_id: OTHER_AGENT_ID, dba: "Invented Merchant 3", status: "inactive", processor: null, split_agent_pct: "40.00", split_company_pct: "60.00", city: null, state: null, street: null, zip: null },
      { mid: "NEW0000003", agent_id: AGENT_ID, dba: "Invented Merchant 4", status: "active", processor: "365 Pay", split_agent_pct: "25.00", split_company_pct: "75.00", city: null, state: null, street: null, zip: null },
    ]);
    expect(await rows(db, `select status, merchant_count, committed_at is not null as at from merchant_import_batches`)).toEqual([
      { status: "committed", merchant_count: 3, at: true },
    ]);
    // The staged rows stay: the record of what the file held.
    expect(await count(db, `select count(*) from merchant_import_rows`)).toBe(3);
  });

  it("merges a repeated MID into one merchant: the first name, the first non-blank processor", async () => {
    const id = await stage(db, [
      raw({ mid_raw: "NEW0000009", processor_raw: null, name_raw: "First Name" }, 2),
      raw({ mid_raw: "new0000009", processor_raw: "Square", name_raw: "Second Name", split_raw: "50%" }, 3),
    ]);
    expect(await commit(db, id)).toEqual({ created: 1, rows: 2, merged: 1 });
    expect(await rows(db, `select mid, dba, processor from merchants where upper(mid) = 'NEW0000009'`)).toEqual([
      { mid: "NEW0000009", dba: "First Name", processor: "Square" },
    ]);
  });

  it("writes one commit audit row, and every merchant's own cross-agent audit row", async () => {
    const id = await stage(db, [raw({}, 2), raw({}, 3), raw({ agent_raw: OTHER_LLC }, 4)]);
    await commit(db, id);
    expect(
      await rows(db, `select actor_id, action, table_name, row_id, detail from audit_log where action = 'commit_merchant_import'`),
    ).toEqual([
      {
        actor_id: ADMIN_ID,
        action: "commit_merchant_import",
        table_name: "merchant_import_batches",
        row_id: String(id),
        detail: "invented-merchants.csv: 3 rows, 3 merchants created, 0 duplicate rows merged",
      },
    ]);
    expect(
      await count(db, `select count(*) from audit_log where action = 'cross_agent_insert' and table_name = 'merchants' and actor_id = '${ADMIN_ID}'`),
    ).toBe(3);
  });

  it("refuses a rep (PT403) and anon (no EXECUTE), and creates nothing", async () => {
    const id = await stage(db, [raw()]);
    expect(await commitError(db, id, AGENT_ID)).toMatch(/Only an admin can import merchants/);
    expect(await commitError(db, id, null)).toMatch(/Only an admin|permission denied/);
    await asUser(db, null);
    await db.exec(`set role anon`);
    await expect(db.query(`select commit_merchant_import(${id})`)).rejects.toThrow(/permission denied for function/);
    await asPlatform(db);
    expect(await importedMerchants(db)).toBe(0);
  });

  it("refuses an unknown batch, a settled one, and an empty one", async () => {
    expect(await commitError(db, 999)).toMatch(/does not exist/);
    const id = await stage(db, [raw()]);
    await commit(db, id);
    expect(await commitError(db, id)).toMatch(/This import is committed and cannot be committed/);
    const [{ id: empty }] = await rows<{ id: number }>(
      db,
      `insert into merchant_import_batches (file_name, file_kind, source_bytes) values ('e.csv', 'csv', '\\x41') returning id`,
    );
    expect(await commitError(db, empty)).toMatch(/no rows to commit/);
  });

  it("is all or nothing: a failure on the third merchant leaves none and the batch in review", async () => {
    const id = await stage(db, [raw({}, 2), raw({}, 3), raw({}, 4)]);
    await db.exec(`
      create function test_refuse_third() returns trigger language plpgsql as $$
      begin
        if new.mid = '400100200304' then raise exception 'planted failure'; end if;
        return new;
      end $$;
      create trigger test_refuse_third before insert on merchants for each row execute function test_refuse_third();`);
    try {
      expect(await commitError(db, id)).toMatch(/planted failure/);
      expect(await importedMerchants(db)).toBe(0);
      expect(await rows(db, `select status from merchant_import_batches where id = ${id}`)).toEqual([{ status: "review" }]);
      expect(await count(db, `select count(*) from audit_log`)).toBe(0);
    } finally {
      await db.exec(`drop trigger test_refuse_third on merchants; drop function test_refuse_third();`);
    }
  });

  it("refuses a MID that became a merchant after the file was read, and an owner deactivated since", async () => {
    const id = await stage(db, [raw({}, 2), raw({}, 3)]);
    await db.exec(`insert into merchants (agent_id, mid, dba, city, state) values ('${OTHER_AGENT_ID}', '400100200302', 'Already', 'Austin', 'TX')`);
    expect(await commitError(db, id)).toMatch(/mid_exists \(row 2\)/);
    await db.exec(`delete from merchants where mid = '400100200302'; update profiles set is_active = false where id = '${AGENT_ID}'`);
    expect(await commitError(db, id)).toMatch(/inactive_agent \(rows 2, 3\)/);
  });

  it("refuses on a blocker the parser staged even when the cells look fine to SQL", async () => {
    const id = await stage(db, [raw()]);
    await db.exec(`update merchant_import_rows set blockers = array['invalid_mid'] where batch_id = ${id}`);
    expect(await commitError(db, id)).toMatch(/invalid_mid \(row 2\)/);
  });

  it("commits 500 merchants in one go, quickly", async () => {
    const cells = Array.from({ length: 500 }, (_, i) =>
      raw({ mid_raw: `NEW${String(i).padStart(7, "0")}`, agent_raw: i % 2 ? AGENT_LLC : OTHER_LLC, split_raw: i % 3 ? "0.5" : null }, i + 2),
    );
    const id = await stage(db, cells);
    const started = Date.now();
    expect(await commit(db, id)).toEqual({ created: 500, rows: 500, merged: 0 });
    // PGlite (wasm) is slower than the real server; the live suite times the stack.
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(await count(db, `select count(*) from merchants where mid like 'NEW%'`)).toBe(500);
  });
});

describe("the location exception is the import's alone", () => {
  it("leaves the flag off after a commit, and an ordinary insert without a location is still refused", async () => {
    const id = await stage(db, [raw()]);
    await commit(db, id);
    expect(await rows(db, `select coalesce(current_setting('tapswipe.merchant_import_write', true), '') as v`)).toEqual([{ v: "" }]);
    await asUser(db, ADMIN_ID);
    await expect(
      db.query(`insert into merchants (agent_id, mid, dba) values ('${AGENT_ID}', 'NOLOC0001', 'No Location')`),
    ).rejects.toThrow(/needs a city and a two-letter state/);
    await asPlatform(db);
  });

  it("even under the flag, a half location is refused", async () => {
    await db.exec(`begin; select set_config('tapswipe.merchant_import_write', 'on', true);`);
    try {
      await expect(
        db.query(`insert into merchants (agent_id, mid, dba, city) values ('${AGENT_ID}', 'HALF00001', 'Half', 'Austin')`),
      ).rejects.toThrow(/needs a city and a two-letter state/);
    } finally {
      await db.exec(`rollback`);
    }
  });

  it("the commit never sets the split guard's flag: the rate rides on the insert", async () => {
    const [{ src }] = await rows<{ src: string }>(
      db,
      `select prosrc as src from pg_proc where oid = 'commit_merchant_import(int)'::regprocedure`,
    );
    expect(src).not.toMatch(/merchant_split_write/);
    expect(src).not.toMatch(/update merchants/i);
  });
});

// -------------------------------------------------------------------------
// 3. Every refusal re-derived at commit, staged rows "clean"
// -------------------------------------------------------------------------

describe("every refusal is re-derived at commit, whatever the staged row says", () => {
  const cases: [string, RawMerchantRow[]][] = [
    ["invalid_type", [raw({ type_raw: "AGENT" })]],
    ["missing_mid", [raw({ mid_raw: null })]],
    ["invalid_mid", [raw({ mid_raw: "4001-0020" })]],
    ["mid_precision", [raw({ mid_raw: "400100200300", mid_source: "unsafe_number" })]],
    ["mid_precision", [raw({ mid_raw: "4.00100E+11" })]],
    ["missing_name", [raw({ name_raw: "  " })]],
    ["invalid_name", [raw({ name_raw: "N".repeat(201) })]],
    ["missing_agent", [raw({ agent_raw: null })]],
    ["unknown_agent", [raw({ agent_raw: "Agent User Payment LLC" })]],
    ["inactive_agent", [raw({ agent_raw: "Inactive Rep LLC" })]],
    ["ambiguous_agent", [raw({ agent_raw: "Twin Payments" })]],
    ["agent_not_rep", [raw({ agent_raw: "Admin Holdings" })]],
    ["invalid_split", [raw({ split_raw: "30" })]],
    ["invalid_split", [raw({ split_raw: "0.12345" })]],
    ["split_above_50", [raw({ split_raw: "0.6" })]],
    ["unknown_processor", [raw({ processor_raw: "Fiserv Nova" })]],
    ["invalid_status", [raw({ status_raw: "Closed" })]],
    ["duplicate_mid_conflict", [raw({}, 2), raw({ mid_raw: "400100200302", agent_raw: OTHER_LLC }, 3)]],
    ["duplicate_mid_conflict", [raw({}, 2), raw({ mid_raw: "400100200302", split_raw: "0.3" }, 3)]],
    ["duplicate_mid_conflict", [raw({}, 2), raw({ mid_raw: "400100200302", status_raw: "Inactive" }, 3)]],
    ["duplicate_mid_processor", [raw({}, 2), raw({ mid_raw: "400100200302", processor_raw: "Square" }, 3)]],
    ["mid_exists", [raw({ mid_raw: "exists0001" })]],
  ];

  beforeEach(async () => {
    await db.exec(`
      insert into auth.users (id, email) values
        ('44444444-4444-4444-4444-444444444444', 'inactive@tapswipe.test'),
        ('55555555-5555-5555-5555-555555555551', 'twin1@tapswipe.test'),
        ('55555555-5555-5555-5555-555555555552', 'twin2@tapswipe.test');
      insert into profiles (id, full_name, role, is_active, llc_legal_name) values
        ('44444444-4444-4444-4444-444444444444', 'Inactive Rep', 'agent', false, 'Inactive Rep LLC'),
        ('55555555-5555-5555-5555-555555555551', 'Twin One', 'agent', true, 'Twin Payments'),
        ('55555555-5555-5555-5555-555555555552', 'Twin Two', 'agent', true, 'twin  payments');
      insert into merchants (agent_id, mid, dba, city, state)
        values ('${OTHER_AGENT_ID}', 'EXISTS0001', 'Invented Existing', 'Austin', 'TX');`);
  });

  for (const [i, [code, cells]] of cases.entries()) {
    it(`${code} (case ${i + 1})`, async () => {
      // The parser finds it...
      const staged = await tsValidate(db, cells);
      expect(staged.some((r) => r.blockers.includes(code as never))).toBe(true);
      // ...but the staged rows are written as if it had not.
      const id = await stage(db, cells, { clean: true });
      expect(await commitError(db, id)).toMatch(new RegExp(`cannot be committed: .*${code}`));
      expect(await importedMerchants(db)).toBe(0);
      expect(await rows(db, `select status from merchant_import_batches where id = ${id}`)).toEqual([{ status: "review" }]);
    });
  }

  it("parity: the TS staging checks and the SQL re-derivation agree on every row of a file raising every code", async () => {
    const cells = cases.flatMap(([, c]) => c).map((c, i) => ({ ...c, row_number: i + 2 }));
    const staged = await tsValidate(db, cells);
    const id = await stage(db, cells, { clean: true });
    const sql = await rows<{ row_number: number; blockers: string[]; is_first: boolean; mid: string | null; owner_id: string | null }>(
      db,
      `select row_number, blockers, is_first, mid, owner_id from merchant_import_findings(${id}) order by row_number`,
    );
    expect(sql.map((r) => [r.row_number, [...r.blockers].sort()])).toEqual(
      staged.map((r) => [r.row_number, [...r.blockers].sort()]),
    );
    expect(sql.map((r) => [r.mid, r.owner_id])).toEqual(staged.map((r) => [r.mid, r.owner_id]));
    // Every code is raised somewhere.
    expect(new Set(sql.flatMap((r) => r.blockers))).toEqual(new Set(MERCHANT_IMPORT_BLOCKERS));
  });

  it("parity on a clean file: the same rows are first of their MID, with the same owner, rate and processor", async () => {
    const cells = [
      raw({ mid_raw: "NEW0000101", split_raw: null, processor_raw: null }, 2),
      raw({ mid_raw: "new0000101", split_raw: "0.5", processor_raw: "square" }, 3),
      raw({ mid_raw: "NEW0000102", agent_raw: OTHER_LLC, split_raw: "12.5%" }, 4),
    ];
    const staged = await tsValidate(db, cells);
    const id = await stage(db, cells);
    const sql = await rows<{ row_number: number; is_first: boolean; owner_id: string; rate: string | null; processor: string | null; status: string }>(
      db,
      `select row_number, is_first, owner_id, rate::text, processor, status from merchant_import_findings(${id}) order by row_number`,
    );
    expect(sql.filter((r) => r.is_first).map((r) => r.row_number)).toEqual(
      staged.filter((r) => r.merged_into === null).map((r) => r.row_number),
    );
    const first = sql.filter((r) => r.is_first);
    expect(first.map((r) => [r.owner_id, r.rate === null ? null : Number(r.rate), r.processor, r.status])).toEqual(
      staged.filter((r) => r.merged_into === null).map((r) => [r.owner_id, r.rate, r.processor, r.status]),
    );
  });
});

// -------------------------------------------------------------------------
// 5. Mutation proofs
// -------------------------------------------------------------------------

describe("mutation proofs: each protection is what stops its case", () => {
  let mutant: TestDb;
  const originals: Record<string, string> = {};
  const SIGNATURES = { findings: "merchant_import_findings(int)", commit: "commit_merchant_import(int)" } as const;

  beforeAll(async () => {
    mutant = await createTestDb();
    for (const [key, sig] of Object.entries(SIGNATURES)) {
      [{ def: originals[key] }] = await rows<{ def: string }>(
        mutant,
        `select pg_get_functiondef('${sig}'::regprocedure) as def`,
      );
    }
  });

  afterAll(async () => {
    await mutant?.close();
  });

  beforeEach(async () => {
    await prepare(mutant);
    await mutant.exec(originals.findings);
    await mutant.exec(originals.commit);
    await mutant.exec(`
      insert into auth.users (id, email) values
        ('44444444-4444-4444-4444-444444444444', 'inactive@tapswipe.test'),
        ('55555555-5555-5555-5555-555555555551', 'twin1@tapswipe.test'),
        ('55555555-5555-5555-5555-555555555552', 'twin2@tapswipe.test');
      insert into profiles (id, full_name, role, is_active, llc_legal_name) values
        ('44444444-4444-4444-4444-444444444444', 'Inactive Rep', 'agent', false, 'Inactive Rep LLC'),
        ('55555555-5555-5555-5555-555555555551', 'Twin One', 'agent', true, 'Twin Payments'),
        ('55555555-5555-5555-5555-555555555552', 'Twin Two', 'agent', true, 'twin  payments');
      insert into merchants (agent_id, mid, dba, city, state)
        values ('${OTHER_AGENT_ID}', 'existsx001', 'Invented Existing', 'Austin', 'TX');`);
  });

  async function without(fn: keyof typeof SIGNATURES, fragment: string, replacement = ""): Promise<void> {
    await asPlatform(mutant);
    const [{ def }] = await rows<{ def: string }>(
      mutant,
      `select pg_get_functiondef('${SIGNATURES[fn]}'::regprocedure) as def`,
    );
    expect(def, "the fragment must be in the function").toContain(fragment);
    await mutant.exec(def.replace(fragment, replacement));
  }

  /** The real function refuses with `code`; the mutant does not refuse with it. */
  async function proves(code: string, cells: RawMerchantRow[], mutate: () => Promise<void>, { commits = true } = {}) {
    const real = await stage(mutant, cells, { clean: true });
    expect(await commitError(mutant, real)).toMatch(new RegExp(`cannot be committed: .*${code}`));
    await mutate();
    const id = await stage(mutant, cells, { clean: true });
    if (commits) {
      expect((await commit(mutant, id)).created).toBeGreaterThan(0);
    } else {
      // A constraint is the backstop: refused, but not by this check.
      expect(await commitError(mutant, id)).not.toMatch(new RegExp(code));
    }
  }

  it("is_admin() first", async () => {
    const id = await stage(mutant, [raw()]);
    expect(await commitError(mutant, id, AGENT_ID)).toMatch(/Only an admin/);
    await without("commit", "if not is_admin() then", "if false then");
    expect((await commit(mutant, id, AGENT_ID)).created).toBe(1);
  });

  it("review only (the batch's own trigger is the backstop)", async () => {
    const id = await stage(mutant, [raw({ mid_raw: "NEW0000001" })]);
    await mutant.exec(`update merchant_import_batches set status = 'abandoned' where id = ${id}`);
    expect(await commitError(mutant, id)).toMatch(/This import is abandoned and cannot be committed/);
    await without("commit", "if batch.status <> 'review' then", "if false then");
    expect(await commitError(mutant, id)).toMatch(/abandoned and can no longer change/);
    expect(await importedMerchants(mutant)).toBe(0);
  });

  it("the refusal check itself", () =>
    proves("unknown_processor", [raw({ processor_raw: "Fiserv Nova" })], () =>
      without("commit", "if problems is not null then", "if false then")));

  it("the staged blockers count too", async () => {
    const id = await stage(mutant, [raw()]);
    await mutant.exec(`update merchant_import_rows set blockers = array['invalid_mid']`);
    expect(await commitError(mutant, id)).toMatch(/invalid_mid/);
    await without("commit", "where r.batch_id = batch.id", "where false");
    expect((await commit(mutant, id)).created).toBe(1);
  });

  it("Type MERCHANT", () =>
    proves("invalid_type", [raw({ type_raw: "AGENT" })], () =>
      without("findings", "case when g.type_text is null or upper(g.type_text) <> 'MERCHANT' then 'invalid_type' end", "null")));

  it("a spreadsheet number that may have lost digits", () =>
    proves("mid_precision", [raw({ mid_raw: "400100200300", mid_source: "unsafe_number" })], () =>
      without("findings", "when c.mid_source = 'unsafe_number' then 'mid_precision'", "when false then 'mid_precision'")));

  it("text in exponent form", () =>
    proves("mid_precision", [raw({ mid_raw: "4001002E11" })], () =>
      without("findings", "or c.mid_text ~* '^[0-9]*\\.?[0-9]+e[+-]?[0-9]+$'", "")));

  it("the MID's shape", () =>
    proves("invalid_mid", [raw({ mid_raw: "4001-0020" })], () =>
      without("findings", "when c.mid_text !~ '^[A-Za-z0-9]{6,20}$' then 'invalid_mid'", "when false then 'invalid_mid'")));

  it("a name is required (NOT NULL is the backstop)", () =>
    proves("missing_name", [raw({ name_raw: " " })], () =>
      without("findings", "case when g.name_text is null then 'missing_name'", "case when false then 'missing_name'"), { commits: false }));

  it("an unknown agent (NOT NULL is the backstop)", () =>
    proves("unknown_agent", [raw({ agent_raw: "Nobody Payments" })], () =>
      without("findings", "when g.matches = 0 then 'unknown_agent'", ""), { commits: false }));

  it("an ambiguous agent", () =>
    proves("ambiguous_agent", [raw({ agent_raw: "Twin Payments" })], async () => {
      await without("findings", "when g.matches > 1 then 'ambiguous_agent'", "");
      await without("findings", "case when g.matches = 1 then g.match_id end", "g.match_id");
    }));

  it("an inactive agent", () =>
    proves("inactive_agent", [raw({ agent_raw: "Inactive Rep LLC" })], () =>
      without("findings", "when not g.owner_active then 'inactive_agent'", "")));

  it("an admin is not a rep", () =>
    proves("agent_not_rep", [raw({ agent_raw: "Admin Holdings" })], () =>
      without("findings", "when g.owner_role <> 'agent' then 'agent_not_rep'", "")));

  it("a rate not in hundredths (otherwise rounded and stored: 12.344% becomes 12.34)", async () => {
    await proves("invalid_split", [raw({ split_raw: "12.344%" })], () =>
      without("findings", "when g.pct is null or g.pct <> round(g.pct, 2) then 'invalid_split'", "when g.pct is null then 'invalid_split'"));
    expect(await rows(mutant, `select split_agent_pct::text as r from merchants where mid = '400100200302'`)).toEqual([{ r: "12.34" }]);
  });

  it("above 50 (merchants_split_zero_to_fifty is the backstop, untouched)", async () => {
    await proves("split_above_50", [raw({ split_raw: "0.6" })], () =>
      without("findings", "when g.pct > 50 then 'split_above_50'", ""), { commits: false });
    const id = await stage(mutant, [raw({ split_raw: "0.6", mid_raw: "NEW0000060" })], { clean: true });
    expect(await commitError(mutant, id)).toMatch(/merchants_split_zero_to_fifty/);
  });

  it("an unknown processor (otherwise dropped: the merchant lands with none)", () =>
    proves("unknown_processor", [raw({ processor_raw: "Fiserv Nova" })], () =>
      without("findings", "then 'unknown_processor' end", "then null end")));

  it("Status Active or Inactive (the status NOT NULL is the backstop)", () =>
    proves("invalid_status", [raw({ status_raw: "Closed" })], () =>
      without("findings", "then 'invalid_status' end", "then null end"), { commits: false }));

  it("a repeated MID with another owner", () =>
    proves("duplicate_mid_conflict", [raw({}, 2), raw({ mid_raw: "400100200302", agent_raw: OTHER_LLC }, 3)], () =>
      without("findings", "case when gr.conflict then 'duplicate_mid_conflict' end", "null")));

  it("a repeated MID with two processors", () =>
    proves("duplicate_mid_processor", [raw({}, 2), raw({ mid_raw: "400100200302", processor_raw: "Square" }, 3)], () =>
      without("findings", "case when gr.processor_conflict then 'duplicate_mid_processor' end", "null")));

  it("the batch guard: without it an admin commits a batch by hand", async () => {
    const id = await stage(mutant, [raw()]);
    const byHand = `update merchant_import_batches
                       set status = 'committed', committed_at = now(), merchant_count = 0 where id = ${id}`;
    // The trigger binds every writer, the owner included.
    await expect(mutant.query(byHand)).rejects.toThrow(/committed only by its Commit button/);
    await mutant.exec(`drop trigger merchant_import_batches_guard on merchant_import_batches`);
    try {
      await mutant.query(byHand);
      expect(await rows(mutant, `select status from merchant_import_batches where id = ${id}`)).toEqual([{ status: "committed" }]);
    } finally {
      await asPlatform(mutant);
      await mutant.exec(`create trigger merchant_import_batches_guard before update on merchant_import_batches
                           for each row execute function guard_merchant_import_batch()`);
    }
  });

  it("the location flag: without it, any insert may skip the location", async () => {
    const [{ def }] = await rows<{ def: string }>(
      mutant,
      `select pg_get_functiondef('enforce_merchant_location()'::regprocedure) as def`,
    );
    const fragment = "and coalesce(current_setting('tapswipe.merchant_import_write', true), '') = 'on'";
    expect(def).toContain(fragment);
    await mutant.exec(def.replace(fragment, ""));
    try {
      await asUser(mutant, ADMIN_ID);
      await mutant.query(`insert into merchants (agent_id, mid, dba) values ('${AGENT_ID}', 'NOLOC0001', 'No Location')`);
      await asPlatform(mutant);
      expect(await count(mutant, `select count(*) from merchants where mid = 'NOLOC0001'`)).toBe(1);
    } finally {
      await asPlatform(mutant);
      await mutant.exec(def);
    }
  });

  it("a MID already in the CRM in another case (the unique index sees only the exact spelling)", () =>
    proves("mid_exists", [raw({ mid_raw: "EXISTSX001" })], () =>
      without("findings", "case when gr.exists_already then 'mid_exists' end", "null")));
});

// -------------------------------------------------------------------------
// 6. The migration's guards
// -------------------------------------------------------------------------

describe("the migration refuses only what it cannot handle, and passes otherwise", () => {
  async function prefix(): Promise<TestDb> {
    return createTestDb(await migrationsBefore(MIGRATION));
  }
  async function applyRest(target: TestDb): Promise<void> {
    for (const file of await migrationsFrom(MIGRATION)) {
      await target.exec(await readMigration(file));
    }
  }

  it("passes on a database holding merchants, and is a no-op for an existing identical 365 Pay row", async () => {
    const target = await prefix();
    try {
      await target.exec(`insert into processors (code, label, sort_order) values ('365 Pay', '365 Pay', 60)`);
      await applyRest(target);
      expect(await rows(target, `select code from processors order by sort_order`)).toEqual(
        ["TSYS", "Red Fynn", "PayBright", "Netevia HQ", "Square", "365 Pay"].map((code) => ({ code })),
      );
    } finally {
      await target.close();
    }
  });

  it("refuses a 365 Pay row in another spelling, naming it", async () => {
    const target = await prefix();
    try {
      await target.exec(`insert into processors (code, label, sort_order) values ('365 pay', '365 pay', 70)`);
      await expect(applyRest(target)).rejects.toThrow(/processors already holds '365 pay' \(sort order 70\)/);
    } finally {
      await target.close();
    }
  });

  it("refuses sort order 60 held by another processor, naming it", async () => {
    const target = await prefix();
    try {
      await target.exec(`insert into processors (code, label, sort_order) values ('Invented Pay', 'Invented Pay', 60)`);
      await expect(applyRest(target)).rejects.toThrow(/sort order 60 is already held by processor 'Invented Pay'/);
    } finally {
      await target.close();
    }
  });

  it("refuses a location trigger that is not the body it rewrites", async () => {
    const target = await prefix();
    try {
      await target.exec(`create or replace function enforce_merchant_location() returns trigger language plpgsql as $$ begin return new; end $$;`);
      await expect(applyRest(target)).rejects.toThrow(/enforce_merchant_location\(\) is not the body/);
    } finally {
      await target.close();
    }
  });
});
