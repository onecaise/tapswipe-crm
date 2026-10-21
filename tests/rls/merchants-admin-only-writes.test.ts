import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_ID,
  AGENT_ID,
  AGENT_NUMBER,
  OTHER_AGENT_ID,
  PAYOUT_PERIOD,
  asPlatform,
  asUser,
  createTestDb,
  migrationsBefore,
  resetData,
  rows,
  seedPayouts,
  type TestDb,
} from "../helpers/db";

/**
 * Security fix, phase 1 (docs/claude/security-fixes.md): merchants are
 * admin-only to change.
 *
 * The attack this file reproduces end to end. commit_residual_import_v2 finds
 * the share covering a staged row by the merchant's CURRENT mid
 * (`left join merchants m on m.mid = r.mid_raw`). A rep who could update their
 * own merchant could append a trailing space to its mid while an admin had a
 * month in review; the signer's row then matched no merchant, committed as an
 * ordinary unshared line, and the partner got nothing. The rep restores the
 * mid afterwards, and log_cross_agent_change() records nothing, because the
 * editor owns the row.
 */

const FIX_MIGRATION = "20261021120000_merchants_admin_only_writes.sql";

const PARTNER_ID = "55555555-5555-5555-5555-555555555555";
const PARTNER_NUMBER = "5555";
const SHARED_MID = "MID-AGENT-2";

let db: TestDb;

async function addPartner(target: TestDb): Promise<void> {
  await asPlatform(target);
  await target.exec(`
    insert into auth.users (id, email) values ('${PARTNER_ID}', 'partner@tapswipe.test');
    insert into profiles (id, full_name, email, role, is_active, agent_number)
    values ('${PARTNER_ID}', 'Partner Agent', 'partner@tapswipe.test', 'agent', true, '${PARTNER_NUMBER}');
  `);
}

/** Signer AGENT 40%, partner 10%, on MID-AGENT-2 from July 2026. */
async function shareMerchant(target: TestDb): Promise<void> {
  await asUser(target, ADMIN_ID);
  await target.query(
    `select set_merchant_rep_share(
       (select id from merchants where mid = '${SHARED_MID}'),
       '${AGENT_ID}', '${PARTNER_ID}', 40, 10, '${PAYOUT_PERIOD}')`,
  );
  await asPlatform(target);
}

/**
 * One signer row in review for the shared MID -- what parse-residual-import
 * (service role) stages from the processor file.
 */
async function stageSignerRow(target: TestDb): Promise<number> {
  await asPlatform(target);
  const [{ id }] = await rows<{ id: number }>(
    target,
    `insert into rep_payout_batches (imported_by, file_key, file_name, status)
     values ('${ADMIN_ID}', 'test/file.xlsx', 'file.xlsx', 'review')
     returning id`,
  );
  await target.exec(`
    insert into rep_payout_import_rows
      (batch_id, row_number, agent_number_raw, mid_raw, merchant_name_raw,
       period, agent_id, merchant_id, volume, average_ticket, total_cost,
       residual_income, rep_split_pct)
    values (${id}, 2, '${AGENT_NUMBER}', '${SHARED_MID}', 'Agent Inactive Co',
       '${PAYOUT_PERIOD}', '${AGENT_ID}',
       (select id from merchants where mid = '${SHARED_MID}'),
       5100.00, 10.00, 25.00, 200.00, 50.00);
  `);
  return id;
}

type Line = { agent_id: string; share_role: string | null; rep_share_id: number | null };

async function ledgerLines(target: TestDb): Promise<Line[]> {
  await asPlatform(target);
  return rows<Line>(
    target,
    `select agent_id, share_role, rep_share_id from rep_payout_rows
      where mid = '${SHARED_MID}' and period = '${PAYOUT_PERIOD}'
      order by share_role nulls last, agent_id`,
  );
}

/**
 * The attack, step by step. Returns how many rows the rep's two MID edits
 * touched and what the commit wrote.
 */
