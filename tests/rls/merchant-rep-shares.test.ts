import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_ID,
  AGENT_ID,
  OTHER_AGENT_ID,
  asPlatform,
  asUser,
  createTestDb,
  resetData,
  rows,
  seedPayouts,
  type TestDb,
} from "../helpers/db";

/**
 * merchant_rep_shares and its three write RPCs (20261014130000; phase 2 of
 * docs/design/residual-splits.md).
 *
 * The table records that two reps divide one account's 50-point rep side.
 * Nothing reads it yet — the commit applies it from phase 4 — so what is
 * tested here is the table's own guarantees:
 *
 *   * only an admin can read it, and nobody writes it except through the RPCs;
 *   * two different reps, shares above zero totalling exactly 50;
 *   * no two shares on one merchant overlap;
 *   * the MONTH RULE: no start, end or cancellation at or before a month
 *     already committed for that merchant's MID, so a share edit can never move
 *     a committed figure.
 *
 * All three RPCs are `security definer`, so every one of those rules on the
 * write path is a guard written by hand — the tests below assert each one
 * separately, because a guard deleted from a definer function fails open
 * without a sound. The table's CHECKs and exclusion constraint are asserted
 * separately as owner, because they are the backstop that holds even for a
 * writer that skips the RPCs.
 *
 * Ledger fixture (seedPayouts): MID-AGENT-1 is committed for June and July
 * 2026; MID-OTHER-1 for July; MID-AGENT-2 and MID-OTHER-2 have nothing
 * committed (MID-AGENT-2 is only staged in a review batch, which does not
 * count).
 */

const THIRD_AGENT_ID = "44444444-4444-4444-4444-444444444444";
const GONE_AGENT_ID = "55555555-5555-5555-5555-555555555555";
const MISSING_ID = "66666666-6666-6666-6666-666666666666";

type DbError = { code?: string; message: string };

type ShareRow = {
  id: number;
  merchant_id: number;
  primary_agent_id: string;
  secondary_agent_id: string;
  primary_rep_pct: string;
  secondary_rep_pct: string;
  effective_from: string;
  effective_to: string | null;
};

type AuditRow = {
  actor_id: string | null;
  action: string;
  table_name: string;
  row_id: string;
};

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  // resetData truncates profiles and merchants with CASCADE, which reaches
  // merchant_rep_shares through both of its foreign keys.
  await resetData(db);
  await seedPayouts(db);
  await asPlatform(db);
  await db.exec(`
    insert into auth.users (id, email) values
      ('${THIRD_AGENT_ID}', 'third@tapswipe.test'),
      ('${GONE_AGENT_ID}', 'gone@tapswipe.test');
    insert into profiles (id, full_name, role, is_active) values
      ('${THIRD_AGENT_ID}', 'Third Agent', 'agent', true),
      ('${GONE_AGENT_ID}', 'Gone Agent', 'agent', false);
    delete from audit_log;
  `);
});

async function merchantId(mid: string): Promise<number> {
  await asPlatform(db);
  const [row] = await rows<{ id: number }>(
    db,
    `select id from merchants where mid = '${mid}'`,
  );
  return row.id;
}

/** Runs one statement as `userId`; returns the error, or null if it succeeded. */
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

function setSql(
  merchant: number,
  primary: string,
  secondary: string,
  a: string,
  b: string,
  from: string,
): string {
  return `select set_merchant_rep_share(${merchant}, '${primary}', '${secondary}', ${a}, ${b}, '${from}')`;
}

/** Sets a share as the admin and returns its id; fails the test if refused. */
async function setShare(
  mid: string,
  from: string,
  a = "25",
  b = "25",
  primary = AGENT_ID,
  secondary = THIRD_AGENT_ID,
): Promise<number> {
  const merchant = await merchantId(mid);
  await asUser(db, ADMIN_ID);
  const [{ id }] = await rows<{ id: number }>(
    db,
    `select set_merchant_rep_share(${merchant}, '${primary}', '${secondary}', ${a}, ${b}, '${from}') as id`,
  );
  await asPlatform(db);
  return id;
}

