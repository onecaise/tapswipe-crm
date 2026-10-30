import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_ID,
  AGENT_ID,
  AGENT_NUMBER,
  OTHER_AGENT_ID,
  asPlatform,
  asUser,
  createTestDb,
  migrationsBefore,
  migrationsThrough,
  readMigration,
  resetData,
  rows,
  seedPayouts,
  type TestDb,
} from "../helpers/db";

/**
 * 20261030120000, the import schema -- phase 6 of
 * docs/design/intake-and-reports.md. Database only. The claims:
 *
 *   1. The catalog changes in exactly the intended ways and no other.
 *   2. A batch's processor is a listed one; its month is the 1st, not in the
 *      future and not more than 24 months back (memo A11), boundaries
 *      included, and processor and month come together.
 *   3. One committed batch per (processor, month), whoever writes it, the
 *      commit functions included. Review, abandoned and replaced batches are
 *      not limited; a batch with no processor is outside the rule.
 *   4. 'replaced' exists, only with its replaced_by_batch_id, and a client
 *      still cannot set it.
 *   5. payout_period_closures: admin reads, no client writes (permission
 *      denied, admin included), anon nothing, never edited, never a future
 *      month, and every insert and delete audited, failing closed.
 *   6. Negative volume only on a marked line, the marker only on a negative
 *      line, and no client can set it. Zero stays allowed.
 *   7. The merge key carries the processor, keeps the import predicate, and
 *      still dedups a NULL-processor line (NULLS NOT DISTINCT); both commit
 *      functions write the batch's processor, the shared pair included.
 *   8. The staging warnings vocabulary, and the widened blocker vocabulary.
 *   9. The migration refuses rows and definitions it cannot carry, naming
 *      them, and otherwise changes no existing row.
 */

const MIGRATION = "20261030120000_import_schema.sql";
const PARTNER_ID = "55555555-5555-5555-5555-555555555555";

type DbError = { code?: string; message: string };
type Privilege = { table_name: string; grantee: string; privilege_type: string };

const opened: TestDb[] = [];
afterAll(async () => {
  await Promise.all(opened.map((d) => d.close()));
});

async function open(files?: string[]): Promise<TestDb> {
  const created = await createTestDb(files);
  opened.push(created);
  return created;
}

async function attempt(fn: () => Promise<unknown>): Promise<DbError | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error as DbError;
  }
}

/** The 1st of the month `offset` months from the current UTC month, from SQL. */
async function month(target: TestDb, offset: number): Promise<string> {
  const [{ m }] = await rows<{ m: string }>(
    target,
    `select to_char((date_trunc('month', now() at time zone 'UTC')
                     + make_interval(months => ${offset}))::date, 'YYYY-MM-DD') as m`,
  );
  return m;
}

/** A batch, as the platform (the service role's stand-in). */
async function batch(
  target: TestDb,
  fields: { processor?: string | null; period?: string | null; status?: string } = {},
): Promise<number> {
  await asPlatform(target);
  const lit = (v: string | null | undefined) => (v == null ? "null" : `'${v}'`);
  const [{ id }] = await rows<{ id: number }>(
    target,
    `insert into rep_payout_batches (imported_by, file_key, file_name, status, processor, period)
     values ('${ADMIN_ID}', 'test/f.xlsx', 'f.xlsx', '${fields.status ?? "review"}',
             ${lit(fields.processor)}, ${lit(fields.period)})
     returning id`,
  );
  return id;
}

// -------------------------------------------------------------------------
// 1. Catalog
// -------------------------------------------------------------------------

