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
 * 20261102120000, overrides -- phase 10 of docs/design/intake-and-reports.md.
 * What this file pins:
 *
 *   1. merchant_overrides: RLS on (written in the migration, not left to
 *      ensure_rls), one admin SELECT policy, SELECT the only client grant, the
 *      outer CHECKs and one override per merchant per month.
 *   2. set_merchant_override / end / cancel: admin only, audited, the cap at
 *      the MERCHANT's rate (0, 30, 50), the recipient rules, the month rule.
 *   3. The rules that hold over time: set_merchant_split below a live
 *      override (A29), moving the merchant, a share naming the recipient.
 *   4. Commit v3's override lines: the example, a shared account with odd
 *      cents, a clawback, a zero, the backstops, replace and period delete,
 *      and a committed month untouched by a later edit.
 *   5. The invariant, over many random cases through the real commit.
 *   6. Visibility: the rep's debit, the recipient's credit, no merchant row
 *      for the recipient, my_override_recipients()' key-absent shape.
 *   7. The ledger CHECKs and the migration over a populated database.
 *   8. Mutation proofs: each protection, removed from a copy, lets its case
 *      through.
 */

const MIGRATION = "20261102120000_merchant_overrides.sql";
const V3 = "commit_residual_import_v3";

/** The recipient: an active rep with no merchant of their own here. */
const MANAGER_ID = "44444444-4444-4444-4444-444444444444";
const MANAGER_NAME = "Dana Cole";

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

async function addManager(target: TestDb): Promise<void> {
  await asPlatform(target);
  await target.exec(`
    insert into auth.users (id, email) values ('${MANAGER_ID}', 'dana@tapswipe.test');
    insert into profiles (id, full_name, role, is_active, email)
    values ('${MANAGER_ID}', '${MANAGER_NAME}', 'agent', true, 'dana@tapswipe.test');
    update profiles set manager_id = '${MANAGER_ID}' where id = '${AGENT_ID}';
    delete from audit_log;`);
}

/** A merchant at a rate, owned by `owner` (AGENT_ID), as the platform. */
async function merchant(
  target: TestDb,
  mid: string,
  fields: { owner?: string; rate?: number } = {},
): Promise<number> {
  await asPlatform(target);
  const rate = fields.rate ?? 50;
  const [{ id }] = await rows<{ id: number }>(
    target,
    `insert into merchants (agent_id, mid, dba, status, processor, split_agent_pct, split_company_pct, city, state)
     values ('${fields.owner ?? AGENT_ID}', '${mid}', '${mid} Co', 'active', 'TSYS', ${rate}, ${100 - rate}, 'Nashville', 'TN')
     returning id`,
  );
  return id;
}

/** An override inserted as the platform (the RPC's guards are tested on their own). */
async function plant(
  target: TestDb,
  merchantId: number,
  pct: number,
  from: string,
  fields: { recipient?: string; to?: string | null } = {},
): Promise<number> {
  await asPlatform(target);
  const [{ id }] = await rows<{ id: number }>(
    target,
    `insert into merchant_overrides (merchant_id, recipient_id, override_pct, effective_from, effective_to)
     values (${merchantId}, '${fields.recipient ?? MANAGER_ID}', ${pct}, '${from}',
             ${fields.to ? `'${fields.to}'` : "null"}) returning id`,
  );
  return id;
}

/** A share inserted as the platform. */
async function share(target: TestDb, merchantId: number, a: number, b: number, from: string): Promise<number> {
  await asPlatform(target);
  const [{ id }] = await rows<{ id: number }>(
    target,
    `insert into merchant_rep_shares (merchant_id, primary_agent_id, secondary_agent_id,
                                      primary_rep_pct, secondary_rep_pct, effective_from)
     values (${merchantId}, '${AGENT_ID}', '${OTHER_AGENT_ID}', ${a}, ${b}, '${from}') returning id`,
  );
  return id;
}

/** The month a new test batch will take (insertBatch's freeBatchMonth). */
async function nextMonth(target: TestDb): Promise<string> {
  await asPlatform(target);
  const [{ m }] = await rows<{ m: string }>(target, `select ${freeBatchMonth("TSYS")}::text as m`);
  return m;
}

/** A review batch for `period` (a free one by default), its rows staged as the parser would. */
async function batchWith(
  target: TestDb,
  staged: { mid: string; residual?: string; volume?: string }[],
  fields: { period?: string; replaces?: number } = {},
): Promise<{ id: number; period: string }> {
  await asPlatform(target);
  const extra: Record<string, string> = {
    processor: "'TSYS'",
    period: fields.period ? `'${fields.period}'` : freeBatchMonth("TSYS"),
  };
  if (fields.replaces !== undefined) extra.replaces_batch_id = String(fields.replaces);
  const id = await insertBatch(target, { extra });
  const [{ period }] = await rows<{ period: string }>(
    target,
    `select period::text as period from rep_payout_batches where id = ${id}`,
  );
  const values = staged.map((row, i) => `
    (${id}, ${i + 2}, '${row.mid}', 'File name', 'TSYS', 'Residuals', 'v', 'r', '${period}',
     (select agent_id from merchants where mid = '${row.mid}'),
     (select id from merchants where mid = '${row.mid}'),
     ${row.volume ?? "100000.00"}, ${row.residual ?? "100.00"}, null, '{}')`);
  if (values.length > 0) {
    await target.exec(`
      insert into rep_payout_import_rows
        (batch_id, row_number, mid_raw, merchant_name_raw, processor_raw, income_type_raw,
         volume_raw, residual_income_raw, period, agent_id, merchant_id,
         volume, residual_income, blocker, blockers)
      values ${values.join(",")}`);
  }
  return { id, period };
}

async function commit(target: TestDb, id: number, confirmed: string[] = []): Promise<Record<string, number>> {
  await asUser(target, ADMIN_ID);
  try {
    const list = confirmed.length === 0 ? "'{}'::text[]" : `array[${confirmed.map((c) => `'${c}'`).join(", ")}]`;
    const [{ result }] = await rows<{ result: Record<string, number> }>(
      target,
      `select ${V3}(${id}, ${list}) as result`,
    );
    return result;
  } finally {
    await asPlatform(target);
  }
}

async function refused(target: TestDb, id: number): Promise<DbError> {
  const error = await attempt(() => commit(target, id));
  await asPlatform(target);
  expect(error, "expected the commit to be refused").not.toBeNull();
  return error as DbError;
}

/** Calls an RPC as `who` (the admin by default), returning its error or null. */
async function rpc(target: TestDb, sql: string, who: string | null = ADMIN_ID): Promise<DbError | null> {
  await asUser(target, who);
  try {
    return await attempt(() => target.query(sql));
  } finally {
    await asPlatform(target);
  }
}

async function setOverride(
  target: TestDb,
  merchantId: number,
  pct: number | string,
  from: string,
  recipient: string = MANAGER_ID,
): Promise<number> {
  await asUser(target, ADMIN_ID);
  try {
    const [{ id }] = await rows<{ id: number }>(
      target,
      `select set_merchant_override(${merchantId}, '${recipient}', ${pct}, '${from}') as id`,
    );
    return id;
  } finally {
    await asPlatform(target);
  }
}

type Line = {
  agent_id: string;
  line_kind: string;
  override_id: number | null;
  override_role: string | null;
  amount: string | null;
  payout: string | null;
  mid: string;
  merchant_name: string | null;
  merchant_id: number | null;
};

async function linesOf(target: TestDb, batchId: number): Promise<Line[]> {
  await asPlatform(target);
  return rows<Line>(
    target,
    `select agent_id, line_kind, override_id, override_role, override_amount::text as amount,
            rep_payout::text as payout, mid, merchant_name, merchant_id
       from rep_payout_rows where batch_id = ${batchId}
      order by mid, line_kind, override_role, agent_id`,
  );
}

const auditOf = async (target: TestDb, action: string) => {
  await asPlatform(target);
  return rows<{ actor_id: string | null; table_name: string; row_id: string }>(
    target,
    `select actor_id, table_name, row_id from audit_log where action = '${action}' order by id`,
  );
};

let db: TestDb;

beforeAll(async () => {
  db = await open();
});

beforeEach(async () => {
  await resetData(db);
  await addManager(db);
});

// -------------------------------------------------------------------------
// 1. The table
// -------------------------------------------------------------------------

