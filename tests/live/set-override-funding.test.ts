// scripts/set-override-funding.sql against the REAL local stack: Postgres 17,
// the real auth schema, and the non-superuser `postgres` role the Supabase SQL
// Editor runs as. The part that could differ from PGlite (a superuser) is the
// identity switch: `postgres` setting role `authenticated` and the JWT claims,
// then is_admin() and set_merchant_override_funding() as that.
//
// Run with:  npm run test:live   (needs `supabase start` and Docker; no
// functions -- ALLOW_SKIPPED_FUNCTION_TESTS=1 is fine for this file alone)
//
// Talks to Postgres through `docker exec ... psql` (no port 54321 involved).
// The local database is never changed: every run seeds inside BEGIN and ends
// in ROLLBACK, or in an error, which ends the psql session and rolls back.
// The script counts EVERY override on the project, so the transaction first
// clears the ones earlier e2e and live runs left (their lines first); ROLLBACK
// puts them back.
//
// tests/rls/set-override-funding.test.ts carries the full matrix.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const CONTAINER = `supabase_db_${/^project_id\s*=\s*"([^"]+)"/m.exec(
  readFileSync("supabase/config.toml", "utf8"),
)![1]}`;
const SCRIPT = readFileSync("scripts/set-override-funding.sql", "utf8").replace(/\r\n/g, "\n");
const COUNTS = readFileSync("scripts/set-override-funding-counts.sql", "utf8").replace(/\r\n/g, "\n");
const COMMIT_OFF = "do_commit       boolean := false;";

const ADMIN = "e0000000-0000-4000-8000-000000000001";
const BRUCE = "e0000000-0000-4000-8000-000000000003";
const SHERWIN = "e0000000-0000-4000-8000-000000000005";
const PLUMLEE = "e0000000-0000-4000-8000-000000000008";

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

// Whatever the stack holds that the fixture's people or numbers would collide
// with is moved aside inside the transaction; ROLLBACK puts it back.
const SEED = `
  delete from rep_payout_rows where line_kind = 'override';
  delete from merchant_overrides;
  update auth.users set email = 'moved-' || id || '@local.test' where lower(email) = 'owen@tapswipellc.com';
  update profiles set agent_number = null where agent_number in ('103', '105', '108');
  update profiles set llc_legal_name = null where llc_legal_name = 'Plumlee LLC';
  insert into auth.users (id, email, aud, role) values
    ('${ADMIN}', 'owen@tapswipellc.com', 'authenticated', 'authenticated'),
    ('${BRUCE}', 'bruce-live@tapswipe.test', 'authenticated', 'authenticated'),
    ('${SHERWIN}', 'sherwin-live@tapswipe.test', 'authenticated', 'authenticated'),
    ('${PLUMLEE}', 'plumlee-live@tapswipe.test', 'authenticated', 'authenticated');
  insert into profiles (id, full_name, role, is_active, email, agent_number, llc_legal_name) values
    ('${ADMIN}', 'Live Admin', 'admin', true, 'owen@tapswipellc.com', null, null),
    ('${BRUCE}', 'Live Bruce', 'agent', true, 'bruce-live@tapswipe.test', '103', null),
    ('${SHERWIN}', 'Live Sherwin', 'agent', true, 'sherwin-live@tapswipe.test', '105', null),
    ('${PLUMLEE}', 'Live Plumlee', 'agent', true, 'plumlee-live@tapswipe.test', '108', 'Plumlee LLC');
  insert into merchants (agent_id, mid, dba, status, processor, split_agent_pct, split_company_pct, city, state)
  select '${PLUMLEE}', 'PLFLIVE' || lpad(g::text, 3, '0'), 'Live Smokes #' || g, 'active', 'TSYS', 50, 50, 'Hattiesburg', 'MS'
    from generate_series(1, 88) g;
  insert into merchants (agent_id, mid, dba, status, processor, split_agent_pct, split_company_pct, city, state) values
    ('${BRUCE}', 'SHFLIVE001', 'Live Sherwin One', 'active', 'TSYS', 50, 50, 'Macon', 'GA'),
    ('${BRUCE}', 'SHFLIVE002', 'Live Sherwin Two', 'active', 'TSYS', 50, 50, 'Macon', 'GA'),
    ('${BRUCE}', 'SHFLIVE003', 'Live Sherwin Three', 'active', 'TSYS', 50, 50, 'Macon', 'GA'),
    ('${BRUCE}', '30119964826', 'Live Lamar', 'active', 'TSYS', 50, 50, 'Barnesville', 'GA');
  insert into merchant_overrides (merchant_id, recipient_id, override_pct, effective_from, funded_by)
  select id, '${BRUCE}', 5, '2026-01-01', 'owner' from merchants where mid like 'PLFLIVE%';
  insert into merchant_overrides (merchant_id, recipient_id, override_pct, effective_from, funded_by)
  select id, '${SHERWIN}', 5, '2026-01-01', 'owner' from merchants where mid like 'SHFLIVE%';
  insert into merchant_overrides (merchant_id, recipient_id, override_pct, effective_from, funded_by)
  select id, '${PLUMLEE}', 25, '2026-01-01', 'owner' from merchants where mid = '30119964826';
