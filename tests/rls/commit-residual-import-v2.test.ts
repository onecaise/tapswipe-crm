import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_ID,
  AGENT_ID,
  AGENT_NUMBER,
  OTHER_AGENT_ID,
  OTHER_AGENT_NUMBER,
  PAYOUT_PERIOD,
  PAYOUT_PERIOD_PRIOR,
  asPlatform,
  asUser,
  createTestDb,
  migrationsBefore,
  resetData,
  rows,
  seedPayouts,
  type PayoutFixtures,
  type TestDb,
} from "../helpers/db";

/**
 * commit_residual_import_v2() — the shared-account-aware commit
 * (20261016120000; phase 4 of docs/design/residual-splits.md).
 *
 * What this file pins, in order:
 *
 *   1. With no shared account in the batch, v2 IS the old commit: one sequence
 *      of batches run through the pre-phase-4 function, the guarded old
 *      function and v2 leaves identical ledger, history, audit and batch rows,
 *      and `written` equals the old return value at every step. Repeated with a
 *      share on a merchant the batches never touch.
 *   2. The old function refuses a batch a share covers, and nothing else.
 *   3. A signer row becomes two lines; a partner row is skipped and recorded;
 *      a third rep imports as an ordinary line; the file's residual and rate are
 *      ignored on a shared line; the share in force AT COMMIT is the one used.
 *   4. R-1: re-importing a shared month five ways leaves both lines' money,
 *      rate and share columns byte-identical.
 *   5. Catalog, grants and redaction, as for every other definer function.
 *
 * The share lock is pinned here by grep only. Its behaviour needs two
 * connections, which PGlite does not have; it was checked by hand against the
 * local stack's Postgres with two psql sessions (see the phase 4 commit).
 */

const V2 = "commit_residual_import_v2";
const V2_MIGRATION = "20261016120000_commit_residual_import_v2.sql";

const PARTNER_ID = "55555555-5555-5555-5555-555555555555";
const PARTNER_NUMBER = "5555";
const THIRD_ID = "66666666-6666-6666-6666-666666666666";
const THIRD_NUMBER = "6666";

const AUG = "2026-08-01";
const SEP = "2026-09-01";

type Json = Record<string, unknown>;
type DbError = { code?: string; message: string };
type Result = { written: number; skipped: number };

type StagedRow = {
  period: string;
  agentId: string;
  agentNumber: string;
  mid: string;
  name?: string;
  volume?: string | null;
  residual?: string | null;
  split?: string | null;
};

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

async function addReps(db: TestDb): Promise<void> {
  await asPlatform(db);
  await db.exec(`
    insert into auth.users (id, email) values
      ('${PARTNER_ID}', 'partner@tapswipe.test'),
      ('${THIRD_ID}', 'third@tapswipe.test');
    insert into profiles (id, full_name, role, is_active, agent_number) values
      ('${PARTNER_ID}', 'Partner Agent', 'agent', true, '${PARTNER_NUMBER}'),
      ('${THIRD_ID}', 'Third Agent', 'agent', true, '${THIRD_NUMBER}');
  `);
}

/** A new review batch holding `staged`, sheet rows numbered from 2. */
async function stage(db: TestDb, staged: StagedRow[]): Promise<number> {
  await asPlatform(db);
  const [{ id }] = await rows<{ id: number }>(
    db,
    `insert into rep_payout_batches (imported_by, file_key, file_name, status)
     values ('${ADMIN_ID}', 'test/file.xlsx', 'file.xlsx', 'review')
     returning id`,
  );
  const values = staged.map((r, index) => {
    const num = (v: string | null | undefined) => (v == null ? "null" : v);
    return `(${id}, ${index + 2}, '${r.agentNumber}', '${r.mid}',
      '${r.name ?? `${r.mid} Co`}', '${r.period}', '${r.agentId}',
      (select id from merchants where mid = '${r.mid}'),
      ${num(r.volume === undefined ? "1000.00" : r.volume)}, 10.00, 25.00,
      ${num(r.residual)}, ${num(r.split)})`;
  });
  await db.exec(`
    insert into rep_payout_import_rows
      (batch_id, row_number, agent_number_raw, mid_raw, merchant_name_raw,
       period, agent_id, merchant_id, volume, average_ticket, total_cost,
       residual_income, rep_split_pct)
    values ${values.join(",\n")};
  `);
  return id;
}

async function commitV2(db: TestDb, caller: string | null, batchId: number): Promise<Result> {
  await asUser(db, caller);
  try {
    const [{ result }] = await rows<{ result: Result }>(
      db,
      `select ${V2}(${batchId}) as result`,
    );
    return result;
  } finally {
    await asPlatform(db);
  }
}

async function commitOld(db: TestDb, caller: string | null, batchId: number): Promise<number> {
  await asUser(db, caller);
  try {
    const [{ n }] = await rows<{ n: number }>(
      db,
      `select commit_residual_import(${batchId}) as n`,
    );
    return n;
  } finally {
    await asPlatform(db);
  }
}

async function attempt(fn: () => Promise<unknown>): Promise<DbError | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error as DbError;
  }
}