describe("merchant_overrides: RLS, grants, CHECKs", () => {
  it("enables RLS itself in the migration, rather than relying on ensure_rls", async () => {
    expect(await readMigration(MIGRATION)).toMatch(/^alter table merchant_overrides enable row level security;$/m);
    const [{ on }] = await rows<{ on: boolean }>(
      db,
      `select relrowsecurity as on from pg_class where oid = 'public.merchant_overrides'::regclass`,
    );
    expect(on).toBe(true);
  });

  it("has one policy, an admin SELECT", async () => {
    expect(
      await rows(db, `select polname, polcmd, pg_get_expr(polqual, polrelid) as qual
                        from pg_policy where polrelid = 'public.merchant_overrides'::regclass`),
    ).toEqual([{ polname: "admin only select", polcmd: "r", qual: "is_admin()" }]);
  });

  it("grants SELECT to authenticated only, SELECT and DELETE to service_role, nothing to anon", async () => {
    const grants = await rows<{ grantee: string; privilege_type: string }>(
      db,
      `select grantee, privilege_type from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'merchant_overrides'
          and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
        order by grantee, privilege_type`,
    );
    expect(grants).toEqual([
      { grantee: "authenticated", privilege_type: "SELECT" },
      { grantee: "service_role", privilege_type: "DELETE" },
      { grantee: "service_role", privilege_type: "SELECT" },
    ]);
  });

  it("no client writes it, an admin included; a rep and the recipient read nothing of it", async () => {
    const m = await merchant(db, "OV-1");
    const id = await plant(db, m, 10, await nextMonth(db));
    for (const sql of [
      `insert into merchant_overrides (merchant_id, recipient_id, override_pct, effective_from)
       values (${m}, '${MANAGER_ID}', 5, '2030-01-01')`,
      `update merchant_overrides set override_pct = 1 where id = ${id}`,
      `delete from merchant_overrides where id = ${id}`,
    ]) {
      expect((await rpc(db, sql))?.message).toMatch(/permission denied for table merchant_overrides/);
    }
    await asUser(db, ADMIN_ID);
    expect(await rows(db, `select id from merchant_overrides`)).toEqual([{ id }]);
    for (const who of [AGENT_ID, MANAGER_ID, OTHER_AGENT_ID]) {
      await asUser(db, who);
      expect(await rows(db, `select id from merchant_overrides`)).toEqual([]);
    }
    await asPlatform(db);
  });

  it("refuses a percent of 0 or above 50, a month not on the 1st, and an end not after the start", async () => {
    const m = await merchant(db, "OV-1");
    const from = await nextMonth(db);
    for (const [pct, f, to, constraint] of [
      [0, from, null, "merchant_overrides_pct_range"],
      [50.01, from, null, "merchant_overrides_pct_range"],
      [10, from.replace(/-01$/, "-02"), null, "merchant_overrides_from_first_of_month"],
      [10, from, from, "merchant_overrides_to_first_of_month"],
    ] as const) {
      const error = await attempt(() => plant(db, m, pct, f, { to }));
      expect(error?.message).toContain(constraint);
    }
  });

  it("allows at most one override per merchant per month", async () => {
    const m = await merchant(db, "OV-1");
    await plant(db, m, 10, "2030-01-01", { to: "2030-06-01" });
    const error = await attempt(() => plant(db, m, 5, "2030-05-01"));
    expect(error?.message).toContain("merchant_overrides_no_overlap");
    await plant(db, m, 5, "2030-06-01");
    const other = await merchant(db, "OV-2");
    await plant(db, other, 5, "2030-05-01");
  });
});

// -------------------------------------------------------------------------
// 2. The functions
// -------------------------------------------------------------------------

describe("set_merchant_override", () => {
  it("is admin only: PT403 for a rep, no EXECUTE for anon", async () => {
    const m = await merchant(db, "OV-1");
    const sql = `select set_merchant_override(${m}, '${MANAGER_ID}', 10, '2030-01-01')`;
    expect((await rpc(db, sql, AGENT_ID))?.code).toBe("PT403");
    await asUser(db, null);
    await db.exec(`set role anon`);
    expect((await attempt(() => db.query(sql)))?.message).toMatch(/permission denied for function set_merchant_override/);
    await asPlatform(db);
    expect(await rows(db, `select id from merchant_overrides`)).toEqual([]);
  });

  it("sets one and writes its audit row, the admin as actor", async () => {
    const m = await merchant(db, "OV-1");
    const id = await setOverride(db, m, 10, "2030-01-01");
    expect(
      await rows(db, `select merchant_id, recipient_id, override_pct::text as pct, effective_from::text as f, effective_to
                        from merchant_overrides`),
    ).toEqual([{ merchant_id: m, recipient_id: MANAGER_ID, pct: "10.00", f: "2030-01-01", effective_to: null }]);
    expect(await auditOf(db, "set_merchant_override")).toEqual([
      { actor_id: ADMIN_ID, table_name: "merchant_overrides", row_id: String(id) },
    ]);
  });

  describe("the cap is the MERCHANT's rate, not 50", () => {
    it.each([
      [50, ["0.01", "10", "49.99", "50"], ["50.01"]],
      [30, ["0.01", "30"], ["30.01", "50"]],
      [46.5, ["46.5"], ["46.51"]],
    ])("at rate %s: accepts %j, refuses %j", async (rate, accepted, rejected) => {
      for (const [i, pct] of accepted.entries()) {
        const m = await merchant(db, `OK-${i}`, { rate });
        await setOverride(db, m, pct, "2030-01-01");
      }
      for (const [i, pct] of rejected.entries()) {
        const m = await merchant(db, `NO-${i}`, { rate });
        const error = await rpc(db, `select set_merchant_override(${m}, '${MANAGER_ID}', ${pct}, '2030-01-01')`);
        expect(error?.code).toBe("22023");
        expect(error?.message).toMatch(
          Number(pct) > 50
            ? /^An override is a percent of the full residual/
            : new RegExp(`cannot be more than this merchant's rate: ${rate}\\.$`),
        );
      }
    });

    it("refuses any override on a house merchant at rate 0", async () => {
      const m = await merchant(db, "HOUSE", { rate: 0 });
      const error = await rpc(db, `select set_merchant_override(${m}, '${MANAGER_ID}', 0.01, '2030-01-01')`);
      expect(error?.code).toBe("PT409");
      expect(error?.message).toBe("This merchant's rate is 0, so there is no rep side for an override to come out of.");
    });

    it("refuses 0, a negative, finer than a hundredth, and a merchant with no rate", async () => {
      const m = await merchant(db, "OV-1");
      for (const pct of ["0", "-5", "10.001"]) {
        expect((await rpc(db, `select set_merchant_override(${m}, '${MANAGER_ID}', ${pct}, '2030-01-01')`))?.code).toBe("22023");
      }
      await asPlatform(db);
      await db.exec(`set session_replication_role = replica;
        insert into merchants (agent_id, mid, dba, city, state) values ('${AGENT_ID}', 'NORATE', 'No Rate', 'Nashville', 'TN');
        set session_replication_role = origin;`);
      const [{ id }] = await rows<{ id: number }>(db, `select id from merchants where mid = 'NORATE'`);
      const error = await rpc(db, `select set_merchant_override(${id}, '${MANAGER_ID}', 5, '2030-01-01')`);
      expect(error?.message).toBe("This merchant has no split rate yet. Set its rate before giving it an override.");
    });
  });

  describe("the recipient", () => {
    it("may be any named active person: the manager, another rep, an admin", async () => {
      for (const [i, who] of [MANAGER_ID, OTHER_AGENT_ID, ADMIN_ID].entries()) {
        const m = await merchant(db, `R-${i}`);
        await setOverride(db, m, 5, "2030-01-01", who);
      }
      expect(await rows(db, `select count(*)::int as n from merchant_overrides`)).toEqual([{ n: 3 }]);
    });

    it("must be named: the function never guesses (the form prefills the manager)", async () => {
      const m = await merchant(db, "OV-1");
      const error = await rpc(db, `select set_merchant_override(${m}, null, 5, '2030-01-01')`);
      expect(error?.code).toBe("22023");
    });

    it("refuses someone deactivated, someone who does not exist, and the owner", async () => {
      const m = await merchant(db, "OV-1");
      await db.exec(`update profiles set is_active = false where id = '${MANAGER_ID}'`);
      let error = await rpc(db, `select set_merchant_override(${m}, '${MANAGER_ID}', 5, '2030-01-01')`);
      expect([error?.code, error?.message]).toEqual(["PT409", `${MANAGER_NAME} is deactivated, so a new override cannot name them.`]);
      error = await rpc(db, `select set_merchant_override(${m}, '99999999-9999-9999-9999-999999999999', 5, '2030-01-01')`);
      expect(error?.code).toBe("PT404");
      error = await rpc(db, `select set_merchant_override(${m}, '${AGENT_ID}', 5, '2030-01-01')`);
      expect([error?.code, error?.message]).toEqual([
        "22023",
        "The override is paid out of the owner's side, so the owner cannot also receive it. Name their manager or another person.",
      ]);
      expect(await rows(db, `select id from merchant_overrides`)).toEqual([]);
    });

    it("refuses either party of a share overlapping it", async () => {
      const m = await merchant(db, "OV-1");
      await share(db, m, 40, 10, "2030-01-01");
      const error = await rpc(db, `select set_merchant_override(${m}, '${OTHER_AGENT_ID}', 5, '2030-03-01')`);
      expect([error?.code, error?.message]).toEqual([
        "PT409",
        "Other Agent is a party to this merchant's shared account, so they cannot also receive its override.",
      ]);
      await setOverride(db, m, 5, "2030-03-01", MANAGER_ID);
    });
  });

  it("refuses a merchant whose pre-app is not submitted or approved (A4b); a hand-made one is allowed", async () => {
    const m = await merchant(db, "OV-1");
    const [{ id: draft }] = await rows<{ id: number }>(db, `select id from pre_apps where status = 'draft' limit 1`);
    const [{ id: submitted }] = await rows<{ id: number }>(db, `select id from pre_apps where status = 'submitted' limit 1`);
    await db.exec(`update merchants set pre_app_id = ${draft} where id = ${m}`);
    const error = await rpc(db, `select set_merchant_override(${m}, '${MANAGER_ID}', 5, '2030-01-01')`);
    expect([error?.code, error?.message]).toEqual([
      "PT409",
      "This merchant's pre-app has not been submitted, so it cannot carry an override yet.",
    ]);
    await db.exec(`update merchants set pre_app_id = ${submitted} where id = ${m}`);
    await setOverride(db, m, 5, "2030-01-01");
  });

  it("refuses a merchant with no MID, and a start that is not the 1st", async () => {
    const m = await merchant(db, "OV-1");
    expect((await rpc(db, `select set_merchant_override(${m}, '${MANAGER_ID}', 5, '2030-01-02')`))?.code).toBe("22023");
    await db.exec(`update merchants set mid = null where id = ${m}`);
    const error = await rpc(db, `select set_merchant_override(${m}, '${MANAGER_ID}', 5, '2030-01-01')`);
    expect(error?.message).toMatch(/^This merchant has no MID/);
  });

  it("refuses a start at or before the latest committed month for the MID (an adjustment instead)", async () => {
    const m = await merchant(db, "OV-1");
    const { id, period } = await batchWith(db, [{ mid: "OV-1" }]);
    await commit(db, id);
    const error = await rpc(db, `select set_merchant_override(${m}, '${MANAGER_ID}', 5, '${period}')`);
    expect(error?.code).toBe("PT409");
    expect(error?.message).toMatch(/is already committed for this MID\. An override can only start after it/);
  });

  it("a later start ends the open override at that month (one call, audited twice); an earlier or equal one is refused", async () => {
    const m = await merchant(db, "OV-1");
    const first = await setOverride(db, m, 10, "2030-01-01");
    let error = await rpc(db, `select set_merchant_override(${m}, '${MANAGER_ID}', 5, '2030-01-01')`);
    expect(error?.message).toBe("This merchant already has an override starting January 2030. Cancel or end that one first.");
    const second = await setOverride(db, m, 5, "2030-04-01", OTHER_AGENT_ID);
    expect(
      await rows(db, `select id, effective_from::text as f, effective_to::text as t from merchant_overrides order by id`),
    ).toEqual([
      { id: first, f: "2030-01-01", t: "2030-04-01" },
      { id: second, f: "2030-04-01", t: null },
    ]);
    expect(await auditOf(db, "end_merchant_override")).toEqual([
      { actor_id: ADMIN_ID, table_name: "merchant_overrides", row_id: String(first) },
    ]);
    // An override that ends in the future still blocks a start inside it.
    await rpc(db, `select end_merchant_override(${second}, '2030-09-01')`);
    error = await rpc(db, `select set_merchant_override(${m}, '${MANAGER_ID}', 5, '2030-06-01')`);
    expect(error?.message).toBe("That month overlaps another override on this merchant.");
  });
});