describe("the catalog changes in exactly the intended ways", () => {
  let before: TestDb;
  let after: TestDb;

  beforeAll(async () => {
    before = await open(await migrationsBefore(MIGRATION));
    after = await open(await migrationsThrough(MIGRATION));
  }, 120_000);

  async function catalog(target: TestDb) {
    await asPlatform(target);
    return {
      indexes: await rows<{ name: string; def: string }>(
        target,
        `select indexname as name, indexdef as def from pg_indexes
          where schemaname = 'public' order by indexname`,
      ),
      constraints: await rows<{ name: string; tbl: string; def: string }>(
        target,
        `select c.conname as name, c.conrelid::regclass::text as tbl,
                pg_get_constraintdef(c.oid) as def
           from pg_constraint c join pg_namespace n on n.oid = c.connamespace
          where n.nspname = 'public'
          order by c.conrelid::regclass::text, c.conname`,
      ),
      functions: await rows<{ sig: string; body: string; definer: boolean; config: string | null; acl: string | null }>(
        target,
        `select p.oid::regprocedure::text as sig, p.prosrc as body,
                p.prosecdef as definer, p.proconfig::text as config, p.proacl::text as acl
           from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`,
      ),
      policies: await rows<{ tablename: string; policyname: string }>(
        target,
        `select tablename, policyname, cmd, roles::text, qual, with_check
           from pg_policies where schemaname = 'public' order by tablename, policyname`,
      ),
      triggers: await rows<{ tbl: string; tgname: string; def: string }>(
        target,
        `select tgrelid::regclass::text as tbl, tgname, pg_get_triggerdef(oid) as def
           from pg_trigger
          where not tgisinternal
            and tgrelid in (select oid from pg_class where relnamespace = 'public'::regnamespace)
          order by 1, 2`,
      ),
      columns: await rows<{ table_name: string; column_name: string }>(
        target,
        `select table_name, column_name, data_type, is_nullable, column_default,
                is_generated, generation_expression
           from information_schema.columns
          where table_schema = 'public' order by table_name, column_name`,
      ),
      tablePrivileges: await rows<Privilege>(
        target,
        `select table_name, grantee, privilege_type from information_schema.table_privileges
          where table_schema = 'public' order by 1, 2, 3`,
      ),
      columnPrivileges: await rows<Privilege & { column_name: string }>(
        target,
        `select table_name, column_name, grantee, privilege_type
           from information_schema.column_privileges
          where table_schema = 'public' order by 1, 2, 3, 4`,
      ),
    };
  }

  const key = (x: object) => JSON.stringify(x);
  const added = <T extends object>(b: T[], a: T[]) => a.filter((x) => !b.map(key).includes(key(x)));
  const removed = <T extends object>(b: T[], a: T[]) => b.filter((x) => !a.map(key).includes(key(x)));

  it("indexes: the merge key gains the processor (NULLS NOT DISTINCT), plus the one-committed rule and the closures key", async () => {
    const b = await catalog(before);
    const a = await catalog(after);
    expect(removed(b.indexes, a.indexes)).toEqual([
      {
        name: "rep_payout_rows_import_merge_key",
        def: "CREATE UNIQUE INDEX rep_payout_rows_import_merge_key ON public.rep_payout_rows USING btree (period, agent_id, mid) WHERE (line_kind = 'import'::text)",
      },
    ]);
    expect(added(b.indexes, a.indexes)).toEqual([
      {
        name: "payout_period_closures_pkey",
        def: "CREATE UNIQUE INDEX payout_period_closures_pkey ON public.payout_period_closures USING btree (period, processor)",
      },
      {
        name: "rep_payout_batches_one_committed_per_month",
        def: "CREATE UNIQUE INDEX rep_payout_batches_one_committed_per_month ON public.rep_payout_batches USING btree (processor, period) WHERE (status = 'committed'::text)",
      },
      {
        name: "rep_payout_rows_import_merge_key",
        def: "CREATE UNIQUE INDEX rep_payout_rows_import_merge_key ON public.rep_payout_rows USING btree (period, processor, agent_id, mid) NULLS NOT DISTINCT WHERE (line_kind = 'import'::text)",
      },
    ]);
  });

  it("constraints: exactly the intended ones change", async () => {
    const b = await catalog(before);
    const a = await catalog(after);
    expect(removed(b.constraints, a.constraints)).toEqual([
      {
        name: "rep_payout_batches_status_check",
        tbl: "rep_payout_batches",
        def: "CHECK ((status = ANY (ARRAY['review'::text, 'committed'::text, 'abandoned'::text])))",
      },
      {
        name: "rep_payout_import_rows_blocker_check",
        tbl: "rep_payout_import_rows",
        def: "CHECK ((blocker = ANY (ARRAY['unknown_agent'::text, 'unparseable_period'::text, 'bad_number'::text, 'missing_mid'::text, 'duplicate_in_file'::text])))",
      },
      { name: "rep_payout_rows_volume_check", tbl: "rep_payout_rows", def: "CHECK ((volume >= (0)::numeric))" },
    ]);
    const changed = added(b.constraints, a.constraints).map((c) => `${c.tbl}.${c.name}: ${c.def}`);
    expect(changed).toEqual([
      "payout_period_closures.payout_period_closures_closed_at_not_null: NOT NULL closed_at",
      "payout_period_closures.payout_period_closures_period_first_of_month: CHECK ((EXTRACT(day FROM period) = (1)::numeric))",
      "payout_period_closures.payout_period_closures_period_not_null: NOT NULL period",
      "payout_period_closures.payout_period_closures_pkey: PRIMARY KEY (period, processor)",
      "payout_period_closures.payout_period_closures_processor_fkey: FOREIGN KEY (processor) REFERENCES processors(code)",
      "payout_period_closures.payout_period_closures_processor_not_null: NOT NULL processor",
      "rep_payout_batches.rep_payout_batches_period_first_of_month: CHECK ((EXTRACT(day FROM period) = (1)::numeric))",
      "rep_payout_batches.rep_payout_batches_processor_fkey: FOREIGN KEY (processor) REFERENCES processors(code)",
      "rep_payout_batches.rep_payout_batches_processor_period_together: CHECK (((processor IS NULL) = (period IS NULL)))",
      "rep_payout_batches.rep_payout_batches_replace_needs_month: CHECK (((replaces_batch_id IS NULL) OR (processor IS NOT NULL)))",
      "rep_payout_batches.rep_payout_batches_replace_pair_not_self: CHECK (((replaces_batch_id <> id) AND (replaced_by_batch_id <> id)))",
      "rep_payout_batches.rep_payout_batches_replaced_by_batch_id_fkey: FOREIGN KEY (replaced_by_batch_id) REFERENCES rep_payout_batches(id)",
      "rep_payout_batches.rep_payout_batches_replaced_by_when_replaced: CHECK (((status = 'replaced'::text) = (replaced_by_batch_id IS NOT NULL)))",
      "rep_payout_batches.rep_payout_batches_replaces_batch_id_fkey: FOREIGN KEY (replaces_batch_id) REFERENCES rep_payout_batches(id)",
      "rep_payout_batches.rep_payout_batches_status_check: CHECK ((status = ANY (ARRAY['review'::text, 'committed'::text, 'abandoned'::text, 'replaced'::text])))",
      "rep_payout_import_rows.rep_payout_import_rows_blocker_check: CHECK ((blocker = ANY (ARRAY['unknown_agent'::text, 'unparseable_period'::text, 'bad_number'::text, 'missing_mid'::text, 'duplicate_in_file'::text, 'unknown_mid'::text, 'duplicate_mid'::text, 'mid_in_other_batch'::text, 'wrong_income_type'::text, 'missing_figure'::text, 'unreadable_number'::text])))",
      "rep_payout_import_rows.rep_payout_import_rows_warnings_not_null: NOT NULL warnings",
      "rep_payout_import_rows.rep_payout_import_rows_warnings_vocabulary: CHECK ((warnings <@ ARRAY['processor_mismatch'::text, 'inactive_merchant'::text, 'bad_numbers'::text]))",
      "rep_payout_rows.rep_payout_rows_processor_fkey: FOREIGN KEY (processor) REFERENCES processors(code)",
      "rep_payout_rows.rep_payout_rows_volume_check: CHECK ((volume_confirmed_negative = COALESCE((volume < (0)::numeric), false)))",
      "rep_payout_rows.rep_payout_rows_volume_confirmed_negative_not_null: NOT NULL volume_confirmed_negative",
    ]);
  });

  it("functions: the two commits differ only by the processor; three new trigger functions, none executable by a client", async () => {
    const b = await catalog(before);
    const a = await catalog(after);
    const sigs = (list: { sig: string }[]) => list.map((f) => f.sig);
    expect(sigs(a.functions).filter((s) => !sigs(b.functions).includes(s))).toEqual([
      "guard_payout_batch_period()",
      "guard_payout_period_closure()",
      "log_payout_period_closure()",
    ]);
    expect(sigs(b.functions).filter((s) => !sigs(a.functions).includes(s))).toEqual([]);

    const differing = a.functions.filter((f) => {
      const old = b.functions.find((o) => o.sig === f.sig);
      return old && key(old) !== key(f);
    });
    expect(differing.map((f) => f.sig)).toEqual([
      "commit_residual_import(integer)",
      "commit_residual_import_v2(integer)",
    ]);

    // Each body, with the intended edits undone, is its predecessor exactly.
    const undo = (s: string) =>
      s
        .split("on conflict (period, processor, agent_id, mid) where").join("on conflict (period, agent_id, mid) where")
        .split("batch_id, processor\n  )").join("batch_id\n  )")
        .split("batch_id_input, batch.processor\n").join("batch_id_input\n")
        .split("account_residual_income, processor\n  )").join("account_residual_income\n  )")
        .split("    null, batch.processor\n").join("    null\n")
        .split("sl.account_residual_income, sl.processor\n").join("sl.account_residual_income\n");
    for (const f of differing) {
      const old = b.functions.find((o) => o.sig === f.sig)!;
      expect(undo(f.body), f.sig).toBe(old.body);
      expect({ ...f, body: "" }).toEqual({ ...old, body: "" });
    }

    // THE COALESCE is still the merge rule in both (phase 8 retires it).
    for (const f of differing) {
      expect(f.body).toMatch(/residual_income = coalesce\(excluded\.residual_income,\s+rep_payout_rows\.residual_income\)/);
      expect(f.body).toMatch(/rep_split_pct\s+= coalesce\(excluded\.rep_split_pct,\s+rep_payout_rows\.rep_split_pct\)/);
    }

    const fresh = a.functions.filter((f) => !sigs(b.functions).includes(f.sig));
    expect(fresh.map((f) => [f.sig, f.definer])).toEqual([
      ["guard_payout_batch_period()", false],
      ["guard_payout_period_closure()", false],
      // audit_log has no insert policy: the audit trigger must be definer.
      ["log_payout_period_closure()", true],
    ]);
    for (const f of fresh) {
      expect(f.config, f.sig).toBe('{"search_path=public, pg_temp"}');
      for (const role of ["anon", "authenticated", "service_role"]) {
        const [{ ok }] = await rows<{ ok: boolean }>(
          after,
          `select has_function_privilege('${role}', 'public.${f.sig}', 'execute') as ok`,
        );
        expect(ok, `${role} on ${f.sig}`).toBe(false);
      }
    }
  });

  it("policies, triggers, columns, privileges: only the intended additions", async () => {
    const b = await catalog(before);
    const a = await catalog(after);

    expect(removed(b.policies, a.policies)).toEqual([]);
    expect(added(b.policies, a.policies)).toEqual([
      {
        tablename: "payout_period_closures",
        policyname: "admin only select",
        cmd: "SELECT",
        roles: "{public}",
        qual: "is_admin()",
        with_check: null,
      },
    ]);

    expect(removed(b.triggers, a.triggers)).toEqual([]);
    expect(added(b.triggers, a.triggers).map((t) => `${t.tbl}.${t.tgname}`)).toEqual([
      "payout_period_closures.payout_period_closures_audit",
      "payout_period_closures.payout_period_closures_guard",
      "rep_payout_batches.rep_payout_batches_period_window",
    ]);

    expect(removed(b.columns, a.columns)).toEqual([]);
    expect(added(b.columns, a.columns).map((c) => `${c.table_name}.${c.column_name}`)).toEqual([
      "payout_period_closures.closed_at",
      "payout_period_closures.period",
      "payout_period_closures.processor",
      "rep_payout_batches.period",
      "rep_payout_batches.processor",
      "rep_payout_batches.replaced_by_batch_id",
      "rep_payout_batches.replaces_batch_id",
      "rep_payout_import_rows.warnings",
      "rep_payout_rows.processor",
      "rep_payout_rows.volume_confirmed_negative",
    ]);

    // The only new table privileges are the closures table's, and on it the
    // client roles hold SELECT and nothing else.
    expect(removed(b.tablePrivileges, a.tablePrivileges)).toEqual([]);
    const fresh = added(b.tablePrivileges, a.tablePrivileges);
    expect(fresh.every((p) => p.table_name === "payout_period_closures")).toBe(true);
    expect(
      fresh
        .filter((p) => p.grantee !== "postgres")
        .map((p) => `${p.grantee}:${p.privilege_type}`),
    ).toEqual(["authenticated:SELECT", "service_role:SELECT"]);

    // No new column privilege for a client role but SELECT (which the new
    // columns inherit from the table): the batch UPDATE grant is still (status)
    // only, the ledger's still the two figures. service_role's new column
    // entries are its existing table-level grants, shown per column.
    const clientColumns = <T extends Privilege>(list: T[]) =>
      list.filter((p) => ["authenticated", "anon"].includes(p.grantee));
    expect(
      added(clientColumns(b.columnPrivileges), clientColumns(a.columnPrivileges)).filter(
        (p) => p.table_name !== "payout_period_closures"
          && p.privilege_type !== "SELECT",
      ),
    ).toEqual([]);
  });

  it("states row level security for the new table in the migration text, not leaving it to ensure_rls", async () => {
    // ensure_rls would switch it on anyway wherever it runs, so the behavioural
    // tests cannot see a missing line; this can.
    const sql = await readMigration(MIGRATION);
    expect(sql).toMatch(/alter table payout_period_closures enable row level security;/);
    expect(sql).toMatch(/revoke all on payout_period_closures from anon, authenticated, service_role;/);
    const [{ rls }] = await rows<{ rls: boolean }>(
      after,
      `select relrowsecurity as rls from pg_class where oid = 'public.payout_period_closures'::regclass`,
    );
    expect(rls).toBe(true);
  });
});