async function shares(): Promise<ShareRow[]> {
  await asPlatform(db);
  return rows<ShareRow>(
    db,
    `select id, merchant_id, primary_agent_id, secondary_agent_id,
            primary_rep_pct::text, secondary_rep_pct::text,
            effective_from::text, effective_to::text
       from merchant_rep_shares order by id`,
  );
}

async function audit(): Promise<AuditRow[]> {
  await asPlatform(db);
  return rows<AuditRow>(
    db,
    `select actor_id, action, table_name, row_id from audit_log order by id`,
  );
}

/** Puts a ledger row in place, standing in for a month committed for a MID. */
async function commitMonth(
  mid: string,
  period: string,
  { linkMerchant = true }: { linkMerchant?: boolean } = {},
): Promise<void> {
  await asPlatform(db);
  await db.exec(`
    insert into rep_payout_rows (agent_id, period, mid, merchant_name, merchant_id)
    values ('${AGENT_ID}', '${period}', '${mid}', 'Fixture',
            ${linkMerchant ? `(select id from merchants where mid = '${mid}')` : "null"});
  `);
}

describe("set_merchant_rep_share", () => {
  it("stores the shares exactly as the admin typed them, in rep-percent terms", async () => {
    const id = await setShare("MID-AGENT-2", "2026-08-01", "40", "10");
    expect(await shares()).toEqual([
      {
        id,
        merchant_id: await merchantId("MID-AGENT-2"),
        primary_agent_id: AGENT_ID,
        secondary_agent_id: THIRD_AGENT_ID,
        primary_rep_pct: "40.00",
        secondary_rep_pct: "10.00",
        effective_from: "2026-08-01",
        effective_to: null,
      },
    ]);
  });

  it("accepts hundredths that total 50 exactly: 33.33 + 16.67", async () => {
    await setShare("MID-AGENT-2", "2026-08-01", "33.33", "16.67");
    const [row] = await shares();
    expect([row.primary_rep_pct, row.secondary_rep_pct]).toEqual(["33.33", "16.67"]);
  });

  it("writes one audit_log row naming the admin", async () => {
    const id = await setShare("MID-AGENT-2", "2026-08-01");
    expect(await audit()).toEqual([
      {
        actor_id: ADMIN_ID,
        action: "set_merchant_rep_share",
        table_name: "merchant_rep_shares",
        row_id: String(id),
      },
    ]);
  });

  it.each([
    ["an agent", AGENT_ID],
    ["the other agent", OTHER_AGENT_ID],
    ["an unauthenticated caller", null],
  ])("refuses %s with PT403 and writes nothing", async (_label, caller) => {
    const merchant = await merchantId("MID-AGENT-2");
    const error = await attempt(
      caller,
      setSql(merchant, AGENT_ID, THIRD_AGENT_ID, "25", "25", "2026-08-01"),
    );
    expect(error?.code).toBe("PT403");
    expect(await shares()).toEqual([]);
    expect(await audit()).toEqual([]);
  });

  it("refuses a deactivated admin — a valid JWT is not an enabled account", async () => {
    await asPlatform(db);
    await db.exec(`update profiles set is_active = false where id = '${ADMIN_ID}'`);
    const merchant = await merchantId("MID-AGENT-2");
    const error = await attempt(
      ADMIN_ID,
      setSql(merchant, AGENT_ID, THIRD_AGENT_ID, "25", "25", "2026-08-01"),
    );
    expect(error?.code).toBe("PT403");
    expect(await shares()).toEqual([]);
  });

  it("refuses the same rep on both sides", async () => {
    const merchant = await merchantId("MID-AGENT-2");
    const error = await attempt(
      ADMIN_ID,
      setSql(merchant, AGENT_ID, AGENT_ID, "25", "25", "2026-08-01"),
    );
    expect(error?.code).toBe("22023");
    expect(error?.message).toMatch(/two different reps/);
    expect(await shares()).toEqual([]);
  });

  it.each([
    ["30 + 30 (60, over the rep side)", "30", "30"],
    ["25 + 24.99 (49.99, a cent short)", "25", "24.99"],
    ["50 + 0 (the partner gets nothing)", "50", "0"],
    ["50.01 + -0.01 (a negative share)", "50.01", "-0.01"],
    ["24.995 + 25.005 (finer than a hundredth)", "24.995", "25.005"],
  ])("refuses shares of %s: they must each be above 0 and total exactly 50", async (_label, a, b) => {
    const merchant = await merchantId("MID-AGENT-2");
    const error = await attempt(
      ADMIN_ID,
      setSql(merchant, AGENT_ID, THIRD_AGENT_ID, a, b, "2026-08-01"),
    );
    expect(error?.code).toBe("22023");
    expect(error?.message).toMatch(/add up to the rep side: 50/);
    expect(await shares()).toEqual([]);
  });

  it("refuses a start that is not the first of a month", async () => {
    const merchant = await merchantId("MID-AGENT-2");
    const error = await attempt(
      ADMIN_ID,
      setSql(merchant, AGENT_ID, THIRD_AGENT_ID, "25", "25", "2026-08-15"),
    );
    expect(error?.code).toBe("22023");
  });

  describe("the month rule: never at or before a committed month", () => {
    it.each([
      ["the latest committed month itself", "2026-07-01"],
      ["an earlier committed month", "2026-06-01"],
      ["a month before anything was committed", "2026-01-01"],
    ])("refuses a start at %s", async (_label, from) => {
      // MID-AGENT-1 is committed for June and July 2026.
      const merchant = await merchantId("MID-AGENT-1");
      const error = await attempt(
        ADMIN_ID,
        setSql(merchant, AGENT_ID, THIRD_AGENT_ID, "25", "25", from),
      );
      expect(error?.code).toBe("PT409");
      expect(error?.message).toMatch(/July 2026 is already committed/);
      expect(await shares()).toEqual([]);
    });

    it("allows the first month after the latest committed one", async () => {
      await setShare("MID-AGENT-1", "2026-08-01");
      expect(await shares()).toHaveLength(1);
    });

    it("counts a month committed by MID alone, where the ledger row matched no merchant", async () => {
      // merchant_id on a ledger row is the soft link resolved at parse time; a
      // row whose MID matched nothing still means that month is paid.
      await commitMonth("MID-AGENT-2", "2026-09-01", { linkMerchant: false });
      const merchant = await merchantId("MID-AGENT-2");
      const error = await attempt(
        ADMIN_ID,
        setSql(merchant, AGENT_ID, THIRD_AGENT_ID, "25", "25", "2026-09-01"),
      );
      expect(error?.code).toBe("PT409");
      await setShare("MID-AGENT-2", "2026-10-01");
    });

    it("does not count a month that is only staged in a batch under review", async () => {
      // seedPayouts stages MID-AGENT-2 for July in a review batch. Nothing is
      // in the ledger for it, so July is still open.
      await setShare("MID-AGENT-2", "2026-07-01");
      expect(await shares()).toHaveLength(1);
    });
  });

  it("refuses a merchant with no MID — no residual could ever match it", async () => {
    await asPlatform(db);
    await db.exec(`update merchants set mid = null where mid = 'MID-OTHER-2'`);
    const [{ id }] = await rows<{ id: number }>(
      db,
      `select id from merchants where dba = 'Other Other Co'`,
    );
    const error = await attempt(
      ADMIN_ID,
      setSql(id, OTHER_AGENT_ID, THIRD_AGENT_ID, "25", "25", "2026-08-01"),
    );
    expect(error?.code).toBe("PT409");
    expect(error?.message).toMatch(/no MID/);
  });

  it("refuses an unknown merchant and an unknown rep with PT404", async () => {
    expect(
      (await attempt(ADMIN_ID, setSql(999999, AGENT_ID, THIRD_AGENT_ID, "25", "25", "2026-08-01")))?.code,
    ).toBe("PT404");
    const merchant = await merchantId("MID-AGENT-2");
    expect(
      (await attempt(ADMIN_ID, setSql(merchant, AGENT_ID, MISSING_ID, "25", "25", "2026-08-01")))?.code,
    ).toBe("PT404");
  });

  it("refuses a new share naming a deactivated rep, on either side", async () => {
    const merchant = await merchantId("MID-AGENT-2");
    for (const [primary, secondary] of [
      [GONE_AGENT_ID, THIRD_AGENT_ID],
      [AGENT_ID, GONE_AGENT_ID],
    ]) {
      const error = await attempt(
        ADMIN_ID,
        setSql(merchant, primary, secondary, "25", "25", "2026-08-01"),
      );
      expect(error?.code).toBe("PT409");
      expect(error?.message).toMatch(/Gone Agent is deactivated/);
    }
    expect(await shares()).toEqual([]);
  });

  describe("overlap", () => {
    it("ends the open share and starts the new one, in one call", async () => {
      const first = await setShare("MID-AGENT-2", "2026-08-01", "25", "25");
      const second = await setShare("MID-AGENT-2", "2026-10-01", "40", "10");

      const [a, b] = await shares();
      expect([a.id, a.effective_from, a.effective_to]).toEqual([first, "2026-08-01", "2026-10-01"]);
      expect([b.id, b.effective_from, b.effective_to]).toEqual([second, "2026-10-01", null]);
      expect((await audit()).map((row) => [row.action, row.row_id])).toEqual([
        ["set_merchant_rep_share", String(first)],
        ["end_merchant_rep_share", String(first)],
        ["set_merchant_rep_share", String(second)],
      ]);
    });

    it.each([
      ["the same month", "2026-08-01"],
      ["an earlier month", "2026-07-01"],
    ])("refuses a second share starting %s as an open one", async (_label, from) => {
      await setShare("MID-AGENT-2", "2026-08-01");
      const merchant = await merchantId("MID-AGENT-2");
      const error = await attempt(
        ADMIN_ID,
        setSql(merchant, AGENT_ID, THIRD_AGENT_ID, "40", "10", from),
      );
      expect(error?.code).toBe("PT409");
      expect(await shares()).toHaveLength(1);
    });

    it("refuses a share overlapping one that is closed but ends later", async () => {
      const first = await setShare("MID-AGENT-2", "2026-08-01");
      await asUser(db, ADMIN_ID);
      await db.query(`select end_merchant_rep_share(${first}, '2026-12-01')`);
      const merchant = await merchantId("MID-AGENT-2");
      const error = await attempt(
        ADMIN_ID,
        setSql(merchant, AGENT_ID, THIRD_AGENT_ID, "40", "10", "2026-10-01"),
      );
      expect(error?.code).toBe("PT409");
      expect(error?.message).toMatch(/overlaps another share/);

      // Directly after it is fine.
      await setShare("MID-AGENT-2", "2026-12-01", "40", "10");
      expect(await shares()).toHaveLength(2);
    });

    it("keeps different merchants independent", async () => {
      await setShare("MID-AGENT-2", "2026-08-01");
      await setShare("MID-OTHER-2", "2026-08-01", "25", "25", OTHER_AGENT_ID, THIRD_AGENT_ID);
      expect(await shares()).toHaveLength(2);
    });
  });
});