describe("end_merchant_override and cancel_merchant_override", () => {
  it("end: admin only, audited, after the start, never at or before a committed month", async () => {
    const m = await merchant(db, "OV-1");
    const { id: batch, period } = await batchWith(db, [{ mid: "OV-1" }]);
    const ov = await plant(db, m, 10, period);
    await commit(db, batch);
    expect((await rpc(db, `select end_merchant_override(${ov}, '2099-01-01')`, AGENT_ID))?.code).toBe("PT403");
    expect((await rpc(db, `select end_merchant_override(${ov}, '${period}')`))?.code).toBe("22023");
    const error = await rpc(db, `select end_merchant_override(${ov}, (date '${period}' - interval '1 month')::date)`);
    expect(error?.code).toBe("22023");
    await db.exec(`delete from audit_log`);
    expect(await rpc(db, `select end_merchant_override(${ov}, (date '${period}' + interval '1 month')::date)`)).toBeNull();
    expect(await auditOf(db, "end_merchant_override")).toEqual([
      { actor_id: ADMIN_ID, table_name: "merchant_overrides", row_id: String(ov) },
    ]);
    // Its end now sits on the committed month's boundary: settled.
    await db.exec(`insert into rep_payout_rows (agent_id, period, processor, mid, merchant_id, residual_income, rep_split_pct, volume)
                   values ('${AGENT_ID}', (date '${period}' + interval '1 month')::date, 'TSYS', 'OV-1', ${m}, 1, 50, 1)`);
    const settled = await rpc(db, `select end_merchant_override(${ov}, (date '${period}' + interval '3 month')::date)`);
    expect(settled?.code).toBe("PT409");
  });

  it("cancel: deletes an override that never applied (audited); refuses one a line references", async () => {
    const m = await merchant(db, "OV-1");
    const unused = await plant(db, m, 10, "2030-01-01");
    expect((await rpc(db, `select cancel_merchant_override(${unused})`, AGENT_ID))?.code).toBe("PT403");
    expect(await rpc(db, `select cancel_merchant_override(${unused})`)).toBeNull();
    expect(await auditOf(db, "cancel_merchant_override")).toEqual([
      { actor_id: ADMIN_ID, table_name: "merchant_overrides", row_id: String(unused) },
    ]);

    const { id: batch, period } = await batchWith(db, [{ mid: "OV-1" }]);
    const used = await plant(db, m, 10, period);
    await commit(db, batch);
    const error = await rpc(db, `select cancel_merchant_override(${used})`);
    expect([error?.code, error?.message]).toEqual([
      "PT409",
      "This override has applied to a committed month, so it cannot be cancelled. End it instead.",
    ]);
    expect((await rpc(db, `select cancel_merchant_override(999999)`))?.code).toBe("PT404");
  });
});

// -------------------------------------------------------------------------
// 3. The rules that hold over time
// -------------------------------------------------------------------------

describe("the rules that hold over time", () => {
  it("set_merchant_split refuses a rate below a live override (A29), and allows one at or above it", async () => {
    const m = await merchant(db, "OV-1", { rate: 50 });
    await plant(db, m, 30, "2030-01-01");
    const error = await rpc(db, `select set_merchant_split(${m}, 29.99)`);
    expect([error?.code, error?.message]).toEqual([
      "PT409",
      "This merchant has an override of 30%, which comes out of its rate. End or change the override before setting the rate below it.",
    ]);
    expect(await rpc(db, `select set_merchant_split(${m}, 30)`)).toBeNull();
  });

  it("set_merchant_split ignores an override that has ended before the latest committed month", async () => {
    const m = await merchant(db, "OV-1", { rate: 50 });
    await db.exec(`insert into rep_payout_rows (agent_id, period, processor, mid, merchant_id, residual_income, rep_split_pct, volume)
                   values ('${AGENT_ID}', '2026-03-01', 'TSYS', 'OV-1', ${m}, 1, 50, 1)`);
    await plant(db, m, 30, "2026-01-01", { to: "2026-03-01" });
    expect(await rpc(db, `select set_merchant_split(${m}, 10)`)).toBeNull();
  });

  it("moving a merchant is refused while it has a live override; allowed without one", async () => {
    const m = await merchant(db, "OV-1");
    await plant(db, m, 10, "2030-01-01");
    const error = await attempt(() => db.query(`update merchants set agent_id = '${OTHER_AGENT_ID}' where id = ${m}`));
    expect(error?.message).toBe("This merchant has an override, which comes out of its owner's side. End it before moving the merchant.");
    const free = await merchant(db, "OV-2");
    await db.exec(`update merchants set agent_id = '${OTHER_AGENT_ID}' where id = ${free}`);
  });

  it("set_merchant_rep_share refuses naming an overlapping override's recipient as a party", async () => {
    const m = await merchant(db, "OV-1");
    await plant(db, m, 10, "2030-01-01", { recipient: OTHER_AGENT_ID });
    const error = await rpc(
      db,
      `select set_merchant_rep_share(${m}, '${AGENT_ID}', '${OTHER_AGENT_ID}', 40, 10, '2030-02-01')`,
    );
    expect([error?.code, error?.message]).toEqual([
      "PT409",
      "Other Agent receives this merchant's override, so they cannot also be a party to its shared account. End the override first.",
    ]);
    expect(
      await rpc(db, `select set_merchant_rep_share(${m}, '${AGENT_ID}', '${MANAGER_ID}', 40, 10, '2030-02-01')`),
    ).toBeNull();
  });
});

