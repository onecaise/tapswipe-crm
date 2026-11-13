import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_ID,
  AGENT_ID,
  FIXTURE_BATCH_PROCESSOR,
  asPlatform,
  asUser,
  commitV3,
  createTestDb,
  freeBatchMonth,
  insertBatch,
  migrationsBefore,
  readMigration,
  resetData,
  rows,
  seedPayouts,
  stageForCommit,
  type TestDb,
} from "../helpers/db";

/**
 * 20261030140000, the import parser -- the database half of phase 7 of
 * docs/design/intake-and-reports.md. The claims:
 *
 *   1. A NEW batch needs a processor and a month; an update cannot clear them;
 *      a batch without them can be abandoned but never committed (trigger
 *      first, with its sentence; a validated CHECK behind it).
 *   2. Staging carries the file's raw Processor and Income Type, and EVERY
 *      refusal a row trips (`blockers`), from the seven codes only; a row that
 *      lists a refusal always has a `blocker` (so v2's `blocker is not null`
 *      sees it), and that blocker is one of them.
 *   3. The four retired codes are refused; payee_changed is a note it accepts.
 *   4. The migration refuses -- naming them -- a committed batch with no
 *      processor and month, and a staged row with a retired code; and
 *      otherwise applies over a populated database changing no row, legacy
 *      review and abandoned batches included.
 */

const MIGRATION = "20261030140000_import_parser.sql";

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

/** The 1st of the month `offset` months from the current UTC month, from SQL. */
async function month(target: TestDb, offset: number): Promise<string> {
  const [{ m }] = await rows<{ m: string }>(
    target,
    `select to_char((date_trunc('month', now() at time zone 'UTC')
                     + make_interval(months => ${offset}))::date, 'YYYY-MM-DD') as m`,
  );
  return m;
}

// -------------------------------------------------------------------------
// 1-3. On a database with every migration.
// -------------------------------------------------------------------------

let db: TestDb;

beforeAll(async () => {
  db = await open();
});

beforeEach(async () => {
  await resetData(db);
  await asPlatform(db);
});

