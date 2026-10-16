import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_ID,
  AGENT_ID,
  AGENT_NUMBER,
  OTHER_AGENT_ID,
  PAYOUT_PERIOD,
  PAYOUT_PERIOD_PRIOR,
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
 * 20261016160000: the ledger's merge key becomes the partial unique index
 * rep_payout_rows_import_merge_key, `(period, agent_id, mid) where line_kind =
 * 'import'`, and rep_payout_rows_import_lines_only goes with it (phase 5 of
 * docs/design/residual-splits.md). This file is the proof that:
 *
 *   1. the catalog changes in exactly the intended ways and no other -- every
 *      index and constraint in the schema, every function body (five
 *      re-created, each differing from its predecessor by exactly the intended
 *      text), every policy, trigger, privilege and column;
 *   2. the migration's own check refuses a swap that moved anything: a row
 *      lost, a payout changed, two MIDs swapped with count and total intact;
 *   3. an import never merges into an adjustment line and an adjustment is
 *      never merged into an import line, through every writer;
 *   4. an adjustment never makes a month look committed -- not to v2's plan,
 *      not to the share RPCs.
 *
 * The comparison of v2 before and after this migration on unshared batches is
 * in commit-residual-import-v2.test.ts ("pre-phase-5 v2"), next to the other
 * comparisons. post_share_correction() is in share-corrections.test.ts.
 */

const MIGRATION = "20261016160000_import_merge_key.sql";
const AUG = "2026-08-01";
const PARTNER_ID = "55555555-5555-5555-5555-555555555555";

type Json = Record<string, unknown>;
type DbError = { code?: string; message: string };

const opened: TestDb[] = [];
afterAll(async () => {
  await Promise.all(opened.map((db) => db.close()));
});

async function open(files?: string[]): Promise<TestDb> {
  const db = await createTestDb(files);
  opened.push(db);
  return db;
}