describe("end_merchant_rep_share", () => {
  it("ends a share and audits it", async () => {
    const id = await setShare("MID-AGENT-2", "2026-08-01");
    await asPlatform(db);
    await db.exec(`delete from audit_log`);
    await asUser(db, ADMIN_ID);
    await db.query(`select end_merchant_rep_share(${id}, '2026-11-01')`);
    const [row] = await shares();
    expect(row.effective_to).toBe("2026-11-01");
    expect(await audit()).toEqual([
      {
        actor_id: ADMIN_ID,
        action: "end_merchant_rep_share",
        table_name: "merchant_rep_shares",
        row_id: String(id),
      },
    ]);
  });

  it("refuses an end at or before a committed month", async () => {
    const id = await setShare("MID-AGENT-1", "2026-08-01");
    // August and September are then committed for MID-AGENT-1.
    await commitMonth("MID-AGENT-1", "2026-08-01");
    await commitMonth("MID-AGENT-1", "2026-09-01");
    // September is the latest committed month, and the only end in range that
    // is still after the share's own start (an end AT the start is refused
    // earlier, as 22023 — see below).
    const error = await attempt(ADMIN_ID, `select end_merchant_rep_share(${id}, '2026-09-01')`);
    expect(error?.code).toBe("PT409");
    expect(error?.message).toMatch(/September 2026 is already committed/);
    // The month after the latest committed one is the earliest legal end.
    await asUser(db, ADMIN_ID);
    await db.query(`select end_merchant_rep_share(${id}, '2026-10-01')`);
    expect((await shares())[0].effective_to).toBe("2026-10-01");
  });

  it("refuses to move an end that a committed month already sits past", async () => {
    const id = await setShare("MID-AGENT-2", "2026-08-01");
    await asUser(db, ADMIN_ID);
    await db.query(`select end_merchant_rep_share(${id}, '2026-10-01')`);
    // November is committed, so October's months were paid WITHOUT the share:
    // moving the end later would rewrite how they should have been split.
    await commitMonth("MID-AGENT-2", "2026-11-01");
    const error = await attempt(ADMIN_ID, `select end_merchant_rep_share(${id}, '2026-12-01')`);
    expect(error?.code).toBe("PT409");
    expect((await shares())[0].effective_to).toBe("2026-10-01");
  });

  it("refuses an end that would run into the next share", async () => {
    const first = await setShare("MID-AGENT-2", "2026-08-01");
    await setShare("MID-AGENT-2", "2026-10-01", "40", "10");
    const error = await attempt(ADMIN_ID, `select end_merchant_rep_share(${first}, '2026-12-01')`);
    expect(error?.code).toBe("PT409");
    expect(error?.message).toMatch(/overlaps another share/);
  });

  it.each([
    ["at its own start", "2026-08-01", "22023"],
    ["before its start", "2026-07-01", "22023"],
    ["mid-month", "2026-10-15", "22023"],
  ])("refuses an end %s", async (_label, to, code) => {
    const id = await setShare("MID-AGENT-2", "2026-08-01");
    const error = await attempt(ADMIN_ID, `select end_merchant_rep_share(${id}, '${to}')`);
    expect(error?.code).toBe(code);
  });

  it("refuses a non-admin with PT403 and an unknown share with PT404", async () => {
    const id = await setShare("MID-AGENT-2", "2026-08-01");
    expect((await attempt(AGENT_ID, `select end_merchant_rep_share(${id}, '2026-10-01')`))?.code).toBe("PT403");
    expect((await attempt(THIRD_AGENT_ID, `select end_merchant_rep_share(${id}, '2026-10-01')`))?.code).toBe("PT403");
    expect((await attempt(ADMIN_ID, `select end_merchant_rep_share(999999, '2026-10-01')`))?.code).toBe("PT404");
    expect((await shares())[0].effective_to).toBeNull();
  });
});