// -------------------------------------------------------------------------
// 4. The commit's override lines
// -------------------------------------------------------------------------

describe("commit v3 writes the override lines", () => {
  it("the memo's example: R = 100, rate 50, override 10 -- rep 40, recipient 10, company 50", async () => {
    const m = await merchant(db, "OV-1");
    const { id, period } = await batchWith(db, [{ mid: "OV-1", residual: "100.00" }]);
    const ov = await plant(db, m, 10, period);
    const result = await commit(db, id);
    expect(result).toMatchObject({ written: 1, overrides: 1 });
    expect(await linesOf(db, id)).toEqual([
      { agent_id: AGENT_ID, line_kind: "import", override_id: null, override_role: null, amount: null, payout: "50.00", mid: "OV-1", merchant_name: "OV-1 Co", merchant_id: m },
      { agent_id: MANAGER_ID, line_kind: "override", override_id: ov, override_role: "credit", amount: "10.00", payout: "10.00", mid: "OV-1", merchant_name: "OV-1 Co", merchant_id: m },
      { agent_id: AGENT_ID, line_kind: "override", override_id: ov, override_role: "debit", amount: "-10.00", payout: "-10.00", mid: "OV-1", merchant_name: "OV-1 Co", merchant_id: m },
    ]);
    const [{ rep, recipient }] = await rows<{ rep: string; recipient: string }>(
      db,
      `select sum(rep_payout) filter (where agent_id = '${AGENT_ID}')::text as rep,
              sum(rep_payout) filter (where agent_id = '${MANAGER_ID}')::text as recipient
         from rep_payout_rows where batch_id = ${id}`,
    );
    expect([rep, recipient]).toEqual(["40.00", "10.00"]);
  });

  it("an override lines carry the batch, its month and processor, and no figures", async () => {
    const m = await merchant(db, "OV-1");
    const { id, period } = await batchWith(db, [{ mid: "OV-1" }]);
    await plant(db, m, 10, period);
    await commit(db, id);
    expect(
      await rows(db, `select distinct period::text as period, processor, batch_id, residual_income, rep_split_pct,
                                      volume, average_ticket, total_cost, rep_share_id, adjustment_amount
                         from rep_payout_rows where line_kind = 'override'`),
    ).toEqual([{ period, processor: "TSYS", batch_id: id, residual_income: null, rep_split_pct: null,
                 volume: null, average_ticket: null, total_cost: null, rep_share_id: null, adjustment_amount: null }]);
  });

  it("a shared account: the deduction divides in the share ratio by the cent rule, the signer taking the odd cent", async () => {
    const m = await merchant(db, "SH-1", { rate: 50 });
    const { id, period } = await batchWith(db, [{ mid: "SH-1", residual: "33.33" }]);
    await share(db, m, 25, 25, period);
    const ov = await plant(db, m, 10, period);
    await commit(db, id);
    // R 33.33: T = 16.67 (signer 8.34, partner 8.33). X = 3.33: partner
    // shared_part(3.33, 25, 50) = 1.66 (1.665, the tie toward zero), signer 1.67.
    const lines = await linesOf(db, id);
    const of = (agent: string, kind: string) =>
      lines.filter((l) => l.agent_id === agent && l.line_kind === kind).map((l) => l.payout);
    expect(of(AGENT_ID, "import")).toEqual(["8.34"]);
    expect(of(OTHER_AGENT_ID, "import")).toEqual(["8.33"]);
    expect(of(AGENT_ID, "override")).toEqual(["-1.67"]);
    expect(of(OTHER_AGENT_ID, "override")).toEqual(["-1.66"]);
    expect(of(MANAGER_ID, "override")).toEqual(["3.33"]);
    expect(lines.filter((l) => l.line_kind === "override").every((l) => l.override_id === ov)).toBe(true);
  });

  it("a clawback (negative residual) imports with no warning, and the override reverses in proportion", async () => {
    const m = await merchant(db, "CB-1");
    const { id, period } = await batchWith(db, [{ mid: "CB-1", residual: "-11.76", volume: "5000.00" }]);
    await plant(db, m, 10, period);
    await commit(db, id); // no confirmation needed: A25
    const lines = await linesOf(db, id);
    expect(lines.map((l) => [l.agent_id, l.override_role, l.payout])).toEqual([
      [AGENT_ID, null, "-5.88"],
      [MANAGER_ID, "credit", "-1.18"],
      [AGENT_ID, "debit", "1.18"],
    ]);
  });

  it("a residual too small to carry a cent of override still records the pair, at 0.00", async () => {
    const m = await merchant(db, "Z-1");
    const { id, period } = await batchWith(db, [{ mid: "Z-1", residual: "0.04" }]);
    await plant(db, m, 10, period);
    expect((await commit(db, id)).overrides).toBe(1);
    expect((await linesOf(db, id)).filter((l) => l.line_kind === "override").map((l) => l.payout)).toEqual(["0.00", "0.00"]);
  });

  it("only an override in force for the batch month applies", async () => {
    const before = await merchant(db, "B-1");
    const after = await merchant(db, "A-1");
    const { id, period } = await batchWith(db, [{ mid: "B-1" }, { mid: "A-1" }]);
    await plant(db, before, 10, "2020-01-01", { to: period }); // ended at the month: exclusive
    await plant(db, after, 10, `${Number(period.slice(0, 4)) + 1}${period.slice(4)}`);
    expect((await commit(db, id)).overrides).toBe(0);
    expect((await linesOf(db, id)).filter((l) => l.line_kind === "override")).toEqual([]);
  });

  describe("backstops, refused before anything is written", () => {
    it("an override above the merchant's rate now", async () => {
      const m = await merchant(db, "OV-1", { rate: 50 });
      const { id, period } = await batchWith(db, [{ mid: "OV-1" }]);
      const ov = await plant(db, m, 40, period);
      await db.exec(`set session_replication_role = replica;
        update merchants set split_agent_pct = 30, split_company_pct = 70 where id = ${m};
        set session_replication_role = origin;`);
      const error = await refused(db, id);
      expect(error.message).toBe(`MIDs OV-1 (override #${ov}) have an override above the merchant's rate. An override comes out of the rep side: end or change it, then commit.`);
      expect((await linesOf(db, id)).length).toBe(0);
    });

    it("a recipient who has been deactivated (named, with the override)", async () => {
      const m = await merchant(db, "OV-1");
      const { id, period } = await batchWith(db, [{ mid: "OV-1" }]);
      const ov = await plant(db, m, 10, period);
      await db.exec(`update profiles set is_active = false where id = '${MANAGER_ID}'`);
      const error = await refused(db, id);
      expect(error.code).toBe("PT409");
      expect(error.message).toBe(`Overrides on MIDs OV-1 (override #${ov} to ${MANAGER_NAME}) pay someone who is deactivated. End each override (or reactivate the person), then commit.`);
      expect((await linesOf(db, id)).length).toBe(0);
    });

    it("a recipient who is now the owner, or a party of a covering share", async () => {
      const own = await merchant(db, "OWN-1");
      const shared = await merchant(db, "SHR-1");
      const { id, period } = await batchWith(db, [{ mid: "OWN-1" }]);
      const ov = await plant(db, own, 10, period, { recipient: AGENT_ID });
      let error = await refused(db, id);
      expect(error.message).toBe(`MIDs OWN-1 (override #${ov}) have an override paid to the merchant's owner or to a party of its shared account. End the override and set it again, then commit.`);

      const second = await batchWith(db, [{ mid: "SHR-1" }]);
      await share(db, shared, 40, 10, second.period);
      const ov2 = await plant(db, shared, 10, second.period, { recipient: OTHER_AGENT_ID });
      error = await refused(db, second.id);
      expect(error.message).toContain(`SHR-1 (override #${ov2})`);
    });
  });

  it("a replace removes the old override lines and writes them again from the same override", async () => {
    const m = await merchant(db, "OV-1");
    const first = await batchWith(db, [{ mid: "OV-1", residual: "100.00" }]);
    const ov = await plant(db, m, 10, first.period);
    await commit(db, first.id);
    const second = await batchWith(db, [{ mid: "OV-1", residual: "80.00" }], { period: first.period, replaces: first.id });
    const result = await commit(db, second.id);
    expect(result).toMatchObject({ replaced_lines: 3, overrides: 1 });
    expect(await linesOf(db, first.id)).toEqual([]);
    expect((await linesOf(db, second.id)).map((l) => [l.agent_id, l.override_role, l.override_id, l.payout])).toEqual([
      [AGENT_ID, null, null, "40.00"],
      [MANAGER_ID, "credit", ov, "8.00"],
      [AGENT_ID, "debit", ov, "-8.00"],
    ]);
  });

  it("delete_payout_period removes the month's override lines with its import lines", async () => {
    const m = await merchant(db, "OV-1");
    const { id, period } = await batchWith(db, [{ mid: "OV-1" }]);
    const ov = await plant(db, m, 10, period);
    await commit(db, id);
    await asUser(db, ADMIN_ID);
    const [{ result }] = await rows<{ result: { deleted: number } }>(
      db,
      `select delete_payout_period('${period}', 'TSYS') as result`,
    );
    await asPlatform(db);
    expect(result.deleted).toBe(3);
    expect(await rows(db, `select id from rep_payout_rows where override_id = ${ov}`)).toEqual([]);
    expect(await rpc(db, `select cancel_merchant_override(${ov})`)).toBeNull();
  });

  it("a committed month is never changed by editing the override afterwards", async () => {
    const m = await merchant(db, "OV-1");
    const { id, period } = await batchWith(db, [{ mid: "OV-1" }]);
    const ov = await plant(db, m, 10, period);
    await commit(db, id);
    const before = await linesOf(db, id);
    const later = (n: number) => `(date '${period}' + interval '${n} month')::date`;
    expect(await rpc(db, `select end_merchant_override(${ov}, ${later(1)})`)).toBeNull();
    expect(await rpc(db, `select set_merchant_override(${m}, '${OTHER_AGENT_ID}', 20, ${later(2)})`)).toBeNull();
    expect((await rpc(db, `select set_merchant_override(${m}, '${OTHER_AGENT_ID}', 20, '${period}')`))?.code).toBe("PT409");
    expect(await linesOf(db, id)).toEqual(before);
  });
});

