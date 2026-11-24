import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_ID,
  AGENT_ID,
  OTHER_AGENT_ID,
  asPlatform,
  asUser,
  commitV3,
  createTestDb,
  hasColumn,
  insertBatch,
  migrationsBefore,
  readMigration,
  resetData,
  rows,
  stageForCommit,
  type TestDb,
} from "../helpers/db";

/**
 * 20261102140000, lock residuals -- phase 11 of
 * docs/design/intake-and-reports.md (§0.5, A7). What this file pins:
 *
 *   1. The catalog: no UPDATE privilege on rep_payout_rows for anon or
 *      authenticated, at the table or on any column; no UPDATE policy; the
 *      service role keeps its privileges; the guard trigger is attached and no
 *      client may call its function.
 *   2. Every client role -- a rep, the recipient of an override, an admin,
 *      anon -- is refused any update of every kind of line (import, shared,
 *      override, adjustment), and nothing changes.
 *   3. Two layers, each shown to refuse alone (mutation proofs): the missing
 *      grant, and the guard trigger behind it.
 *   4. The fixes that remain still work: a REPLACE before the month is paid,
 *      and an ADJUSTMENT after.
 *   5. set_shared_residual is gone.
 *   6. The migration over a populated database: it changes no line, and it
 *      refuses, by name, a schema missing what it removes.
 */

const MIGRATION = "20261102140000_lock_residuals.sql";
const RECIPIENT_ID = "44444444-4444-4444-4444-444444444444";
const PROCESSOR = "TSYS";

type DbError = { code?: string; message: string };

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

/** Runs `sql` as a client role: a user id, or anon. */
async function asClient(target: TestDb, who: string | "anon", sql: string): Promise<DbError | null> {
  if (who === "anon") {
    await asUser(target, null);
    await target.exec(`set role anon`);
  } else {
    await asUser(target, who);
  }
  try {
    return await attempt(() => target.query(sql));
  } finally {
    await asPlatform(target);
  }
}

/** A month committed through v3 with one ordinary, one shared and one overridden merchant. */
async function committedMonth(target: TestDb): Promise<{ batch: number; period: string }> {
  await asPlatform(target);
  await target.exec(`
    insert into auth.users (id, email) values ('${RECIPIENT_ID}', 'dana@tapswipe.test');
    insert into profiles (id, full_name, role, is_active, email)
    values ('${RECIPIENT_ID}', 'Dana Cole', 'agent', true, 'dana@tapswipe.test');
    insert into merchants (agent_id, mid, dba, status, processor, split_agent_pct, split_company_pct, city, state)
    values ('${AGENT_ID}', 'LK-PLAIN', 'Plain Co', 'active', '${PROCESSOR}', 50, 50, 'Nashville', 'TN'),
           ('${AGENT_ID}', 'LK-SHARED', 'Shared Co', 'active', '${PROCESSOR}', 50, 50, 'Nashville', 'TN'),
           ('${AGENT_ID}', 'LK-OVR', 'Override Co', 'active', '${PROCESSOR}', 50, 50, 'Nashville', 'TN');`);
  const batch = await insertBatch(target);
  const [{ period }] = await rows<{ period: string }>(
    target,
    `select period::text as period from rep_payout_batches where id = ${batch}`,
  );
  // funded_by exists from 20261116120000; this fixture also seeds a database
  // replayed to before it, where the override is owner-funded by definition.
  const funded = await hasColumn(target, "merchant_overrides", "funded_by");
  await target.exec(`
    insert into merchant_rep_shares (merchant_id, primary_agent_id, secondary_agent_id,
                                     primary_rep_pct, secondary_rep_pct, effective_from)
    values ((select id from merchants where mid = 'LK-SHARED'), '${AGENT_ID}', '${OTHER_AGENT_ID}', 40, 10, '${period}');
    insert into merchant_overrides (merchant_id, recipient_id, override_pct, effective_from${funded ? ", funded_by" : ""})
    values ((select id from merchants where mid = 'LK-OVR'), '${RECIPIENT_ID}', 10, '${period}'${funded ? ", 'owner'" : ""});`);
  await stageForCommit(target, batch, [{ mid: "LK-PLAIN" }, { mid: "LK-SHARED" }, { mid: "LK-OVR" }]);
  await commitV3(target, batch);
  await target.exec(`delete from audit_log; delete from rep_payout_row_history;`);
  return { batch, period };
}