async function runAttack(target: TestDb): Promise<{ touched: number[]; lines: Line[] }> {
  await addPartner(target);
  await shareMerchant(target);
  const batch = await stageSignerRow(target);

  // 1. While the month is in review, the signer pads their merchant's MID.
  await asUser(target, AGENT_ID);
  const pad = await target.query(
    `update merchants set mid = '${SHARED_MID} ' where mid = '${SHARED_MID}'`,
  );

  // 2. The admin commits the month.
  await asUser(target, ADMIN_ID);
  await target.query(`select commit_residual_import_v2(${batch})`);

  // 3. The signer puts the MID back.
  await asUser(target, AGENT_ID);
  const restore = await target.query(
    `update merchants set mid = '${SHARED_MID}' where mid = '${SHARED_MID} '`,
  );

  return {
    touched: [pad.affectedRows ?? 0, restore.affectedRows ?? 0],
    lines: await ledgerLines(target),
  };
}

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(async () => {
  await resetData(db);
  await seedPayouts(db);
  await asPlatform(db);
  await db.exec(`delete from rep_payout_import_rows`);
});

afterAll(async () => {
  await db?.close();
});

describe("the attack, on the schema as it was before the fix", () => {
  it("pads the MID, commits the signer's row unshared, restores it, and leaves no trail", async () => {
    const before = await createTestDb(await migrationsBefore(FIX_MIGRATION));
    try {
      await resetData(before);
      await seedPayouts(before);
      await asPlatform(before);
      await before.exec(`delete from rep_payout_import_rows; delete from audit_log;`);

      const { touched, lines } = await runAttack(before);

      expect(touched).toEqual([1, 1]);
      // One ordinary line: the signer holds the whole account, the partner nothing.
      expect(lines).toEqual([{ agent_id: AGENT_ID, share_role: null, rep_share_id: null }]);
      // And the merchant looks untouched.
      await asPlatform(before);
      const [m] = await rows<{ mid: string }>(
        before,
        `select mid from merchants where dba = 'Agent Inactive Co'`,
      );
      expect(m.mid).toBe(SHARED_MID);
      // The owner's own edits are invisible to log_cross_agent_change().
      const audit = await rows<{ action: string }>(
        before,
        `select action from audit_log where table_name = 'merchants'`,
      );
      expect(audit).toEqual([]);
    } finally {
      await before.close();
    }
  });
});

describe("a rep cannot steer a shared month by editing the MID", () => {
  it("the rep's MID edits touch nothing, and the month commits as the pair", async () => {
    const { touched, lines } = await runAttack(db);

    expect(touched).toEqual([0, 0]);
    expect(lines.map((l) => [l.agent_id, l.share_role])).toEqual([
      [AGENT_ID, "primary"],
      [PARTNER_ID, "secondary"],
    ]);
    expect(lines.every((l) => l.rep_share_id !== null)).toBe(true);
  });
});

// -------------------------------------------------------------------------
// The policies: a rep reads their book and writes nothing.
// -------------------------------------------------------------------------

type CountRow = { n: number };

async function count(target: TestDb, sql: string): Promise<number> {
  await asPlatform(target);
  const [{ n }] = await rows<CountRow>(target, `select (${sql})::int as n`);
  return n;
}

/** What a rep's three write verbs do to their OWN merchant. */
async function repWrites(target: TestDb): Promise<{
  updated: number;
  deleted: number;
  insertError: string | null;
}> {
  await asUser(target, AGENT_ID);
  const updated =
    (await target.query(`update merchants set processor = 'Nuvei' where dba = 'Agent Active Co'`))
      .affectedRows ?? 0;
  const deleted =
    (await target.query(`delete from merchants where dba = 'Agent Active Co'`)).affectedRows ?? 0;
  let insertError: string | null = null;
  try {
    await target.query(
      `insert into merchants (agent_id, dba, city, state)
       values ('${AGENT_ID}', 'My New Co', 'Nashville', 'TN')`,
    );
  } catch (error) {
    insertError = (error as Error).message;
  }
  await asPlatform(target);
  return { updated, deleted, insertError };
}

