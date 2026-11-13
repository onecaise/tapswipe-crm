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
 * 20261030160000, commit v3 -- phase 8 of docs/design/intake-and-reports.md.
 * What this file pins:
 *
 *   1. commit_residual_import_v3 refuses, by name, every shape the memo lists:
 *      a batch not in review, without a month, or beside a committed batch for
 *      its processor-month; a staged row read for another month, a blank,
 *      repeated or unknown MID, a missing figure, an owner
 *      or MID that changed after the read, a merchant with no rate, a MID that
 *      already has a line this month (no merge), and a share whose signer is
 *      not the owner or whose shares do not total the rate.
 *   2. Every warning is recomputed, and a type not confirmed refuses -- one
 *      yes per type covers its rows; a warning that appeared after the review
 *      is not covered by an old yes.
 *      Since phase 15 (20261111120000) another Income Type is the fourth
 *      warning, other_income_type, not a refusal; a blank Processor cell and
 *      the aliases Goat (TSYS) and Netevia (Netevia HQ) warn of nothing.
 *   3. The money: rep amount from the MERCHANT's rate, company the rest, a
 *      house merchant at 0 still gets its line, a shared account divides the
 *      merchant's rate in the share ratio by the cent rule -- a grid.
 *   4. The negative-volume marker, the audit row and the batch record.
 *   5. The merchant rate: the 0-50 CHECK, set_merchant_split, the direct-edit
 *      guard, and the owner-change refusal while a share is live.
 *   6. Grants, catalog, and v2 gone.
 *   7. The migration over a populated database: refuses a merchant it cannot
 *      carry, naming it, and otherwise changes no row.
 *   8. Mutation proofs: each protection, removed from a copy of the function,
 *      lets its case through -- so the tests above are about something.
 */

const MIGRATION = "20261030160000_commit_v3.sql";
const V3 = "commit_residual_import_v3";

type DbError = { code?: string; message: string; detail?: string };

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

type Staged = {
  mid: string;
  volume?: string | null;
  residual?: string | null;
  processor?: string | null;
  incomeType?: string | null;
  /** Overrides the staged owner/merchant (default: resolved from the MID now). */
  agentId?: string | null;
  merchantId?: string;
  period?: string;
  blocker?: string;
};

/** A review batch (TSYS unless told otherwise, a free month), with its rows. */
async function batchWith(
  target: TestDb,
  staged: Staged[],
  fields: { processor?: string; period?: string } = {},
): Promise<{ id: number; period: string }> {
  await asPlatform(target);
  const processor = fields.processor ?? "TSYS";
  const id = await insertBatch(target, {
    extra: {
      processor: `'${processor}'`,
      period: fields.period ? `'${fields.period}'` : freeBatchMonth(processor),
    },
  });
  const [{ period }] = await rows<{ period: string }>(
    target,
    `select period::text as period from rep_payout_batches where id = ${id}`,
  );
  const lit = (v: string | null | undefined, fallback: string) =>
    v === undefined ? fallback : v === null ? "null" : `'${v}'`;
  for (const [i, row] of staged.entries()) {
    await target.exec(`
      insert into rep_payout_import_rows
        (batch_id, row_number, mid_raw, merchant_name_raw, processor_raw, income_type_raw,
         volume_raw, residual_income_raw, period, agent_id, merchant_id,
         volume, residual_income, blocker, blockers)
      values (${id}, ${i + 2}, '${row.mid}', 'File name', ${lit(row.processor, "'TSYS'")},
              ${lit(row.incomeType, "'Residuals'")}, 'v', 'r',
              '${row.period ?? period}',
              ${row.agentId === undefined ? `(select agent_id from merchants where mid = '${row.mid}')` : lit(row.agentId, "null")},
              ${row.merchantId ?? `(select id from merchants where mid = '${row.mid}')`},
              ${lit(row.volume, "1000.00")}, ${lit(row.residual, "100.00")},
              ${row.blocker ? `'${row.blocker}'` : "null"},
              ${row.blocker ? `array['${row.blocker}']` : "'{}'"})`);
  }
  return { id, period };
}

async function commit(target: TestDb, id: number, confirmed: string[] = []): Promise<Record<string, number>> {
  await asUser(target, ADMIN_ID);
  const list = confirmed.length === 0 ? "'{}'::text[]" : `array[${confirmed.map((c) => `'${c}'`).join(", ")}]`;
  const [{ result }] = await rows<{ result: Record<string, number> }>(
    target,
    `select ${V3}(${id}, ${list}) as result`,
  );
  await asPlatform(target);
  return result;
}

async function refused(target: TestDb, id: number, confirmed: string[] = []): Promise<DbError> {
  const error = await attempt(() => commit(target, id, confirmed));
  await asPlatform(target);
  expect(error, "expected the commit to be refused").not.toBeNull();
  return error as DbError;
}

/**
 * A merchant at a rate, owned by `owner`, as the platform. `rate: null` is a
 * merchant with NO rate, which since 20261030180000 only a row made before
 * that migration can be (an insert without one takes the owner's profile
 * rate): so it is inserted with triggers off, the shape such a row has.
 */
async function merchant(
  target: TestDb,
  mid: string,
  fields: { owner?: string; rate?: number | null; processor?: string | null; status?: string } = {},
): Promise<number> {
  await asPlatform(target);
  const rate = fields.rate === undefined ? 50 : fields.rate;
  if (rate === null) await target.exec(`set session_replication_role = replica`);
  try {
    return await insertMerchant(target, mid, fields, rate);
  } finally {
    if (rate === null) await target.exec(`set session_replication_role = origin`);
  }
}

async function insertMerchant(
  target: TestDb,
  mid: string,
  fields: { owner?: string; processor?: string | null; status?: string },
  rate: number | null,
): Promise<number> {
  const [{ id }] = await rows<{ id: number }>(
    target,
    `insert into merchants (agent_id, mid, dba, status, processor, split_agent_pct, split_company_pct, city, state)
     values ('${fields.owner ?? AGENT_ID}', '${mid}', '${mid} Co', '${fields.status ?? "active"}',
             ${fields.processor === undefined ? "'TSYS'" : fields.processor === null ? "null" : `'${fields.processor}'`},
             ${rate === null ? "null" : rate}, ${rate === null ? "null" : 100 - rate}, 'Nashville', 'TN')
     returning id`,
  );
  return id;
}

/** A share inserted as the platform (the RPC's guards are tested separately). */
async function share(target: TestDb, merchantId: number, primary: string, secondary: string, a: number, b: number, from: string): Promise<number> {
  await asPlatform(target);
  const [{ id }] = await rows<{ id: number }>(
    target,
    `insert into merchant_rep_shares (merchant_id, primary_agent_id, secondary_agent_id,
                                      primary_rep_pct, secondary_rep_pct, effective_from)
     values (${merchantId}, '${primary}', '${secondary}', ${a}, ${b}, '${from}') returning id`,
  );
  return id;
}

const lineCount = async (target: TestDb, batch?: number) => {
  await asPlatform(target);
  const [{ n }] = await rows<{ n: number }>(
    target,
    `select count(*)::int as n from rep_payout_rows${batch === undefined ? "" : ` where batch_id = ${batch}`}`,
  );
  return n;
};

