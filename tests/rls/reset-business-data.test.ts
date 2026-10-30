/**
 * scripts/reset-business-data.sql, hermetic half (PGlite, every migration).
 *
 * The file is run exactly as Owen pastes it into the SQL Editor, with only the
 * two literals at its top flipped by string replacement, the way he would.
 * The local-stack half (tests/live/reset-business-data.test.ts) repeats the
 * core claims on real Postgres 17 as the non-superuser `postgres` role the
 * editor uses; PGlite runs as a superuser, so the privilege guard is proven
 * here by switching to a role that lacks TRUNCATE instead.
 *
 * Every refusal is checked two ways: it raised the script's own message (not
 * some incidental error), and the whole database is byte-for-byte what it was.
 */
import { readFile } from "node:fs/promises";

import { beforeEach, describe, expect, it } from "vitest";

import { asPlatform, asUser, createTestDb, rows, type TestDb } from "../helpers/db";

const SCRIPT = "scripts/reset-business-data.sql";
const SEED = "tests/fixtures/reset-business-data-seed.sql";
const COMMIT_OFF = "do_commit       boolean := false;";
const COMMIT_ON = "do_commit       boolean := true;";
const EMAILS_EMPTY = "expected_emails text[]  := array[]::text[];";

const ADMIN = "a0000000-0000-4000-8000-000000000001";
const AGENT = "a0000000-0000-4000-8000-000000000002";

async function script(opts: { commit?: boolean; emails?: string[] } = {}): Promise<string> {
  let sql = (await readFile(SCRIPT, "utf8")).replace(/\r\n/g, "\n");
  // Fail loudly if the switches ever move, rather than test an unflipped file.
  expect(sql).toContain(COMMIT_OFF);
  expect(sql).toContain(EMAILS_EMPTY);
  if (opts.commit) sql = sql.replace(COMMIT_OFF, COMMIT_ON);
  if (opts.emails) {
    const list = opts.emails.map((e) => `'${e}'`).join(", ");
    sql = sql.replace(EMAILS_EMPTY, `expected_emails text[]  := array[${list}]::text[];`);
  }
  return sql;
}

/** Every public table, auth.users and every public sequence, as one comparable map. */
async function snapshot(db: TestDb): Promise<Record<string, string>> {
  await asPlatform(db);
  const tables = await rows<{ t: string }>(
    db,
    `select relname as t from pg_class
      where relnamespace = 'public'::regnamespace and relkind in ('r','p') order by 1`,
  );
  const out: Record<string, string> = {};
  for (const { t } of [...tables, { t: "auth.users" }]) {
    const rel = t === "auth.users" ? "auth.users" : `public.${t}`;
    const [r] = await rows<{ s: string }>(
      db,
      `select count(*) || ':' || coalesce(md5(string_agg(md5(x::text), ',' order by md5(x::text))), '') as s
         from ${rel} x`,
    );
    out[t] = r.s;
  }
  for (const s of await rows<{ sequencename: string; last_value: string | null }>(
    db,
    `select sequencename, last_value::text from pg_sequences where schemaname = 'public'`,
  )) {
    out[`seq:${s.sequencename}`] = String(s.last_value);
  }
  return out;
}

async function count(db: TestDb, table: string): Promise<number> {
  const [r] = await rows<{ n: number }>(db, `select count(*)::int as n from ${table}`);
  return r.n;
}

/** Per-row md5 of the two kept relations, by id. */
async function accounts(db: TestDb): Promise<string> {
  const [r] = await rows<{ s: string }>(
    db,
    `select (select jsonb_agg(jsonb_build_array(id, md5(u::text)) order by id) from auth.users u)::text
         || (select jsonb_agg(jsonb_build_array(id, md5(p::text)) order by id) from profiles p)::text as s`,
  );
  return r.s;
}

let db: TestDb;

beforeEach(async () => {
  db = await createTestDb();
  await db.exec(await readFile(SEED, "utf8"));
});

