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
  resetData,
  rows,
  seedPayouts,
  type PayoutFixtures,
  type TestDb,
} from "../helpers/db";

/**
 * The four rep_payout tables: scoping, the verbs each role actually holds, the
 * constraints, and the generated payout column.
 *
 * What makes this group different from every other Tier 1 table here, and what
 * most of these assertions are really about: only ONE of the four is rep-readable,
 * and NONE of them is client-insertable. rep_payout_rows is written solely by
 * commit-residual-import under the service role, so a plain `authenticated` insert
 * has to be refused rather than filtered — and it is refused twice over, by a
 * missing policy and by a missing grant. Either alone would do; both means a
 * policy added by mistake still opens nothing.
 *
 * Money is the reason the constraint cases are here in this much detail. A CHECK
 * that wrongly rejects a negative residual turns a legitimate clawback into an
 * unexplainable blocked import, and a CHECK that wrongly accepts a negative volume
 * lets a parse error through as a business fact. Both directions are asserted.
 */

type CountRow = { n: number };
type LedgerRow = { id: number; mid: string; period: string };

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

async function countRows(db: TestDb): Promise<number> {
  const [{ n }] = await rows<CountRow>(
    db,
    `select count(*)::int as n from rep_payout_rows`,
  );
  return n;
}

describe("rep_payout_rows: who can read which rows", () => {
  it("gives an agent only their own rows, across both periods", async () => {
    await asUser(db, AGENT_ID);

    const result = await rows<LedgerRow>(
      db,
      `select id, mid, period::text as period from rep_payout_rows order by id`,
    );

    // Three: two in the current period, one in the prior. The prior-period row is
    // what stops "filtered by period" and "filtered by owner" being confusable.
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.id)).not.toContain(fx.rowIds.other);
    expect(new Set(result.map((r) => r.period))).toEqual(
      new Set([PAYOUT_PERIOD, PAYOUT_PERIOD_PRIOR]),
    );
  });

  it("gives the other agent only theirs", async () => {
    await asUser(db, OTHER_AGENT_ID);

    const result = await rows<LedgerRow>(db, `select id, mid, period::text as period from rep_payout_rows`);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(fx.rowIds.other);
  });

  it("gives an admin every row", async () => {
    await asUser(db, ADMIN_ID);

    expect(await countRows(db)).toBe(4);
  });

  it("gives an unauthenticated caller nothing", async () => {
    await asUser(db, null);

    expect(await countRows(db)).toBe(0);
  });

  it("gives a deactivated agent nothing, even for their own rows", async () => {
    // The own-row branch is `agent_id = auth.uid() and is_active_agent()`. A valid
    // JWT proves who the caller is, not that their account is still enabled, and a
    // deactivated rep's token keeps working until it expires.
    await asPlatform(db);
    await db.exec(
      `update profiles set is_active = false where id = '${AGENT_ID}'`,
    );

    await asUser(db, AGENT_ID);
    expect(await countRows(db)).toBe(0);
  });
});