async function ledger(target: TestDb): Promise<unknown[]> {
  await asPlatform(target);
  return rows(target, `select to_jsonb(r) - 'updated_at' as j from rep_payout_rows r order by id`);
}

let db: TestDb;

beforeAll(async () => {
  db = await open();
});

beforeEach(async () => {
  await resetData(db);
  await asPlatform(db);
});

// -------------------------------------------------------------------------
// 1. The catalog
// -------------------------------------------------------------------------

describe("the catalog", () => {
  it("anon and authenticated hold no UPDATE on rep_payout_rows, at the table or on any column", async () => {
    for (const role of ["anon", "authenticated"]) {
      expect(
        await rows(db, `select has_table_privilege('${role}', 'rep_payout_rows', 'UPDATE') as ok`),
        role,
      ).toEqual([{ ok: false }]);
      const columns = await rows<{ name: string }>(
        db,
        `select attname as name from pg_attribute
          where attrelid = 'rep_payout_rows'::regclass and attnum > 0 and not attisdropped
            and has_column_privilege('${role}', 'rep_payout_rows', attname, 'UPDATE')`,
      );
      expect(columns, role).toEqual([]);
    }
    // The service role keeps it: the teardowns detach lines from a batch they delete.
    expect(
      await rows(db, `select has_table_privilege('service_role', 'rep_payout_rows', 'UPDATE') as ok`),
    ).toEqual([{ ok: true }]);
  });

  it("has no UPDATE policy (nor ALL)", async () => {
    expect(
      await rows(db, `select polname, polcmd from pg_policy
                       where polrelid = 'public.rep_payout_rows'::regclass order by polname`),
    ).toEqual([{ polname: "select own or admin", polcmd: "r" }]);
  });

  it("the guard trigger is attached BEFORE UPDATE, and no client may call its function", async () => {
    expect(
      await rows(db, `select tgname from pg_trigger
                       where tgrelid = 'public.rep_payout_rows'::regclass
                         and tgname = 'rep_payout_rows_guard_client_update'
                         and tgtype & 2 = 2 and tgtype & 16 = 16`),
    ).toEqual([{ tgname: "rep_payout_rows_guard_client_update" }]);
    for (const role of ["anon", "authenticated"]) {
      expect(
        await rows(db, `select has_function_privilege('${role}', 'guard_client_payout_update()', 'execute') as ok`),
      ).toEqual([{ ok: false }]);
    }
  });

  it("set_shared_residual is gone", async () => {
    expect(
      await rows(db, `select to_regprocedure('set_shared_residual(int, date, numeric)') as fn`),
    ).toEqual([{ fn: null }]);
  });
});

// -------------------------------------------------------------------------
// 2. Every client role refused, on every kind of line
// -------------------------------------------------------------------------

describe("every client role is refused any update of a payout line", () => {
  it("a rep, the override's recipient, an admin and anon: on import, shared, override and adjustment lines", async () => {
    await committedMonth(db);
    await db.exec(`
      insert into rep_payout_rows (agent_id, period, mid, line_kind, adjustment_amount, adjusts_period, adjustment_note)
      values ('${AGENT_ID}', '2030-01-01', 'LK-PLAIN', 'adjustment', -1.00, '2029-12-01', 'x');`);
    const kinds = await rows<{ id: number; kind: string }>(
      db,
      `select min(id) as id,
              case when share_role is not null then 'shared'
                   else line_kind end as kind
         from rep_payout_rows group by 2 order by 2`,
    );
    expect(kinds.map((k) => k.kind)).toEqual(["adjustment", "import", "override", "shared"]);
    const before = await ledger(db);

    for (const who of [AGENT_ID, OTHER_AGENT_ID, RECIPIENT_ID, ADMIN_ID, "anon"] as const) {
      for (const { id, kind } of kinds) {
        for (const set of ["residual_income = residual_income", "rep_split_pct = 1", "merchant_name = 'x'"]) {
          const error = await asClient(db, who, `update rep_payout_rows set ${set} where id = ${id}`);
          expect(error?.code, `${who} ${kind} ${set}`).toBe("42501");
          expect(error?.message).toMatch(/permission denied for table rep_payout_rows/);
        }
      }
    }
    expect(await ledger(db)).toEqual(before);
    expect(await rows(db, `select count(*)::int as n from rep_payout_row_history`)).toEqual([{ n: 0 }]);
  });

  it("an owner-side write -- what a definer function or the service role does -- is not refused by the guard", async () => {
    const { batch } = await committedMonth(db);
    await asPlatform(db);
    // The teardowns' detach, as the service role (and the owner) runs it.
    const result = await db.query(
      `update rep_payout_rows set batch_id = null where batch_id = ${batch} and line_kind = 'import'`,
    );
    expect(result.affectedRows).toBeGreaterThan(0);
  });
});

