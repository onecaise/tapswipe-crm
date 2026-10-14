import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_ID,
  AGENT_ID,
  OTHER_AGENT_ID,
  asPlatform,
  asUser,
  createTestDb,
  readMigration,
  resetData,
  rows,
  seedPayouts,
  type TestDb,
} from "../helpers/db";

/**
 * The shared branch of rep_payout_rows (20261014140000; phase 3 of
 * docs/design/residual-splits.md).
 *
 * A shared account is two ledger lines in a month, the signer's and the
 * partner's, each carrying the account residual and the share snapshot. What
 * this file pins:
 *
 *   * the cent rule THROUGH THE GENERATED COLUMN: signer + partner payout =
 *     round(account residual x rate / 100, 2), what one rep alone would get,
 *     for every cent from -$20.00 to $20.00 at three ratios;
 *   * set_shared_residual() is the one way to set the residual, and sets both
 *     lines in one statement;
 *   * the partner's rate copies the signer's -- set on the signer's line, it
 *     lands on both;
 *   * the guard refuses hand-editing one piece of a pair, the partner's rate,
 *     or any share column, while ordinary lines edit exactly as before;
 *   * each line proves its own residual piece (a CHECK), the share snapshot
 *     totals 50, adjustment lines pay their amount;
 *   * a share with lines cannot be deleted; each rep reads only their line.
 *
 * Nothing creates shared lines yet (the commit does that from phase 4), so
 * the fixture inserts the pair as the owner -- exactly the INSERT the commit
 * will perform, which the guard does not cover (it is BEFORE UPDATE).
 */

const THIRD_AGENT_ID = "44444444-4444-4444-4444-444444444444";
const SHARED_MONTH = "2026-08-01";

type DbError = { code?: string; message: string };

type Line = {
  agent_id: string;
  share_role: string | null;
  residual_income: string | null;
  account_residual_income: string | null;
  rep_split_pct: string | null;
  rep_payout: string | null;
};

