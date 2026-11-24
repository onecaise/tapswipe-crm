import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PAYOUT_ROW_COLUMNS, payoutTotals, type PayoutRow } from "@/lib/payouts";
import {
  ADMIN_ID,
  AGENT_ID,
  OTHER_AGENT_ID,
  asPlatform,
  asUser,
  commitV3,
  createTestDb,
  insertBatch,
  migrationsBefore,
  readMigration,
  resetData,
  rows,
  stageForCommit,
  type TestDb,
} from "../helpers/db";

/**
 * 20261102160000, the reports -- phase 12 of docs/design/intake-and-reports.md
 * (§7.2, §4.5, §0b.7, §0c.1, A4d). What this file pins:
 *
 *   1. The catalog: both functions security INVOKER with a pinned
 *      search_path; EXECUTE for authenticated and service_role only (no anon,
 *      no PUBLIC); a rep is refused (PT403), anon cannot call them, a bad
 *      month range is 22023.
 *   2. A worked month through the real commit: an override, a clawback on a
 *      zero-volume line, a shared account (once per rep, the cent rule), the
 *      house profile at rate 0, Report 2's account residual, rep side and
 *      company share, and the totals rows.
 *   3. Committed only: lines on a review, abandoned, replaced or deleted batch
 *      (or on none) are never counted; a real replace and a real period delete
 *      leave only what is committed.
 *   4. Deductions: shown, never in the total, and total + deductions = the
 *      statement's total.
 *   5. Reconciliation over many random months through the real commit: split +
 *      received + company share = the file residuals to the cent; every rep row
 *      equals the statement (payoutTotals over the rep's lines); Report 2's
 *      grand total = the committed batches' residuals; the processor filter.
 *   6. The migration's refusal and its pass.
 *   7. Mutation proofs: admin-only, committed-only, the total formula and the
 *      deductions exclusion, each removed from a copy, let its case through.
 */

const MIGRATION = "20261102160000_reports.sql";
const R1 = "rep_payout_summary";
const R2 = "merchant_processor_summary";

const MANAGER_ID = "44444444-4444-4444-4444-444444444444";
const HOUSE_ID = "55555555-5555-5555-5555-555555555555";

type DbError = { code?: string; message: string };

type R1Row = {
  row_kind: "rep" | "month" | "total";
  period: string | null;
  agent_id: string | null;
  agent_code: string | null;
  legal_name: string | null;
  full_name: string | null;
  sales_volume: string;
  net_residual: string;
  agent_split: string;
  deductions: string;
  overrides_received: string;
  total_commission: string;
};

type R2Row = {
  row_kind: "merchant" | "processor" | "total";
  period: string | null;
  processor: string | null;
  merchant_id: number | null;
  mid: string | null;
  merchant_name: string | null;
  owner_id: string | null;
  owner_code: string | null;
  owner_name: string | null;
  volume: string;
  residual: string;
  rep_side: string;
  company_overrides: string;
  company_share: string;
};

/** Whole cents, so sums are exact. */
const cents = (value: string | number | null | undefined): number =>
  value === null || value === undefined ? 0 : Math.round(Number(value) * 100);

/** A first-of-month `back` months before this UTC month, as YYYY-MM-DD. */
function monthsAgo(back: number): string {
  const now = new Date();
  const index = now.getUTCFullYear() * 12 + now.getUTCMonth() - back;
  const year = Math.floor(index / 12);
  return `${year}-${String(index - year * 12 + 1).padStart(2, "0")}-01`;
}

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

/** The recipient (a manager with no book) and the house profile (code 122, rate 0). */
async function addPeople(target: TestDb): Promise<void> {
  await asPlatform(target);
  await target.exec(`
    truncate payout_period_closures;
    insert into auth.users (id, email) values
      ('${MANAGER_ID}', 'dana@tapswipe.test'), ('${HOUSE_ID}', 'house@tapswipe.test');
    insert into profiles (id, full_name, role, is_active, email, agent_number, split_rate_pct)
    values ('${MANAGER_ID}', 'Dana Cole', 'agent', true, 'dana@tapswipe.test', '300', 50),
           ('${HOUSE_ID}', 'House Account', 'agent', true, 'house@tapswipe.test', '122', 0);
    update profiles set agent_number = '101', legal_name = 'Ann Ito',
                        llc_legal_name = 'Ito Payments LLC' where id = '${AGENT_ID}';
    update profiles set agent_number = '102', legal_name = 'Bo Lee' where id = '${OTHER_AGENT_ID}';
    delete from audit_log;`);
}

/** A merchant at `rate`, owned by `owner`, with no saved processor (never a mismatch). */
async function merchant(target: TestDb, mid: string, owner: string, rate: number): Promise<number> {
  await asPlatform(target);
  const [{ id }] = await rows<{ id: number }>(
    target,
    `insert into merchants (agent_id, mid, dba, status, split_agent_pct, split_company_pct, city, state)
     values ('${owner}', '${mid}', '${mid} Co', 'active', ${rate}, ${100 - rate}, 'Nashville', 'TN')
     returning id`,
  );
  return id;
}

async function share(target: TestDb, merchantId: number, signer: string, partner: string,
                     a: number, b: number, from: string): Promise<void> {
  await asPlatform(target);
  await target.exec(`
    insert into merchant_rep_shares (merchant_id, primary_agent_id, secondary_agent_id,
                                     primary_rep_pct, secondary_rep_pct, effective_from)
    values (${merchantId}, '${signer}', '${partner}', ${a}, ${b}, '${from}')`);
}

