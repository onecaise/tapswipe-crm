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
  type TestDb,
} from "../helpers/db";

/**
 * log_cross_agent_change() — the audit trail for privileged action on other
 * people's records.
 *
 * The gap it closes: an admin editing or deleting any rep's row does it with
 * plain supabase-js, RLS permits it via is_admin(), and nothing was recorded.
 * That was the largest privileged surface in the app and the only unlogged one.
 *
 * The tests that matter most are the negative ones. A trigger that logs
 * everything is easy and useless — it buries the handful of entries worth
 * reading under every rep's ordinary edits. So the assertions below care as much
 * about what does NOT appear as what does.
 */

type AuditRow = {
  actor_id: string | null;
  action: string;
  table_name: string;
  row_id: string;
};

async function auditRows(db: TestDb): Promise<AuditRow[]> {
  await asPlatform(db);
  return rows<AuditRow>(
    db,
    `select actor_id, action, table_name, row_id
       from audit_log order by id asc`,
  );
}

async function merchantId(db: TestDb, dba: string): Promise<number> {
  await asPlatform(db);
  const [row] = await rows<{ id: number }>(
    db,
    `select id from merchants where dba = '${dba}'`,
  );
  return row.id;
}

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(async () => {
  await resetData(db);
});

afterAll(async () => {
  await db?.close();
});

describe("a rep's own edits are not logged", () => {
  it("stays silent when an agent updates their own merchant", async () => {
    const id = await merchantId(db, "Agent Active Co");

    await asUser(db, AGENT_ID);
    await db.exec(
      `update merchants set processor = 'Elavon' where id = ${id}`,
    );

    // The whole design rests on this. If ordinary self-service work landed in
    // audit_log, the trail would be thousands of rows of noise and the admin
    // actions worth reviewing would be unfindable.
    expect(await auditRows(db)).toEqual([]);
  });

  it("stays silent across a rep's whole own-row lifecycle", async () => {
    await asUser(db, AGENT_ID);
    await db.exec(`
      insert into merchants (agent_id, dba, status)
      values ('${AGENT_ID}', 'Rep Own Co', 'active');
    `);
    await asPlatform(db);
    const id = await merchantId(db, "Rep Own Co");

    await asUser(db, AGENT_ID);
    await db.exec(`update merchants set status = 'inactive' where id = ${id}`);

    expect(await auditRows(db)).toEqual([]);
  });
});

describe("cross-agent mutations are logged", () => {
  it("records an admin updating another agent's merchant", async () => {
    const id = await merchantId(db, "Agent Active Co");

    await asUser(db, ADMIN_ID);
    await db.exec(`update merchants set processor = 'TSYS 2' where id = ${id}`);

    expect(await auditRows(db)).toEqual([
      {
        actor_id: ADMIN_ID,
        action: "cross_agent_update",
        table_name: "merchants",
        row_id: String(id),
      },
    ]);
  });

  it("records an admin deleting another agent's merchant", async () => {
    // Deletes are admin-only on every table, so they were *always* privileged
    // and *always* unlogged before this.
    const id = await merchantId(db, "Agent Active Co");

    await asUser(db, ADMIN_ID);
    await db.exec(`delete from merchants where id = ${id}`);

    const audit = await auditRows(db);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_id: ADMIN_ID,
      action: "cross_agent_delete",
      table_name: "merchants",
      row_id: String(id),
    });
  });

  it("names the table it fired on, so one function serves many tables", async () => {
    // table_name comes from TG_TABLE_NAME. This is what makes the function
    // reusable rather than seven near-copies.
    const id = await merchantId(db, "Agent Active Co");

    await asUser(db, ADMIN_ID);
    await db.exec(`update merchants set mid = 'MID-CHANGED' where id = ${id}`);

    expect((await auditRows(db))[0].table_name).toBe("merchants");
  });

  it("records a reassignment even when the admin owned the row", async () => {
    // The hole in "log when the actor isn't the owner": an admin moving a record
    // they THEMSELVES own into someone else's book has actor = OLD.agent_id, so
    // the ownership branch skips it — yet moving a record between books is
    // exactly the privileged act a trail exists for.
    await asPlatform(db);
    await db.exec(`
      insert into merchants (agent_id, dba, status)
      values ('${ADMIN_ID}', 'Admin Own Co', 'active');
    `);
    const id = await merchantId(db, "Admin Own Co");

    await asUser(db, ADMIN_ID);
    await db.exec(
      `update merchants set agent_id = '${OTHER_AGENT_ID}' where id = ${id}`,
    );

    expect(await auditRows(db)).toEqual([
      {
        actor_id: ADMIN_ID,
        action: "record_reassigned",
        table_name: "merchants",
        row_id: String(id),
      },
    ]);
  });

  it("logs a privileged server write with a null actor", async () => {
    // A service-role connection has no auth.uid() at all, so `is distinct from`
    // catches it. Recording those is wanted: it is the other way a row changes
    // without its owner doing it. actor_id is nullable precisely for this.
    const id = await merchantId(db, "Agent Active Co");

    await asPlatform(db);
    await db.exec(`update merchants set processor = 'Server' where id = ${id}`);

    const audit = await auditRows(db);
    expect(audit).toHaveLength(1);
    expect(audit[0].actor_id).toBeNull();
    expect(audit[0].action).toBe("cross_agent_update");
  });
});

describe("the trigger cannot be defeated by the grant it runs against", () => {
  it("still writes audit_log even though authenticated has no INSERT on it", async () => {
    // This is why the function must be `security definer`. audit_log has no
    // INSERT policy and, after the grant migration, no INSERT privilege for
    // `authenticated` either — so a security invoker trigger would have its
    // insert refused and would fail the admin's UPDATE outright.
    await asPlatform(db);
    const [{ ok }] = await rows<{ ok: boolean }>(
      db,
      `select has_table_privilege('authenticated', 'audit_log', 'INSERT') as ok`,
    );
    expect(ok, "authenticated should not hold INSERT on audit_log").toBe(false);

    const id = await merchantId(db, "Agent Active Co");
    await asUser(db, ADMIN_ID);
    await db.exec(`update merchants set processor = 'Definer' where id = ${id}`);

    // The write landed anyway, and the admin's UPDATE was not rejected.
    expect(await auditRows(db)).toHaveLength(1);
  });

  it("records the real caller, not the function owner", async () => {
    // `security definer` changes current_user but NOT the session's JWT claims,
    // so auth.uid() inside the function still returns whoever presented the
    // token. submit_pre_app() relies on the same property. If this broke, every
    // row would be attributed to postgres and the trail would name nobody.
    const id = await merchantId(db, "Agent Active Co");

    await asUser(db, ADMIN_ID);
    await db.exec(`update merchants set processor = 'Caller' where id = ${id}`);

    expect((await auditRows(db))[0].actor_id).toBe(ADMIN_ID);
  });
});
