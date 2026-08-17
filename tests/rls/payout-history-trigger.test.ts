import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_ID,
  AGENT_ID,
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
 * log_payout_row_change() — the field-level trail behind the two money figures an
 * admin types.
 *
 * Corrections to rep_payout_rows overwrite in place, so the row itself carries no
 * memory of what a residual used to be. This trigger is that memory, and it is the
 * only record of it: audit_log has no detail column, and the cross-agent trigger
 * is deliberately not attached to this table (asserted below, because "we chose not
 * to" and "we forgot" look identical in a schema).
 *
 * Three properties matter more than the happy path:
 *
 *   1. It records a change to or from NULL. Both columns arrive empty from an
 *      import, so the FIRST edit to every figure is null -> value. A `<>`
 *      comparison would skip every one of them and the trail would begin at the
 *      second correction.
 *   2. It outlives its subject. Deleting a period must not erase the record that
 *      its figures were edited, which is why row_id carries no foreign key.
 *   3. It fails closed. An unrecorded change to a commission figure is worse than
 *      a failed one, because the failure is visible and the gap is not.
 */

type HistoryRow = {
  row_id: number;
  period: string;
  agent_id: string;
  mid: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  changed_by: string | null;
};

type CountRow = { n: number };

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

async function history(db: TestDb): Promise<HistoryRow[]> {
  await asPlatform(db);
  return rows<HistoryRow>(
    db,
    `select row_id, period::text as period, agent_id, mid, field,
            old_value::text as old_value, new_value::text as new_value, changed_by
       from rep_payout_row_history order by id asc`,
  );
}

/** Runs an update to rep_payout_rows as an admin, the way the UI does. */
async function editAsAdmin(db: TestDb, sql: string): Promise<void> {
  await asUser(db, ADMIN_ID);
  await db.exec(sql);
}

describe("it records a change to either money figure", () => {
  it("captures old, new, who, and enough context to read the row later", async () => {
    await editAsAdmin(
      db,
      `update rep_payout_rows set residual_income = 91.00 where id = ${fx.rowIds.filled}`,
    );

    const result = await history(db);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      row_id: fx.rowIds.filled,
      // Denormalised, so this row still says what it is about after the ledger row
      // is gone.
      period: PAYOUT_PERIOD,
      agent_id: AGENT_ID,
      mid: "MID-AGENT-1",
      field: "residual_income",
      old_value: "88.40",
      new_value: "91.00",
      changed_by: ADMIN_ID,
    });
  });

  it("captures a split change", async () => {
    await editAsAdmin(
      db,
      `update rep_payout_rows set rep_split_pct = 55.00 where id = ${fx.rowIds.filled}`,
    );

    const result = await history(db);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      field: "rep_split_pct",
      old_value: "60.00",
      new_value: "55.00",
    });
  });

  it("writes one row per changed field when both move", async () => {
    // One row per field rather than one per statement, so "what changed" needs no
    // parsing — which is the whole reason this table exists rather than an
    // audit_log entry.
    await editAsAdmin(
      db,
      `update rep_payout_rows
          set residual_income = 91.00, rep_split_pct = 55.00
        where id = ${fx.rowIds.filled}`,
    );

    const result = await history(db);
    expect(result.map((r) => r.field)).toEqual([
      "residual_income",
      "rep_split_pct",
    ]);
  });

  it("records the first edit, which is always null -> value", async () => {
    // The load-bearing case for `is distinct from` over `<>`. Both columns arrive
    // empty from an import, so with `<>` the trail would silently begin at the
    // SECOND correction and the original entry of every figure would be unrecorded.
    await editAsAdmin(
      db,
      `update rep_payout_rows set residual_income = 42.10 where id = ${fx.rowIds.blank}`,
    );

    const result = await history(db);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      field: "residual_income",
      old_value: null,
      new_value: "42.10",
    });
  });

  it("records a figure being cleared back to null", async () => {
    await editAsAdmin(
      db,
      `update rep_payout_rows set residual_income = null where id = ${fx.rowIds.filled}`,
    );

    const result = await history(db);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      old_value: "88.40",
      new_value: null,
    });
  });

  it("attributes a service-role write to nobody rather than to a person", async () => {
    // The commit step runs with no auth.uid(), so a round-trip import that fills in
    // figures is recorded as a server write — exactly the convention
    // audit_log.actor_id follows. Attributing it to some person would be worse than
    // leaving it null, because it would be a specific lie.
    await asPlatform(db);
    await db.exec(
      `update rep_payout_rows set residual_income = 77.00 where id = ${fx.rowIds.filled}`,
    );

    const result = await history(db);
    expect(result).toHaveLength(1);
    expect(result[0].changed_by).toBeNull();
  });
});