describe("rep_payout_rows: which verbs each role holds", () => {
  it("refuses an insert from authenticated outright, rather than filtering it", async () => {
    // The distinction matters. Elsewhere in this schema RLS *filters* — a write
    // the policy hides matches nothing and reports success. Here there is no
    // INSERT policy AND no INSERT grant, so the statement is rejected instead: a
    // ledger of what a processor reported must not be writable a row at a time
    // from a browser, and a silent no-op would look like it had worked.
    await asUser(db, ADMIN_ID);

    await expect(
      db.exec(
        `insert into rep_payout_rows (agent_id, period, mid)
         values ('${AGENT_ID}', '${PAYOUT_PERIOD}', 'MID-SNUCK-IN')`,
      ),
    ).rejects.toThrow(/permission denied|row-level security/i);

    await asPlatform(db);
    expect(await countRows(db)).toBe(4);
  });

  it("lets an admin update the two money figures", async () => {
    await asUser(db, ADMIN_ID);
    await db.exec(
      `update rep_payout_rows set residual_income = 91.00
        where id = ${fx.rowIds.filled}`,
    );

    await asPlatform(db);
    const [{ v }] = await rows<{ v: string }>(
      db,
      `select residual_income::text as v from rep_payout_rows where id = ${fx.rowIds.filled}`,
    );
    expect(v).toBe("91.00");
  });

  it("filters an agent's update of their own row to nothing", async () => {
    // Filtered, not refused: `authenticated` does hold the UPDATE grant (an admin
    // is authenticated too), so the privilege check passes and the admin-only
    // USING clause is what hides the row. The figures belong to whoever runs
    // payouts, not to the rep being paid.
    await asUser(db, AGENT_ID);
    await db.exec(
      `update rep_payout_rows set residual_income = 999.00
        where id = ${fx.rowIds.filled}`,
    );

    await asPlatform(db);
    const [{ v }] = await rows<{ v: string }>(
      db,
      `select residual_income::text as v from rep_payout_rows where id = ${fx.rowIds.filled}`,
    );
    expect(v).toBe("88.40");
  });

  it("filters an agent's delete of their own row to nothing", async () => {
    await asUser(db, AGENT_ID);
    await db.exec(`delete from rep_payout_rows where id = ${fx.rowIds.filled}`);

    await asPlatform(db);
    expect(await countRows(db)).toBe(4);
  });

  it("lets an admin delete a whole period", async () => {
    // The escape hatch for an import that was simply wrong. Individual rows are
    // not deletable through the UI, but the policy is per-row and this is what it
    // permits.
    await asUser(db, ADMIN_ID);
    await db.exec(
      `delete from rep_payout_rows where period = '${PAYOUT_PERIOD}'`,
    );

    await asPlatform(db);
    expect(await countRows(db)).toBe(1);
    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from rep_payout_rows where period = '${PAYOUT_PERIOD_PRIOR}'`,
    );
    expect(n).toBe(1);
  });

  it("has no INSERT policy at all", async () => {
    // Asserted against the catalog as well as behaviourally, because the
    // behavioural test above would still pass if someone added an INSERT policy
    // while leaving the grant off — and then a later grant would silently open it.
    await asPlatform(db);
    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from pg_policies
        where tablename = 'rep_payout_rows' and cmd = 'INSERT'`,
    );
    expect(n).toBe(0);
  });
});

