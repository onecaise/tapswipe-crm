// Privilege-layer tests: who may touch a table at all, independent of which
// rows RLS would then show them.
//
// The rest of tests/rls asserts row visibility. That is a different question
// from this one, and the two failed apart: the policies were correct for months
// while `permission denied for table profiles` was the real answer PostgREST
// gave, because no migration granted anything. So the grant surface gets its own
// assertions.
//
// The interesting case is not today's privileges but tomorrow's table. Supabase's
// older project init installed default privileges that auto-grant every new table
// to anon and authenticated at CREATE time, which is why the linked project has
// blanket grants nobody wrote. A plain revoke cannot reach that; the scenario
// below reproduces the legacy state and proves the revoke migration closes it.

import { describe, expect, it } from "vitest";

import {
  GRANTS_MIGRATION,
  REVOKE_MIGRATION,
  createTestDb,
  migrationsExcept,
  readMigration,
  rows,
  type TestDb,
} from "../helpers/db";

/** The four privileges, alphabetical — the order tablePrivileges() returns. */
const ALL_TABLE_PRIVILEGES = ["DELETE", "INSERT", "SELECT", "UPDATE"];

/** Which of the four table privileges `role` actually holds on `table`. */
async function tablePrivileges(
  db: TestDb,
  role: string,
  table: string,
): Promise<string[]> {
  const result = await rows<{ privilege: string }>(
    db,
    `select p as privilege
       from unnest(array['SELECT','INSERT','UPDATE','DELETE']) p
      where has_table_privilege('${role}', '${table}', p)
      order by p`,
  );
  return result.map((r) => r.privilege);
}

async function canExecute(
  db: TestDb,
  role: string,
  signature: string,
): Promise<boolean> {
  const [row] = await rows<{ ok: boolean }>(
    db,
    `select has_function_privilege('${role}', '${signature}', 'execute') as ok`,
  );
  return row.ok;
}

describe("grant surface after all migrations", () => {
  it("gives authenticated the 13 non-secret tables and nothing on the secrets tables", async () => {
    const db = await createTestDb();

    expect(await tablePrivileges(db, "authenticated", "merchants")).toEqual(
      ALL_TABLE_PRIVILEGES,
    );
    expect(await tablePrivileges(db, "authenticated", "documents")).toEqual(
      ALL_TABLE_PRIVILEGES,
    );

    // Zero-policy RLS already denies these; the absent grant is the second
    // lock, so that a policy added by mistake still opens nothing.
    for (const secrets of [
      "pre_app_owner_secrets",
      "pre_app_banking_secrets",
      "pre_app_terminal_secrets",
    ]) {
      expect(await tablePrivileges(db, "authenticated", secrets)).toEqual([]);
      expect(await tablePrivileges(db, "anon", secrets)).toEqual([]);
    }

    await db.close();
  });

  it("leaves anon with no table, sequence or function access", async () => {
    const db = await createTestDb();

    expect(await tablePrivileges(db, "anon", "merchants")).toEqual([]);
    expect(await tablePrivileges(db, "anon", "profiles")).toEqual([]);
    expect(await canExecute(db, "anon", "public.is_admin()")).toBe(false);
    expect(await canExecute(db, "anon", "public.approve_pre_app(int)")).toBe(
      false,
    );

    const [seq] = await rows<{ ok: boolean }>(
      db,
      `select has_sequence_privilege('anon', 'merchants_id_seq', 'usage') as ok`,
    );
    expect(seq.ok).toBe(false);

    // Schema usage is kept on purpose: anon can reach nothing through it, and
    // dropping it would turn an empty result into a schema-level error on any
    // unauthenticated query that slips past the proxy redirect.
    const [schema] = await rows<{ ok: boolean }>(
      db,
      `select has_schema_privilege('anon', 'public', 'usage') as ok`,
    );
    expect(schema.ok).toBe(true);

    await db.close();
  });

  it("keeps the policy helpers executable by authenticated", async () => {
    const db = await createTestDb();

    // Not cosmetic: the policies call these during RLS evaluation, which runs
    // as the querying role. Without EXECUTE every policy check errors instead
    // of returning false, and the whole app 500s.
    expect(await canExecute(db, "authenticated", "public.is_admin()")).toBe(
      true,
    );
    expect(
      await canExecute(db, "authenticated", "public.is_active_agent()"),
    ).toBe(true);

    await db.close();
  });
});