describe("cancel_merchant_rep_share", () => {
  it("deletes a share no committed month falls inside, and audits it", async () => {
    const id = await setShare("MID-AGENT-2", "2026-08-01");
    await asPlatform(db);
    await db.exec(`delete from audit_log`);
    await asUser(db, ADMIN_ID);
    await db.query(`select cancel_merchant_rep_share(${id})`);
    expect(await shares()).toEqual([]);
    expect(await audit()).toEqual([
      {
        actor_id: ADMIN_ID,
        action: "cancel_merchant_rep_share",
        table_name: "merchant_rep_shares",
        row_id: String(id),
      },
    ]);
  });

  it("refuses once a month inside the share is committed — end it instead", async () => {
    const id = await setShare("MID-AGENT-2", "2026-08-01");
    await commitMonth("MID-AGENT-2", "2026-08-01");
    const error = await attempt(ADMIN_ID, `select cancel_merchant_rep_share(${id})`);
    expect(error?.code).toBe("PT409");
    expect(error?.message).toMatch(/End it instead/);
    expect(await shares()).toHaveLength(1);
  });

  it("refuses a non-admin with PT403", async () => {
    const id = await setShare("MID-AGENT-2", "2026-08-01");
    expect((await attempt(AGENT_ID, `select cancel_merchant_rep_share(${id})`))?.code).toBe("PT403");
    expect(await shares()).toHaveLength(1);
  });
});