describe("rep_payout_rows: the constraints protect the money", () => {
  /** Inserts as the platform owner, which bypasses RLS but not CHECKs. */
  async function insert(columns: string, values: string): Promise<void> {
    await asPlatform(db);
    await db.exec(
      `insert into rep_payout_rows (agent_id, period, mid, ${columns})
       values ('${AGENT_ID}', '${PAYOUT_PERIOD}', 'MID-CHECK-${Math.abs(
         values.length * 7,
       )}', ${values})`,
    );
  }

  it("rejects a duplicate (period, agent_id, mid)", async () => {
    // The merge key. Two rows for one merchant in one period for one rep would
    // make the upsert ambiguous, and the importer would have no honest answer.
    await asPlatform(db);
    await expect(
      db.exec(
        `insert into rep_payout_rows (agent_id, period, mid)
         values ('${AGENT_ID}', '${PAYOUT_PERIOD}', 'MID-AGENT-1')`,
      ),
    ).rejects.toThrow(/unique|duplicate key/i);
  });

  it("allows the same MID for the same rep in a different period", async () => {
    // The other half of the key, and the normal case: a merchant earns residuals
    // every month.
    await asPlatform(db);
    await db.exec(
      `insert into rep_payout_rows (agent_id, period, mid)
       values ('${AGENT_ID}', '2026-05-01', 'MID-AGENT-1')`,
    );
    expect(await countRows(db)).toBe(5);
  });

  it("allows the same MID for two different reps in one period", async () => {
    // A MID can change hands, and a residual report can name the same merchant
    // under two reps in the month it moved.
    await asPlatform(db);
    await db.exec(
      `insert into rep_payout_rows (agent_id, period, mid)
       values ('${OTHER_AGENT_ID}', '${PAYOUT_PERIOD}', 'MID-AGENT-1')`,
    );
    expect(await countRows(db)).toBe(5);
  });

  it("rejects a negative volume or average ticket", async () => {
    // A negative there is a parse error, not a business fact.
    await expect(insert("volume", "-1.00")).rejects.toThrow(/check|violates/i);
    await expect(insert("average_ticket", "-0.01")).rejects.toThrow(
      /check|violates/i,
    );
  });

  it("ACCEPTS a negative total cost and residual income", async () => {
    // The load-bearing permissive case. Clawbacks and adjustments are real, and a
    // CHECK that rejected one would turn valid processor data into a blocked row
    // nobody could explain. This is the assertion that stops a future "tidy up the
    // constraints" pass from breaking a real month.
    await asPlatform(db);
    await db.exec(
      `insert into rep_payout_rows
         (agent_id, period, mid, total_cost, residual_income, rep_split_pct)
       values ('${AGENT_ID}', '${PAYOUT_PERIOD}', 'MID-CLAWBACK',
               -42.00, -18.50, 60.00)`,
    );

    const [{ payout }] = await rows<{ payout: string }>(
      db,
      `select rep_payout::text as payout from rep_payout_rows where mid = 'MID-CLAWBACK'`,
    );
    // And the derived column carries the sign through rather than clamping it.
    expect(payout).toBe("-11.10");
  });

  it("keeps rep_split_pct inside 0..100, boundaries included", async () => {
    await expect(insert("rep_split_pct", "100.01")).rejects.toThrow(
      /check|violates/i,
    );
    await expect(insert("rep_split_pct", "-0.01")).rejects.toThrow(
      /check|violates/i,
    );

    await asPlatform(db);
    await db.exec(
      `insert into rep_payout_rows (agent_id, period, mid, rep_split_pct) values
         ('${AGENT_ID}', '${PAYOUT_PERIOD}', 'MID-SPLIT-0',   0.00),
         ('${AGENT_ID}', '${PAYOUT_PERIOD}', 'MID-SPLIT-100', 100.00)`,
    );
    expect(await countRows(db)).toBe(6);
  });

  it("requires a period and a MID", async () => {
    await asPlatform(db);
    await expect(
      db.exec(
        `insert into rep_payout_rows (agent_id, mid) values ('${AGENT_ID}', 'MID-NO-PERIOD')`,
      ),
    ).rejects.toThrow(/null value|not-null/i);

    await expect(
      db.exec(
        `insert into rep_payout_rows (agent_id, period) values ('${AGENT_ID}', '${PAYOUT_PERIOD}')`,
      ),
    ).rejects.toThrow(/null value|not-null/i);
  });

  it("survives its merchant being deleted, and keeps the MID", async () => {
    // `on delete set null`, so tidying up Merchants cannot wedge on an FK from the
    // ledger — and the MID text stays, because the file is the authority for it.
    await asPlatform(db);
    await db.exec(`delete from merchants where mid = 'MID-AGENT-1'`);

    const [row] = await rows<{ merchant_id: number | null; mid: string }>(
      db,
      `select merchant_id, mid from rep_payout_rows where id = ${fx.rowIds.filled}`,
    );
    expect(row.merchant_id).toBeNull();
    expect(row.mid).toBe("MID-AGENT-1");
  });
});

