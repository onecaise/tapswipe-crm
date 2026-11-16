import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_ID,
  AGENT_ID,
  OTHER_AGENT_ID,
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
  stageForCommit,
  type TestDb,
} from "../helpers/db";
import { payoutMonthLabel } from "@/lib/payouts";

/**
 * 20261030190000 -- phase 9 of docs/design/intake-and-reports.md: Mark paid
 * and Reopen (A8), replace inside commit_residual_import_v3 (§3.2), the
 * audited period delete (§3.4) and the general adjustment (§3.3, A23).
 *
 *   1. Mark paid: the typed confirmation is checked in the database; one
 *      audit row per action, written by the table's trigger.
 *   2. Reopen: a written reason (10-500), carried to that ONE audit row
 *      through a transaction-local setting; no closure goes without one.
 *   3. Replace: atomic, refused once paid, refused under an adjustment,
 *      refused a second time; the old batch 'replaced' (final), its lines
 *      (shared ones included) gone, nothing else touched; two audit rows.
 *   4. The batch status rules: committed -> replaced / deleted only, both
 *      final, the client rule unchanged.
 *   5. The period delete: audited, refused when paid or under an
 *      adjustment, and a failed audit write undoes it.
 *   6. The general adjustment: paid months only, posted in the open month.
 *   7. Roles: a rep is refused every one (PT403), anon cannot call any.
 *   8. Grants and catalog; the client DELETE is gone.
 *   9. The migration over a populated database, and its refusals.
 *  10. Mutation proofs: each protection, removed, lets its case through.
 */

const MIGRATION = "20261030190000_replace_paid_adjustments.sql";
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
  } finally {
    await asPlatform(db);
  }
}

/** Runs `sql` as `who` (the admin by default) and returns the first column of the first row. */
async function call<T = unknown>(sql: string, who: string | null = ADMIN_ID): Promise<T> {
  await asUser(db, who);
  try {
    const result = await db.query<Record<string, T>>(`select ${sql} as v`);
    return result.rows[0]?.v as T;
  } finally {
    await asPlatform(db);
  }
}

