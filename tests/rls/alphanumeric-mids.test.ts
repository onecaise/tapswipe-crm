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
  seedPayouts,
  stageForCommit,
  type TestDb,
} from "../helpers/db";

/**
 * 20261106140000: MIDs with letters, compared case-insensitively wherever a
 * residual line is matched to a merchant. Every MID here is invented.
 *
 *   1. mid_key() and merchants_mid_key_ci: one merchant per MID whatever its
 *      case; grants as every function's.
 *   2. Through the real commit: a lettered MID staged in another case (and
 *      in mixed case) pays its merchant, the line carries the MERCHANT's
 *      spelling; a MID repeated in another case is refused naming both
 *      spellings; an unknown lettered MID is refused; a MID with a line this
 *      month in another case is refused (no merge); a replace goes through,
 *      and is refused under an adjustment naming the MID in another case.
 *   3. post_payout_adjustment finds the merchant in any case;
 *      delete_payout_period sees an adjustment in another case.
 *   4. The migration: refuses, naming them, merchants whose MIDs differ only
 *      in case or surrounding spaces, and a function body it did not copy;
 *      passes over a populated database and moves no row.
 *   5. Mutation proofs: each comparison put back to plain equality lets its
 *      case through, so the tests above are about something.
 */

const MIGRATION = "20261106140000_alphanumeric_mids.sql";
const V3 = "commit_residual_import_v3";
const PROCESSOR = "TSYS";
const SQ = "SQ7K2M9QX4B1Z";

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

async function attempt(target: TestDb, fn: () => Promise<unknown>): Promise<DbError | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error as DbError;
  } finally {
    await asPlatform(target);
  }
}

/** A merchant at rate 50, as the platform. */
async function merchant(target: TestDb, mid: string, owner = AGENT_ID): Promise<number> {
  await asPlatform(target);
  const [{ id }] = await rows<{ id: number }>(
    target,
    `insert into merchants (agent_id, mid, dba, status, processor, split_agent_pct, split_company_pct, city, state)
     values ('${owner}', '${mid}', 'Invented ${mid} Co', 'active', '${PROCESSOR}', 50, 50, 'Nashville', 'TN')
     returning id`,
  );
  return id;
}

/**
 * A review batch with rows staged as parse-residual-import leaves them: the
 * file's spelling in mid_raw, the merchant found by key.
 */
async function batchWith(
  target: TestDb,
  mids: string[],
  fields: { period?: string; replaces?: number } = {},
): Promise<{ id: number; period: string }> {
  await asPlatform(target);
  const extra: Record<string, string> = {
    processor: `'${PROCESSOR}'`,
    period: fields.period ? `'${fields.period}'` : freeBatchMonth(PROCESSOR),
  };
  if (fields.replaces !== undefined) extra.replaces_batch_id = String(fields.replaces);
  const id = await insertBatch(target, { extra });
  for (const [i, mid] of mids.entries()) {
    await target.exec(`
      insert into rep_payout_import_rows
        (batch_id, row_number, mid_raw, merchant_name_raw, processor_raw, income_type_raw,
         period, agent_id, merchant_id, volume, residual_income)
      select b.id, ${i + 2}, '${mid}', 'File name', b.processor, 'Residuals',
             b.period, m.agent_id, m.id, 1000.00, 100.00
        from rep_payout_batches b
        left join merchants m on upper(m.mid) = upper('${mid}')
       where b.id = ${id}`);
  }
  const [{ period }] = await rows<{ period: string }>(
    target,
    `select period::text as period from rep_payout_batches where id = ${id}`,
  );
  return { id, period };
}

async function call<T = unknown>(target: TestDb, sql: string): Promise<T> {
  await asUser(target, ADMIN_ID);
  try {
    const result = await target.query<Record<string, T>>(`select ${sql} as v`);
    return result.rows[0]?.v as T;
  } finally {
    await asPlatform(target);
  }
}