async function count(db: TestDb, sql: string): Promise<number> {
  await asPlatform(db);
  const [{ n }] = await rows<{ n: number }>(db, `select (${sql})::int as n`);
  return n;
}

async function share(
  db: TestDb,
  mid: string,
  signer: string,
  partner: string,
  from: string,
): Promise<number> {
  await asUser(db, ADMIN_ID);
  const [{ id }] = await rows<{ id: number }>(
    db,
    `select set_merchant_rep_share(
       (select id from merchants where mid = '${mid}'),
       '${signer}', '${partner}', 40, 10, '${from}') as id`,
  );
  await asPlatform(db);
  return id;
}

/** Timestamps are compared by presence; everything else by value. */
function stable(row: Json): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = key.endsWith("_at") ? value !== null : value;
  }
  return out;
}

type Snapshot = { ledger: Json[]; history: Json[]; audit: Json[]; batches: Json[] };

async function snapshot(db: TestDb, dropBatchKeys: string[] = []): Promise<Snapshot> {
  await asPlatform(db);
  const grab = async (table: string) =>
    (await rows<{ j: Json }>(db, `select to_jsonb(t) as j from ${table} t order by id`)).map(
      (r) => stable(r.j),
    );
  const batches = (await grab("rep_payout_batches")).map((b) => {
    const copy = { ...b };
    for (const key of dropBatchKeys) delete copy[key];
    return copy;
  });
  return {
    ledger: await grab("rep_payout_rows"),
    history: await grab("rep_payout_row_history"),
    audit: await grab("audit_log"),
    batches,
  };
}

// -------------------------------------------------------------------------
// 1. No shared account: v2 is the old commit.
// -------------------------------------------------------------------------

/**
 * Fresh, corrected, round-trip, negative, NULL, half-cent, a second period, two
 * reps on one MID, and a re-import of the prior period. Every batch is
 * committed in order; the same sequence runs on every database.
 */
const SEQUENCE: StagedRow[][] = [
  // Fresh rows, and a corrected file for two existing lines (no figures).
  [
    { period: PAYOUT_PERIOD, agentId: AGENT_ID, agentNumber: AGENT_NUMBER, mid: "MID-AGENT-2", volume: "5100.00" },
    { period: PAYOUT_PERIOD, agentId: AGENT_ID, agentNumber: AGENT_NUMBER, mid: "MID-AGENT-1", volume: "13100.00", name: "Agent Active Co RENAMED" },
    { period: PAYOUT_PERIOD, agentId: OTHER_AGENT_ID, agentNumber: OTHER_AGENT_NUMBER, mid: "MID-OTHER-1", volume: "9950.00" },
  ],
  // A round-trip export carrying figures, one negative, one rate without a residual.
  [
    { period: PAYOUT_PERIOD, agentId: AGENT_ID, agentNumber: AGENT_NUMBER, mid: "MID-AGENT-1", residual: "91.00", split: "55.00" },
    { period: PAYOUT_PERIOD, agentId: AGENT_ID, agentNumber: AGENT_NUMBER, mid: "MID-UNMATCHED", residual: "-12.34", split: "50.00" },
    { period: PAYOUT_PERIOD, agentId: AGENT_ID, agentNumber: AGENT_NUMBER, mid: "MID-AGENT-2", residual: null, split: "50.00" },
  ],
  // A corrected processor file again: no figures, so the figures above must survive.
  [
    { period: PAYOUT_PERIOD, agentId: AGENT_ID, agentNumber: AGENT_NUMBER, mid: "MID-AGENT-1", volume: "13200.00" },
    { period: PAYOUT_PERIOD, agentId: AGENT_ID, agentNumber: AGENT_NUMBER, mid: "MID-UNMATCHED", volume: null },
  ],
  // Two reps on one MID, and a new period with a half-cent payout.
  [
    { period: PAYOUT_PERIOD, agentId: OTHER_AGENT_ID, agentNumber: OTHER_AGENT_NUMBER, mid: "MID-AGENT-1", volume: "500.00" },
    { period: AUG, agentId: AGENT_ID, agentNumber: AGENT_NUMBER, mid: "MID-AGENT-1", residual: "0.03", split: "50.00" },
    { period: AUG, agentId: OTHER_AGENT_ID, agentNumber: OTHER_AGENT_NUMBER, mid: "MID-OTHER-1", residual: "-100.01", split: "50.00" },
  ],
  // The prior period re-imported, clearing nothing.
  [
    { period: PAYOUT_PERIOD_PRIOR, agentId: AGENT_ID, agentNumber: AGENT_NUMBER, mid: "MID-AGENT-1", volume: "11900.00" },
  ],
];

type Variant = "pre-phase-4 old" | "guarded old" | "v2";

