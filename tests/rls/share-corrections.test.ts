import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_ID,
  AGENT_ID,
  OTHER_AGENT_ID,
  PAYOUT_PERIOD,
  PAYOUT_PERIOD_PRIOR,
  asPlatform,
  asUser,
  createTestDb,
  resetData,
  rows,
  seedPayouts,
  type TestDb,
} from "../helpers/db";

/**
 * post_share_correction() (20261016161000; phase 5 of
 * docs/design/residual-splits.md, §6): a share agreed after its month was
 * committed is corrected by an adjustment PAIR in the earliest uncommitted
 * month -- the partner +x, the signer -x, x = shared_part(T, b, a + b) of that
 * month's payout T. The pair nets to zero; across both months the signer keeps
 * T - x and the partner gets x, exactly what the shared lines pay.
 *
 * The seeded ledger's latest month is July 2026, so the posting month is
 * August until something later is committed.
 */

const PARTNER_ID = "55555555-5555-5555-5555-555555555555";
const AUG = "2026-08-01";
const MID = "MID-AGENT-1";
const NOTE = "Shared with Partner Agent from July, agreed in August";

type Json = Record<string, unknown>;
type DbError = { code?: string; message: string };
type Result = { posting_period: string; amount: number; partner_line_id: number; signer_line_id: number };

/**
 * The cent rule, independently: integer cents, the solo payout rounded half
 * away from zero, the partner's part the nearest cent with an exact tie toward
 * zero. Written here from design §4.2, not copied from the SQL.
 */
function partnerPart(residualCents: number, ratePct: number, a: number, b: number): number {
  // T in cents, half away from zero, from R (cents) x p (percent, 2 dp).
  const pHundredths = Math.round(ratePct * 100);
  const numerator = Math.abs(residualCents) * pHundredths; // cents x 1/10000
  const tAbs = Math.floor((2 * numerator + 10_000) / 20_000);
  const t = Math.sign(residualCents) * tAbs;
  const bp = Math.round(b * 100);
  const wp = Math.round((a + b) * 100);
  const n = Math.abs(t) * bp;
  return Math.sign(t) * Math.floor((2 * n + wp - 1) / (2 * wp));
}