// -------------------------------------------------------------------------
// 3. Two layers, each refusing alone
// -------------------------------------------------------------------------

describe("mutation proofs: the grant and the trigger each refuse alone", () => {
  let mutant: TestDb;

  beforeAll(async () => {
    mutant = await open();
  });

  beforeEach(async () => {
    await resetData(mutant);
    await asPlatform(mutant);
  });

  const edit = (target: TestDb) =>
    asClient(target, ADMIN_ID, `update rep_payout_rows set residual_income = 1.00 where mid = 'LK-PLAIN'`);

  it("with the grant and an update policy put back, the trigger still refuses (PT409, its sentence)", async () => {
    await committedMonth(mutant);
    await mutant.exec(`grant update (residual_income) on rep_payout_rows to authenticated;
      create policy "mutant update" on rep_payout_rows for update using (is_admin()) with check (is_admin());`);
    try {
      const error = await edit(mutant);
      expect([error?.code, error?.message]).toEqual([
        "PT409",
        "A committed payout line is never edited. Replace the month (until it is marked paid), or post an adjustment after.",
      ]);

      // ...and with the trigger gone as well, the edit goes through: the
      // trigger was what stopped it.
      await mutant.exec(`drop trigger rep_payout_rows_guard_client_update on rep_payout_rows`);
      expect(await edit(mutant)).toBeNull();
      expect(
        await rows(mutant, `select residual_income::text as v from rep_payout_rows where mid = 'LK-PLAIN'`),
      ).toEqual([{ v: "1.00" }]);
    } finally {
      await asPlatform(mutant);
      await mutant.exec(`
        drop policy if exists "mutant update" on rep_payout_rows;
        revoke update on rep_payout_rows from authenticated;
        drop trigger if exists rep_payout_rows_guard_client_update on rep_payout_rows;
        create trigger rep_payout_rows_guard_client_update
          before update on rep_payout_rows
          for each row execute function guard_client_payout_update();`);
    }
  });

  it("with the trigger gone, the missing grant still refuses (42501)", async () => {
    await committedMonth(mutant);
    await mutant.exec(`drop trigger rep_payout_rows_guard_client_update on rep_payout_rows`);
    try {
      expect((await edit(mutant))?.code).toBe("42501");
    } finally {
      await asPlatform(mutant);
      await mutant.exec(`create trigger rep_payout_rows_guard_client_update
        before update on rep_payout_rows
        for each row execute function guard_client_payout_update();`);
    }
  });

  it("the trigger names the client roles, not 'every role': without the role test it would refuse the owner too", async () => {
    await committedMonth(mutant);
    const [{ def }] = await rows<{ def: string }>(
      mutant,
      `select pg_get_functiondef('guard_client_payout_update()'::regprocedure) as def`,
    );
    const fragment = "if current_user in ('authenticated', 'anon') then";
    expect(def).toContain(fragment);
    await mutant.exec(def.replace(fragment, "if true then"));
    try {
      const error = await attempt(() =>
        mutant.query(`update rep_payout_rows set batch_id = null where mid = 'LK-PLAIN'`),
      );
      expect(error?.code).toBe("PT409");
    } finally {
      await asPlatform(mutant);
      await mutant.exec(def);
    }
  });
});

