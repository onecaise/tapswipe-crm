// docs/claude/grants-inventory.md on the LOCAL STACK: the doc's own read-only
// query, run as postgres (as the SQL Editor runs it) through `docker exec
// psql`, must say every grant matches.
//
// Why this is a live test as well as tests/rls/grants-inventory.test.ts: the
// stack is real Postgres with Supabase's default ACL, which PGlite does not
// have. There, a table created by postgres in public still gets TRUNCATE,
// REFERENCES, TRIGGER and MAINTAIN for service_role, and nothing for
// authenticated, unless its migration says otherwise. So a table that relied
// on the old automatic Data API grants fails here twice over: authenticated
// lacks the SELECT its policies need, and service_role holds extras.
//
// Read-only apart from the last test's probe table, which is created and
// rolled back in one transaction.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { EXPECTED, EXPECTED_SEQUENCES, inventoryQuery } from "../helpers/grants-inventory";

const CONTAINER = `supabase_db_${/^project_id\s*=\s*"([^"]+)"/m.exec(
  readFileSync("supabase/config.toml", "utf8"),
)![1]}`;
const PSQL = ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"];
const ENV = { ...process.env, MSYS_NO_PATHCONV: "1" };

/** Runs `sql` and returns its rows as JSON objects (one json_agg row). */
function query<T>(sql: string): T[] {
  const wrapped = `select coalesce(json_agg(q), '[]'::json) from (${sql.replace(/;\s*$/, "")}) q;`;
  const r = spawnSync("docker", PSQL, { input: wrapped, encoding: "utf8", env: ENV, timeout: 30_000 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`psql exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout.trim()) as T[];
}

type Result = {
  table_name: string;
  grantee: string;
  set_by: string;
  table_exists: boolean;
  expected: string;
  actual: string;
  matches: boolean;
};

describe("the grants inventory on the local stack", () => {
  it("the doc's query says every grant matches", async () => {
    const result = query<Result>(await inventoryQuery());
    expect(result.map(({ table_name, grantee, set_by, expected }) => ({ table_name, grantee, set_by, expected }))).toEqual(EXPECTED);
    expect(result.filter((r) => !r.matches)).toEqual([]);
    expect(result.every((r) => r.table_exists)).toBe(true);
  });

  it("the two sequences are granted as the doc says", () => {
    for (const [sequence, role, usage] of EXPECTED_SEQUENCES) {
      const [{ ok }] = query<{ ok: boolean }>(
        `select has_sequence_privilege('${role}', 'public.${sequence}', 'usage') as ok`,
      );
      expect(ok, `${role} usage on ${sequence}`).toBe(usage);
    }
  });

  it("a table that writes no grants would not match: the stack's default ACL is not the inventory's", () => {
    // One transaction, rolled back: a probe table made the way a migration
    // that forgot its grant lines would make it.
    const r = spawnSync(
      "docker",
      PSQL,
      {
        input: `begin;
create table public.zz_grants_inventory_probe (id int);
select coalesce(string_agg(grantee || ':' || privilege_type, ',' order by grantee, privilege_type), '')
  from information_schema.role_table_grants
 where table_schema = 'public' and table_name = 'zz_grants_inventory_probe'
   and grantee in ('anon', 'authenticated', 'service_role');
rollback;`,
        encoding: "utf8",
        env: ENV,
        timeout: 30_000,
      },
    );
    expect(r.status, r.stderr).toBe(0);
    const grants = r.stdout.trim().split(",").filter(Boolean);
    // Nothing for the client roles (so no policy could ever be reached)...
    expect(grants.filter((g) => !g.startsWith("service_role:"))).toEqual([]);
    // ...and service_role's privileges are not any row of the inventory's.
    const svc = grants.map((g) => g.split(":")[1]).sort().join(", ");
    expect(svc).not.toBe("");
    for (const row of EXPECTED.filter((e) => e.grantee === "service_role")) {
      expect(svc, row.table_name).not.toBe(row.expected);
    }
    // And it is gone.
    expect(query(`select 1 from pg_class where relname = 'zz_grants_inventory_probe'`)).toEqual([]);
  });
});