describe("the fixture", () => {
  it("puts rows in every public table, so a reset that skipped one would show", async () => {
    const empty = await rows<{ t: string }>(
      db,
      `select c.relname as t from pg_class c
        where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
          and (xpath('/row/n/text()',
                query_to_xml(format('select count(*) as n from public.%I', c.relname), false, true, '')))[1]::text::int = 0`,
    );
    expect(empty).toEqual([]);
  });
});

describe("dry run (as shipped)", () => {
  it("runs every step, reports the counts, and changes nothing at all", async () => {
    const before = await snapshot(db);
    const error = await db.exec(await script()).then(
      () => null,
      (e: Error) => e.message,
    );
    expect(error).toMatch(/^DRY RUN: rolled back, nothing was changed\. Every check passed\./);
    expect(error).toMatch(/\n {2}profiles: 3 -> 3\n/);
    expect(error).toMatch(/\n {2}processors: 5 -> 5\n/);
    expect(error).toMatch(/\n {2}pre_app_tax_secrets: 1 -> 0\n/);
    expect(error).toMatch(/\n {2}payout_period_closures: 1 -> 0\n/);
    expect(error).toMatch(/\n {2}auth\.users: 3 -> 3\n/);
    expect(error).toMatch(/\n {2}leads: 2 -> 0\n/);
    expect(error).toMatch(/\n {2}brands: 1 -> 0\n/);
    expect(error).toMatch(/\n {2}audit_log: \d+ -> 1\n/);
    expect(await snapshot(db)).toEqual(before);
  });
});