describe("it stays quiet about everything else", () => {
  it("writes nothing when neither figure changes", async () => {
    await editAsAdmin(
      db,
      `update rep_payout_rows set merchant_name = 'Renamed Co' where id = ${fx.rowIds.filled}`,
    );

    // The file-sourced columns change on every re-import by design. Recording them
    // would bury the entries that matter under the ones that don't.
    expect(await history(db)).toEqual([]);
  });

  it("writes nothing when a figure is set to the value it already has", async () => {
    // Re-saving an unchanged cell is what an inline editor does on every blur. A
    // history row for it would claim a correction that never happened.
    await editAsAdmin(
      db,
      `update rep_payout_rows set residual_income = 88.40 where id = ${fx.rowIds.filled}`,
    );

    expect(await history(db)).toEqual([]);
  });

  it("writes nothing on insert", async () => {
    // AFTER UPDATE only. An imported row's opening figures are not a correction,
    // and logging them would double the table for no information.
    await asPlatform(db);
    await db.exec(
      `insert into rep_payout_rows (agent_id, period, mid, residual_income, rep_split_pct)
       values ('${AGENT_ID}', '${PAYOUT_PERIOD}', 'MID-BRAND-NEW', 10.00, 50.00)`,
    );

    expect(await history(db)).toEqual([]);
  });

  it("writes no audit_log row, because the cross-agent trigger is not attached", async () => {
    // "We chose not to" and "we forgot" look identical in a schema, so this pins
    // the choice. log_cross_agent_change() would fire on every write to this table
    // — nobody but an admin can write it at all — turning one forty-row import into
    // forty audit_log rows, and it still could not say what a figure changed FROM.
    await editAsAdmin(
      db,
      `update rep_payout_rows set residual_income = 91.00 where id = ${fx.rowIds.filled}`,
    );

    await asPlatform(db);
    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from audit_log`,
    );
    expect(n).toBe(0);

    // And the trail is not simply missing — it went to the table that can hold a
    // before and an after.
    expect(await history(db)).toHaveLength(1);
  });

  it("has no trigger attached to the other three payout tables", async () => {
    await asPlatform(db);
    const result = await rows<{ tgrelid: string }>(
      db,
      `select c.relname as tgrelid
         from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
        where not t.tgisinternal
          and c.relname like 'rep_payout%'
        order by c.relname`,
    );

    // Only the ledger has triggers (the history one and set_updated_at). Batches,
    // staging and history itself have none — they carry no agent_id, so the
    // cross-agent function would read NULL and log every write, the same trap
    // support_ticket_replies needed its own function to avoid.
    expect(new Set(result.map((r) => r.tgrelid))).toEqual(
      new Set(["rep_payout_rows"]),
    );
  });
});

describe("it outlives what it describes", () => {
  it("survives its ledger row being deleted, and still reads", async () => {
    await editAsAdmin(
      db,
      `update rep_payout_rows set residual_income = 91.00 where id = ${fx.rowIds.filled}`,
    );

    await asPlatform(db);
    await db.exec(`delete from rep_payout_rows where id = ${fx.rowIds.filled}`);

    const result = await history(db);
    expect(result).toHaveLength(1);
    // The point of row_id carrying no foreign key, and of the three denormalised
    // columns: without them this would be a value change attached to an integer
    // that no longer resolves to anything.
    expect(result[0]).toMatchObject({
      row_id: fx.rowIds.filled,
      period: PAYOUT_PERIOD,
      agent_id: AGENT_ID,
      mid: "MID-AGENT-1",
      old_value: "88.40",
      new_value: "91.00",
    });
  });

  it("survives a whole period being deleted", async () => {
    // The admin escape hatch. Deleting a bad import must not also erase the record
    // that someone had entered figures against it.
    await editAsAdmin(
      db,
      `update rep_payout_rows set residual_income = 91.00 where id = ${fx.rowIds.filled}`,
    );
    await editAsAdmin(
      db,
      `update rep_payout_rows set rep_split_pct = 45.00 where id = ${fx.rowIds.other}`,
    );

    await asUser(db, ADMIN_ID);
    await db.exec(
      `delete from rep_payout_rows where period = '${PAYOUT_PERIOD}'`,
    );

    expect(await history(db)).toHaveLength(2);
  });

  it("does not stop a period being deleted", async () => {
    // The other half. `on delete restrict` would have made the period undeletable
    // once anyone had touched a figure on it — which is most periods.
    await editAsAdmin(
      db,
      `update rep_payout_rows set residual_income = 91.00 where id = ${fx.rowIds.filled}`,
    );

    await asUser(db, ADMIN_ID);
    await expect(
      db.exec(`delete from rep_payout_rows where period = '${PAYOUT_PERIOD}'`),
    ).resolves.not.toThrow();
  });
});

describe("a history failure rolls the edit back — fail closed, not silent", () => {
  it("refuses the UPDATE when the history insert is rejected", async () => {
    // The property the whole design rests on, asserted rather than assumed.
    //
    // AFTER ROW with no EXCEPTION block, so it runs inside the triggering
    // statement's transaction and any error propagates: the edit is rolled back
    // with it. A commission figure therefore cannot change while its trail quietly
    // does not.
    //
    // Provoked through the real failure mode — changed_by's foreign key to
    // profiles(id), exactly as audit-trigger.test.ts provokes actor_id's. A JWT
    // whose sub has no profiles row violates it. Reaching that needs the owner
    // role, because RLS would refuse such a caller's UPDATE long before the
    // trigger ran; that is why it is unreachable in production and still worth
    // pinning.
    const GHOST = "99999999-9999-9999-9999-999999999999";

    await db.exec(`reset role;`);
    await db.exec(
      `set request.jwt.claims = '${JSON.stringify({ sub: GHOST })}';`,
    );

    let failed = false;
    try {
      await db.exec(
        `update rep_payout_rows set residual_income = 500.00
          where id = ${fx.rowIds.filled}`,
      );
    } catch {
      failed = true;
    }

    expect(failed, "the history failure should have aborted the UPDATE").toBe(
      true,
    );

    // The assertion that distinguishes fail-closed from fail-silent: without the
    // rollback the residual would read 500.00 with nothing to show who changed it
    // or what it had been.
    await asPlatform(db);
    const [row] = await rows<{ v: string }>(
      db,
      `select residual_income::text as v from rep_payout_rows where id = ${fx.rowIds.filled}`,
    );
    expect(row.v).toBe("88.40");
    expect(await history(db)).toEqual([]);
  });
});

describe("the trigger cannot be defeated by the grants it runs against", () => {
  it("writes history even though authenticated holds no INSERT on that table", async () => {
    // This is why the function must be `security definer`. rep_payout_row_history
    // has no INSERT policy and no INSERT privilege for `authenticated`, so a
    // security invoker trigger would have its insert refused and would fail the
    // admin's UPDATE outright — turning the fail-closed design into a table nobody
    // could edit at all.
    await asPlatform(db);
    const [{ ok }] = await rows<{ ok: boolean }>(
      db,
      `select has_table_privilege('authenticated', 'rep_payout_row_history', 'INSERT') as ok`,
    );
    expect(ok, "authenticated must not hold INSERT on the history table").toBe(
      false,
    );

    await editAsAdmin(
      db,
      `update rep_payout_rows set residual_income = 91.00 where id = ${fx.rowIds.filled}`,
    );

    expect(await history(db)).toHaveLength(1);
  });

  it("is security definer, with a pinned search_path", async () => {
    await asPlatform(db);
    const [row] = await rows<{ prosecdef: boolean; def: string }>(
      db,
      `select p.prosecdef, pg_get_functiondef(p.oid) as def
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'log_payout_row_change'`,
    );

    expect(row.prosecdef).toBe(true);
    expect(row.def).toMatch(/search_path/);
    // And no exception handler. The rollback IS the design; wrapping the insert to
    // "stop a trigger breaking an edit" would silently reintroduce the gap.
    expect(row.def).not.toMatch(/exception\s+when/i);
  });

  it("is not granted to authenticated", async () => {
    // A trigger fires whether or not the querying role holds EXECUTE on its
    // function, so a grant would widen the surface for no benefit. Same treatment
    // as set_updated_at() and log_cross_agent_change().
    await asPlatform(db);
    const [{ ok }] = await rows<{ ok: boolean }>(
      db,
      `select has_function_privilege('authenticated', 'log_payout_row_change()', 'execute') as ok`,
    );
    expect(ok).toBe(false);
  });
});