// -------------------------------------------------------------------------
// 2-8. Behaviour, on one database as this migration left it.
//
// Through 20261030120000, not every migration: the next one (20261030140000,
// phase 7) makes a processor and month REQUIRED on every new batch, so the
// rules here about a batch WITHOUT them -- together-or-neither, legacy
// batches outside the one-committed rule, a replace with no processor-month,
// staging rows of such a batch -- can only be shown on this schema. What
// 20261030140000 changed is pinned by tests/rls/import-parser.test.ts.
// -------------------------------------------------------------------------

let db: TestDb;

beforeAll(async () => {
  db = await open(await migrationsThrough(MIGRATION));
});

beforeEach(async () => {
  await resetData(db);
  await asPlatform(db);
  await db.exec(`delete from payout_period_closures; delete from audit_log;`);
});

describe("a batch's processor and month", () => {
  it("accepts a listed processor and refuses anything else", async () => {
    const m = await month(db, -1);
    expect(await batch(db, { processor: "Red Fynn", period: m })).toBeGreaterThan(0);
    const error = await attempt(() => batch(db, { processor: "Tsys", period: m }));
    expect(error?.message).toMatch(/rep_payout_batches_processor_fkey/);
  });

  it("takes processor and month together or not at all", async () => {
    const m = await month(db, -1);
    expect(await batch(db, {})).toBeGreaterThan(0);
    expect((await attempt(() => batch(db, { processor: "TSYS" })))?.message).toMatch(
      /rep_payout_batches_processor_period_together/,
    );
    expect((await attempt(() => batch(db, { period: m })))?.message).toMatch(
      /rep_payout_batches_processor_period_together/,
    );
  });

  it("must be the 1st of a month", async () => {
    const m = await month(db, -1);
    const error = await attempt(() => batch(db, { processor: "TSYS", period: m.slice(0, 8) + "15" }));
    expect(error?.message).toMatch(/rep_payout_batches_period_first_of_month/);
  });

  it("accepts the current month and the month exactly 24 back; refuses next month and 25 back", async () => {
    for (const offset of [0, -1, -23, -24]) {
      expect(await batch(db, { processor: "TSYS", period: await month(db, offset) }), String(offset)).toBeGreaterThan(0);
    }
    const next = await attempt(async () => batch(db, { processor: "TSYS", period: await month(db, 1) }));
    expect(next?.code).toBe("PT400");
    expect(next?.message).toMatch(/is in the future/);
    const farFuture = await attempt(async () => batch(db, { processor: "TSYS", period: await month(db, 13) }));
    expect(farFuture?.message).toMatch(/is in the future/);

    const tooOld = await attempt(async () => batch(db, { processor: "TSYS", period: await month(db, -25) }));
    expect(tooOld?.code).toBe("PT400");
    expect(tooOld?.message).toMatch(/more than 24 months ago/);
  });

  it("refuses moving a batch's month out of the window, and lets an old batch age without touching it", async () => {
    const id = await batch(db, { processor: "TSYS", period: await month(db, -1) });
    const moved = await attempt(async () =>
      db.exec(`update rep_payout_batches set period = '${await month(db, 2)}' where id = ${id}`),
    );
    expect(moved?.message).toMatch(/is in the future/);

    // A batch whose month has since left the window: written with the trigger
    // off (as if two years had passed), then updated in another column.
    await db.exec(`set session_replication_role = replica`);
    const old = await batch(db, { processor: "TSYS", period: await month(db, -30) });
    await db.exec(`set session_replication_role = origin`);
    await db.exec(`update rep_payout_batches set row_count = 7 where id = ${old}`);
    const [{ n }] = await rows<{ n: number }>(db, `select row_count as n from rep_payout_batches where id = ${old}`);
    expect(n).toBe(7);
  });
});