const label = (period: string) =>
  `${PROCESSOR} ${new Date(`${period}T00:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })}`;
const close = (target: TestDb, period: string) =>
  call(target, `close_payout_period('${period}', '${PROCESSOR}', '${label(period)}')`);
const reopen = (target: TestDb, period: string) =>
  call(target, `reopen_payout_period('${period}', '${PROCESSOR}', 'An invented reason for the test.')`);

/** An adjustment line for `period`, under ANOTHER processor, with `mid` as given. */
async function adjustmentLine(target: TestDb, period: string, mid: string): Promise<void> {
  await asPlatform(target);
  await target.exec(`
    insert into rep_payout_rows (agent_id, period, processor, mid, merchant_name, line_kind,
                                 adjustment_amount, adjusts_period, adjustment_note)
    values ('${AGENT_ID}', (date '${period}' + interval '1 month')::date, 'Square', '${mid}',
            'Invented', 'adjustment', -1.00, '${period}', 'Invented correction')`);
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
// 1. The key and the index
// -------------------------------------------------------------------------

describe("mid_key and merchants_mid_key_ci", () => {
  it("is upper(btrim()), immutable, and executable by authenticated and service_role only", async () => {
    expect(await rows(db, `select mid_key('  sq7k2m9qx4b1z ') as k, mid_key(null) as n`)).toEqual([
      { k: SQ, n: null },
    ]);
    const [fn] = await rows<{ volatile: string; acl: string }>(
      db,
      `select provolatile as volatile, proacl::text as acl from pg_proc where proname = 'mid_key'`,
    );
    expect(fn.volatile).toBe("i");
    expect(fn.acl).toMatch(/authenticated=X/);
    expect(fn.acl).toMatch(/service_role=X/);
    expect(fn.acl).not.toMatch(/anon=|(^|[{,])=X/);
  });

  it("refuses a second merchant whose MID differs only in case or spaces, as 23505", async () => {
    await merchant(db, SQ);
    for (const other of ["sq7k2m9qx4b1z", "Sq7K2m9Qx4B1z", ` ${SQ} `]) {
      const error = await attempt(db, () => merchant(db, other, OTHER_AGENT_ID));
      expect(error?.code, other).toBe("23505");
      expect(error?.message, other).toMatch(/merchants_mid_key_ci/);
    }
  });

  it("still allows many merchants with no MID", async () => {
    await asPlatform(db);
    await db.exec(`
      insert into merchants (agent_id, mid, dba, city, state) values
        ('${AGENT_ID}', null, 'Invented A', 'Nashville', 'TN'),
        ('${AGENT_ID}', null, 'Invented B', 'Nashville', 'TN')`);
    expect(await rows(db, `select count(*)::int as n from merchants where mid is null and dba like 'Invented _'`)).toEqual([{ n: 2 }]);
  });
});

// -------------------------------------------------------------------------
// 2. Through the real commit
// -------------------------------------------------------------------------

describe("commit_residual_import_v3 matches MIDs by key", () => {
  it("pays a lettered MID written in lower and in mixed case, on a line with the merchant's spelling", async () => {
    const sq = await merchant(db, SQ);
    const other = await merchant(db, "AB12CD34EF56", OTHER_AGENT_ID);
    const { id } = await batchWith(db, ["sq7k2m9qx4b1z", "aB12cD34eF56"]);
    expect(await commitV3(db, id)).toMatchObject({ written: 2, rows: 2 });
    expect(
      await rows(
        db,
        `select mid, merchant_id, agent_id::text as agent, rep_payout::text as payout
           from rep_payout_rows where batch_id = ${id} order by mid`,
      ),
    ).toEqual([
      { mid: "AB12CD34EF56", merchant_id: other, agent: OTHER_AGENT_ID, payout: "50.00" },
      { mid: SQ, merchant_id: sq, agent: AGENT_ID, payout: "50.00" },
    ]);
  });

  it("Report 2 shows the line under the merchant's spelling, once, whatever case the file used", async () => {
    await merchant(db, SQ);
    const { id, period } = await batchWith(db, ["sq7k2m9qx4b1z"]);
    await commitV3(db, id);
    expect(
      await call(
        db,
        `(select jsonb_agg(jsonb_build_object('mid', mid, 'residual', residual::text))
            from merchant_processor_summary('${period}', '${period}', '${PROCESSOR}')
           where row_kind = 'merchant')`,
      ),
    ).toEqual([{ mid: SQ, residual: "100.00" }]);
  });

  it("refuses a MID repeated in another case, naming both spellings and the rows", async () => {
    await merchant(db, SQ);
    const { id } = await batchWith(db, [SQ, "MID-AGENT-1", "sq7k2m9qx4b1z"]);
    const error = await attempt(db, () => commitV3(db, id));
    expect(error?.message).toMatch(
      new RegExp(`A MID appears on more than one row: (${SQ} / sq7k2m9qx4b1z|sq7k2m9qx4b1z / ${SQ}) \\(rows 2, 4\\)`),
    );
    expect(await rows(db, `select count(*)::int as n from rep_payout_rows where batch_id = ${id}`)).toEqual([{ n: 0 }]);
  });

  it("refuses a lettered MID that is not a merchant", async () => {
    const { id } = await batchWith(db, ["ZZ9NOTAMERCH"]);
    expect((await attempt(db, () => commitV3(db, id)))?.message).toMatch(
      /MIDs ZZ9NOTAMERCH are not merchants in the CRM/,
    );
  });

  it("refuses a MID that already has a line this month in another case (no merge)", async () => {
    await merchant(db, SQ);
    const { id, period } = await batchWith(db, ["sq7k2m9qx4b1z"]);
    await db.exec(`insert into rep_payout_rows (agent_id, period, processor, mid, residual_income, rep_split_pct)
                   values ('${OTHER_AGENT_ID}', '${period}', 'Square', '${SQ}', 1.00, 50.00)`);
    expect((await attempt(db, () => commitV3(db, id)))?.message).toMatch(
      /MIDs sq7k2m9qx4b1z already have a line for/,
    );
  });

  it("replaces a month read in another case, and refuses a replace under an adjustment in another case", async () => {
    await merchant(db, SQ);
    const first = await batchWith(db, [SQ]);
    await commitV3(db, first.id);

    const second = await batchWith(db, ["sq7k2m9qx4b1z"], { period: first.period, replaces: first.id });
    expect(await commitV3(db, second.id)).toMatchObject({ written: 1, replaced_lines: 1 });
    expect(await rows(db, `select mid from rep_payout_rows where batch_id = ${second.id}`)).toEqual([{ mid: SQ }]);

    await adjustmentLine(db, first.period, "sq7k2m9qx4b1z");
    const third = await batchWith(db, [SQ], { period: first.period, replaces: second.id });
    expect((await attempt(db, () => commitV3(db, third.id)))?.message).toMatch(
      /Adjustments already correct TSYS for .* \(MIDs sq7k2m9qx4b1z\)/,
    );
  });
});

// -------------------------------------------------------------------------
// 3. The adjustment and the delete
// -------------------------------------------------------------------------

describe("post_payout_adjustment and delete_payout_period", () => {
  it("post_payout_adjustment finds the merchant in any case and writes its spelling", async () => {
    const sq = await merchant(db, SQ);
    const { id, period } = await batchWith(db, [SQ]);
    await commitV3(db, id);
    await close(db, period);
    try {
      await call(
        db,
        `post_payout_adjustment('${AGENT_ID}', ' sq7k2m9qx4b1z ', '${period}', '${PROCESSOR}', -2.50, 'An invented clawback')`,
      );
      expect(
        await rows(db, `select mid, merchant_id from rep_payout_rows where line_kind = 'adjustment'`),
      ).toEqual([{ mid: SQ, merchant_id: sq }]);
    } finally {
      // resetData keeps closures; the next test takes the same free month.
      await reopen(db, period);
    }
  });

  it("delete_payout_period refuses under an adjustment that names the MID in another case", async () => {
    await merchant(db, SQ);
    const { id, period } = await batchWith(db, [SQ]);
    await commitV3(db, id);
    await adjustmentLine(db, period, "sq7k2m9qx4b1z");
    expect(
      (await attempt(db, () => call(db, `delete_payout_period('${period}', '${PROCESSOR}')`)))?.message,
    ).toMatch(/Adjustments already correct .* \(MIDs sq7k2m9qx4b1z\)/);
  });
});

// -------------------------------------------------------------------------
// 4. The migration over existing rows
// -------------------------------------------------------------------------

describe("the migration over existing rows", () => {
  async function before(): Promise<TestDb> {
    const target = await open(await migrationsBefore(MIGRATION));
    await resetData(target);
    return target;
  }

  it("passes over a populated database, writes no row, and adds the index", async () => {
    const target = await before();
    await seedPayouts(target);
    const id = await insertBatch(target);
    await stageForCommit(target, id, [{ mid: "MID-AGENT-1" }]);
    await commitV3(target, id);
    await merchant(target, SQ);
    const fingerprint = () =>
      rows(
        target,
        `select (select md5(string_agg(row(m.*)::text, '|' order by m.id)) from merchants m) as merchants,
                (select md5(string_agg(row(r.*)::text, '|' order by r.id)) from rep_payout_rows r) as ledger,
                (select md5(string_agg(row(b.*)::text, '|' order by b.id)) from rep_payout_batches b) as batches`,
      );
    const was = await fingerprint();
    await target.exec(await readMigration(MIGRATION));
    expect(await fingerprint()).toEqual(was);
    expect(
      await rows(target, `select indexdef from pg_indexes where indexname = 'merchants_mid_key_ci'`),
    ).toEqual([{ indexdef: "CREATE UNIQUE INDEX merchants_mid_key_ci ON public.merchants USING btree (mid_key(mid))" }]);
  });

  it("refuses, naming each, merchants whose MIDs differ only in case or spaces; passes once one is changed", async () => {
    const target = await before();
    const a = await merchant(target, SQ);
    const b = await merchant(target, "sq7k2m9qx4b1z", OTHER_AGENT_ID);
    const c = await merchant(target, "AB12CD34EF56");
    const d = await merchant(target, " AB12CD34EF56", OTHER_AGENT_ID);
    const error = await attempt(target, async () => target.exec(await readMigration(MIGRATION)));
    expect(error?.message).toContain("alphanumeric_mids refuses to run");
    expect(error?.message).toContain(`merchant ${c} (AB12CD34EF56), merchant ${d} ( AB12CD34EF56)`);
    expect(error?.message).toContain(`merchant ${a} (${SQ}), merchant ${b} (sq7k2m9qx4b1z)`);
    expect(await rows(target, `select count(*)::int as n from pg_proc where proname = 'mid_key'`)).toEqual([{ n: 0 }]);

    await target.exec(`update merchants set mid = 'SQ7K2M9QX4B1Y' where id = ${b};
                       update merchants set mid = 'AB12CD34EF57' where id = ${d}`);
    await target.exec(await readMigration(MIGRATION));
    expect(await rows(target, `select count(*)::int as n from pg_proc where proname = 'mid_key'`)).toEqual([{ n: 1 }]);
  });

  it("refuses over a function that is not the body it copied", async () => {
    for (const [name, sig, from, to] of [
      [V3, "(int, text[])", "join merchants m on m.mid = r.mid_raw", "join merchants m on m.mid = btrim(r.mid_raw)"],
      ["delete_payout_period", "(date, text)", "or a.mid in (select l.mid", "or a.mid in (select btrim(l.mid)"],
      [
        "post_payout_adjustment",
        "(uuid, text, date, text, numeric, text)",
        "where mid = btrim(mid_input);",
        "where mid = mid_input;",
      ],
    ] as const) {
      const target = await before();
      const [{ def }] = await rows<{ def: string }>(
        target,
        `select pg_get_functiondef('${name}${sig}'::regprocedure) as def`,
      );
      expect(def, name).toContain(from);
      await target.exec(def.replace(from, to));
      const error = await attempt(target, async () => target.exec(await readMigration(MIGRATION)));
      expect(error?.message, name).toMatch(/is not the body 20261106140000 copied/);
    }
  });

  it("mutation proof: without its guard the migration fails on the index, naming nobody", async () => {
    const target = await before();
    await merchant(target, SQ);
    await merchant(target, "sq7k2m9qx4b1z", OTHER_AGENT_ID);
    const sql = (await readMigration(MIGRATION)).replace(/\r\n/g, "\n");
    const guard = sql.match(/\n {2}if clash is not null then\n[\s\S]*?\n {2}end if;\n/);
    expect(guard).not.toBeNull();
    const error = await attempt(target, async () => target.exec(sql.replace(guard![0], "\n")));
    expect(error?.message).not.toContain("alphanumeric_mids refuses to run");
    expect(error?.message).toMatch(/merchants_mid_key_ci|could not create unique index/);
  });
});

// -------------------------------------------------------------------------
// 5. Mutation proofs: each comparison back to plain equality
// -------------------------------------------------------------------------

describe("mutation proofs: each mid_key comparison is what matches its case", () => {
  let mutant: TestDb;
  const originals = new Map<string, string>();
  const SIGS: Record<string, string> = {
    [V3]: "(int, text[])",
    delete_payout_period: "(date, text)",
    post_payout_adjustment: "(uuid, text, date, text, numeric, text)",
  };

  beforeAll(async () => {
    mutant = await open();
    for (const [name, sig] of Object.entries(SIGS)) {
      const [{ def }] = await rows<{ def: string }>(
        mutant,
        `select pg_get_functiondef('${name}${sig}'::regprocedure) as def`,
      );
      originals.set(name, def);
    }
  });

  beforeEach(async () => {
    await resetData(mutant);
    await asPlatform(mutant);
    for (const def of originals.values()) await mutant.exec(def);
  });

  /** Re-creates `name` with every `fragment` replaced. */
  async function without(name: string, fragment: string, replacement: string): Promise<void> {
    await asPlatform(mutant);
    const def = originals.get(name) as string;
    expect(def, `${name} must contain ${fragment}`).toContain(fragment);
    await mutant.exec(def.split(fragment).join(replacement));
  }

  it("the merchant join: without it a lower-case line is dropped silently", async () => {
    await without(V3, "join merchants m on mid_key(m.mid) = mid_key(r.mid_raw)", "join merchants m on m.mid = r.mid_raw");
    await merchant(mutant, SQ);
    const { id } = await batchWith(mutant, ["sq7k2m9qx4b1z"]);
    expect(await commitV3(mutant, id)).toMatchObject({ written: 0, rows: 1 });
  });

  it("the unknown-MID check: without it a lower-case MID is refused as unknown", async () => {
    await without(
      V3,
      "where mid_key(m.mid) = mid_key(r.mid_raw));",
      "where m.mid = r.mid_raw);",
    );
    await merchant(mutant, SQ);
    const { id } = await batchWith(mutant, ["sq7k2m9qx4b1z"]);
    expect((await attempt(mutant, () => commitV3(mutant, id)))?.message).toMatch(/are not merchants in the CRM/);
  });

  it("the repeated-MID check: without it two spellings reach the ledger's unique index instead", async () => {
    await without(V3, "group by mid_key(r.mid_raw)", "group by r.mid_raw");
    await merchant(mutant, SQ);
    const { id } = await batchWith(mutant, [SQ, "sq7k2m9qx4b1z"]);
    const error = await attempt(mutant, () => commitV3(mutant, id));
    expect(error?.message).not.toMatch(/appears on more than one row/);
  });

  it("the no-merge check: without it a line in another case is merged beside", async () => {
    await without(
      V3,
      "on mid_key(l.mid) = mid_key(r.mid_raw) and l.period",
      "on l.mid = r.mid_raw and l.period",
    );
    await merchant(mutant, SQ);
    const { id, period } = await batchWith(mutant, ["sq7k2m9qx4b1z"]);
    await mutant.exec(`insert into rep_payout_rows (agent_id, period, processor, mid, residual_income, rep_split_pct)
                       values ('${OTHER_AGENT_ID}', '${period}', 'Square', '${SQ}', 1.00, 50.00)`);
    // Another rep's line, so the ledger's unique index is no backstop here.
    expect(await commitV3(mutant, id)).toMatchObject({ written: 1 });
  });

  it("the replace's adjustment check: without it a month is replaced under an adjustment in another case", async () => {
    await without(V3, "or mid_key(a.mid) in (select mid_key(l.mid)", "or a.mid in (select l.mid");
    await merchant(mutant, SQ);
    const first = await batchWith(mutant, [SQ]);
    await commitV3(mutant, first.id);
    await adjustmentLine(mutant, first.period, "sq7k2m9qx4b1z");
    const second = await batchWith(mutant, [SQ], { period: first.period, replaces: first.id });
    expect(await commitV3(mutant, second.id)).toMatchObject({ replaced_lines: 1 });
  });

  it("delete_payout_period's adjustment check: without it the month is deleted under one", async () => {
    await without("delete_payout_period", "or mid_key(a.mid) in (select mid_key(l.mid)", "or a.mid in (select l.mid");
    await merchant(mutant, SQ);
    const { id, period } = await batchWith(mutant, [SQ]);
    await commitV3(mutant, id);
    await adjustmentLine(mutant, period, "sq7k2m9qx4b1z");
    expect(await call(mutant, `delete_payout_period('${period}', '${PROCESSOR}')`)).toMatchObject({ deleted: 1 });
  });

  it("post_payout_adjustment's lookup: without it a lower-case MID is not a merchant", async () => {
    await without(
      "post_payout_adjustment",
      "where mid_key(mid) = mid_key(mid_input);",
      "where mid = btrim(mid_input);",
    );
    await merchant(mutant, SQ);
    const { id, period } = await batchWith(mutant, [SQ]);
    await commitV3(mutant, id);
    await close(mutant, period);
    const error = await attempt(mutant, () =>
      call(mutant, `post_payout_adjustment('${AGENT_ID}', 'sq7k2m9qx4b1z', '${period}', '${PROCESSOR}', -1.00, 'Invented')`),
    );
    await reopen(mutant, period);
    expect(error?.message).toMatch(/is not a merchant in the CRM/);
  });
});