async function runSequence(
  variant: Variant,
  withShareElsewhere: boolean,
): Promise<{ db: TestDb; returns: number[]; skipped: number[] }> {
  const db = await createTestDb(
    variant === "pre-phase-4 old" ? await migrationsBefore(V2_MIGRATION) : undefined,
  );
  await resetData(db);
  const fx: PayoutFixtures = await seedPayouts(db);
  if (withShareElsewhere) {
    // MID-OTHER-2 is in no batch and has no ledger line.
    await share(db, "MID-OTHER-2", OTHER_AGENT_ID, AGENT_ID, PAYOUT_PERIOD);
  }

  // The seeded review batch first, with its blocker removed.
  await db.exec(
    `delete from rep_payout_import_rows
      where batch_id = ${fx.batchIds.review} and blocker is not null`,
  );
  const batches = [fx.batchIds.review];
  for (const staged of SEQUENCE) batches.push(await stage(db, staged));

  const returns: number[] = [];
  const skipped: number[] = [];
  for (const id of batches) {
    if (variant === "v2") {
      const result = await commitV2(db, ADMIN_ID, id);
      expect(Object.keys(result).sort()).toEqual(["skipped", "written"]);
      returns.push(result.written);
      skipped.push(result.skipped);
    } else {
      returns.push(await commitOld(db, ADMIN_ID, id));
    }
  }
  return { db, returns, skipped };
}

