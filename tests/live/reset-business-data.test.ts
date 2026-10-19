// scripts/reset-business-data.sql against the REAL local stack: Postgres 17,
// the real auth and storage schemas, and the non-superuser `postgres` role the
// Supabase SQL Editor runs as (asserted below, not assumed).
//
// Run with:  npm run test:live   (needs `supabase start` and Docker; no
// functions -- ALLOW_SKIPPED_FUNCTION_TESTS=1 is fine for this file alone)
//
// Talks to Postgres through `docker exec ... psql`, because nothing else in
// this repo holds a Postgres driver and the API cannot run a DO block.
//
// The local database is never changed. Every commit-mode and guard run happens
// inside BEGIN ... and ends in ROLLBACK (or in an error, which ends the psql
// session and rolls back with it). The one exception is the standalone dry run,
// which has no outer transaction on purpose -- that is the only way to prove on
// real Postgres that the script undoes itself -- and it runs only after the
// wrapped dry run has shown it raises.
//
// tests/rls/reset-business-data.test.ts is the hermetic half and carries the
// full guard matrix; this file repeats the claims that could differ between
// PGlite (a superuser, a shim auth.users, no storage) and the real thing.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const CONTAINER = `supabase_db_${/^project_id\s*=\s*"([^"]+)"/m.exec(
  readFileSync("supabase/config.toml", "utf8"),
)![1]}`;
const SCRIPT = readFileSync("scripts/reset-business-data.sql", "utf8").replace(/\r\n/g, "\n");
const SEED = readFileSync("tests/fixtures/reset-business-data-seed.sql", "utf8");
const COUNTS = readFileSync("scripts/reset-business-data-counts.sql", "utf8");
const INVENTORY = readFileSync("scripts/reset-business-data-storage-inventory.sql", "utf8");
const COMMIT_OFF = "do_commit       boolean := false;";
const EMAILS_EMPTY = "expected_emails text[]  := array[]::text[];";
const AGENT = "a0000000-0000-4000-8000-000000000002";
const ADMIN = "a0000000-0000-4000-8000-000000000001";

function script(opts: { commit?: boolean; emails?: string[] } = {}): string {
  expect(SCRIPT).toContain(COMMIT_OFF);
  expect(SCRIPT).toContain(EMAILS_EMPTY);
  let sql = SCRIPT;
  if (opts.commit) sql = sql.replace(COMMIT_OFF, "do_commit       boolean := true;");
  if (opts.emails) {
    const list = opts.emails.map((e) => `'${e}'`).join(", ");
    sql = sql.replace(EMAILS_EMPTY, `expected_emails text[]  := array[${list}]::text[];`);
  }
  return sql;
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

/**
 * The snapshot minus sequences. A wrapped run seeds inside its transaction, and
 * nextval() is not transactional, so the seed's own inserts move sequences that
 * the ROLLBACK cannot put back. That is the test, not the script; the
 * standalone dry run, which seeds nothing, compares sequences too.
 */
function dataOnly(out: string): string[][] {
  return tagged(out, "SNAP").filter(([name]) => !name.startsWith("seq:"));
}

/** Lines tagged `TAG|...`, split on the separator. */
function tagged(out: string, tag: string): string[][] {
  return out
    .split("\n")
    .filter((l) => l.startsWith(`${tag}|`))
    .map((l) => l.split("|").slice(1));
}

/** Everything the reset could touch, plus what it must not: one md5 per relation, and every sequence. */
const SNAPSHOT = `
select 'SNAP', c.oid::regclass::text,
       (xpath('/row/s/text()', query_to_xml(format(
          'select count(*) || '':'' || coalesce(md5(string_agg(md5(x::text), '','' order by md5(x::text))), '''') as s from %s x',
          c.oid::regclass), false, true, '')))[1]::text
  from pg_class c
 where (c.relnamespace = 'public'::regnamespace and c.relkind = 'r')
    or c.oid in ('auth.users'::regclass, 'storage.objects'::regclass)
union all
select 'SNAP', 'seq:' || sequencename, coalesce(last_value::text, 'null')
  from pg_sequences where schemaname = 'public'
order by 2;
`;

describe("reset-business-data.sql on the local stack", () => {
  it("runs as the editor's kind of role: postgres, not a superuser, owning every public table", () => {
    const { ok, out } = psql(`
      select 'ROLE', current_user, rolsuper, rolbypassrls from pg_roles where rolname = current_user;
      select 'NOT_OWNED', relname from pg_class
       where relnamespace = 'public'::regnamespace and relkind = 'r' and relowner <> 'postgres'::regrole;
    `);
    expect(ok).toBe(true);
    expect(tagged(out, "ROLE")).toEqual([["postgres", "f", "t"]]);
    expect(tagged(out, "NOT_OWNED")).toEqual([]);
  });

  it("commit mode: cleared tables at 0, accounts identical per row, sequences restart, app inserts work", () => {
    const { ok, out, err } = psql(`
      begin;
      ${SEED}
      create temp table zz_kept as
        select 'u' as k, id, md5(u::text) as h from auth.users u
        union all select 'p', id, md5(p::text) from profiles p;
      select 'SEEDED_EMPTY', relname from pg_class c
       where relnamespace = 'public'::regnamespace and relkind = 'r'
         and (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', relname), false, true, '')))[1]::text::int = 0;
      ${script({ commit: true, emails: ["reset-admin@tapswipe.test", "reset-agent@tapswipe.test"] })}
      select 'NONZERO', relname from pg_class c
       where relnamespace = 'public'::regnamespace and relkind = 'r' and relname not in ('profiles', 'audit_log')
         and (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', relname), false, true, '')))[1]::text::int <> 0;
      select 'AUDIT', id, coalesce(actor_id::text, 'null'), action from audit_log;
      select 'KEPT_DIFF', count(*) from (
        (select * from zz_kept except
           (select 'u', id, md5(u::text) from auth.users u union all select 'p', id, md5(p::text) from profiles p))
        union all
        ((select 'u', id, md5(u::text) from auth.users u union all select 'p', id, md5(p::text) from profiles p)
           except select * from zz_kept)) d;
      select set_config('request.jwt.claims', '{"sub":"${AGENT}","role":"authenticated"}', true);
      set local role authenticated;
      with l as (insert into leads (agent_id, dba) values ('${AGENT}', 'After Reset') returning id)
        select 'LEAD', id from l;
      insert into notes (agent_id, owner_type, owner_id, body) values ('${AGENT}', 'lead', 1, 'n');
      insert into tasks (agent_id, owner_type, owner_id, title) values ('${AGENT}', 'lead', 1, 't');
      insert into pre_apps (agent_id, dba_name, legal_business_name) values ('${AGENT}', 'P', 'P LLC');
      insert into support_tickets (agent_id, subject) values ('${AGENT}', 's');
      insert into quotes (agent_id, lead_id, customer_name) values ('${AGENT}', 1, 'q');
      reset role;
      select set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true);
      set local role authenticated;
      insert into merchants (agent_id, dba, city, state) values ('${AGENT}', 'M', 'Nashville', 'TN');
      insert into brands (name) values ('B');
      insert into products (name, category, brand) values ('Prod', 'Terminals', 'B');
      reset role;
      select 'MINID', t, (xpath('/row/n/text()', query_to_xml(format('select min(id) as n from public.%I', t), false, true, '')))[1]::text
        from unnest(array['notes','tasks','pre_apps','support_tickets','quotes','merchants','brands','products']) t;
      rollback;
    `);
    expect(err).not.toMatch(/ERROR/);
    expect(err).toMatch(/NOTICE:\s+reset-business-data: COMMITTED\./);
    expect(ok).toBe(true);
    expect(tagged(out, "SEEDED_EMPTY")).toEqual([]);
    expect(tagged(out, "NONZERO")).toEqual([]);
    expect(tagged(out, "AUDIT")).toEqual([["1", "null", "business_data_reset"]]);
    expect(tagged(out, "KEPT_DIFF")).toEqual([["0"]]);
    expect(tagged(out, "LEAD")).toEqual([["1"]]);
    for (const [t, min] of tagged(out, "MINID")) expect(min, t).toBe("1");
    // The script's own result grid came back too.
    expect(out).toMatch(/^profiles\|\d+\|\d+\|kept, unchanged$/m);
    expect(out).toMatch(/^storage\.objects\|\d+\|\d+\|NOT touched: delete these files by hand$/m);
  });

  it("dry run, wrapped: raises the DRY RUN report after every step", () => {
    const { ok, err } = psql(`begin;\n${SEED}\n${script()}\nrollback;`);
    expect(ok).toBe(false);
    expect(err).toMatch(/DRY RUN: rolled back, nothing was changed\. Every check passed\./);
    expect(err).toMatch(/leads: \d+ -> 0/);
    expect(err).toMatch(/HINT:\s+To commit, set do_commit to true/);
  });

  it("dry run, standalone exactly as the editor runs it: the real database is unchanged", () => {
    const before = psql(SNAPSHOT);
    expect(before.ok).toBe(true);
    const run = psql(script());
    expect(run.ok).toBe(false);
    expect(run.err).toMatch(/DRY RUN: rolled back/);
    const after = psql(SNAPSHOT);
    expect(tagged(after.out, "SNAP")).toEqual(tagged(before.out, "SNAP"));
    expect(tagged(before.out, "SNAP").length).toBeGreaterThan(33);
  });

  it.each([
    {
      name: "an expected email missing from auth.users",
      setup: "",
      sql: () => script({ commit: true, emails: ["reset-admin@tapswipe.test", "nobody@tapswipe.test"] }),
      error: /expected_emails\[2\] is not in auth\.users/,
    },
    {
      name: "an unclassified public table",
      setup: "create table public.zz_future_feature (id int);",
      sql: () => script({ commit: true }),
      error: /unclassified table\(s\) in public: zz_future_feature\./,
    },
    {
      name: "a profile changed mid-run",
      setup: `
        create function public.zz_edit_profile() returns trigger language plpgsql as $$
        begin update profiles set territory = 'Moved' where id = '${AGENT}'; return null; end $$;
        create trigger zz_edit_profile before truncate on leads
          for each statement execute function public.zz_edit_profile();`,
      sql: () => script({ commit: true }),
      error: /profiles changed during the run/,
    },
  ])("guard: $name fails the run", ({ setup, sql, error }) => {
    const before = psql(SNAPSHOT);
    const run = psql(`begin;\n${SEED}\n${setup}\n${sql()}\nrollback;`);
    expect(run.ok).toBe(false);
    expect(run.err).toMatch(error);
    expect(dataOnly(psql(SNAPSHOT).out)).toEqual(dataOnly(before.out));
  });

  it("the counts query and the storage inventory are read-only and run as postgres", () => {
    const before = psql(SNAPSHOT);
    const counts = psql(COUNTS);
    expect(counts.ok).toBe(true);
    const names = counts.out.trim().split("\n").map((l) => l.split("|")[0]);
    expect(names).toContain("auth.users");
    expect(names).toContain("storage.objects");
    expect(names).toContain("profiles");
    expect(names.length).toBe(33 + 2);
    const inventory = psql(INVENTORY);
    expect(inventory.ok).toBe(true);
    expect(tagged(psql(SNAPSHOT).out, "SNAP")).toEqual(tagged(before.out, "SNAP"));
  });
});