async function attempt(fn: () => Promise<unknown>): Promise<DbError | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error as DbError;
  }
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

  async function catalog(db: TestDb) {
    await asPlatform(db);
    return {
      indexes: await rows<{ name: string; def: string }>(
        db,
        `select indexname as name, indexdef as def from pg_indexes
          where schemaname = 'public' order by indexname`,
      ),
      constraints: await rows<{ name: string; tbl: string; def: string }>(
        db,
        `select c.conname as name, c.conrelid::regclass::text as tbl,
                pg_get_constraintdef(c.oid) as def
           from pg_constraint c
           join pg_namespace n on n.oid = c.connamespace
          where n.nspname = 'public'
          order by c.conrelid::regclass::text, c.conname`,
      ),
      functions: await rows<{ sig: string; body: string; definer: boolean; config: string | null; acl: string | null }>(
        db,
        `select p.oid::regprocedure::text as sig, p.prosrc as body,
                p.prosecdef as definer, p.proconfig::text as config,
                p.proacl::text as acl
           from pg_proc p where p.pronamespace = 'public'::regnamespace
          order by 1`,
      ),
      policies: await rows(
        db,
        `select tablename, policyname, permissive, roles::text, cmd, qual, with_check
           from pg_policies where schemaname = 'public' order by tablename, policyname`,
      ),
      triggers: await rows(
        db,
        `select tgrelid::regclass::text as tbl, tgname, pg_get_triggerdef(oid) as def
           from pg_trigger
          where not tgisinternal
            and tgrelid in (select oid from pg_class
                             where relnamespace = 'public'::regnamespace)
          order by 1, 2`,
      ),
      columns: await rows(
        db,
        `select table_name, column_name, data_type, numeric_precision,
                numeric_scale, is_nullable, column_default, is_generated,
                generation_expression
           from information_schema.columns
          where table_schema = 'public' order by table_name, column_name`,
      ),
      tablePrivileges: await rows(
        db,
        `select table_name, grantee, privilege_type
           from information_schema.table_privileges
          where table_schema = 'public' order by 1, 2, 3`,
      ),
      columnPrivileges: await rows(
        db,
        `select table_name, column_name, grantee, privilege_type
           from information_schema.column_privileges
          where table_schema = 'public' order by 1, 2, 3, 4`,
      ),
    };
  }

  const names = <T extends { name: string }>(list: T[]) => list.map((x) => x.name);
  const minus = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));

  it("drops one index and adds two, and leaves every other index in the schema untouched", async () => {
    const b = await catalog(before);
    const a = await catalog(after);

    expect(minus(names(b.indexes), names(a.indexes))).toEqual([
      "rep_payout_rows_period_agent_id_mid_key",
    ]);
    expect(a.indexes.filter((i) => !names(b.indexes).includes(i.name))).toEqual([
      {
        name: "idx_rep_payout_rows_period_agent",
        def: "CREATE INDEX idx_rep_payout_rows_period_agent ON public.rep_payout_rows USING btree (period, agent_id)",
      },
      {
        name: "rep_payout_rows_import_merge_key",
        def: "CREATE UNIQUE INDEX rep_payout_rows_import_merge_key ON public.rep_payout_rows USING btree (period, agent_id, mid) WHERE (line_kind = 'import'::text)",
      },
    ]);
    const kept = names(b.indexes).filter((n) => names(a.indexes).includes(n));
    expect(a.indexes.filter((i) => kept.includes(i.name))).toEqual(
      b.indexes.filter((i) => kept.includes(i.name)),
    );
  });

  it("drops two constraints and adds one, and leaves every other constraint in the schema untouched", async () => {
    const b = await catalog(before);
    const a = await catalog(after);
    const key = (c: { tbl: string; name: string }) => `${c.tbl}.${c.name}`;

    expect(
      b.constraints.filter((c) => !a.constraints.some((x) => key(x) === key(c))).map(key),
    ).toEqual([
      "rep_payout_rows.rep_payout_rows_import_lines_only",
      "rep_payout_rows.rep_payout_rows_period_agent_id_mid_key",
    ]);
    const added = a.constraints.filter((c) => !b.constraints.some((x) => key(x) === key(c)));
    expect(added.map(key)).toEqual(["rep_payout_rows.rep_payout_rows_adjustment_no_figures"]);
    expect(added[0].def).toBe(
      "CHECK (((line_kind = 'import'::text) OR ((residual_income IS NULL) AND (rep_split_pct IS NULL) AND (volume IS NULL) AND (average_ticket IS NULL) AND (total_cost IS NULL) AND (batch_id IS NULL))))",
    );
    const kept = b.constraints.filter((c) => a.constraints.some((x) => key(x) === key(c)));
    expect(a.constraints.filter((c) => kept.some((x) => key(x) === key(c)))).toEqual(kept);
  });

  it("re-creates exactly five functions, each differing from before by exactly the intended text", async () => {
    const b = await catalog(before);
    const a = await catalog(after);
    expect(a.functions.map((f) => f.sig)).toEqual(b.functions.map((f) => f.sig));

    const changed = a.functions
      .filter((f) => b.functions.find((x) => x.sig === f.sig)?.body !== f.body)
      .map((f) => f.sig);
    expect(changed.sort()).toEqual([
      "cancel_merchant_rep_share(integer)",
      "commit_residual_import(integer)",
      "commit_residual_import_v2(integer)",
      "end_merchant_rep_share(integer,date)",
      "set_merchant_rep_share(integer,uuid,uuid,numeric,numeric,date)",
    ]);

    const PRED = (s: string) =>
      s.split("on conflict (period, agent_id, mid) do").join(
        "on conflict (period, agent_id, mid) where line_kind = 'import' do",
      );
    const SHARE = (s: string) =>
      s.split("   where merchant_id = m.id or mid = m.mid;").join(
        "   where (merchant_id = m.id or mid = m.mid)\n     and line_kind = 'import';",
      );
    const PLAN = (s: string) =>
      s.replace(
        "                and l.mid = r.mid_raw\n",
        "                and l.mid = r.mid_raw\n                and l.line_kind = 'import'\n",
      );
    const expected: Record<string, (s: string) => string> = {
      "commit_residual_import(integer)": PRED,
      "commit_residual_import_v2(integer)": (s) => PLAN(PRED(s)),
      "set_merchant_rep_share(integer,uuid,uuid,numeric,numeric,date)": SHARE,
      "end_merchant_rep_share(integer,date)": SHARE,
      "cancel_merchant_rep_share(integer)": SHARE,
    };
    for (const sig of changed) {
      const old = b.functions.find((f) => f.sig === sig)!;
      const now = a.functions.find((f) => f.sig === sig)!;
      expect(now.body, sig).toBe(expected[sig](old.body));
      // Not a no-op rewrite: the text really did change.
      expect(now.body, sig).not.toBe(old.body);
      expect([now.definer, now.config, now.acl], sig).toEqual([old.definer, old.config, old.acl]);
    }
    // v2's three targets and the old function's one.
    expect(a.functions.find((f) => f.sig === "commit_residual_import_v2(integer)")!.body.split(
      "where line_kind = 'import' do",
    ).length - 1).toBe(3);
  });

  it("leaves every policy, trigger, column and privilege in the schema identical", async () => {
    const b = await catalog(before);
    const a = await catalog(after);
    expect(a.policies).toEqual(b.policies);
    expect(a.triggers).toEqual(b.triggers);
    expect(a.columns).toEqual(b.columns);
    expect(a.tablePrivileges).toEqual(b.tablePrivileges);
    expect(a.columnPrivileges).toEqual(b.columnPrivileges);
  });

  it("leaves no copy of the ledger behind", async () => {
    await asPlatform(after);
    expect(
      await rows(after, `select relname from pg_class where relname = 'rep_payout_merge_key_before'`),
    ).toEqual([]);
  });
});