describe.each([
  { label: "no share anywhere", withShareElsewhere: false },
  { label: "a share on a merchant the batches never touch", withShareElsewhere: true },
])("with no shared account in the batch, v2 is the old commit ($label)", ({ withShareElsewhere }) => {
  const NEW_BATCH_KEYS = ["skipped_rows", "skips_acknowledged_at"];
  const runs = {} as Record<Variant, Awaited<ReturnType<typeof runSequence>>>;

  beforeAll(async () => {
    runs["pre-phase-4 old"] = await runSequence("pre-phase-4 old", withShareElsewhere);
    runs["guarded old"] = await runSequence("guarded old", withShareElsewhere);
    runs.v2 = await runSequence("v2", withShareElsewhere);
  }, 180_000);

  afterAll(async () => {
    for (const run of Object.values(runs)) await run?.db.close();
  });

  it("returns written = the old count at every step, and skips nothing", () => {
    expect(runs.v2.returns).toEqual(runs["guarded old"].returns);
    expect(runs.v2.returns).toEqual(runs["pre-phase-4 old"].returns);
    // Not vacuous: every batch wrote something.
    expect(runs.v2.returns).toEqual([1, 3, 3, 2, 3, 1]);
    expect(runs.v2.skipped).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("leaves identical ledger, history, audit and batch rows", async () => {
    const v2 = await snapshot(runs.v2.db);
    const guarded = await snapshot(runs["guarded old"].db);
    expect(v2).toEqual(guarded);

    // Against the function as it was before this phase, the two batch columns
    // this phase added are the only difference, so they are set aside...
    const before = await snapshot(runs["pre-phase-4 old"].db);
    expect(await snapshot(runs.v2.db, NEW_BATCH_KEYS)).toEqual(before);

    // ...and on both new databases they say nothing was skipped.
    for (const batch of [...v2.batches, ...guarded.batches]) {
      expect(batch.skipped_rows).toEqual([]);
      expect(batch.skips_acknowledged_at).toBe(false);
    }
  });

  it("is a comparison of something: history, audit and figures are all populated", async () => {
    const v2 = await snapshot(runs.v2.db);
    // Two round-trip figures and a rate on a line with none, plus a cleared nothing.
    expect(v2.history.length).toBeGreaterThanOrEqual(4);
    expect(v2.audit.filter((a) => a.action === "commit_residual_import")).toHaveLength(6);
    const payouts = v2.ledger.map((l) => l.rep_payout).filter((p) => p !== null);
    expect(payouts).toEqual(expect.arrayContaining([50.05, -6.17, 0.02, -50.01]));
  });
});

// -------------------------------------------------------------------------
// 2-4. Shared accounts.
// -------------------------------------------------------------------------

describe("shared accounts", () => {
  let db: TestDb;
  let shareId: number;

  type Pair = {
    id: number;
    agent_id: string;
    share_role: string | null;
    rep_share_id: number | null;
    primary_rep_pct: string | null;
    secondary_rep_pct: string | null;
    merchant_name: string | null;
    volume: string | null;
    average_ticket: string | null;
    total_cost: string | null;
    residual_income: string | null;
    account_residual_income: string | null;
    rep_split_pct: string | null;
    rep_payout: string | null;
    batch_id: number | null;
  };

  const LINE_COLUMNS = `id, agent_id, share_role, rep_share_id,
    primary_rep_pct::text, secondary_rep_pct::text, merchant_name,
    volume::text, average_ticket::text, total_cost::text,
    residual_income::text, account_residual_income::text,
    rep_split_pct::text, rep_payout::text, batch_id`;

  async function lines(mid: string, period: string): Promise<Pair[]> {
    await asPlatform(db);
    return rows<Pair>(
      db,
      `select ${LINE_COLUMNS} from rep_payout_rows
        where mid = '${mid}' and period = '${period}' order by share_role nulls last, agent_id`,
    );
  }

  const signerRow = (over: Partial<StagedRow> = {}): StagedRow => ({
    period: PAYOUT_PERIOD,
    agentId: AGENT_ID,
    agentNumber: AGENT_NUMBER,
    mid: "MID-AGENT-2",
    name: "Shared Co",
    volume: "5100.00",
    ...over,
  });
  const partnerRow = (over: Partial<StagedRow> = {}): StagedRow =>
    signerRow({ agentId: PARTNER_ID, agentNumber: PARTNER_NUMBER, ...over });
  const thirdRow = (over: Partial<StagedRow> = {}): StagedRow =>
    signerRow({ agentId: THIRD_ID, agentNumber: THIRD_NUMBER, ...over });

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await resetData(db);
    await seedPayouts(db);
    await addReps(db);
    // Only the batches each test stages.
    await db.exec(`delete from rep_payout_import_rows`);
    // Signer AGENT 40, partner PARTNER 10, on MID-AGENT-2 (nothing committed
    // for it), July and August only.
    shareId = await share(db, "MID-AGENT-2", AGENT_ID, PARTNER_ID, PAYOUT_PERIOD);
    await asUser(db, ADMIN_ID);
    await db.query(`select end_merchant_rep_share(${shareId}, '${SEP}')`);
    await asPlatform(db);
    await db.exec(`delete from audit_log; delete from rep_payout_row_history;`);
  });

  describe("the old commit refuses a batch a share covers, and nothing else", () => {
    it("refuses with PT409 and writes nothing", async () => {
      const batch = await stage(db, [signerRow(), thirdRow({ mid: "MID-UNMATCHED" })]);
      const ledgerBefore = await count(db, `select count(*) from rep_payout_rows`);

      const error = await attempt(() => commitOld(db, ADMIN_ID, batch));
      expect(error?.code).toBe("PT409");
      expect(error?.message).toBe(
        "This import contains shared accounts, which this version of the CRM cannot commit. It needs the current version of the app.",
      );

      expect(await count(db, `select count(*) from rep_payout_rows`)).toBe(ledgerBefore);
      expect(await count(db, `select count(*) from rep_payout_import_rows where batch_id = ${batch}`)).toBe(2);
      expect(await count(db, `select count(*) from rep_payout_batches where id = ${batch} and status = 'review'`)).toBe(1);
      expect(await count(db, `select count(*) from audit_log`)).toBe(0);
    });

    it("refuses a batch that names only the partner, too", async () => {
      const batch = await stage(db, [partnerRow()]);
      expect((await attempt(() => commitOld(db, ADMIN_ID, batch)))?.code).toBe("PT409");
    });

    it("commits the same MID in a month the share does not cover", async () => {
      const batch = await stage(db, [signerRow({ period: SEP })]);
      expect(await commitOld(db, ADMIN_ID, batch)).toBe(1);
    });
  });

  describe("a signer row becomes the pair", () => {
    it("writes two lines with the share snapshot, volume on the signer's only", async () => {
      const batch = await stage(db, [signerRow()]);
      expect(await commitV2(db, ADMIN_ID, batch)).toEqual({ written: 1, skipped: 0 });

      const [signer, partner] = await lines("MID-AGENT-2", PAYOUT_PERIOD);
      expect(signer).toMatchObject({
        agent_id: AGENT_ID,
        share_role: "primary",
        rep_share_id: shareId,
        primary_rep_pct: "40.00",
        secondary_rep_pct: "10.00",
        merchant_name: "Shared Co",
        volume: "5100.00",
        average_ticket: "10.00",
        total_cost: "25.00",
        residual_income: null,
        account_residual_income: null,
        rep_split_pct: null,
        rep_payout: null,
        batch_id: batch,
      });
      expect(partner).toMatchObject({
        agent_id: PARTNER_ID,
        share_role: "secondary",
        rep_share_id: shareId,
        primary_rep_pct: "40.00",
        secondary_rep_pct: "10.00",
        merchant_name: "Shared Co",
        volume: null,
        average_ticket: null,
        total_cost: null,
        residual_income: null,
        account_residual_income: null,
        rep_split_pct: null,
        rep_payout: null,
        batch_id: batch,
      });
    });

    it("ignores a residual and rate the file supplies for a shared line", async () => {
      const batch = await stage(db, [signerRow({ residual: "100.01", split: "50.00" })]);
      await commitV2(db, ADMIN_ID, batch);

      for (const line of await lines("MID-AGENT-2", PAYOUT_PERIOD)) {
        expect(line.residual_income).toBeNull();
        expect(line.account_residual_income).toBeNull();
        expect(line.rep_split_pct).toBeNull();
      }
    });

    it("then pays the cent rule once the residual and rate are set", async () => {
      await commitV2(db, ADMIN_ID, await stage(db, [signerRow()]));
      await asUser(db, ADMIN_ID);
      await db.query(`select set_shared_residual(${shareId}, '${PAYOUT_PERIOD}', 100.01)`);
      await db.query(
        `update rep_payout_rows set rep_split_pct = 50
          where rep_share_id = ${shareId} and share_role = 'primary'`,
      );
      const [signer, partner] = await lines("MID-AGENT-2", PAYOUT_PERIOD);
      expect([signer.rep_payout, partner.rep_payout]).toEqual(["40.01", "10.00"]);
      expect(partner.rep_split_pct).toBe("50.00");
    });

    it("writes one audit row and no history", async () => {
      const batch = await stage(db, [signerRow()]);
      await commitV2(db, ADMIN_ID, batch);
      await asPlatform(db);
      expect(
        await rows(db, `select actor_id, action, table_name, row_id from audit_log`),
      ).toEqual([
        {
          actor_id: ADMIN_ID,
          action: "commit_residual_import",
          table_name: "rep_payout_batches",
          row_id: String(batch),
        },
      ]);
      expect(await count(db, `select count(*) from rep_payout_row_history`)).toBe(0);
    });

    it("imports a month outside [from, to) as an ordinary line, figures and all", async () => {
      const batch = await stage(db, [
        signerRow({ period: SEP, residual: "20.00", split: "50.00" }),
        signerRow({ period: PAYOUT_PERIOD_PRIOR, residual: "8.00", split: "50.00" }),
      ]);
      expect(await commitV2(db, ADMIN_ID, batch)).toEqual({ written: 2, skipped: 0 });

      for (const period of [SEP, PAYOUT_PERIOD_PRIOR]) {
        const found = await lines("MID-AGENT-2", period);
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ agent_id: AGENT_ID, share_role: null, rep_share_id: null });
      }
      expect((await lines("MID-AGENT-2", SEP))[0].rep_payout).toBe("10.00");
    });
  });

  describe("rows that are not the signer", () => {
    it("skips a partner row and records it on the batch", async () => {
      const batch = await stage(db, [partnerRow()]);
      expect(await commitV2(db, ADMIN_ID, batch)).toEqual({ written: 0, skipped: 1 });

      expect(await lines("MID-AGENT-2", PAYOUT_PERIOD)).toEqual([]);
      await asPlatform(db);
      const [b] = await rows<{ status: string; row_count: number; skipped_rows: Json[]; ack: string | null }>(
        db,
        `select status, row_count, skipped_rows, skips_acknowledged_at as ack
           from rep_payout_batches where id = ${batch}`,
      );
      expect(b).toEqual({
        status: "committed",
        row_count: 1,
        skipped_rows: [
          {
            row_number: 2,
            period: PAYOUT_PERIOD,
            mid: "MID-AGENT-2",
            agent_number: PARTNER_NUMBER,
            reason: "partner_named",
          },
        ],
        ack: null,
      });
      expect(await count(db, `select count(*) from rep_payout_import_rows where batch_id = ${batch}`)).toBe(0);
    });

    it("imports a third rep as an ordinary line, figures and all, and leaves the pair alone", async () => {
      await commitV2(db, ADMIN_ID, await stage(db, [signerRow()]));
      const pairBefore = await lines("MID-AGENT-2", PAYOUT_PERIOD);

      const batch = await stage(db, [thirdRow({ residual: "30.00", split: "50.00" })]);
      expect(await commitV2(db, ADMIN_ID, batch)).toEqual({ written: 1, skipped: 0 });

      const after = await lines("MID-AGENT-2", PAYOUT_PERIOD);
      expect(after.slice(0, 2)).toEqual(pairBefore);
      expect(after[2]).toMatchObject({
        agent_id: THIRD_ID,
        share_role: null,
        rep_share_id: null,
        residual_income: "30.00",
        rep_payout: "15.00",
      });
    });

    it("handles a mixed batch: written + skipped = staged = row_count", async () => {
      const batch = await stage(db, [
        partnerRow(),
        signerRow(),
        thirdRow(),
        signerRow({ mid: "MID-UNMATCHED", name: "Corner Mart" }),
      ]);
      expect(await commitV2(db, ADMIN_ID, batch)).toEqual({ written: 3, skipped: 1 });
      expect(await count(db, `select row_count from rep_payout_batches where id = ${batch}`)).toBe(4);
      expect(await lines("MID-AGENT-2", PAYOUT_PERIOD)).toHaveLength(3);
    });

    it("skips a signer row when either key already holds an unshared line", async () => {
      // Unreachable through the RPCs (the month rule), so made by hand: an
      // ordinary line on the partner's key.
      await asPlatform(db);
      await db.exec(`
        insert into rep_payout_rows (agent_id, period, mid, merchant_name, volume)
        values ('${PARTNER_ID}', '${PAYOUT_PERIOD}', 'MID-AGENT-2', 'Hand Made', 1.00);
      `);
      const batch = await stage(db, [signerRow()]);
      expect(await commitV2(db, ADMIN_ID, batch)).toEqual({ written: 0, skipped: 1 });

      const found = await lines("MID-AGENT-2", PAYOUT_PERIOD);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ agent_id: PARTNER_ID, share_role: null });
      const [{ reason }] = await rows<{ reason: string }>(
        db,
        `select skipped_rows -> 0 ->> 'reason' as reason from rep_payout_batches where id = ${batch}`,
      );
      expect(reason).toBe("line_not_shared");
    });
  });

  describe("the share in force at commit is the one applied", () => {
    it("applies a share created after the rows were staged", async () => {
      const batch = await stage(db, [signerRow({ mid: "MID-OTHER-2", agentId: OTHER_AGENT_ID, agentNumber: OTHER_AGENT_NUMBER })]);
      const late = await share(db, "MID-OTHER-2", OTHER_AGENT_ID, PARTNER_ID, PAYOUT_PERIOD);

      expect(await commitV2(db, ADMIN_ID, batch)).toEqual({ written: 1, skipped: 0 });
      const found = await lines("MID-OTHER-2", PAYOUT_PERIOD);
      expect(found.map((l) => [l.share_role, l.rep_share_id])).toEqual([
        ["primary", late],
        ["secondary", late],
      ]);
    });

    it("does not apply a share ended after the rows were staged", async () => {
      const batch = await stage(db, [signerRow(), signerRow({ period: AUG })]);
      await asUser(db, ADMIN_ID);
      await db.query(`select end_merchant_rep_share(${shareId}, '${AUG}')`);

      expect(await commitV2(db, ADMIN_ID, batch)).toEqual({ written: 2, skipped: 0 });
      expect(await lines("MID-AGENT-2", PAYOUT_PERIOD)).toHaveLength(2);
      const aug = await lines("MID-AGENT-2", AUG);
      expect(aug).toHaveLength(1);
      expect(aug[0].share_role).toBeNull();
    });
  });

  it("rebuilds a missing partner line from the signer's line", async () => {
    await commitV2(db, ADMIN_ID, await stage(db, [signerRow()]));
    await asUser(db, ADMIN_ID);
    await db.query(`select set_shared_residual(${shareId}, '${PAYOUT_PERIOD}', 100.01)`);
    await db.query(
      `update rep_payout_rows set rep_split_pct = 50
        where rep_share_id = ${shareId} and share_role = 'primary'`,
    );
    const [, partnerBefore] = await lines("MID-AGENT-2", PAYOUT_PERIOD);
    await asPlatform(db);
    await db.exec(`delete from rep_payout_rows where id = ${partnerBefore.id}`);

    await commitV2(db, ADMIN_ID, await stage(db, [signerRow()]));
    const [, partner] = await lines("MID-AGENT-2", PAYOUT_PERIOD);
    expect(partner).toMatchObject({
      agent_id: PARTNER_ID,
      share_role: "secondary",
      residual_income: "20.00",
      account_residual_income: "100.01",
      rep_split_pct: "50.00",
      rep_payout: "10.00",
      volume: null,
    });
  });

  // -----------------------------------------------------------------------
  // R-1: re-importing a shared month never overwrites the divided lines.
  // -----------------------------------------------------------------------
  describe("R-1: re-importing a shared month never overwrites the divided lines", () => {
    const MONEY = `id, residual_income::text, account_residual_income::text,
      rep_split_pct::text, rep_payout::text, rep_share_id, share_role,
      primary_rep_pct::text, secondary_rep_pct::text, line_kind`;

    async function money(): Promise<Json[]> {
      await asPlatform(db);
      return rows<Json>(
        db,
        `select ${MONEY} from rep_payout_rows
          where rep_share_id = ${shareId} and period = '${PAYOUT_PERIOD}' order by share_role`,
      );
    }

    async function pairHistory(): Promise<number> {
      return count(
        db,
        `select count(*) from rep_payout_row_history h
           join rep_payout_rows l on l.id = h.row_id
          where l.rep_share_id = ${shareId}`,
      );
    }

    let before: Json[];
    let historyBefore: number;

    beforeEach(async () => {
      await commitV2(db, ADMIN_ID, await stage(db, [signerRow()]));
      await asUser(db, ADMIN_ID);
      await db.query(`select set_shared_residual(${shareId}, '${PAYOUT_PERIOD}', 100.01)`);
      await db.query(
        `update rep_payout_rows set rep_split_pct = 50
          where rep_share_id = ${shareId} and share_role = 'primary'`,
      );
      before = await money();
      historyBefore = await pairHistory();
      // The setup is real: both lines carry money.
      expect(before.map((l) => l.rep_payout)).toEqual(["40.01", "10.00"]);
      expect(historyBefore).toBe(4);
    });

    it.each([
      { way: "a: the same fresh file", staged: () => [signerRow()], result: { written: 1, skipped: 0 } },
      {
        way: "b: a corrected file with a changed volume",
        staged: () => [signerRow({ volume: "6200.00", name: "Shared Co CORRECTED" })],
        result: { written: 1, skipped: 0 },
      },
      {
        way: "c: a round-trip export with edited residuals and rates on both lines",
        staged: () => [
          signerRow({ residual: "999.99", split: "40.00" }),
          partnerRow({ residual: "555.55", split: "45.00" }),
        ],
        result: { written: 1, skipped: 1 },
      },
      { way: "d: a file naming the partner", staged: () => [partnerRow({ residual: "1.00", split: "1.00" })], result: { written: 0, skipped: 1 } },
      { way: "e: a file naming a third rep", staged: () => [thirdRow({ residual: "7.77", split: "50.00" })], result: { written: 1, skipped: 0 } },
    ])("$way", async ({ way, staged, result }) => {
      const batch = await stage(db, staged());
      expect(await commitV2(db, ADMIN_ID, batch)).toEqual(result);

      // Byte-identical money, rate and share columns on both lines.
      expect(await money()).toEqual(before);
      // And not rewritten-to-the-same-value either: no history row for them.
      expect(await pairHistory()).toBe(historyBefore);

      const [signer, partner] = await lines("MID-AGENT-2", PAYOUT_PERIOD);
      expect(partner.volume).toBeNull();
      if (way.startsWith("b")) {
        // The file's own columns DID update, on the signer's line only.
        expect(signer.volume).toBe("6200.00");
        expect(signer.merchant_name).toBe("Shared Co CORRECTED");
        expect(partner.merchant_name).toBe("Shared Co");
      } else {
        expect(signer.volume).toBe("5100.00");
      }
      if (way.startsWith("e")) {
        const third = (await lines("MID-AGENT-2", PAYOUT_PERIOD)).find((l) => l.agent_id === THIRD_ID);
        expect(third).toMatchObject({ share_role: null, rep_payout: "3.89" });
      }
    });
  });
});