const lit = (v: string | null) => (v === null ? "null" : `'${v.replace(/'/g, "''")}'`);
const label = (period: string) =>
  `${PROCESSOR} ${new Date(`${period}T00:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })}`;

/** A committed TSYS batch for a free month (or `period`), one line per MID. */
async function committed(
  mids: { mid: string; residual?: string }[] = [{ mid: "MID-AGENT-1" }, { mid: "MID-OTHER-1" }],
  period?: string,
): Promise<{ id: number; period: string }> {
  await asPlatform(db);
  const id = await insertBatch(db, {
    extra: { processor: `'${PROCESSOR}'`, period: period ? `'${period}'` : freeBatchMonth(PROCESSOR) },
  });
  await stageForCommit(db, id, mids);
  await commitV3(db, id);
  const [row] = await rows<{ period: string }>(db, `select period::text as period from rep_payout_batches where id = ${id}`);
  return { id, period: row.period };
}

/** A review batch that replaces `oldId`, staged with `mids`. */
async function replacement(oldId: number, mids: { mid: string; residual?: string }[]): Promise<number> {
  await asPlatform(db);
  const [old] = await rows<{ processor: string; period: string }>(
    db,
    `select processor, period::text as period from rep_payout_batches where id = ${oldId}`,
  );
  const id = await insertBatch(db, {
    fileName: "corrected.xlsx",
    extra: { processor: `'${old.processor}'`, period: `'${old.period}'`, replaces_batch_id: String(oldId) },
  });
  await stageForCommit(db, id, mids);
  return id;
}

const close = (period: string, typed = label(period)) =>
  call<string>(`close_payout_period('${period}', '${PROCESSOR}', ${lit(typed)})`);
const reopen = (period: string, reason: string | null) =>
  call(`reopen_payout_period('${period}', '${PROCESSOR}', ${lit(reason)})`);
const deletePeriod = (period: string, processor: string | null = PROCESSOR) =>
  call<{ deleted: number; batch_id: number | null }>(`delete_payout_period('${period}', ${lit(processor)})`);
const adjust = (args: { agent?: string; mid?: string; period: string; processor?: string; amount?: string; note?: string | null }) =>
  call<{ line_id: number; posting_period: string; amount: number }>(
    `post_payout_adjustment('${args.agent ?? AGENT_ID}', ${lit(args.mid ?? "MID-AGENT-1")}, '${args.period}',
                            ${lit(args.processor ?? PROCESSOR)}, ${args.amount ?? "-12.34"}, ${lit(args.note === undefined ? "Processor clawback after payment" : args.note)})`,
  );

async function audit(): Promise<{ actor_id: string | null; action: string; table_name: string; row_id: string; detail: string | null }[]> {
  await asPlatform(db);
  return rows(db, `select actor_id, action, table_name, row_id, detail from audit_log order by id`);
}

async function batchState(id: number) {
  await asPlatform(db);
  const [row] = await rows<{ status: string; replaced_by: number | null; replaces: number | null; file_key: string }>(
    db,
    `select status, replaced_by_batch_id as replaced_by, replaces_batch_id as replaces, file_key
       from rep_payout_batches where id = ${id}`,
  );
  return row;
}

async function linesOf(where: string) {
  await asPlatform(db);
  return rows<{ mid: string; agent_id: string; residual: string | null; batch_id: number | null; line_kind: string; share_role: string | null }>(
    db,
    `select mid, agent_id, residual_income::text as residual, batch_id, line_kind, share_role
       from rep_payout_rows where ${where} order by mid, share_role nulls first, id`,
  );
}

/** Makes every audit_log insert of `action` fail, as a broken audit write would. */
async function breakAudit(action: string): Promise<void> {
  await asPlatform(db);
  await db.exec(`alter table audit_log add constraint zz_broken_audit check (action <> '${action}') not valid`);
}

let db: TestDb;

beforeAll(async () => {
  db = await open();
});

beforeEach(async () => {
  await resetData(db);
  await asPlatform(db);
  // Closures belong to no profile, so resetData's cascade does not reach them;
  // TRUNCATE fires no row trigger, so it needs no reason.
  await db.exec(`truncate payout_period_closures;
                 alter table audit_log drop constraint if exists zz_broken_audit;
                 delete from audit_log;`);
});

// -------------------------------------------------------------------------
// 1. Mark paid
// -------------------------------------------------------------------------

describe("Mark paid (close_payout_period)", () => {
  it("closes a committed month on the typed processor and month, with exactly one audit row", async () => {
    const { period } = await committed();
    await db.exec(`delete from audit_log`);
    const closedAt = await close(period);
    expect(closedAt).not.toBeNull();
    expect(await rows(db, `select period::text as period, processor from payout_period_closures`)).toEqual([
      { period, processor: PROCESSOR },
    ]);
    expect(await audit()).toEqual([
      { actor_id: ADMIN_ID, action: "close_payout_period", table_name: "payout_period_closures", row_id: `${period}/${PROCESSOR}`, detail: null },
    ]);
  });

  it("the phrase the page shows (payoutMonthLabel) is the phrase the database accepts, every month", async () => {
    // Two copies of one rule: lib/payouts.ts builds what the admin is told to
    // type; close_payout_period builds what it compares with. Pinned here.
    const months = await rows<{ period: string; phrase: string }>(
      db,
      `select m::date::text as period, 'TSYS ' || to_char(m, 'FMMonth YYYY') as phrase
         from generate_series('2026-01-01'::date, '2026-12-01'::date, interval '1 month') as m`,
    );
    expect(months).toHaveLength(12);
    for (const { period, phrase } of months) expect(payoutMonthLabel("TSYS", period), period).toBe(phrase);
    expect(label("2026-07-01")).toBe(payoutMonthLabel(PROCESSOR, "2026-07-01"));
  });

  it("accepts the phrase in any case and spacing", async () => {
    const { period } = await committed();
    await close(period, `  ${label(period).toUpperCase().replace(" ", "   ")} `);
    expect(await rows(db, `select count(*)::int as n from payout_period_closures`)).toEqual([{ n: 1 }]);
  });

  it.each([
    ["blank", ""],
    ["no confirmation at all", null],
    ["the wrong processor", "Square"],
    ["just 'yes'", "yes"],
  ])("refuses a typed confirmation that is %s (PT400), writing nothing", async (_l, typed) => {
    const { period } = await committed();
    await db.exec(`delete from audit_log`);
    const error = await attempt(() => close(period, typed === "Square" ? label(period).replace(PROCESSOR, "Square") : (typed as string)));
    expect(error?.code).toBe("PT400");
    expect(error?.message).toBe(`To mark it paid, type ${label(period)} exactly.`);
    expect(await rows(db, `select count(*)::int as n from payout_period_closures`)).toEqual([{ n: 0 }]);
    expect(await audit()).toEqual([]);
  });

  it("refuses a month with nothing committed, a month already paid, an unknown processor and a date not on the 1st", async () => {
    const free = (await rows<{ m: string }>(db, `select ${freeBatchMonth(PROCESSOR)}::text as m`))[0].m;
    expect((await attempt(() => close(free)))?.message).toBe(`Nothing is committed for ${label(free)}, so there is nothing to mark paid.`);

    const { period } = await committed();
    await close(period);
    const again = await attempt(() => close(period));
    expect(again?.code).toBe("PT409");
    expect(again?.message).toMatch(new RegExp(`^${label(period)} was already marked paid on `));

    expect((await attempt(() => call(`close_payout_period('${period}', 'Nope', 'Nope')`)))?.code).toBe("PT404");
    expect((await attempt(() => call(`close_payout_period('2026-07-02', '${PROCESSOR}', 'x')`)))?.code).toBe("22023");
  });

  it("is the only way in: no client may insert, update or delete a closure", async () => {
    const { period } = await committed();
    await close(period);
    for (const sql of [
      `insert into payout_period_closures (period, processor) values ('2026-01-01', 'Square')`,
      `update payout_period_closures set closed_at = now()`,
      `delete from payout_period_closures`,
    ]) {
      await asUser(db, ADMIN_ID);
      const error = await attempt(() => db.exec(sql));
      expect(error?.message, sql).toMatch(/permission denied for table payout_period_closures/);
    }
  });
});

// -------------------------------------------------------------------------
// 2. Reopen
// -------------------------------------------------------------------------

describe("Reopen (reopen_payout_period)", () => {
  it("reopens with a reason that reaches the ONE audit row of the reopen", async () => {
    const { period } = await committed();
    await close(period);
    await db.exec(`delete from audit_log`);
    await reopen(period, "   The processor re-sent July with corrected Square fees.  ");
    expect(await rows(db, `select count(*)::int as n from payout_period_closures`)).toEqual([{ n: 0 }]);
    expect(await audit()).toEqual([
      {
        actor_id: ADMIN_ID,
        action: "reopen_payout_period",
        table_name: "payout_period_closures",
        row_id: `${period}/${PROCESSOR}`,
        detail: "The processor re-sent July with corrected Square fees.",
      },
    ]);
  });

  it("one row per action across a close, a reopen and a second close", async () => {
    const { period } = await committed();
    await db.exec(`delete from audit_log`);
    await close(period);
    await reopen(period, "Wrong month was marked paid.");
    await close(period);
    expect((await audit()).map((a) => [a.action, a.detail])).toEqual([
      ["close_payout_period", null],
      ["reopen_payout_period", "Wrong month was marked paid."],
      ["close_payout_period", null],
    ]);
  });

  it("leaves the reason setting cleared after the reopen, in the same transaction", async () => {
    const { period } = await committed();
    await close(period);
    await asUser(db, ADMIN_ID);
    const result = await db.query<{ v: string | null }>(
      `select reopen_payout_period('${period}', '${PROCESSOR}', 'A long enough reason.') is null as done,
              current_setting('tapswipe.reopen_reason', true) as v`,
    );
    await asPlatform(db);
    expect(result.rows[0].v ?? "").toBe("");
  });

  it.each([
    ["blank", "   "],
    ["no reason", null],
    ["under 10 characters", "oops     "],
    ["over 500 characters", "x".repeat(501)],
  ])("refuses a reason that is %s (22023), leaving the month paid", async (_l, reason) => {
    const { period } = await committed();
    await close(period);
    const error = await attempt(() => reopen(period, reason));
    expect(error?.code).toBe("22023");
    expect(await rows(db, `select count(*)::int as n from payout_period_closures`)).toEqual([{ n: 1 }]);
  });

  it("accepts exactly 10 and exactly 500 characters", async () => {
    const { period } = await committed();
    await close(period);
    await reopen(period, "0123456789");
    await close(period);
    await reopen(period, "y".repeat(500));
    expect(await rows(db, `select count(*)::int as n from payout_period_closures`)).toEqual([{ n: 0 }]);
  });

  it("refuses a month that is not marked paid (PT404)", async () => {
    const { period } = await committed();
    expect((await attempt(() => reopen(period, "Nothing to reopen here.")))?.code).toBe("PT404");
  });

  it("no closure goes without a reason: even the owner's direct DELETE is refused by the trigger", async () => {
    const { period } = await committed();
    await close(period);
    const error = await attempt(() => db.exec(`delete from payout_period_closures`));
    expect(error?.code).toBe("PT409");
    expect(error?.message).toBe("A paid month is reopened only with a written reason (reopen_payout_period).");
    expect(await rows(db, `select count(*)::int as n from payout_period_closures`)).toEqual([{ n: 1 }]);
  });

  it("fails closed: a failed audit write undoes the close and the reopen", async () => {
    const { period } = await committed();
    await breakAudit("close_payout_period");
    expect(await attempt(() => close(period))).not.toBeNull();
    expect(await rows(db, `select count(*)::int as n from payout_period_closures`)).toEqual([{ n: 0 }]);
    await db.exec(`alter table audit_log drop constraint zz_broken_audit`);
    await close(period);
    await breakAudit("reopen_payout_period");
    expect(await attempt(() => reopen(period, "This reopen must not stick."))).not.toBeNull();
    expect(await rows(db, `select count(*)::int as n from payout_period_closures`)).toEqual([{ n: 1 }]);
  });
});

// -------------------------------------------------------------------------
// 3. Replace
// -------------------------------------------------------------------------

describe("replace (commit_residual_import_v3 on a replacement batch)", () => {
  it("swaps the month atomically: old lines gone, new lines in, old batch replaced, two audit rows", async () => {
    const old = await committed([{ mid: "MID-AGENT-1", residual: "100.00" }, { mid: "MID-OTHER-1", residual: "40.00" }]);
    const next = await replacement(old.id, [{ mid: "MID-AGENT-1", residual: "90.00" }]);
    await db.exec(`delete from audit_log`);

    const result = await commitV3(db, next);
    expect(result).toEqual({ written: 1, rows: 1, shared: 0, overrides: 0, company_overrides: 0, replaced_lines: 2 });

    expect(await linesOf(`period = '${old.period}' and processor = '${PROCESSOR}'`)).toEqual([
      { mid: "MID-AGENT-1", agent_id: AGENT_ID, residual: "90.00", batch_id: next, line_kind: "import", share_role: null },
    ]);
    expect(await batchState(old.id)).toMatchObject({ status: "replaced", replaced_by: next });
    expect(await batchState(next)).toMatchObject({ status: "committed", replaces: old.id });
    expect(await audit()).toEqual([
      { actor_id: ADMIN_ID, action: "commit_residual_import", table_name: "rep_payout_batches", row_id: String(next), detail: null },
      { actor_id: ADMIN_ID, action: "replace_residual_import", table_name: "rep_payout_batches", row_id: String(old.id), detail: null },
    ]);
  });

  it("keeps the old file: the replaced batch's file key is untouched", async () => {
    const old = await committed();
    const before = (await batchState(old.id)).file_key;
    await commitV3(db, await replacement(old.id, [{ mid: "MID-AGENT-1" }]));
    expect((await batchState(old.id)).file_key).toBe(before);
  });

  it("removes the shared lines derived from the old file and rebuilds them from the new one", async () => {
    const { period } = await committed([{ mid: "MID-OTHER-1" }]);
    // A share on MID-AGENT-1 covering a fresh month, then that month committed.
    const [{ m }] = await rows<{ m: string }>(db, `select ${freeBatchMonth(PROCESSOR)}::text as m`);
    void period;
    await db.exec(`insert into merchant_rep_shares (merchant_id, primary_agent_id, secondary_agent_id,
                                                    primary_rep_pct, secondary_rep_pct, effective_from)
                   values ((select id from merchants where mid = 'MID-AGENT-1'), '${AGENT_ID}', '${OTHER_AGENT_ID}', 40, 10, '${m}')`);
    const old = await committed([{ mid: "MID-AGENT-1", residual: "100.00" }], m);
    expect((await linesOf(`batch_id = ${old.id}`)).map((l) => l.share_role)).toEqual(["primary", "secondary"]);

    const next = await replacement(old.id, [{ mid: "MID-AGENT-1", residual: "10.00" }]);
    expect((await commitV3(db, next)).replaced_lines).toBe(2);
    expect(await linesOf(`period = '${m}' and processor = '${PROCESSOR}'`)).toEqual([
      { mid: "MID-AGENT-1", agent_id: AGENT_ID, residual: "8.00", batch_id: next, line_kind: "import", share_role: "primary" },
      { mid: "MID-AGENT-1", agent_id: OTHER_AGENT_ID, residual: "2.00", batch_id: next, line_kind: "import", share_role: "secondary" },
    ]);
  });

  it("touches nothing else: another processor's lines, adjustment lines and other months stay", async () => {
    const other = await committed([{ mid: "MID-OTHER-1" }]);
    const old = await committed([{ mid: "MID-AGENT-1" }]);
    // Square paid a different MID in the same month; an adjustment was POSTED
    // in the month (it adjusts another one).
    await db.exec(`
      insert into rep_payout_rows (agent_id, period, processor, mid, residual_income, rep_split_pct)
      values ('${OTHER_AGENT_ID}', '${old.period}', 'Square', 'SQ-ELSEWHERE', 5.00, 50);
      insert into rep_payout_rows (agent_id, period, mid, line_kind, adjustment_amount, adjusts_period, adjustment_note)
      values ('${AGENT_ID}', '${old.period}', 'MID-AGENT-1', 'adjustment', -1.00, '${other.period}', 'An older correction')`);
    const keep = await linesOf(`not (period = '${old.period}' and processor = '${PROCESSOR}' and line_kind = 'import')`);

    await commitV3(db, await replacement(old.id, [{ mid: "MID-AGENT-1", residual: "1.00" }]));
    expect(await linesOf(`not (period = '${old.period}' and processor = '${PROCESSOR}' and line_kind = 'import')`)).toEqual(keep);
  });

  it("is refused once the month is marked paid, and nothing changes", async () => {
    const old = await committed();
    await close(old.period);
    const next = await replacement(old.id, [{ mid: "MID-AGENT-1", residual: "1.00" }]);
    const lines = await linesOf(`batch_id = ${old.id}`);
    const error = await attempt(() => commitV3(db, next));
    expect(error?.code).toBe("PT409");
    expect(error?.message).toBe(`${PROCESSOR} for ${label(old.period).slice(PROCESSOR.length + 1)} is marked paid and cannot be replaced. Reopen it (with a reason), or post an adjustment instead.`);
    expect(await linesOf(`batch_id = ${old.id}`)).toEqual(lines);
    expect(await batchState(old.id)).toMatchObject({ status: "committed", replaced_by: null });
    expect(await batchState(next)).toMatchObject({ status: "review" });
  });

  it("goes through once an admin reopens the month (with a reason)", async () => {
    const old = await committed();
    await close(old.period);
    await reopen(old.period, "Processor sent a corrected file.");
    expect((await commitV3(db, await replacement(old.id, [{ mid: "MID-AGENT-1" }]))).replaced_lines).toBe(2);
  });

  it("is refused while an adjustment adjusts that month: a share correction on one of its MIDs", async () => {
    const old = await committed();
    // The share correction's pair, as post_share_correction posts it.
    await db.exec(`insert into rep_payout_rows (agent_id, period, mid, line_kind, adjustment_amount, adjusts_period, adjustment_note)
                   values ('${OTHER_AGENT_ID}', '2099-01-01', 'MID-AGENT-1', 'adjustment', 5.00, '${old.period}', 'Share agreed late'),
                          ('${AGENT_ID}', '2099-01-01', 'MID-AGENT-1', 'adjustment', -5.00, '${old.period}', 'Share agreed late')`);
    const next = await replacement(old.id, [{ mid: "MID-AGENT-1" }]);
    const error = await attempt(() => commitV3(db, next));
    expect(error?.code).toBe("PT409");
    expect(error?.message).toMatch(/^Adjustments already correct TSYS for .* \(MIDs MID-AGENT-1\)\. They were worked out from the committed figures/);
    expect(await batchState(old.id)).toMatchObject({ status: "committed" });
  });

  it("is refused while a general adjustment adjusts that month (posted when it was paid)", async () => {
    const old = await committed();
    await close(old.period);
    await adjust({ period: old.period, mid: "MID-OTHER-1", agent: OTHER_AGENT_ID });
    await reopen(old.period, "Need to look at the file again.");
    const next = await replacement(old.id, [{ mid: "MID-AGENT-1" }]);
    const error = await attempt(() => commitV3(db, next));
    expect(error?.message).toMatch(/^Adjustments already correct .*\(MIDs MID-OTHER-1\)/);
  });

  it("an adjustment on another month, or on a MID and processor this batch never paid, does not block it", async () => {
    const old = await committed([{ mid: "MID-AGENT-1" }]);
    await db.exec(`insert into rep_payout_rows (agent_id, period, mid, line_kind, adjustment_amount, adjusts_period, adjustment_note)
                   values ('${AGENT_ID}', '2099-01-01', 'MID-AGENT-1', 'adjustment', 1.00, '2026-01-01', 'Other month'),
                          ('${OTHER_AGENT_ID}', '2099-01-01', 'MID-OTHER-2', 'adjustment', 1.00, '${old.period}', 'Other MID, no processor')`);
    expect((await commitV3(db, await replacement(old.id, [{ mid: "MID-AGENT-1" }]))).replaced_lines).toBe(1);
  });

  it("is refused a second time: two replacements of one batch, the second finds it replaced", async () => {
    const old = await committed();
    const first = await replacement(old.id, [{ mid: "MID-AGENT-1" }]);
    const second = await replacement(old.id, [{ mid: "MID-OTHER-1" }]);
    await commitV3(db, first);
    const error = await attempt(() => commitV3(db, second));
    expect(error?.code).toBe("PT409");
    expect(error?.message).toBe(
      `This file was uploaded to replace import #${old.id}, which is no longer the committed import for ${PROCESSOR} for ${label(old.period).slice(PROCESSOR.length + 1)}. Abandon it and upload the file again.`,
    );
    expect(await linesOf(`period = '${old.period}' and processor = '${PROCESSOR}'`)).toHaveLength(1);
  });

  it("a second file for a committed month that is NOT a replacement is refused, saying how to replace", async () => {
    const old = await committed();
    const id = await insertBatch(db, { extra: { processor: `'${PROCESSOR}'`, period: `'${old.period}'` } });
    await stageForCommit(db, id, [{ mid: "MID-AGENT-1" }]);
    const error = await attempt(() => commitV3(db, id));
    expect(error?.message).toBe(
      `${PROCESSOR} for ${label(old.period).slice(PROCESSOR.length + 1)} is already committed (import #${old.id}). A second file for that month replaces it: upload it again and answer Yes to replace.`,
    );
  });

  it("still re-derives every refusal and warning: an unconfirmed warning refuses the replace and changes nothing", async () => {
    const old = await committed();
    const next = await replacement(old.id, [{ mid: "MID-AGENT-1", residual: "-3.00" }]);
    // A negative volume: a bad number (zero volume is not one since 20261104120000).
    await db.exec(`update rep_payout_import_rows set volume = -5 where batch_id = ${next}`);
    const error = await attempt(() => commitV3(db, next));
    expect(error?.message).toMatch(/^These warnings were not confirmed: bad numbers/);
    expect(await batchState(old.id)).toMatchObject({ status: "committed" });
    expect(await linesOf(`batch_id = ${old.id}`)).toHaveLength(2);
  });
});