describe("merchant writes are admin-only", () => {
  it("a rep still reads their own book", async () => {
    await asUser(db, AGENT_ID);
    const mine = await rows<{ dba: string }>(db, `select dba from merchants order by dba`);
    expect(mine.map((m) => m.dba)).toEqual(["Agent Active Co", "Agent Inactive Co"]);
  });

  it("a rep cannot update, delete or create a merchant, even in their own book", async () => {
    const result = await repWrites(db);

    expect(result.updated).toBe(0);
    expect(result.deleted).toBe(0);
    expect(result.insertError).toMatch(/row-level security/i);
    expect(
      await count(
        db,
        `select count(*) from merchants where dba = 'Agent Active Co' and processor = 'TSYS'`,
      ),
    ).toBe(1);
    expect(await count(db, `select count(*) from merchants where dba = 'My New Co'`)).toBe(0);
  });

  it("an admin updates, creates and deletes any rep's merchant", async () => {
    await asUser(db, ADMIN_ID);
    const updated = await db.query(
      `update merchants set processor = 'Nuvei' where dba = 'Agent Active Co'`,
    );
    expect(updated.affectedRows).toBe(1);

    await db.query(
      `insert into merchants (agent_id, dba, city, state)
       values ('${AGENT_ID}', 'Admin Made Co', 'Nashville', 'TN')`,
    );
    const deleted = await db.query(`delete from merchants where dba = 'Admin Made Co'`);
    expect(deleted.affectedRows).toBe(1);
  });

  it("approve_pre_app() still creates the rep's merchant", async () => {
    await asPlatform(db);
    const [{ id }] = await rows<{ id: number }>(
      db,
      `select id from pre_apps where dba_name = 'Agent Submitted App'`,
    );
    await asUser(db, ADMIN_ID);
    await db.query(`select approve_pre_app(${id})`);
    expect(
      await count(
        db,
        `select count(*) from merchants where pre_app_id = ${id} and agent_id = '${AGENT_ID}'`,
      ),
    ).toBe(1);
  });

  it("goes red with the old rep branches restored", async () => {
    const broken = await createTestDb();
    try {
      await resetData(broken);
      await asPlatform(broken);
      await broken.exec(`
        drop policy "admin insert only" on merchants;
        drop policy "admin update only" on merchants;
        create policy "insert own" on merchants
          for insert with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());
        create policy "update own or admin" on merchants
          for update using ((agent_id = auth.uid() and is_active_agent()) or is_admin())
          with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());
      `);
      const result = await repWrites(broken);
      expect(result.updated).toBe(1);
      expect(result.insertError).toBeNull();
    } finally {
      await broken.close();
    }
  });
});

// -------------------------------------------------------------------------
// merchants_mid_audit: every MID change, by anyone.
// -------------------------------------------------------------------------

type AuditRow = { actor_id: string | null; action: string; row_id: string };

async function midAudit(target: TestDb): Promise<AuditRow[]> {
  await asPlatform(target);
  return rows<AuditRow>(
    target,
    `select actor_id, action, row_id from audit_log
      where action = 'merchant_mid_changed' order by id`,
  );
}

async function merchantId(target: TestDb, dba: string): Promise<number> {
  await asPlatform(target);
  const [{ id }] = await rows<{ id: number }>(
    target,
    `select id from merchants where dba = '${dba}'`,
  );
  return id;
}

