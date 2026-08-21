import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_ID,
  AGENT_ID,
  AGENT_NUMBER,
  OTHER_AGENT_ID,
  PAYOUT_PERIOD,
  asPlatform,
  asUser,
  createTestDb,
  resetData,
  rows,
  seedPayouts,
  type PayoutFixtures,
  type TestDb,
} from "../helpers/db";

/**
 * commit_residual_import() — a reviewed batch becomes ledger rows.
 *
 * `security definer`, so as with every other definer function here there is no RLS
 * doing the work: the is_admin() guard is hand-written and would fail open silently
 * if deleted.
 *
 * The assertion that matters most is the COALESCE in the upsert. Reversing its two
 * arguments would silently clear every hand-entered residual on every re-import,
 * and nothing else in the schema would notice — no constraint is violated, no
 * error is raised, the numbers just quietly become null. So both directions are
 * pinned: a fresh processor file must NOT clear figures, and a round-trip export
 * that carries them MUST write them.
 */

type CountRow = { n: number };
type LedgerRow = {
  mid: string;
  merchant_name: string | null;
  volume: string | null;
  residual_income: string | null;
  rep_split_pct: string | null;
  rep_payout: string | null;
};

let db: TestDb;
let fx: PayoutFixtures;

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(async () => {
  await resetData(db);
  fx = await seedPayouts(db);
});

afterAll(async () => {
  await db?.close();
});