// -------------------------------------------------------------------------
// 4. Batch status rules
// -------------------------------------------------------------------------

describe("batch status: committed -> replaced or deleted only, both final", () => {
  const setStatus = (id: number, set: string) => attempt(() => db.exec(`update rep_payout_batches set ${set} where id = ${id}`));

  it("a review or abandoned batch cannot become replaced or deleted, even as the owner", async () => {
    const review = await insertBatch(db);
    const abandoned = await insertBatch(db, { status: "abandoned" });
    const other = await insertBatch(db);
    for (const id of [review, abandoned]) {
      expect((await setStatus(id, `status = 'replaced', replaced_by_batch_id = ${other}`))?.message).toMatch(/^Only a committed import can become replaced/);
      expect((await setStatus(id, `status = 'deleted'`))?.message).toMatch(/^Only a committed import can become deleted/);
    }
  });

  it("a replaced or deleted batch is final: no change of any kind", async () => {
    const old = await committed();
    const next = await replacement(old.id, [{ mid: "MID-AGENT-1" }]);
    await commitV3(db, next);
    const gone = await committed([{ mid: "MID-AGENT-1" }]);
    await deletePeriod(gone.period);
    for (const id of [old.id, gone.id]) {
      for (const set of [`status = 'committed', replaced_by_batch_id = null`, `file_name = 'renamed.xlsx'`, `status = 'review', replaced_by_batch_id = null`]) {
        const error = await setStatus(id, set);
        expect(error?.code, `${id}: ${set}`).toBe("PT409");
        expect(error?.message).toMatch(/That is final: nothing about it changes\.$/);
      }
    }
  });

  it("the client rule is unchanged: a signed-in admin can only abandon a review batch", async () => {
    const old = await committed();
    const other = await insertBatch(db);
    await asUser(db, ADMIN_ID);
    const error = await attempt(() =>
      db.exec(`update rep_payout_batches set status = 'deleted' where id = ${old.id}`),
    );
    expect(error?.message).toMatch(/^Only an import still in review can be changed here/);
    await asUser(db, ADMIN_ID);
    expect((await attempt(() => db.exec(`update rep_payout_batches set status = 'abandoned' where id = ${other}`)))).toBeNull();
  });
});