// -------------------------------------------------------------------------
// v2's own guards, as the old function's.
// -------------------------------------------------------------------------

describe("v2 refuses what the old commit refuses", () => {
  let db: TestDb;
  let fx: PayoutFixtures;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await resetData(db);
    fx = await seedPayouts(db);
  });

  const unblock = () =>
    db.exec(
      `delete from rep_payout_import_rows where batch_id = ${fx.batchIds.review} and blocker is not null`,
    );

  it.each([
    { who: "an agent", caller: AGENT_ID as string | null },
    { who: "no JWT", caller: null },
  ])("refuses $who, and writes nothing", async ({ caller }) => {
    await unblock();
    const error = await attempt(() => commitV2(db, caller, fx.batchIds.review));
    expect(error?.message).toBe("admin only");
    expect(await count(db, `select count(*) from rep_payout_rows`)).toBe(4);
    expect(await count(db, `select count(*) from rep_payout_import_rows`)).toBe(1);
    expect(await count(db, `select count(*) from audit_log`)).toBe(0);
  });

  it("refuses a deactivated admin", async () => {
    await unblock();
    await db.exec(`update profiles set is_active = false where id = '${ADMIN_ID}'`);
    expect((await attempt(() => commitV2(db, ADMIN_ID, fx.batchIds.review)))?.message).toBe("admin only");
  });

  it("refuses while any row is blocked, naming how many", async () => {
    const error = await attempt(() => commitV2(db, ADMIN_ID, fx.batchIds.review));
    expect(error?.message).toBe("1 of 2 rows are still blocked");
    expect(await count(db, `select count(*) from rep_payout_rows`)).toBe(4);
  });

  it("refuses an empty batch, a committed batch, and a missing one", async () => {
    await db.exec(`delete from rep_payout_import_rows where batch_id = ${fx.batchIds.review}`);
    expect((await attempt(() => commitV2(db, ADMIN_ID, fx.batchIds.review)))?.message).toBe(
      "this import has no rows",
    );
    expect((await attempt(() => commitV2(db, ADMIN_ID, fx.batchIds.committed)))?.message).toBe(
      "this import is already committed",
    );
    expect((await attempt(() => commitV2(db, ADMIN_ID, 999_999)))?.message).toBe("import not found");
  });

  it("cannot be committed twice", async () => {
    await unblock();
    expect(await commitV2(db, ADMIN_ID, fx.batchIds.review)).toEqual({ written: 1, skipped: 0 });
    expect((await attempt(() => commitV2(db, ADMIN_ID, fx.batchIds.review)))?.message).toBe(
      "this import is already committed",
    );
    expect(await count(db, `select count(*) from audit_log`)).toBe(1);
  });

  it("can be called twice in one transaction (the temp table is dropped)", async () => {
    await unblock();
    const second = await stage(db, [
      { period: PAYOUT_PERIOD, agentId: AGENT_ID, agentNumber: AGENT_NUMBER, mid: "MID-UNMATCHED" },
    ]);
    await asUser(db, ADMIN_ID);
    await db.exec(`begin;
      select ${V2}(${fx.batchIds.review});
      select ${V2}(${second});
      commit;`);
    expect(
      await count(db, `select count(*) from rep_payout_batches where status = 'committed' and id in (${fx.batchIds.review}, ${second})`),
    ).toBe(2);
  });
});