// -------------------------------------------------------------------------
// 2. The migration refuses a swap that moved anything
// -------------------------------------------------------------------------

describe("the migration proves nothing moved, and refuses when something did", () => {
  const MARKER = "-- 9. Nothing moved, to the cent and to the key, or nothing commits.";

  type Ledger = { n: number; total: string | null; values: string[] };

  async function ledger(db: TestDb): Promise<Ledger> {
    await asPlatform(db);
    const values = await rows<{ v: string }>(
      db,
      `select id || ':' || coalesce(rep_payout::text, 'null') || ':' || period || ':' ||
              agent_id || ':' || mid as v
         from rep_payout_rows order by id`,
    );
    const [{ total }] = await rows<{ total: string | null }>(
      db,
      `select sum(rep_payout)::text as total from rep_payout_rows`,
    );
    return { n: values.length, total, values: values.map((r) => r.v) };
  }

  async function seeded(): Promise<{ db: TestDb; before: Ledger }> {
    const db = await open(await migrationsBefore(MIGRATION));
    await resetData(db);
    await seedPayouts(db);
    await asPlatform(db);
    // Shapes worth carrying across: negatives, a half-cent tie, NULLs, two
    // reps on one MID, many months.
    await db.exec(`
      insert into rep_payout_rows (agent_id, period, mid, residual_income, rep_split_pct)
      select case when g % 2 = 0 then '${AGENT_ID}'::uuid else '${OTHER_AGENT_ID}'::uuid end,
             make_date(2025, 1 + (g % 12), 1), 'KEY-' || (g / 2),
             case when g % 7 = 0 then null else (g - 500) * 0.01 end,
             case when g % 5 = 0 then null else 50.00 end
        from generate_series(1, 1000) as g;
    `);
    return { db, before: await ledger(db) };
  }

  async function expectRolledBack(db: TestDb, before: Ledger) {
    await asPlatform(db);
    const [{ old_key, guard, new_key }] = await rows<{ old_key: number; guard: number; new_key: number }>(
      db,
      `select
         (select count(*)::int from pg_constraint where conname = 'rep_payout_rows_period_agent_id_mid_key') as old_key,
         (select count(*)::int from pg_constraint where conname = 'rep_payout_rows_import_lines_only') as guard,
         (select count(*)::int from pg_indexes where indexname = 'rep_payout_rows_import_merge_key') as new_key`,
    );
    expect({ old_key, guard, new_key }).toEqual({ old_key: 1, guard: 1, new_key: 0 });
    expect(await ledger(db)).toEqual(before);
  }

  async function broken(inject: string): Promise<string> {
    const sql = await readMigration(MIGRATION);
    expect(sql).toContain(MARKER);
    return sql.replace(MARKER, `${inject}\n\n${MARKER}`);
  }

  it("applies over a populated ledger and every line comes out identical", async () => {
    const { db, before } = await seeded();
    expect(before.n).toBe(1004);
    await asPlatform(db);
    await db.exec(await readMigration(MIGRATION));
    expect(await ledger(db)).toEqual(before);
  });

  it("refuses a lost row", async () => {
    const { db, before } = await seeded();
    const sql = await broken(`delete from rep_payout_rows where id = (select max(id) from rep_payout_rows);`);
    const error = await attempt(() => db.exec(sql));
    expect(error?.message).toMatch(
      /merge key swap changed existing lines \(rows 1004 -> 1003, total (matches|DIFFERS), per-row checksum DIFFERS\); rolled back/,
    );
    await expectRolledBack(db, before);
  });

  it("refuses a changed payout", async () => {
    const { db, before } = await seeded();
    const sql = await broken(
      `update rep_payout_rows set residual_income = residual_income + 1
        where id = (select min(id) from rep_payout_rows
                     where residual_income is not null and rep_split_pct is not null);`,
    );
    const error = await attempt(() => db.exec(sql));
    expect(error?.message).toMatch(/rows 1004 -> 1004, total DIFFERS, per-row checksum DIFFERS/);
    await expectRolledBack(db, before);
  });

  it("refuses two MIDs swapped, which the count and the total cannot see", async () => {
    const { db, before } = await seeded();
    const sql = await broken(`
      update rep_payout_rows r
         set mid = case r.mid when 'KEY-10' then 'KEY-11' else 'KEY-10' end
       where r.agent_id = '${AGENT_ID}' and r.mid in ('KEY-10', 'KEY-11');`);
    const error = await attempt(() => db.exec(sql));
    expect(error?.message).toMatch(/rows 1004 -> 1004, total matches, per-row checksum DIFFERS/);
    await expectRolledBack(db, before);
  });

  it("refuses to drop a merge key that is not the one it expects", async () => {
    const { db, before } = await seeded();
    await asPlatform(db);
    await db.exec(`
      alter table rep_payout_rows drop constraint rep_payout_rows_period_agent_id_mid_key;
      alter table rep_payout_rows add constraint rep_payout_rows_period_agent_id_mid_key
        unique (agent_id, period, mid);
    `);
    const sql = await readMigration(MIGRATION);
    const error = await attempt(() => db.exec(sql));
    expect(error?.message).toMatch(/is not UNIQUE \(period, agent_id, mid\) here \(found: UNIQUE \(agent_id, period, mid\)\)/);
    expect(await ledger(db)).toEqual(before);
    // The hand-altered key survives, and nothing of the migration applied.
    const [{ guard, new_key }] = await rows<{ guard: number; new_key: number }>(
      db,
      `select
         (select count(*)::int from pg_constraint where conname = 'rep_payout_rows_import_lines_only') as guard,
         (select count(*)::int from pg_indexes where indexname = 'rep_payout_rows_import_merge_key') as new_key`,
    );
    expect({ guard, new_key }).toEqual({ guard: 1, new_key: 0 });
  });
});