async function override(target: TestDb, merchantId: number, pct: number, from: string,
                        funded: "owner" | "company" = "owner"): Promise<void> {
  await asPlatform(target);
  await target.exec(`
    insert into merchant_overrides (merchant_id, recipient_id, override_pct, effective_from, funded_by)
    values (${merchantId}, '${MANAGER_ID}', ${pct}, '${from}', '${funded}')`);
}

type Staged = { mid: string; volume?: string; residual?: string };

/** A batch for processor + month, staged, committed through the real v3 (every warning confirmed). */
async function commitMonth(
  target: TestDb,
  processor: string,
  period: string,
  staged: Staged[],
  replaces?: number,
): Promise<number> {
  await asPlatform(target);
  const extra: Record<string, string> = { processor: `'${processor}'`, period: `'${period}'` };
  if (replaces !== undefined) extra.replaces_batch_id = String(replaces);
  const id = await insertBatch(target, { extra });
  await stageForCommit(target, id, staged);
  await commitV3(target, id, ["bad_numbers", "processor_mismatch", "inactive_merchant"]);
  return id;
}

async function asAdmin<T>(target: TestDb, fn: () => Promise<T>, who: string | null = ADMIN_ID): Promise<T> {
  await asUser(target, who);
  try {
    return await fn();
  } finally {
    await asPlatform(target);
  }
}

const procArg = (processor: string | null) => (processor === null ? "null" : `'${processor}'`);

async function report1(target: TestDb, from: string, to = from, processor: string | null = null,
                       who: string | null = ADMIN_ID): Promise<R1Row[]> {
  return asAdmin(target, () => rows<R1Row>(target,
    `select row_kind, period::text, agent_id::text, agent_code, legal_name, full_name,
            sales_volume::text, net_residual::text, agent_split::text, deductions::text,
            overrides_received::text, total_commission::text
       from ${R1}('${from}', '${to}', ${procArg(processor)})`), who);
}

async function report2(target: TestDb, from: string, to = from, processor: string | null = null,
                       who: string | null = ADMIN_ID): Promise<R2Row[]> {
  return asAdmin(target, () => rows<R2Row>(target,
    `select row_kind, period::text, processor, merchant_id, mid, merchant_name,
            owner_id::text, owner_code, owner_name, volume::text, residual::text,
            rep_side::text, company_overrides::text, company_share::text
       from ${R2}('${from}', '${to}', ${procArg(processor)})`), who);
}

/** The statement's total for a rep and month: payoutTotals over the rep's lines, as the page reads them. */
async function statementTotal(target: TestDb, agentId: string, period: string): Promise<number> {
  const lines = await asAdmin(target, () => rows<PayoutRow>(target,
    `select ${PAYOUT_ROW_COLUMNS} from rep_payout_rows
      where period = '${period}' and agent_id = '${agentId}'`));
  return cents(payoutTotals(lines).repPayout);
}

const repRow = (report: R1Row[], agentId: string, period?: string) =>
  report.find((r) => r.row_kind === "rep" && r.agent_id === agentId && (!period || r.period === period));

let db: TestDb;

beforeAll(async () => {
  db = await open();
});

beforeEach(async () => {
  await resetData(db);
  await addPeople(db);
});

// -------------------------------------------------------------------------
// 1. The catalog and the refusals
// -------------------------------------------------------------------------