describe("no client reads or writes the table directly", () => {
  it("shows every share to an admin and none to a rep — not even one naming them", async () => {
    await setShare("MID-AGENT-2", "2026-08-01", "25", "25", AGENT_ID, OTHER_AGENT_ID);

    for (const [caller, expected] of [
      [ADMIN_ID, 1],
      [AGENT_ID, 0], // the signer
      [OTHER_AGENT_ID, 0], // the partner
      [THIRD_AGENT_ID, 0],
    ] as [string, number][]) {
      await asUser(db, caller);
      const found = await rows(db, `select id from merchant_rep_shares`);
      expect(found, `rows visible to ${caller}`).toHaveLength(expected);
    }
  });

  it("shows nothing to a deactivated admin", async () => {
    await setShare("MID-AGENT-2", "2026-08-01");
    await asPlatform(db);
    await db.exec(`update profiles set is_active = false where id = '${ADMIN_ID}'`);
    await asUser(db, ADMIN_ID);
    expect(await rows(db, `select id from merchant_rep_shares`)).toHaveLength(0);
    await asPlatform(db);
  });

  it("refuses a direct INSERT, UPDATE and DELETE with permission denied — for an admin too", async () => {
    const id = await setShare("MID-AGENT-2", "2026-08-01");
    const merchant = await merchantId("MID-OTHER-2");
    for (const caller of [ADMIN_ID, AGENT_ID]) {
      for (const sql of [
        `insert into merchant_rep_shares
           (merchant_id, primary_agent_id, secondary_agent_id,
            primary_rep_pct, secondary_rep_pct, effective_from)
         values (${merchant}, '${OTHER_AGENT_ID}', '${THIRD_AGENT_ID}', 25, 25, '2026-08-01')`,
        `update merchant_rep_shares set primary_rep_pct = 45, secondary_rep_pct = 5 where id = ${id}`,
        `delete from merchant_rep_shares where id = ${id}`,
      ]) {
        const error = await attempt(caller, sql);
        // 42501: refused by the grant, loudly — not filtered by RLS into a
        // write that reports success having changed nothing.
        expect(error?.code, `${caller}: ${sql.slice(0, 30)}`).toBe("42501");
      }
    }
    const [row] = await shares();
    expect([row.primary_rep_pct, row.secondary_rep_pct]).toEqual(["25.00", "25.00"]);
  });
});

