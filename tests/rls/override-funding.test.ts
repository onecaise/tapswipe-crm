import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_ID,
  AGENT_ID,
  OTHER_AGENT_ID,
  asPlatform,
  asUser,
  createTestDb,
  freeBatchMonth,
  insertBatch,
  migrationsBefore,
  readMigration,
  resetData,
  rows,
  type TestDb,
} from "../helpers/db";

/**
 * 20261116120000, override funding -- docs/design/override-funding.md.
 * What this file pins (the design's §5.3):
 *
 *   1. The invariant to the cent, BOTH modes, over many random cases through
 *      the real commit v3: owner/pair lines + override lines + company share
 *      = R. Owner-funded: debits + credit = 0. Company-funded: no debit line
 *      at all, one credit of X, the reps' lines total T. Odd in R.
 *   2. The worked examples (45/5/50 and 50/5/45), a shared account with a
 *      company-funded override, and the one-cent edge: at s = o = 50 an
 *      odd-cent residual leaves the company -0.01 and the sum still holds.
 *   3. set_merchant_override requires the funding (NULL and a bad value are
 *      22023; the four-argument function is gone); "Change" never inherits.
 *   4. A funding change: audited once with the reason and the months; the
 *      table changes and the ledger does not; override_funding_pending()
 *      lists the month; Mark paid is refused; a replace applies it, and
 *      switching back and replacing restores the figures to the cent.
 *   5. Refusals: rep, anon, missing, bad value, short reason, a paid touched
 *      month (allowed after Reopen), owner funding the merchant can no longer
 *      carry, the ledger CHECKs.
 *   6. Period delete and cancel with credit-only lines.
 *   7. The catalog: every new or re-created function's security, search_path
 *      and EXECUTE surface; the migration revokes before it grants.
 *   8. The migration over a populated ledger: the backfill is true and
 *      validated, nothing moves, and it refuses an inconsistent pair or a
 *      CHECK it does not expect.
 *   9. Mutation proofs.
 */