describe("one committed batch per processor and month", () => {
  it("refuses a second committed batch for the same processor and month", async () => {
    const m = await month(db, -1);
    await batch(db, { processor: "TSYS", period: m, status: "committed" });
    const error = await attempt(() => batch(db, { processor: "TSYS", period: m, status: "committed" }));
    expect(error?.code).toBe("23505");
    expect(error?.message).toMatch(/rep_payout_batches_one_committed_per_month/);

    // ...and by an update to committed, too.
    const review = await batch(db, { processor: "TSYS", period: m });
    const flip = await attempt(() =>
      db.exec(`update rep_payout_batches set status = 'committed' where id = ${review}`),
    );
    expect(flip?.message).toMatch(/rep_payout_batches_one_committed_per_month/);
  });

  it("does not limit review, abandoned or replaced batches, another processor, or another month", async () => {
    const m = await month(db, -1);
    const first = await batch(db, { processor: "TSYS", period: m, status: "committed" });
    await batch(db, { processor: "TSYS", period: m });
    await batch(db, { processor: "TSYS", period: m });
    await batch(db, { processor: "TSYS", period: m, status: "abandoned" });
    await batch(db, { processor: "Square", period: m, status: "committed" });
    await batch(db, { processor: "TSYS", period: await month(db, -2), status: "committed" });

    // Replaced: the first steps aside and a successor commits the same month.
    const second = await batch(db, { processor: "TSYS", period: m });
    await db.exec(`
      update rep_payout_batches set status = 'replaced', replaced_by_batch_id = ${second} where id = ${first};
      update rep_payout_batches set status = 'committed', replaces_batch_id = ${first} where id = ${second};
    `);
    const [{ n }] = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from rep_payout_batches where processor = 'TSYS' and period = '${m}' and status = 'committed'`,
    );
    expect(n).toBe(1);
  });

  it("leaves batches without a processor -- every batch today -- outside the rule", async () => {
    await batch(db, { status: "committed" });
    await batch(db, { status: "committed" });
    const [{ n }] = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from rep_payout_batches where processor is null and status = 'committed'`,
    );
    expect(n).toBe(2);
  });

  it("holds through the commit functions: a second batch for a committed month cannot commit", async () => {
    await seedPayouts(db);
    const m = await month(db, -1);
    for (const fn of ["commit_residual_import", "commit_residual_import_v2"]) {
      await asPlatform(db);
      await db.exec(`delete from rep_payout_batches where processor is not null`);
      const ids: number[] = [];
      for (const mid of ["MID-AGENT-1", "MID-AGENT-2"]) {
        const id = await batch(db, { processor: "PayBright", period: m });
        await db.exec(`
          insert into rep_payout_import_rows (batch_id, row_number, agent_number_raw, mid_raw, period, agent_id, volume)
          values (${id}, 2, '${AGENT_NUMBER}', '${mid}', '${m}', '${AGENT_ID}', 10.00)`);
        ids.push(id);
      }
      await asUser(db, ADMIN_ID);
      await db.query(`select ${fn}(${ids[0]})`);
      const error = await attempt(() => db.query(`select ${fn}(${ids[1]})`));
      expect(error?.message, fn).toMatch(/rep_payout_batches_one_committed_per_month/);
      await asPlatform(db);
      const [{ status }] = await rows<{ status: string }>(db, `select status from rep_payout_batches where id = ${ids[1]}`);
      expect(status, fn).toBe("review");
      await db.exec(`delete from rep_payout_rows where processor = 'PayBright'`);
    }
  });
});