// -------------------------------------------------------------------------
// 5. The period delete
// -------------------------------------------------------------------------

describe("delete_payout_period", () => {
  it("deletes the processor-month's import lines, marks its batch deleted, and writes one audit row", async () => {
    const old = await committed();
    await db.exec(`
      insert into rep_payout_rows (agent_id, period, processor, mid, residual_income, rep_split_pct)
      values ('${OTHER_AGENT_ID}', '${old.period}', 'Square', 'SQ-ELSEWHERE', 5.00, 50);
      insert into rep_payout_rows (agent_id, period, mid, line_kind, adjustment_amount, adjusts_period, adjustment_note)
      values ('${AGENT_ID}', '${old.period}', 'MID-AGENT-1', 'adjustment', -1.00, '2026-01-01', 'Posted in this month')`);
    await db.exec(`delete from audit_log`);

    expect(await deletePeriod(old.period)).toEqual({ deleted: 2, batch_id: old.id });
    expect(await linesOf(`period = '${old.period}'`)).toEqual([
      { mid: "MID-AGENT-1", agent_id: AGENT_ID, residual: null, batch_id: null, line_kind: "adjustment", share_role: null },
      { mid: "SQ-ELSEWHERE", agent_id: OTHER_AGENT_ID, residual: "5.00", batch_id: null, line_kind: "import", share_role: null },
    ]);
    expect(await batchState(old.id)).toMatchObject({ status: "deleted" });
    expect(await audit()).toEqual([
      { actor_id: ADMIN_ID, action: "delete_payout_period", table_name: "rep_payout_rows", row_id: `${old.period}/${PROCESSOR}`, detail: `2 lines; import #${old.id}` },
    ]);
  });

  it("frees the processor-month: a new file for it commits as a first import", async () => {
    const old = await committed();
    await deletePeriod(old.period);
    const again = await committed([{ mid: "MID-AGENT-1" }], old.period);
    expect(await batchState(again.id)).toMatchObject({ status: "committed" });
  });

  it("deletes the lines committed before processors were recorded, with a NULL processor", async () => {
    await db.exec(`insert into rep_payout_rows (agent_id, period, mid, residual_income, rep_split_pct)
                   values ('${AGENT_ID}', '2026-03-01', 'LEGACY-1', 1.00, 50), ('${AGENT_ID}', '2026-03-01', 'LEGACY-2', 1.00, 50)`);
    await db.exec(`delete from audit_log`);
    expect(await deletePeriod("2026-03-01", null)).toEqual({ deleted: 2, batch_id: null });
    expect((await audit()).map((a) => [a.row_id, a.detail])).toEqual([["2026-03-01/none", "2 lines"]]);
  });

  it("is refused for a paid month, and nothing changes", async () => {
    const old = await committed();
    await close(old.period);
    const error = await attempt(() => deletePeriod(old.period));
    expect(error?.code).toBe("PT409");
    expect(error?.message).toMatch(/is marked paid and cannot be deleted\. Reopen it \(with a reason\) first, or post an adjustment instead\.$/);
    expect(await linesOf(`batch_id = ${old.id}`)).toHaveLength(2);
    expect(await batchState(old.id)).toMatchObject({ status: "committed" });
  });

  it("is refused while an adjustment adjusts the month, and when there is nothing to delete", async () => {
    const old = await committed();
    await db.exec(`insert into rep_payout_rows (agent_id, period, mid, line_kind, adjustment_amount, adjusts_period, adjustment_note)
                   values ('${AGENT_ID}', '2099-01-01', 'MID-OTHER-1', 'adjustment', 2.00, '${old.period}', 'Correction')`);
    const error = await attempt(() => deletePeriod(old.period));
    expect(error?.message).toMatch(/\(MIDs MID-OTHER-1\)\. They were worked out from these lines/);
    expect(await linesOf(`batch_id = ${old.id}`)).toHaveLength(2);
    expect((await attempt(() => deletePeriod("2026-02-01")))?.code).toBe("PT404");
  });

  it("fails closed: a failed audit write undoes the delete", async () => {
    const old = await committed();
    await breakAudit("delete_payout_period");
    expect(await attempt(() => deletePeriod(old.period))).not.toBeNull();
    expect(await linesOf(`batch_id = ${old.id}`)).toHaveLength(2);
    expect(await batchState(old.id)).toMatchObject({ status: "committed" });
  });

  it("the client path is closed: an admin's direct DELETE of ledger lines is refused", async () => {
    await committed();
    await asUser(db, ADMIN_ID);
    const error = await attempt(() => db.exec(`delete from rep_payout_rows`));
    expect(error?.message).toMatch(/permission denied for table rep_payout_rows/);
    expect((await linesOf("true")).length).toBeGreaterThan(0);
  });
});