describe("the two functions: invoker, pinned search_path, admin-only EXECUTE surface", () => {
  for (const fn of [R1, R2]) {
    const sig = `${fn}(date, date, text)`;

    it(`${fn} is security invoker with search_path pinned`, async () => {
      const [row] = await rows<{ prosecdef: boolean; config: string[] | null }>(db,
        `select prosecdef, proconfig as config from pg_proc where oid = '${sig}'::regprocedure`);
      expect(row.prosecdef).toBe(false);
      expect(row.config).toContain("search_path=public, pg_temp");
    });

    it(`${fn}: EXECUTE for authenticated and service_role, never anon or PUBLIC`, async () => {
      const [row] = await rows<{ anon: boolean; authenticated: boolean; service: boolean; acl: string }>(db,
        `select has_function_privilege('anon', '${sig}', 'execute') as anon,
                has_function_privilege('authenticated', '${sig}', 'execute') as authenticated,
                has_function_privilege('service_role', '${sig}', 'execute') as service,
                proacl::text as acl
           from pg_proc where oid = '${sig}'::regprocedure`);
      expect(row).toMatchObject({ anon: false, authenticated: true, service: true });
      // No "=X/" entry: PUBLIC holds nothing.
      expect(row.acl).not.toMatch(/(^|[{,])=X/);
    });

    it(`${fn} refuses a rep (PT403), even over their own lines`, async () => {
      const m = await merchant(db, "RF-1", AGENT_ID, 50);
      expect(m).toBeGreaterThan(0);
      await commitMonth(db, "TSYS", monthsAgo(2), [{ mid: "RF-1" }]);
      const error = await attempt(() => asAdmin(db,
        () => db.query(`select * from ${fn}('${monthsAgo(2)}', '${monthsAgo(2)}', null)`), AGENT_ID));
      expect(error?.code).toBe("PT403");
    });

    it(`${fn} cannot be called by anon`, async () => {
      // The anon ROLE (asUser(null) is authenticated with no user).
      await asPlatform(db);
      await db.exec(`set role anon`);
      const error = await attempt(() =>
        db.query(`select * from ${fn}('${monthsAgo(2)}', '${monthsAgo(2)}', null)`));
      await asPlatform(db);
      expect(error?.message).toMatch(/permission denied for function/);
    });

    it(`${fn} refuses a bad month range (22023)`, async () => {
      for (const [from, to] of [["2026-07-02", "2026-07-02"], ["2026-08-01", "2026-07-01"]]) {
        const error = await attempt(() => asAdmin(db,
          () => db.query(`select * from ${fn}('${from}', '${to}', null)`)));
        expect(error?.code, `${from}..${to}`).toBe("22023");
      }
      const error = await attempt(() => asAdmin(db,
        () => db.query(`select * from ${fn}(null, '2026-07-01', null)`)));
      expect(error?.code).toBe("22023");
    });

    it(`${fn} answers no rows for a month with no lines`, async () => {
      const result = fn === R1 ? await report1(db, monthsAgo(2)) : await report2(db, monthsAgo(2));
      expect(result).toEqual([]);
    });
  }
});

// -------------------------------------------------------------------------
// 2. A worked month
// -------------------------------------------------------------------------

describe("a worked month through the real commit", () => {
  const M = monthsAgo(3);

  async function plantMonth(target: TestDb): Promise<void> {
    // R = 100.00 at 50 with a 10% override: rep side 50, the rep keeps 40, Dana 10.
    const plain = await merchant(target, "WK-PLAIN", AGENT_ID, 50);
    await override(target, plain, 10, M);
    // A clawback on a zero-volume line at 46: T = round(-11.76 * 0.46) = -5.41.
    await merchant(target, "WK-CLAW", AGENT_ID, 46);
    // Shared 30 + 20 of 50: R = 1234.57, T = 617.29; Bo's piece shared_part(617.29, 20, 50).
    const shared = await merchant(target, "WK-SHARED", AGENT_ID, 50);
    await share(target, shared, AGENT_ID, OTHER_AGENT_ID, 30, 20, M);
    // The house: rate 0, a line with a zero rep amount.
    await merchant(target, "WK-HOUSE", HOUSE_ID, 0);
    await commitMonth(target, "TSYS", M, [
      { mid: "WK-PLAIN", volume: "1000.00", residual: "100.00" },
      { mid: "WK-CLAW", volume: "0.00", residual: "-11.76" },
      { mid: "WK-SHARED", volume: "50000.00", residual: "1234.57" },
      { mid: "WK-HOUSE", volume: "20000.00", residual: "500.00" },
    ]);
  }

  it("Report 1: Owen's columns per rep, the override received, the house row, the totals", async () => {
    await plantMonth(db);
    const [{ partner }] = await rows<{ partner: string }>(db,
      `select shared_part(617.29, 20, 50)::text as partner`);
    const signerPiece = cents("617.29") - cents(partner);
    const [{ bo_residual }] = await rows<{ bo_residual: string }>(db,
      `select shared_part(1234.57, 20, 50)::text as bo_residual`);

    const report = await report1(db, M);

    const ann = repRow(report, AGENT_ID)!;
    expect(ann).toMatchObject({
      agent_code: "101", legal_name: "Ito Payments LLC", full_name: "Agent User",
      deductions: "0.00", overrides_received: "0.00",
    });
    // Volume includes the shared account (signer's line); not Bo's.
    expect(ann.sales_volume).toBe("51000.00");
    expect(cents(ann.net_residual)).toBe(cents("100.00") + cents("-11.76") + cents("1234.57") - cents(bo_residual));
    expect(cents(ann.agent_split)).toBe(5000 - 1000 - 541 + signerPiece);
    expect(ann.total_commission).toBe(ann.agent_split);

    const bo = repRow(report, OTHER_AGENT_ID)!;
    // No LLC: the rep's own legal name (A17).
    expect(bo).toMatchObject({ agent_code: "102", legal_name: "Bo Lee", sales_volume: "0.00" });
    expect(bo.net_residual).toBe(bo_residual);
    expect(bo.agent_split).toBe(partner);

    const dana = repRow(report, MANAGER_ID)!;
    expect(dana).toMatchObject({
      sales_volume: "0.00", net_residual: "0.00", agent_split: "0.00",
      overrides_received: "10.00", total_commission: "10.00",
    });

    const house = repRow(report, HOUSE_ID)!;
    expect(house).toMatchObject({
      agent_code: "122", sales_volume: "20000.00", net_residual: "500.00",
      agent_split: "0.00", overrides_received: "0.00", total_commission: "0.00",
    });

    // One row per rep, then the month's total, then the grand total.
    expect(report.map((r) => r.row_kind)).toEqual(["rep", "rep", "rep", "rep", "month", "total"]);
    const total = report.find((r) => r.row_kind === "total")!;
    expect(total.sales_volume).toBe("71000.00");
    expect(total.overrides_received).toBe("10.00");
    expect(cents(total.total_commission)).toBe(
      [ann, bo, dana, house].reduce((s, r) => s + cents(r.total_commission), 0));
    expect(report.find((r) => r.row_kind === "month")).toMatchObject({ ...total, row_kind: "month", period: M });
  });

  it("Report 2: one row per MID, the account residual once, rep side and company share", async () => {
    await plantMonth(db);
    const report = await report2(db, M);
    const byMid = new Map(report.filter((r) => r.row_kind === "merchant").map((r) => [r.mid, r]));
    expect(byMid.size).toBe(4);

    expect(byMid.get("WK-PLAIN")).toMatchObject({
      processor: "TSYS", merchant_name: "WK-PLAIN Co", owner_id: AGENT_ID, owner_code: "101",
      owner_name: "Agent User", volume: "1000.00", residual: "100.00", rep_side: "50.00",
      company_overrides: "0.00", company_share: "50.00",
    });
    expect(byMid.get("WK-CLAW")).toMatchObject({
      volume: "0.00", residual: "-11.76", rep_side: "-5.41", company_share: "-6.35",
    });
    // The shared account once, under its signer, with the whole account's figures.
    expect(byMid.get("WK-SHARED")).toMatchObject({
      owner_id: AGENT_ID, volume: "50000.00", residual: "1234.57", rep_side: "617.29",
      company_share: "617.28",
    });
    expect(byMid.get("WK-HOUSE")).toMatchObject({
      owner_id: HOUSE_ID, owner_code: "122", volume: "20000.00", residual: "500.00",
      rep_side: "0.00", company_share: "500.00",
    });

    const sub = report.find((r) => r.row_kind === "processor")!;
    const total = report.find((r) => r.row_kind === "total")!;
    expect(sub).toMatchObject({ processor: "TSYS", period: M, residual: "1822.81", volume: "71000.00" });
    expect(total).toMatchObject({ residual: "1822.81", rep_side: "661.88", company_share: "1160.93" });
    expect(report.map((r) => r.row_kind)).toEqual(["merchant", "merchant", "merchant", "merchant", "processor", "total"]);
  });

  it("the two reports reconcile with the file and with each rep's statement", async () => {
    await plantMonth(db);
    const r1 = await report1(db, M);
    const r2 = await report2(db, M);
    const reps = r1.filter((r) => r.row_kind === "rep");
    const company = r2.filter((r) => r.row_kind === "merchant").reduce((s, r) => s + cents(r.company_share), 0);
    const paid = reps.reduce((s, r) => s + cents(r.agent_split) + cents(r.overrides_received), 0);
    expect(paid + company).toBe(cents("100.00") + cents("-11.76") + cents("1234.57") + cents("500.00"));
    for (const rep of reps) {
      expect(cents(rep.total_commission) + cents(rep.deductions), rep.full_name!)
        .toBe(await statementTotal(db, rep.agent_id!, M));
    }
  });
});

// -------------------------------------------------------------------------
// 3. Committed only
// -------------------------------------------------------------------------

describe("committed batches only", () => {
  const M = monthsAgo(4);

  /** A ledger line planted on `batchId` (or none), as the owner. */
  async function plantLine(target: TestDb, mid: string, batchId: number | null, residual = "100.00"): Promise<void> {
    await asPlatform(target);
    await target.exec(`
      insert into rep_payout_rows (agent_id, period, processor, mid, merchant_name, volume,
                                   residual_income, rep_split_pct, batch_id)
      values ('${AGENT_ID}', '${M}', 'TSYS', '${mid}', '${mid} Co', 1000, ${residual}, 50, ${batchId ?? "null"})`);
  }

  it("a line on a review, abandoned or replaced batch, or on none, is not counted", async () => {
    await merchant(db, "CO-REAL", AGENT_ID, 50);
    await commitMonth(db, "TSYS", M, [{ mid: "CO-REAL" }]);
    await asPlatform(db);
    const review = await insertBatch(db, { extra: { processor: "'Square'", period: `'${M}'` } });
    const abandoned = await insertBatch(db, { status: "abandoned", extra: { processor: "'PayBright'", period: `'${M}'` } });
    await plantLine(db, "CO-REVIEW", review);
    await plantLine(db, "CO-ABANDONED", abandoned);
    await plantLine(db, "CO-NONE", null);

    const r1 = await report1(db, M);
    expect(repRow(r1, AGENT_ID)).toMatchObject({ net_residual: "100.00", agent_split: "50.00" });
    const r2 = await report2(db, M);
    expect(r2.filter((r) => r.row_kind === "merchant").map((r) => r.mid)).toEqual(["CO-REAL"]);
  });

  it("a real replace counts only the replacement; a real period delete leaves nothing", async () => {
    await merchant(db, "CO-A", AGENT_ID, 50);
    await merchant(db, "CO-B", OTHER_AGENT_ID, 40);
    const first = await commitMonth(db, "TSYS", M, [
      { mid: "CO-A", residual: "100.00" }, { mid: "CO-B", residual: "300.00" },
    ]);
    await commitMonth(db, "TSYS", M, [{ mid: "CO-A", residual: "80.00" }], first);
    const [{ status }] = await rows<{ status: string }>(db,
      `select status from rep_payout_batches where id = ${first}`);
    expect(status).toBe("replaced");

    const r1 = await report1(db, M);
    expect(repRow(r1, AGENT_ID)).toMatchObject({ net_residual: "80.00", agent_split: "40.00" });
    expect(repRow(r1, OTHER_AGENT_ID)).toBeUndefined();
    const r2 = await report2(db, M);
    expect(r2.find((r) => r.row_kind === "total")?.residual).toBe("80.00");

    await asAdmin(db, () => db.query(`select delete_payout_period('${M}', 'TSYS')`));
    expect(await report1(db, M)).toEqual([]);
    expect(await report2(db, M)).toEqual([]);
  });
});

// -------------------------------------------------------------------------
// 4. Deductions: shown, never in the total
// -------------------------------------------------------------------------

describe("deductions (adjustments)", () => {
  it("are their own column, not in the total, and total + deductions is the statement", async () => {
    const paidMonth = monthsAgo(6);
    const nextMonth = monthsAgo(5);
    await merchant(db, "AD-1", AGENT_ID, 50);
    await commitMonth(db, "TSYS", paidMonth, [{ mid: "AD-1", residual: "200.00" }]);
    const label = new Date(`${paidMonth}T00:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
    await asAdmin(db, () => db.query(`select close_payout_period('${paidMonth}', 'TSYS', 'TSYS ${label}')`));
    // Posts in the month after the latest import: nextMonth.
    const [{ result }] = await asAdmin(db, () => rows<{ result: { posting_period: string } }>(db,
      `select post_payout_adjustment('${AGENT_ID}', 'AD-1', '${paidMonth}', 'TSYS', -25.50, 'Chargeback') as result`));
    expect(result.posting_period).toBe(nextMonth);
    await commitMonth(db, "TSYS", nextMonth, [{ mid: "AD-1", residual: "300.00" }]);

    const report = await report1(db, nextMonth);
    const ann = repRow(report, AGENT_ID)!;
    expect(ann).toMatchObject({ agent_split: "150.00", deductions: "-25.50", total_commission: "150.00" });
    expect(cents(ann.total_commission) + cents(ann.deductions)).toBe(await statementTotal(db, AGENT_ID, nextMonth));
    expect(report.find((r) => r.row_kind === "total")?.deductions).toBe("-25.50");

    // Under its processor, and not under another one.
    expect(repRow(await report1(db, nextMonth, nextMonth, "TSYS"), AGENT_ID)?.deductions).toBe("-25.50");
    expect(await report1(db, nextMonth, nextMonth, "Square")).toEqual([]);
    // Report 2 is the file: an adjustment is not a merchant line.
    const r2 = await report2(db, nextMonth);
    expect(r2.find((r) => r.row_kind === "total")?.residual).toBe("300.00");
  });

  it("a rep with only an adjustment in a month has a row with a zero total", async () => {
    const paidMonth = monthsAgo(8);
    const nextMonth = monthsAgo(7);
    await merchant(db, "AD-2", AGENT_ID, 50);
    await commitMonth(db, "TSYS", paidMonth, [{ mid: "AD-2" }]);
    const label = new Date(`${paidMonth}T00:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
    await asAdmin(db, () => db.query(`select close_payout_period('${paidMonth}', 'TSYS', 'TSYS ${label}')`));
    await asAdmin(db, () => db.query(
      `select post_payout_adjustment('${OTHER_AGENT_ID}', 'AD-2', '${paidMonth}', 'TSYS', 12.00, 'Owed')`));
    const report = await report1(db, nextMonth);
    expect(repRow(report, OTHER_AGENT_ID)).toMatchObject({
      sales_volume: "0.00", agent_split: "0.00", deductions: "12.00", total_commission: "0.00",
    });
  });
});

// -------------------------------------------------------------------------
// 5. Reconciliation over many random cases
// -------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32), so a failure is reproducible from its seed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RATES = [0, 0.01, 12.5, 30, 33.33, 46, 46.5, 50];
const PROCESSORS = ["TSYS", "Square", "PayBright"];
const OWNERS = [AGENT_ID, OTHER_AGENT_ID];

describe("reconciliation over random months, through the real commit", () => {
  for (const seed of [12, 2026]) {
    it(`seed ${seed}: split + received + company = the file; every rep = the statement`, async () => {
      const rand = prng(seed);
      const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)];
      const months = [monthsAgo(10), monthsAgo(9)];
      // The file residuals each committed processor-month carried, by month.
      const fileTotal = new Map<string, number>(months.map((m) => [m, 0]));
      const filePerProcessor = new Map<string, number>();

      let n = 0;
      for (const month of months) {
        for (const processor of PROCESSORS) {
          const staged: Staged[] = [];
          const count = 6 + Math.floor(rand() * 8);
          for (let i = 0; i < count; i += 1) {
            n += 1;
            const mid = `RC${seed}-${n}`;
            const house = rand() < 0.15;
            const owner = house ? HOUSE_ID : pick(OWNERS);
            const rate = house ? 0 : pick(RATES.filter((r) => r > 0));
            const id = await merchant(db, mid, owner, rate);
            if (!house && rate >= 0.02 && rand() < 0.35) {
              const partner = owner === AGENT_ID ? OTHER_AGENT_ID : AGENT_ID;
              const steps = Math.round(rate * 100);
              const a = (1 + Math.floor(rand() * (steps - 1))) / 100;
              await share(db, id, owner, partner, a, Math.round((rate - a) * 100) / 100, month);
            }
            if (!house && rand() < 0.4) {
              const o = Math.max(1, Math.floor(rand() * Math.round(rate * 100))) / 100;
              // Both fundings (20261116120000), in the same months.
              await override(db, id, o, month, rand() < 0.5 ? "owner" : "company");
            }
            // Clawbacks, zero-volume fee lines, odd cents, exact zeros.
            const kind = rand();
            const residualCents = kind < 0.15 ? -Math.floor(rand() * 5000)
              : kind < 0.2 ? 0
              : Math.floor(rand() * 500000);
            const volume = kind < 0.25 ? "0.00" : (Math.floor(rand() * 10000000) / 100).toFixed(2);
            staged.push({ mid, volume, residual: (residualCents / 100).toFixed(2) });
            fileTotal.set(month, fileTotal.get(month)! + residualCents);
            const key = `${month}|${processor}`;
            filePerProcessor.set(key, (filePerProcessor.get(key) ?? 0) + residualCents);
          }
          await commitMonth(db, processor, month, staged);
        }
      }

      // Not vacuous: the months hold every awkward shape.
      const [shape] = await rows<Record<string, number>>(db, `
        select count(*) filter (where share_role = 'secondary')::int as partners,
               count(*) filter (where override_role = 'credit')::int as overrides,
               count(*) filter (where override_role = 'credit' and override_funded_by = 'company')::int as company_funded,
               count(*) filter (where override_role = 'credit' and override_funded_by = 'owner')::int as owner_funded,
               count(*) filter (where line_kind = 'import' and residual_income < 0)::int as clawbacks,
               count(*) filter (where line_kind = 'import' and volume = 0)::int as zero_volume,
               count(*) filter (where line_kind = 'import' and rep_split_pct = 0)::int as house
          from rep_payout_rows`);
      for (const [name, count] of Object.entries(shape)) expect(count, name).toBeGreaterThan(2);

      for (const month of months) {
        const r1 = await report1(db, month);
        const r2 = await report2(db, month);
        const reps = r1.filter((r) => r.row_kind === "rep");
        const merchants = r2.filter((r) => r.row_kind === "merchant");

        const paid = reps.reduce((s, r) => s + cents(r.agent_split) + cents(r.overrides_received), 0);
        const company = merchants.reduce((s, r) => s + cents(r.company_share), 0);
        expect(paid + company, `${month}: split + received + company`).toBe(fileTotal.get(month));

        const total2 = r2.find((r) => r.row_kind === "total")!;
        expect(cents(total2.residual), `${month}: Report 2 total`).toBe(fileTotal.get(month));
        expect(cents(total2.rep_side) + cents(total2.company_overrides) + cents(total2.company_share))
          .toBe(fileTotal.get(month));
        // Owner-funded debits and credits cancel; a company-funded credit is
        // paid on top of the rep side, out of the company's share.
        expect(paid).toBe(cents(total2.rep_side) + cents(total2.company_overrides));
        // Every Report 2 row adds up: residual = rep side + overrides from company + company share.
        for (const row of merchants) {
          expect(cents(row.rep_side) + cents(row.company_overrides) + cents(row.company_share), row.mid!)
            .toBe(cents(row.residual));
        }

        // Every rep row is that rep's statement.
        for (const rep of reps) {
          expect(cents(rep.total_commission) + cents(rep.deductions), `${month} ${rep.full_name}`)
            .toBe(await statementTotal(db, rep.agent_id!, month));
          expect(cents(rep.total_commission)).toBe(cents(rep.agent_split) + cents(rep.overrides_received));
        }
        // The house: zero split, zero total, its volume and net still shown.
        const house = repRow(r1, HOUSE_ID);
        if (house) {
          expect(house.agent_split).toBe("0.00");
          expect(house.total_commission).toBe("0.00");
        }
        // The totals rows are the sums of the rows above them.
        const total1 = r1.find((r) => r.row_kind === "total")!;
        for (const column of ["sales_volume", "net_residual", "agent_split", "overrides_received", "total_commission"] as const) {
          expect(cents(total1[column]), column).toBe(reps.reduce((s, r) => s + cents(r[column]), 0));
        }
        for (const column of ["volume", "residual", "rep_side", "company_overrides", "company_share"] as const) {
          expect(cents(total2[column]), column).toBe(merchants.reduce((s, r) => s + cents(r[column]), 0));
        }

        // Each processor on its own reconciles too, and the subtotals are the file's.
        for (const processor of PROCESSORS) {
          const p1 = await report1(db, month, month, processor);
          const p2 = await report2(db, month, month, processor);
          const pPaid = p1.filter((r) => r.row_kind === "rep")
            .reduce((s, r) => s + cents(r.agent_split) + cents(r.overrides_received), 0);
          const pCompany = p2.filter((r) => r.row_kind === "merchant").reduce((s, r) => s + cents(r.company_share), 0);
          expect(pPaid + pCompany, `${month} ${processor}`).toBe(filePerProcessor.get(`${month}|${processor}`));
          expect(p2.every((r) => r.processor === processor || r.row_kind === "total")).toBe(true);
          const sub = r2.find((r) => r.row_kind === "processor" && r.processor === processor)!;
          expect(cents(sub.residual)).toBe(filePerProcessor.get(`${month}|${processor}`));
        }
      }

      // The range: both months at once is the sum of each.
      const both = await report2(db, months[0], months[1]);
      expect(cents(both.find((r) => r.row_kind === "total")!.residual))
        .toBe(fileTotal.get(months[0])! + fileTotal.get(months[1])!);
    }, 120_000);
  }
});