/** Runs the RPC as `caller`, returning the error message or null. */
async function commit(
  db: TestDb,
  caller: string | null,
  batchId: number,
): Promise<string | null> {
  await asUser(db, caller);
  try {
    await db.exec(`select commit_residual_import(${batchId})`);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Clears the seeded blocker so the review batch is committable. */
async function unblock(db: TestDb): Promise<void> {
  await asPlatform(db);
  await db.exec(
    `delete from rep_payout_import_rows
      where batch_id = ${fx.batchIds.review} and blocker is not null`,
  );
}

async function ledgerRow(db: TestDb, mid: string): Promise<LedgerRow> {
  await asPlatform(db);
  const [row] = await rows<LedgerRow>(
    db,
    `select mid, merchant_name, volume::text as volume,
            residual_income::text as residual_income,
            rep_split_pct::text as rep_split_pct,
            rep_payout::text as rep_payout
       from rep_payout_rows
      where mid = '${mid}' and period = '${PAYOUT_PERIOD}'`,
  );
  return row;
}

async function countLedger(db: TestDb): Promise<number> {
  await asPlatform(db);
  const [{ n }] = await rows<CountRow>(
    db,
    `select count(*)::int as n from rep_payout_rows`,
  );
  return n;
}

describe("only an active admin may commit", () => {
  beforeEach(async () => {
    await unblock(db);
  });

  it("refuses an agent", async () => {
    const error = await commit(db, AGENT_ID, fx.batchIds.review);

    expect(error).toMatch(/admin only/);
    expect(await countLedger(db)).toBe(4);
  });

  it("refuses a caller with no JWT", async () => {
    expect(await commit(db, null, fx.batchIds.review)).toMatch(/admin only/);
  });

  it("refuses a deactivated admin", async () => {
    // is_admin() requires is_active, so switching the admin off is enough.
    await asPlatform(db);
    await db.exec(
      `update profiles set is_active = false where id = '${ADMIN_ID}'`,
    );

    expect(await commit(db, ADMIN_ID, fx.batchIds.review)).toMatch(
      /admin only/,
    );
  });

  it("writes nothing at all when it refuses", async () => {
    await commit(db, AGENT_ID, fx.batchIds.review);

    await asPlatform(db);
    // The batch is untouched, the staging rows survive, and no audit row claims
    // an import happened.
    const [{ status }] = await rows<{ status: string }>(
      db,
      `select status from rep_payout_batches where id = ${fx.batchIds.review}`,
    );
    expect(status).toBe("review");

    const [{ n: staging }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from rep_payout_import_rows`,
    );
    expect(staging).toBe(1);

    const [{ n: audit }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from audit_log`,
    );
    expect(audit).toBe(0);
  });
});

describe("it refuses a batch that is not ready", () => {
  it("refuses while any row is blocked", async () => {
    // The seeded review batch has one clean row and one unknown_agent blocker.
    const error = await commit(db, ADMIN_ID, fx.batchIds.review);

    expect(error).toMatch(/blocked/);
    // And the clean row did NOT sneak in. Partial import is the failure mode this
    // guard exists to prevent: a period that looks imported but is missing rows.
    expect(await countLedger(db)).toBe(4);
  });

  it("names how many of how many are blocked", async () => {
    const error = await commit(db, ADMIN_ID, fx.batchIds.review);
    expect(error).toMatch(/1 of 2 rows/);
  });

  it("refuses a batch with no staging rows", async () => {
    // Rather than trivially succeeding. Flipping a batch to 'committed' having
    // imported nothing reads as a successful import of an empty month.
    await asPlatform(db);
    await db.exec(
      `delete from rep_payout_import_rows where batch_id = ${fx.batchIds.review}`,
    );

    expect(await commit(db, ADMIN_ID, fx.batchIds.review)).toMatch(/no rows/);
  });

  it("refuses a batch that is already committed", async () => {
    expect(await commit(db, ADMIN_ID, fx.batchIds.committed)).toMatch(
      /already committed/,
    );
  });

  it("refuses a batch that does not exist", async () => {
    expect(await commit(db, ADMIN_ID, 999_999)).toMatch(/import not found/);
  });

  it("cannot be committed twice", async () => {
    await unblock(db);
    expect(await commit(db, ADMIN_ID, fx.batchIds.review)).toBeNull();

    // The status flip is what makes this idempotent-by-refusal. Without it the
    // second call would re-upsert rows whose staging rows are gone — importing
    // nothing, but flipping timestamps and writing a second audit row.
    expect(await commit(db, ADMIN_ID, fx.batchIds.review)).toMatch(
      /already committed/,
    );
  });
});

describe("a clean batch lands in the ledger", () => {
  beforeEach(async () => {
    await unblock(db);
  });

  it("inserts the staged row and reports the count", async () => {
    await asUser(db, ADMIN_ID);
    const [{ imported }] = await rows<{ imported: number }>(
      db,
      `select commit_residual_import(${fx.batchIds.review}) as imported`,
    );

    expect(imported).toBe(1);
    expect(await countLedger(db)).toBe(5);

    const row = await ledgerRow(db, "MID-AGENT-2");
    expect(row).toMatchObject({
      merchant_name: "Agent Inactive Co",
      volume: "5100.00",
      // The file carried no figures, so these arrive empty — which is the normal
      // state of a fresh import, not a failure.
      residual_income: null,
      rep_split_pct: null,
      rep_payout: null,
    });
  });

  it("clears the staging rows and marks the batch committed", async () => {
    await commit(db, ADMIN_ID, fx.batchIds.review);

    await asPlatform(db);
    const [batch] = await rows<{
      status: string;
      row_count: number;
      committed: boolean;
    }>(
      db,
      `select status, row_count, (committed_at is not null) as committed
         from rep_payout_batches where id = ${fx.batchIds.review}`,
    );
    expect(batch).toMatchObject({
      status: "committed",
      row_count: 1,
      committed: true,
    });

    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from rep_payout_import_rows
        where batch_id = ${fx.batchIds.review}`,
    );
    expect(n).toBe(0);
  });

  it("records who committed it", async () => {
    await commit(db, ADMIN_ID, fx.batchIds.review);

    await asPlatform(db);
    const [audit] = await rows<{
      actor_id: string;
      action: string;
      table_name: string;
      row_id: string;
    }>(
      db,
      `select actor_id, action, table_name, row_id from audit_log order by id`,
    );

    // auth.uid() survives `security definer` — it changes current_user, not the
    // session's JWT claims — so this is the admin rather than null.
    expect(audit).toEqual({
      actor_id: ADMIN_ID,
      action: "commit_residual_import",
      table_name: "rep_payout_batches",
      row_id: String(fx.batchIds.review),
    });
  });

  it("stamps the batch as the row's provenance", async () => {
    await commit(db, ADMIN_ID, fx.batchIds.review);

    await asPlatform(db);
    const [{ batch_id }] = await rows<{ batch_id: number }>(
      db,
      `select batch_id from rep_payout_rows where mid = 'MID-AGENT-2'`,
    );
    expect(batch_id).toBe(fx.batchIds.review);
  });
});

describe("re-importing merges, and does not clear hand-entered figures", () => {
  /**
   * Re-stages the already-committed MID-AGENT-1 row, so a commit hits the
   * `on conflict` branch against a ledger row that already has figures.
   */
  async function restage(
    money: { residual: string | null; split: string | null },
    volume = "13100.00",
  ): Promise<number> {
    await asPlatform(db);
    await db.exec(
      `delete from rep_payout_import_rows where batch_id = ${fx.batchIds.review}`,
    );
    await db.exec(`
      insert into rep_payout_import_rows
        (batch_id, row_number, mid_raw, merchant_name_raw,
         period, agent_id, volume, average_ticket, total_cost,
         residual_income, rep_split_pct)
      values (${fx.batchIds.review}, 2, 'MID-AGENT-1', 'Agent Active Co RENAMED',
              '${PAYOUT_PERIOD}', '${AGENT_ID}', ${volume}, 65.00, 322.00,
              ${money.residual ?? "null"}, ${money.split ?? "null"});
    `);
    return fx.batchIds.review;
  }

  it("overwrites the file's own columns", async () => {
    await restage({ residual: null, split: null });
    expect(await commit(db, ADMIN_ID, fx.batchIds.review)).toBeNull();

    const row = await ledgerRow(db, "MID-AGENT-1");
    expect(row.volume).toBe("13100.00");
    expect(row.merchant_name).toBe("Agent Active Co RENAMED");
  });

  it("KEEPS the hand-entered figures when the file has none", async () => {
    // The assertion this whole file exists for. A fresh processor report carries
    // no Residual income or Rep split columns at all, so re-importing a corrected
    // one must not wipe a month of typed-in commission figures. Reversing the
    // coalesce arguments breaks exactly this, silently, with no error anywhere.
    await restage({ residual: null, split: null });
    await commit(db, ADMIN_ID, fx.batchIds.review);

    const row = await ledgerRow(db, "MID-AGENT-1");
    expect(row.residual_income).toBe("88.40");
    expect(row.rep_split_pct).toBe("60.00");
    // And the derived column still agrees with them.
    expect(row.rep_payout).toBe("53.04");
  });

  it("WRITES the figures when a round-trip export supplies them", async () => {
    // The other direction, and the bulk-entry path: export the table, fill the two
    // columns in Excel, re-import. If coalesce were replaced by a plain keep, this
    // would silently do nothing and the admin's work would vanish.
    await restage({ residual: "91.00", split: "55.00" });
    await commit(db, ADMIN_ID, fx.batchIds.review);

    const row = await ledgerRow(db, "MID-AGENT-1");
    expect(row.residual_income).toBe("91.00");
    expect(row.rep_split_pct).toBe("55.00");
    expect(row.rep_payout).toBe("50.05");
  });

  it("writes history for a figure a re-import changed", async () => {
    // The upsert's UPDATE fires log_payout_row_change, so a bulk fill is as
    // traceable as typing into the table — and attributed to the committing admin,
    // because auth.uid() survives `security definer`.
    await restage({ residual: "91.00", split: null });
    await commit(db, ADMIN_ID, fx.batchIds.review);

    await asPlatform(db);
    const history = await rows<{
      field: string;
      old_value: string;
      new_value: string;
      changed_by: string;
    }>(
      db,
      `select field, old_value::text as old_value, new_value::text as new_value,
              changed_by
         from rep_payout_row_history order by id`,
    );

    expect(history).toEqual([
      {
        field: "residual_income",
        old_value: "88.40",
        new_value: "91.00",
        changed_by: ADMIN_ID,
      },
    ]);
  });

  it("adds no history when a re-import changes only the file's columns", async () => {
    await restage({ residual: null, split: null });
    await commit(db, ADMIN_ID, fx.batchIds.review);

    await asPlatform(db);
    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from rep_payout_row_history`,
    );
    expect(n).toBe(0);
  });

  it("does not duplicate the row it merged into", async () => {
    await restage({ residual: null, split: null });
    await commit(db, ADMIN_ID, fx.batchIds.review);

    // Still four: the upsert updated MID-AGENT-1 rather than inserting a second
    // row for the same period and rep.
    expect(await countLedger(db)).toBe(4);
  });

  it("keeps two reps' rows for the same MID apart", async () => {
    // The merge key includes agent_id, so a MID that changed hands mid-month is
    // two rows, not one overwriting the other.
    await asPlatform(db);
    await db.exec(
      `delete from rep_payout_import_rows where batch_id = ${fx.batchIds.review}`,
    );
    await db.exec(`
      insert into rep_payout_import_rows
        (batch_id, row_number, mid_raw, merchant_name_raw, period, agent_id,
         volume, average_ticket, total_cost)
      values (${fx.batchIds.review}, 2, 'MID-AGENT-1', 'Moved Co',
              '${PAYOUT_PERIOD}', '${OTHER_AGENT_ID}', 500.00, 5.00, 10.00);
    `);

    expect(await commit(db, ADMIN_ID, fx.batchIds.review)).toBeNull();
    expect(await countLedger(db)).toBe(5);
  });
});

describe("the guard and the search_path are load-bearing", () => {
  it("is security definer with a pinned search_path and its own admin check", async () => {
    // These are only safe together. `definer` is what lets this insert into
    // rep_payout_rows (no INSERT policy), delete staging rows (no DELETE policy)
    // and write audit_log (no INSERT policy at all); the is_admin() call is the
    // only thing between that privilege and any authenticated caller.
    await asPlatform(db);
    const [row] = await rows<{ prosecdef: boolean; def: string }>(
      db,
      `select p.prosecdef, pg_get_functiondef(p.oid) as def
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'commit_residual_import'`,
    );

    expect(row.prosecdef).toBe(true);
    expect(row.def).toMatch(/is_admin\(\)/);
    expect(row.def).toMatch(/search_path/);
    // The merge rule itself, asserted in the catalog as well as behaviourally:
    // this is the line whose reversal is silent.
    expect(row.def).toMatch(/coalesce\(excluded\.residual_income/);
  });

  it("locks the batch row it checks the status of", async () => {
    // Pinned by grep rather than by behaviour, for the same reason the merge rule
    // above is pinned twice: this suite structurally cannot exercise it. PGlite is
    // a single connection, and the failure needs two overlapping transactions.
    //
    // What it prevents, reproduced against real Postgres before 20260821171000
    // added the lock (session A holding its transaction open, session B calling in
    // before A committed):
    //
    //   A returned 1        B returned 1
    //   audit_rows = 2      ledger_rows = 1      status = committed
    //
    // Two audit rows for one commit, both callers told they succeeded. The
    // `batch.status <> 'review'` check below is only a guard if the row it read
    // cannot change underneath it — an unlocked SELECT lets both transactions see
    // 'review' and both proceed. The ledger survived on the unique index and the
    // upsert, which is a good schema covering for this function rather than this
    // function being correct.
    //
    // With the lock, B blocks at the SELECT until A commits and then raises
    // 'this import is already committed', which is what the sequential
    // "cannot be committed twice" test above has always asserted.
    await asPlatform(db);
    const [locked] = await rows<{ def: string }>(
      db,
      `select pg_get_functiondef(p.oid) as def
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'commit_residual_import'`,
    );

    expect(locked.def).toMatch(
      /from rep_payout_batches\s+where id = batch_id_input\s+for update/,
    );
  });

  it("is not executable by anon", async () => {
    await asPlatform(db);
    const [{ ok }] = await rows<{ ok: boolean }>(
      db,
      `select has_function_privilege('anon', 'commit_residual_import(int)', 'execute') as ok`,
    );
    expect(ok).toBe(false);
  });

  it("is executable by authenticated and service_role", async () => {
    await asPlatform(db);
    for (const role of ["authenticated", "service_role"]) {
      const [{ ok }] = await rows<{ ok: boolean }>(
        db,
        `select has_function_privilege('${role}', 'commit_residual_import(int)', 'execute') as ok`,
      );
      expect(ok, `${role} should execute it`).toBe(true);
    }
  });

  it("resolves the seeded agent number, so the fixture and the key agree", async () => {
    await asPlatform(db);
    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from profiles where agent_number = '${AGENT_NUMBER}'`,
    );
    expect(n).toBe(1);
  });
});