// -------------------------------------------------------------------------
// 5. The invariant, over many random cases through the real commit
// -------------------------------------------------------------------------

/** Whole-cent rounding, half away from zero: Postgres round(numeric, 2). */
function roundAway(numerator: number, denominator: number): number {
  const sign = Math.sign(numerator);
  const n = Math.abs(numerator);
  return sign * Math.floor((2 * n + denominator) / (2 * denominator)) || 0;
}

/** shared_part's cent rule: nearest cent, an exact half toward zero. */
function part(totalCents: number, partHundredths: number, wholeHundredths: number): number {
  const n = Math.abs(totalCents) * partHundredths;
  return Math.sign(totalCents) * Math.floor((2 * n + wholeHundredths - 1) / (2 * wholeHundredths)) || 0;
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

type Case = { r: number; s: number; o: number; b: number | null };

/**
 * Random cases (rates, percents and residuals in hundredths and cents), every
 * one mirrored at -R, plus fixed cases for the edges the random ones rarely
 * hit: o = s, half-cent ties on the partner's piece, one cent, zero.
 */
function cases(seed: number, count: number): Case[] {
  const rand = prng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const out: Case[] = [
    { r: 10000, s: 5000, o: 1000, b: null },
    { r: 10, s: 5000, o: 1000, b: 2500 }, // X = 0.01, partner's piece a tie (0.005 -> 0)
    { r: 30, s: 5000, o: 5000, b: 2500 }, // o = s; X = T = 0.15, partner 0.07 (tie)
    { r: 3333, s: 3000, o: 3000, b: 1000 }, // o = s on a shared account
    { r: 1, s: 5000, o: 4999, b: 4999 },
    { r: 0, s: 5000, o: 1000, b: 2500 },
    { r: -1176, s: 4600, o: 333, b: null },
  ];
  while (out.length < count) {
    const s = rand() < 0.3 ? [5000, 4600, 3000, 1].at(int(0, 3))! : int(1, 5000);
    const o = rand() < 0.15 ? s : int(1, s);
    const shared = s >= 2 && rand() < 0.5;
    const b = shared ? int(1, s - 1) : null;
    const r = rand() < 0.2 ? int(-200, 200) : int(-5_000_000, 5_000_000);
    out.push({ r, s, o, b });
  }
  return out.flatMap((c) => [c, { ...c, r: -c.r }]);
}

/** Every way the committed lines break the invariant. Empty when the money is right. */
async function propertyCheck(target: TestDb, seed: number, count: number): Promise<string[]> {
  const list = cases(seed, count);
  const period = await nextMonth(target);
  await asPlatform(target);
  const money = (c: number) => (c / 100).toFixed(2);
  const pct = (h: number) => (h / 100).toFixed(2);
  await target.exec(`
    insert into merchants (agent_id, mid, dba, status, processor, split_agent_pct, split_company_pct, city, state)
    values ${list.map((c, i) => `('${AGENT_ID}', 'P-${i}', 'P ${i}', 'active', 'TSYS', ${pct(c.s)}, ${pct(10000 - c.s)}, 'Nashville', 'TN')`).join(",")}`);
  await target.exec(`
    insert into merchant_overrides (merchant_id, recipient_id, override_pct, effective_from)
    select id, '${MANAGER_ID}', v.o, '${period}'
      from merchants m join (values ${list.map((c, i) => `('P-${i}', ${pct(c.o)})`).join(",")}) as v(mid, o) on v.mid = m.mid`);
  const shared = list.map((c, i) => [c, i] as const).filter(([c]) => c.b !== null);
  if (shared.length > 0) {
    await target.exec(`
      insert into merchant_rep_shares (merchant_id, primary_agent_id, secondary_agent_id, primary_rep_pct, secondary_rep_pct, effective_from)
      select m.id, '${AGENT_ID}', '${OTHER_AGENT_ID}', v.a, v.b, '${period}'
        from merchants m join (values ${shared.map(([c, i]) => `('P-${i}', ${pct(c.s - c.b!)}, ${pct(c.b!)})`).join(",")}) as v(mid, a, b) on v.mid = m.mid`);
  }
  const { id } = await batchWith(
    target,
    list.map((c, i) => ({ mid: `P-${i}`, residual: money(c.r), volume: "99999999.00" })),
    { period },
  );
  const result = await commit(target, id);

  const lines = await rows<{ mid: string; agent_id: string; line_kind: string; role: string | null; payout: string; share_role: string | null }>(
    target,
    `select mid, agent_id, line_kind, override_role as role, rep_payout::text as payout, share_role
       from rep_payout_rows where batch_id = ${id}`,
  );
  const byMid = new Map<string, typeof lines>();
  for (const line of lines) byMid.set(line.mid, [...(byMid.get(line.mid) ?? []), line]);
  const cents = (v: string | undefined) => (v === undefined ? NaN : Math.round(Number(v) * 100));

  const wrong: string[] = [];
  const nets: number[][] = [];
  for (const [i, c] of list.entries()) {
    const mine = byMid.get(`P-${i}`) ?? [];
    const pick = (agent: string, kind: string, role: string | null = null) =>
      mine.filter((l) => l.agent_id === agent && l.line_kind === kind && l.role === role).map((l) => cents(l.payout));
    const t = roundAway(c.r * c.s, 10000);
    const x = roundAway(c.r * c.o, 10000);
    const [signerT = 0] = pick(AGENT_ID, "import");
    const [partnerT = 0] = c.b === null ? [0] : pick(OTHER_AGENT_ID, "import");
    const [signerD] = pick(AGENT_ID, "override", "debit");
    const [partnerD = 0] = c.b === null ? [0] : pick(OTHER_AGENT_ID, "override", "debit");
    const [credit] = pick(MANAGER_ID, "override", "credit");
    const label = `case ${i} ${JSON.stringify(c)}`;

    if (mine.length !== (c.b === null ? 3 : 5)) wrong.push(`${label}: ${mine.length} lines`);
    if (credit !== x) wrong.push(`${label}: credit ${credit} != X ${x}`);
    if (signerD + partnerD + credit !== 0) wrong.push(`${label}: debits + credit = ${signerD + partnerD + credit}`);
    if (signerT + partnerT !== t) wrong.push(`${label}: rep side ${signerT + partnerT} != T ${t}`);
    // Rep lines plus the override equal the merchant's rate amount exactly,
    // so the company's R - T never moves.
    const signerNet = signerT + signerD;
    const partnerNet = partnerT + partnerD;
    if (signerNet + partnerNet + credit !== t) wrong.push(`${label}: nets + override = ${signerNet + partnerNet + credit} != T ${t}`);
    if (c.b !== null && -partnerD !== part(x, c.b, c.s)) wrong.push(`${label}: partner's piece ${-partnerD} != ${part(x, c.b, c.s)}`);
    if (c.o === c.s && (signerNet !== 0 || partnerNet !== 0)) wrong.push(`${label}: o = s leaves ${signerNet}/${partnerNet}`);
    if (Math.sign(signerNet) * Math.sign(signerT) === -1) wrong.push(`${label}: signer's net has the wrong sign`);
    if (Math.sign(partnerNet) * Math.sign(partnerT) === -1) wrong.push(`${label}: partner's net has the wrong sign`);
    nets.push([signerNet, partnerNet, credit]);
  }
  // f(-R) = -f(R): cases come in mirrored pairs.
  for (let i = 0; i < nets.length; i += 2) {
    if (nets[i].some((v, k) => v !== -nets[i + 1][k] && !(v === 0 && nets[i + 1][k] === 0))) {
      wrong.push(`case ${i}: not odd in R (${nets[i]} vs ${nets[i + 1]})`);
    }
  }
  if (result.overrides !== list.length) wrong.push(`overrides ${result.overrides} for ${list.length} rows`);
  return wrong;
}

describe("the invariant, over many random cases through commit v3", () => {
  it("rep lines + override = T to the cent, debits + credit = 0, odd in R, o = s nets zero, no sign flips", async () => {
    expect(await propertyCheck(db, 20261102, 200)).toEqual([]);
  });

  it("holds for a second seed (another 400 cases)", async () => {
    expect(await propertyCheck(db, 7, 200)).toEqual([]);
  });
});

// -------------------------------------------------------------------------
// 6. Visibility (A4c)
// -------------------------------------------------------------------------

describe("who sees what", () => {
  async function committed(): Promise<{ m: number; ov: number; batch: number }> {
    const m = await merchant(db, "OV-1");
    const { id, period } = await batchWith(db, [{ mid: "OV-1" }]);
    const ov = await plant(db, m, 10, period);
    await commit(db, id);
    return { m, ov, batch: id };
  }

  const ownLines = async (who: string) => {
    await asUser(db, who);
    try {
      return await rows<{ line_kind: string; role: string | null; payout: string; merchant_name: string }>(
        db,
        `select line_kind, override_role as role, rep_payout::text as payout, merchant_name
           from rep_payout_rows where line_kind <> 'import' or agent_id = '${who}' order by id`,
      );
    } finally {
      await asPlatform(db);
    }
  };

  it("the rep reads their own debit; the recipient their credit, with the merchant's name as text; nobody else either", async () => {
    await committed();
    expect(await ownLines(AGENT_ID)).toEqual([
      { line_kind: "import", role: null, payout: "50.00", merchant_name: "OV-1 Co" },
      { line_kind: "override", role: "debit", payout: "-10.00", merchant_name: "OV-1 Co" },
    ]);
    expect(await ownLines(MANAGER_ID)).toEqual([
      { line_kind: "override", role: "credit", payout: "10.00", merchant_name: "OV-1 Co" },
    ]);
    expect(await ownLines(OTHER_AGENT_ID)).toEqual([]);
  });

  it("the recipient cannot read the merchant, by id or by MID; no merchants policy was widened", async () => {
    const { m } = await committed();
    await asUser(db, MANAGER_ID);
    expect(await rows(db, `select id from merchants where id = ${m} or mid = 'OV-1'`)).toEqual([]);
    await asPlatform(db);
    expect(
      await rows(db, `select count(*)::int as n from pg_policy
                        where polrelid = 'public.merchants'::regclass
                          and (pg_get_expr(polqual, polrelid) ilike '%override%'
                               or pg_get_expr(polwithcheck, polrelid) ilike '%override%')`),
    ).toEqual([{ n: 0 }]);
  });

  it("my_override_recipients: the rep gets exactly override_id, recipient_name and override_pct, for their own debits", async () => {
    const { ov } = await committed();
    await asUser(db, AGENT_ID);
    const [{ result }] = await rows<{ result: unknown }>(db, `select my_override_recipients() as result`);
    expect(result).toEqual([{ override_id: ov, recipient_name: MANAGER_NAME, override_pct: 10 }]);
    for (const who of [MANAGER_ID, OTHER_AGENT_ID, ADMIN_ID]) {
      await asUser(db, who);
      const [{ result: none }] = await rows<{ result: unknown }>(db, `select my_override_recipients() as result`);
      expect(none).toEqual([]);
    }
    await asPlatform(db);
  });

  it("my_override_recipients refuses a deactivated caller (PT403) and anon (no EXECUTE)", async () => {
    await committed();
    await db.exec(`update profiles set is_active = false where id = '${AGENT_ID}'`);
    expect((await rpc(db, `select my_override_recipients()`, AGENT_ID))?.code).toBe("PT403");
    await asUser(db, null);
    await db.exec(`set role anon`);
    expect((await attempt(() => db.query(`select my_override_recipients()`)))?.message)
      .toMatch(/permission denied for function my_override_recipients/);
    await asPlatform(db);
  });

  it("no client changes an override line: the figures are CHECKed off it, the override columns are not granted", async () => {
    const { batch } = await committed();
    const [{ id }] = await rows<{ id: number }>(db, `select id from rep_payout_rows where batch_id = ${batch} and override_role = 'credit'`);
    let error = await rpc(db, `update rep_payout_rows set residual_income = 5 where id = ${id}`);
    expect(error?.message).toContain("rep_payout_rows_adjustment_no_figures");
    error = await rpc(db, `update rep_payout_rows set rep_split_pct = 50 where id = ${id}`);
    expect(error?.message).toContain("rep_payout_rows_adjustment_no_figures");
    error = await rpc(db, `update rep_payout_rows set override_amount = 99 where id = ${id}`);
    expect(error?.message).toMatch(/permission denied/);
    error = await rpc(db, `delete from rep_payout_rows where id = ${id}`);
    expect(error?.message).toMatch(/permission denied/);
  });
});

// -------------------------------------------------------------------------
// 7. The ledger and the migration
// -------------------------------------------------------------------------

describe("the ledger CHECKs", () => {
  const base = `agent_id, period, processor, mid, line_kind, override_id, override_role, override_amount, batch_id`;
  async function tryLine(values: string): Promise<DbError | null> {
    await asPlatform(db);
    return attempt(() => db.query(`insert into rep_payout_rows (${base}) values (${values})`));
  }

  it("the override columns come together, on override lines only, with a batch and a processor", async () => {
    const m = await merchant(db, "OV-1");
    const ov = await plant(db, m, 10, "2030-01-01");
    const batch = await insertBatch(db);
    const ok = `'${AGENT_ID}', '2030-01-01', 'TSYS', 'OV-1', 'override', ${ov}, 'debit', -1, ${batch}`;
    expect(await tryLine(ok)).toBeNull();
    for (const [values, constraint] of [
      [`'${AGENT_ID}', '2030-01-01', 'TSYS', 'OV-1', 'override', null, 'debit', -1, ${batch}`, "rep_payout_rows_override_columns"],
      [`'${AGENT_ID}', '2030-01-01', 'TSYS', 'OV-1', 'override', ${ov}, null, -1, ${batch}`, "rep_payout_rows_override_columns"],
      [`'${AGENT_ID}', '2030-01-01', null, 'OV-1', 'override', ${ov}, 'credit', 1, ${batch}`, "rep_payout_rows_override_columns"],
      [`'${AGENT_ID}', '2030-01-01', 'TSYS', 'OV-1', 'override', ${ov}, 'credit', 1, null`, "rep_payout_rows_adjustment_no_figures"],
      [`'${AGENT_ID}', '2030-01-01', 'TSYS', 'OV-1', 'import', ${ov}, 'debit', -1, ${batch}`, "rep_payout_rows_override_columns"],
      [`'${AGENT_ID}', '2030-01-01', 'TSYS', 'OV-1', 'override', ${ov}, 'refund', 1, ${batch}`, "rep_payout_rows_override_role"],
      [`'${OTHER_AGENT_ID}', '2030-01-01', 'TSYS', 'OV-1', 'override', ${ov}, 'debit', -1, ${batch}`, null],
      [`'${AGENT_ID}', '2030-01-01', 'TSYS', 'OV-1', 'override', ${ov}, 'debit', -2, ${batch}`, "rep_payout_rows_override_line_key"],
    ] as const) {
      const error = await tryLine(values);
      if (constraint === null) expect(error).toBeNull();
      else expect(error?.message).toContain(constraint);
    }
  });

  it("an adjustment still carries no batch, and an override line no figure", async () => {
    const batch = await insertBatch(db);
    await asPlatform(db);
    const adj = await attempt(() => db.query(
      `insert into rep_payout_rows (agent_id, period, mid, line_kind, adjustment_amount, adjusts_period, batch_id)
       values ('${AGENT_ID}', '2030-01-01', 'X', 'adjustment', 1, '2029-12-01', ${batch})`));
    expect(adj?.message).toContain("rep_payout_rows_adjustment_no_figures");
    const m = await merchant(db, "OV-1");
    const ov = await plant(db, m, 10, "2030-01-01");
    const fig = await attempt(() => db.query(
      `insert into rep_payout_rows (agent_id, period, processor, mid, line_kind, override_id, override_role, override_amount, batch_id, volume)
       values ('${AGENT_ID}', '2030-01-01', 'TSYS', 'OV-1', 'override', ${ov}, 'debit', -1, ${batch}, 10)`));
    expect(fig?.message).toContain("rep_payout_rows_adjustment_no_figures");
  });

  it("an override a line references cannot be deleted (ON DELETE RESTRICT), nor its merchant", async () => {
    const m = await merchant(db, "OV-1");
    const { id, period } = await batchWith(db, [{ mid: "OV-1" }]);
    const ov = await plant(db, m, 10, period);
    await commit(db, id);
    expect((await attempt(() => db.query(`delete from merchant_overrides where id = ${ov}`)))?.message)
      .toContain("rep_payout_rows_override_id_fkey");
    await db.exec(`delete from rep_payout_rows where override_id = ${ov}`);
    expect((await attempt(() => db.query(`delete from merchants where id = ${m}`)))?.message)
      .toContain("merchant_overrides_merchant_id_fkey");
  });
});

describe("grants and catalog", () => {
  const FUNCTIONS = [
    "set_merchant_override(int, uuid, numeric, date)",
    "end_merchant_override(int, date)",
    "cancel_merchant_override(int)",
    "my_override_recipients()",
    "delete_payout_period(date, text)",
    "set_merchant_split(int, numeric)",
    "set_merchant_rep_share(int, uuid, uuid, numeric, numeric, date)",
    "commit_residual_import_v3(int, text[])",
  ];

  it("every function is definer with a pinned search_path, executable by authenticated and service_role, never anon", async () => {
    for (const fn of FUNCTIONS) {
      const [row] = await rows<{ definer: boolean; config: string[] | null; anon: boolean; auth: boolean; svc: boolean }>(
        db,
        `select prosecdef as definer, proconfig as config,
                has_function_privilege('anon', '${fn}'::regprocedure, 'execute') as anon,
                has_function_privilege('authenticated', '${fn}'::regprocedure, 'execute') as auth,
                has_function_privilege('service_role', '${fn}'::regprocedure, 'execute') as svc
           from pg_proc where oid = '${fn}'::regprocedure`,
      );
      expect({ fn, ...row }).toMatchObject({ fn, definer: true, anon: false, auth: true, svc: true });
      expect(row.config?.some((c) => c.startsWith("search_path="))).toBe(true);
    }
  });

  it("each override function checks is_admin() first, and the migration revokes before it grants", async () => {
    const text = await readMigration(MIGRATION);
    for (const name of ["set_merchant_override", "end_merchant_override", "cancel_merchant_override"]) {
      const [{ def }] = await rows<{ def: string }>(db, `select prosrc as def from pg_proc where proname = '${name}'`);
      expect(def).toMatch(/^\s*declare[\s\S]*?\bbegin\s+if not is_admin\(\) then/);
      const revoke = text.indexOf(`revoke all on function ${name}(`);
      const grant = text.indexOf(`grant execute on function ${name}(`);
      expect(revoke).toBeGreaterThan(-1);
      expect(grant).toBeGreaterThan(revoke);
    }
  });

  it("the live-override helper is callable by no client", async () => {
    for (const role of ["anon", "authenticated"]) {
      expect(
        await rows(db, `select has_function_privilege('${role}', 'merchant_has_live_override(int)', 'execute') as ok`),
      ).toEqual([{ ok: false }]);
    }
  });
});

describe("the migration over a populated database", () => {
  async function populated(): Promise<TestDb> {
    const target = await open(await migrationsBefore(MIGRATION));
    await resetData(target);
    await asPlatform(target);
    // An import line, a shared pair's worth of plain lines, a null-figure
    // line and an adjustment: every shape the ledger can hold before.
    await target.exec(`
      insert into rep_payout_rows (agent_id, period, processor, mid, merchant_name, residual_income, rep_split_pct, volume)
      values ('${AGENT_ID}', '2026-07-01', 'TSYS', 'MID-AGENT-1', 'A', 88.40, 50, 100),
             ('${AGENT_ID}', '2026-07-01', 'TSYS', 'MID-AGENT-2', 'B', null, null, 100),
             ('${OTHER_AGENT_ID}', '2026-07-01', 'TSYS', 'MID-OTHER-1', 'C', -11.77, 46.5, 100);
      insert into rep_payout_rows (agent_id, period, mid, line_kind, adjustment_amount, adjusts_period, adjustment_note)
      values ('${AGENT_ID}', '2026-08-01', 'MID-AGENT-1', 'adjustment', -3.21, '2026-07-01', 'x');`);
    return target;
  }

  const payouts = (target: TestDb) =>
    rows(target, `select id, line_kind, rep_payout::text as payout from rep_payout_rows order by id`);

  it("applies over existing lines and changes no payout", async () => {
    const target = await populated();
    const before = await payouts(target);
    await target.exec(await readMigration(MIGRATION));
    expect(await payouts(target)).toEqual(before);
    expect(before.length).toBe(4);
  });

  it("refuses, naming it, a line_kind CHECK that is not the one it expects -- and changes nothing", async () => {
    const target = await populated();
    await target.exec(`alter table rep_payout_rows drop constraint rep_payout_rows_line_kind;
                       alter table rep_payout_rows add constraint rep_payout_rows_line_kind
                         check (line_kind in ('import', 'adjustment', 'bonus'));`);
    const error = await attempt(async () => target.exec(await readMigration(MIGRATION)));
    expect(error?.message).toMatch(/^rep_payout_rows_line_kind is not \(import, adjustment\) here \(found: CHECK/);
    expect(await rows(target, `select to_regclass('public.merchant_overrides') as t`)).toEqual([{ t: null }]);
  });

  it("refuses when something depends on rep_payout, naming the count, rather than dropping it", async () => {
    const target = await populated();
    await target.exec(`create view payout_view as select id, rep_payout from rep_payout_rows;`);
    const error = await attempt(async () => target.exec(await readMigration(MIGRATION)));
    expect(error?.message).toMatch(/^rep_payout_rows\.rep_payout has \d+ dependent object\(s\) besides its own expression/);
    expect(await rows(target, `select count(*)::int as n from payout_view`)).toEqual([{ n: 4 }]);
  });

  it("refuses an adjustment CHECK it does not expect, naming it", async () => {
    const target = await populated();
    await target.exec(`alter table rep_payout_rows drop constraint rep_payout_rows_adjustment_no_figures;
                       alter table rep_payout_rows add constraint rep_payout_rows_adjustment_no_figures
                         check (line_kind = 'import' or residual_income is null);`);
    const error = await attempt(async () => target.exec(await readMigration(MIGRATION)));
    expect(error?.message).toMatch(/^rep_payout_rows_adjustment_no_figures is not the 20261016160000 CHECK here/);
  });
});

// -------------------------------------------------------------------------
// 8. Mutation proofs
// -------------------------------------------------------------------------

describe("mutation proofs: each protection is what stops its case", () => {
  let mutant: TestDb;
  const MUTATED = [
    "set_merchant_override(int, uuid, numeric, date)",
    "end_merchant_override(int, date)",
    "cancel_merchant_override(int)",
    "my_override_recipients()",
    "delete_payout_period(date, text)",
    "set_merchant_split(int, numeric)",
    "set_merchant_rep_share(int, uuid, uuid, numeric, numeric, date)",
    "guard_merchant_split_and_owner()",
    `${V3}(int, text[])`,
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
    await addManager(mutant);
    // Every test starts from the real functions: a mutant never outlives its test.
    for (const def of originals) await mutant.exec(def);
  });

  /** Re-creates `fn` from its own definition with one fragment replaced. */
  async function without(fn: string, fragment: string, replacement = ""): Promise<void> {
    await asPlatform(mutant);
    const [{ def }] = await rows<{ def: string }>(
      mutant,
      `select pg_get_functiondef('${fn}'::regprocedure) as def`,
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

  it("the cap in set_merchant_override", async () => {
    await without("set_merchant_override(int, uuid, numeric, date)",
      "if override_pct_input > m.split_agent_pct then", "if false then");
    await swap(async () => {
      const m = await merchant(db, "OV-1", { rate: 30 });
      expect(await rpc(db, `select set_merchant_override(${m}, '${MANAGER_ID}', 40, '2030-01-01')`)).toBeNull();
    });
  });

  it("the recipient's active check in set_merchant_override", async () => {
    await without("set_merchant_override(int, uuid, numeric, date)", "if not recipient.is_active then", "if false then");
    await swap(async () => {
      const m = await merchant(db, "OV-1");
      await db.exec(`update profiles set is_active = false where id = '${MANAGER_ID}'`);
      expect(await rpc(db, `select set_merchant_override(${m}, '${MANAGER_ID}', 5, '2030-01-01')`)).toBeNull();
    });
  });

  it("the owner check in set_merchant_override", async () => {
    await without("set_merchant_override(int, uuid, numeric, date)", "if recipient.id = m.agent_id then", "if false then");
    await swap(async () => {
      const m = await merchant(db, "OV-1");
      expect(await rpc(db, `select set_merchant_override(${m}, '${AGENT_ID}', 5, '2030-01-01')`)).toBeNull();
    });
  });

  it("the share-party check in set_merchant_override", async () => {
    await without("set_merchant_override(int, uuid, numeric, date)",
      "recipient.id in (s.primary_agent_id, s.secondary_agent_id)", "false");
    await swap(async () => {
      const m = await merchant(db, "OV-1");
      await share(db, m, 40, 10, "2030-01-01");
      expect(await rpc(db, `select set_merchant_override(${m}, '${OTHER_AGENT_ID}', 5, '2030-03-01')`)).toBeNull();
    });
  });

  it("the month rule in set_merchant_override", async () => {
    await without("set_merchant_override(int, uuid, numeric, date)",
      "if latest is not null and effective_from_input <= latest then", "if false then");
    await swap(async () => {
      const m = await merchant(db, "OV-1");
      const { id, period } = await batchWith(db, [{ mid: "OV-1" }]);
      await commit(db, id);
      expect(await rpc(db, `select set_merchant_override(${m}, '${MANAGER_ID}', 5, '${period}')`)).toBeNull();
    });
  });

  it("the pre-app check in set_merchant_override", async () => {
    await without("set_merchant_override(int, uuid, numeric, date)", "if m.pre_app_id is not null then", "if false then");
    await swap(async () => {
      const m = await merchant(db, "OV-1");
      await db.exec(`update merchants set pre_app_id = (select id from pre_apps where status = 'draft' limit 1) where id = ${m}`);
      expect(await rpc(db, `select set_merchant_override(${m}, '${MANAGER_ID}', 5, '2030-01-01')`)).toBeNull();
    });
  });

  it("the is_admin() guard in set_merchant_override", async () => {
    await without("set_merchant_override(int, uuid, numeric, date)", "if not is_admin() then", "if false then");
    await swap(async () => {
      const m = await merchant(db, "OV-1");
      expect(await rpc(db, `select set_merchant_override(${m}, '${MANAGER_ID}', 5, '2030-01-01')`, AGENT_ID)).toBeNull();
    });
  });

  it("the is_admin() guards in end and cancel", async () => {
    await without("end_merchant_override(int, date)", "if not is_admin() then", "if false then");
    await without("cancel_merchant_override(int)", "if not is_admin() then", "if false then");
    await swap(async () => {
      const m = await merchant(db, "OV-1");
      const a = await plant(db, m, 5, "2030-01-01");
      expect(await rpc(db, `select end_merchant_override(${a}, '2030-03-01')`, AGENT_ID)).toBeNull();
      expect(await rpc(db, `select cancel_merchant_override(${a})`, AGENT_ID)).toBeNull();
    });
  });

  it("the line check in cancel_merchant_override (the FK then refuses the delete)", async () => {
    await without("cancel_merchant_override(int)",
      "if exists (select 1 from rep_payout_rows where override_id = o.id)\n     or (latest is not null and o.effective_from <= latest) then",
      "if false then");
    await swap(async () => {
      const m = await merchant(db, "OV-1");
      const { id, period } = await batchWith(db, [{ mid: "OV-1" }]);
      const ov = await plant(db, m, 10, period);
      await commit(db, id);
      const error = await rpc(db, `select cancel_merchant_override(${ov})`);
      expect(error?.message).toContain("rep_payout_rows_override_id_fkey");
    });
  });

  it("A29 in set_merchant_split", async () => {
    await without("set_merchant_split(int, numeric)", "and o.override_pct > rate_input", "and false");
    await swap(async () => {
      const m = await merchant(db, "OV-1");
      await plant(db, m, 30, "2030-01-01");
      expect(await rpc(db, `select set_merchant_split(${m}, 10)`)).toBeNull();
    });
  });

  it("the move refusal in guard_merchant_split_and_owner", async () => {
    await without("guard_merchant_split_and_owner()",
      "and merchant_has_live_override(old.id) then", "and false then");
    await swap(async () => {
      const m = await merchant(db, "OV-1");
      await plant(db, m, 10, "2030-01-01");
      await db.exec(`update merchants set agent_id = '${OTHER_AGENT_ID}' where id = ${m}`);
    });
  });

  it("the recipient check in set_merchant_rep_share", async () => {
    await without("set_merchant_rep_share(int, uuid, uuid, numeric, numeric, date)",
      "if recipient is not null then", "if false then");
    await swap(async () => {
      const m = await merchant(db, "OV-1");
      await plant(db, m, 10, "2030-01-01", { recipient: OTHER_AGENT_ID });
      expect(await rpc(db, `select set_merchant_rep_share(${m}, '${AGENT_ID}', '${OTHER_AGENT_ID}', 40, 10, '2030-02-01')`)).toBeNull();
    });
  });

  it("v3's cap backstop", async () => {
    await without(`${V3}(int, text[])`, "and o.override_pct > m.split_agent_pct", "and false");
    await swap(async () => {
      const m = await merchant(db, "OV-1", { rate: 50 });
      const { id, period } = await batchWith(db, [{ mid: "OV-1" }]);
      await plant(db, m, 40, period);
      await db.exec(`set session_replication_role = replica;
        update merchants set split_agent_pct = 30, split_company_pct = 70 where id = ${m};
        set session_replication_role = origin;`);
      expect((await commit(db, id)).overrides).toBe(1);
    });
  });

  it("v3's deactivated-recipient backstop", async () => {
    await without(`${V3}(int, text[])`, "and not p.is_active", "and false");
    await swap(async () => {
      const m = await merchant(db, "OV-1");
      const { id, period } = await batchWith(db, [{ mid: "OV-1" }]);
      await plant(db, m, 10, period);
      await db.exec(`update profiles set is_active = false where id = '${MANAGER_ID}'`);
      expect((await commit(db, id)).overrides).toBe(1);
    });
  });

  it("v3's party backstop (the line key then lets the owner be paid their own override)", async () => {
    await without(`${V3}(int, text[])`, "and (o.recipient_id = m.agent_id\n", "and false and (o.recipient_id = m.agent_id\n");
    await swap(async () => {
      const m = await merchant(db, "OV-1");
      const { id, period } = await batchWith(db, [{ mid: "OV-1" }]);
      await plant(db, m, 10, period, { recipient: AGENT_ID });
      expect((await commit(db, id)).overrides).toBe(1);
    });
  });

  it("the signer's debit (a debit of the whole X breaks debits + credit = 0)", async () => {
    await without(`${V3}(int, text[])`, "'debit' as role, -(x - partner_piece) as amount", "'debit' as role, -x as amount");
    await swap(async () => {
      const wrong = await propertyCheck(db, 11, 40);
      expect(wrong.some((w) => w.includes("debits + credit"))).toBe(true);
    });
  });

  it("the cent rule on the partner's piece (round half away instead of shared_part fails at the ties)", async () => {
    await without(
      `${V3}(int, text[])`,
      "shared_part(a.x, a.secondary_rep_pct,\n                                 a.primary_rep_pct + a.secondary_rep_pct)",
      "round(a.x * a.secondary_rep_pct / (a.primary_rep_pct + a.secondary_rep_pct), 2)",
    );
    await swap(async () => {
      const wrong = await propertyCheck(db, 11, 40);
      expect(wrong.some((w) => w.includes("partner's piece"))).toBe(true);
    });
  });

  it("X from the full residual (not from the rate amount)", async () => {
    await without(`${V3}(int, text[])`,
      "round(r.residual_income * o.override_pct / 100, 2) as x",
      "round(round(r.residual_income * m.split_agent_pct / 100, 2) * o.override_pct / m.split_agent_pct, 2) as x");
    await swap(async () => {
      const wrong = await propertyCheck(db, 11, 40);
      expect(wrong.some((w) => w.includes("!= X"))).toBe(true);
    });
  });

  it("the override lines in delete_payout_period", async () => {
    await without("delete_payout_period(date, text)", "line_kind in ('import', 'override')", "line_kind = 'import'");
    await swap(async () => {
      const m = await merchant(db, "OV-1");
      const { id, period } = await batchWith(db, [{ mid: "OV-1" }]);
      await plant(db, m, 10, period);
      await commit(db, id);
      await asUser(db, ADMIN_ID);
      await db.query(`select delete_payout_period('${period}', 'TSYS')`);
      await asPlatform(db);
      expect(await rows(db, `select count(*)::int as n from rep_payout_rows where line_kind = 'override'`)).toEqual([{ n: 2 }]);
    });
  });

  it("the caller filter in my_override_recipients", async () => {
    await without("my_override_recipients()", "and l.agent_id = caller", "");
    await swap(async () => {
      const m = await merchant(db, "OV-1");
      const { id, period } = await batchWith(db, [{ mid: "OV-1" }]);
      await plant(db, m, 10, period);
      await commit(db, id);
      await asUser(db, OTHER_AGENT_ID);
      const [{ result }] = await rows<{ result: unknown[] }>(db, `select my_override_recipients() as result`);
      await asPlatform(db);
      expect(result.length).toBe(1);
    });
  });
});