// -------------------------------------------------------------------------
// 6. The migration
// -------------------------------------------------------------------------

describe("the migration", () => {
  it("passes over a database holding committed months, and changes no row", async () => {
    const before = await open(await migrationsBefore(MIGRATION));
    await resetData(before);
    await addPeople(before);
    await merchant(before, "MG-1", AGENT_ID, 50);
    await commitMonth(before, "TSYS", monthsAgo(2), [{ mid: "MG-1" }]);
    const snapshot = async () => rows<{ s: string }>(before,
      `select md5(string_agg(t::text, ',' order by id)) as s from rep_payout_rows t`);
    const was = await snapshot();
    await before.exec(await readMigration(MIGRATION));
    expect(await snapshot()).toEqual(was);
    expect(repRow(await report1(before, monthsAgo(2)), AGENT_ID)?.agent_split).toBe("50.00");
  });

  it("refuses, naming it, when a column the bodies read is missing", async () => {
    const before = await open(await migrationsBefore(MIGRATION));
    await before.exec(`alter table profiles rename column llc_legal_name to llc_name_gone`);
    const error = await attempt(async () => before.exec(await readMigration(MIGRATION)));
    expect(error?.message).toContain("profiles.llc_legal_name");
    expect(await rows(before, `select 1 from pg_proc where proname = '${R1}'`)).toEqual([]);
  });
});