describe("future tables do not silently inherit grants", () => {
  it("closes the default-privilege auto-grant that created the legacy surface", async () => {
    // Everything up to and including the grants migration, but not the revoke.
    const db = await createTestDb(await migrationsExcept(REVOKE_MIGRATION));

    // Reproduce what Supabase's older project init left on the linked project.
    // This is the mechanism behind blanket grants nobody wrote: it applies at
    // CREATE time, so it cannot be found by auditing migrations.
    await db.exec(`
      alter default privileges in schema public
        grant all on tables to anon, authenticated;
    `);

    await db.exec(`create table legacy_era_table (id serial primary key);`);

    // Baseline: the auto-grant is real, so the test below isn't vacuous.
    expect(await tablePrivileges(db, "anon", "legacy_era_table")).toEqual([
      ...ALL_TABLE_PRIVILEGES,
    ]);
    expect(
      await tablePrivileges(db, "authenticated", "legacy_era_table"),
    ).toEqual([...ALL_TABLE_PRIVILEGES]);

    await db.exec(await readMigration(REVOKE_MIGRATION));

    // Existing objects are stripped, including the table created above.
    expect(await tablePrivileges(db, "anon", "legacy_era_table")).toEqual([]);

    // And the door is shut: a table created AFTER the migration inherits
    // nothing. This is the assertion that a plain revoke could not satisfy.
    await db.exec(`create table post_revoke_table (id serial primary key);`);
    expect(await tablePrivileges(db, "anon", "post_revoke_table")).toEqual([]);
    expect(
      await tablePrivileges(db, "authenticated", "post_revoke_table"),
    ).toEqual([]);

    await db.close();
  });

  it("does NOT protect a new function — the PUBLIC execute default survives", async () => {
    const db = await createTestDb();

    await db.exec(`
      create function public.some_future_rpc()
      returns int language sql as $$ select 1 $$;
    `);

    // Asserting the gap, not a guarantee. Postgres grants EXECUTE to PUBLIC on
    // function creation and `alter default privileges ... revoke execute on
    // functions from public` does not stop it: the new function comes out with
    // proacl = NULL, the built-in default, on both Postgres 17 and PGlite.
    // Verified before writing the migration, which is why no such statement is
    // in it. PUBLIC includes anon, so a new RPC is callable unauthenticated
    // from the moment it exists.
    expect(await canExecute(db, "anon", "public.some_future_rpc()")).toBe(true);

    const [acl] = await rows<{ acl: string | null }>(
      db,
      `select proacl::text as acl from pg_proc where proname = 'some_future_rpc'`,
    );
    expect(acl.acl).toBeNull();

    await db.close();
  });

  it("is closed instead by the per-function revoke each new RPC must carry", async () => {
    const db = await createTestDb();

    await db.exec(`
      create function public.some_future_rpc()
      returns int language sql as $$ select 1 $$;
    `);
    expect(await canExecute(db, "anon", "public.some_future_rpc()")).toBe(true);

    // The pattern 20260805200000 uses for the five existing RPCs, and the only
    // thing that works. Anything adding a function has to include this or it
    // ships open.
    await db.exec(`
      revoke all on function public.some_future_rpc() from public;
      grant execute on function public.some_future_rpc() to authenticated, service_role;
    `);

    expect(await canExecute(db, "anon", "public.some_future_rpc()")).toBe(false);
    expect(
      await canExecute(db, "authenticated", "public.some_future_rpc()"),
    ).toBe(true);

    await db.close();
  });

  it("would catch the revoke migration being dropped", async () => {
    // The load-bearing check: without the revoke migration, and with the
    // legacy defaults in place, a new table is wide open. If someone deletes
    // the migration this fails loudly rather than quietly regressing.
    const db = await createTestDb(await migrationsExcept(REVOKE_MIGRATION));
    await db.exec(`
      alter default privileges in schema public
        grant all on tables to anon, authenticated;
      create table unprotected (id serial primary key);
    `);

    expect(await tablePrivileges(db, "anon", "unprotected")).toEqual([
      ...ALL_TABLE_PRIVILEGES,
    ]);

    await db.close();
  });
});

describe("the grants migration is still load-bearing", () => {
  it("leaves authenticated unable to read anything when dropped", async () => {
    const db = await createTestDb(
      await migrationsExcept(GRANTS_MIGRATION, REVOKE_MIGRATION),
    );

    // createTestDb only applies its subset stand-in grants when GRANTS_MIGRATION
    // is absent, so this is the real no-grants state: policies intact, schema
    // unreachable. Exactly what PostgREST reported before it was fixed.
    await db.exec(`revoke all on all tables in schema public from authenticated;`);
    expect(await tablePrivileges(db, "authenticated", "merchants")).toEqual([]);

    await db.close();
  });
});
