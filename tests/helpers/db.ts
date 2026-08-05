import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");

/**
 * Minimal stand-in for the parts of Supabase's hosted platform that the
 * migrations depend on but don't create themselves.
 *
 * Kept as small as possible on purpose — every line here is a place where the
 * test environment could diverge from production. It provides exactly three
 * things:
 *
 *   1. the `authenticated` role, so queries can run as a non-owner. This is
 *      what makes RLS apply at all: Postgres bypasses RLS for a table's owner,
 *      so running as the default superuser would silently pass every test.
 *   2. `auth.users`, which `profiles.id` references.
 *   3. `auth.uid()`, reading the `request.jwt.claims` GUC. This is how the real
 *      Supabase API layer exposes the caller's JWT to Postgres, so setting that
 *      GUC is a faithful stand-in for arriving with a valid access token.
 */
const AUTH_SHIM = `
  do $$
  begin
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then
      create role authenticated nologin;
    end if;
  end
  $$;

  create schema if not exists auth;

  create table if not exists auth.users (
    id uuid primary key,
    email text unique
  );

  create or replace function auth.uid()
  returns uuid
  language sql
  stable
  as $$
    select (nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub')::uuid;
  $$;
`;

/**
 * Supabase grants these to `authenticated` as part of project setup, so the
 * migrations don't. Applied after the migrations run, since it needs the tables
 * to exist. Without it every query fails on permissions rather than RLS, which
 * would look like a passing security test for entirely the wrong reason.
 */
const GRANTS = `
  grant usage on schema public to authenticated;
  grant select, insert, update, delete on all tables in schema public to authenticated;
  grant usage, select on all sequences in schema public to authenticated;
`;

export type TestDb = PGlite;

/**
 * A fresh in-memory Postgres with the auth shim and migrations applied.
 *
 * @param migrationFiles Explicit migration filenames, in order. Defaults to
 *   every .sql file in supabase/migrations sorted by name (which is the same
 *   order the Supabase CLI applies them in). Passing a subset lets a test prove
 *   a migration actually changes behavior — see the regression test.
 */
export async function createTestDb(migrationFiles?: string[]): Promise<TestDb> {
  const db = new PGlite();

  await db.exec(AUTH_SHIM);

  const files =
    migrationFiles ??
    (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();

  if (files.length === 0) {
    throw new Error(`No migrations found in ${MIGRATIONS_DIR}`);
  }

  for (const file of files) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    try {
      await db.exec(sql);
    } catch (cause) {
      throw new Error(`Migration ${file} failed to apply: ${cause}`, { cause });
    }
  }

  await db.exec(GRANTS);

  return db;
}

/**
 * Run subsequent queries as the platform owner, bypassing RLS. Stands in for a
 * service-role Edge Function — used only to seed fixtures and to make
 * out-of-band changes (like deactivating an account) that an agent could never
 * make themselves.
 */
export async function asPlatform(db: TestDb): Promise<void> {
  await db.exec(`reset role; set request.jwt.claims = '';`);
}

/**
 * Run subsequent queries as `userId` would through the Supabase API — i.e. as
 * the `authenticated` role with that user's id in the JWT claims. Pass null for
 * an unauthenticated caller.
 */
export async function asUser(db: TestDb, userId: string | null): Promise<void> {
  await db.exec(`reset role;`);
  const claims = userId
    ? JSON.stringify({ sub: userId, role: "authenticated" })
    : "";
  await db.exec(`set request.jwt.claims = '${claims}';`);
  await db.exec(`set role authenticated;`);
}

export const ADMIN_ID = "11111111-1111-1111-1111-111111111111";
export const AGENT_ID = "22222222-2222-2222-2222-222222222222";
export const OTHER_AGENT_ID = "33333333-3333-3333-3333-333333333333";

/**
 * Seeds one admin and two agents, plus a lead owned by each agent.
 *
 * Two agents rather than one on purpose: with a single agent, a policy bug that
 * returned "all rows belonging to any agent" would be indistinguishable from
 * one that correctly returned "only my rows".
 */
export async function seed(db: TestDb): Promise<void> {
  await asPlatform(db);
  await db.exec(`
    insert into auth.users (id, email) values
      ('${ADMIN_ID}', 'admin@tapswipe.test'),
      ('${AGENT_ID}', 'agent@tapswipe.test'),
      ('${OTHER_AGENT_ID}', 'other@tapswipe.test');

    insert into profiles (id, full_name, role, is_active) values
      ('${ADMIN_ID}', 'Admin User', 'admin', true),
      ('${AGENT_ID}', 'Agent User', 'agent', true),
      ('${OTHER_AGENT_ID}', 'Other Agent', 'agent', true);

    insert into leads (agent_id, dba) values
      ('${AGENT_ID}', 'Agent Lead A'),
      ('${AGENT_ID}', 'Agent Lead B'),
      ('${OTHER_AGENT_ID}', 'Other Agent Lead');
  `);
}

/** Convenience: run a query and return typed rows. */
export async function rows<T>(db: TestDb, sql: string): Promise<T[]> {
  const result = await db.query<T>(sql);
  return result.rows;
}