describe("the 'replaced' status and the replace pair", () => {
  it("'replaced' needs replaced_by_batch_id, and replaced_by_batch_id needs 'replaced'", async () => {
    const m = await month(db, -1);
    const a = await batch(db, { processor: "TSYS", period: m, status: "committed" });
    const b = await batch(db, { processor: "TSYS", period: m });
    expect(
      (await attempt(() => db.exec(`update rep_payout_batches set status = 'replaced' where id = ${a}`)))?.message,
    ).toMatch(/rep_payout_batches_replaced_by_when_replaced/);
    expect(
      (await attempt(() => db.exec(`update rep_payout_batches set replaced_by_batch_id = ${b} where id = ${a}`)))?.message,
    ).toMatch(/rep_payout_batches_replaced_by_when_replaced/);
  });

  it("refuses a batch that points at itself, and a replace with no processor-month", async () => {
    const m = await month(db, -1);
    const a = await batch(db, { processor: "TSYS", period: m });
    expect(
      (await attempt(() => db.exec(`update rep_payout_batches set replaces_batch_id = ${a} where id = ${a}`)))?.message,
    ).toMatch(/rep_payout_batches_replace_pair_not_self/);
    const legacy = await batch(db, {});
    expect(
      (await attempt(() => db.exec(`update rep_payout_batches set replaces_batch_id = ${a} where id = ${legacy}`)))?.message,
    ).toMatch(/rep_payout_batches_replace_needs_month/);
  });

  it("a signed-in admin still cannot set 'replaced', from review or from committed", async () => {
    const m = await month(db, -1);
    const committed = await batch(db, { processor: "TSYS", period: m, status: "committed" });
    const review = await batch(db, { processor: "TSYS", period: m });
    await asUser(db, ADMIN_ID);
    for (const id of [review, committed]) {
      const error = await attempt(() =>
        db.exec(`update rep_payout_batches set status = 'replaced' where id = ${id}`),
      );
      expect(error?.code).toBe("PT409");
    }
    // Nor any of the new columns: the UPDATE grant is (status) only.
    for (const column of ["processor = 'Square'", `period = '${m}'`, `replaced_by_batch_id = ${committed}`, `replaces_batch_id = ${committed}`]) {
      const error = await attempt(() => db.exec(`update rep_payout_batches set ${column} where id = ${review}`));
      expect(error?.code, column).toBe("42501");
    }
  });
});