// -------------------------------------------------------------------------
// 6. The general adjustment
// -------------------------------------------------------------------------

describe("post_payout_adjustment", () => {
  it("adds one adjustment line for a paid month, posted in the open month, and audits it", async () => {
    const old = await committed();
    await close(old.period);
    await db.exec(`delete from audit_log`);
    const result = await adjust({ period: old.period, amount: "-12.34" });
    const [{ open: posting }] = await rows<{ open: string }>(
      db,
      `select ((max(period) + interval '1 month')::date)::text as open from rep_payout_rows where line_kind = 'import'`,
    );
    expect(result).toMatchObject({ posting_period: posting, amount: -12.34 });
    expect(posting > old.period).toBe(true);
    expect(
      await rows(
        db,
        `select agent_id, period::text as period, processor, mid, merchant_name, line_kind,
                adjustment_amount::text as amount, adjusts_period::text as adjusts, adjustment_note as note,
                rep_payout::text as payout, batch_id
           from rep_payout_rows where id = ${result.line_id}`,
      ),
    ).toEqual([
      {
        agent_id: AGENT_ID, period: posting, processor: PROCESSOR, mid: "MID-AGENT-1", merchant_name: "Agent Active Co",
        line_kind: "adjustment", amount: "-12.34", adjusts: old.period, note: "Processor clawback after payment",
        payout: "-12.34", batch_id: null,
      },
    ]);
    expect(await audit()).toEqual([
      { actor_id: ADMIN_ID, action: "post_payout_adjustment", table_name: "rep_payout_rows", row_id: String(result.line_id), detail: null },
    ]);
  });

  it("is refused for a month that is not marked paid: that is a replace", async () => {
    const old = await committed();
    const error = await attempt(() => adjust({ period: old.period }));
    expect(error?.code).toBe("PT409");
    expect(error?.message).toBe(`${label(old.period)} is not marked paid. Until it is, a correction is a replace: upload the corrected file for that month.`);
    expect(await linesOf(`line_kind = 'adjustment'`)).toEqual([]);
  });

  it.each([
    ["a zero amount", { amount: "0" }, "22023"],
    ["three decimals", { amount: "1.005" }, "22023"],
    ["a blank reason", { note: "   " }, "22023"],
    ["no reason", { note: null }, "22023"],
    ["a reason over 500 characters", { note: "z".repeat(501) }, "22023"],
    ["a month not on the 1st", { period: "2026-07-02" }, "22023"],
    ["an unknown MID", { mid: "NOPE" }, "PT404"],
    ["an unknown payee", { agent: "44444444-4444-4444-4444-444444444444" }, "PT404"],
  ])("refuses %s (%s) and writes nothing", async (_l, args, code) => {
    const old = await committed();
    await close(old.period);
    const error = await attempt(() => adjust({ period: old.period, ...(args as object) }));
    expect(error?.code).toBe(code);
    expect(await linesOf(`line_kind = 'adjustment'`)).toEqual([]);
  });

  it("refuses a deactivated payee", async () => {
    const old = await committed();
    await close(old.period);
    await db.exec(`update profiles set is_active = false where id = '${OTHER_AGENT_ID}'`);
    const error = await attempt(() => adjust({ period: old.period, agent: OTHER_AGENT_ID }));
    expect(error?.code).toBe("PT409");
    expect(error?.message).toBe("Other Agent is deactivated, so an adjustment cannot name them.");
  });

  it("each rep reads their own adjustment line and not another rep's", async () => {
    const old = await committed();
    await close(old.period);
    await adjust({ period: old.period, agent: AGENT_ID, note: "For the agent" });
    await adjust({ period: old.period, agent: OTHER_AGENT_ID, mid: "MID-OTHER-1", note: "For the other agent" });
    for (const [who, note] of [[AGENT_ID, "For the agent"], [OTHER_AGENT_ID, "For the other agent"]]) {
      await asUser(db, who);
      const seen = await rows<{ note: string }>(db, `select adjustment_note as note from rep_payout_rows where line_kind = 'adjustment'`);
      await asPlatform(db);
      expect(seen).toEqual([{ note }]);
    }
  });

  it("fails closed: a failed audit write leaves no line", async () => {
    const old = await committed();
    await close(old.period);
    await breakAudit("post_payout_adjustment");
    expect(await attempt(() => adjust({ period: old.period }))).not.toBeNull();
    expect(await linesOf(`line_kind = 'adjustment'`)).toEqual([]);
  });

  it("post_share_correction is kept, and posts in the same open month", async () => {
    const old = await committed([{ mid: "MID-AGENT-1", residual: "100.00" }, { mid: "MID-OTHER-1" }]);
    await close(old.period);
    const general = await adjust({ period: old.period, mid: "MID-OTHER-1", agent: OTHER_AGENT_ID });
    const share = await call<{ posting_period: string }>(
      `post_share_correction((select id from merchants where mid = 'MID-AGENT-1'), '${old.period}', '${OTHER_AGENT_ID}', 25, 25, 'Agreed late')`,
    );
    expect(share.posting_period).toBe(general.posting_period);
  });

  it("post_share_correction, unchanged, counts a general adjustment on the same MID and month as a correction already posted", async () => {
    // Kept as it was (memo §2.1: post_share_correction unchanged). Its
    // double-post guard reads every adjustment line on the MID and month, so
    // a general adjustment there refuses a later share correction. The safe
    // side: neither can pay twice. Its sentence predates general adjustments.
    const old = await committed([{ mid: "MID-AGENT-1", residual: "100.00" }]);
    await close(old.period);
    await adjust({ period: old.period });
    const error = await attempt(() =>
      call(`post_share_correction((select id from merchants where mid = 'MID-AGENT-1'), '${old.period}', '${OTHER_AGENT_ID}', 25, 25, 'Agreed late')`),
    );
    expect(error?.message).toMatch(/^A correction for MID MID-AGENT-1, .* has already been posted\.$/);
  });
});

