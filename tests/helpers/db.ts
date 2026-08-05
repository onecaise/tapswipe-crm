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
 *   1. the three Data API roles, so queries can run as a non-owner. This is
 *      what makes RLS apply at all: Postgres bypasses RLS for a table's owner,
 *      so running as the default superuser would silently pass every test.
 *      All three exist because the grants migration names all three.
 *   2. `auth.users`, which `profiles.id` references.
 *   3. `auth.uid()`, reading the `request.jwt.claims` GUC. This is how the real
 *      Supabase API layer exposes the caller's JWT to Postgres, so setting that
 *      GUC is a faithful stand-in for arriving with a valid access token.
 *
 * It does NOT grant table privileges. It used to, on the assumption that
 * Supabase grants them during project setup — but that auto-exposure is
 * deprecated and off by default now, so the grant block here was hiding the fact
 * that no migration granted anything: any project built from these migrations
 * alone is unreachable through PostgREST. (The currently linked project predates
 * the change and carries legacy blanket grants, which is why it kept working —
 * that is platform history, not something this repo can rely on.) Privileges now
 * come from 20260805200000_grant_data_api_roles.sql like everything else, which
 * means these tests would fail if that migration were dropped.
 */
const AUTH_SHIM = `
  do $$
  declare
    r text;
  begin
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if not exists (select 1 from pg_roles where rolname = r) then
        execute format('create role %I nologin', r);
      end if;
    end loop;
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

export const GRANTS_MIGRATION = "20260805200000_grant_data_api_roles.sql";

/**
 * Stand-in grants for the regression tests only.
 *
 * Those tests apply a deliberate *subset* of migrations to prove a later
 * migration is load-bearing, and the grants migration can't go into an
 * arbitrary subset — it revokes on functions (is_active_agent,
 * convert_ghost_sheet_to_lead) that the earlier migrations haven't created yet.
 * Without any grants they'd fail on "permission denied" instead of on the
 * behaviour they're actually probing, which is a false pass waiting to happen.
 *
 * Applied ONLY when an explicit subset was requested. The normal path — every
 * migration, which is what all the real assertions run on — gets its privileges
 * from GRANTS_MIGRATION and nothing else.
 */
const SUBSET_GRANTS = `
  grant usage on schema public to authenticated;
  grant select, insert, update, delete on all tables in schema public to authenticated;
  grant usage on all sequences in schema public to authenticated;
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

  if (migrationFiles && !migrationFiles.includes(GRANTS_MIGRATION)) {
    await db.exec(SUBSET_GRANTS);
  }

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
 * Seeds one admin and two agents, plus leads and merchants owned by each agent.
 *
 * Two agents rather than one on purpose: with a single agent, a policy bug that
 * returned "all rows belonging to any agent" would be indistinguishable from
 * one that correctly returned "only my rows".
 *
 * Each agent gets one active and one inactive merchant, so the status filter can
 * be tested without it coinciding with the ownership filter — if every one of an
 * agent's merchants were active, "filtered by status" and "filtered by owner"
 * would produce the same rows and neither assertion would mean much.
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

    -- Follow-up dates are relative to current_date so the leads list's
    -- date-window filter can be tested without hardcoding a calendar date.
    -- One of each bucket, and the only lead inside the other agent's 7-day
    -- window belongs to the *other* agent, so "filtered by date" and
    -- "filtered by owner" can't be mistaken for each other.
    insert into leads (agent_id, dba, next_followup_date) values
      ('${AGENT_ID}',       'Agent Lead A',     current_date - 3),
      ('${AGENT_ID}',       'Agent Lead B',     current_date),
      ('${AGENT_ID}',       'Agent Lead C',     null),
      ('${OTHER_AGENT_ID}', 'Other Agent Lead', current_date + 2);

    -- Ghost sheets: two open and one already-converted for the agent, one open
    -- for the other agent. The converted one lets the "already converted" path
    -- be tested without converting first, and the notes-less one covers the
    -- branch where conversion must NOT create a notes row.
    -- lead_id is resolved by dba rather than a hardcoded serial, so the fixture
    -- doesn't silently break if seed order changes.
    insert into ghost_sheets (agent_id, lead_id, dba, contact_name, contact_phone, notes, status)
    values
      ('${AGENT_ID}',       null, 'Agent Sheet Open',     'Ann Agent',  '555-0101', 'Met at the diner. Wants terminal pricing.', 'open'),
      ('${AGENT_ID}',       null, 'Agent Sheet No Notes', 'Ned Nonote', '555-0102', null,   'open'),
      -- Points at 'Agent Lead C', deliberately not 'Agent Lead A'.
      -- ghost_sheets.lead_id has no ON DELETE clause, so it defaults to
      -- NO ACTION: a referenced lead cannot be deleted. 'Agent Lead A' is kept
      -- unreferenced so the lead delete tests have a row they can actually
      -- remove. (The FK behaviour itself is asserted in leads.test.ts.)
      ('${AGENT_ID}',
        (select id from leads where dba = 'Agent Lead C'),
                                 'Agent Sheet Converted', 'Cal Convert', '555-0103', 'Already promoted.', 'converted'),
      ('${OTHER_AGENT_ID}', null, 'Other Sheet Open',     'Oli Other',  '555-0201', 'Other agent notes.', 'open');

    insert into merchants (agent_id, mid, dba, legal_business_name, status, processor, split_agent_pct, split_company_pct)
    values
      ('${AGENT_ID}',       'MID-AGENT-1', 'Agent Active Co',   'Agent Active Co LLC',   'active',   'TSYS',  60.00, 40.00),
      ('${AGENT_ID}',       'MID-AGENT-2', 'Agent Inactive Co', 'Agent Inactive Co LLC', 'inactive', 'FDMS',  55.00, 45.00),
      ('${OTHER_AGENT_ID}', 'MID-OTHER-1', 'Other Active Co',   'Other Active Co LLC',   'active',   'TSYS',  50.00, 50.00),
      ('${OTHER_AGENT_ID}', 'MID-OTHER-2', 'Other Other Co',    'Other Other Co LLC',    'other',    'Elavon', 70.00, 30.00);

    -- Documents. owner_id is resolved by lookup rather than a hardcoded serial.
    -- One per agent against a merchant, plus one against a lead, so the
    -- owner_type/owner_id pair is exercised with more than a single shape.
    insert into documents (agent_id, owner_type, owner_id, doc_type, file_key, file_name, mime_type)
    values
      ('${AGENT_ID}', 'merchant',
        (select id from merchants where dba = 'Agent Active Co'),
        'Voided check',
        '${AGENT_ID}/merchant/1/11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'agent-voided-check.pdf', 'application/pdf'),
      ('${AGENT_ID}', 'lead',
        (select id from leads where dba = 'Agent Lead A'),
        'Statement',
        '${AGENT_ID}/lead/1/22222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'agent-statement.pdf', 'application/pdf'),
      ('${OTHER_AGENT_ID}', 'merchant',
        (select id from merchants where dba = 'Other Active Co'),
        'Driver''s license',
        '${OTHER_AGENT_ID}/merchant/3/33333333-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        'other-dl.jpg', 'image/jpeg');
  `);
}

/**
 * Wipes and re-seeds the data without touching the schema.
 *
 * Spinning up a fresh PGlite per test gives clean isolation but costs ~2s each
 * in WASM init plus migration replay, which doesn't scale as tables are added.
 * Creating the database once per file and calling this in `beforeEach` keeps the
 * same isolation for a fraction of the time.
 *
 * `restart identity` resets the serial sequences, so row ids are stable across
 * tests. `cascade` picks up every table referencing profiles.
 */
export async function resetData(db: TestDb): Promise<void> {
  await asPlatform(db);
  await db.exec(
    `truncate auth.users, profiles, merchants, leads, ghost_sheets, notes, documents
     restart identity cascade;`,
  );
  await seed(db);
}

/** Convenience: run a query and return typed rows. */
export async function rows<T>(db: TestDb, sql: string): Promise<T[]> {
  const result = await db.query<T>(sql);
  return result.rows;
}