const MIGRATION = "20261116120000_override_funding.sql";
const V3 = "commit_residual_import_v3";
const MANAGER_ID = "44444444-4444-4444-4444-444444444444";
const REASON = "Owner decision: paid from the company's share, as ISO Hub pays it.";
/** REASON as a SQL literal's body. */
const RQ = REASON.replace(/'/g, "''");

type DbError = { code?: string; message: string; detail?: string };
type Funding = "owner" | "company";

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

async function addManager(target: TestDb): Promise<void> {
  await asPlatform(target);
  await target.exec(`
    insert into auth.users (id, email) values ('${MANAGER_ID}', 'dana@tapswipe.test');
    insert into profiles (id, full_name, role, is_active, email)
    values ('${MANAGER_ID}', 'Dana Cole', 'agent', true, 'dana@tapswipe.test');
    delete from audit_log;`);
}

async function merchant(target: TestDb, mid: string, rate = 50, owner = AGENT_ID): Promise<number> {
  await asPlatform(target);
  const [{ id }] = await rows<{ id: number }>(
    target,
    `insert into merchants (agent_id, mid, dba, status, processor, split_agent_pct, split_company_pct, city, state)
     values ('${owner}', '${mid}', '${mid} Co', 'active', 'TSYS', ${rate}, ${100 - rate}, 'Nashville', 'TN')
     returning id`,
  );
  return id;
}

/** An override as the platform; `funded` is omitted on a database from before this migration. */
async function plant(
  target: TestDb,
  merchantId: number,
  pct: number,
  from: string,
  funded: Funding | null = "owner",
): Promise<number> {
  await asPlatform(target);
  const [{ id }] = await rows<{ id: number }>(
    target,
    funded === null
      ? `insert into merchant_overrides (merchant_id, recipient_id, override_pct, effective_from)
         values (${merchantId}, '${MANAGER_ID}', ${pct}, '${from}') returning id`
      : `insert into merchant_overrides (merchant_id, recipient_id, override_pct, effective_from, funded_by)
         values (${merchantId}, '${MANAGER_ID}', ${pct}, '${from}', '${funded}') returning id`,
  );
  return id;
}

async function share(target: TestDb, merchantId: number, a: number, b: number, from: string): Promise<void> {
  await asPlatform(target);
  await target.exec(`
    insert into merchant_rep_shares (merchant_id, primary_agent_id, secondary_agent_id,
                                     primary_rep_pct, secondary_rep_pct, effective_from)
    values (${merchantId}, '${AGENT_ID}', '${OTHER_AGENT_ID}', ${a}, ${b}, '${from}')`);
}

async function freeMonth(target: TestDb): Promise<string> {
  await asPlatform(target);
  const [{ m }] = await rows<{ m: string }>(target, `select ${freeBatchMonth("TSYS")}::text as m`);
  return m;
}

/** A TSYS review batch for `period`, its rows staged as the parser leaves them. */
async function batchWith(
  target: TestDb,
  staged: { mid: string; residual?: string; volume?: string }[],
  period: string,
  replaces?: number,
): Promise<number> {
  await asPlatform(target);
  const extra: Record<string, string> = { processor: "'TSYS'", period: `'${period}'` };
  if (replaces !== undefined) extra.replaces_batch_id = String(replaces);
  const id = await insertBatch(target, { extra });
  const values = staged.map((row, i) => `
    (${id}, ${i + 2}, '${row.mid}', 'File name', 'TSYS', 'Residuals', 'v', 'r', '${period}',
     (select agent_id from merchants where mid = '${row.mid}'),
     (select id from merchants where mid = '${row.mid}'),
     ${row.volume ?? "100000.00"}, ${row.residual ?? "100.00"}, null, '{}')`);
  await target.exec(`
    insert into rep_payout_import_rows
      (batch_id, row_number, mid_raw, merchant_name_raw, processor_raw, income_type_raw,
       volume_raw, residual_income_raw, period, agent_id, merchant_id,
       volume, residual_income, blocker, blockers)
    values ${values.join(",")}`);
  return id;
}

async function commit(target: TestDb, id: number): Promise<Record<string, number>> {
  await asUser(target, ADMIN_ID);
  try {
    const [{ result }] = await rows<{ result: Record<string, number> }>(
      target,
      `select ${V3}(${id}, '{}'::text[]) as result`,
    );
    return result;
  } finally {
    await asPlatform(target);
  }
}

/** A month committed for `staged`, returning the batch id. */
async function commitMonth(
  target: TestDb,
  staged: { mid: string; residual?: string }[],
  period: string,
  replaces?: number,
): Promise<number> {
  const id = await batchWith(target, staged, period, replaces);
  await commit(target, id);
  return id;
}

async function rpc(target: TestDb, sql: string, who: string | null = ADMIN_ID): Promise<DbError | null> {
  await asUser(target, who);
  try {
    return await attempt(() => target.query(sql));
  } finally {
    await asPlatform(target);
  }
}

async function call<T>(target: TestDb, sql: string, who: string | null = ADMIN_ID): Promise<T[]> {
  await asUser(target, who);
  try {
    return await rows<T>(target, sql);
  } finally {
    await asPlatform(target);
  }
}

const setFunding = (target: TestDb, id: number, funded: string, reason = REASON) =>
  call<{ r: { changed: boolean; from: string; to: string; replace: { processor: string; period: string; batch_id: number }[] } }>(
    target,
    `select set_merchant_override_funding(${id}, '${funded}', '${reason.replace(/'/g, "''")}') as r`,
  ).then(([row]) => row.r);

type Line = { agent_id: string; line_kind: string; role: string | null; payout: string; funded: string | null };

async function linesOf(target: TestDb, batchId: number): Promise<Line[]> {
  await asPlatform(target);
  return rows<Line>(
    target,
    `select agent_id, line_kind, override_role as role, rep_payout::text as payout,
            override_funded_by as funded
       from rep_payout_rows where batch_id = ${batchId}
      order by line_kind, override_role nulls first, agent_id`,
  );
}

type R2 = { mid: string | null; residual: string; rep_side: string; company_overrides: string; company_share: string };

async function report2(target: TestDb, period: string): Promise<R2[]> {
  return call<R2>(
    target,
    `select mid, residual::text, rep_side::text, company_overrides::text, company_share::text
       from merchant_processor_summary('${period}', '${period}', null) where row_kind = 'merchant'`,
  );
}

async function split(target: TestDb, period: string, agentId: string): Promise<{ agent_split: string; overrides_received: string }> {
  const [row] = await call<{ agent_split: string; overrides_received: string }>(
    target,
    `select agent_split::text, overrides_received::text
       from rep_payout_summary('${period}', '${period}', null)
      where row_kind = 'rep' and agent_id = '${agentId}'`,
  );
  return row;
}

const pending = (target: TestDb) =>
  call<{ processor: string; period: string; batch_id: number; override_count: number }>(
    target,
    `select processor, period::text, batch_id, override_count from override_funding_pending()`,
  );

const monthName = (period: string) =>
  new Date(`${period}T00:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

const markPaid = (target: TestDb, period: string) =>
  rpc(target, `select close_payout_period('${period}', 'TSYS', 'TSYS ${monthName(period)}')`);

const cents = (value: string | number | null | undefined): number =>
  value === null || value === undefined ? 0 : Math.round(Number(value) * 100);

let db: TestDb;

beforeAll(async () => {
  db = await open();
});

/** payout_period_closures has no profiles FK, so resetData leaves it: clear it (TRUNCATE, as the replace suite does). */
async function clearClosures(target: TestDb): Promise<void> {
  await asPlatform(target);
  await target.exec(`truncate payout_period_closures`);
}

beforeEach(async () => {
  await resetData(db);
  await clearClosures(db);
  await addManager(db);
});

// -------------------------------------------------------------------------
// 1. The invariant, both modes, through commit v3
// -------------------------------------------------------------------------

/** Postgres round(): nearest, half away from zero. In cents x hundredths / 10000. */
function roundAway(numerator: number, denominator: number): number {
  const sign = Math.sign(numerator);
  const n = Math.abs(numerator);
  return sign * Math.floor((2 * n + denominator) / (2 * denominator)) || 0;
}

/** A small deterministic PRNG (mulberry32), so a failure reproduces. */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** R in cents; s, o, b in hundredths of a percent; the funding. */
type Case = { r: number; s: number; o: number; b: number | null; funded: Funding };

function cases(seed: number, count: number): Case[] {
  const rand = prng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const out: Case[] = [
    { r: 10000, s: 5000, o: 500, b: null, funded: "owner" },
    { r: 10000, s: 5000, o: 500, b: null, funded: "company" },
    { r: 1, s: 5000, o: 5000, b: null, funded: "company" }, // the one-cent edge
    { r: 3, s: 5000, o: 5000, b: 2500, funded: "company" },
    { r: 30, s: 5000, o: 5000, b: 2500, funded: "owner" },
  ];
  while (out.length < count) {
    const s = rand() < 0.3 ? [5000, 4600, 3000, 1].at(int(0, 3))! : int(1, 5000);
    const o = rand() < 0.15 ? s : int(1, s);
    const shared = s >= 2 && rand() < 0.4;
    const b = shared ? int(1, s - 1) : null;
    const r = rand() < 0.2 ? int(-200, 200) : int(-5_000_000, 5_000_000);
    out.push({ r, s, o, b, funded: rand() < 0.5 ? "owner" : "company" });
  }
  return out.flatMap((c) => [c, { ...c, r: -c.r }]);
}

/** Every way the committed lines and Report 2 break the invariant. Empty when the money is right. */
async function propertyCheck(target: TestDb, seed: number, count: number): Promise<string[]> {
  const list = cases(seed, count);
  const period = await freeMonth(target);
  await asPlatform(target);
  const money = (c: number) => (c / 100).toFixed(2);
  const pct = (h: number) => (h / 100).toFixed(2);
  await target.exec(`
    insert into merchants (agent_id, mid, dba, status, processor, split_agent_pct, split_company_pct, city, state)
    values ${list.map((c, i) => `('${AGENT_ID}', 'F-${i}', 'F ${i}', 'active', 'TSYS', ${pct(c.s)}, ${pct(10000 - c.s)}, 'Nashville', 'TN')`).join(",")}`);
  await target.exec(`
    insert into merchant_overrides (merchant_id, recipient_id, override_pct, effective_from, funded_by)
    select m.id, '${MANAGER_ID}', v.o, '${period}', v.f
      from merchants m
      join (values ${list.map((c, i) => `('F-${i}', ${pct(c.o)}, '${c.funded}')`).join(",")}) as v(mid, o, f)
        on v.mid = m.mid`);
  const shared = list.map((c, i) => [c, i] as const).filter(([c]) => c.b !== null);
  if (shared.length > 0) {
    await target.exec(`
      insert into merchant_rep_shares (merchant_id, primary_agent_id, secondary_agent_id, primary_rep_pct, secondary_rep_pct, effective_from)
      select m.id, '${AGENT_ID}', '${OTHER_AGENT_ID}', v.a, v.b, '${period}'
        from merchants m join (values ${shared.map(([c, i]) => `('F-${i}', ${pct(c.s - c.b!)}, ${pct(c.b!)})`).join(",")}) as v(mid, a, b)
          on v.mid = m.mid`);
  }
  const id = await batchWith(
    target,
    list.map((c, i) => ({ mid: `F-${i}`, residual: money(c.r), volume: "99999999.00" })),
    period,
  );
  const result = await commit(target, id);

  const lines = await rows<{ mid: string; agent_id: string; line_kind: string; role: string | null; payout: string; funded: string | null }>(
    target,
    `select mid, agent_id, line_kind, override_role as role, rep_payout::text as payout, override_funded_by as funded
       from rep_payout_rows where batch_id = ${id}`,
  );
  const byMid = new Map<string, typeof lines>();
  for (const line of lines) byMid.set(line.mid, [...(byMid.get(line.mid) ?? []), line]);
  const r2 = new Map((await report2(target, period)).map((row) => [row.mid, row]));

  const wrong: string[] = [];
  const nets: number[][] = [];
  for (const [i, c] of list.entries()) {
    const mid = `F-${i}`;
    const mine = byMid.get(mid) ?? [];
    const label = `case ${i} ${JSON.stringify(c)}`;
    const t = roundAway(c.r * c.s, 10000);
    const x = roundAway(c.r * c.o, 10000);
    const sum = (filter: (l: (typeof lines)[number]) => boolean) =>
      mine.filter(filter).reduce((s, l) => s + cents(l.payout), 0);
    const repLines = sum((l) => l.line_kind === "import");
    const debits = sum((l) => l.role === "debit");
    const debitCount = mine.filter((l) => l.role === "debit").length;
    const credits = mine.filter((l) => l.role === "credit");
    const credit = sum((l) => l.role === "credit");

    if (repLines !== t) wrong.push(`${label}: rep lines ${repLines} != T ${t}`);
    if (credits.length !== 1 || credit !== x) wrong.push(`${label}: credit ${credit} (x${credits.length}) != X ${x}`);
    if (mine.some((l) => l.line_kind === "override" && l.funded !== c.funded)) wrong.push(`${label}: a line's funding is not the override's`);
    if (c.funded === "company") {
      if (debitCount !== 0) wrong.push(`${label}: ${debitCount} debit line(s) on a company-funded override`);
    } else if (debitCount !== (c.b === null ? 1 : 2) || debits + credit !== 0) {
      wrong.push(`${label}: ${debitCount} debit(s) totalling ${debits} for a credit of ${credit}`);
    }

    // Report 2: the company's share, and the invariant to the cent.
    const row = r2.get(mid);
    if (!row) {
      wrong.push(`${label}: no Report 2 row`);
      continue;
    }
    const companyOverride = c.funded === "company" ? x : 0;
    const company = c.r - t - companyOverride;
    if (cents(row.residual) !== c.r) wrong.push(`${label}: residual ${row.residual}`);
    if (cents(row.rep_side) !== t) wrong.push(`${label}: rep side ${row.rep_side} != T ${t}`);
    if (cents(row.company_overrides) !== companyOverride) wrong.push(`${label}: company overrides ${row.company_overrides} != ${companyOverride}`);
    if (cents(row.company_share) !== company) wrong.push(`${label}: company share ${row.company_share} != ${company}`);
    // owner/pair lines + override lines + company share = R.
    const ownerAndPair = repLines + debits;
    if (ownerAndPair + credit + cents(row.company_share) !== c.r) {
      wrong.push(`${label}: ${ownerAndPair} + ${credit} + ${row.company_share} != R ${c.r}`);
    }
    // The company's share never crosses zero by more than the s = o = 50 cent.
    const floor = c.s === 5000 && c.o === 5000 && c.funded === "company" ? -1 : 0;
    if (Math.sign(c.r) * cents(row.company_share) < floor) wrong.push(`${label}: company share ${row.company_share} has the wrong sign`);
    nets.push([ownerAndPair, credit, cents(row.company_share)]);
  }
  // f(-R) = -f(R): cases come in mirrored pairs.
  for (let i = 0; i < nets.length; i += 2) {
    if (nets[i].some((v, k) => v !== -nets[i + 1][k] && !(v === 0 && nets[i + 1][k] === 0))) {
      wrong.push(`case ${i}: not odd in R (${nets[i]} vs ${nets[i + 1]})`);
    }
  }
  if (result.overrides !== list.length) wrong.push(`overrides ${result.overrides} for ${list.length} rows`);
  const company = list.filter((c) => c.funded === "company").length;
  if (result.company_overrides !== company) wrong.push(`company_overrides ${result.company_overrides} != ${company}`);
  return wrong;
}

describe("the invariant to the cent, both funding modes, through commit v3", () => {
  it("owner + override + company = R; owner debits cancel the credit; company-funded has no debit", async () => {
    expect(await propertyCheck(db, 20261116, 200)).toEqual([]);
  });

  it("holds for a second seed", async () => {
    expect(await propertyCheck(db, 91, 200)).toEqual([]);
  });
});

// -------------------------------------------------------------------------
// 2. Worked examples and the one-cent edge
// -------------------------------------------------------------------------

describe("worked examples", () => {
  it("owner-funded, R = 100, rate 50, 5%: owner 45, recipient 5, company 50", async () => {
    const m = await merchant(db, "WX-OWN");
    const period = await freeMonth(db);
    await plant(db, m, 5, period, "owner");
    const id = await commitMonth(db, [{ mid: "WX-OWN" }], period);
    expect(await linesOf(db, id)).toEqual([
      { agent_id: AGENT_ID, line_kind: "import", role: null, payout: "50.00", funded: null },
      { agent_id: MANAGER_ID, line_kind: "override", role: "credit", payout: "5.00", funded: "owner" },
      { agent_id: AGENT_ID, line_kind: "override", role: "debit", payout: "-5.00", funded: "owner" },
    ]);
    expect(await split(db, period, AGENT_ID)).toEqual({ agent_split: "45.00", overrides_received: "0.00" });
    expect(await report2(db, period)).toEqual([
      { mid: "WX-OWN", residual: "100.00", rep_side: "50.00", company_overrides: "0.00", company_share: "50.00" },
    ]);
  });

  it("company-funded, R = 100, rate 50, 5%: owner 50, recipient 5, company 45 -- one line, the credit", async () => {
    const m = await merchant(db, "WX-CO");
    const period = await freeMonth(db);
    await plant(db, m, 5, period, "company");
    const id = await commitMonth(db, [{ mid: "WX-CO" }], period);
    expect(await linesOf(db, id)).toEqual([
      { agent_id: AGENT_ID, line_kind: "import", role: null, payout: "50.00", funded: null },
      { agent_id: MANAGER_ID, line_kind: "override", role: "credit", payout: "5.00", funded: "company" },
    ]);
    expect(await split(db, period, AGENT_ID)).toEqual({ agent_split: "50.00", overrides_received: "0.00" });
    expect(await split(db, period, MANAGER_ID)).toEqual({ agent_split: "0.00", overrides_received: "5.00" });
    expect(await report2(db, period)).toEqual([
      { mid: "WX-CO", residual: "100.00", rep_side: "50.00", company_overrides: "5.00", company_share: "45.00" },
    ]);
  });

  it("a shared account with a company-funded override: signer and partner keep exactly what they had", async () => {
    const m = await merchant(db, "WX-SH");
    const period = await freeMonth(db);
    await share(db, m, 30, 20, period);
    await plant(db, m, 10, period, "company");
    const id = await commitMonth(db, [{ mid: "WX-SH", residual: "1234.57" }], period);
    const lines = await linesOf(db, id);
    const [{ partner }] = await rows<{ partner: string }>(db, `select shared_part(617.29, 20, 50)::text as partner`);
    expect(lines.filter((l) => l.line_kind === "import").map((l) => [l.agent_id, l.payout]).sort()).toEqual(
      [[AGENT_ID, ((cents("617.29") - cents(partner)) / 100).toFixed(2)], [OTHER_AGENT_ID, partner]].sort(),
    );
    expect(lines.filter((l) => l.line_kind === "override")).toEqual([
      { agent_id: MANAGER_ID, line_kind: "override", role: "credit", payout: "123.46", funded: "company" },
    ]);
    expect(await report2(db, period)).toEqual([
      { mid: "WX-SH", residual: "1234.57", rep_side: "617.29", company_overrides: "123.46", company_share: "493.82" },
    ]);
  });

  it("the one-cent edge: s = o = 50, R = 0.01, company-funded -- the company share is -0.01 and the sum still holds", async () => {
    const m = await merchant(db, "WX-CENT");
    const period = await freeMonth(db);
    await plant(db, m, 50, period, "company");
    const id = await commitMonth(db, [{ mid: "WX-CENT", residual: "0.01" }], period);
    // T = round(0.005) = 0.01 and X = round(0.005) = 0.01, both half away from zero.
    expect((await linesOf(db, id)).map((l) => l.payout)).toEqual(["0.01", "0.01"]);
    expect(await report2(db, period)).toEqual([
      { mid: "WX-CENT", residual: "0.01", rep_side: "0.01", company_overrides: "0.01", company_share: "-0.01" },
    ]);
  });
});

// -------------------------------------------------------------------------
// 3. set_merchant_override takes the funding
// -------------------------------------------------------------------------

describe("set_merchant_override requires who pays it", () => {
  it("NULL and a value that is neither owner nor company are 22023; the four-argument function is gone", async () => {
    const m = await merchant(db, "SO-1");
    let error = await rpc(db, `select set_merchant_override(${m}, '${MANAGER_ID}', 5, '2030-01-01', null)`);
    expect([error?.code, error?.message]).toEqual([
      "22023",
      "Every field is required to set an override: who receives it, the percent, the first month and who pays it.",
    ]);
    error = await rpc(db, `select set_merchant_override(${m}, '${MANAGER_ID}', 5, '2030-01-01', 'house')`);
    expect([error?.code, error?.message]).toEqual(["22023", "Paid from must be the owner's side or the company's share."]);
    error = await rpc(db, `select set_merchant_override(${m}, '${MANAGER_ID}', 5, '2030-01-01')`);
    expect(error?.code).toBe("42883");
    expect(await rows(db, `select to_regprocedure('set_merchant_override(int, uuid, numeric, date)') as p`)).toEqual([{ p: null }]);
    expect(await rows(db, `select count(*)::int as n from merchant_overrides`)).toEqual([{ n: 0 }]);
  });

  it("stores the funding and records it in the audit row's detail", async () => {
    const m = await merchant(db, "SO-1");
    const [{ id }] = await call<{ id: number }>(db,
      `select set_merchant_override(${m}, '${MANAGER_ID}', 5, '2030-01-01', 'company') as id`);
    expect(await rows(db, `select funded_by from merchant_overrides where id = ${id}`)).toEqual([{ funded_by: "company" }]);
    expect(await rows(db, `select actor_id, detail from audit_log where action = 'set_merchant_override'`)).toEqual([
      { actor_id: ADMIN_ID, detail: "funded_by=company" },
    ]);
  });

  it("a Change (a later start) takes the funding passed, never the old override's", async () => {
    const m = await merchant(db, "SO-1");
    await call(db, `select set_merchant_override(${m}, '${MANAGER_ID}', 5, '2030-01-01', 'company')`);
    await call(db, `select set_merchant_override(${m}, '${MANAGER_ID}', 5, '2030-06-01', 'owner')`);
    expect(await rows(db, `select effective_from::text as f, effective_to::text as t, funded_by
                             from merchant_overrides order by effective_from`)).toEqual([
      { f: "2030-01-01", t: "2030-06-01", funded_by: "company" },
      { f: "2030-06-01", t: null, funded_by: "owner" },
    ]);
  });

  it("the column has no default: a direct insert without the funding fails", async () => {
    const m = await merchant(db, "SO-1");
    const error = await attempt(() => db.query(
      `insert into merchant_overrides (merchant_id, recipient_id, override_pct, effective_from)
       values (${m}, '${MANAGER_ID}', 5, '2030-01-01')`));
    expect(error?.message).toContain("funded_by");
    expect(await rows(db, `select column_default from information_schema.columns
                            where table_name = 'merchant_overrides' and column_name = 'funded_by'`))
      .toEqual([{ column_default: null }]);
  });
});

// -------------------------------------------------------------------------
// 4. A funding change, through replace and back
// -------------------------------------------------------------------------

describe("set_merchant_override_funding: the change, and how a committed month picks it up", () => {
  it("audits once, changes the table but not the ledger, lists the month, blocks Mark paid; a replace applies it; back again restores the cent", async () => {
    const m = await merchant(db, "FC-1");
    const period = await freeMonth(db);
    const ov = await plant(db, m, 10, period, "owner");
    const first = await commitMonth(db, [{ mid: "FC-1", residual: "100.00" }], period);
    const original = await linesOf(db, first);
    const originalReport = await report2(db, period);
    expect(await split(db, period, AGENT_ID)).toEqual({ agent_split: "40.00", overrides_received: "0.00" });
    expect(await pending(db)).toEqual([]);

    const result = await setFunding(db, ov, "company");
    expect(result).toEqual({
      changed: true, from: "owner", to: "company",
      replace: [{ processor: "TSYS", period, batch_id: first }],
    });
    expect(await rows(db, `select funded_by from merchant_overrides where id = ${ov}`)).toEqual([{ funded_by: "company" }]);
    expect(await rows(db, `select actor_id, table_name, row_id, detail from audit_log where action = 'set_override_funding'`)).toEqual([
      { actor_id: ADMIN_ID, table_name: "merchant_overrides", row_id: String(ov),
        detail: `owner -> company; replace: TSYS ${period.slice(0, 7)}; reason: ${REASON}` },
    ]);
    // The ledger is a snapshot: nothing moved.
    expect(await linesOf(db, first)).toEqual(original);
    expect(await report2(db, period)).toEqual(originalReport);
    expect(await pending(db)).toEqual([{ processor: "TSYS", period, batch_id: first, override_count: 1 }]);

    const error = await markPaid(db, period);
    expect(error?.code).toBe("PT409");
    expect(error?.message).toBe(`1 override(s) on TSYS ${monthName(period)} changed who pays them after this month was committed. Replace the month first, then mark it paid.`);

    // The replace: the same file again.
    const second = await commitMonth(db, [{ mid: "FC-1", residual: "100.00" }], period, first);
    expect(await linesOf(db, second)).toEqual([
      { agent_id: AGENT_ID, line_kind: "import", role: null, payout: "50.00", funded: null },
      { agent_id: MANAGER_ID, line_kind: "override", role: "credit", payout: "10.00", funded: "company" },
    ]);
    expect(await pending(db)).toEqual([]);
    expect(await split(db, period, AGENT_ID)).toEqual({ agent_split: "50.00", overrides_received: "0.00" });
    expect(await report2(db, period)).toEqual([
      { mid: "FC-1", residual: "100.00", rep_side: "50.00", company_overrides: "10.00", company_share: "40.00" },
    ]);

    // And back: owner-funded again, replaced again, to the cent of the original.
    expect((await setFunding(db, ov, "owner")).replace).toEqual([{ processor: "TSYS", period, batch_id: second }]);
    const third = await commitMonth(db, [{ mid: "FC-1", residual: "100.00" }], period, second);
    expect(await linesOf(db, third)).toEqual(original);
    expect(await report2(db, period)).toEqual(originalReport);
    expect(await markPaid(db, period)).toBeNull();
  });

  it("the same value changes nothing and writes no audit row", async () => {
    const m = await merchant(db, "FC-1");
    const ov = await plant(db, m, 10, "2030-01-01", "owner");
    expect(await setFunding(db, ov, "owner")).toEqual({ changed: false, from: "owner", to: "owner", replace: [] });
    expect(await rows(db, `select count(*)::int as n from audit_log where action = 'set_override_funding'`)).toEqual([{ n: 0 }]);
  });

  it("with no committed month there is nothing to replace", async () => {
    const m = await merchant(db, "FC-1");
    const ov = await plant(db, m, 10, "2030-01-01", "owner");
    expect(await setFunding(db, ov, "company")).toEqual({ changed: true, from: "owner", to: "company", replace: [] });
    expect(await rows(db, `select detail from audit_log where action = 'set_override_funding'`)).toEqual([
      { detail: `owner -> company; replace: none; reason: ${REASON}` },
    ]);
  });
});

// -------------------------------------------------------------------------
// 5. Refusals
// -------------------------------------------------------------------------

describe("set_merchant_override_funding refuses", () => {
  it("a rep (PT403), anon (no EXECUTE), a missing override (PT404), a bad value or reason (22023)", async () => {
    const m = await merchant(db, "RF-1");
    const ov = await plant(db, m, 10, "2030-01-01");
    expect((await rpc(db, `select set_merchant_override_funding(${ov}, 'company', '${RQ}')`, AGENT_ID))?.code).toBe("PT403");
    expect(await rows(db, `select has_function_privilege('anon', 'set_merchant_override_funding(int, text, text)', 'execute') as ok`))
      .toEqual([{ ok: false }]);
    expect((await rpc(db, `select set_merchant_override_funding(999999, 'company', '${RQ}')`))?.code).toBe("PT404");
    for (const [args, message] of [
      [`${ov}, 'house', '${RQ}'`, "Paid from must be the owner's side or the company's share."],
      [`${ov}, null, '${RQ}'`, "An override and who pays it are required."],
      [`${ov}, 'company', 'too short'`, "Give a reason of 10 to 500 characters. It is kept in the audit log."],
      [`${ov}, 'company', '${"x".repeat(501)}'`, "Give a reason of 10 to 500 characters. It is kept in the audit log."],
      [`${ov}, 'company', null`, "Give a reason of 10 to 500 characters. It is kept in the audit log."],
    ] as const) {
      const error = await rpc(db, `select set_merchant_override_funding(${args})`);
      expect([error?.code, error?.message]).toEqual(["22023", message]);
    }
    expect(await rows(db, `select funded_by from merchant_overrides`)).toEqual([{ funded_by: "owner" }]);
    expect(await rows(db, `select count(*)::int as n from audit_log where action = 'set_override_funding'`)).toEqual([{ n: 0 }]);
  });

  it("while a month it touched is marked paid, naming it; after Reopen it is allowed", async () => {
    const m = await merchant(db, "RF-1");
    const period = await freeMonth(db);
    const ov = await plant(db, m, 10, period);
    await commitMonth(db, [{ mid: "RF-1" }], period);
    expect(await markPaid(db, period)).toBeNull();
    const error = await rpc(db, `select set_merchant_override_funding(${ov}, 'company', '${RQ}')`);
    expect([error?.code, error?.message]).toEqual([
      "PT409",
      `TSYS ${monthName(period)} is marked paid. Reopen it (with a reason) before changing who pays this override.`,
    ]);
    expect(await rows(db, `select funded_by from merchant_overrides`)).toEqual([{ funded_by: "owner" }]);
    expect(await rpc(db, `select reopen_payout_period('${period}', 'TSYS', 'Overrides move to company funding.')`)).toBeNull();
    expect((await setFunding(db, ov, "company")).changed).toBe(true);
  });

  it("owner funding the merchant can no longer carry: a rate now below the percent", async () => {
    const m = await merchant(db, "RF-1");
    const ov = await plant(db, m, 30, "2030-01-01", "company");
    await asPlatform(db);
    await db.exec(`select set_config('tapswipe.merchant_split_write', 'on', false);
                   update merchants set split_agent_pct = 20, split_company_pct = 80 where id = ${m};
                   select set_config('tapswipe.merchant_split_write', '', false);`);
    const error = await rpc(db, `select set_merchant_override_funding(${ov}, 'owner', '${RQ}')`);
    expect([error?.code, error?.message]).toEqual([
      "PT409",
      "This merchant's rate is now 20, below the override's 30, so it cannot come out of the owner's side.",
    ]);
  });
});

describe("override_funding_pending and Mark paid", () => {
  it("override_funding_pending is admin only and security invoker", async () => {
    expect((await rpc(db, `select * from override_funding_pending()`, AGENT_ID))?.code).toBe("PT403");
    expect(await rows(db, `select prosecdef from pg_proc where oid = 'override_funding_pending()'::regprocedure`))
      .toEqual([{ prosecdef: false }]);
  });
});

// -------------------------------------------------------------------------
// 6. Period delete and cancel
// -------------------------------------------------------------------------

describe("credit-only lines", () => {
  it("delete_payout_period removes a company-funded month's credit lines with its import lines", async () => {
    const m = await merchant(db, "DL-1");
    const period = await freeMonth(db);
    await plant(db, m, 5, period, "company");
    await commitMonth(db, [{ mid: "DL-1" }], period);
    expect(await rpc(db, `select delete_payout_period('${period}', 'TSYS')`)).toBeNull();
    expect(await rows(db, `select count(*)::int as n from rep_payout_rows where period = '${period}'`)).toEqual([{ n: 0 }]);
  });

  it("cancel is refused once a company-funded line references the override", async () => {
    const m = await merchant(db, "DL-1");
    const period = await freeMonth(db);
    const ov = await plant(db, m, 5, period, "company");
    await commitMonth(db, [{ mid: "DL-1" }], period);
    expect((await rpc(db, `select cancel_merchant_override(${ov})`))?.code).toBe("PT409");
  });
});

// -------------------------------------------------------------------------
// 7. The catalog
// -------------------------------------------------------------------------

describe("the catalog", () => {
  const DEFINER = [
    "set_merchant_override(int, uuid, numeric, date, text)",
    "set_merchant_override_funding(int, text, text)",
    "close_payout_period(date, text, text)",
    `${V3}(int, text[])`,
  ];
  const INVOKER = ["override_funding_pending()", "merchant_processor_summary(date, date, text)"];

  it("each is definer or invoker as designed, search_path pinned, EXECUTE for authenticated and service_role only", async () => {
    for (const fn of [...DEFINER, ...INVOKER]) {
      const [row] = await rows<{ definer: boolean; config: string[] | null; anon: boolean; pub: boolean; auth: boolean; svc: boolean }>(
        db,
        `select prosecdef as definer, proconfig as config,
                has_function_privilege('anon', '${fn}'::regprocedure, 'execute') as anon,
                exists (select 1 from aclexplode(proacl) a where a.grantee = 0) as pub,
                has_function_privilege('authenticated', '${fn}'::regprocedure, 'execute') as auth,
                has_function_privilege('service_role', '${fn}'::regprocedure, 'execute') as svc
           from pg_proc where oid = '${fn}'::regprocedure`,
      );
      expect({ fn, ...row, config: undefined }).toEqual({
        fn, definer: DEFINER.includes(fn), config: undefined, anon: false, pub: false, auth: true, svc: true,
      });
      expect(row.config?.some((c) => c.startsWith("search_path="))).toBe(true);
    }
  });

  it("the funding functions check is_admin() first, and the migration revokes before it grants", async () => {
    const text = await readMigration(MIGRATION);
    for (const name of ["set_merchant_override", "set_merchant_override_funding", "override_funding_pending"]) {
      const [{ def }] = await rows<{ def: string }>(db, `select prosrc as def from pg_proc where proname = '${name}'`);
      expect(def, name).toMatch(/^\s*(?:#variable_conflict use_column\s*)?(?:declare[\s\S]*?)?\bbegin\s+if not is_admin\(\) then/);
      const revoke = text.indexOf(`revoke all on function ${name}(`);
      const grant = text.indexOf(`grant execute on function ${name}(`);
      expect(revoke, name).toBeGreaterThan(-1);
      expect(grant, name).toBeGreaterThan(revoke);
    }
  });

  it("the ledger CHECKs are validated, and the generated rep_payout was not rewritten", async () => {
    expect(await rows(db, `select conname, convalidated from pg_constraint
                            where conrelid = 'public.rep_payout_rows'::regclass
                              and conname in ('rep_payout_rows_override_columns', 'rep_payout_rows_override_funded_by',
                                              'rep_payout_rows_company_override_no_debit')
                            order by conname`)).toEqual([
      { conname: "rep_payout_rows_company_override_no_debit", convalidated: true },
      { conname: "rep_payout_rows_override_columns", convalidated: true },
      { conname: "rep_payout_rows_override_funded_by", convalidated: true },
    ]);
    expect(await readMigration(MIGRATION)).not.toMatch(/drop column rep_payout\b/);
  });
});

// -------------------------------------------------------------------------
// 8. The migration over a populated ledger
// -------------------------------------------------------------------------

describe("the migration over a committed, owner-funded month", () => {
  /** A database from before this migration, with a month committed through the old v3. */
  async function populated(): Promise<{ target: TestDb; batch: number; period: string }> {
    const target = await open(await migrationsBefore(MIGRATION));
    await resetData(target);
    await addManager(target);
    const plain = await merchant(target, "MG-1");
    const shared = await merchant(target, "MG-2");
    const period = await freeMonth(target);
    await share(target, shared, 30, 20, period);
    await plant(target, plain, 10, period, null);
    await plant(target, shared, 7.5, period, null);
    const batch = await commitMonth(target, [{ mid: "MG-1", residual: "100.00" }, { mid: "MG-2", residual: "-33.33" }], period);
    return { target, batch, period };
  }

  const payouts = (target: TestDb) =>
    rows<{ s: string }>(target, `select md5(string_agg(id || ':' || coalesce(rep_payout::text, 'null'), ',' order by id)) as s
                                   from rep_payout_rows`);

  it("backfills owner on every override and every override line, validated, and moves no payout", async () => {
    const { target, batch } = await populated();
    const before = await payouts(target);
    const lines = await rows<{ n: number }>(target, `select count(*)::int as n from rep_payout_rows where line_kind = 'override'`);
    expect(lines).toEqual([{ n: 5 }]); // two credits, three debits (the shared pair)
    await target.exec(await readMigration(MIGRATION));
    expect(await payouts(target)).toEqual(before);
    expect(await rows(target, `select line_kind, override_funded_by as f, count(*)::int as n from rep_payout_rows
                                group by 1, 2 order by 1, 2`)).toEqual([
      { line_kind: "import", f: null, n: 3 },
      { line_kind: "override", f: "owner", n: 5 },
    ]);
    expect(await rows(target, `select funded_by, count(*)::int as n from merchant_overrides group by 1`))
      .toEqual([{ funded_by: "owner", n: 2 }]);
    expect(await call(target, `select * from override_funding_pending()`)).toEqual([]);
    expect(batch).toBeGreaterThan(0);
  });

  it("refuses, naming it, an override pair that is not owner-funded -- and changes nothing", async () => {
    const { target, batch } = await populated();
    await asPlatform(target);
    const [{ ov }] = await rows<{ ov: number }>(target,
      `select override_id as ov from rep_payout_rows where mid = 'MG-1' and override_role = 'debit'`);
    await target.exec(`delete from rep_payout_rows where mid = 'MG-1' and override_role = 'debit'`);
    const error = await attempt(async () => target.exec(await readMigration(MIGRATION)));
    expect(error?.message).toBe(
      `Override lines that are not an owner-funded pair (one credit, debits totalling minus it): batch ${batch} / override ${ov}. They cannot be marked owner-funded; inspect them before applying 20261116120000.`,
    );
    expect(await rows(target, `select count(*)::int as n from information_schema.columns
                                where table_name = 'merchant_overrides' and column_name = 'funded_by'`)).toEqual([{ n: 0 }]);
  });

  it("refuses an override-columns CHECK it does not expect, naming it", async () => {
    const { target } = await populated();
    await target.exec(`alter table rep_payout_rows drop constraint rep_payout_rows_override_columns;
                       alter table rep_payout_rows add constraint rep_payout_rows_override_columns
                         check (line_kind <> 'override' or override_id is not null);`);
    const error = await attempt(async () => target.exec(await readMigration(MIGRATION)));
    expect(error?.message).toMatch(/^rep_payout_rows_override_columns is not the 20261102120000 CHECK here \(found: CHECK/);
  });
});

// -------------------------------------------------------------------------
// 9. Mutation proofs
// -------------------------------------------------------------------------

describe("mutation proofs: each protection is what stops its case", () => {
  let mutant: TestDb;
  const MUTATED = [
    `${V3}(int, text[])`,
    "set_merchant_override_funding(int, text, text)",
    "close_payout_period(date, text, text)",
    "merchant_processor_summary(date, date, text)",
  ];
  const originals: string[] = [];

  beforeAll(async () => {
    mutant = await open();
    for (const fn of MUTATED) {
      const [{ def }] = await rows<{ def: string }>(mutant, `select pg_get_functiondef('${fn}'::regprocedure) as def`);
      originals.push(def);
    }
  });

  beforeEach(async () => {
    await resetData(mutant);
    await clearClosures(mutant);
    await addManager(mutant);
    for (const def of originals) await mutant.exec(def);
  });

  async function without(fn: string, fragment: string, replacement = ""): Promise<void> {
    await asPlatform(mutant);
    const [{ def }] = await rows<{ def: string }>(mutant, `select pg_get_functiondef('${fn}'::regprocedure) as def`);
    expect(def, "the fragment must be in the function").toContain(fragment);
    await mutant.exec(def.replace(fragment, replacement));
  }

  it("v3's owner filter on the debit: without it a company-funded override writes a debit, and the CHECK refuses the commit", async () => {
    await without(`${V3}(int, text[])`, "      from pieces\n     where funded_by = 'owner'\n    union all", "      from pieces\n    union all");
    const m = await merchant(mutant, "MU-1");
    const period = await freeMonth(mutant);
    await plant(mutant, m, 5, period, "company");
    const id = await batchWith(mutant, [{ mid: "MU-1" }], period);
    const error = await attempt(() => commit(mutant, id));
    expect(error?.message).toContain("rep_payout_rows_company_override_no_debit");
    // Without the CHECK as well, the owner pays a company-funded override.
    await asPlatform(mutant);
    await mutant.exec(`alter table rep_payout_rows drop constraint rep_payout_rows_company_override_no_debit`);
    try {
      await commit(mutant, id);
      expect(await rows(mutant, `select sum(rep_payout)::text as s from rep_payout_rows where batch_id = ${id} and agent_id = '${AGENT_ID}'`))
        .toEqual([{ s: "45.00" }]);
    } finally {
      await asPlatform(mutant);
      await mutant.exec(`delete from rep_payout_rows;
        alter table rep_payout_rows add constraint rep_payout_rows_company_override_no_debit
          check (not (override_funded_by = 'company' and override_role = 'debit'))`);
    }
  });

  it("the paid-month refusal: without it a paid month's override changes funding", async () => {
    const m = await merchant(mutant, "MU-1");
    const period = await freeMonth(mutant);
    const ov = await plant(mutant, m, 10, period);
    await commitMonth(mutant, [{ mid: "MU-1" }], period);
    expect(await markPaid(mutant, period)).toBeNull();
    expect((await rpc(mutant, `select set_merchant_override_funding(${ov}, 'company', '${RQ}')`))?.code).toBe("PT409");
    await without("set_merchant_override_funding(int, text, text)", "  if paid is not null then", "  if false then");
    expect(await rpc(mutant, `select set_merchant_override_funding(${ov}, 'company', '${RQ}')`)).toBeNull();
  });

  it("Mark paid's stale check: without it a month is marked paid on figures its funding change made stale", async () => {
    const m = await merchant(mutant, "MU-1");
    const period = await freeMonth(mutant);
    const ov = await plant(mutant, m, 10, period);
    await commitMonth(mutant, [{ mid: "MU-1" }], period);
    await setFunding(mutant, ov, "company");
    expect((await markPaid(mutant, period))?.code).toBe("PT409");
    await without("close_payout_period(date, text, text)", "  if stale > 0 then", "  if false then");
    expect(await markPaid(mutant, period)).toBeNull();
  });

  it("Report 2 reads the line's funding, never the override's now: a pending change does not move a committed month", async () => {
    const m = await merchant(mutant, "MU-1");
    const period = await freeMonth(mutant);
    const ov = await plant(mutant, m, 10, period);
    await commitMonth(mutant, [{ mid: "MU-1" }], period);
    await setFunding(mutant, ov, "company");
    expect((await report2(mutant, period))[0]).toMatchObject({ company_overrides: "0.00", company_share: "50.00" });
  });
});