// -------------------------------------------------------------------------
// 5. Catalog, grants, redaction.
// -------------------------------------------------------------------------

describe("catalog, grants and redaction", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  async function fn(sig: string) {
    await asPlatform(db);
    const [row] = await rows<{
      prosecdef: boolean;
      proconfig: string[] | null;
      body: string;
      ret: string;
      acl: string | null;
    }>(
      db,
      `select p.prosecdef, p.proconfig, p.prosrc as body,
              pg_get_function_result(p.oid) as ret, p.proacl::text as acl
         from pg_proc p where p.oid = '${sig}'::regprocedure`,
    );
    return row;
  }

  it("is security definer, search_path pinned, guarded first, locked, one overload, jsonb", async () => {
    const v2 = await fn(`public.${V2}(int)`);
    expect(v2.prosecdef).toBe(true);
    expect(v2.proconfig).toContain("search_path=public");
    expect(v2.body.trimStart()).toMatch(/^declare[\s\S]*?begin\s+if not is_admin\(\) then/);
    expect(v2.body).toMatch(/from rep_payout_batches where id = batch_id_input for update/);
    expect(v2.body).toContain("pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'))");
    // The lock comes before the share table is read.
    expect(v2.body.indexOf("pg_advisory_xact_lock")).toBeLessThan(v2.body.indexOf("merchant_rep_shares s"));
    expect(v2.ret).toBe("jsonb");
    expect(await count(db, `select count(*) from pg_proc where proname = '${V2}'`)).toBe(1);
  });

  it("keeps THE COALESCE on the ordinary upsert", async () => {
    const { body } = await fn(`public.${V2}(int)`);
    expect(body).toMatch(/residual_income = coalesce\(excluded\.residual_income,\s+rep_payout_rows\.residual_income\)/);
    expect(body).toMatch(/rep_split_pct\s+= coalesce\(excluded\.rep_split_pct,\s+rep_payout_rows\.rep_split_pct\)/);
  });

  it("writes no money, rate or share column on a shared conflict", async () => {
    const { body } = await fn(`public.${V2}(int)`);
    const signerConflict = body.slice(
      body.indexOf("-- NEVER THE MONEY ON CONFLICT"),
      body.indexOf("get diagnostics shared"),
    );
    expect(signerConflict.length).toBeGreaterThan(0);
    expect(signerConflict).not.toMatch(
      /\b(residual_income|account_residual_income|rep_split_pct|rep_share_id|share_role|primary_rep_pct|secondary_rep_pct)\s*=/,
    );
    const partnerInsert = body.slice(body.indexOf("-- 4b."), body.indexOf("-- 5."));
    expect(partnerInsert).toMatch(/on conflict \(period, agent_id, mid\) do nothing;/);
  });

  it("is executable by authenticated and service_role only", async () => {
    for (const [role, ok] of [
      ["authenticated", true],
      ["service_role", true],
      ["anon", false],
    ] as const) {
      expect(
        await count(db, `select has_function_privilege('${role}', 'public.${V2}(int)', 'execute')::int`),
        role,
      ).toBe(ok ? 1 : 0);
    }
    // No PUBLIC entry in the ACL: "=X/..." is how PUBLIC's EXECUTE prints.
    const { acl } = await fn(`public.${V2}(int)`);
    expect(acl).not.toBeNull();
    expect(acl).not.toMatch(/(^|[{,])=X/);
  });

  it("leaves the old function returning int, with the share guard under the same lock", async () => {
    const old = await fn("public.commit_residual_import(int)");
    expect(old.ret).toBe("integer");
    expect(old.prosecdef).toBe(true);
    expect(old.body).toContain("This import contains shared accounts, which this version of the CRM cannot commit.");
    expect(old.body.indexOf("pg_advisory_xact_lock")).toBeLessThan(old.body.indexOf("merchant_rep_shares s"));
    expect(old.acl).not.toMatch(/(^|[{,])=X/);
  });

  describe("redaction", () => {
    let fx: PayoutFixtures;
    let skippedBatch: number;

    beforeAll(async () => {
      await resetData(db);
      fx = await seedPayouts(db);
      await addReps(db);
      await share(db, "MID-AGENT-2", AGENT_ID, PARTNER_ID, PAYOUT_PERIOD);
      skippedBatch = await stage(db, [
        {
          period: PAYOUT_PERIOD,
          agentId: PARTNER_ID,
          agentNumber: PARTNER_NUMBER,
          mid: "MID-AGENT-2",
          residual: "123.45",
          split: "50.00",
        },
      ]);
      await commitV2(db, ADMIN_ID, skippedBatch);
    });

    it("returns two counts and nothing else", async () => {
      const second = await stage(db, [
        { period: PAYOUT_PERIOD, agentId: PARTNER_ID, agentNumber: PARTNER_NUMBER, mid: "MID-AGENT-2" },
      ]);
      const result = await commitV2(db, ADMIN_ID, second);
      expect(result).toEqual({ written: 0, skipped: 1 });
      expect(Object.values(result).every((v) => Number.isInteger(v))).toBe(true);
    });

    it("records a skip with the file's identifiers only — no figure, no name", async () => {
      await asPlatform(db);
      const [{ entry }] = await rows<{ entry: Json }>(
        db,
        `select skipped_rows -> 0 as entry from rep_payout_batches where id = ${skippedBatch}`,
      );
      expect(Object.keys(entry).sort()).toEqual(["agent_number", "mid", "period", "reason", "row_number"]);
      expect(JSON.stringify(entry)).not.toContain("123.45");
    });

    it("lets no rep read a batch or its skip record, including the rep it names", async () => {
      for (const rep of [AGENT_ID, PARTNER_ID, OTHER_AGENT_ID]) {
        await asUser(db, rep);
        const seen = await rows<Json>(db, `select skipped_rows from rep_payout_batches`);
        expect(seen, rep).toEqual([]);
      }
      await asUser(db, ADMIN_ID);
      expect((await rows<Json>(db, `select id from rep_payout_batches where id = ${skippedBatch}`))).toHaveLength(1);
      await asPlatform(db);
    });

    it("answers an agent identically for a real batch and a missing one (no id oracle)", async () => {
      const real = await attempt(() => commitV2(db, AGENT_ID, fx.batchIds.review));
      const missing = await attempt(() => commitV2(db, AGENT_ID, 999_999));
      expect(real?.message).toBe("admin only");
      expect(missing?.message).toBe(real?.message);
      expect(missing?.code).toBe(real?.code);
    });
  });
});