`;

describe("set-override-funding.sql on the local stack", () => {
  it("runs as the editor's kind of role: postgres, not a superuser", () => {
    const { ok, out } = psql(`select 'ROLE', current_user, rolsuper from pg_roles where rolname = current_user;`);
    expect(ok).toBe(true);
    expect(tagged(out, "ROLE")).toEqual([["postgres", "f"]]);
  });

  it("dry run: reports the tally, and rolls itself back", () => {
    const { ok, err } = psql(`begin;\n${SEED}\n${script()}\nrollback;`);
    expect(ok).toBe(false);
    expect(err).toContain("DRY RUN: rolled back, nothing was changed. Every check passed.");
    expect(err).toContain("overrides by recipient (agent 103 / 105 / 108 / total): 88 / 3 / 1 / 92");
    expect(err).toContain("final tally: 91 company, 1 owner, 92 in total");
  });

  it("commit: the 91 change as the admin, audited, Lamar stays, the tally grid, and the identity is put back", () => {
    const { ok, out, err } = psql(`
      begin;
      ${SEED}
      ${script(true)}
      select 'WHO', current_user, coalesce(current_setting('request.jwt.claims', true), '');
      select 'TALLY', p.agent_number, o.funded_by, count(*)
        from merchant_overrides o join profiles p on p.id = o.recipient_id
       group by 2, 3 order by 2, 3;
      select 'AUDIT', count(*), count(*) filter (where actor_id = '${ADMIN}')
        from audit_log where action = 'set_override_funding';
      select 'COUNTS', section, item, n from (${COUNTS.replace(/;\s*$/, "")}) c where section = '1 overrides';
      rollback;
    `);
    expect(err).not.toMatch(/ERROR/);
    expect(ok).toBe(true);
    expect(tagged(out, "WHO")).toEqual([["postgres", ""]]);
    expect(tagged(out, "TALLY")).toEqual([["103", "company", "88"], ["105", "company", "3"], ["108", "owner", "1"]]);
    expect(tagged(out, "AUDIT")).toEqual([["91", "91"]]);
    expect(tagged(out, "COUNTS")).toEqual([
      ["1 overrides", "103 company", "88"],
      ["1 overrides", "105 company", "3"],
      ["1 overrides", "108 owner", "1"],
      ["1 overrides", "total", "92"],
    ]);
    // The trailing grid of the commit run.
    expect(out).toMatch(/^91\|91\|1\|92\|none$/m);
  });

  it("a count that is not 92 aborts with found N, expected M", () => {
    const { ok, err } = psql(`
      begin;
      ${SEED}
      delete from merchant_overrides where merchant_id = (select id from merchants where mid = 'SHFLIVE003');
      ${script(true)}
      rollback;`);
    expect(ok).toBe(false);
    expect(err).toContain("overrides to agent 105: found 2, expected 3");
    expect(err).toContain("overrides in total: found 91, expected 92");
  });
});