describe("the table's own constraints, the backstop for any writer", () => {
  async function ownerInsert(values: string): Promise<DbError | null> {
    await asPlatform(db);
    try {
      await db.query(`
        insert into merchant_rep_shares
          (merchant_id, primary_agent_id, secondary_agent_id,
           primary_rep_pct, secondary_rep_pct, effective_from, effective_to)
        values (${values})`);
      return null;
    } catch (error) {
      return error as DbError;
    }
  }

  it.each([
    ["the same rep twice", (m: number) => `${m}, '${AGENT_ID}', '${AGENT_ID}', 25, 25, '2026-08-01', null`, "merchant_rep_shares_two_reps"],
    ["shares totalling 60", (m: number) => `${m}, '${AGENT_ID}', '${THIRD_AGENT_ID}', 30, 30, '2026-08-01', null`, "merchant_rep_shares_total_rep_side"],
    ["a zero share", (m: number) => `${m}, '${AGENT_ID}', '${THIRD_AGENT_ID}', 50, 0, '2026-08-01', null`, "merchant_rep_shares_positive"],
    ["a mid-month start", (m: number) => `${m}, '${AGENT_ID}', '${THIRD_AGENT_ID}', 25, 25, '2026-08-02', null`, "merchant_rep_shares_from_first_of_month"],
    ["an end before the start", (m: number) => `${m}, '${AGENT_ID}', '${THIRD_AGENT_ID}', 25, 25, '2026-08-01', '2026-07-01'`, "merchant_rep_shares_to_first_of_month"],
  ])("refuses %s even from the owner", async (_label, values, constraint) => {
    const error = await ownerInsert(values(await merchantId("MID-AGENT-2")));
    expect(error?.code).toBe("23514");
    expect(error?.message).toContain(constraint);
  });

  it("refuses overlapping shares on one merchant through the exclusion constraint", async () => {
    const m = await merchantId("MID-AGENT-2");
    expect(await ownerInsert(`${m}, '${AGENT_ID}', '${THIRD_AGENT_ID}', 25, 25, '2026-08-01', '2026-11-01'`)).toBeNull();
    const overlap = await ownerInsert(`${m}, '${AGENT_ID}', '${THIRD_AGENT_ID}', 40, 10, '2026-10-01', null`);
    expect(overlap?.code).toBe("23P01");
    expect(overlap?.message).toContain("merchant_rep_shares_no_overlap");
    // Touching is not overlapping: [Aug, Nov) and [Nov, ...) share no month.
    expect(await ownerInsert(`${m}, '${AGENT_ID}', '${THIRD_AGENT_ID}', 40, 10, '2026-11-01', null`)).toBeNull();
  });

  it("refuses deleting a merchant that has a share (ON DELETE RESTRICT)", async () => {
    // A fresh merchant nothing else references, so the share is the only thing
    // that can be in the way — seeded merchants also carry support tickets.
    await asPlatform(db);
    await db.exec(`
      insert into merchants (agent_id, mid, dba, status, city, state)
      values ('${AGENT_ID}', 'MID-SHARED-ONLY', 'Shared Only Co', 'active', 'Nashville', 'TN');
    `);
    const id = await setShare("MID-SHARED-ONLY", "2026-08-01");
    await asPlatform(db);
    await expect(
      db.exec(`delete from merchants where mid = 'MID-SHARED-ONLY'`),
    ).rejects.toThrow(/merchant_rep_shares_merchant_id_fkey/);

    // Non-vacuous: with the share cancelled, the same delete goes through.
    await asUser(db, ADMIN_ID);
    await db.query(`select cancel_merchant_rep_share(${id})`);
    await asPlatform(db);
    await db.exec(`delete from merchants where mid = 'MID-SHARED-ONLY'`);
    expect(await rows(db, `select id from merchants where mid = 'MID-SHARED-ONLY'`)).toHaveLength(0);
  });
});