// -------------------------------------------------------------------------
// 7. Roles
// -------------------------------------------------------------------------

describe("roles: a rep is refused every one of them, anon cannot call any", () => {
  const CALLS = [
    "close_payout_period('2026-07-01', 'TSYS', 'TSYS July 2026')",
    "reopen_payout_period('2026-07-01', 'TSYS', 'A reason long enough')",
    "delete_payout_period('2026-07-01', 'TSYS')",
    "post_payout_adjustment('22222222-2222-2222-2222-222222222222', 'MID-AGENT-1', '2026-07-01', 'TSYS', 1.00, 'note')",
  ];

  it.each(CALLS)("a rep: %s is PT403 'admin only'", async (sql) => {
    const error = await attempt(() => call(sql, AGENT_ID));
    expect(error?.code).toBe("PT403");
    expect(error?.message).toBe("admin only");
  });

  it.each(CALLS)("anon: %s is not executable", async (sql) => {
    await asUser(db, null);
    await db.exec(`set role anon`);
    const error = await attempt(() => db.query(`select ${sql}`));
    expect(error?.message).toMatch(/permission denied for function/);
  });

  it("a rep cannot commit a replacement either", async () => {
    const old = await committed();
    const next = await replacement(old.id, [{ mid: "MID-AGENT-1" }]);
    const error = await attempt(() => call(`commit_residual_import_v3(${next}, '{}')`, AGENT_ID));
    expect(error?.code).toBe("PT403");
    expect(await batchState(old.id)).toMatchObject({ status: "committed" });
  });
});

// -------------------------------------------------------------------------
// 8. Grants and catalog
// -------------------------------------------------------------------------