describe("every MID change is audited", () => {
  beforeEach(async () => {
    await asPlatform(db);
    await db.exec(`delete from audit_log`);
  });

  it("records an admin changing their OWN merchant's MID, which the cross-agent trigger skips", async () => {
    await asPlatform(db);
    await db.exec(`
      insert into merchants (agent_id, mid, dba, city, state)
      values ('${ADMIN_ID}', 'MID-ADMIN-1', 'Admin Own Co', 'Nashville', 'TN');
      delete from audit_log;
    `);
    const id = await merchantId(db, "Admin Own Co");

    await asUser(db, ADMIN_ID);
    await db.query(`update merchants set mid = 'MID-ADMIN-1 ' where id = ${id}`);

    expect(await midAudit(db)).toEqual([
      { actor_id: ADMIN_ID, action: "merchant_mid_changed", row_id: String(id) },
    ]);
    // The cross-agent trigger, by contrast, wrote nothing: the editor owns it.
    expect(
      await count(db, `select count(*) from audit_log where action like 'cross_agent%'`),
    ).toBe(0);
  });

  it("records an admin changing a rep's MID, alongside the cross-agent row", async () => {
    const id = await merchantId(db, "Agent Active Co");
    await asUser(db, ADMIN_ID);
    await db.query(`update merchants set mid = 'MID-AGENT-1B' where id = ${id}`);

    expect(await midAudit(db)).toEqual([
      { actor_id: ADMIN_ID, action: "merchant_mid_changed", row_id: String(id) },
    ]);
    expect(
      await count(db, `select count(*) from audit_log where action = 'cross_agent_update'`),
    ).toBe(1);
  });

  it("records a service-role change with a NULL actor", async () => {
    const id = await merchantId(db, "Agent Active Co");
    await asPlatform(db);
    await db.query(`update merchants set mid = null where id = ${id}`);

    expect(await midAudit(db)).toEqual([
      { actor_id: null, action: "merchant_mid_changed", row_id: String(id) },
    ]);
  });

  it("records nothing when the MID is re-sent unchanged, or another column changes", async () => {
    const id = await merchantId(db, "Agent Active Co");
    await asUser(db, ADMIN_ID);
    await db.query(
      `update merchants set mid = 'MID-AGENT-1', dba = 'Agent Active Co' where id = ${id}`,
    );
    await db.query(`update merchants set processor = 'Nuvei' where id = ${id}`);

    expect(await midAudit(db)).toEqual([]);
  });

  it("is security definer with a pinned search_path and no EXECUTE for anyone", async () => {
    await asPlatform(db);
    const [fn] = await rows<{
      prosecdef: boolean;
      proconfig: string[];
      anon: boolean;
      auth: boolean;
    }>(
      db,
      `select p.prosecdef, p.proconfig,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as auth
         from pg_proc p where p.proname = 'audit_merchant_mid_change'`,
    );
    expect(fn.prosecdef).toBe(true);
    expect(fn.proconfig).toEqual(["search_path=public, pg_temp"]);
    expect(fn.anon).toBe(false);
    expect(fn.auth).toBe(false);
  });

  it("goes red with the trigger dropped", async () => {
    const broken = await createTestDb();
    try {
      await resetData(broken);
      await asPlatform(broken);
      await broken.exec(`drop trigger merchants_mid_audit on merchants; delete from audit_log;`);
      const id = await merchantId(broken, "Agent Active Co");
      await asUser(broken, ADMIN_ID);
      await broken.query(`update merchants set mid = 'MID-AGENT-1B' where id = ${id}`);
      expect(await midAudit(broken)).toEqual([]);
    } finally {
      await broken.close();
    }
  });
});

// -------------------------------------------------------------------------
// Ownership (follow-up to phase 1): an admin creates a merchant FOR a rep and
// moves one between books. Ownership decides who SEES a merchant; it does
// not decide who is paid, and it does not touch merchant_rep_shares.
// -------------------------------------------------------------------------

async function visibleTo(target: TestDb, userId: string, dba: string): Promise<number> {
  await asUser(target, userId);
  const r = await rows<{ id: number }>(target, `select id from merchants where dba = '${dba}'`);
  await asPlatform(target);
  return r.length;
}