describe("catalog and privileges", () => {
  const RPCS = [
    "set_merchant_rep_share(int, uuid, uuid, numeric, numeric, date)",
    "end_merchant_rep_share(int, date)",
    "cancel_merchant_rep_share(int)",
  ];

  it("has RLS enabled, and SELECT alone for authenticated", async () => {
    await asPlatform(db);
    const [table] = await rows<{ rls: boolean }>(
      db,
      `select relrowsecurity as rls from pg_class where oid = 'merchant_rep_shares'::regclass`,
    );
    expect(table.rls).toBe(true);

    const [grants] = await rows<{
      sel: boolean;
      ins: boolean;
      upd: boolean;
      del: boolean;
      anon: boolean;
      seq: boolean;
    }>(
      db,
      `select has_table_privilege('authenticated', 'merchant_rep_shares', 'select') as sel,
              has_table_privilege('authenticated', 'merchant_rep_shares', 'insert') as ins,
              has_table_privilege('authenticated', 'merchant_rep_shares', 'update') as upd,
              has_table_privilege('authenticated', 'merchant_rep_shares', 'delete') as del,
              has_table_privilege('anon', 'merchant_rep_shares', 'select') as anon,
              has_sequence_privilege('authenticated', 'merchant_rep_shares_id_seq', 'usage') as seq`,
    );
    expect(grants).toEqual({
      sel: true,
      ins: false,
      upd: false,
      del: false,
      anon: false,
      seq: false,
    });
  });

  it.each(RPCS)("%s is security definer, guarded, locked, and not executable by anon", async (sig) => {
    await asPlatform(db);
    const [fn] = await rows<{
      prosecdef: boolean;
      proconfig: string[] | null;
      body: string;
      auth: boolean;
      anon: boolean;
    }>(
      db,
      `select p.prosecdef, p.proconfig, p.prosrc as body,
              has_function_privilege('authenticated', '${sig}', 'execute') as auth,
              has_function_privilege('anon', '${sig}', 'execute') as anon
         from pg_proc p where p.oid = '${sig}'::regprocedure`,
    );
    expect(fn.prosecdef).toBe(true);
    expect(fn.proconfig).toContain("search_path=public");
    // The guard has to be the FIRST thing the function does: definer bypasses
    // RLS, so anything above it runs for anybody.
    expect(fn.body.trimStart()).toMatch(/^declare[\s\S]*?begin\s+if not is_admin\(\) then/);
    // The same lock the commit path takes from phase 4.
    expect(fn.body).toContain("pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'))");
    expect(fn.auth).toBe(true);
    expect(fn.anon).toBe(false);
  });
});