describe("grants and catalog", () => {
  const SIGS = [
    "close_payout_period(date, text, text)",
    "reopen_payout_period(date, text, text)",
    "delete_payout_period(date, text)",
    "post_payout_adjustment(uuid, text, date, text, numeric, text)",
  ];

  it.each(SIGS)("%s: definer, search_path pinned, is_admin() first; authenticated and service_role, never anon", async (sig) => {
    const [fn] = await rows<{ definer: boolean; config: string[]; body: string }>(
      db,
      `select prosecdef as definer, proconfig as config, prosrc as body from pg_proc where oid = '${sig}'::regprocedure`,
    );
    expect(fn.definer).toBe(true);
    expect(fn.config).toEqual(["search_path=public, pg_temp"]);
    expect(fn.body.trimStart()).toMatch(/^declare[\s\S]*?begin\s+if not is_admin\(\) then\s+raise exception 'admin only' using errcode = 'PT403';/);
    expect(
      await rows(
        db,
        `select r as role, has_function_privilege(r, '${sig}', 'execute') as ok
           from unnest(array['anon', 'authenticated', 'service_role']) as r`,
      ),
    ).toEqual([
      { role: "anon", ok: false },
      { role: "authenticated", ok: true },
      { role: "service_role", ok: true },
    ]);
  });

  it("every function that touches one month takes the processor-month lock", async () => {
    for (const name of ["close_payout_period", "reopen_payout_period", "delete_payout_period", "post_payout_adjustment", "commit_residual_import_v3"]) {
      const [{ body }] = await rows<{ body: string }>(db, `select prosrc as body from pg_proc where proname = '${name}'`);
      expect(body, name).toContain("'tapswipe.residual_month:'");
    }
  });

  it("the ledger has no client DELETE: no grant, no policy", async () => {
    expect(
      await rows(db, `select has_table_privilege('authenticated', 'rep_payout_rows', 'delete') as ok`),
    ).toEqual([{ ok: false }]);
    expect(
      await rows(db, `select polname from pg_policy where polrelid = 'public.rep_payout_rows'::regclass and polcmd = 'd'`),
    ).toEqual([]);
  });

  it("audit_log.detail exists, nullable, at most 1000 characters; authenticated still only reads audit_log", async () => {
    expect(
      await rows(
        db,
        `select is_nullable from information_schema.columns where table_name = 'audit_log' and column_name = 'detail'`,
      ),
    ).toEqual([{ is_nullable: "YES" }]);
    const error = await attempt(() =>
      db.exec(`insert into audit_log (action, detail) values ('x', repeat('d', 1001))`),
    );
    expect(error?.message).toMatch(/audit_log_detail_length/);
    expect(
      await rows(
        db,
        `select p as privilege, has_table_privilege('authenticated', 'audit_log', p) as ok
           from unnest(array['select', 'insert', 'update', 'delete']) as p`,
      ),
    ).toEqual([
      { privilege: "select", ok: true },
      { privilege: "insert", ok: false },
      { privilege: "update", ok: false },
      { privilege: "delete", ok: false },
    ]);
  });

  it("the batch status vocabulary gains 'deleted'", async () => {
    expect(
      await rows(
        db,
        `select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'rep_payout_batches_status_check'`,
      ),
    ).toEqual([{ def: "CHECK ((status = ANY (ARRAY['review'::text, 'committed'::text, 'abandoned'::text, 'replaced'::text, 'deleted'::text])))" }]);
  });
});

// -------------------------------------------------------------------------
// 9. The migration over existing rows
// -------------------------------------------------------------------------