// -------------------------------------------------------------------------
// 4. The fixes that remain
// -------------------------------------------------------------------------

describe("the fixes that remain still work", () => {
  it("a REPLACE before the month is paid writes the corrected figures", async () => {
    const { batch, period } = await committedMonth(db);
    const second = await insertBatch(db, {
      extra: { period: `'${period}'`, replaces_batch_id: String(batch) },
    });
    await stageForCommit(db, second, [
      { mid: "LK-PLAIN", residual: "80.00" },
      { mid: "LK-SHARED" },
      { mid: "LK-OVR" },
    ]);
    const result = await commitV3(db, second);
    expect(result.replaced_lines).toBeGreaterThan(0);
    await asPlatform(db);
    expect(
      await rows(db, `select rep_payout::text as payout from rep_payout_rows where mid = 'LK-PLAIN' and batch_id = ${second}`),
    ).toEqual([{ payout: "40.00" }]);
    expect(
      await rows(db, `select status from rep_payout_batches where id = ${batch}`),
    ).toEqual([{ status: "replaced" }]);
  });

  it("an ADJUSTMENT after the month is marked paid posts its line", async () => {
    const { period } = await committedMonth(db);
    const [{ label }] = await rows<{ label: string }>(
      db,
      `select '${PROCESSOR} ' || to_char(date '${period}', 'FMMonth YYYY') as label`,
    );
    await asUser(db, ADMIN_ID);
    await db.query(`select close_payout_period('${period}', '${PROCESSOR}', '${label}')`);
    const [{ result }] = await rows<{ result: { line_id: number } }>(
      db,
      `select post_payout_adjustment('${AGENT_ID}', 'LK-PLAIN', '${period}', '${PROCESSOR}', -5.00,
                                     'Processor corrected the month') as result`,
    );
    await asPlatform(db);
    expect(
      await rows(db, `select line_kind, rep_payout::text as payout, adjusts_period::text as adjusts
                        from rep_payout_rows where id = ${result.line_id}`),
    ).toEqual([{ line_kind: "adjustment", payout: "-5.00", adjusts: period }]);
  });
});

// -------------------------------------------------------------------------
// 5. The migration over a populated database
// -------------------------------------------------------------------------

describe("the migration over a populated database", () => {
  async function populated(): Promise<TestDb> {
    const target = await open(await migrationsBefore(MIGRATION));
    await resetData(target);
    await committedMonth(target);
    return target;
  }

  it("applies over committed lines (import, shared, override) and changes none of them", async () => {
    const target = await populated();
    const before = await ledger(target);
    expect(before.length).toBeGreaterThan(4);
    await asPlatform(target);
    await target.exec(await readMigration(MIGRATION));
    expect(await ledger(target)).toEqual(before);
    expect(
      await rows(target, `select has_column_privilege('authenticated', 'rep_payout_rows', 'residual_income', 'UPDATE') as ok`),
    ).toEqual([{ ok: false }]);
  });

  it("refuses, naming it, when the update policy it drops is not there -- and changes nothing", async () => {
    const target = await populated();
    await asPlatform(target);
    await target.exec(`drop policy "admin only update" on rep_payout_rows`);
    const error = await attempt(async () => target.exec(await readMigration(MIGRATION)));
    expect(error?.message).toBe(
      'rep_payout_rows has no "admin only update" policy here. Inspect its policies before applying 20261102140000.',
    );
    expect(
      await rows(target, `select to_regprocedure('set_shared_residual(int, date, numeric)') is not null as kept`),
    ).toEqual([{ kept: true }]);
  });

  it("refuses, naming it, when set_shared_residual is not there", async () => {
    const target = await populated();
    await asPlatform(target);
    await target.exec(`drop function set_shared_residual(int, date, numeric)`);
    const error = await attempt(async () => target.exec(await readMigration(MIGRATION)));
    expect(error?.message).toBe(
      "set_shared_residual(int, date, numeric) does not exist here. Inspect the functions before applying 20261102140000.",
    );
    expect(
      await rows(target, `select has_column_privilege('authenticated', 'rep_payout_rows', 'residual_income', 'UPDATE') as ok`),
    ).toEqual([{ ok: true }]);
  });
});