describe("post_share_correction", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await resetData(db);
    await seedPayouts(db);
    await asPlatform(db);
    await db.exec(`
      insert into auth.users (id, email) values ('${PARTNER_ID}', 'partner@tapswipe.test');
      insert into profiles (id, full_name, role, is_active, agent_number)
        values ('${PARTNER_ID}', 'Partner Agent', 'agent', true, '5555');
      delete from audit_log; delete from rep_payout_row_history;
    `);
  });

  async function correct(
    caller: string | null,
    args: { mid?: string; merchantId?: string; period?: string; partner?: string; a?: string; b?: string; note?: string | null } = {},
  ): Promise<Result> {
    const merchant = args.merchantId ?? `(select id from merchants where mid = '${args.mid ?? MID}')`;
    const note = args.note === null ? "null" : `'${(args.note ?? NOTE).replace(/'/g, "''")}'`;
    await asUser(db, caller);
    try {
      const [{ r }] = await rows<{ r: Result }>(
        db,
        `select post_share_correction(${merchant}, ${args.period ?? `'${PAYOUT_PERIOD}'`},
           ${args.partner ?? `'${PARTNER_ID}'`}, ${args.a ?? "40"}, ${args.b ?? "10"}, ${note}) as r`,
      );
      return r;
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

  async function adjustments(): Promise<Json[]> {
    await asPlatform(db);
    return rows<Json>(
      db,
      `select id, agent_id, period::text, mid, merchant_name, merchant_id, line_kind,
              adjustment_amount::text, adjusts_period::text, adjustment_note,
              rep_payout::text, residual_income, rep_split_pct, volume, batch_id
         from rep_payout_rows where line_kind = 'adjustment' order by id`,
    );
  }

  async function count(sql: string): Promise<number> {
    await asPlatform(db);
    const [{ n }] = await rows<{ n: number }>(db, `select (${sql})::int as n`);
    return n;
  }

  /** Sets the July signer line's figures, as the owner. */
  async function setJuly(residual: string | null, rate: string | null): Promise<void> {
    await asPlatform(db);
    await db.exec(`update rep_payout_rows set residual_income = ${residual ?? "null"},
                     rep_split_pct = ${rate ?? "null"}
                    where period = '${PAYOUT_PERIOD}' and agent_id = '${AGENT_ID}' and mid = '${MID}'`);
  }

  /** No adjustment line and no correction audit row (fixture writes audit other things). */
  async function nothingWritten(): Promise<void> {
    expect(await count(`select count(*) from rep_payout_rows where line_kind = 'adjustment'`)).toBe(0);
    expect(await count(`select count(*) from audit_log where action = 'post_share_correction'`)).toBe(0);
  }

  // -----------------------------------------------------------------------
  // The pair
  // -----------------------------------------------------------------------

  it("posts +x to the partner and -x to the signer in the earliest uncommitted month", async () => {
    // July MID-AGENT-1: 88.40 at 60% = T 53.04. 40 + 10: x = 53.04 / 5 = 10.608 -> 10.61.
    const result = await correct(ADMIN_ID);
    expect(result).toEqual({
      posting_period: AUG,
      amount: 10.61,
      partner_line_id: expect.any(Number),
      signer_line_id: expect.any(Number),
    });

    const [partner, signer] = await adjustments();
    const common = {
      period: AUG,
      mid: MID,
      merchant_name: "Agent Active Co",
      line_kind: "adjustment",
      adjusts_period: PAYOUT_PERIOD,
      adjustment_note: NOTE,
      residual_income: null,
      rep_split_pct: null,
      volume: null,
      batch_id: null,
    };
    expect(partner).toMatchObject({ ...common, id: result.partner_line_id, agent_id: PARTNER_ID, adjustment_amount: "10.61", rep_payout: "10.61" });
    expect(signer).toMatchObject({ ...common, id: result.signer_line_id, agent_id: AGENT_ID, adjustment_amount: "-10.61", rep_payout: "-10.61" });
  });

  it("nets to zero, and across both months pays the signer T - x and the partner x", async () => {
    await correct(ADMIN_ID);
    await asPlatform(db);
    const [{ net, signer_total, partner_total, t }] = await rows<{
      net: string; signer_total: string; partner_total: string; t: string;
    }>(
      db,
      `select
         (select sum(rep_payout) from rep_payout_rows where line_kind = 'adjustment')::text as net,
         (select sum(rep_payout) from rep_payout_rows
           where agent_id = '${AGENT_ID}' and mid = '${MID}' and period in ('${PAYOUT_PERIOD}', '${AUG}'))::text as signer_total,
         (select sum(rep_payout) from rep_payout_rows
           where agent_id = '${PARTNER_ID}' and mid = '${MID}')::text as partner_total,
         (select rep_payout from rep_payout_rows
           where agent_id = '${AGENT_ID}' and mid = '${MID}' and period = '${PAYOUT_PERIOD}')::text as t`,
    );
    expect(net).toBe("0.00");
    expect(t).toBe("53.04");
    expect([signer_total, partner_total]).toEqual(["42.43", "10.61"]);
    expect(Number(signer_total) + Number(partner_total)).toBeCloseTo(53.04, 10);
  });

  /**
   * The cent rule against an independent reference, and against the shared
   * lines themselves: for each (R, p, a + b) the partner's adjustment equals
   * what the generated column pays a secondary line on the same account, the
   * signer keeps exactly what a primary line would get, and the two sum to T.
   */
  it.each([
    { label: "half-cent tie at 25+25 (T 0.03 -> partner 0.01, signer keeps 0.02)", r: "0.06", p: "50", a: "25", b: "25", partner: "0.01", tie: true },
    { label: "negative month (clawback) at 40+10", r: "-100.01", p: "50", a: "40", b: "10", partner: "-10.00" },
    { label: "negative half-cent tie at 25+25", r: "-0.06", p: "50", a: "25", b: "25", partner: "-0.01", tie: true },
    { label: "T on a half cent, 25+25 (T 50.01 -> 25.00 / 25.01)", r: "100.01", p: "50", a: "25", b: "25", partner: "25.00", tie: true },
    { label: "30+20 on 7.77 (T 3.89 -> 1.56 / 2.33)", r: "7.77", p: "50", a: "30", b: "20", partner: "1.56" },
    { label: "33.33+16.67", r: "999.99", p: "50", a: "33.33", b: "16.67", partner: "166.70" },
    { label: "0.01+49.99", r: "12.34", p: "50", a: "0.01", b: "49.99", partner: "6.17" },
    { label: "49.99+0.01 on a large month", r: "123456.78", p: "50", a: "49.99", b: "0.01", partner: "12.35" },
    { label: "a non-50 rate", r: "88.40", p: "60", a: "40", b: "10", partner: "10.61" },
  ])("$label", async ({ r, p, a, b, partner, tie }) => {
    await setJuly(r, p);
    const result = await correct(ADMIN_ID, { a, b });

    const residualCents = Math.round(Number(r) * 100);
    const reference = partnerPart(residualCents, Number(p), Number(a), Number(b));
    expect(Math.round(result.amount * 100)).toBe(reference);
    expect(result.amount.toFixed(2)).toBe(partner);

    // The shared lines' own arithmetic, on the generated column itself.
    await asPlatform(db);
    const [lines] = await rows<{ t: string; secondary: string; primary: string; signer_net: string; sum: string }>(
      db,
      `with x as (select ${r}::numeric(14,2) as r, ${p}::numeric(5,2) as p,
                         ${a}::numeric(5,2) as a, ${b}::numeric(5,2) as b)
       select round(x.r * x.p / 100, 2)::text as t,
              shared_part(round(x.r * x.p / 100, 2), x.b, x.a + x.b)::text as secondary,
              (round(x.r * x.p / 100, 2)
                 - shared_part(round(x.r * x.p / 100, 2), x.b, x.a + x.b))::text as primary,
              ((select rep_payout from rep_payout_rows
                 where period = '${PAYOUT_PERIOD}' and agent_id = '${AGENT_ID}' and mid = '${MID}')
               + (select rep_payout from rep_payout_rows where id = ${result.signer_line_id}))::text as signer_net,
              ((select rep_payout from rep_payout_rows where id = ${result.signer_line_id})
               + (select rep_payout from rep_payout_rows where id = ${result.partner_line_id}))::text as sum
         from x`,
    );
    expect(lines.secondary).toBe(partner);
    expect(lines.signer_net).toBe(lines.primary);
    expect(lines.sum).toBe("0.00");
    // On an exact half-cent tie in an even split the signer absorbs the cent.
    if (tie) expect(Math.abs(Number(lines.primary))).toBe(Math.abs(Number(partner)) + 0.01);
  });

  it("refuses a zero x, writing nothing: a zero month, and one too small to divide", async () => {
    for (const [r, a, b] of [["0.00", "40", "10"], ["0.02", "25", "25"]]) {
      await setJuly(r, "50");
      const error = await attempt(() => correct(ADMIN_ID, { a, b }));
      expect(error?.code, r).toBe("PT409");
      expect(error?.message, r).toBe("The partner's share of that month rounds to $0.00, so there is nothing to move.");
      await nothingWritten();
    }
  });

  it("refuses a month whose payout is blank (not worked out yet), residual or rate", async () => {
    for (const [r, p] of [[null, "50"], ["10.00", null]] as const) {
      await setJuly(r, p);
      const error = await attempt(() => correct(ADMIN_ID));
      expect(error?.code).toBe("PT409");
      expect(error?.message).toBe(
        "The payout for July 2026 is not worked out yet: its residual or rate is blank. Fill it in first.",
      );
      await nothingWritten();
    }
  });

  it("refuses a blank note, a whitespace note, a NULL note and one over 500 characters", async () => {
    for (const note of ["", "   ", null, "x".repeat(501)]) {
      const error = await attempt(() => correct(ADMIN_ID, { note }));
      expect(error?.code, String(note)).toBe("22023");
      await nothingWritten();
    }
    expect(await attempt(() => correct(ADMIN_ID, { note: "x".repeat(500) }))).toBeNull();
  });

  // -----------------------------------------------------------------------
  // The posting month
  // -----------------------------------------------------------------------

  describe("the posting month is the earliest uncommitted one, and never a committed one", () => {
    it("is the month after the latest import line anywhere, and moves when a later month is committed", async () => {
      expect((await correct(ADMIN_ID)).posting_period).toBe(AUG);

      // A second correction before August is committed: still August -- the
      // first correction's lines do not make August committed.
      expect((await correct(ADMIN_ID, { mid: "MID-OTHER-1", partner: `'${AGENT_ID}'` })).posting_period).toBe(AUG);

      // September committed on an unrelated MID closes August and September.
      await asPlatform(db);
      await db.exec(`insert into rep_payout_rows (agent_id, period, mid) values ('${OTHER_AGENT_ID}', '2026-09-01', 'MID-ELSEWHERE')`);
      await setJuly("88.40", "60");
      expect(
        (await correct(ADMIN_ID, { period: `'${PAYOUT_PERIOD_PRIOR}'` })).posting_period,
      ).toBe("2026-10-01");

      // Every adjustment sits after every import line's month at its posting.
      expect(
        await count(`select count(*) from rep_payout_rows a
                      where a.line_kind = 'adjustment'
                        and a.period <= a.adjusts_period`),
      ).toBe(0);
    });

    it("takes no posting month from the caller: a seventh argument can only CONFIRM the computed one", async () => {
      // 20261019130000 added expected_posting_period_input so the merchant
      // page's "this will post to <month>" cannot be overtaken by a commit.
      // It never chooses the month: a mismatch is refused, nothing written.
      const call = (expected: string) =>
        attempt(async () => {
          await asUser(db, ADMIN_ID);
          try {
            await db.query(`select post_share_correction((select id from merchants where mid = '${MID}'),
                        '${PAYOUT_PERIOD}', '${PARTNER_ID}', 40, 10, 'n', '${expected}')`);
          } finally {
            await asPlatform(db);
          }
        });
      const error = await call(PAYOUT_PERIOD);
      expect(error?.code).toBe("PT409");
      expect(error?.message).toBe(
        "A month was committed after this correction was reviewed, so it would now post to August 2026, not July 2026. Review it again.",
      );
      await nothingWritten();
      expect(await call(AUG)).toBeNull();
      expect(
        await count(`select count(*) from rep_payout_rows where line_kind = 'adjustment' and period = '${AUG}'`),
      ).toBe(2);
      expect(await count(`select count(*) from pg_proc where proname = 'post_share_correction'`)).toBe(1);
    });

    it("refuses a month with no committed line: the correction must be OF a committed month", async () => {
      const error = await attempt(() => correct(ADMIN_ID, { period: `'${AUG}'` }));
      expect(error?.code).toBe("PT404");
      expect(error?.message).toBe("August 2026 has no committed line for MID MID-AGENT-1, so there is nothing to correct.");
      await nothingWritten();
    });
  });

  // -----------------------------------------------------------------------
  // Refusals
  // -----------------------------------------------------------------------

  it.each([
    { who: "an agent", caller: AGENT_ID as string | null },
    { who: "no JWT", caller: null },
  ])("refuses $who with 'admin only', writing nothing", async ({ caller }) => {
    const error = await attempt(() => correct(caller));
    expect(error?.message).toBe("admin only");
    expect(error?.code).toBe("PT403");
    await nothingWritten();
  });

  it("refuses a deactivated admin", async () => {
    await asPlatform(db);
    await db.exec(`update profiles set is_active = false where id = '${ADMIN_ID}'`);
    expect((await attempt(() => correct(ADMIN_ID)))?.message).toBe("admin only");
    await nothingWritten();
  });

  it("refuses by name: bad arguments, missing records, a deactivated partner, the signer as partner", async () => {
    const cases: [Parameters<typeof correct>[1], string, RegExp | string][] = [
      [{ a: "40", b: "15" }, "22023", /add up to the rep side: 50/],
      [{ a: "50", b: "0" }, "22023", /each be above 0/],
      [{ a: "39.995", b: "10.005" }, "22023", /in hundredths at most/],
      [{ period: `'2026-07-15'` }, "22023", "The month being corrected is given as its first day."],
      [{ period: "null" }, "22023", "Every field is required to post a correction."],
      [{ merchantId: "999999" }, "PT404", "merchant not found"],
      [{ partner: `'99999999-9999-9999-9999-999999999999'` }, "PT404", "rep not found"],
      [{ partner: `'${AGENT_ID}'` }, "22023", "The partner must be a different rep from the one paid for that month."],
    ];
    for (const [args, code, message] of cases) {
      const error = await attempt(() => correct(ADMIN_ID, args));
      expect(error?.code, JSON.stringify(args)).toBe(code);
      if (typeof message === "string") expect(error?.message).toBe(message);
      else expect(error?.message).toMatch(message);
    }

    await asPlatform(db);
    await db.exec(`update profiles set is_active = false where id = '${PARTNER_ID}'`);
    const deactivated = await attempt(() => correct(ADMIN_ID));
    expect(deactivated?.message).toBe("Partner Agent is deactivated, so a correction cannot name them.");

    await asPlatform(db);
    await db.exec(`update merchants set mid = null where mid = '${MID}'`);
    await db.exec(`update profiles set is_active = true where id = '${PARTNER_ID}'`);
    const noMid = await attempt(() =>
      correct(ADMIN_ID, { merchantId: `(select id from merchants where dba = 'Agent Active Co')` }),
    );
    expect(noMid?.code).toBe("PT409");
    expect(noMid?.message).toBe("This merchant has no MID, so it has no committed month to correct.");
    await nothingWritten();
  });

  it("refuses a month with two reps on the MID, and a month that is already shared", async () => {
    await asPlatform(db);
    await db.exec(`insert into rep_payout_rows (agent_id, period, mid) values ('${OTHER_AGENT_ID}', '${PAYOUT_PERIOD}', '${MID}')`);
    const two = await attempt(() => correct(ADMIN_ID));
    expect(two?.code).toBe("PT409");
    expect(two?.message).toBe(
      "July 2026 has 2 lines for MID MID-AGENT-1. A correction divides one rep's month, so that month must have exactly one.",
    );

    // A shared month: MID-AGENT-2 shared from August, committed through v2.
    await asUser(db, ADMIN_ID);
    const [{ id: shareId }] = await rows<{ id: number }>(
      db,
      `select set_merchant_rep_share((select id from merchants where mid = 'MID-AGENT-2'),
         '${AGENT_ID}', '${PARTNER_ID}', 40, 10, '${AUG}') as id`,
    );
    await asPlatform(db);
    await db.exec(`
      insert into rep_payout_rows (agent_id, period, mid, rep_share_id, share_role,
        primary_rep_pct, secondary_rep_pct, account_residual_income, residual_income, rep_split_pct)
      values ('${AGENT_ID}', '${AUG}', 'MID-AGENT-2', ${shareId}, 'primary', 40, 10, 100.00, 80.00, 50);
    `);
    const shared = await attempt(() => correct(ADMIN_ID, { mid: "MID-AGENT-2", period: `'${AUG}'` }));
    expect(shared?.code).toBe("PT409");
    expect(shared?.message).toBe("August 2026 is already a shared month for MID MID-AGENT-2, so there is nothing to correct.");
    await nothingWritten();
  });

  it("refuses a second correction of the same MID and month: a double click does not pay twice", async () => {
    await correct(ADMIN_ID);
    const again = await attempt(() => correct(ADMIN_ID, { a: "25", b: "25" }));
    expect(again?.code).toBe("PT409");
    expect(again?.message).toBe("A correction for MID MID-AGENT-1, July 2026 has already been posted.");
    expect(await count(`select count(*) from rep_payout_rows where line_kind = 'adjustment'`)).toBe(2);
    expect(await count(`select count(*) from audit_log`)).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Audit, history, visibility
  // -----------------------------------------------------------------------

  it("writes one audit row naming the admin and the partner's line, and no history", async () => {
    const result = await correct(ADMIN_ID);
    await asPlatform(db);
    expect(await rows(db, `select actor_id, action, table_name, row_id from audit_log`)).toEqual([
      {
        actor_id: ADMIN_ID,
        action: "post_share_correction",
        table_name: "rep_payout_rows",
        row_id: String(result.partner_line_id),
      },
    ]);
    expect(await count(`select count(*) from rep_payout_row_history`)).toBe(0);
  });

  it("shows each rep their own line of the pair, note included, and no rep anyone else's", async () => {
    const result = await correct(ADMIN_ID);
    const seen = async (rep: string) => {
      await asUser(db, rep);
      const found = await rows<{ id: number; rep_payout: string; adjustment_note: string }>(
        db,
        `select id, rep_payout::text, adjustment_note from rep_payout_rows where line_kind = 'adjustment' order by id`,
      );
      await asPlatform(db);
      return found;
    };
    expect(await seen(PARTNER_ID)).toEqual([{ id: result.partner_line_id, rep_payout: "10.61", adjustment_note: NOTE }]);
    expect(await seen(AGENT_ID)).toEqual([{ id: result.signer_line_id, rep_payout: "-10.61", adjustment_note: NOTE }]);
    expect(await seen(OTHER_AGENT_ID)).toEqual([]);
    expect((await seen(ADMIN_ID)).map((r) => r.id)).toEqual([result.partner_line_id, result.signer_line_id]);
  });

  it("refuses an admin's hand edit of the figures on an adjustment line", async () => {
    const result = await correct(ADMIN_ID);
    await asUser(db, ADMIN_ID);
    for (const set of ["residual_income = 1.00", "rep_split_pct = 50"]) {
      const error = await attempt(() =>
        db.query(`update rep_payout_rows set ${set} where id = ${result.partner_line_id}`),
      );
      expect(error?.code, set).toBe("23514");
      expect(error?.message).toContain("rep_payout_rows_adjustment_no_figures");
    }
    // The amount itself: the column grant refuses it first.
    const amount = await attempt(() =>
      db.query(`update rep_payout_rows set adjustment_amount = 99 where id = ${result.partner_line_id}`),
    );
    expect(amount?.code).toBe("42501");
    await asPlatform(db);
  });
});

// -------------------------------------------------------------------------
// Catalog
// -------------------------------------------------------------------------

describe("catalog", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  const SIG = "public.post_share_correction(int, date, uuid, numeric, numeric, text, date)";

  it("is security definer, search_path pinned, guarded first, locked before reading, fails closed", async () => {
    await asPlatform(db);
    const [fn] = await rows<{ prosecdef: boolean; proconfig: string[]; body: string; ret: string; acl: string }>(
      db,
      `select prosecdef, proconfig, prosrc as body, pg_get_function_result(oid) as ret, proacl::text as acl
         from pg_proc where oid = '${SIG}'::regprocedure`,
    );
    expect(fn.prosecdef).toBe(true);
    expect(fn.proconfig).toContain("search_path=public");
    expect(fn.ret).toBe("jsonb");
    expect(fn.body.trimStart()).toMatch(/^declare[\s\S]*?begin\s+if not is_admin\(\) then/);
    const lock = fn.body.indexOf("pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'))");
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(fn.body.indexOf("from merchants"));
    expect(lock).toBeLessThan(fn.body.indexOf("from rep_payout_rows"));
    // The cent rule is shared_part of the month's payout, in the share's ratio.
    expect(fn.body).toContain(
      "shared_part(signer.rep_payout, secondary_rep_pct_input,\n                        primary_rep_pct_input + secondary_rep_pct_input)",
    );
    // The posting month has ONE rule, in share_correction_posting_period(),
    // which the merchant page's preview also calls (20261019130000).
    expect(fn.body).toContain("posting := share_correction_posting_period();");
    expect(fn.body).not.toMatch(/max\(period\)/);
    // No exception handler anywhere: the audit insert fails closed.
    expect(fn.body).not.toMatch(/\bexception\s+when\b/i);
    expect(fn.acl).not.toMatch(/(^|[{,])=X/);
  });

  it("is executable by authenticated and service_role, not anon", async () => {
    await asPlatform(db);
    for (const [role, ok] of [["authenticated", true], ["service_role", true], ["anon", false]] as const) {
      const [{ v }] = await rows<{ v: boolean }>(db, `select has_function_privilege('${role}', '${SIG}', 'execute') as v`);
      expect(v, role).toBe(ok);
    }
  });

  it("widens the preview flag vocabulary to five, and keeps adjustment_rows_ignored out of the client's reach", async () => {
    await asPlatform(db);
    const [{ def }] = await rows<{ def: string }>(
      db,
      `select pg_get_constraintdef(oid) as def from pg_constraint
        where conname = 'rep_payout_import_rows_preview_flag_check'`,
    );
    for (const flag of ["share_not_applied", "partner_named", "line_not_shared", "share_not_in_force", "looks_shared"]) {
      expect(def).toContain(`'${flag}'`);
    }
    const [{ can }] = await rows<{ can: boolean }>(
      db,
      `select has_column_privilege('authenticated', 'rep_payout_batches', 'adjustment_rows_ignored', 'update') as can`,
    );
    expect(can).toBe(false);
  });
});