let db: TestDb;
let shareId: number;

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
    insert into auth.users (id, email) values ('${THIRD_AGENT_ID}', 'third@tapswipe.test');
    insert into profiles (id, full_name, role, is_active)
    values ('${THIRD_AGENT_ID}', 'Third Agent', 'agent', true);
  `);

  // A 40 + 10 share on MID-AGENT-2 (nothing committed for it), signer AGENT,
  // partner THIRD, through the RPC.
  await asUser(db, ADMIN_ID);
  const [{ id }] = await rows<{ id: number }>(
    db,
    `select set_merchant_rep_share(
       (select id from merchants where mid = 'MID-AGENT-2'),
       '${AGENT_ID}', '${THIRD_AGENT_ID}', 40, 10, '${SHARED_MONTH}') as id`,
  );
  shareId = id;

  // The pair, as the phase 4 commit will write it: no residual, no rate yet.
  await asPlatform(db);
  await insertPair("MID-AGENT-2", SHARED_MONTH);
  await db.exec(`delete from audit_log; delete from rep_payout_row_history;`);
});

async function insertPair(mid: string, period: string): Promise<void> {
  const id = shareId;
  await asPlatform(db);
  await db.exec(`
    insert into rep_payout_rows
      (agent_id, period, mid, merchant_name, merchant_id, volume,
       rep_share_id, share_role, primary_rep_pct, secondary_rep_pct)
    values
      ('${AGENT_ID}', '${period}', '${mid}', 'Shared Co',
        (select id from merchants where mid = '${mid}'), 5100.00,
        ${id}, 'primary', 40, 10),
      ('${THIRD_AGENT_ID}', '${period}', '${mid}', 'Shared Co',
        (select id from merchants where mid = '${mid}'), null,
        ${id}, 'secondary', 40, 10);
  `);
}

async function pair(period = SHARED_MONTH): Promise<{ signer: Line; partner: Line }> {
  await asPlatform(db);
  const lines = await rows<Line>(
    db,
    `select agent_id, share_role, residual_income::text, account_residual_income::text,
            rep_split_pct::text, rep_payout::text
       from rep_payout_rows
      where rep_share_id = ${shareId} and period = '${period}'
      order by share_role`,
  );
  const signer = lines.find((line) => line.share_role === "primary");
  const partner = lines.find((line) => line.share_role === "secondary");
  if (!signer || !partner) throw new Error("fixture pair missing");
  return { signer, partner };
}

async function attempt(userId: string | null, sql: string): Promise<DbError | null> {
  await asUser(db, userId);
  try {
    await db.query(sql);
    return null;
  } catch (error) {
    return error as DbError;
  } finally {
    await asPlatform(db);
  }
}

async function setResidual(amount: string): Promise<void> {
  await asUser(db, ADMIN_ID);
  await db.query(`select set_shared_residual(${shareId}, '${SHARED_MONTH}', ${amount})`);
  await asPlatform(db);
}

async function setSignerRate(rate: string): Promise<void> {
  await asUser(db, ADMIN_ID);
  await db.query(
    `update rep_payout_rows set rep_split_pct = ${rate}
      where rep_share_id = ${shareId} and period = '${SHARED_MONTH}' and share_role = 'primary'`,
  );
  await asPlatform(db);
}

describe("set_shared_residual and the generated payout", () => {
  it("divides the account residual 40:10 and pays both lines from the solo payout", async () => {
    await setResidual("100.01");
    await setSignerRate("50");

    const { signer, partner } = await pair();
    // Residual pieces: partner gets the nearest cent to 100.01 x 10/50 = 20.002.
    expect([signer.residual_income, partner.residual_income]).toEqual(["80.01", "20.00"]);
    expect([signer.account_residual_income, partner.account_residual_income]).toEqual([
      "100.01",
      "100.01",
    ]);
    // Payout: solo is round(100.01 x 50%) = 50.01; partner 10.00 (10.002), signer 40.01.
    expect([signer.rep_payout, partner.rep_payout]).toEqual(["40.01", "10.00"]);
  });

  it("divides a negative month as the mirror of a positive one", async () => {
    await setResidual("-100.01");
    await setSignerRate("50");
    const { signer, partner } = await pair();
    expect([signer.residual_income, partner.residual_income]).toEqual(["-80.01", "-20.00"]);
    expect([signer.rep_payout, partner.rep_payout]).toEqual(["-40.01", "-10.00"]);
  });

  it("clears both lines with NULL — 'not worked out yet' on both", async () => {
    await setResidual("100.01");
    await setSignerRate("50");
    await setResidual("null");
    const { signer, partner } = await pair();
    expect([signer.residual_income, partner.residual_income]).toEqual([null, null]);
    expect([signer.account_residual_income, partner.account_residual_income]).toEqual([null, null]);
    expect([signer.rep_payout, partner.rep_payout]).toEqual([null, null]);
  });

  it("records each line's change in the history, attributed to the admin", async () => {
    await setResidual("100.01");
    const history = await rows<{ agent_id: string; field: string; new_value: string; changed_by: string }>(
      db,
      `select agent_id, field, new_value::text, changed_by
         from rep_payout_row_history order by agent_id`,
    );
    expect(history).toEqual([
      { agent_id: AGENT_ID, field: "residual_income", new_value: "80.01", changed_by: ADMIN_ID },
      { agent_id: THIRD_AGENT_ID, field: "residual_income", new_value: "20.00", changed_by: ADMIN_ID },
    ]);
  });

  it.each([
    ["an agent", AGENT_ID, "PT403"],
    ["the partner", THIRD_AGENT_ID, "PT403"],
  ])("refuses %s with PT403", async (_label, caller, code) => {
    const error = await attempt(caller, `select set_shared_residual(${shareId}, '${SHARED_MONTH}', 1.00)`);
    expect(error?.code).toBe(code);
    expect((await pair()).signer.account_residual_income).toBeNull();
  });

  it("refuses a month with no pair (PT404) and a fraction of a cent (22023)", async () => {
    expect((await attempt(ADMIN_ID, `select set_shared_residual(${shareId}, '2026-09-01', 1.00)`))?.code).toBe("PT404");
    expect((await attempt(ADMIN_ID, `select set_shared_residual(${shareId}, '${SHARED_MONTH}', 1.005)`))?.code).toBe("22023");
  });
});

describe("the cent rule through the generated column", () => {
  it("signer + partner payout = round(R x 50 / 100, 2) for every cent from -$20.00 to $20.00 at three ratios", async () => {
    await asPlatform(db);
    // One pair per (cent, ratio), each pair its own MID; pieces computed by
    // shared_part exactly as set_shared_residual does, which the CHECK enforces.
    for (const [a, b] of [["25", "25"], ["40", "10"], ["33.33", "16.67"]]) {
      await db.exec(`
        insert into rep_payout_rows
          (agent_id, period, mid, rep_share_id, share_role, primary_rep_pct, secondary_rep_pct,
           account_residual_income, residual_income, rep_split_pct)
        select agent, '2026-09-01', 'GRID-${a}-' || g, ${shareId}, role, ${a}, ${b}, r,
               case role when 'secondary' then shared_part(r, ${b}, 50)
                         else r - shared_part(r, ${b}, 50) end,
               50.00
          from (select g, (g * 0.01)::numeric(14,2) as r from generate_series(-2000, 2000) g) amounts
         cross join (values ('${AGENT_ID}'::uuid, 'primary'), ('${THIRD_AGENT_ID}'::uuid, 'secondary')) as p(agent, role);
      `);
    }

    const [result] = await rows<{ pairs: number; wrong: number; ties: number }>(
      db,
      `with pairs as (
         select mid,
                max(account_residual_income) as r,
                sum(rep_payout) as paid,
                count(*) as lines
           from rep_payout_rows where mid like 'GRID-%' group by mid
       )
       select count(*)::int as pairs,
              count(*) filter (where lines <> 2 or paid <> round(r * 50.00 / 100, 2))::int as wrong,
              count(*) filter (where mod(abs(r * 50.00), 1) = 0.5)::int as ties
         from pairs`,
    );
    expect(result.pairs).toBe(4001 * 3);
    expect(result.wrong).toBe(0);
    // Non-vacuous: solo payouts that land on a half-cent are in the grid.
    expect(result.ties).toBeGreaterThan(1000);
  });
});

describe("the partner's rate copies the signer's", () => {
  it("setting the signer's rate sets the partner's, with a history row each", async () => {
    await setSignerRate("50");
    const { signer, partner } = await pair();
    expect([signer.rep_split_pct, partner.rep_split_pct]).toEqual(["50.00", "50.00"]);

    const history = await rows<{ agent_id: string; field: string; new_value: string; changed_by: string }>(
      db,
      `select agent_id, field, new_value::text, changed_by
         from rep_payout_row_history order by agent_id`,
    );
    expect(history).toEqual([
      { agent_id: AGENT_ID, field: "rep_split_pct", new_value: "50.00", changed_by: ADMIN_ID },
      { agent_id: THIRD_AGENT_ID, field: "rep_split_pct", new_value: "50.00", changed_by: ADMIN_ID },
    ]);
  });

  it("follows every later change, including back to blank", async () => {
    await setSignerRate("50");
    await setSignerRate("45.5");
    expect((await pair()).partner.rep_split_pct).toBe("45.50");
    await setSignerRate("null");
    expect((await pair()).partner.rep_split_pct).toBeNull();
  });

  it("leaves the shared-write flag as it found it", async () => {
    await setSignerRate("50");
    const [{ flag }] = await rows<{ flag: string | null }>(
      db,
      `select current_setting('tapswipe.shared_write', true) as flag`,
    );
    expect(flag === null || flag === "").toBe(true);
  });
});

describe("the guard: a pair is edited together or not at all", () => {
  it.each([
    [
      "the signer's residual piece",
      `update rep_payout_rows set residual_income = 99.00 where share_role = 'primary'`,
      /Set its total residual on the signer's line/,
    ],
    [
      "the partner's residual piece",
      `update rep_payout_rows set residual_income = 99.00 where share_role = 'secondary'`,
      /Set its total residual on the signer's line/,
    ],
    [
      "the partner's rate",
      `update rep_payout_rows set rep_split_pct = 60 where share_role = 'secondary'`,
      /rate always copies the signer's/,
    ],
    [
      "the account residual directly",
      `update rep_payout_rows set account_residual_income = 1.00 where share_role = 'primary'`,
      /set by their own functions/,
    ],
    [
      "the share snapshot",
      `update rep_payout_rows set primary_rep_pct = 45, secondary_rep_pct = 5 where rep_share_id is not null`,
      /set by their own functions/,
    ],
    [
      "a line's role",
      `update rep_payout_rows set share_role = 'primary' where share_role = 'secondary'`,
      /set by their own functions/,
    ],
  ])("refuses an admin hand-editing %s (PT409)", async (_label, sql, message) => {
    await setResidual("100.01");
    await setSignerRate("50");
    const before = await pair();
    const error = await attempt(ADMIN_ID, sql);
    expect(error?.code).toBe("PT409");
    expect(error?.message).toMatch(message);
    expect(await pair()).toEqual(before);
  });

  it("refuses turning an ordinary line into a shared or adjustment one", async () => {
    for (const sql of [
      `update rep_payout_rows set rep_share_id = ${shareId}, share_role = 'primary',
              primary_rep_pct = 40, secondary_rep_pct = 10 where mid = 'MID-UNMATCHED'`,
      `update rep_payout_rows set line_kind = 'adjustment', adjustment_amount = 5,
              adjusts_period = '2026-06-01' where mid = 'MID-UNMATCHED'`,
    ]) {
      const error = await attempt(ADMIN_ID, sql);
      expect(error?.code).toBe("PT409");
    }
  });

  it("changes nothing for an ordinary line: the inline edit works exactly as before", async () => {
    await asUser(db, ADMIN_ID);
    const result = await db.query(
      `update rep_payout_rows set residual_income = 91.00, rep_split_pct = 55
        where mid = 'MID-AGENT-1' and period = '2026-07-01'`,
    );
    expect(result.affectedRows).toBe(1);
    await asPlatform(db);
    const [row] = await rows<{ rep_payout: string }>(
      db,
      `select rep_payout::text from rep_payout_rows where mid = 'MID-AGENT-1' and period = '2026-07-01'`,
    );
    expect(row.rep_payout).toBe("50.05");
  });
});

describe("constraints every writer meets, the commit included", () => {
  async function ownerInsert(sql: string): Promise<DbError | null> {
    await asPlatform(db);
    try {
      await db.query(sql);
      return null;
    } catch (error) {
      return error as DbError;
    }
  }

  it("refuses a shared line whose residual piece does not follow from the account figure", async () => {
    const error = await ownerInsert(`
      insert into rep_payout_rows (agent_id, period, mid, rep_share_id, share_role,
        primary_rep_pct, secondary_rep_pct, account_residual_income, residual_income)
      values ('${AGENT_ID}', '2026-10-01', 'PIECE', ${shareId}, 'primary', 40, 10, 100.00, 50.00)`);
    expect(error?.code).toBe("23514");
    expect(error?.message).toContain("rep_payout_rows_shared_piece");
  });

  it("refuses an account figure without a piece, and a piece without an account figure", async () => {
    for (const [account, piece] of [["100.00", "null"], ["null", "80.00"]]) {
      const error = await ownerInsert(`
        insert into rep_payout_rows (agent_id, period, mid, rep_share_id, share_role,
          primary_rep_pct, secondary_rep_pct, account_residual_income, residual_income)
        values ('${AGENT_ID}', '2026-10-01', 'HALF', ${shareId}, 'primary', 40, 10, ${account}, ${piece})`);
      expect(error?.code, `${account} / ${piece}`).toBe("23514");
    }
  });

  it("refuses share columns that do not come as a set, and a snapshot not totalling 50", async () => {
    expect(
      (await ownerInsert(`
        insert into rep_payout_rows (agent_id, period, mid, rep_share_id)
        values ('${AGENT_ID}', '2026-10-01', 'PARTIAL', ${shareId})`))?.message,
    ).toContain("rep_payout_rows_share_columns_together");
    expect(
      (await ownerInsert(`
        insert into rep_payout_rows (agent_id, period, mid, rep_share_id, share_role,
          primary_rep_pct, secondary_rep_pct)
        values ('${AGENT_ID}', '2026-10-01', 'SIXTY', ${shareId}, 'primary', 40, 20)`))?.message,
    ).toContain("rep_payout_rows_share_snapshot");
  });

  it("refuses any adjustment line until phase 5, even a well-formed one, and keeps adjustment columns off import lines", async () => {
    // Every adjustment column valid; only rep_payout_rows_import_lines_only
    // objects. Run as the owner, which holds every privilege and is what the
    // definer commit runs as -- so no writer gets past it.
    const error = await ownerInsert(`
      insert into rep_payout_rows (agent_id, period, mid, line_kind,
        adjustment_amount, adjusts_period, adjustment_note)
      values ('${THIRD_AGENT_ID}', '2026-10-01', 'ADJ', 'adjustment', 12.34, '2026-07-01', 'test')`);
    expect(error?.code).toBe("23514");
    expect(error?.message).toContain("rep_payout_rows_import_lines_only");

    expect(
      (await ownerInsert(`
        insert into rep_payout_rows (agent_id, period, mid, adjustment_amount)
        values ('${AGENT_ID}', '2026-10-01', 'NOTADJ', 1.00)`))?.message,
    ).toContain("rep_payout_rows_adjustment_columns");
  });

  it("refuses deleting a share that ledger lines name (ON DELETE RESTRICT)", async () => {
    const error = await ownerInsert(`delete from merchant_rep_shares where id = ${shareId}`);
    // The SQLSTATE depends on the server version, so the CONSTRAINT NAME is
    // what is pinned. Postgres 18 (PGlite 0.5.4 is 18.3) reports an ON DELETE
    // RESTRICT violation as 23001 restrict_violation; Postgres 17 (the local
    // stack, 17.6) reports the same refusal as 23503 foreign_key_violation.
    // Measured on both, 14 Oct 2026.
    expect(["23001", "23503"]).toContain(error?.code);
    expect(error?.message).toContain("rep_payout_rows_rep_share_id_fkey");
  });
});

describe("the adjustment branch, against a scratch table built from the migration's text", () => {
  /**
   * rep_payout_rows_import_lines_only refuses every adjustment line until
   * phase 5, so the real table cannot hold one and the branch would otherwise
   * ship untested. This builds a temp table whose rep_payout is the expression
   * text COPIED OUT OF 20261014140000 -- not retyped -- over columns typed
   * exactly as the real ones, with none of the real table's CHECKs, and runs
   * the branch there. The deparsed expression is then compared with the live
   * column's, so the copy cannot drift from what the database actually runs.
   */
  const INPUT_COLUMNS = [
    "line_kind",
    "adjustment_amount",
    "share_role",
    "residual_income",
    "rep_split_pct",
    "account_residual_income",
    "primary_rep_pct",
    "secondary_rep_pct",
    "rep_payout",
  ];

  async function expressionFromMigration(): Promise<string> {
    const sql = await readMigration("20261014140000_shared_lines.sql");
    const match = sql.match(
      /add column rep_payout numeric\(14,2\) generated always as \(\n([\s\S]*?)\n {2}\) stored;/,
    );
    if (!match) throw new Error("rep_payout expression not found in 20261014140000");
    return match[1];
  }

  async function createScratch(): Promise<void> {
    await asPlatform(db);
    const types = await rows<{ name: string; type: string }>(
      db,
      `select attname as name, format_type(atttypid, atttypmod) as type
         from pg_attribute
        where attrelid = 'rep_payout_rows'::regclass
          and attname = any(array[${INPUT_COLUMNS.map((c) => `'${c}'`).join(", ")}])`,
    );
    expect(types).toHaveLength(INPUT_COLUMNS.length);
    const typeOf = (name: string) => types.find((t) => t.name === name)!.type;
    const inputs = INPUT_COLUMNS.filter((c) => c !== "rep_payout")
      .map((c) => `${c} ${typeOf(c)}`)
      .join(",\n  ");
    await db.exec(`
      drop table if exists adjustment_scratch;
      create temp table adjustment_scratch (
        label text primary key,
        ${inputs},
        rep_payout ${typeOf("rep_payout")} generated always as (
${await expressionFromMigration()}
        ) stored
      );
    `);
  }

  it("is the live column's expression, character for character once deparsed", async () => {
    await createScratch();
    const [result] = await rows<{ live: string; scratch: string }>(
      db,
      `select (select pg_get_expr(d.adbin, d.adrelid) from pg_attrdef d
                 join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
                where d.adrelid = 'rep_payout_rows'::regclass and a.attname = 'rep_payout') as live,
              (select pg_get_expr(d.adbin, d.adrelid) from pg_attrdef d
                 join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
                where d.adrelid = 'adjustment_scratch'::regclass and a.attname = 'rep_payout') as scratch`,
    );
    expect(result.live).toContain("adjustment_amount");
    expect(result.scratch).toBe(result.live);
  });

  it("pays exactly the stored amount: negative, blank, half-cent, zero", async () => {
    await createScratch();
    // Every adjustment row also carries a residual and a rate that the
    // unshared branch would turn into 50.00, and one carries a share role, so
    // a branch that fell through to either would show here.
    await db.exec(`
      insert into adjustment_scratch
        (label, line_kind, adjustment_amount, share_role, residual_income, rep_split_pct,
         account_residual_income, primary_rep_pct, secondary_rep_pct)
      values
        ('negative',          'adjustment', -12.34,  null, 100.00, 50.00, null, null, null),
        ('blank',             'adjustment', null,    null, 100.00, 50.00, null, null, null),
        ('half-cent up',      'adjustment', 12.345,  null, 100.00, 50.00, null, null, null),
        ('half-cent down',    'adjustment', -12.345, null, 100.00, 50.00, null, null, null),
        ('half-cent small',   'adjustment', 0.005,   null, 100.00, 50.00, null, null, null),
        ('zero',              'adjustment', 0,       null, 100.00, 50.00, null, null, null),
        ('shared-looking',    'adjustment', 7.00,    'secondary', 100.00, 50.00, 100.00, 40, 10),
        -- Control: the same inputs as an import line take the unshared branch.
        ('import control',    'import',     null,    null, 100.00, 50.00, null, null, null);
    `);

    const result = await rows<{ label: string; amount: string | null; rep_payout: string | null }>(
      db,
      `select label, adjustment_amount::text as amount, rep_payout::text
         from adjustment_scratch order by label`,
    );
    expect(result).toEqual([
      { label: "blank", amount: null, rep_payout: null },
      // numeric(14,2) rounds half away from zero on the way IN; the branch
      // then pays the stored cents and adds no rounding of its own.
      { label: "half-cent down", amount: "-12.35", rep_payout: "-12.35" },
      { label: "half-cent small", amount: "0.01", rep_payout: "0.01" },
      { label: "half-cent up", amount: "12.35", rep_payout: "12.35" },
      { label: "import control", amount: null, rep_payout: "50.00" },
      { label: "negative", amount: "-12.34", rep_payout: "-12.34" },
      { label: "shared-looking", amount: "7.00", rep_payout: "7.00" },
      // Zero pays zero -- not NULL, which would read as "not worked out yet".
      { label: "zero", amount: "0.00", rep_payout: "0.00" },
    ]);
  });
});

describe("each rep reads only their own line", () => {
  it("the signer sees the signer's line, the partner the partner's, a third rep neither", async () => {
    await setResidual("100.01");
    await setSignerRate("50");
    for (const [caller, expected] of [
      [AGENT_ID, ["primary"]],
      [THIRD_AGENT_ID, ["secondary"]],
      [OTHER_AGENT_ID, []],
    ] as [string, string[]][]) {
      await asUser(db, caller);
      const lines = await rows<{ share_role: string }>(
        db,
        `select share_role from rep_payout_rows where rep_share_id is not null order by share_role`,
      );
      expect(lines.map((line) => line.share_role), caller).toEqual(expected);
    }
    await asPlatform(db);
  });
});

describe("catalog and privileges", () => {
  it("set_shared_residual is security definer, guarded first, locked, not for anon", async () => {
    await asPlatform(db);
    const sig = "set_shared_residual(int, date, numeric)";
    const [fn] = await rows<{ prosecdef: boolean; body: string; auth: boolean; anon: boolean }>(
      db,
      `select prosecdef, prosrc as body,
              has_function_privilege('authenticated', '${sig}', 'execute') as auth,
              has_function_privilege('anon', '${sig}', 'execute') as anon
         from pg_proc where oid = '${sig}'::regprocedure`,
    );
    expect(fn.prosecdef).toBe(true);
    expect(fn.body.trimStart()).toMatch(/^declare[\s\S]*?begin\s+if not is_admin\(\) then/);
    expect(fn.body).toContain("pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'))");
    expect(fn.auth).toBe(true);
    expect(fn.anon).toBe(false);
  });

  it("the two trigger functions are executable by nobody signed in", async () => {
    await asPlatform(db);
    for (const sig of ["guard_shared_line()", "copy_signer_rate_to_partner()"]) {
      const [row] = await rows<{ auth: boolean; anon: boolean }>(
        db,
        `select has_function_privilege('authenticated', '${sig}', 'execute') as auth,
                has_function_privilege('anon', '${sig}', 'execute') as anon`,
      );
      expect(row, sig).toEqual({ auth: false, anon: false });
    }
  });
});