async function snapshotOf(target: TestDb, table: string): Promise<string> {
  await asPlatform(target);
  const [{ s }] = await rows<{ s: string }>(
    target,
    `select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]')::text as s from ${table} t`,
  );
  return s;
}

async function allAudit(target: TestDb): Promise<AuditRow[]> {
  await asPlatform(target);
  return rows<AuditRow>(target, `select actor_id, action, row_id from audit_log order by id`);
}

describe("an admin decides who owns a merchant", () => {
  beforeEach(async () => {
    await asPlatform(db);
    await db.exec(`delete from audit_log`);
  });

  it("creates a merchant in a rep's book, and the insert is audited", async () => {
    await asUser(db, ADMIN_ID);
    await db.query(
      `insert into merchants (agent_id, dba, city, state)
       values ('${AGENT_ID}', 'For The Rep Co', 'Nashville', 'TN')`,
    );
    const id = await merchantId(db, "For The Rep Co");

    expect(await visibleTo(db, AGENT_ID, "For The Rep Co")).toBe(1);
    expect(await visibleTo(db, OTHER_AGENT_ID, "For The Rep Co")).toBe(0);
    expect(await allAudit(db)).toEqual([
      { actor_id: ADMIN_ID, action: "cross_agent_insert", row_id: String(id) },
    ]);
  });

  it("reassigns: the old owner loses sight of it, the new owner gains it, and it is audited", async () => {
    const id = await merchantId(db, "Agent Active Co");
    expect(await visibleTo(db, AGENT_ID, "Agent Active Co")).toBe(1);
    expect(await visibleTo(db, OTHER_AGENT_ID, "Agent Active Co")).toBe(0);

    await asUser(db, ADMIN_ID);
    const moved = await db.query(
      `update merchants set agent_id = '${OTHER_AGENT_ID}' where id = ${id}`,
    );
    expect(moved.affectedRows).toBe(1);

    expect(await visibleTo(db, AGENT_ID, "Agent Active Co")).toBe(0);
    expect(await visibleTo(db, OTHER_AGENT_ID, "Agent Active Co")).toBe(1);
    expect(await allAudit(db)).toEqual([
      { actor_id: ADMIN_ID, action: "record_reassigned", row_id: String(id) },
    ]);
  });

  it("audits a reassignment out of the admin's OWN book too", async () => {
    await asPlatform(db);
    await db.exec(`
      insert into merchants (agent_id, dba, city, state)
      values ('${ADMIN_ID}', 'Admin Kept Co', 'Nashville', 'TN');
      delete from audit_log;
    `);
    const id = await merchantId(db, "Admin Kept Co");
    await asUser(db, ADMIN_ID);
    await db.query(`update merchants set agent_id = '${AGENT_ID}' where id = ${id}`);
    expect(await allAudit(db)).toEqual([
      { actor_id: ADMIN_ID, action: "record_reassigned", row_id: String(id) },
    ]);
  });

  it("a rep can neither give their merchant away nor take someone else's", async () => {
    const mine = await merchantId(db, "Agent Active Co");
    const theirs = await merchantId(db, "Other Active Co");

    await asUser(db, AGENT_ID);
    const give = await db.query(
      `update merchants set agent_id = '${OTHER_AGENT_ID}' where id = ${mine}`,
    );
    const take = await db.query(
      `update merchants set agent_id = '${AGENT_ID}' where id = ${theirs}`,
    );
    expect([give.affectedRows, take.affectedRows]).toEqual([0, 0]);

    await asPlatform(db);
    const owners = await rows<{ id: number; agent_id: string }>(
      db,
      `select id, agent_id from merchants where id in (${mine}, ${theirs}) order by id`,
    );
    expect(owners).toEqual([
      { id: mine, agent_id: AGENT_ID },
      { id: theirs, agent_id: OTHER_AGENT_ID },
    ]);
    expect(await allAudit(db)).toEqual([]);
  });

  it("does not touch merchant_rep_shares or a single ledger line", async () => {
    await addPartner(db);
    await shareMerchant(db);
    const sharesBefore = await snapshotOf(db, "merchant_rep_shares");
    const ledgerBefore = await snapshotOf(db, "rep_payout_rows");

    await asUser(db, ADMIN_ID);
    await db.query(
      `update merchants set agent_id = '${OTHER_AGENT_ID}' where mid = '${SHARED_MID}'`,
    );

    expect(await snapshotOf(db, "merchant_rep_shares")).toBe(sharesBefore);
    expect(await snapshotOf(db, "rep_payout_rows")).toBe(ledgerBefore);
  });

  it("does not change who is paid: the commit still follows the file's Agent #", async () => {
    // Shared merchant moved to OTHER_AGENT: the signer's row still commits
    // as the AGENT/PARTNER pair.
    await addPartner(db);
    await shareMerchant(db);
    await asUser(db, ADMIN_ID);
    await db.query(
      `update merchants set agent_id = '${OTHER_AGENT_ID}' where mid = '${SHARED_MID}'`,
    );
    const shared = await stageSignerRow(db);
    await asUser(db, ADMIN_ID);
    await db.query(`select commit_residual_import_v2(${shared})`);
    expect((await ledgerLines(db)).map((l) => [l.agent_id, l.share_role])).toEqual([
      [AGENT_ID, "primary"],
      [PARTNER_ID, "secondary"],
    ]);

    // Unshared merchant moved to OTHER_AGENT: a row naming AGENT's number is
    // paid to AGENT, not to the new owner.
    await asUser(db, ADMIN_ID);
    await db.query(
      `update merchants set agent_id = '${OTHER_AGENT_ID}' where mid = 'MID-AGENT-1'`,
    );
    await asPlatform(db);
    const [{ id: batch }] = await rows<{ id: number }>(
      db,
      `insert into rep_payout_batches (imported_by, file_key, file_name, status)
       values ('${ADMIN_ID}', 'test/owner.xlsx', 'owner.xlsx', 'review') returning id`,
    );
    await db.exec(`
      insert into rep_payout_import_rows
        (batch_id, row_number, agent_number_raw, mid_raw, merchant_name_raw,
         period, agent_id, merchant_id, volume, average_ticket, total_cost,
         residual_income, rep_split_pct)
      values (${batch}, 2, '${AGENT_NUMBER}', 'MID-AGENT-1', 'Agent Active Co',
         '2026-08-01', '${AGENT_ID}', (select id from merchants where mid = 'MID-AGENT-1'),
         100.00, 10.00, 5.00, 40.00, 50.00);
    `);
    await asUser(db, ADMIN_ID);
    await db.query(`select commit_residual_import_v2(${batch})`);
    await asPlatform(db);
    expect(
      await rows<{ agent_id: string; rep_payout: string }>(
        db,
        `select agent_id, rep_payout::text from rep_payout_rows
          where mid = 'MID-AGENT-1' and period = '2026-08-01'`,
      ),
    ).toEqual([{ agent_id: AGENT_ID, rep_payout: "20.00" }]);
  });

  it("goes red with the cross-agent trigger dropped: the reassignment leaves no row", async () => {
    const broken = await createTestDb();
    try {
      await resetData(broken);
      await asPlatform(broken);
      await broken.exec(
        `drop trigger merchants_audit_cross_agent on merchants; delete from audit_log;`,
      );
      const id = await merchantId(broken, "Agent Active Co");
      await asUser(broken, ADMIN_ID);
      await broken.query(`update merchants set agent_id = '${OTHER_AGENT_ID}' where id = ${id}`);
      expect(await allAudit(broken)).toEqual([]);
    } finally {
      await broken.close();
    }
  });
});