describe("rep_payout_rows: the derived payout column", () => {
  it("computes and rounds to two places", async () => {
    await asPlatform(db);
    const [{ payout }] = await rows<{ payout: string }>(
      db,
      `select rep_payout::text as payout from rep_payout_rows where id = ${fx.rowIds.filled}`,
    );
    // 88.40 at 60% = 53.04.
    expect(payout).toBe("53.04");
  });

  it("is null when either input is null", async () => {
    // Which reads correctly as "not worked out yet" rather than as a payout of
    // zero — the distinction every total and every summary depends on.
    await asPlatform(db);
    const [blank] = await rows<{ payout: string | null }>(
      db,
      `select rep_payout::text as payout from rep_payout_rows where id = ${fx.rowIds.blank}`,
    );
    expect(blank.payout).toBeNull();

    await db.exec(
      `update rep_payout_rows set rep_split_pct = 50.00 where id = ${fx.rowIds.blank}`,
    );
    const [halfFilled] = await rows<{ payout: string | null }>(
      db,
      `select rep_payout::text as payout from rep_payout_rows where id = ${fx.rowIds.blank}`,
    );
    // A split with no residual income is still nothing to pay.
    expect(halfFilled.payout).toBeNull();
  });

  it("recomputes when either input changes", async () => {
    await asPlatform(db);
    await db.exec(
      `update rep_payout_rows set rep_split_pct = 50.00 where id = ${fx.rowIds.filled}`,
    );

    const [{ payout }] = await rows<{ payout: string }>(
      db,
      `select rep_payout::text as payout from rep_payout_rows where id = ${fx.rowIds.filled}`,
    );
    expect(payout).toBe("44.20");
  });

  it("cannot be written directly", async () => {
    // The whole reason it is generated rather than a third editable column: a
    // payout an admin could type would eventually disagree with the two figures it
    // comes from, and nothing would say which was right.
    await asPlatform(db);
    await expect(
      db.exec(
        `update rep_payout_rows set rep_payout = 1000.00 where id = ${fx.rowIds.filled}`,
      ),
    ).rejects.toThrow(/can only be updated to DEFAULT/i);
  });

  it("rounds half-up at the cent, not toward zero", async () => {
    // 33.335 * 50% = 16.6675 -> 16.67. Pinned because the alternative (truncation)
    // is a cent per row in the company's favour, which is exactly the kind of
    // quiet arithmetic difference nobody reports and everybody notices.
    await asPlatform(db);
    await db.exec(
      `insert into rep_payout_rows (agent_id, period, mid, residual_income, rep_split_pct)
       values ('${AGENT_ID}', '${PAYOUT_PERIOD}', 'MID-ROUNDING', 33.335, 50.00)`,
    );

    const [{ payout }] = await rows<{ payout: string }>(
      db,
      `select rep_payout::text as payout from rep_payout_rows where mid = 'MID-ROUNDING'`,
    );
    expect(payout).toBe("16.67");
  });
});

describe("batches and staging are admin-only, and client-read-only", () => {
  it("shows an agent no batches and no staging rows", async () => {
    await asUser(db, AGENT_ID);

    const [batches] = await rows<CountRow>(
      db,
      `select count(*)::int as n from rep_payout_batches`,
    );
    const [staging] = await rows<CountRow>(
      db,
      `select count(*)::int as n from rep_payout_import_rows`,
    );

    expect(batches.n).toBe(0);
    expect(staging.n).toBe(0);
  });

  it("shows an admin both batches and both staging rows", async () => {
    await asUser(db, ADMIN_ID);

    const [batches] = await rows<CountRow>(
      db,
      `select count(*)::int as n from rep_payout_batches`,
    );
    const [staging] = await rows<CountRow>(
      db,
      `select count(*)::int as n from rep_payout_import_rows`,
    );

    expect(batches.n).toBe(2);
    // One clean, one blocked — so "cannot commit" is distinguishable from "empty".
    expect(staging.n).toBe(2);
    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from rep_payout_import_rows where blocker = 'unknown_agent'`,
    );
    expect(n).toBe(1);
  });

  it("lets an admin abandon a batch", async () => {
    await asUser(db, ADMIN_ID);
    await db.exec(
      `update rep_payout_batches set status = 'abandoned' where id = ${fx.batchIds.review}`,
    );

    await asPlatform(db);
    const [{ status }] = await rows<{ status: string }>(
      db,
      `select status from rep_payout_batches where id = ${fx.batchIds.review}`,
    );
    expect(status).toBe("abandoned");
  });

  it("refuses every other verb on both tables from authenticated", async () => {
    // No INSERT or DELETE grant on batches; nothing but SELECT on staging. All
    // writes come from a service-role Edge Function, so these are refusals rather
    // than filtered no-ops.
    await asUser(db, ADMIN_ID);

    await expect(
      db.exec(
        `insert into rep_payout_batches (imported_by, file_key, file_name)
         values ('${ADMIN_ID}', 'k', 'f.xlsx')`,
      ),
    ).rejects.toThrow(/permission denied|row-level security/i);

    await expect(
      db.exec(`delete from rep_payout_batches where id = ${fx.batchIds.review}`),
    ).rejects.toThrow(/permission denied|row-level security/i);

    await expect(
      db.exec(
        `insert into rep_payout_import_rows (batch_id, row_number)
         values (${fx.batchIds.review}, 9)`,
      ),
    ).rejects.toThrow(/permission denied|row-level security/i);

    await expect(
      db.exec(
        `update rep_payout_import_rows set blocker = null where batch_id = ${fx.batchIds.review}`,
      ),
    ).rejects.toThrow(/permission denied|row-level security/i);
  });

  it("removes a batch's staging rows with it, and only its own", async () => {
    // `on delete cascade` is right here and only here: a staging row has no
    // meaning without its batch.
    await asPlatform(db);
    await db.exec(
      `delete from rep_payout_batches where id = ${fx.batchIds.review}`,
    );

    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from rep_payout_import_rows`,
    );
    expect(n).toBe(0);
  });

  it("keeps ledger rows when their batch goes", async () => {
    // `set null`, not cascade. Tidying an old batch away must not delete the
    // period it imported.
    await asPlatform(db);
    await db.exec(
      `update rep_payout_rows set batch_id = ${fx.batchIds.committed}
        where id = ${fx.rowIds.filled}`,
    );
    await db.exec(
      `delete from rep_payout_batches where id = ${fx.batchIds.committed}`,
    );

    const [row] = await rows<{ batch_id: number | null }>(
      db,
      `select batch_id from rep_payout_rows where id = ${fx.rowIds.filled}`,
    );
    expect(row.batch_id).toBeNull();
    expect(await countRows(db)).toBe(4);
  });
});

