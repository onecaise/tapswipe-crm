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
  NARROW_GRANTS_MIGRATION,
  REVOKE_MIGRATION,
  createTestDb,
  migrationsExcept,
  readMigration,
  rows,
  type TestDb,
} from "../helpers/db";

/** The four privileges, alphabetical — the order tablePrivileges() returns. */
const ALL_TABLE_PRIVILEGES = ["DELETE", "INSERT", "SELECT", "UPDATE"];

/**
 * Which of the four DML privileges `role` holds on `table`.
 *
 * Deliberately only four. The privileges RLS cannot filter are asserted
 * separately by nonDmlPrivileges() below, because mixing them into this list
 * would let a TRUNCATE grant hide inside an expected-set comparison.
 */
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

/**
 * The privileges that `GRANT ALL` adds beyond DML, and that RLS says nothing
 * about.
 *
 * TRUNCATE is the one that matters: **RLS does not apply to it**, so a role
 * holding TRUNCATE can empty a table no matter how careful every policy on it
 * is. The audit found all 13 tables carrying `GRANT ALL` to `authenticated` on
 * both the local stack and the linked project — a plain `grant` only adds, and
 * the legacy blanket grant was only ever revoked from `anon`.
 */
async function nonDmlPrivileges(
  db: TestDb,
  role: string,
  table: string,
): Promise<string[]> {
  const result = await rows<{ privilege: string }>(
    db,
    `select p as privilege
       from unnest(array['TRUNCATE','REFERENCES','TRIGGER']) p
      where has_table_privilege('${role}', '${table}', p)
      order by p`,
  );
  return result.map((r) => r.privilege);
}

