// scripts/add-plumlee-bruce-overrides.sql against the REAL local stack:
// Postgres 17, the real auth schema, and the non-superuser `postgres` role the
// Supabase SQL Editor runs as. The part that could differ from PGlite (a
// superuser) is the identity switch: `postgres` setting role `authenticated`
// and the JWT claims, then is_admin() and set_merchant_override() as that.
//
// Run with:  npm run test:live   (needs `supabase start` and Docker; no
// functions -- ALLOW_SKIPPED_FUNCTION_TESTS=1 is fine for this file alone)
//
// Talks to Postgres through `docker exec ... psql` (no port 54321 involved).
// The local database is never changed: every run seeds inside BEGIN and ends
// in ROLLBACK, or in an error, which ends the psql session and rolls back.
//
// tests/rls/add-plumlee-bruce-overrides.test.ts carries the full matrix.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const CONTAINER = `supabase_db_${/^project_id\s*=\s*"([^"]+)"/m.exec(
  readFileSync("supabase/config.toml", "utf8"),
)![1]}`;
const SCRIPT = readFileSync("scripts/add-plumlee-bruce-overrides.sql", "utf8").replace(/\r\n/g, "\n");
const COUNTS = readFileSync("scripts/add-plumlee-bruce-overrides-counts.sql", "utf8").replace(/\r\n/g, "\n");
const COMMIT_OFF = "do_commit       boolean := false;";

const ADMIN = "c0000000-0000-4000-8000-000000000001";
const PLUMLEE = "c0000000-0000-4000-8000-000000000002";
const BRUCE = "c0000000-0000-4000-8000-000000000003";

function script(commit = false): string {
  expect(SCRIPT).toContain(COMMIT_OFF);
  return commit ? SCRIPT.replace(COMMIT_OFF, "do_commit       boolean := true;") : SCRIPT;
}

/** One psql session as `postgres`. Unaligned, tuples only, stops at the first error. */
function psql(sql: string): { ok: boolean; out: string; err: string } {
  const r = spawnSync(
    "docker",
    ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-A", "-t",
     "-F", "|", "-v", "ON_ERROR_STOP=1"],
    { input: sql, encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" }, timeout: 120_000 },
  );
  if (r.error) throw r.error;
  return { ok: r.status === 0, out: r.stdout, err: r.stderr };
}

function tagged(out: string, tag: string): string[][] {
  return out
    .split("\n")
    .filter((l) => l.startsWith(`${tag}|`))
    .map((l) => l.split("|").slice(1));
}

// The local stack may already hold an account with the admin's address, an
// agent 103 or a Plumlee LLC profile; inside the transaction they are moved
// aside so the fixture's are the only ones. ROLLBACK puts them back.
const SEED = `
  update auth.users set email = 'moved-' || id || '@local.test' where lower(email) = 'owen@tapswipellc.com';
  update profiles set agent_number = null where agent_number = '103';
  update profiles set llc_legal_name = null where llc_legal_name = 'Plumlee LLC';
  insert into auth.users (id, email, aud, role) values
    ('${ADMIN}', 'owen@tapswipellc.com', 'authenticated', 'authenticated'),
    ('${PLUMLEE}', 'plumlee-live@tapswipe.test', 'authenticated', 'authenticated'),
    ('${BRUCE}', 'bruce-live@tapswipe.test', 'authenticated', 'authenticated');
  insert into profiles (id, full_name, role, is_active, email, agent_number, llc_legal_name) values
    ('${ADMIN}', 'Live Admin', 'admin', true, 'owen@tapswipellc.com', null, null),
    ('${PLUMLEE}', 'Live Plumlee', 'agent', true, 'plumlee-live@tapswipe.test', '9101', 'Plumlee LLC'),
    ('${BRUCE}', 'Live Bruce', 'agent', true, 'bruce-live@tapswipe.test', '103', null);
  insert into merchants (agent_id, mid, dba, status, processor, split_agent_pct, split_company_pct, city, state) values
    ('${PLUMLEE}', 'PLLIVE0001', 'Live Alpha', 'active', 'TSYS', 50, 50, 'Nashville', 'TN'),
    ('${PLUMLEE}', 'PLLIVE0002', 'Live Bravo', 'inactive', 'TSYS', 30, 70, 'Nashville', 'TN');
  insert into merchant_overrides (merchant_id, recipient_id, override_pct, effective_from)
    select id, '${BRUCE}', 5, '2026-01-01' from merchants where mid = 'PLLIVE0002';
`;

describe("add-plumlee-bruce-overrides.sql on the local stack", () => {
  it("runs as the editor's kind of role: postgres, not a superuser", () => {
    const { ok, out } = psql(`select 'ROLE', current_user, rolsuper from pg_roles where rolname = current_user;`);
    expect(ok).toBe(true);
    expect(tagged(out, "ROLE")).toEqual([["postgres", "f"]]);
  });

  it("dry run: reports, and rolls itself back", () => {
    const { ok, err } = psql(`begin;\n${SEED}\n${script()}\nrollback;`);
    expect(ok).toBe(false);
    expect(err).toContain("DRY RUN: rolled back, nothing was changed. Every check passed.");
    expect(err).toContain("Plumlee LLC merchants (every status): 2");
    expect(err).toContain("would create (5% of the full residual to agent 103, from 2026-01): 1");
    expect(err).toContain("first five: Live Alpha");
  });

  it("commit: the override is created as the admin, audited, and the identity is put back", () => {
    const { ok, out, err } = psql(`
      begin;
      ${SEED}
      ${script(true)}
      select 'WHO', current_user, coalesce(current_setting('request.jwt.claims', true), '');
      select 'NEW', o.recipient_id, o.override_pct, o.effective_from, coalesce(o.effective_to::text, 'open')
        from merchant_overrides o join merchants m on m.id = o.merchant_id where m.mid = 'PLLIVE0001';
      select 'AUDIT', a.actor_id, a.action from audit_log a
       where a.table_name = 'merchant_overrides'
         and a.row_id in (select o.id::text from merchant_overrides o
                            join merchants m on m.id = o.merchant_id where m.mid = 'PLLIVE0001');
      select 'COUNTS', * from (${COUNTS.replace(/;\s*$/, "")}) c;
      rollback;
    `);
    expect(err).not.toMatch(/ERROR/);
    expect(ok).toBe(true);
    expect(tagged(out, "WHO")).toEqual([["postgres", ""]]);
    expect(tagged(out, "NEW")).toEqual([[BRUCE, "5.00", "2026-01-01", "open"]]);
    expect(tagged(out, "AUDIT")).toEqual([[ADMIN, "set_merchant_override"]]);
    // plumlee_profiles, agent_103_profiles, merchants, with 103, other, without, audit rows
    // (the planted one on Bravo has no audit row: it was inserted, not set).
    expect(tagged(out, "COUNTS")).toEqual([["1", "1", "2", "2", "0", "0", "1"]]);
  });
});