describe("payout_period_closures", () => {
  async function close(processor: string, period: string, as: string | null = ADMIN_ID): Promise<void> {
    // The owner, as phase 9's definer function will be, with the caller's JWT.
    await asPlatform(db);
    if (as) await db.exec(`set request.jwt.claims = '${JSON.stringify({ sub: as, role: "authenticated" })}'`);
    await db.exec(`insert into payout_period_closures (period, processor) values ('${period}', '${processor}')`);
    await asPlatform(db);
  }

  it("an admin reads every closure; a rep, a deactivated admin and anon read nothing", async () => {
    const m = await month(db, -1);
    await close("TSYS", m);
    await close("Square", m);
    await asUser(db, ADMIN_ID);
    expect(await rows(db, `select processor from payout_period_closures order by processor`)).toEqual([
      { processor: "Square" },
      { processor: "TSYS" },
    ]);
    await asUser(db, AGENT_ID);
    expect(await rows(db, `select * from payout_period_closures`)).toEqual([]);
    await asPlatform(db);
    await db.exec(`update profiles set is_active = false where id = '${ADMIN_ID}'`);
    await asUser(db, ADMIN_ID);
    expect(await rows(db, `select * from payout_period_closures`)).toEqual([]);
    await asPlatform(db);
    await db.exec(`set role anon`);
    expect((await attempt(() => db.query(`select * from payout_period_closures`)))?.code).toBe("42501");
    await asPlatform(db);
  });

  it("no client writes it, admin included: insert, update, delete and truncate are permission denied", async () => {
    const m = await month(db, -1);
    await close("TSYS", m);
    for (const user of [ADMIN_ID, AGENT_ID]) {
      await asUser(db, user);
      for (const sql of [
        `insert into payout_period_closures (period, processor) values ('${await month(db, -2)}', 'TSYS')`,
        `update payout_period_closures set closed_at = now()`,
        `delete from payout_period_closures`,
        `truncate payout_period_closures`,
      ]) {
        expect((await attempt(() => db.exec(sql)))?.code, `${user}: ${sql}`).toBe("42501");
      }
    }
    // service_role too: SELECT only. Phase 9's functions are definer.
    await asPlatform(db);
    await db.exec(`set role service_role`);
    expect(
      (await attempt(() => db.exec(`insert into payout_period_closures (period, processor) values ('${m}', 'Square')`)))?.code,
    ).toBe("42501");
    // (Read back as the owner: PGlite's service_role lacks the BYPASSRLS the
    // hosted one has, so the admin-only policy would hide the row from it.)
    await asPlatform(db);
    expect(await rows(db, `select processor from payout_period_closures`)).toEqual([{ processor: "TSYS" }]);
  });

  it("is never edited, and never closes a month that has not begun", async () => {
    const m = await month(db, -1);
    await close("TSYS", m);
    const edit = await attempt(() => db.exec(`update payout_period_closures set closed_at = now()`));
    expect(edit?.code).toBe("PT409");
    expect(edit?.message).toMatch(/not edited/);
    const future = await attempt(async () => close("TSYS", await month(db, 1)));
    expect(future?.code).toBe("PT400");
    await close("TSYS", await month(db, 0));
    expect((await attempt(() => close("TSYS", m)))?.code).toBe("23505");
    expect((await attempt(() => close("Nope", m)))?.message).toMatch(/payout_period_closures_processor_fkey/);
    expect((await attempt(async () => close("Square", (await month(db, -1)).slice(0, 8) + "02")))?.message).toMatch(
      /payout_period_closures_period_first_of_month/,
    );
  });

  it("audits a close and a reopen, naming the admin and the processor-month", async () => {
    const m = await month(db, -1);
    await close("Red Fynn", m);
    await db.exec(`set request.jwt.claims = '${JSON.stringify({ sub: ADMIN_ID, role: "authenticated" })}'`);
    await db.exec(`delete from payout_period_closures where processor = 'Red Fynn'`);
    await asPlatform(db);
    expect(await rows(db, `select actor_id, action, table_name, row_id from audit_log order by id`)).toEqual([
      { actor_id: ADMIN_ID, action: "close_payout_period", table_name: "payout_period_closures", row_id: `${m}/Red Fynn` },
      { actor_id: ADMIN_ID, action: "reopen_payout_period", table_name: "payout_period_closures", row_id: `${m}/Red Fynn` },
    ]);
  });

  it("fails closed: if the audit row cannot be written, the close and the reopen do not happen", async () => {
    const m = await month(db, -1);
    await close("TSYS", m);
    await db.exec(`alter table audit_log add constraint zz_no_closure_audit check (table_name <> 'payout_period_closures') not valid`);
    try {
      expect((await attempt(() => close("Square", m)))?.message).toMatch(/zz_no_closure_audit/);
      expect((await attempt(() => db.exec(`delete from payout_period_closures`)))?.message).toMatch(/zz_no_closure_audit/);
      expect(await rows(db, `select processor from payout_period_closures`)).toEqual([{ processor: "TSYS" }]);
    } finally {
      await asPlatform(db);
      await db.exec(`alter table audit_log drop constraint zz_no_closure_audit`);
    }
  });
});

describe("negative volume only on a marked line", () => {
  async function line(volume: string, marked: boolean, mid: string): Promise<DbError | null> {
    await asPlatform(db);
    return attempt(() =>
      db.exec(
        `insert into rep_payout_rows (agent_id, period, mid, volume, volume_confirmed_negative)
         values ('${AGENT_ID}', '2026-07-01', '${mid}', ${volume}, ${marked})`,
      ),
    );
  }

  it("refuses an unmarked negative volume and accepts a marked one", async () => {
    expect((await line("-11.76", false, "NEG-1"))?.message).toMatch(/rep_payout_rows_volume_check/);
    expect(await line("-11.76", true, "NEG-2")).toBeNull();
    expect(await line("-0.01", true, "NEG-3")).toBeNull();
  });

  it("refuses the marker on a zero, positive or NULL volume", async () => {
    for (const [volume, mid] of [["0", "M-0"], ["0.01", "M-1"], ["76877.18", "M-2"], ["null", "M-3"]]) {
      expect((await line(volume, true, mid))?.message, volume).toMatch(/rep_payout_rows_volume_check/);
    }
  });

  it("keeps zero and NULL volume allowed unmarked, and the marker defaults to false", async () => {
    expect(await line("0", false, "Z-1")).toBeNull();
    expect(await line("null", false, "Z-2")).toBeNull();
    await db.exec(`insert into rep_payout_rows (agent_id, period, mid, volume) values ('${AGENT_ID}', '2026-07-01', 'Z-3', 5)`);
    expect(await rows(db, `select volume_confirmed_negative as m from rep_payout_rows where mid = 'Z-3'`)).toEqual([{ m: false }]);
  });

  it("no client can set the marker, an admin included", async () => {
    await seedPayouts(db);
    await asUser(db, ADMIN_ID);
    const error = await attempt(() =>
      db.exec(`update rep_payout_rows set volume_confirmed_negative = true, volume = -1 where mid = 'MID-AGENT-1'`),
    );
    expect(error?.code).toBe("42501");
    const marker = await attempt(() => db.exec(`update rep_payout_rows set volume_confirmed_negative = false`));
    expect(marker?.code).toBe("42501");
  });
});