describe("commit", () => {
  it("empties every cleared table, keeps auth.users and profiles byte-for-byte, leaves one marker", async () => {
    const keptBefore = await accounts(db);
    const results = await db.exec(await script({ commit: true }));
    const grid = results.at(-1)!.rows as { table_name: string; status: string }[];

    const tables = await rows<{ t: string }>(
      db,
      `select relname as t from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'`,
    );
    // 35 since the intake-and-reports merge: processors (kept) and
    // pre_app_tax_secrets (cleared); 36 since phase 6 added
    // payout_period_closures (cleared).
    expect(tables.length).toBe(36);
    for (const { t } of tables) {
      const n = await count(db, t);
      if (t === "profiles") expect(n, t).toBe(3);
      else if (t === "processors") expect(n, t).toBe(5);
      else if (t === "audit_log") expect(n, t).toBe(1);
      else expect(n, t).toBe(0);
    }
    expect(await accounts(db)).toBe(keptBefore);

    const [marker] = await rows<{ id: number; actor_id: string | null; action: string }>(
      db,
      `select id, actor_id, action from audit_log`,
    );
    expect(marker).toEqual({ id: 1, actor_id: null, action: "business_data_reset" });

    // The grid: one row per kept and cleared table, plus auth.users and storage.
    expect(grid.length).toBe(2 + 1 + 34 + 1);
    expect(grid.find((r) => r.table_name === "brands")?.status).toBe("cleared");
    expect(grid.find((r) => r.table_name === "profiles")?.status).toBe("kept, unchanged");
    expect(grid.find((r) => r.table_name === "processors")?.status).toBe("kept, unchanged");
    expect(grid.find((r) => r.table_name === "pre_app_tax_secrets")?.status).toBe("cleared");
    expect(grid.find((r) => r.table_name === "payout_period_closures")?.status).toBe("cleared");
  });

  it("keeps processors' five rows exactly, and the new pre-app tax secrets go", async () => {
    const before = await rows<{ code: string; label: string; sort_order: number }>(
      db,
      `select code, label, sort_order from processors order by code`,
    );
    expect(before.map((r) => r.code)).toEqual(["Netevia HQ", "PayBright", "Red Fynn", "Square", "TSYS"]);
    expect(await count(db, "pre_app_tax_secrets")).toBe(1);

    await db.exec(await script({ commit: true }));

    expect(
      await rows(db, `select code, label, sort_order from processors order by code`),
    ).toEqual(before);
    expect(await count(db, "pre_app_tax_secrets")).toBe(0);
    expect(await count(db, "merchants")).toBe(0);

    // And the kept list still works as a foreign-key target afterwards.
    await asUser(db, ADMIN);
    await db.exec(
      `insert into merchants (agent_id, dba, city, state, processor) values ('${AGENT}', 'M', 'Nashville', 'TN', 'Square')`,
    );
    await asPlatform(db);
    expect(await count(db, "merchants")).toBe(1);
  });

  it("restarts the id sequences, and the app's own inserts work afterwards", async () => {
    await db.exec(await script({ commit: true }));

    await asUser(db, AGENT);
    const [lead] = await rows<{ id: number }>(
      db,
      `insert into leads (agent_id, dba) values ('${AGENT}', 'After Reset') returning id`,
    );
    expect(lead.id).toBe(1);
    await db.exec(`
      insert into notes (agent_id, owner_type, owner_id, body) values ('${AGENT}', 'lead', ${lead.id}, 'n');
      insert into tasks (agent_id, owner_type, owner_id, title) values ('${AGENT}', 'lead', ${lead.id}, 't');
      insert into pre_apps (agent_id, dba_name, legal_business_name) values ('${AGENT}', 'P', 'P LLC');
      insert into support_tickets (agent_id, subject) values ('${AGENT}', 's');
      insert into quotes (agent_id, lead_id, customer_name) values ('${AGENT}', ${lead.id}, 'q');
    `);

    await asUser(db, ADMIN);
    await db.exec(`
      insert into merchants (agent_id, dba, city, state) values ('${AGENT}', 'M', 'Nashville', 'TN');
      insert into brands (name) values ('B');
      insert into products (name, category, brand) values ('Prod', 'Terminals', 'B');
    `);
    await asPlatform(db);

    for (const t of ["notes", "tasks", "pre_apps", "support_tickets", "quotes", "merchants", "brands", "products"]) {
      const [r] = await rows<{ id: number }>(db, `select min(id) as id from ${t}`);
      expect(r.id, t).toBe(1);
    }
  });

  it("commits when every expected email is present (case and spaces ignored)", async () => {
    await db.exec(
      await script({ commit: true, emails: ["Reset-Admin@tapswipe.test", " reset-agent@tapswipe.test"] }),
    );
    expect(await count(db, "leads")).toBe(0);
    expect(await count(db, "profiles")).toBe(3);
  });

  it("skips a clear-listed table that does not exist (prod lags the repo) and says so", async () => {
    await db.exec(`drop table product_compatibility`);
    const results = await db.exec(await script({ commit: true }));
    const grid = results.at(-1)!.rows as { table_name: string; status: string }[];
    expect(grid.find((r) => r.table_name === "product_compatibility")?.status).toBe("absent (skipped)");
    expect(await count(db, "products")).toBe(0);
  });
});

describe("scripts/reset-business-data-counts.sql", () => {
  it("counts every public table plus auth.users, read-only, before and after", async () => {
    const counts = async () =>
      Object.fromEntries(
        (await db.exec(await readFile("scripts/reset-business-data-counts.sql", "utf8")))
          .at(-1)!
          .rows.map((r) => {
            const { table_name, row_count } = r as { table_name: string; row_count: number | null };
            return [table_name, row_count];
          }),
      );
    const before = await snapshot(db);
    const pre = await counts();
    expect(await snapshot(db)).toEqual(before);
    expect(Object.keys(pre).length).toBe(36 + 2);
    expect(pre).toMatchObject({
      leads: 2, profiles: 3, processors: 5, pre_app_tax_secrets: 1, "auth.users": 3, "storage.objects": null,
    });

    await db.exec(await script({ commit: true }));
    const post = await counts();
    expect(post).toMatchObject({
      leads: 0, brands: 0, pre_app_tax_secrets: 0, audit_log: 1, profiles: 3, processors: 5, "auth.users": 3,
    });
  });
});

