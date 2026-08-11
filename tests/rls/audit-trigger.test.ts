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

async function documentId(db: TestDb, fileName: string): Promise<number> {
  await asPlatform(db);
  const [row] = await rows<{ id: number }>(
    db,
    `select id from documents where file_name = '${fileName}'`,
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
    // Created BY the admin, so the insert itself is not cross-agent and logs
    // nothing — leaving the reassignment below as the only row. Seeding this via
    // asPlatform would log a cross_agent_insert with a null actor first, since
    // the owner has no auth.uid().
    await asUser(db, ADMIN_ID);
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

describe("INSERT is covered too", () => {
  it("records an admin creating a record in a rep's name", async () => {
    // The `insert own` policy is `(agent_id = auth.uid() and is_active_agent())
    // or is_admin()`, so an admin may supply ANY agent_id. Before this branch
    // existed that left no trace anywhere.
    await asUser(db, ADMIN_ID);
    await db.exec(`
      insert into merchants (agent_id, dba, status)
      values ('${AGENT_ID}', 'Admin Made This', 'active');
    `);

    const id = await merchantId(db, "Admin Made This");
    expect(await auditRows(db)).toEqual([
      {
        actor_id: ADMIN_ID,
        action: "cross_agent_insert",
        table_name: "merchants",
        row_id: String(id),
      },
    ]);
  });

  it("stays silent when a rep creates their own record", async () => {
    await asUser(db, AGENT_ID);
    await db.exec(`
      insert into leads (agent_id, dba) values ('${AGENT_ID}', 'Rep Made This');
    `);

    expect(await auditRows(db)).toEqual([]);
  });

  it("captures the id the database assigned, not one the caller supplied", async () => {
    // Only an AFTER trigger can do this: the serial default has been resolved by
    // the time it runs, so row_id names the real row.
    await asUser(db, ADMIN_ID);
    await db.exec(`
      insert into leads (agent_id, dba) values ('${AGENT_ID}', 'Admin Made Lead');
    `);

    await asPlatform(db);
    const [lead] = await rows<{ id: number }>(
      db,
      `select id from leads where dba = 'Admin Made Lead'`,
    );
    const audit = await auditRows(db);
    expect(audit).toHaveLength(1);
    expect(audit[0].row_id).toBe(String(lead.id));
    expect(Number(audit[0].row_id)).toBeGreaterThan(0);
  });
});

describe("all eight tables are covered", () => {
  // One function, eight attachments — so the risk is not the logic but a table
  // being forgotten. Asserted per table rather than sampled, for the same reason
  // the grants test enumerates every table: the failure mode is an omission.
  // documents was exactly that omission, found by the 11 Aug audit.
  const CASES: { table: string; insert: string }[] = [
    {
      table: "merchants",
      insert: `insert into merchants (agent_id, dba, status) values ('${AGENT_ID}', 'T Merchant', 'active')`,
    },
    {
      table: "leads",
      insert: `insert into leads (agent_id, dba) values ('${AGENT_ID}', 'T Lead')`,
    },
    {
      table: "ghost_sheets",
      insert: `insert into ghost_sheets (agent_id, dba) values ('${AGENT_ID}', 'T Sheet')`,
    },
    {
      table: "pre_apps",
      insert: `insert into pre_apps (agent_id, status, dba_name, legal_business_name) values ('${AGENT_ID}', 'draft', 'T App', 'T App LLC')`,
    },
    {
      table: "support_tickets",
      insert: `insert into support_tickets (agent_id, subject, status) values ('${AGENT_ID}', 'T Ticket', 'open')`,
    },
    {
      table: "notes",
      insert: `insert into notes (agent_id, owner_type, owner_id, body) values ('${AGENT_ID}', 'lead', 1, 'T Note')`,
    },
    {
      table: "tasks",
      insert: `insert into tasks (agent_id, owner_type, owner_id, title) values ('${AGENT_ID}', 'lead', 1, 'T Task')`,
    },
    {
      table: "documents",
      insert: `insert into documents (agent_id, owner_type, owner_id, doc_type, file_key) values ('${AGENT_ID}', 'lead', 1, 'T Doc', 'k/t-doc')`,
    },
  ];

  for (const { table, insert } of CASES) {
    it(`logs a cross-agent insert on ${table}`, async () => {
      await asUser(db, ADMIN_ID);
      await db.exec(insert);

      const audit = await auditRows(db);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actor_id: ADMIN_ID,
        action: "cross_agent_insert",
        table_name: table,
      });
    });
  }
});