describe("the merge key carries the processor", () => {
  async function importLine(processor: string | null, mid = "KEY-1"): Promise<DbError | null> {
    await asPlatform(db);
    return attempt(() =>
      db.exec(
        `insert into rep_payout_rows (agent_id, period, mid, processor)
         values ('${AGENT_ID}', '2026-07-01', '${mid}', ${processor === null ? "null" : `'${processor}'`})`,
      ),
    );
  }

  it("refuses a second import line on (period, processor, agent, MID), naming the key", async () => {
    expect(await importLine("TSYS")).toBeNull();
    const error = await importLine("TSYS");
    expect(error?.code).toBe("23505");
    expect(error?.message).toContain("rep_payout_rows_import_merge_key");
  });

  it("still refuses two NULL-processor lines on one key (NULLS NOT DISTINCT), so today's import still merges", async () => {
    expect(await importLine(null)).toBeNull();
    expect((await importLine(null))?.message).toContain("rep_payout_rows_import_merge_key");
  });

  it("allows the same rep, MID and month under another processor", async () => {
    expect(await importLine("TSYS")).toBeNull();
    expect(await importLine("Square")).toBeNull();
    expect(await importLine(null)).toBeNull();
  });

  it("refuses a processor that is not listed", async () => {
    expect((await importLine("tsys"))?.message).toMatch(/rep_payout_rows_processor_fkey/);
  });

  it("keeps adjustment lines outside it", async () => {
    expect(await importLine("TSYS")).toBeNull();
    await db.exec(`
      insert into rep_payout_rows (agent_id, period, mid, line_kind, adjustment_amount, adjusts_period, adjustment_note)
      values ('${AGENT_ID}', '2026-07-01', 'KEY-1', 'adjustment', -5, '2026-06-01', 'x'),
             ('${AGENT_ID}', '2026-07-01', 'KEY-1', 'adjustment', -6, '2026-06-01', 'y')`);
    const [{ n }] = await rows<{ n: number }>(db, `select count(*)::int as n from rep_payout_rows where mid = 'KEY-1'`);
    expect(n).toBe(3);
  });

  it("both commit functions write the batch's processor, and re-importing it merges on the key", async () => {
    await seedPayouts(db);
    const m = await month(db, -1);
    for (const [fn, processor] of [["commit_residual_import", "Netevia HQ"], ["commit_residual_import_v2", "PayBright"]]) {
      const staged = async (volume: string, residual: string | null) => {
        const id = await batch(db, { processor, period: m });
        await db.exec(`
          insert into rep_payout_import_rows (batch_id, row_number, agent_number_raw, mid_raw, period, agent_id, volume, residual_income, rep_split_pct)
          values (${id}, 2, '${AGENT_NUMBER}', 'MID-AGENT-1', '${m}', '${AGENT_ID}', ${volume}, ${residual ?? "null"}, 50)`);
        return id;
      };
      const first = await staged("100.00", "40.00");
      await asUser(db, ADMIN_ID);
      await db.query(`select ${fn}(${first})`);
      // The same processor-month again would break the one-committed rule, so
      // the re-import is tested on the batch-less key: the first batch steps
      // aside (as phase 9's replace will) and a second commits.
      await asPlatform(db);
      const second = await staged("200.00", null);
      await db.exec(`update rep_payout_batches set status = 'replaced', replaced_by_batch_id = ${second} where id = ${first}`);
      await asUser(db, ADMIN_ID);
      await db.query(`select ${fn}(${second})`);
      await asPlatform(db);
      expect(
        await rows(db, `select processor, volume::text, residual_income::text, batch_id from rep_payout_rows where processor = '${processor}'`),
        fn,
      ).toEqual([{ processor, volume: "200.00", residual_income: "40.00", batch_id: second }]);
    }
  });

  it("v2's shared pair carries the batch's processor on both lines", async () => {
    await seedPayouts(db);
    await asPlatform(db);
    await db.exec(`
      insert into auth.users (id, email) values ('${PARTNER_ID}', 'partner@tapswipe.test');
      insert into profiles (id, full_name, role, is_active, agent_number)
      values ('${PARTNER_ID}', 'Partner Agent', 'agent', true, '5555');`);
    const m = await month(db, -1);
    await asUser(db, ADMIN_ID);
    await db.query(
      `select set_merchant_rep_share((select id from merchants where mid = 'MID-AGENT-2'),
         '${AGENT_ID}', '${PARTNER_ID}', 40, 10, '${m}')`,
    );
    const id = await batch(db, { processor: "Square", period: m });
    await db.exec(`
      insert into rep_payout_import_rows (batch_id, row_number, agent_number_raw, mid_raw, period, agent_id, merchant_id, volume)
      values (${id}, 2, '${AGENT_NUMBER}', 'MID-AGENT-2', '${m}', '${AGENT_ID}', (select id from merchants where mid = 'MID-AGENT-2'), 300.00)`);
    await asUser(db, ADMIN_ID);
    const [{ result }] = await rows<{ result: unknown }>(db, `select commit_residual_import_v2(${id}) as result`);
    expect(result).toEqual({ written: 1, skipped: 0 });
    await asPlatform(db);
    expect(
      await rows(db, `select agent_id, share_role, processor from rep_payout_rows where mid = 'MID-AGENT-2' and period = '${m}' order by share_role`),
    ).toEqual([
      { agent_id: AGENT_ID, share_role: "primary", processor: "Square" },
      { agent_id: PARTNER_ID, share_role: "secondary", processor: "Square" },
    ]);
  });
});