/** Moves a batch's staged rows to the month before its own. */
async function shiftStagedMonth(target: TestDb, batchId: number): Promise<void> {
  await asPlatform(target);
  await target.exec(`update rep_payout_import_rows set period = (period - interval '1 month')::date
                      where batch_id = ${batchId}`);
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
// 1. Refusals
// -------------------------------------------------------------------------

describe("refusals: guards on the batch", () => {
  it("refuses an agent (PT403) and anon (no EXECUTE), and writes nothing", async () => {
    const { id } = await batchWith(db, [{ mid: "MID-AGENT-1" }]);
    await asUser(db, AGENT_ID);
    const agent = await attempt(() => db.query(`select ${V3}(${id}, '{}')`));
    expect(agent?.code).toBe("PT403");
    await asUser(db, null);
    await db.exec(`set role anon`);
    const anon = await attempt(() => db.query(`select ${V3}(${id}, '{}')`));
    expect(anon?.message).toMatch(/permission denied for function commit_residual_import_v3/);
    await asPlatform(db);
    expect(await lineCount(db)).toBe(0);
  });

  it("refuses a missing batch, one not in review, and an empty one", async () => {
    expect((await refused(db, 999999)).code).toBe("PT404");
    const empty = await batchWith(db, []);
    expect((await refused(db, empty.id)).message).toBe("this import has no rows");
    const done = await batchWith(db, [{ mid: "MID-AGENT-1" }]);
    await commit(db, done.id);
    expect((await refused(db, done.id)).message).toBe("this import is already committed");
  });

  it("refuses while a row is blocked", async () => {
    const { id } = await batchWith(db, [{ mid: "MID-AGENT-1" }, { mid: "X", blocker: "unknown_mid" }]);
    const error = await refused(db, id);
    expect(error.code).toBe("PT409");
    expect(error.message).toBe("1 of 2 rows are still blocked");
  });

  it("refuses beside a committed batch for the same processor-month, naming it", async () => {
    const first = await batchWith(db, [{ mid: "MID-AGENT-1" }]);
    await commit(db, first.id);
    const second = await batchWith(db, [{ mid: "MID-OTHER-1" }], { period: first.period });
    const error = await refused(db, second.id);
    expect(error.code).toBe("PT409");
    expect(error.message).toMatch(new RegExp(`^TSYS for .* is already committed \\(import #${first.id}\\)`));
    expect(await lineCount(db, second.id)).toBe(0);
  });
});

describe("refusals: re-derived from the database, each listing what it found", () => {
  const cases: [string, () => Promise<number>, RegExp][] = [
    ["a row read for another month", async () => {
      const { id } = await batchWith(db, [{ mid: "MID-AGENT-1" }]);
      await shiftStagedMonth(db, id);
      return id;
    }, /^Rows 2 were read for a different month than this import's/],
    ["a blank MID", async () => (await batchWith(db, [{ mid: "  " }])).id, /^Rows 2 have no MID\./],
    ["a repeated MID", async () => (await batchWith(db, [{ mid: "MID-AGENT-1" }, { mid: "MID-AGENT-1" }])).id,
      /^A MID appears on more than one row: MID-AGENT-1 \(rows 2, 3\)\./],
    ["an unknown MID", async () => (await batchWith(db, [{ mid: "NOPE-1", agentId: null }])).id,
      /^MIDs NOPE-1 are not merchants in the CRM\./],
    ["a missing Residual", async () => (await batchWith(db, [{ mid: "MID-AGENT-1", residual: null }])).id,
      /^Rows 2 have no Volume or no Residual\./],
    ["a missing Volume", async () => (await batchWith(db, [{ mid: "MID-AGENT-1", volume: null }])).id,
      /^Rows 2 have no Volume or no Residual\./],
    ["a merchant with no rate", async () => {
      await merchant(db, "NORATE-1", { rate: null });
      return (await batchWith(db, [{ mid: "NORATE-1" }])).id;
    }, /^MIDs NORATE-1 belong to merchants with no split rate\./],
  ];

  it.each(cases)("refuses %s (PT409) and writes nothing", async (_label, make, message) => {
    const id = await make();
    const error = await refused(db, id);
    expect(error.code).toBe("PT409");
    expect(error.message).toMatch(message);
    expect(await lineCount(db)).toBe(0);
    const [{ status }] = await rows<{ status: string }>(db, `select status from rep_payout_batches where id = ${id}`);
    expect(status).toBe("review");
  });

  it("accepts Residual, Residuals and blank in any case and spacing, with no warning, as the parser does (phase 15)", async () => {
    await merchant(db, "BLANKTYPE");
    const { id } = await batchWith(db, [
      { mid: "MID-AGENT-1", incomeType: "  RESIDUALS " },
      { mid: "MID-OTHER-1", incomeType: "Residual " },
      { mid: "BLANKTYPE", incomeType: null },
    ]);
    expect((await commit(db, id)).written).toBe(3);
  });

  it("no longer refuses another Income Type: it is the other_income_type warning (phase 15)", async () => {
    const { id } = await batchWith(db, [{ mid: "MID-AGENT-1", incomeType: "ACH" }]);
    const error = await refused(db, id);
    expect(error.message).toMatch(/^These warnings were not confirmed: other income type \(rows 2\)\./);
    expect((await commit(db, id, ["other_income_type"])).written).toBe(1);
  });
});

describe("the owner (and the MID) is re-resolved at commit: refused, never re-paid", () => {
  const OWNER_CHANGED = /^A merchant's MID or owner changed after this file was read \(MIDs MID-AGENT-1\)\. Read it again\.$/;

  it("refuses when the merchant's owner changed between Read and Commit", async () => {
    const { id } = await batchWith(db, [{ mid: "MID-AGENT-1" }]);
    await asUser(db, ADMIN_ID);
    await db.exec(`update merchants set agent_id = '${OTHER_AGENT_ID}' where mid = 'MID-AGENT-1'`);
    const error = await refused(db, id);
    expect(error.code).toBe("PT409");
    expect(error.message).toMatch(OWNER_CHANGED);
    expect(await lineCount(db)).toBe(0);
  });

  it("refuses when the MID moved to another merchant (same owner)", async () => {
    const { id } = await batchWith(db, [{ mid: "MID-AGENT-1" }]);
    await asUser(db, ADMIN_ID);
    await db.exec(`update merchants set mid = 'MID-AGENT-1-OLD' where mid = 'MID-AGENT-1';
                   update merchants set mid = 'MID-AGENT-1' where mid = 'MID-AGENT-2'`);
    const error = await refused(db, id);
    expect(error.message).toMatch(OWNER_CHANGED);
  });

  it("refuses a staged payee that is not the owner, even with the merchant unchanged", async () => {
    const { id } = await batchWith(db, [{ mid: "MID-AGENT-1", agentId: OTHER_AGENT_ID }]);
    expect((await refused(db, id)).message).toMatch(OWNER_CHANGED);
  });

  it("pays the current owner when nothing changed", async () => {
    const { id } = await batchWith(db, [{ mid: "MID-AGENT-1" }]);
    await commit(db, id);
    const lines = await rows<{ agent_id: string }>(db, `select agent_id from rep_payout_rows where batch_id = ${id}`);
    expect(lines).toEqual([{ agent_id: AGENT_ID }]);
  });
});

describe("no merge: a month is committed once", () => {
  it("refuses a MID that already has a line this month under the same processor", async () => {
    const first = await batchWith(db, [{ mid: "MID-AGENT-1", residual: "10.00" }]);
    await commit(db, first.id);
    // A second review batch for that month cannot even get past the
    // processor-month rule...
    const again = await batchWith(db, [{ mid: "MID-AGENT-1", residual: "99.00" }], { period: first.period });
    expect((await refused(db, again.id)).message).toMatch(/is already committed/);
    // ...and a line already in the month without a committed batch beside it
    // (a legacy line) is not merged into either: the first batch is removed,
    // its line put back by hand.
    await asPlatform(db);
    await db.exec(`delete from rep_payout_rows where batch_id = ${first.id};
                   delete from rep_payout_batches where id = ${first.id};
                   insert into rep_payout_rows (agent_id, period, processor, mid, residual_income, rep_split_pct)
                   values ('${AGENT_ID}', '${first.period}', 'TSYS', 'MID-AGENT-1', 10.00, 50.00)`);
    const error = await refused(db, again.id);
    expect(error.message).toMatch(/^MIDs MID-AGENT-1 already have a line for .*A committed month is never merged into/);
    const lines = await rows<{ residual: string }>(
      db,
      `select residual_income::text as residual from rep_payout_rows where mid = 'MID-AGENT-1'`,
    );
    expect(lines).toEqual([{ residual: "10.00" }]);
  });

  it("refuses a MID another processor already paid this month", async () => {
    const tsys = await batchWith(db, [{ mid: "MID-OTHER-1" }]);
    await commit(db, tsys.id);
    await merchant(db, "PB-1", { processor: null });
    const paybright = await batchWith(
      db,
      [{ mid: "MID-OTHER-1", processor: "PayBright" }],
      { processor: "PayBright", period: tsys.period },
    );
    const error = await refused(db, paybright.id, ["processor_mismatch"]);
    expect(error.message).toMatch(/^MIDs MID-OTHER-1 already have a line for/);
  });

  it("has no ON CONFLICT and no coalesce merge anywhere in its body", async () => {
    const [{ body }] = await rows<{ body: string }>(
      db,
      `select prosrc as body from pg_proc where proname = '${V3}'`,
    );
    expect(body.toLowerCase()).not.toContain("on conflict");
    expect(body).not.toMatch(/coalesce\(excluded/);
    // Unshared, signer, partner -- and since 20261102120000 the override
    // lines (step 6), a plain insert like the other three.
    expect(body.match(/insert into rep_payout_rows/g)).toHaveLength(4);
  });
});

describe("shares the commit will not apply (backstops for rows that predate the guards)", () => {
  it("refuses a share covering the month whose signer is not the owner", async () => {
    const m = await merchant(db, "SH-OWN", { owner: AGENT_ID, rate: 50 });
    const { id, period } = await batchWith(db, [{ mid: "SH-OWN" }]);
    await share(db, m, OTHER_AGENT_ID, ADMIN_ID, 25, 25, period);
    const error = await refused(db, id);
    expect(error.message).toMatch(/^MIDs SH-OWN have a shared-account split whose signer is not the merchant's owner/);
  });

  it("refuses a share whose two shares do not total the merchant's rate", async () => {
    const m = await merchant(db, "SH-RATE", { rate: 40 });
    const { id, period } = await batchWith(db, [{ mid: "SH-RATE" }]);
    await share(db, m, AGENT_ID, OTHER_AGENT_ID, 25, 25, period);
    expect((await refused(db, id)).message).toMatch(/^MIDs SH-RATE have a shared-account split/);
  });

  it("ignores a share that does not cover the batch month", async () => {
    const m = await merchant(db, "SH-LATER", { rate: 50 });
    const { id, period } = await batchWith(db, [{ mid: "SH-LATER" }]);
    const [{ next }] = await rows<{ next: string }>(db, `select ('${period}'::date + interval '1 month')::date::text as next`);
    await share(db, m, OTHER_AGENT_ID, AGENT_ID, 25, 25, next);
    expect((await commit(db, id)).written).toBe(1);
  });
});

describe("confirmations", () => {
  it("refuses an unknown confirmation code (22023)", async () => {
    const { id } = await batchWith(db, [{ mid: "MID-AGENT-1" }]);
    const error = await refused(db, id, ["looks_shared"]);
    expect(error.code).toBe("22023");
  });

  const warned: [string, Staged, string][] = [
    ["processor_mismatch (the file's cell)", { mid: "MID-AGENT-1", processor: "Square" }, "processor_mismatch"],
    ["processor_mismatch (the merchant's own processor)", { mid: "MID-OTHER-2" }, "processor_mismatch"],
    ["other_income_type", { mid: "MID-AGENT-1", incomeType: "ACH" }, "other_income_type"],
    ["inactive_merchant", { mid: "MID-AGENT-2", processor: "TSYS" }, "inactive_merchant"],
    ["bad_numbers (negative volume, negative residual)", { mid: "MID-AGENT-1", volume: "-500.00", residual: "-11.76" }, "bad_numbers"],
    ["bad_numbers (residual over volume)", { mid: "MID-AGENT-1", volume: "10.00", residual: "11.00" }, "bad_numbers"],
    ["bad_numbers (negative volume)", { mid: "MID-AGENT-1", volume: "-5.00", residual: "1.00" }, "bad_numbers"],
  ];

  it.each(warned)("refuses %s unconfirmed, naming the type and its rows, then commits on a yes", async (_l, row, code) => {
    // MID-AGENT-2 is inactive AND a Square merchant; MID-OTHER-2 is PayBright.
    // Confirm whatever else the row trips, so only `code` is at issue.
    const all = ["processor_mismatch", "inactive_merchant", "bad_numbers", "other_income_type"];
    const others = row.mid === "MID-AGENT-2" ? all.filter((c) => c !== code) : [];
    const { id } = await batchWith(db, [row]);
    const error = await refused(db, id, others);
    expect(error.code).toBe("PT409");
    expect(error.message).toBe(
      `These warnings were not confirmed: ${code.replace(/_/g, " ")} (rows 2). Confirm them on the review screen, or fix the data and read the file again.`,
    );
    expect(error.detail).toBe(code);
    expect(await lineCount(db)).toBe(0);
    await commit(db, id, [...others, code]);
    expect(await lineCount(db, id)).toBe(1);
  });

  it("is silent where there is nothing to warn about", async () => {
    // Case and runs of whitespace in the Processor cell, a merchant with no
    // processor (A6), status 'other' (A26), a clawback on a positive volume (A25).
    await merchant(db, "NOPROC", { processor: null, status: "other" });
    const { id } = await batchWith(db, [
      { mid: "MID-AGENT-1", processor: "  tsys " },
      { mid: "NOPROC", volume: "500.00", residual: "-12.00" },
      { mid: "MID-OTHER-1", volume: "10.00", residual: "10.00" },
    ]);
    expect((await commit(db, id)).written).toBe(3);
    const [{ confirmed }] = await rows<{ confirmed: unknown }>(
      db,
      `select confirmed_warnings as confirmed from rep_payout_batches where id = ${id}`,
    );
    expect(confirmed).toEqual({});
  });

  it("is silent on a blank Processor cell, punctuation, and the aliases Goat and Netevia (phase 15)", async () => {
    await merchant(db, "NETEVIA-1", { processor: "Netevia HQ" });
    const tsys = await batchWith(db, [
      { mid: "MID-AGENT-1", processor: null },
      { mid: "MID-OTHER-1", processor: "Goat " },
    ]);
    expect((await commit(db, tsys.id)).written).toBe(2);
    const netevia = await batchWith(db, [{ mid: "NETEVIA-1", processor: "Netevia" }], { processor: "Netevia HQ" });
    expect((await commit(db, netevia.id)).written).toBe(1);
    const punctuated = await batchWith(db, [{ mid: "MID-AGENT-1", processor: "T.S.Y.S" }]);
    expect((await commit(db, punctuated.id)).written).toBe(1);
  });

  it("processor_key: letters and digits, the two aliases, NULL when blank; callable by authenticated only", async () => {
    await asUser(db, ADMIN_ID);
    expect(
      await rows(db, `select processor_key('  Goat ') as a, processor_key('Netevia') as b, processor_key('Red-Fynn') as c,
                             processor_key(' ') as d, processor_key(null) as e, processor_key('Netevia HQ') as f`),
    ).toEqual([{ a: "tsys", b: "neteviahq", c: "redfynn", d: null, e: null, f: "neteviahq" }]);
    await asPlatform(db);
    expect(
      await rows(db, `select has_function_privilege('anon', 'processor_key(text)', 'execute') as anon,
                             has_function_privilege('authenticated', 'processor_key(text)', 'execute') as auth`),
    ).toEqual([{ anon: false, auth: true }]);
  });

  it("one yes per type covers every row of it, and the batch keeps what was confirmed", async () => {
    const { id } = await batchWith(db, [
      { mid: "MID-AGENT-1", volume: "-1.00", residual: "-1.00" },
      { mid: "MID-OTHER-1", volume: "10.00", residual: "12.00" },
      { mid: "MID-OTHER-2" },
    ]);
    const error = await refused(db, id, ["bad_numbers"]);
    expect(error.message).toMatch(/not confirmed: processor mismatch \(rows 4\)\./);
    await commit(db, id, ["bad_numbers", "processor_mismatch", "inactive_merchant"]);
    const [{ confirmed }] = await rows<{ confirmed: unknown }>(
      db,
      `select confirmed_warnings as confirmed from rep_payout_batches where id = ${id}`,
    );
    // The types PRESENT, with their sheet rows; a yes to an absent type is not
    // recorded as covering anything.
    expect(confirmed).toEqual({ bad_numbers: [2, 3], processor_mismatch: [4] });
  });

  it("a warning that appeared after the review is not covered by the earlier answers", async () => {
    const { id } = await batchWith(db, [{ mid: "MID-AGENT-1" }]);
    await asUser(db, ADMIN_ID);
    await db.exec(`update merchants set status = 'inactive' where mid = 'MID-AGENT-1'`);
    const error = await refused(db, id, []);
    expect(error.message).toMatch(/not confirmed: inactive merchant \(rows 2\)/);
  });
});

// -------------------------------------------------------------------------
// 3. The money
// -------------------------------------------------------------------------

/** Whole-cent rounding, half away from zero: Postgres round(numeric, 2). */
function rateOf(residualCents: number, rateHundredths: number): number {
  const n = Math.abs(residualCents) * rateHundredths;
  return Math.sign(residualCents) * Math.floor((2 * n + 10000) / 20000) || 0;
}

/** shared_part's cent rule: nearest cent, an exact half toward zero. */
function part(totalCents: number, partHundredths: number, wholeHundredths: number): number {
  const n = Math.abs(totalCents) * partHundredths;
  const d = wholeHundredths;
  return Math.sign(totalCents) * Math.floor((2 * n + d - 1) / (2 * d)) || 0;
}

const RESIDUALS = ["100.00", "0.01", "0.03", "0.05", "1.01", "33.33", "99.99", "-0.01", "-0.05", "-33.33", "-11.76", "12345.67"];
const cents = (v: string) => Math.round(Number(v) * 100);
const money = (c: number) => (c / 100).toFixed(2);

const RATES = [0, 30, 45, 50];
const SPLITS: [number, number][] = [
  [25, 25], [40, 10], [0.01, 49.99], // rate 50
  [15, 15], [20, 10], [29.99, 0.01], // rate 30
  [22.5, 22.5], [33.33, 11.67], // rate 45
];

/**
 * The unshared grid: a merchant per (rate, residual), one batch, committed.
 * Returns every way the lines differ from the merchant's rate -- empty when
 * the money is right. A function, not a test body, so the mutation proofs
 * below can run the same grid against a broken copy of v3 and watch it fail.
 */
async function unsharedGrid(target: TestDb): Promise<string[]> {
  const staged: Staged[] = [];
  for (const rate of RATES) {
    for (const [i, residual] of RESIDUALS.entries()) {
      const mid = `U-${rate}-${i}`;
      await merchant(target, mid, { rate });
      staged.push({ mid, volume: "100000.00", residual });
    }
  }
  const { id } = await batchWith(target, staged);
  await commit(target, id);

  const lines = await rows<{ mid: string; rate: string; residual: string; payout: string; volume: string; share_role: string | null }>(
    target,
    `select mid, rep_split_pct::text as rate, residual_income::text as residual,
            rep_payout::text as payout, volume::text as volume, share_role
       from rep_payout_rows where batch_id = ${id}`,
  );
  const wrong: string[] = [];
  for (const { mid } of staged) {
    const line = lines.find((l) => l.mid === mid);
    if (!line) {
      wrong.push(`${mid}: no line`);
      continue;
    }
    const [, rate, i] = mid.split("-");
    const r = cents(RESIDUALS[Number(i)]);
    // The company keeps the rest; at rate 0, all of it (payout 0.00).
    const want = { rate: Number(rate).toFixed(2), residual: money(r), payout: money(rateOf(r, Number(rate) * 100)), volume: "100000.00", share_role: null };
    const got = { rate: line.rate, residual: line.residual, payout: line.payout, volume: line.volume, share_role: line.share_role };
    if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push(`${mid}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
  }
  if (lines.length !== staged.length) wrong.push(`${lines.length} lines for ${staged.length} rows`);
  return wrong;
}

/**
 * The shared grid: SPLITS x RESIDUALS, each a merchant at the split's total
 * rate with a share covering the month. Returns every way a pair differs
 * from the cent rule, and how many exact half-cent ties the grid held (so the
 * tie rule is known to be exercised).
 */
async function sharedGrid(target: TestDb): Promise<{ wrong: string[]; ties: number; result: Record<string, number> }> {
  const staged: Staged[] = [];
  const { period } = await batchWith(target, []); // to learn the month the next batch takes
  await asPlatform(target);
  await target.exec(`delete from rep_payout_batches`);
  for (const [k, [a, b]] of SPLITS.entries()) {
    for (const [i, residual] of RESIDUALS.entries()) {
      const mid = `S-${k}-${i}`;
      const m = await merchant(target, mid, { rate: a + b });
      await share(target, m, AGENT_ID, OTHER_AGENT_ID, a, b, period);
      staged.push({ mid, volume: "100000.00", residual });
    }
  }
  const batch = await batchWith(target, staged, { period });
  const result = await commit(target, batch.id);

  type Line = { mid: string; agent_id: string; share_role: string; rate: string; residual: string; account: string; payout: string; volume: string | null };
  const lines = await rows<Line>(
    target,
    `select mid, agent_id, share_role, rep_split_pct::text as rate, residual_income::text as residual,
            account_residual_income::text as account, rep_payout::text as payout,
            volume::text as volume
       from rep_payout_rows where batch_id = ${batch.id}`,
  );
  const wrong: string[] = [];
  let ties = 0;
  const differs = (mid: string, got: object, want: object) => {
    const picked = Object.fromEntries(Object.keys(want).map((key) => [key, (got as Record<string, unknown>)[key]]));
    if (JSON.stringify(picked) !== JSON.stringify(want)) wrong.push(`${mid}: ${JSON.stringify(picked)} != ${JSON.stringify(want)}`);
  };
  for (const [k, [a, b]] of SPLITS.entries()) {
    const s = Math.round((a + b) * 100);
    for (const [i, residual] of RESIDUALS.entries()) {
      const mid = `S-${k}-${i}`;
      const signer = lines.find((l) => l.mid === mid && l.share_role === "primary");
      const partner = lines.find((l) => l.mid === mid && l.share_role === "secondary");
      if (!signer || !partner) {
        wrong.push(`${mid}: missing a line of the pair`);
        continue;
      }
      const r = cents(residual);
      const t = rateOf(r, s);
      const p = part(t, Math.round(b * 100), s);
      const rp = part(r, Math.round(b * 100), s);
      differs(mid, signer, { agent_id: AGENT_ID, rate: (s / 100).toFixed(2), account: money(r), payout: money(t - p), residual: money(r - rp), volume: "100000.00" });
      differs(mid, partner, { agent_id: OTHER_AGENT_ID, rate: (s / 100).toFixed(2), account: money(r), payout: money(p), residual: money(rp), volume: null });
      // The pair is exactly T, so the company's R - T never moves.
      if (cents(signer.payout) + cents(partner.payout) !== t) wrong.push(`${mid}: pair is not T`);
      if (cents(signer.residual) + cents(partner.residual) !== r) wrong.push(`${mid}: pieces are not R`);
      // Odd-in-R: neither side takes the opposite sign to the account.
      if (Math.sign(cents(signer.payout)) * Math.sign(t) === -1) wrong.push(`${mid}: signer's sign`);
      if (Math.sign(cents(partner.payout)) * Math.sign(t) === -1) wrong.push(`${mid}: partner's sign`);
      // An exact half-cent tie on the partner's piece: the signer absorbs it.
      if ((2 * Math.abs(t) * Math.round(b * 100)) % (2 * s) === s) ties += 1;
    }
  }
  if (lines.length !== staged.length * 2) wrong.push(`${lines.length} lines for ${staged.length} shared rows`);
  return { wrong, ties, result };
}

describe("the money: the merchant's rate, the company the rest, the cent rule on a shared account", () => {
  it("pays every unshared line at its merchant's rate -- 0, 30, 45 and 50 -- across odd cents", async () => {
    expect(await unsharedGrid(db)).toEqual([]);
  });

  it("divides the merchant's rate between signer and partner by the cent rule, the pair summing to T", async () => {
    const { wrong, ties, result } = await sharedGrid(db);
    const shared = SPLITS.length * RESIDUALS.length;
    expect(result).toEqual({ written: shared * 2, rows: shared, shared, overrides: 0, replaced_lines: 0 });
    expect(wrong).toEqual([]);
    // The grid holds exact half-cent ties (25+25 on an odd T), so the tie rule is exercised.
    expect(ties).toBeGreaterThan(0);
  });
});

// -------------------------------------------------------------------------
// 4. The marker, the audit row, the batch record
// -------------------------------------------------------------------------

describe("the negative-volume marker", () => {
  it("is set exactly on the negative-volume lines of a confirmed bad_numbers, and nowhere else", async () => {
    await merchant(db, "NEG-1");
    await merchant(db, "NEG-2");
    await merchant(db, "NEG-3");
    const { id } = await batchWith(db, [
      { mid: "NEG-1", volume: "-5.00", residual: "1.00" },
      { mid: "NEG-2", volume: "0.00", residual: "-1.00" },
      { mid: "NEG-3", volume: "10.00", residual: "20.00" },
      { mid: "MID-AGENT-1", volume: "100.00", residual: "5.00" },
    ]);
    await commit(db, id, ["bad_numbers"]);
    const marked = await rows<{ mid: string; marked: boolean }>(
      db,
      `select mid, volume_confirmed_negative as marked from rep_payout_rows where batch_id = ${id} order by mid`,
    );
    expect(marked).toEqual([
      { mid: "MID-AGENT-1", marked: false },
      { mid: "NEG-1", marked: true },
      { mid: "NEG-2", marked: false },
      { mid: "NEG-3", marked: false },
    ]);
  });

  it("marks the signer's line of a shared account (the partner's has no volume)", async () => {
    const { period } = await batchWith(db, []);
    await asPlatform(db);
    await db.exec(`delete from rep_payout_batches`);
    const m = await merchant(db, "NEG-SH", { rate: 50 });
    await share(db, m, AGENT_ID, OTHER_AGENT_ID, 40, 10, period);
    const { id } = await batchWith(db, [{ mid: "NEG-SH", volume: "-2.00", residual: "1.00" }], { period });
    await commit(db, id, ["bad_numbers"]);
    expect(
      await rows(db, `select share_role, volume_confirmed_negative as marked from rep_payout_rows where batch_id = ${id} order by share_role`),
    ).toEqual([{ share_role: "primary", marked: true }, { share_role: "secondary", marked: false }]);
  });
});

describe("the commit's record", () => {
  it("writes one audit row naming the admin, and closes the batch with who-and-when", async () => {
    await db.exec(`delete from audit_log`);
    const { id, period } = await batchWith(db, [{ mid: "MID-AGENT-1" }, { mid: "MID-OTHER-1" }]);
    const result = await commit(db, id);
    expect(result).toEqual({ written: 2, rows: 2, shared: 0, overrides: 0, replaced_lines: 0 });

    const audit = await rows(
      db,
      `select actor_id, action, table_name, row_id from audit_log where action = 'commit_residual_import'`,
    );
    expect(audit).toEqual([
      { actor_id: ADMIN_ID, action: "commit_residual_import", table_name: "rep_payout_batches", row_id: String(id) },
    ]);
    const [batch] = await rows<Record<string, unknown>>(
      db,
      `select status, committed_at is not null as stamped, row_count
         from rep_payout_batches where id = ${id}`,
    );
    expect(batch).toEqual({ status: "committed", stamped: true, row_count: 2 });
    expect(await rows(db, `select count(*)::int as n from rep_payout_import_rows where batch_id = ${id}`)).toEqual([{ n: 0 }]);
    // Month and processor from the batch, name from the merchant.
    const lines = await rows(
      db,
      `select period::text as period, processor, merchant_name, line_kind
         from rep_payout_rows where batch_id = ${id} order by mid`,
    );
    expect(lines).toEqual([
      { period, processor: "TSYS", merchant_name: "Agent Active Co", line_kind: "import" },
      { period, processor: "TSYS", merchant_name: "Other Active Co", line_kind: "import" },
    ]);
  });
});

// -------------------------------------------------------------------------
// 5. The merchant's rate and owner
// -------------------------------------------------------------------------

describe("the merchant rate CHECK (0 to 50, the company half matching)", () => {
  const insert = (agent: string, company: string) =>
    `insert into merchants (agent_id, dba, split_agent_pct, split_company_pct, city, state)
     values ('${AGENT_ID}', 'Rate Co', ${agent}, ${company}, 'Nashville', 'TN')`;

  it.each([["0", "100"], ["50", "50"], ["12.34", "87.66"], ["null", "null"]])("accepts %s / %s", async (a, c) => {
    await asUser(db, ADMIN_ID);
    await db.exec(insert(a, c));
  });

  it.each([["50.01", "49.99"], ["60", "40"], ["-1", "101"]])("refuses %s / %s", async (a, c) => {
    await asUser(db, ADMIN_ID);
    const error = await attempt(() => db.exec(insert(a, c)));
    expect(error?.message).toMatch(/merchants_split_zero_to_fifty/);
  });

  it("is validated, not NOT VALID", async () => {
    expect(
      await rows(db, `select convalidated from pg_constraint where conname = 'merchants_split_zero_to_fifty'`),
    ).toEqual([{ convalidated: true }]);
  });
});

describe("set_merchant_split", () => {
  const set = async (who: string, id: number | string, rate: string) => {
    await asUser(db, who);
    try {
      await db.query(`select set_merchant_split(${id}, ${rate})`);
    } finally {
      await asPlatform(db);
    }
  };
  const idOf = async (mid: string) =>
    (await rows<{ id: number }>(db, `select id from merchants where mid = '${mid}'`))[0].id;
  const splitOf = async (mid: string) =>
    (await rows(db, `select split_agent_pct::text as a, split_company_pct::text as c from merchants where mid = '${mid}'`))[0];

  it("sets both halves for an admin and audits it", async () => {
    const id = await idOf("MID-AGENT-1");
    await set(ADMIN_ID, id, "30.5");
    expect(await splitOf("MID-AGENT-1")).toEqual({ a: "30.50", c: "69.50" });
    expect(await rows(db, `select actor_id, action, table_name, row_id from audit_log where action = 'set_merchant_split'`)).toEqual([
      { actor_id: ADMIN_ID, action: "set_merchant_split", table_name: "merchants", row_id: String(id) },
    ]);
  });

  it("gives a merchant with no rate its first one; a same-value call writes no audit row", async () => {
    const id = await merchant(db, "FIRST", { rate: null });
    await set(ADMIN_ID, id, "0");
    expect(await splitOf("FIRST")).toEqual({ a: "0.00", c: "100.00" });
    await set(ADMIN_ID, id, "0");
    expect(await rows(db, `select count(*)::int as n from audit_log where action = 'set_merchant_split'`)).toEqual([{ n: 1 }]);
  });

  it.each([
    ["an agent", AGENT_ID, "40", "PT403"],
    ["a rate over 50", ADMIN_ID, "50.01", "PT400"],
    ["a negative rate", ADMIN_ID, "-0.01", "PT400"],
    ["three decimals", ADMIN_ID, "10.005", "PT400"],
    ["no rate", ADMIN_ID, "null", "PT400"],
  ])("refuses %s (%s) and changes nothing", async (_l, who, rate, code) => {
    const id = await idOf("MID-AGENT-1");
    const error = await attempt(() => set(who, id, rate));
    expect(error?.code).toBe(code);
    expect(await splitOf("MID-AGENT-1")).toEqual({ a: "50.00", c: "50.00" });
  });

  it("refuses a missing merchant (PT404)", async () => {
    expect((await attempt(() => set(ADMIN_ID, 999999, "10")))?.code).toBe("PT404");
  });

  it("refuses while the merchant has a live share, and allows it once the share is settled", async () => {
    const id = await idOf("MID-AGENT-1");
    const [{ m }] = await rows<{ m: string }>(db, `select to_char(date_trunc('month', now()) - interval '3 months', 'YYYY-MM-DD') as m`);
    const shareId = await share(db, id, AGENT_ID, OTHER_AGENT_ID, 25, 25, m);
    const error = await attempt(() => set(ADMIN_ID, id, "40"));
    expect(error?.code).toBe("PT409");
    expect(error?.message).toBe(
      "This merchant has a shared-account split, which divides its current rate. End the share before changing the rate.",
    );
    // Ended at month m+1, and a line committed for month m+1: nothing left to pay.
    await db.exec(`update merchant_rep_shares set effective_to = ('${m}'::date + interval '1 month')::date where id = ${shareId};
                   insert into rep_payout_rows (agent_id, period, mid, merchant_id, residual_income, rep_split_pct)
                   values ('${AGENT_ID}', ('${m}'::date + interval '1 month')::date, 'MID-AGENT-1', ${id}, 1.00, 50.00)`);
    await set(ADMIN_ID, id, "40");
    expect(await splitOf("MID-AGENT-1")).toEqual({ a: "40.00", c: "60.00" });
  });

  it("is the only way in: a direct UPDATE of either half is refused, an admin's too", async () => {
    for (const column of ["split_agent_pct = 40, split_company_pct = 60", "split_company_pct = 60"]) {
      await asUser(db, ADMIN_ID);
      const error = await attempt(() => db.exec(`update merchants set ${column} where mid = 'MID-AGENT-1'`));
      expect(error?.code, column).toBe("PT409");
      expect(error?.message).toMatch(/^A merchant's split rate is changed only with its Split control/);
    }
    // A same-value write (the form saving other fields) is not a change.
    await asUser(db, ADMIN_ID);
    await db.exec(`update merchants set split_agent_pct = 50, dba = 'Renamed' where mid = 'MID-AGENT-1'`);
    await asPlatform(db);
  });
});

describe("moving a merchant while it has a live share", () => {
  it("is refused; with no share, or a settled one, it is allowed", async () => {
    const id = (await rows<{ id: number }>(db, `select id from merchants where mid = 'MID-AGENT-1'`))[0].id;
    const move = async () => {
      await asUser(db, ADMIN_ID);
      try {
        await db.exec(`update merchants set agent_id = '${OTHER_AGENT_ID}' where id = ${id}`);
      } finally {
        await asPlatform(db);
      }
    };
    const [{ m }] = await rows<{ m: string }>(db, `select to_char(date_trunc('month', now()) + interval '2 months', 'YYYY-MM-DD') as m`);
    // A share starting in the future is live too.
    const shareId = await share(db, id, AGENT_ID, OTHER_AGENT_ID, 25, 25, m);
    const error = await attempt(move);
    expect(error?.code).toBe("PT409");
    expect(error?.message).toBe("This merchant has a shared-account split. End it before moving the merchant.");
    expect(await rows(db, `select agent_id from merchants where id = ${id}`)).toEqual([{ agent_id: AGENT_ID }]);
    await db.exec(`delete from merchant_rep_shares where id = ${shareId}`);
    await move();
    expect(await rows(db, `select agent_id from merchants where id = ${id}`)).toEqual([{ agent_id: OTHER_AGENT_ID }]);
  });
});

// -------------------------------------------------------------------------
// 6. Grants and catalog
// -------------------------------------------------------------------------

describe("grants and catalog", () => {
  it("v3: security definer, search_path pinned, is_admin() first, one overload; executable by authenticated and service_role, never anon", async () => {
    const fns = await rows<{ sig: string; definer: boolean; config: string[]; body: string }>(
      db,
      `select oid::regprocedure::text as sig, prosecdef as definer, proconfig as config, prosrc as body
         from pg_proc where proname = '${V3}'`,
    );
    expect(fns).toHaveLength(1);
    expect(fns[0].sig).toBe("commit_residual_import_v3(integer,text[])");
    expect(fns[0].definer).toBe(true);
    expect(fns[0].config).toEqual(["search_path=public, pg_temp"]);
    expect(fns[0].body.trimStart()).toMatch(/^declare[\s\S]*?begin\s+if not is_admin\(\) then/);
    expect(fns[0].body).toContain("pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'))");
    const can = await rows<{ role: string; ok: boolean }>(
      db,
      `select r as role, has_function_privilege(r, '${V3}(int, text[])', 'execute') as ok
         from unnest(array['anon', 'authenticated', 'service_role']) as r`,
    );
    expect(can).toEqual([
      { role: "anon", ok: false },
      { role: "authenticated", ok: true },
      { role: "service_role", ok: true },
    ]);
  });

  it("set_merchant_split has the same shape; the live-share helper and the guard are callable by no client", async () => {
    const [split] = await rows<{ definer: boolean; config: string[] }>(
      db,
      `select prosecdef as definer, proconfig as config from pg_proc where proname = 'set_merchant_split'`,
    );
    expect(split).toEqual({ definer: true, config: ["search_path=public, pg_temp"] });
    const can = await rows<{ fn: string; role: string; ok: boolean }>(
      db,
      `select f as fn, r as role, has_function_privilege(r, f, 'execute') as ok
         from unnest(array['set_merchant_split(int, numeric)', 'merchant_has_live_share(int)',
                           'guard_merchant_split_and_owner()']) as f,
              unnest(array['anon', 'authenticated']) as r
        order by 1, 2`,
    );
    expect(can).toEqual([
      { fn: "guard_merchant_split_and_owner()", role: "anon", ok: false },
      { fn: "guard_merchant_split_and_owner()", role: "authenticated", ok: false },
      { fn: "merchant_has_live_share(int)", role: "anon", ok: false },
      { fn: "merchant_has_live_share(int)", role: "authenticated", ok: false },
      { fn: "set_merchant_split(int, numeric)", role: "anon", ok: false },
      { fn: "set_merchant_split(int, numeric)", role: "authenticated", ok: true },
    ]);
  });

  it("v2 is gone, and since 20261104140000 the old commit_residual_import(int) too", async () => {
    expect(await rows(db, `select count(*)::int as n from pg_proc where proname = 'commit_residual_import_v2'`)).toEqual([{ n: 0 }]);
    expect(await rows(db, `select count(*)::int as n from pg_proc where proname = 'commit_residual_import'`)).toEqual([{ n: 0 }]);
  });
});

// -------------------------------------------------------------------------
// 7. The migration over existing rows
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
      merchants: await rows(target, `select to_jsonb(m) as j from merchants m order by id`),
      shares: await rows(target, `select to_jsonb(s) as j from merchant_rep_shares s order by id`),
    };
  };

  it("applies over merchants at 0-50 and shares, changing no row", async () => {
    const target = await populated();
    await target.exec(`
      insert into merchants (agent_id, mid, dba, split_agent_pct, split_company_pct, city, state)
      values ('${AGENT_ID}', 'HOUSE', 'House Co', 0, 100, 'Nashville', 'TN'),
             ('${AGENT_ID}', 'NONE', 'None Co', null, null, 'Nashville', 'TN');
      insert into merchant_rep_shares (merchant_id, primary_agent_id, secondary_agent_id,
                                       primary_rep_pct, secondary_rep_pct, effective_from)
      values ((select id from merchants where mid = 'MID-AGENT-1'), '${AGENT_ID}', '${OTHER_AGENT_ID}', 40, 10, '2026-08-01');`);
    const before = await snapshot(target);
    await target.exec(await readMigration(MIGRATION));
    expect(await snapshot(target)).toEqual(before);
  });

  it("refuses a merchant outside 0-50, or with a mismatched company half, naming them, and changes nothing", async () => {
    const target = await populated();
    await target.exec(`
      insert into merchants (agent_id, mid, dba, split_agent_pct, split_company_pct, city, state)
      values ('${AGENT_ID}', 'SIXTY', 'Sixty Co', 60, 40, 'Nashville', 'TN');`);
    // merchants_split_totals_100 is NOT VALID, so a row predating it can hold
    // a mismatched pair; one is planted the way such a row would have got in.
    await target.exec(`
      alter table merchants drop constraint merchants_split_totals_100;
      insert into merchants (agent_id, mid, dba, split_agent_pct, split_company_pct, city, state)
      values ('${AGENT_ID}', 'ODD', 'Odd Co', 40, 50, 'Nashville', 'TN');`);
    const ids = await rows<{ id: number }>(target, `select id from merchants where mid in ('SIXTY', 'ODD') order by id`);
    const before = await snapshot(target);
    const error = await attempt(async () => target.exec(await readMigration(MIGRATION)));
    expect(error?.message).toBe(
      `commit v3 migration refuses to run: merchants ${ids.map((r) => r.id).join(", ")} have a split rate outside 0-50, or a company half that is not 100 minus it. Set each one deliberately (the rate is money owed), then re-run.`,
    );
    expect(await snapshot(target)).toEqual(before);
    expect(await rows(target, `select count(*)::int as n from pg_proc where proname = '${V3}'`)).toEqual([{ n: 0 }]);
  });
});

// -------------------------------------------------------------------------
// 8. Mutation proofs: remove one protection from a copy, and its case passes.
// -------------------------------------------------------------------------

describe("mutation proofs: each protection is what stops its case", () => {
  let mutant: TestDb;
  let original: string;

  beforeAll(async () => {
    mutant = await open();
    [{ def: original }] = await rows<{ def: string }>(
      mutant,
      `select pg_get_functiondef('${V3}(int, text[])'::regprocedure) as def`,
    );
  });

  beforeEach(async () => {
    await resetData(mutant);
    await asPlatform(mutant);
    await mutant.exec(original);
  });

  /** Re-creates v3 from its own definition with one fragment removed. */
  async function without(fragment: string, replacement = ""): Promise<void> {
    await asPlatform(mutant);
    const [{ def }] = await rows<{ def: string }>(
      mutant,
      `select pg_get_functiondef('${V3}(int, text[])'::regprocedure) as def`,
    );
    expect(def, "the fragment must be in the function").toContain(fragment);
    await mutant.exec(def.replace(fragment, replacement));
  }

  const swap = async <T,>(fn: () => Promise<T>): Promise<T> => {
    const saved = db;
    db = mutant;
    try {
      return await fn();
    } finally {
      db = saved;
    }
  };

  it("the owner re-check", async () => {
    await without("r.agent_id is distinct from m.agent_id", "false");
    await swap(async () => {
      const { id } = await batchWith(db, [{ mid: "MID-AGENT-1", agentId: OTHER_AGENT_ID }]);
      // Committed instead of refused (to the current owner: v3 never pays the
      // staged rep, so the refusal is the whole protection).
      expect((await commit(db, id)).written).toBe(1);
    });
  });

  it("the warning check", async () => {
    await without("if cardinality(unconfirmed) > 0 then", "if false then");
    await swap(async () => {
      const { id } = await batchWith(db, [{ mid: "MID-AGENT-1", processor: "Square" }]);
      expect((await commit(db, id)).written).toBe(1);
    });
  });

  it("the existing-line (no merge) check", async () => {
    await without("on mid_key(l.mid) = mid_key(r.mid_raw) and l.period = batch.period", "on false");
    await swap(async () => {
      const { id, period } = await batchWith(db, [{ mid: "MID-AGENT-1" }]);
      await db.exec(`insert into rep_payout_rows (agent_id, period, processor, mid, residual_income, rep_split_pct)
                     values ('${OTHER_AGENT_ID}', '${period}', 'Square', 'MID-AGENT-1', 1.00, 50.00)`);
      expect((await commit(db, id)).written).toBe(1);
      expect(await rows(db, `select count(*)::int as n from rep_payout_rows where mid = 'MID-AGENT-1'`)).toEqual([{ n: 2 }]);
    });
  });

  it("the staged-month check", async () => {
    await without("r.period is distinct from batch.period", "false");
    await swap(async () => {
      const { id } = await batchWith(db, [{ mid: "MID-AGENT-1" }]);
      await shiftStagedMonth(db, id);
      expect((await commit(db, id)).written).toBe(1);
    });
  });

  it("the processor-month check (the unique index is the backstop)", async () => {
    await without("status = 'committed' and id <> batch.id", "false");
    await swap(async () => {
      const first = await batchWith(db, [{ mid: "MID-AGENT-1" }]);
      await commit(db, first.id);
      const second = await batchWith(db, [{ mid: "MID-OTHER-1" }], { period: first.period });
      const error = await attempt(() => commit(db, second.id));
      await asPlatform(db);
      expect(error?.message).toMatch(/rep_payout_batches_one_committed_per_month/);
    });
  });

  it("the share-signer check", async () => {
    await without("s.primary_agent_id <> m.agent_id", "false");
    await swap(async () => {
      const m = await merchant(db, "SH-OWN", { rate: 50 });
      const { id, period } = await batchWith(db, [{ mid: "SH-OWN" }]);
      await share(db, m, OTHER_AGENT_ID, ADMIN_ID, 25, 25, period);
      expect((await commit(db, id)).shared).toBe(1);
    });
  });

  it("the negative-volume marker (the ledger CHECK then refuses the line)", async () => {
    await without("r.volume, r.average_ticket, r.total_cost, r.volume < 0,", "r.volume, r.average_ticket, r.total_cost, false,");
    await swap(async () => {
      const { id } = await batchWith(db, [{ mid: "MID-AGENT-1", volume: "-5.00", residual: "1.00" }]);
      const error = await attempt(() => commit(db, id, ["bad_numbers"]));
      await asPlatform(db);
      expect(error?.message).toMatch(/rep_payout_rows_volume_check/);
    });
  });

  // Step 0 of phase 9: every refusal above that had no proof of its own. Each
  // case is first refused by the real v3 with its own sentence; with the one
  // check removed, the same data is either committed or refused by something
  // else (a later check or the ledger's own index) -- never by that sentence.
  // So each refusal test above fails if its check is taken out.
  const REFUSALS: {
    label: string;
    fragment: string;
    replacement: string;
    make: () => Promise<{ id: number; confirmed?: string[] }>;
    refusal: RegExp;
  }[] = [
    {
      label: "unknown confirmation code",
      fragment: "if exists (select 1 from unnest(confirmed) as c(code)",
      replacement: "if false and exists (select 1 from unnest(confirmed) as c(code)",
      make: async () => ({ id: (await batchWith(db, [{ mid: "MID-AGENT-1" }])).id, confirmed: ["looks_shared"] }),
      refusal: /^Only processor_mismatch, inactive_merchant, bad_numbers and other_income_type can be confirmed\.$/,
    },
    {
      label: "status (an abandoned batch)",
      fragment: "if batch.status <> 'review' then",
      replacement: "if false then",
      make: async () => {
        const { id } = await batchWith(db, [{ mid: "MID-AGENT-1" }]);
        await asPlatform(db);
        await db.exec(`update rep_payout_batches set status = 'abandoned' where id = ${id}`);
        return { id };
      },
      refusal: /^this import is already abandoned$/,
    },
    {
      label: "processor-and-month check (a legacy batch)",
      fragment: "if batch.processor is null or batch.period is null then",
      replacement: "if false then",
      make: async () => {
        await asPlatform(db);
        await db.exec(`set session_replication_role = replica`);
        let id: number;
        try {
          [{ id }] = await rows<{ id: number }>(
            db,
            `insert into rep_payout_batches (imported_by, file_key, file_name, status)
             values ('${ADMIN_ID}', 'old/f.xlsx', 'f.xlsx', 'review') returning id`,
          );
        } finally {
          await db.exec(`set session_replication_role = origin`);
        }
        await db.exec(`insert into rep_payout_import_rows (batch_id, row_number, mid_raw, income_type_raw, processor_raw,
                                                           period, agent_id, merchant_id, volume, residual_income)
                       select ${id}, 2, mid, 'Residuals', 'TSYS', '2026-07-01', agent_id, id, 1000, 100
                         from merchants where mid = 'MID-AGENT-1'`);
        return { id };
      },
      refusal: /started before the processor and month were chosen at upload/,
    },
    {
      label: "empty-batch check",
      fragment: "if staged = 0 then",
      replacement: "if false then",
      make: async () => ({ id: (await batchWith(db, [])).id }),
      refusal: /^this import has no rows$/,
    },
    {
      label: "blocked-row check",
      fragment: "if blocked > 0 then",
      replacement: "if false then",
      // A clean row carrying a stored blocker: nothing else would refuse it.
      make: async () => ({ id: (await batchWith(db, [{ mid: "MID-AGENT-1", blocker: "mid_in_other_batch" }])).id }),
      refusal: /rows are still blocked$/,
    },
    {
      label: "blank-MID check",
      fragment: "and (r.mid_raw is null or btrim(r.mid_raw) = '');",
      replacement: "and false;",
      make: async () => ({ id: (await batchWith(db, [{ mid: "  " }])).id }),
      refusal: /^Rows 2 have no MID\./,
    },
    {
      label: "repeated-MID check (the merge key then refuses the second line)",
      fragment: "having count(*) > 1) d;",
      replacement: "having false) d;",
      make: async () => ({ id: (await batchWith(db, [{ mid: "MID-AGENT-1" }, { mid: "MID-AGENT-1" }])).id }),
      refusal: /^A MID appears on more than one row/,
    },
    {
      label: "unknown-MID check (the row would be dropped silently)",
      fragment: "and not exists (select 1 from merchants m where mid_key(m.mid) = mid_key(r.mid_raw));",
      replacement: "and false;",
      make: async () => ({ id: (await batchWith(db, [{ mid: "NOPE-1", agentId: null }])).id }),
      refusal: /are not merchants in the CRM/,
    },
    {
      // Phase 15: another Income Type is a warning; without its line the
      // row would commit unconfirmed.
      label: "other_income_type warning",
      fragment: "not in ('', 'residual', 'residuals'))",
      replacement: "not in ('', 'residual', 'residuals') and false)",
      make: async () => ({ id: (await batchWith(db, [{ mid: "MID-AGENT-1", incomeType: "ACH" }])).id }),
      refusal: /not confirmed: other income type \(rows 2\)/,
    },
    {
      label: "processor_mismatch on a named processor (the file's cell)",
      fragment: "and processor_key(r.processor_raw) is distinct from processor_key(batch.processor))",
      replacement: "and false)",
      make: async () => ({ id: (await batchWith(db, [{ mid: "MID-AGENT-1", processor: "Square" }])).id }),
      refusal: /not confirmed: processor mismatch \(rows 2\)/,
    },
    {
      label: "missing-figure check",
      fragment: "and (r.volume is null or r.residual_income is null);",
      replacement: "and false;",
      make: async () => ({ id: (await batchWith(db, [{ mid: "MID-AGENT-1", residual: null }])).id }),
      refusal: /have no Volume or no Residual/,
    },
    {
      label: "no-rate check",
      fragment: "where r.batch_id = batch_id_input and m.split_agent_pct is null;",
      replacement: "where false;",
      make: async () => {
        await merchant(db, "NORATE-1", { rate: null });
        return { id: (await batchWith(db, [{ mid: "NORATE-1" }])).id };
      },
      refusal: /belong to merchants with no split rate/,
    },
    {
      label: "shares-total-the-rate check",
      fragment: "or s.primary_rep_pct + s.secondary_rep_pct <> m.split_agent_pct);",
      replacement: ");",
      make: async () => {
        const m = await merchant(db, "SH-RATE", { rate: 40 });
        const batch = await batchWith(db, [{ mid: "SH-RATE" }]);
        await share(db, m, AGENT_ID, OTHER_AGENT_ID, 25, 25, batch.period);
        return { id: batch.id };
      },
      refusal: /have a shared-account split whose signer is not the merchant's owner, or whose shares do not total/,
    },
  ];

  it.each(REFUSALS)("the $label", async ({ fragment, replacement, make, refusal }) => {
    await swap(async () => {
      const { id, confirmed } = await make();
      const real = await attempt(() => commit(db, id, confirmed));
      await asPlatform(db);
      expect(real?.message, "the real v3 refuses the case with its sentence").toMatch(refusal);
      await without(fragment, replacement);
      const mutated = await attempt(() => commit(db, id, confirmed));
      await asPlatform(db);
      expect(mutated?.message ?? "committed", "without the check, that sentence is gone").not.toMatch(refusal);
    });
  });

  // Phase 15's two relaxations, the other way round: each test above that
  // commits a blank Processor cell or an alias silently fails without its rule.
  it("the blank-cell exemption (a blank Processor cell would warn again)", async () => {
    await swap(async () => {
      const { id } = await batchWith(db, [{ mid: "MID-AGENT-1", processor: null }]);
      await without("(processor_key(r.processor_raw) is not null\n          and ", "(");
      const error = await attempt(() => commit(db, id));
      await asPlatform(db);
      expect(error?.message).toMatch(/not confirmed: processor mismatch \(rows 2\)/);
    });
  });

  it("the alias map (Goat on a TSYS file would warn)", async () => {
    await swap(async () => {
      const { id } = await batchWith(db, [{ mid: "MID-AGENT-1", processor: "Goat" }]);
      const [{ def }] = await rows<{ def: string }>(
        db,
        `select pg_get_functiondef('processor_key(text)'::regprocedure) as def`,
      );
      expect(def).toContain("when 'goat' then 'tsys'");
      await db.exec(def.replace("when 'goat' then 'tsys'", "when 'never' then 'tsys'"));
      try {
        const error = await attempt(() => commit(db, id));
        await asPlatform(db);
        expect(error?.message).toMatch(/not confirmed: processor mismatch \(rows 2\)/);
      } finally {
        await asPlatform(db);
        await db.exec(def);
      }
    });
  });

  it("the is_admin() guard (a rep would commit)", async () => {
    await swap(async () => {
      const { id } = await batchWith(db, [{ mid: "MID-AGENT-1" }]);
      const asAgent = async () => {
        await asUser(db, AGENT_ID);
        try {
          return await db.query(`select ${V3}(${id}, '{}')`);
        } finally {
          await asPlatform(db);
        }
      };
      expect((await attempt(asAgent))?.code).toBe("PT403");
      await without("if not is_admin() then", "if false then");
      expect(await attempt(asAgent)).toBeNull();
      expect(await lineCount(db, id)).toBe(1);
    });
  });

  it("the house line (rate 0 still writes its line): skipping it fails the unshared grid", async () => {
    await swap(async () => {
      expect(await unsharedGrid(db)).toEqual([]);
      await resetData(db);
      await without(
        "     and not exists (\n       select 1 from merchant_rep_shares s",
        "     and m.split_agent_pct > 0\n     and not exists (\n       select 1 from merchant_rep_shares s",
      );
      const wrong = await unsharedGrid(db);
      expect(wrong.length).toBeGreaterThan(0);
      expect(wrong.some((w) => /^U-0-\d+: no line$/.test(w))).toBe(true);
    });
  });

  it("the cent rule: a shared_part that rounds half away from zero fails the shared grid at the ties", async () => {
    await swap(async () => {
      const [{ def: sharedPart }] = await rows<{ def: string }>(
        db,
        `select pg_get_functiondef('shared_part(numeric, numeric, numeric)'::regprocedure) as def`,
      );
      try {
        await db.exec(`create or replace function shared_part(total numeric, part numeric, whole numeric)
                       returns numeric language sql immutable strict set search_path = public
                       as $$ select round(total * part / whole, 2) $$`);
        const { wrong, ties } = await sharedGrid(db);
        expect(ties).toBeGreaterThan(0);
        expect(wrong.length).toBeGreaterThan(0);
      } finally {
        await asPlatform(db);
        await db.exec(sharedPart);
      }
    });
  });

  it("the merchant's rate (a constant 50 instead pays the wrong amount)", async () => {
    await without("r.residual_income, m.split_agent_pct, batch_id_input\n", "r.residual_income, 50, batch_id_input\n");
    await swap(async () => {
      // THIRTY's rate is 30: v3 pays 30.00 of 100.00; the mutant pays 50.00.
      await merchant(db, "THIRTY", { rate: 30 });
      const { id } = await batchWith(db, [{ mid: "THIRTY" }]);
      await commit(db, id);
      expect(await rows(db, `select rep_payout::text as p from rep_payout_rows where batch_id = ${id}`)).toEqual([{ p: "50.00" }]);
    });
  });
});