describe("every guard fails the run and rolls back", () => {
  async function refuses(sql: string, message: RegExp) {
    const before = await snapshot(db);
    await expect(db.exec(sql)).rejects.toThrow(message);
    expect(await snapshot(db)).toEqual(before);
  }

  it("an expected email missing from auth.users", async () => {
    await refuses(
      await script({ commit: true, emails: ["reset-admin@tapswipe.test", "nobody@tapswipe.test"] }),
      /expected_emails\[2\] is not in auth\.users/,
    );
  });

  it("an expected email with no profiles row", async () => {
    await db.exec(`insert into auth.users (id, email) values (gen_random_uuid(), 'orphan@tapswipe.test')`);
    await refuses(
      await script({ commit: true, emails: ["orphan@tapswipe.test"] }),
      /expected_emails\[1\] has no profiles row/,
    );
  });

  it("a public table in neither list", async () => {
    await db.exec(`create table public.zz_future_feature (id int); insert into zz_future_feature values (1);`);
    await refuses(await script({ commit: true }), /unclassified table\(s\) in public: zz_future_feature\./);
  });

  // The mid-run mutations ride a statement-level BEFORE TRUNCATE trigger: the
  // one moment between the script's snapshot and its re-check.
  it("profiles count changes mid-run", async () => {
    await db.exec(`
      insert into auth.users (id, email) values ('a0000000-0000-4000-8000-0000000000ff', 'spare@tapswipe.test');
      insert into profiles (id, full_name) values ('a0000000-0000-4000-8000-0000000000ff', 'Spare');
      create function zz_drop_profile() returns trigger language plpgsql as $$
      begin delete from profiles where id = 'a0000000-0000-4000-8000-0000000000ff'; return null; end $$;
      create trigger zz_drop_profile before truncate on leads for each statement execute function zz_drop_profile();
    `);
    await refuses(await script({ commit: true }), /profiles changed during the run \(count 3, was 4\)/);
  });

  it("a profile column changes mid-run, count unchanged", async () => {
    await db.exec(`
      create function zz_edit_profile() returns trigger language plpgsql as $$
      begin update profiles set territory = 'Moved' where id = '${AGENT}'; return null; end $$;
      create trigger zz_edit_profile before truncate on leads for each statement execute function zz_edit_profile();
    `);
    await refuses(await script({ commit: true }), /profiles changed during the run \(count 3, was 3\)/);
  });

  it("a processor changes mid-run (a kept table other than profiles)", async () => {
    await db.exec(`
      create function zz_edit_processor() returns trigger language plpgsql as $$
      begin update processors set label = 'Moved' where code = 'Square'; return null; end $$;
      create trigger zz_edit_processor before truncate on leads for each statement execute function zz_edit_processor();
    `);
    await refuses(
      await script({ commit: true }),
      /kept table public\.processors changed during the run \(count 5, was 5\)/,
    );
  });

  it("auth.users changes mid-run", async () => {
    await db.exec(`
      create function zz_edit_user() returns trigger language plpgsql as $$
      begin update auth.users set email = 'moved@tapswipe.test' where id = '${AGENT}'; return null; end $$;
      create trigger zz_edit_user before truncate on leads for each statement execute function zz_edit_user();
    `);
    await refuses(await script({ commit: true }), /auth\.users changed during the run/);
  });

  it("a kept table referencing a cleared one: no cascade, so TRUNCATE itself refuses", async () => {
    await db.exec(`alter table profiles add column zz_merchant int references merchants(id)`);
    await refuses(await script({ commit: true }), /cannot truncate a table referenced in a foreign key constraint/);
  });

  it("a role without TRUNCATE", async () => {
    const sql = await script({ commit: true });
    const before = await snapshot(db);
    await asUser(db, ADMIN);
    await expect(db.exec(sql)).rejects.toThrow(/authenticated lacks TRUNCATE on public\./);
    expect(await snapshot(db)).toEqual(before);
  });
});