// -------------------------------------------------------------------------
// 3-4. Import lines and adjustment lines never meet
// -------------------------------------------------------------------------

describe("an import never merges into an adjustment, and an adjustment never into an import", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await open();
  });

  beforeEach(async () => {
    await resetData(db);
    await seedPayouts(db);
    await asPlatform(db);
    await db.exec(`
      delete from rep_payout_import_rows;
      insert into auth.users (id, email) values ('${PARTNER_ID}', 'partner@tapswipe.test');
      insert into profiles (id, full_name, role, is_active, agent_number)
        values ('${PARTNER_ID}', 'Partner Agent', 'agent', true, '5555');
    `);
  });

  const LINE = `to_jsonb(r) - 'updated_at' - 'created_at'`;

  async function lines(where: string): Promise<Json[]> {
    await asPlatform(db);
    return (
      await rows<{ j: Json }>(db, `select ${LINE} as j from rep_payout_rows r where ${where} order by id`)
    ).map((r) => r.j);
  }

  async function adjustment(agentId: string, period: string, mid: string, amount: string): Promise<number> {
    await asPlatform(db);
    const [{ id }] = await rows<{ id: number }>(
      db,
      `insert into rep_payout_rows (agent_id, period, mid, merchant_name, line_kind,
         adjustment_amount, adjusts_period, adjustment_note)
       values ('${agentId}', '${period}', '${mid}', 'Adjusted Co', 'adjustment',
               ${amount}, '${PAYOUT_PERIOD_PRIOR}', 'agreed later')
       returning id`,
    );
    return id;
  }

  async function stage(
    staged: { agentId: string; agentNumber: string; mid: string; period: string; volume: string; residual?: string; split?: string }[],
  ): Promise<number> {
    await asPlatform(db);
    const [{ id }] = await rows<{ id: number }>(
      db,
      `insert into rep_payout_batches (imported_by, file_key, file_name, status)
       values ('${ADMIN_ID}', 'test/f.xlsx', 'f.xlsx', 'review') returning id`,
    );
    for (const [index, r] of staged.entries()) {
      await db.exec(`
        insert into rep_payout_import_rows
          (batch_id, row_number, agent_number_raw, mid_raw, merchant_name_raw, period,
           agent_id, merchant_id, volume, residual_income, rep_split_pct)
        values (${id}, ${index + 2}, '${r.agentNumber}', '${r.mid}', 'File Co', '${r.period}',
                '${r.agentId}', (select id from merchants where mid = '${r.mid}'), ${r.volume},
                ${r.residual ?? "null"}, ${r.split ?? "null"});`);
    }
    return id;
  }

  async function commit(fn: "commit_residual_import" | "commit_residual_import_v2", batch: number): Promise<unknown> {
    await asUser(db, ADMIN_ID);
    try {
      const [{ r }] = await rows<{ r: unknown }>(db, `select ${fn}(${batch}) as r`);
      return r;
    } finally {
      await asPlatform(db);
    }
  }

  it.each(["commit_residual_import", "commit_residual_import_v2"] as const)(
    "%s: importing a key that holds only an adjustment inserts a new import line beside it, twice over",
    async (fn) => {
      const adj = await adjustment(AGENT_ID, AUG, "MID-AGENT-1", "12.34");
      const adjBefore = await lines(`id = ${adj}`);

      const first = await stage([
        { agentId: AGENT_ID, agentNumber: AGENT_NUMBER, mid: "MID-AGENT-1", period: AUG, volume: "100.00", residual: "40.00", split: "50.00" },
      ]);
      await commit(fn, first);
      const second = await stage([
        { agentId: AGENT_ID, agentNumber: AGENT_NUMBER, mid: "MID-AGENT-1", period: AUG, volume: "200.00", residual: "60.00" },
      ]);
      await commit(fn, second);

      const onKey = await lines(`period = '${AUG}' and agent_id = '${AGENT_ID}' and mid = 'MID-AGENT-1'`);
      expect(onKey).toHaveLength(2);
      // The adjustment, byte-identical through both commits.
      expect(onKey.find((l) => l.id === adj)).toEqual(adjBefore[0]);
      // The import line took both commits, merged by THE COALESCE as always.
      expect(onKey.find((l) => l.id !== adj)).toMatchObject({
        line_kind: "import",
        volume: 200,
        residual_income: 60,
        rep_split_pct: 50,
        rep_payout: 30,
        adjustment_amount: null,
      });
    },
  );

  it("an adjustment on a key that holds an import line is a second line, even through an upsert naming the merge key", async () => {
    const [importBefore] = await lines(`period = '${PAYOUT_PERIOD}' and agent_id = '${AGENT_ID}' and mid = 'MID-AGENT-1'`);

    const direct = await adjustment(AGENT_ID, PAYOUT_PERIOD, "MID-AGENT-1", "5.00");
    await asPlatform(db);
    await db.exec(`
      insert into rep_payout_rows (agent_id, period, mid, line_kind,
        adjustment_amount, adjusts_period, adjustment_note)
      values ('${AGENT_ID}', '${PAYOUT_PERIOD}', 'MID-AGENT-1', 'adjustment', -5.00, '${PAYOUT_PERIOD_PRIOR}', 'x')
      on conflict (period, agent_id, mid) where line_kind = 'import' do update
        set adjustment_amount = excluded.adjustment_amount;
    `);

    const onKey = await lines(`period = '${PAYOUT_PERIOD}' and agent_id = '${AGENT_ID}' and mid = 'MID-AGENT-1'`);
    expect(onKey.map((l) => l.line_kind)).toEqual(["import", "adjustment", "adjustment"]);
    expect(onKey[0]).toEqual(importBefore);
    expect(onKey.find((l) => l.id === direct)?.rep_payout).toBe(5);
  });

  it("still refuses a second IMPORT line on a key, naming the merge key", async () => {
    await asPlatform(db);
    const error = await attempt(() =>
      db.exec(`insert into rep_payout_rows (agent_id, period, mid)
               values ('${AGENT_ID}', '${PAYOUT_PERIOD}', 'MID-AGENT-1')`),
    );
    expect(error?.code).toBe("23505");
    expect(error?.message).toContain("rep_payout_rows_import_merge_key");
  });

  it("v2 builds the shared pair in a month where adjustments sit on both keys of the pair", async () => {
    // A share from August on MID-AGENT-2, with a correction pair already
    // posted into August on the signer's and the partner's keys.
    await asUser(db, ADMIN_ID);
    const [{ id: shareId }] = await rows<{ id: number }>(
      db,
      `select set_merchant_rep_share((select id from merchants where mid = 'MID-AGENT-2'),
         '${AGENT_ID}', '${PARTNER_ID}', 40, 10, '${AUG}') as id`,
    );
    const signerAdj = await adjustment(AGENT_ID, AUG, "MID-AGENT-2", "-2.00");
    const partnerAdj = await adjustment(PARTNER_ID, AUG, "MID-AGENT-2", "2.00");
    const adjBefore = await lines(`id in (${signerAdj}, ${partnerAdj})`);

    const batch = await stage([
      { agentId: AGENT_ID, agentNumber: AGENT_NUMBER, mid: "MID-AGENT-2", period: AUG, volume: "500.00" },
    ]);
    expect(await commit("commit_residual_import_v2", batch)).toEqual({ written: 1, skipped: 0 });

    const pair = await lines(`rep_share_id = ${shareId}`);
    expect(pair.map((l) => [l.agent_id, l.share_role])).toEqual([
      [AGENT_ID, "primary"],
      [PARTNER_ID, "secondary"],
    ]);
    expect(await lines(`id in (${signerAdj}, ${partnerAdj})`)).toEqual(adjBefore);
  });

  it("a share can start, end and be cancelled in a month that holds only adjustments", async () => {
    await adjustment(AGENT_ID, AUG, "MID-AGENT-1", "1.00");
    await asUser(db, ADMIN_ID);
    const set = await attempt(() =>
      db.query(`select set_merchant_rep_share((select id from merchants where mid = 'MID-AGENT-1'),
                  '${AGENT_ID}', '${PARTNER_ID}', 25, 25, '${AUG}')`),
    );
    expect(set).toBeNull();
    const [{ id }] = await rows<{ id: number }>(
      db,
      `select id from merchant_rep_shares where merchant_id = (select id from merchants where mid = 'MID-AGENT-1')`,
    );
    expect(await attempt(() => db.query(`select end_merchant_rep_share(${id}, '2026-09-01')`))).toBeNull();
    expect(await attempt(() => db.query(`select cancel_merchant_rep_share(${id})`))).toBeNull();

    // And July, which holds an import line, is still committed to them.
    const july = await attempt(() =>
      db.query(`select set_merchant_rep_share((select id from merchants where mid = 'MID-AGENT-1'),
                  '${AGENT_ID}', '${PARTNER_ID}', 25, 25, '${PAYOUT_PERIOD}')`),
    );
    expect(july?.message).toMatch(/July 2026 is already committed for this MID/);
    await asPlatform(db);
  });
});