/** Which sequence privileges `role` holds. */
async function sequencePrivileges(
  db: TestDb,
  role: string,
  sequence: string,
): Promise<string[]> {
  const result = await rows<{ privilege: string }>(
    db,
    `select p as privilege
       from unnest(array['USAGE','SELECT','UPDATE']) p
      where has_sequence_privilege('${role}', '${sequence}', p)
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

    // tasks keeps all four, and this pins why: unlike notes it has an UPDATE
    // policy (`completed` is a checkbox whose purpose is to be toggled), and an
    // admin-only DELETE policy still backs the DELETE verb. Audited alongside
    // the notes revoke in 20260812143407 and found clean.
    expect(await tablePrivileges(db, "authenticated", "tasks")).toEqual(
      ALL_TABLE_PRIVILEGES,
    );

    // documents is narrower than the rest: no UPDATE. Nothing edits a document
    // row in place — it is replaced by a new upload plus a delete — so the
    // table has never had an UPDATE policy, and the grant that outlived that
    // fact was revoked by 20260811173000. Left in place it would have failed
    // the quiet way: privilege check passes, RLS filters to zero rows, and a
    // future edit affordance reports a save that did nothing.
    expect(await tablePrivileges(db, "authenticated", "documents")).toEqual([
      "DELETE",
      "INSERT",
      "SELECT",
    ]);

    // notes is narrower for a different reason: append-only by design, so a
    // note can be added and removed by an admin but never rewritten. Same dead
    // UPDATE grant as documents, revoked one migration later by
    // 20260812143407 — it was the last verb in the schema that no policy
    // backed.
    expect(await tablePrivileges(db, "authenticated", "notes")).toEqual([
      "DELETE",
      "INSERT",
      "SELECT",
    ]);

    // support_ticket_replies is append-only like notes, and was created that way
    // rather than narrowed later — a new table gets the verbs its policies back
    // and no more, which is what keeps the rule above exception-free.
    expect(
      await tablePrivileges(db, "authenticated", "support_ticket_replies"),
    ).toEqual(["DELETE", "INSERT", "SELECT"]);

    // profiles is narrower still: SELECT alone, matching its single policy.
    // It is the table that decides who is an admin, so it gets the *_secrets
    // treatment — no client write path at all. Every writer is a security
    // definer RPC or a service-role Edge Function, both of which bypass grants.
    expect(await tablePrivileges(db, "authenticated", "profiles")).toEqual([
      "SELECT",
    ]);

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

  it("ends with no privilege RLS cannot filter, and audit_log read-only", async () => {
    // The end state. On its own this assertion is nearly vacuous — PGlite never
    // had Supabase's legacy default privileges, so nothing here would have
    // granted TRUNCATE even without the fix. The test that actually proves the
    // migration is the before/after one below; this one guards against a future
    // `grant all` being added by hand.
    const db = await createTestDb();

    for (const table of [
      "profiles",
      "merchants",
      "leads",
      "ghost_sheets",
      "pre_apps",
      "pre_app_owners",
      "pre_app_terminal",
      "pre_app_business_profile",
      "documents",
      "support_tickets",
      "support_ticket_replies",
      "notes",
      "tasks",
      "audit_log",
    ]) {
      expect(
        await nonDmlPrivileges(db, "authenticated", table),
        `authenticated should hold no TRUNCATE/REFERENCES/TRIGGER on ${table}`,
      ).toEqual([]);
    }

    // audit_log is the tamper-evidence table. Its INSERT/UPDATE/DELETE grants
    // used to be held back only by the absence of a policy for those verbs, so
    // one permissive policy — or one `disable row level security` — would have
    // made the trail forgeable by any signed-in rep. Every legitimate writer is
    // a `security definer` function or a service-role Edge Function, both of
    // which bypass the grant entirely.
    expect(await tablePrivileges(db, "authenticated", "audit_log")).toEqual([
      "SELECT",
    ]);

    // SELECT on a sequence exposes last_value — a free row count of every other
    // agent's book, past RLS. UPDATE allows setval(), i.e. resetting an id
    // sequence into collisions. The legacy grant included UPDATE.
    for (const sequence of [
      "merchants_id_seq",
      "leads_id_seq",
      "pre_apps_id_seq",
    ]) {
      expect(
        await sequencePrivileges(db, "authenticated", sequence),
        `authenticated should hold USAGE alone on ${sequence}`,
      ).toEqual(["USAGE"]);
    }

    // audit_log_id_seq holds nothing at all, and is asserted apart from the
    // loop above for that reason. It was granted USAGE alongside the others
    // even after audit_log itself dropped to SELECT-only seventeen lines
    // earlier in the same migration — nothing authenticated can do consumes it,
    // since every audit_log insert runs as the owner or as service_role. What
    // it left reachable was nextval() through a security invoker RPC: burning
    // ids to put gaps in the sequence of the one table whose job is tamper
    // evidence.
    expect(
      await sequencePrivileges(db, "authenticated", "audit_log_id_seq"),
      "authenticated should hold nothing on audit_log_id_seq",
    ).toEqual([]);

    await db.close();
  });

  it("takes TRUNCATE back off authenticated on tables that already existed", async () => {
    // This is the test that proves the audit fix, and it has to construct the
    // broken state by hand.
    //
    // PGlite has no legacy Supabase default privileges, so the suite could never
    // have caught the original bug: the four verbs in the grants migration are
    // all PGlite ever had, while the linked project and the local stack both
    // carried `GRANT ALL` because a plain `grant` only ADDS and the revoke
    // migration named only `anon`. So the fixture below reproduces production's
    // real state before asserting the migration corrects it.
    const db = await createTestDb(
      await migrationsExcept(NARROW_GRANTS_MIGRATION),
    );

    // Exactly what `supabase db dump` showed on both environments.
    await db.exec(`
      grant all on
        merchants, leads, pre_apps, documents, notes, tasks, audit_log
      to authenticated;
      grant all on merchants_id_seq, audit_log_id_seq to authenticated;
    `);

    // Baseline, so the assertions afterwards are not vacuous.
    expect(await nonDmlPrivileges(db, "authenticated", "merchants")).toEqual([
      "REFERENCES",
      "TRIGGER",
      "TRUNCATE",
    ]);
    expect(await tablePrivileges(db, "authenticated", "audit_log")).toEqual(
      ALL_TABLE_PRIVILEGES,
    );
    expect(
      await sequencePrivileges(db, "authenticated", "merchants_id_seq"),
    ).toEqual(["SELECT", "UPDATE", "USAGE"]);

    await db.exec(await readMigration(NARROW_GRANTS_MIGRATION));

    // TRUNCATE is the one that matters: RLS does not apply to it, so a role
    // holding it can empty a table however careful the policies are.
    expect(await nonDmlPrivileges(db, "authenticated", "merchants")).toEqual([]);
    expect(await nonDmlPrivileges(db, "authenticated", "audit_log")).toEqual([]);

    // The four verbs the app actually needs survive the revoke.
    expect(await tablePrivileges(db, "authenticated", "merchants")).toEqual(
      ALL_TABLE_PRIVILEGES,
    );
    // …and audit_log drops to read-only.
    expect(await tablePrivileges(db, "authenticated", "audit_log")).toEqual([
      "SELECT",
    ]);
    expect(
      await sequencePrivileges(db, "authenticated", "merchants_id_seq"),
    ).toEqual(["USAGE"]);

    // The secrets tables must come out of a blanket-grant scenario with nothing,
    // which is the other thing the revoke-then-regrant shape buys.
    await db.exec(`grant all on pre_app_owner_secrets to authenticated;`);
    await db.exec(await readMigration(NARROW_GRANTS_MIGRATION));
    expect(
      await tablePrivileges(db, "authenticated", "pre_app_owner_secrets"),
    ).toEqual([]);

    await db.close();
  });

  it("auto-enables RLS on a table a future migration forgets", async () => {
    // The `ensure_rls` backstop, adopted from the linked project into
    // 20260811150000 precisely so it can be asserted instead of described.
    //
    // Why it is worth having: a migration that forgets
    // `alter table ... enable row level security` used to fail two opposite ways
    // — RLS-on-with-no-policies in production (denies everyone, looks like a
    // broken feature) and wide open everywhere else (a leak) — with the
    // environment that looked fine being the one nobody tested. Now both
    // environments behave the same way, and this test is what says so.
    const db = await createTestDb();

    await db.exec(`create table forgot_to_enable_rls (id serial primary key);`);

    const [row] = await rows<{ relrowsecurity: boolean }>(
      db,
      `select relrowsecurity from pg_class
        where oid = 'public.forgot_to_enable_rls'::regclass`,
    );

    expect(
      row.relrowsecurity,
      "the event trigger should have enabled RLS on a table that did not ask for it",
    ).toBe(true);

    // And it is a net, not a policy: the table denies everyone until someone
    // writes policies, which is the safe direction to fail.
    expect(
      await tablePrivileges(db, "authenticated", "forgot_to_enable_rls"),
    ).toEqual([]);

    await db.close();
  });

  it("grants no trigger function to authenticated", async () => {
    // A trigger fires whether or not the querying role holds EXECUTE, so a grant
    // adds surface for nothing. The linked project had set_updated_at() granted
    // to `authenticated` from the same legacy default.
    const db = await createTestDb();

    for (const signature of [
      "set_updated_at()",
      "pre_apps_guard_transitions()",
      "log_cross_agent_change()",
    ]) {
      expect(
        await canExecute(db, "authenticated", signature),
        `${signature} is a trigger function and needs no grant`,
      ).toBe(false);
      expect(await canExecute(db, "anon", signature)).toBe(false);
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