describe("staging: warnings and blockers", () => {
  async function stagingRow(fields: string, values: string): Promise<DbError | null> {
    await asPlatform(db);
    const id = await batch(db, {});
    return attempt(() =>
      db.exec(`insert into rep_payout_import_rows (batch_id, row_number, ${fields}) values (${id}, 2, ${values})`),
    );
  }

  it("warnings default to none and take only the three confirmable types", async () => {
    expect(await stagingRow("mid_raw", "'X'")).toBeNull();
    expect(await rows(db, `select warnings from rep_payout_import_rows`)).toEqual([{ warnings: [] }]);
    expect(
      await stagingRow("warnings", "array['processor_mismatch', 'inactive_merchant', 'bad_numbers']"),
    ).toBeNull();
    expect((await stagingRow("warnings", "array['bad_numbers', 'unknown_mid']"))?.message).toMatch(
      /rep_payout_import_rows_warnings_vocabulary/,
    );
    expect((await stagingRow("warnings", "null"))?.message).toMatch(/null value|not-null/i);
  });

  it("blockers take the six new codes and the five the deployed parser still writes, and nothing else", async () => {
    for (const code of [
      "unknown_mid", "duplicate_mid", "mid_in_other_batch", "wrong_income_type", "missing_figure", "unreadable_number",
      "unknown_agent", "unparseable_period", "bad_number", "missing_mid", "duplicate_in_file",
    ]) {
      expect(await stagingRow("blocker", `'${code}'`), code).toBeNull();
    }
    expect((await stagingRow("blocker", "'bad_numbers'"))?.message).toMatch(/rep_payout_import_rows_blocker_check/);
  });
});

// -------------------------------------------------------------------------
// 9. The migration over existing rows.
// -------------------------------------------------------------------------

describe("the migration over a populated database", () => {
  async function populated(): Promise<TestDb> {
    const target = await open(await migrationsBefore(MIGRATION));
    await resetData(target);
    await seedPayouts(target);
    await asPlatform(target);
    // A committed, an abandoned and a review batch, adjustment and shared
    // lines: every shape the ledger holds today.
    await target.exec(`
      insert into rep_payout_batches (imported_by, file_key, file_name, status)
      values ('${ADMIN_ID}', 'old/a.xlsx', 'a.xlsx', 'abandoned');
      insert into rep_payout_rows (agent_id, period, mid, line_kind, adjustment_amount, adjusts_period, adjustment_note)
      values ('${OTHER_AGENT_ID}', '2026-07-01', 'MID-OTHER-1', 'adjustment', 3.50, '2026-06-01', 'old');
      insert into rep_payout_rows (agent_id, period, mid, volume) values ('${AGENT_ID}', '2026-05-01', 'ZERO', 0);`);
    return target;
  }

  const snapshot = async (target: TestDb) => {
    await asPlatform(target);
    return {
      ledger: await rows(target, `select to_jsonb(r) - 'processor' - 'volume_confirmed_negative' as j from rep_payout_rows r order by id`),
      batches: await rows(
        target,
        `select to_jsonb(b) - 'processor' - 'period' - 'replaces_batch_id' - 'replaced_by_batch_id' as j from rep_payout_batches b order by id`,
      ),
      staging: await rows(target, `select to_jsonb(s) - 'warnings' as j from rep_payout_import_rows s order by id`),
    };
  };

  it("applies, and every existing batch, staged row and ledger line comes out unchanged", async () => {
    const target = await populated();
    const before = await snapshot(target);
    expect(before.ledger.length).toBeGreaterThan(4);
    await target.exec(await readMigration(MIGRATION));
    expect(await snapshot(target)).toEqual(before);
    expect(
      await rows(
        target,
        `select count(*)::int as n from rep_payout_rows where processor is not null or volume_confirmed_negative`,
      ),
    ).toEqual([{ n: 0 }]);
    expect(
      await rows(target, `select count(*)::int as n from rep_payout_batches where processor is not null or period is not null`),
    ).toEqual([{ n: 0 }]);
  });

  it("refuses a ledger line with a negative volume, naming it, and changes nothing", async () => {
    const target = await populated();
    // A project whose volume CHECK was dropped by hand, then a negative written.
    await target.exec(`
      alter table rep_payout_rows drop constraint rep_payout_rows_volume_check;
      insert into rep_payout_rows (agent_id, period, mid, volume) values ('${AGENT_ID}', '2026-04-01', 'NEG', -1);`);
    const [{ id }] = await rows<{ id: number }>(target, `select id from rep_payout_rows where mid = 'NEG'`);
    const before = await snapshot(target);
    const error = await attempt(async () => target.exec(await readMigration(MIGRATION)));
    expect(error?.message).toContain(`rep_payout_rows line(s) ${id} have a negative volume`);
    expect(await snapshot(target)).toEqual(before);
    expect(
      await rows(target, `select count(*)::int as n from information_schema.tables where table_name = 'payout_period_closures'`),
    ).toEqual([{ n: 0 }]);
  });

  it("refuses when a definition it replaces is not the one it expects", async () => {
    for (const [label, alter, found] of [
      ["merge key", `drop index rep_payout_rows_import_merge_key;
        create unique index rep_payout_rows_import_merge_key on rep_payout_rows (period, mid) where line_kind = 'import';`, /rep_payout_rows_import_merge_key is not/],
      ["status", `alter table rep_payout_batches drop constraint rep_payout_batches_status_check;`, /no such constraint/],
      ["blocker", `alter table rep_payout_import_rows drop constraint rep_payout_import_rows_blocker_check;
        alter table rep_payout_import_rows add constraint rep_payout_import_rows_blocker_check check (blocker <> 'x');`, /rep_payout_import_rows_blocker_check is not/],
      ["volume", `alter table rep_payout_rows drop constraint rep_payout_rows_volume_check;
        alter table rep_payout_rows add constraint rep_payout_rows_volume_check check (volume > -100);`, /rep_payout_rows_volume_check is not/],
    ] as const) {
      const target = await populated();
      await target.exec(alter);
      const error = await attempt(async () => target.exec(await readMigration(MIGRATION)));
      expect(error?.message, label).toMatch(found);
      await target.close();
      opened.splice(opened.indexOf(target), 1);
    }
  }, 240_000);
});