describe("processor and month are required on every new batch", () => {
  it("refuses an INSERT without them, whoever writes it, with a sentence", async () => {
    await asPlatform(db);
    for (const columns of ["", ", processor", ", period"]) {
      const values =
        columns === ""
          ? ""
          : columns === ", processor"
            ? ", 'TSYS'"
            : `, '${await month(db, -1)}'`;
      const error = await attempt(() =>
        db.exec(`insert into rep_payout_batches (imported_by, file_key, file_name, status${columns})
                 values ('${ADMIN_ID}', 'k', 'f.xlsx', 'review'${values})`),
      );
      expect(error?.code, columns).toBe("PT400");
      expect(error?.message, columns).toBe(
        "A residual import needs its processor and month. Choose both when uploading the file.",
      );
    }
    const [{ n }] = await rows<{ n: number }>(db, `select count(*)::int as n from rep_payout_batches`);
    expect(n).toBe(0);
  });

  it("accepts one with both", async () => {
    const id = await insertBatch(db);
    const [batch] = await rows<{ processor: string; period: string }>(
      db,
      `select processor, period::text as period from rep_payout_batches where id = ${id}`,
    );
    expect(batch.processor).toBe(FIXTURE_BATCH_PROCESSOR);
    expect(batch.period).toBe(await month(db, 0));
  });

  it("refuses an UPDATE that clears them, and changes nothing", async () => {
    const id = await insertBatch(db);
    const error = await attempt(() =>
      db.exec(`update rep_payout_batches set processor = null, period = null where id = ${id}`),
    );
    expect(error?.code).toBe("PT400");
    expect(error?.message).toBe("An import's processor and month cannot be cleared.");
    const [{ processor }] = await rows<{ processor: string | null }>(
      db,
      `select processor from rep_payout_batches where id = ${id}`,
    );
    expect(processor).toBe(FIXTURE_BATCH_PROCESSOR);
  });

  it("lets other columns of a batch change as before", async () => {
    const id = await insertBatch(db);
    await db.exec(`update rep_payout_batches set row_count = 4, file_key = '${id}/f.xlsx' where id = ${id}`);
    const [{ n }] = await rows<{ n: number }>(db, `select row_count as n from rep_payout_batches where id = ${id}`);
    expect(n).toBe(4);
  });

  describe("a batch from before the migration (no processor, no month)", () => {
    /** As if it had been written before 20261030140000: the trigger off. */
    async function legacy(status: string): Promise<number> {
      await asPlatform(db);
      await db.exec(`set session_replication_role = replica`);
      try {
        const [{ id }] = await rows<{ id: number }>(
          db,
          `insert into rep_payout_batches (imported_by, file_key, file_name, status)
           values ('${ADMIN_ID}', 'old/f.xlsx', 'f.xlsx', '${status}') returning id`,
        );
        return id;
      } finally {
        await db.exec(`set session_replication_role = origin`);
      }
    }

    it("can still be abandoned by an admin, the one client transition", async () => {
      const id = await legacy("review");
      await asUser(db, ADMIN_ID);
      await db.exec(`update rep_payout_batches set status = 'abandoned' where id = ${id}`);
      await asPlatform(db);
      const [{ status }] = await rows<{ status: string }>(db, `select status from rep_payout_batches where id = ${id}`);
      expect(status).toBe("abandoned");
    });

    it("can never be committed: the trigger says why, before the CHECK", async () => {
      const id = await legacy("review");
      const error = await attempt(() =>
        db.exec(`update rep_payout_batches set status = 'committed' where id = ${id}`),
      );
      expect(error?.code).toBe("PT409");
      expect(error?.message).toMatch(/started before the processor and month were chosen at upload/);
    });

    it("can never be committed through v3 either, and nothing reaches the ledger", async () => {
      const id = await legacy("review");
      await db.exec(`
        insert into rep_payout_import_rows (batch_id, row_number, mid_raw, period, agent_id, volume)
        values (${id}, 2, 'LEGACY-1', '2026-07-01', '${AGENT_ID}', 10.00)`);
      await asUser(db, ADMIN_ID);
      const error = await attempt(() => db.query(`select commit_residual_import_v3(${id}, '{}')`));
      expect(error?.message).toMatch(/started before the processor and month were chosen at upload/);
      await asPlatform(db);
      const [{ n }] = await rows<{ n: number }>(db, `select count(*)::int as n from rep_payout_rows where mid = 'LEGACY-1'`);
      expect(n).toBe(0);
      const [{ status }] = await rows<{ status: string }>(db, `select status from rep_payout_batches where id = ${id}`);
      expect(status).toBe("review");
    });

    it("the CHECK stands behind the trigger: committed, replaced or deleted needs a processor", async () => {
      const id = await legacy("review");
      await db.exec(`set session_replication_role = replica`);
      try {
        const error = await attempt(() =>
          db.exec(`update rep_payout_batches set status = 'committed' where id = ${id}`),
        );
        expect(error?.message).toMatch(/rep_payout_batches_month_when_committed/);
      } finally {
        await db.exec(`set session_replication_role = origin`);
      }
      const [{ validated, def }] = await rows<{ validated: boolean; def: string }>(
        db,
        `select convalidated as validated, pg_get_constraintdef(oid) as def from pg_constraint
          where conname = 'rep_payout_batches_month_when_committed'`,
      );
      expect(validated).toBe(true);
      // 'deleted' joined the committed states in 20261030190000 (phase 9).
      expect(def).toBe(
        "CHECK (((status <> ALL (ARRAY['committed'::text, 'replaced'::text, 'deleted'::text])) OR (processor IS NOT NULL)))",
      );
    });
  });

  it("the trigger function is nobody's to call", async () => {
    const [{ acl }] = await rows<{ acl: string | null }>(
      db,
      `select proacl::text as acl from pg_proc where proname = 'require_payout_batch_month'`,
    );
    // revoke all from public: no PUBLIC entry, so anon has nothing.
    expect(acl ?? "").not.toMatch(/(^|[{,])=X/);
    expect(acl ?? "").not.toMatch(/anon=/);
  });
});

describe("staging: raw cells, every refusal, the narrowed codes", () => {
  async function stagingRow(fields: string, values: string): Promise<DbError | null> {
    await asPlatform(db);
    const id = await insertBatch(db);
    return attempt(() =>
      db.exec(`insert into rep_payout_import_rows (batch_id, row_number, ${fields}) values (${id}, 2, ${values})`),
    );
  }

  it("keeps the file's Processor and Income Type cells", async () => {
    expect(await stagingRow("processor_raw, income_type_raw", "'Netevia', 'Fees'")).toBeNull();
    expect(
      await rows(db, `select processor_raw, income_type_raw, blockers from rep_payout_import_rows`),
    ).toEqual([{ processor_raw: "Netevia", income_type_raw: "Fees", blockers: [] }]);
  });

  it("blocker takes the seven codes, and nothing else -- the four retired codes included", async () => {
    for (const code of [
      "missing_mid", "unknown_mid", "duplicate_mid", "mid_in_other_batch",
      "wrong_income_type", "missing_figure", "unreadable_number",
    ]) {
      expect(await stagingRow("blocker, blockers", `'${code}', array['${code}']`), code).toBeNull();
    }
    for (const retired of ["unknown_agent", "unparseable_period", "bad_number", "duplicate_in_file", "bad_numbers"]) {
      expect((await stagingRow("blocker", `'${retired}'`))?.message, retired).toMatch(
        /rep_payout_import_rows_blocker_check/,
      );
    }
  });

  it("blockers lists every refusal a row trips, from the seven only", async () => {
    expect(
      await stagingRow("blocker, blockers", "'duplicate_mid', array['duplicate_mid', 'unknown_mid', 'wrong_income_type']"),
    ).toBeNull();
    expect((await stagingRow("blocker, blockers", "'unknown_mid', array['unknown_mid', 'unknown_agent']"))?.message).toMatch(
      /rep_payout_import_rows_blockers_vocabulary/,
    );
    expect((await stagingRow("blockers", "null"))?.message).toMatch(/null value|not-null/i);
  });

  it("a row that lists a refusal always has a blocker: it can never look committable", async () => {
    expect((await stagingRow("blockers", "array['unknown_mid']"))?.message).toMatch(
      /rep_payout_import_rows_blockers_need_blocker/,
    );
  });

  it("the blocker is one of the refusals listed", async () => {
    expect((await stagingRow("blocker, blockers", "'missing_mid', array['unknown_mid']"))?.message).toMatch(
      /rep_payout_import_rows_blocker_in_blockers/,
    );
  });

  it("a blocker with no list is still allowed (a row staged before this migration)", async () => {
    expect(await stagingRow("blocker", "'missing_mid'")).toBeNull();
  });

  it("accepts the payee_changed note, and still refuses an unknown one", async () => {
    expect(await stagingRow("preview_flag", "'payee_changed'")).toBeNull();
    expect((await stagingRow("preview_flag", "'payee_moved'"))?.message).toMatch(
      /rep_payout_import_rows_preview_flag_check/,
    );
  });
});

describe("one committed batch per processor-month, with the month now required", () => {
  it("still refuses a second committed batch for a pair through v3, naming the first", async () => {
    // v3 (20261030160000) refuses it itself, with a sentence; the unique index
    // stays the backstop (tests/rls/commit-residual-import-v3.test.ts removes
    // v3's check and meets the index).
    await asPlatform(db);
    const m = await month(db, -3);
    const ids: number[] = [];
    for (const mid of ["MID-AGENT-1", "MID-OTHER-1"]) {
      const id = await insertBatch(db, { extra: { processor: "'PayBright'", period: `'${m}'` } });
      await stageForCommit(db, id, [{ mid }]);
      ids.push(id);
    }
    // Both merchants are TSYS's: a processor mismatch, confirmed.
    await commitV3(db, ids[0], ["processor_mismatch"]);
    const error = await attempt(() => commitV3(db, ids[1], ["processor_mismatch"]));
    expect(error?.code).toBe("PT409");
    expect(error?.message).toMatch(/^PayBright for /);
    expect(error?.message).toContain(`is already committed (import #${ids[0]}).`);
    const [{ status }] = await rows<{ status: string }>(db, `select status from rep_payout_batches where id = ${ids[1]}`);
    expect(status).toBe("review");
  });

  it("freeBatchMonth gives each new fixture batch its own month", async () => {
    const months = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const id = await insertBatch(db);
      const [{ period }] = await rows<{ period: string }>(
        db,
        `select period::text as period from rep_payout_batches where id = ${id}`,
      );
      months.add(period);
    }
    expect(months.size).toBe(5);
    expect(freeBatchMonth()).toContain("generate_series");
  });
});