describe("rep_payout_row_history is admin-read-only", () => {
  beforeEach(async () => {
    // One real edit, so there is something to fail to see.
    await asUser(db, ADMIN_ID);
    await db.exec(
      `update rep_payout_rows set residual_income = 91.00 where id = ${fx.rowIds.filled}`,
    );
  });

  it("is readable by an admin", async () => {
    await asUser(db, ADMIN_ID);
    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from rep_payout_row_history`,
    );
    expect(n).toBe(1);
  });

  it("is not readable by the rep whose figure changed", async () => {
    // Deliberate: a rep reads their own residuals, but the edit trail behind them
    // is a payroll-administration record. The row they can see is the current
    // truth; who changed it and from what is not theirs.
    await asUser(db, AGENT_ID);
    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from rep_payout_row_history`,
    );
    expect(n).toBe(0);
  });

  it("has no client write path at all", async () => {
    await asUser(db, ADMIN_ID);

    for (const statement of [
      `insert into rep_payout_row_history
         (row_id, period, agent_id, mid, field, new_value)
       values (${fx.rowIds.filled}, '${PAYOUT_PERIOD}', '${AGENT_ID}', 'M', 'residual_income', 1)`,
      `update rep_payout_row_history set new_value = 0`,
      `delete from rep_payout_row_history`,
    ]) {
      await expect(db.exec(statement)).rejects.toThrow(
        /permission denied|row-level security/i,
      );
    }
  });

  it("only allows the two field names it is meant to record", async () => {
    await asPlatform(db);
    await expect(
      db.exec(
        `insert into rep_payout_row_history
           (row_id, period, agent_id, mid, field, new_value)
         values (${fx.rowIds.filled}, '${PAYOUT_PERIOD}', '${AGENT_ID}', 'M', 'volume', 1)`,
      ),
    ).rejects.toThrow(/check|violates/i);
  });
});

describe("the agent number is what joins a report to a rep", () => {
  it("resolves an agent number to exactly one rep", async () => {
    // The lookup the importer performs, asserted here so the fixture and the
    // unique index are known to agree.
    await asPlatform(db);
    const result = await rows<{ id: string }>(
      db,
      `select id from profiles where agent_number = '${AGENT_NUMBER}'`,
    );

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(AGENT_ID);
  });
});

describe("these tests are not vacuous", () => {
  // The load-bearing check documents.test.ts established. Every scoping assertion
  // above is of the form "the agent saw N rows" — which would also hold if the
  // fixture simply had not created the others. This rebuilds the database, widens
  // the select policy to `using (true)`, and asserts the agent then sees
  // EVERYTHING. If that fails, the fixture is not exercising the policy and the
  // rest of this file is measuring nothing.
  it("shows the agent every row once the policy is widened", async () => {
    const wide = await createTestDb();
    try {
      await resetData(wide);
      await seedPayouts(wide);

      await asPlatform(wide);
      await wide.exec(`
        drop policy "select own or admin" on rep_payout_rows;
        create policy "select own or admin" on rep_payout_rows
          for select using (true);
      `);

      await asUser(wide, AGENT_ID);
      expect(await countRows(wide)).toBe(4);
    } finally {
      await wide.close();
    }
  });
});