// -------------------------------------------------------------------------
// 7. Mutation proofs
// -------------------------------------------------------------------------

describe("mutation proofs: each protection is what stops its case", () => {
  let mutant: TestDb;
  const SIGS = [`${R1}(date, date, text)`, `${R2}(date, date, text)`];
  const originals: string[] = [];
  const M = monthsAgo(2);

  beforeAll(async () => {
    mutant = await open();
    for (const fn of SIGS) {
      const [{ def }] = await rows<{ def: string }>(mutant, `select pg_get_functiondef('${fn}'::regprocedure) as def`);
      originals.push(def);
    }
  });

  beforeEach(async () => {
    await resetData(mutant);
    await addPeople(mutant);
    for (const def of originals) await mutant.exec(def);
  });

  async function without(fn: string, fragment: string, replacement = ""): Promise<void> {
    await asPlatform(mutant);
    const [{ def }] = await rows<{ def: string }>(mutant, `select pg_get_functiondef('${fn}'::regprocedure) as def`);
    expect(def, "the fragment must be in the function").toContain(fragment);
    await mutant.exec(def.replace(fragment, replacement));
  }

  /** A committed month for AGENT_ID: R = 100 at 50, and a 10% override to Dana. */
  async function month(target: TestDb): Promise<void> {
    const m = await merchant(target, "MU-1", AGENT_ID, 50);
    await override(target, m, 10, M);
    await commitMonth(target, "TSYS", M, [{ mid: "MU-1", residual: "100.00" }]);
  }

  for (const [i, fn] of [R1, R2].entries()) {
    it(`admin-only in ${fn}: without the is_admin() check a rep is answered`, async () => {
      await month(mutant);
      const call = (target: TestDb) => attempt(() => asAdmin(target,
        () => target.query(`select * from ${fn}('${M}', '${M}', null)`), AGENT_ID));
      expect((await call(mutant))?.code).toBe("PT403");
      await without(SIGS[i], "if not is_admin() then", "if false then");
      expect(await call(mutant)).toBeNull();
    });
  }

  it("committed-only in Report 1: without the status filter an abandoned batch's line counts", async () => {
    await month(mutant);
    await asPlatform(mutant);
    const abandoned = await insertBatch(mutant, { status: "abandoned", extra: { processor: "'Square'", period: `'${M}'` } });
    await mutant.exec(`
      insert into rep_payout_rows (agent_id, period, processor, mid, volume, residual_income, rep_split_pct, batch_id)
      values ('${AGENT_ID}', '${M}', 'Square', 'MU-GHOST', 1000, 1000, 50, ${abandoned})`);
    expect(repRow(await report1(mutant, M), AGENT_ID)?.net_residual).toBe("100.00");
    await without(SIGS[0], "and (l.line_kind = 'adjustment' or b.status = 'committed')");
    expect(repRow(await report1(mutant, M), AGENT_ID)?.net_residual).toBe("1100.00");
  });

  it("committed-only in Report 2: without the status filter an abandoned batch's line counts", async () => {
    await month(mutant);
    await asPlatform(mutant);
    const abandoned = await insertBatch(mutant, { status: "abandoned", extra: { processor: "'Square'", period: `'${M}'` } });
    await mutant.exec(`
      insert into rep_payout_rows (agent_id, period, processor, mid, volume, residual_income, rep_split_pct, batch_id)
      values ('${AGENT_ID}', '${M}', 'Square', 'MU-GHOST', 1000, 1000, 50, ${abandoned})`);
    expect((await report2(mutant, M)).find((r) => r.row_kind === "total")?.residual).toBe("100.00");
    await without(SIGS[1], "and b.status = 'committed'");
    expect((await report2(mutant, M)).find((r) => r.row_kind === "total")?.residual).toBe("1100.00");
  });

  it("the total formula: without the override received, Dana's total is zero", async () => {
    await month(mutant);
    expect(repRow(await report1(mutant, M), MANAGER_ID)?.total_commission).toBe("10.00");
    await without(SIGS[0], "round(a.split + a.received, 2)", "round(a.split, 2)");
    expect(repRow(await report1(mutant, M), MANAGER_ID)?.total_commission).toBe("0.00");
  });

  it("the total formula: without the override debit, the rep's split is the whole rep side", async () => {
    await month(mutant);
    expect(repRow(await report1(mutant, M), AGENT_ID)?.agent_split).toBe("40.00");
    await without(SIGS[0],
      "+ coalesce(sum(l.override_amount)\n                          filter (where l.line_kind = 'override' and l.override_role = 'debit'), 0)");
    expect(repRow(await report1(mutant, M), AGENT_ID)?.agent_split).toBe("50.00");
  });

  // 20261116120000: a company-funded override. R = 100 at 50, 5% to Dana from
  // the company: the rep keeps the full 50, Dana 5, the company 45.
  async function companyMonth(target: TestDb): Promise<void> {
    const m = await merchant(target, "MU-CO", AGENT_ID, 50);
    await override(target, m, 5, M, "company");
    await commitMonth(target, "TSYS", M, [{ mid: "MU-CO", residual: "100.00" }]);
  }

  it("a company-funded override: the owner's split is the full rep side; Report 2 takes it from the company", async () => {
    await companyMonth(mutant);
    const r1 = await report1(mutant, M);
    expect(repRow(r1, AGENT_ID)).toMatchObject({ agent_split: "50.00", overrides_received: "0.00", total_commission: "50.00" });
    expect(repRow(r1, MANAGER_ID)).toMatchObject({ agent_split: "0.00", overrides_received: "5.00", total_commission: "5.00" });
    const row = (await report2(mutant, M)).find((r) => r.row_kind === "merchant");
    expect(row).toMatchObject({ residual: "100.00", rep_side: "50.00", company_overrides: "5.00", company_share: "45.00" });
  });

  it("the company share: without subtracting the company-funded overrides, a Report 2 row would not add up", async () => {
    await companyMonth(mutant);
    await without(SIGS[1], "round(a.res - a.rep - a.co, 2)", "round(a.res - a.rep, 2)");
    const row = (await report2(mutant, M)).find((r) => r.row_kind === "merchant")!;
    expect(row.company_share).toBe("50.00");
    expect(cents(row.rep_side) + cents(row.company_overrides) + cents(row.company_share)).not.toBe(cents(row.residual));
  });

  it("the company overrides: an owner-funded override's credit never counts as the company's", async () => {
    await month(mutant);
    const owned = async () => (await report2(mutant, M)).find((r) => r.row_kind === "merchant");
    expect(await owned()).toMatchObject({ rep_side: "50.00", company_overrides: "0.00", company_share: "50.00" });
    await without(SIGS[1], "\n                and l.override_funded_by = 'company'", "");
    expect(await owned()).toMatchObject({ company_overrides: "10.00", company_share: "40.00" });
  });

  it("a shared account's residual once: counting the partner's line again would be caught", async () => {
    const m = await merchant(mutant, "MU-SH", AGENT_ID, 50);
    await share(mutant, m, AGENT_ID, OTHER_AGENT_ID, 30, 20, M);
    await commitMonth(mutant, "TSYS", M, [{ mid: "MU-SH", residual: "1234.57" }]);
    const residual = async () => (await report2(mutant, M)).find((r) => r.row_kind === "merchant")?.residual;
    expect(await residual()).toBe("1234.57");
    await without(SIGS[1], "when l.share_role = 'primary' then l.account_residual_income",
      "else l.account_residual_income");
    expect(await residual()).toBe("2469.14");
  });

  async function withAdjustment(target: TestDb): Promise<string> {
    const paidMonth = monthsAgo(4);
    const nextMonth = monthsAgo(3);
    await merchant(target, "MU-AD", AGENT_ID, 50);
    await commitMonth(target, "TSYS", paidMonth, [{ mid: "MU-AD" }]);
    const label = new Date(`${paidMonth}T00:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
    await asAdmin(target, () => target.query(`select close_payout_period('${paidMonth}', 'TSYS', 'TSYS ${label}')`));
    await asAdmin(target, () => target.query(
      `select post_payout_adjustment('${AGENT_ID}', 'MU-AD', '${paidMonth}', 'TSYS', -25.00, 'Chargeback')`));
    await commitMonth(target, "TSYS", nextMonth, [{ mid: "MU-AD", residual: "100.00" }]);
    return nextMonth;
  }

  it("the deductions exclusion: a total that subtracted them would be caught", async () => {
    const m = await withAdjustment(mutant);
    expect(repRow(await report1(mutant, m), AGENT_ID)).toMatchObject({ deductions: "-25.00", total_commission: "50.00" });
    await without(SIGS[0], "round(a.split + a.received, 2)", "round(a.split + a.received + a.deduct, 2)");
    expect(repRow(await report1(mutant, m), AGENT_ID)?.total_commission).toBe("25.00");
  });

  it("the deductions exclusion: a split that took in adjustment lines would be caught", async () => {
    const m = await withAdjustment(mutant);
    expect(repRow(await report1(mutant, m), AGENT_ID)?.agent_split).toBe("50.00");
    await without(SIGS[0],
      "coalesce(sum(l.rep_payout) filter (where l.line_kind = 'import'), 0)\n",
      "coalesce(sum(l.rep_payout) filter (where l.line_kind <> 'override'), 0)\n");
    expect(repRow(await report1(mutant, m), AGENT_ID)?.agent_split).toBe("25.00");
  });
});