// -------------------------------------------------------------------------
// 4. The migration over existing rows.
// -------------------------------------------------------------------------

describe("the migration over a populated database", () => {
  /**
   * A database as phase 6 left it, holding every batch shape the CRM can have
   * at that point: legacy review and abandoned batches with no processor,
   * processor-month batches in review and committed, staged rows clean and
   * blocked with a kept code, and ledger lines.
   */
  async function populated(): Promise<TestDb> {
    const target = await open(await migrationsBefore(MIGRATION));
    await resetData(target);
    await seedPayouts(target);
    await asPlatform(target);
    // seedPayouts gave its committed batch a processor (the columns exist
    // here). Legacy shapes beside it:
    await target.exec(`
      insert into rep_payout_batches (imported_by, file_key, file_name, status)
      values ('${ADMIN_ID}', 'old/a.xlsx', 'a.xlsx', 'abandoned'),
             ('${ADMIN_ID}', 'old/r.xlsx', 'r.xlsx', 'review');
      insert into rep_payout_import_rows (batch_id, row_number, mid_raw, blocker, error)
      values ((select id from rep_payout_batches where file_name = 'r.xlsx'), 2, null, 'missing_mid', 'no MID');`);
    // seedPayouts' blocked row carries unknown_agent on this schema, a code the
    // migration retires; it is the subject of its own refusal test, and is
    // turned into a kept code here so the other tests see a carryable database.
    await target.exec(`update rep_payout_import_rows set blocker = 'missing_mid' where blocker = 'unknown_agent'`);
    return target;
  }

  const snapshot = async (target: TestDb) => {
    await asPlatform(target);
    return {
      batches: await rows(target, `select to_jsonb(b) as j from rep_payout_batches b order by id`),
      staging: await rows(
        target,
        `select to_jsonb(s) - 'processor_raw' - 'income_type_raw' - 'blockers' as j from rep_payout_import_rows s order by id`,
      ),
      ledger: await rows(target, `select to_jsonb(r) as j from rep_payout_rows r order by id`),
    };
  };

  it("applies, and every batch, staged row and ledger line comes out unchanged", async () => {
    const target = await populated();
    const before = await snapshot(target);
    expect(before.batches.length).toBe(4);
    await target.exec(await readMigration(MIGRATION));
    expect(await snapshot(target)).toEqual(before);
    // The new staging columns are empty on the old rows.
    expect(
      await rows(
        target,
        `select count(*)::int as n from rep_payout_import_rows
          where processor_raw is not null or income_type_raw is not null or cardinality(blockers) > 0`,
      ),
    ).toEqual([{ n: 0 }]);
  });

  it("refuses a committed batch with no processor and month, naming it, and changes nothing", async () => {
    const target = await populated();
    await target.exec(`
      insert into rep_payout_batches (imported_by, file_key, file_name, status, committed_at)
      values ('${ADMIN_ID}', 'old/c1.xlsx', 'c1.xlsx', 'committed', now()),
             ('${ADMIN_ID}', 'old/c2.xlsx', 'c2.xlsx', 'committed', now());`);
    const ids = await rows<{ id: number }>(
      target,
      `select id from rep_payout_batches where file_name in ('c1.xlsx', 'c2.xlsx') order by id`,
    );
    const before = await snapshot(target);
    const error = await attempt(async () => target.exec(await readMigration(MIGRATION)));
    expect(error?.message).toBe(
      `import parser migration refuses to run: committed rep_payout_batches ${ids
        .map((r) => r.id)
        .join(", ")} have no processor and month. Set both on each (processor, period) by hand, or remove the batch deliberately, then re-run.`,
    );
    expect(await snapshot(target)).toEqual(before);
    const [{ n }] = await rows<{ n: number }>(
      target,
      `select count(*)::int as n from pg_constraint where conname = 'rep_payout_batches_month_when_committed'`,
    );
    expect(n).toBe(0);
  });

  it("refuses a staged row with a retired blocker code, naming its batch, and changes nothing", async () => {
    const target = await populated();
    // A row the old parser staged: an agent number nobody holds.
    const [{ batch }] = await rows<{ batch: number }>(
      target,
      `select id as batch from rep_payout_batches where file_name = 'r.xlsx'`,
    );
    await target.exec(`
      insert into rep_payout_import_rows (batch_id, row_number, agent_number_raw, mid_raw, blocker, error)
      values (${batch}, 3, '7788', 'X', 'unknown_agent', 'No rep has agent # 7788.')`);
    const before = await snapshot(target);
    const error = await attempt(async () => target.exec(await readMigration(MIGRATION)));
    expect(error?.message).toBe(
      `import parser migration refuses to run: staged rows in rep_payout_batches ${batch} carry a retired blocker code. Abandon those batches, delete their staged rows, and upload the files again, then re-run.`,
    );
    expect(await snapshot(target)).toEqual(before);
  });

  it("passes once the named rows are dealt with", async () => {
    const target = await populated();
    await target.exec(`
      insert into rep_payout_batches (imported_by, file_key, file_name, status, committed_at)
      values ('${ADMIN_ID}', 'old/c1.xlsx', 'c1.xlsx', 'committed', now());`);
    expect(await attempt(async () => target.exec(await readMigration(MIGRATION)))).not.toBeNull();
    // The admin's fix: the batch's processor and month set by hand.
    await target.exec(`
      update rep_payout_batches set processor = 'Square', period = '${await month(target, -5)}'
       where file_name = 'c1.xlsx';`);
    expect(await attempt(async () => target.exec(await readMigration(MIGRATION)))).toBeNull();
  });
});