describe("the migration over a populated database", () => {
  async function populated(): Promise<TestDb> {
    const target = await open(await migrationsBefore(MIGRATION));
    await resetData(target);
    await asPlatform(target);
    return target;
  }

  const snapshot = async (target: TestDb) => {
    await asPlatform(target);
    return {
      batches: await rows(target, `select to_jsonb(b) as j from rep_payout_batches b order by id`),
      lines: await rows(target, `select to_jsonb(l) as j from rep_payout_rows l order by id`),
      closures: await rows(target, `select to_jsonb(c) as j from payout_period_closures c order by period`),
      audit: await rows(target, `select id, action, row_id from audit_log order by id`),
    };
  };

  it("applies over batches in every state, ledger lines and a closure, changing no row", async () => {
    const target = await populated();
    const saved = db;
    db = target;
    try {
      const old = await committed();
      await replacement(old.id, [{ mid: "MID-AGENT-1" }]);
      await insertBatch(target, { status: "abandoned" });
      await target.exec(`insert into payout_period_closures (period, processor) values ('${old.period}', '${PROCESSOR}')`);
      const before = await snapshot(target);
      await target.exec(await readMigration(MIGRATION));
      expect(await snapshot(target)).toEqual(before);
    } finally {
      db = saved;
    }
  });

  it.each([
    [
      "the batch status CHECK is not the one it widens",
      `alter table rep_payout_batches drop constraint rep_payout_batches_status_check;
       alter table rep_payout_batches add constraint rep_payout_batches_status_check
         check (status in ('review', 'committed', 'abandoned', 'replaced', 'void'))`,
      /^rep_payout_batches_status_check is not \(review, committed, abandoned, replaced\) here \(found: CHECK .*'void'/,
    ],
    [
      "the committed-month CHECK is missing",
      `alter table rep_payout_batches drop constraint rep_payout_batches_month_when_committed`,
      /^rep_payout_batches_month_when_committed is not the phase 7 CHECK here \(found: no such constraint\)/,
    ],
    [
      "the confirmed-warnings CHECK was altered",
      `alter table rep_payout_batches drop constraint rep_payout_batches_confirmed_warnings_shape;
       alter table rep_payout_batches add constraint rep_payout_batches_confirmed_warnings_shape check (true)`,
      /^rep_payout_batches_confirmed_warnings_shape is not the phase 8 CHECK here/,
    ],
    [
      "the client delete policy is not there",
      `drop policy "admin only delete" on rep_payout_rows`,
      /^rep_payout_rows has no "admin only delete" policy here/,
    ],
  ])("refuses when %s, naming what it found, and changes nothing", async (_l, tamper, message) => {
    const target = await populated();
    await target.exec(tamper);
    const error = await (async () => {
      try {
        await target.exec(await readMigration(MIGRATION));
        return null;
      } catch (e) {
        return e as DbError;
      }
    })();
    expect(error?.message).toMatch(message);
    expect(
      await rows(target, `select count(*)::int as n from pg_proc where proname = 'close_payout_period'`),
    ).toEqual([{ n: 0 }]);
    expect(
      await rows(target, `select count(*)::int as n from information_schema.columns where table_name = 'audit_log' and column_name = 'detail'`),
    ).toEqual([{ n: 0 }]);
  });
});

// -------------------------------------------------------------------------
// 10. Mutation proofs
// -------------------------------------------------------------------------

describe("mutation proofs: each protection is what stops its case", () => {
  let mutant: TestDb;
  const originals = new Map<string, string>();
  const FUNCTIONS = [
    "commit_residual_import_v3(int, text[])",
    "close_payout_period(date, text, text)",
    "reopen_payout_period(date, text, text)",
    "delete_payout_period(date, text)",
    "post_payout_adjustment(uuid, text, date, text, numeric, text)",
    "log_payout_period_closure()",
    "guard_batch_status_transition()",
  ];

  beforeAll(async () => {
    mutant = await open();
    for (const sig of FUNCTIONS) {
      const [{ def }] = await rows<{ def: string }>(mutant, `select pg_get_functiondef('${sig}'::regprocedure) as def`);
      originals.set(sig, def);
    }
  });

  beforeEach(async () => {
    await resetData(mutant);
    await asPlatform(mutant);
    await mutant.exec(`truncate payout_period_closures; delete from audit_log;`);
    for (const def of originals.values()) await mutant.exec(def);
  });

  async function without(sig: string, fragment: string, replacement: string): Promise<void> {
    await asPlatform(mutant);
    const def = originals.get(sig)!;
    expect(def, `the fragment must be in ${sig}`).toContain(fragment);
    await mutant.exec(def.replace(fragment, replacement));
  }

  const swap = async (fn: () => Promise<void>): Promise<void> => {
    const saved = db;
    db = mutant;
    try {
      await fn();
    } finally {
      db = saved;
    }
  };

  it("the typed confirmation", async () => {
    await swap(async () => {
      const { period } = await committed();
      expect((await attempt(() => close(period, "yes")))?.code).toBe("PT400");
      await without("close_payout_period(date, text, text)", "if typed <> lower(label) then", "if false then");
      await close(period, "yes");
      expect(await rows(db, `select count(*)::int as n from payout_period_closures`)).toEqual([{ n: 1 }]);
    });
  });

  it("the reason reaching the audit row (the trigger writing NULL instead)", async () => {
    await swap(async () => {
      const { period } = await committed();
      await close(period);
      await without("log_payout_period_closure()", "          reason);", "          null);");
      await reopen(period, "A reason that must be kept.");
      expect((await audit()).find((a) => a.action === "reopen_payout_period")?.detail).toBeNull();
    });
  });

  it("the reason being required at the trigger (a direct delete then goes through)", async () => {
    await swap(async () => {
      const { period } = await committed();
      await close(period);
      await without("log_payout_period_closure()", "    if reason is null then", "    if false then");
      expect(await attempt(() => db.exec(`delete from payout_period_closures`))).toBeNull();
    });
  });

  it("the replace's paid check", async () => {
    await swap(async () => {
      const old = await committed();
      await close(old.period);
      const next = await replacement(old.id, [{ mid: "MID-AGENT-1" }]);
      expect((await attempt(() => commitV3(db, next)))?.message).toMatch(/is marked paid and cannot be replaced/);
      await without(
        "commit_residual_import_v3(int, text[])",
        "    if exists (select 1 from payout_period_closures\n                where period = batch.period and processor = batch.processor) then",
        "    if false then",
      );
      expect((await commitV3(db, next)).replaced_lines).toBe(2);
    });
  });

  it("the replace's adjustment check", async () => {
    await swap(async () => {
      const old = await committed();
      await db.exec(`insert into rep_payout_rows (agent_id, period, mid, line_kind, adjustment_amount, adjusts_period, adjustment_note)
                     values ('${AGENT_ID}', '2099-01-01', 'MID-AGENT-1', 'adjustment', 1.00, '${old.period}', 'x')`);
      const next = await replacement(old.id, [{ mid: "MID-AGENT-1" }]);
      expect((await attempt(() => commitV3(db, next)))?.message).toMatch(/^Adjustments already correct/);
      await without("commit_residual_import_v3(int, text[])", "    if problem is not null then\n      raise exception 'Adjustments already correct % for %", "    if false then\n      raise exception 'Adjustments already correct % for %");
      expect((await commitV3(db, next)).replaced_lines).toBe(2);
    });
  });

  it("the replace's still-committed check (a deleted month would be resurrected as replaced)", async () => {
    await swap(async () => {
      const old = await committed();
      const next = await replacement(old.id, [{ mid: "MID-AGENT-1" }]);
      await deletePeriod(old.period);
      const real = await attempt(() => commitV3(db, next));
      expect(real?.message).toMatch(/which is no longer the committed import/);
      await without("commit_residual_import_v3(int, text[])", "    if not found or replaced.status <> 'committed'", "    if false and replaced.status <> 'committed'");
      const mutated = await attempt(() => commitV3(db, next));
      expect(mutated?.message ?? "committed").not.toMatch(/which is no longer the committed import/);
    });
  });

  it("the replace's removal of the old lines (without it the new lines collide with the old)", async () => {
    await swap(async () => {
      const old = await committed();
      const next = await replacement(old.id, [{ mid: "MID-AGENT-1" }]);
      await without("commit_residual_import_v3(int, text[])", "    delete from rep_payout_rows where batch_id = replaced.id;", "    perform 1;");
      const mutated = await attempt(() => commitV3(db, next));
      expect(mutated?.message).toMatch(/rep_payout_rows_import_merge_key|duplicate key/);
    });
  });

  it("the delete's paid check", async () => {
    await swap(async () => {
      const old = await committed();
      await close(old.period);
      expect((await attempt(() => deletePeriod(old.period)))?.message).toMatch(/is marked paid and cannot be deleted/);
      await without("delete_payout_period(date, text)", "  if processor_input is not null and exists (\n    select 1 from payout_period_closures", "  if false and exists (\n    select 1 from payout_period_closures");
      expect((await deletePeriod(old.period)).deleted).toBe(2);
    });
  });

  it("the delete's adjustment check", async () => {
    await swap(async () => {
      const old = await committed();
      await db.exec(`insert into rep_payout_rows (agent_id, period, mid, line_kind, adjustment_amount, adjusts_period, adjustment_note)
                     values ('${AGENT_ID}', '2099-01-01', 'MID-AGENT-1', 'adjustment', 1.00, '${old.period}', 'x')`);
      expect((await attempt(() => deletePeriod(old.period)))?.message).toMatch(/^Adjustments already correct/);
      await without("delete_payout_period(date, text)", "  if problem is not null then\n    raise exception 'Adjustments already correct %", "  if false then\n    raise exception 'Adjustments already correct %");
      expect((await deletePeriod(old.period)).deleted).toBe(2);
    });
  });

  it("the adjustment's paid-month check", async () => {
    await swap(async () => {
      const old = await committed();
      expect((await attempt(() => adjust({ period: old.period })))?.message).toMatch(/is not marked paid/);
      await without(
        "post_payout_adjustment(uuid, text, date, text, numeric, text)",
        "  if not exists (select 1 from payout_period_closures\n                  where period = adjusts_period_input and processor = processor_input) then",
        "  if false then",
      );
      expect((await adjust({ period: old.period })).line_id).toBeGreaterThan(0);
    });
  });

  it("replaced is final (without the rule, a replaced batch can be put back to committed)", async () => {
    await swap(async () => {
      const old = await committed();
      const next = await replacement(old.id, [{ mid: "MID-AGENT-1" }]);
      await commitV3(db, next);
      // Free the slot so only the status rule can stop it.
      await db.exec(`update rep_payout_batches set status = 'deleted' where id = ${next}`);
      const put = () => db.exec(`update rep_payout_batches set status = 'committed', replaced_by_batch_id = null where id = ${old.id}`);
      expect((await attempt(put))?.message).toMatch(/That is final/);
      await without("guard_batch_status_transition()", "  if old.status in ('replaced', 'deleted') then", "  if false then");
      expect(await attempt(put)).toBeNull();
    });
  });

  it("committed -> replaced only (without the rule, a review batch can be marked replaced)", async () => {
    await swap(async () => {
      const review = await insertBatch(db);
      const other = await insertBatch(db);
      const mark = () => db.exec(`update rep_payout_batches set status = 'replaced', replaced_by_batch_id = ${other} where id = ${review}`);
      expect((await attempt(mark))?.message).toMatch(/^Only a committed import can become replaced/);
      await without("guard_batch_status_transition()", "     and old.status <> 'committed' then", "     and false then");
      expect(await attempt(mark)).toBeNull();
    });
  });
});