describe("documents — the eighth table, and the delete that nothing logged", () => {
  /**
   * documents was deliberately excluded from this trigger on the grounds that
   * its access is audited inside create-upload-url and create-download-url,
   * where the signed-URL mint is the event worth recording. That reasoning is
   * correct for reads and still holds.
   *
   * It does not cover DELETE. documents is the one table whose delete policy is
   * `(agent_id = auth.uid() and is_active_agent()) or is_admin()` rather than
   * is_admin() alone, and a delete mints no URL — so neither function ran, no
   * trigger fired, and the metadata row vanished with its Storage object
   * orphaned and nothing written down anywhere.
   */
  it("records an admin deleting another agent's document", async () => {
    // The statement, not the voided check: it is documents id 2 against lead 1,
    // so row_id and owner_id genuinely differ. The voided check is documents
    // id 1 against merchant 1, where the two collide and the assertion below
    // could not tell them apart — the same id-collision-across-types hazard the
    // notes/tasks owner_type rule exists for.
    const id = await documentId(db, "agent-statement.pdf");

    // Captured before the delete, to prove row_id names the document itself and
    // not the owner_id it also carries. That is the one way reusing the shared
    // function on a polymorphic table could have gone wrong:
    // log_cross_agent_change() reads `id` and `agent_id` out of to_jsonb(OLD)
    // by name, so it needs no documents-specific variant — documents.id is
    // serial like the other seven and documents.agent_id is uuid not null.
    await asPlatform(db);
    const [doc] = await rows<{ owner_id: number }>(
      db,
      `select owner_id from documents where id = ${id}`,
    );

    await asUser(db, ADMIN_ID);
    await db.exec(`delete from documents where id = ${id}`);

    const audit = await auditRows(db);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_id: ADMIN_ID,
      action: "cross_agent_delete",
      table_name: "documents",
      row_id: String(id),
    });
    expect(audit[0].row_id).not.toBe(String(doc.owner_id));
  });

  it("stays silent when a rep deletes their own upload", async () => {
    // The own-row delete documents exists to allow. If this logged, every
    // routine re-upload would land in the trail and bury the admin actions.
    const id = await documentId(db, "agent-voided-check.pdf");

    await asUser(db, AGENT_ID);
    await db.exec(`delete from documents where id = ${id}`);

    expect(await auditRows(db)).toEqual([]);
  });

  it("records an admin uploading in a rep's name", async () => {
    // The object key is {parent's agent_id}/..., so an admin uploading for a
    // rep files the row under that rep — meaning actor is distinct from
    // agent_id and this is a genuine cross-agent insert. Expect it alongside
    // the upload_document row create-upload-url writes: one event, two
    // granularities, the same shape approve_pre_app already produces.
    await asUser(db, ADMIN_ID);
    await db.exec(`
      insert into documents (agent_id, owner_type, owner_id, doc_type, file_key)
      values ('${AGENT_ID}', 'merchant', 1, 'Bank letter', 'k/admin-made');
    `);

    await asPlatform(db);
    const [created] = await rows<{ id: number }>(
      db,
      `select id from documents where file_key = 'k/admin-made'`,
    );
    const id = created.id;

    const audit = await auditRows(db);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_id: ADMIN_ID,
      action: "cross_agent_insert",
      table_name: "documents",
      row_id: String(id),
    });
  });
});

describe("an audit failure rolls the write back — fail closed, not silent", () => {
  it("refuses the UPDATE when audit_log rejects the row", async () => {
    // The property this whole design rests on, asserted rather than assumed.
    //
    // It is an AFTER ROW trigger with no EXCEPTION block, so it runs inside the
    // triggering statement's transaction and any error propagates: the write is
    // rolled back with it. A mutation to these seven tables therefore cannot
    // succeed while its audit row quietly does not.
    //
    // Provoked through the real failure mode — audit_log.actor_id's foreign key
    // to profiles(id). A JWT whose sub has no profiles row violates it. Reaching
    // that needs the owner role, because RLS would otherwise refuse such a
    // caller's UPDATE long before the trigger ran; that is why this is
    // unreachable in production and still worth pinning here.
    const id = await merchantId(db, "Agent Active Co");
    const GHOST = "99999999-9999-9999-9999-999999999999";

    await db.exec(`reset role;`);
    await db.exec(
      `set request.jwt.claims = '${JSON.stringify({ sub: GHOST })}';`,
    );

    let failed = false;
    try {
      await db.exec(
        `update merchants set processor = 'Should Roll Back' where id = ${id}`,
      );
    } catch {
      failed = true;
    }

    expect(failed, "the audit failure should have aborted the UPDATE").toBe(
      true,
    );

    // The write did not land. This is the assertion that distinguishes fail-closed
    // from fail-silent: without the rollback the processor would read
    // 'Should Roll Back' with nothing in audit_log to show who changed it.
    await asPlatform(db);
    const [merchant] = await rows<{ processor: string | null }>(
      db,
      `select processor from merchants where id = ${id}`,
    );
    expect(merchant.processor).not.toBe("Should Roll Back");

    expect(await auditRows(db)).toEqual([]);
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
