import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_ID,
  AGENT_ID,
  OTHER_AGENT_ID,
  asPlatform,
  asUser,
  createTestDb,
  migrationsBefore,
  readMigration,
  resetData,
  rows,
  seed,
  type TestDb,
} from "../helpers/db";

/**
 * Proposals as their own record (20261009150000).
 *
 * The database still calls them quotes — only the UI says "Proposals". What
 * this migration changed, and what these tests pin:
 *
 *   1. **agent_id is the rep the proposal is FOR.** A rep creates proposals
 *      for themselves only; an admin for any rep. A rep reads only their own,
 *      an admin all — including UNLINKED ones, which have no lead or merchant
 *      for any other policy to lean on.
 *   2. **A link must be a record the caller can see**, and "not yours" must
 *      look exactly like "does not exist" — the same error, or the insert
 *      becomes an id oracle for other reps' leads.
 *   3. **customer_name is a snapshot.** Linked: copied from the record whatever
 *      the caller typed. Unlinked: typed, and required.
 *   4. **create_quote_version() resolves to exactly one function.**
 *   5. **The backfill named every existing proposal and wrote no audit rows.**
 */

let db: TestDb;
let deviceId = 0;
let agentLeadId = 0;
let otherLeadId = 0;
let agentMerchantId = 0;

const MIGRATION = "20261009150000_proposals.sql";

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await resetData(db);
  await asPlatform(db);
  await db.exec(`truncate products restart identity cascade`);
  const [device] = await rows<{ id: number }>(
    db,
    `insert into products (name, sku, category, list_price)
     values ('TEST Terminal', 'P-TERM', 'Terminals', '300.00') returning id`,
  );
  deviceId = device.id;
  agentLeadId = (
    await rows<{ id: number }>(db, `select id from leads where dba = 'Agent Lead A'`)
  )[0].id;
  otherLeadId = (
    await rows<{ id: number }>(db, `select id from leads where dba = 'Other Agent Lead'`)
  )[0].id;
  agentMerchantId = (
    await rows<{ id: number }>(db, `select id from merchants where dba = 'Agent Active Co'`)
  )[0].id;
});

function sqlText(value: string | null | undefined): string {
  return value == null ? "null" : `'${value.replace(/'/g, "''")}'`;
}

/** The RPC's nine positional arguments. */
function createSql(args: {
  leadId?: number | null;
  merchantId?: number | null;
  customerName?: string | null;
  agentId: string;
  groupId?: string | null;
}): string {
  return `select create_quote_version(
    ${args.leadId ?? "null"}, ${args.merchantId ?? "null"},
    ${sqlText(args.customerName)}, '${args.agentId}', ${sqlText(args.groupId)},
    'draft', null, null,
    '[{"product_id": ${deviceId}, "quantity": 1}]'::jsonb
  ) as id`;
}

async function createAs(
  userId: string,
  args: Parameters<typeof createSql>[0],
): Promise<{ id: number; group: string }> {
  await asUser(db, userId);
  const [{ id }] = await rows<{ id: number }>(db, createSql(args));
  await asPlatform(db);
  const [{ quote_group_id }] = await rows<{ quote_group_id: string }>(
    db,
    `select quote_group_id from quotes where id = ${id}`,
  );
  return { id, group: quote_group_id };
}

describe("a proposal belongs to a rep", () => {
  it("a rep sees only their own proposals, unlinked ones included", async () => {
    await createAs(AGENT_ID, { customerName: "Mine Unlinked", agentId: AGENT_ID });
    await createAs(AGENT_ID, { leadId: agentLeadId, agentId: AGENT_ID });
    await createAs(OTHER_AGENT_ID, {
      customerName: "Theirs Unlinked",
      agentId: OTHER_AGENT_ID,
    });

    await asUser(db, AGENT_ID);
    const mine = await rows<{ customer_name: string }>(
      db,
      `select customer_name from quotes order by id`,
    );
    expect(mine.map((r) => r.customer_name)).toEqual([
      "Mine Unlinked",
      "Agent Lead A",
    ]);

    // Their lines too, through the parent quote.
    const lines = await rows<{ quote_id: number }>(
      db,
      `select quote_id from quote_line_items`,
    );
    expect(lines).toHaveLength(2);
  });

  it("an admin sees every rep's proposals", async () => {
    await createAs(AGENT_ID, { customerName: "Mine Unlinked", agentId: AGENT_ID });
    await createAs(OTHER_AGENT_ID, {
      customerName: "Theirs Unlinked",
      agentId: OTHER_AGENT_ID,
    });
    await asUser(db, ADMIN_ID);
    expect(await rows(db, `select id from quotes`)).toHaveLength(2);
  });

  it("a rep cannot create a proposal for another rep", async () => {
    // A DIRECT insert as well as the RPC. Through the RPC a forged row would
    // ALSO be stopped one statement later by quote_line_items' insert policy
    // (its parent quote is not the caller's) — measured: with the quotes
    // policy's agent clause removed, the RPC assertion alone still passed.
    // The direct insert has no lines, so only the quotes policy can refuse it.
    await asUser(db, AGENT_ID);
    await expect(
      db.exec(
        `insert into quotes (customer_name, agent_id)
         values ('Forged', '${OTHER_AGENT_ID}')`,
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      db.exec(createSql({ customerName: "Forged", agentId: OTHER_AGENT_ID })),
    ).rejects.toThrow(/row-level security/);
    await asPlatform(db);
    expect(await rows(db, `select id from quotes`)).toHaveLength(0);
  });

  it("an admin creates one for any rep, and it lands in that rep's book", async () => {
    const { id } = await createAs(ADMIN_ID, {
      customerName: "Admin Made",
      agentId: OTHER_AGENT_ID,
    });
    await asUser(db, OTHER_AGENT_ID);
    expect(await rows(db, `select id from quotes`)).toEqual([{ id }]);
    await asUser(db, AGENT_ID);
    expect(await rows(db, `select id from quotes`)).toEqual([]);
  });

  it("an admin may link a rep's proposal to a record of a different rep", async () => {
    // The link rule is "a record the CALLER can see", and an admin sees
    // every lead. The proposal is still AGENT_ID's; the other rep sees
    // nothing of it.
    await createAs(ADMIN_ID, { leadId: otherLeadId, agentId: AGENT_ID });
    await asUser(db, OTHER_AGENT_ID);
    expect(await rows(db, `select id from quotes`)).toEqual([]);
    await asUser(db, AGENT_ID);
    expect(await rows(db, `select id from quotes`)).toHaveLength(1);
  });
});

describe("a link must be a record the caller can see", () => {
  it("refuses a rep linking another rep's lead", async () => {
    await asUser(db, AGENT_ID);
    await expect(
      db.exec(createSql({ leadId: otherLeadId, agentId: AGENT_ID })),
    ).rejects.toThrow(/row-level security/);
  });

  it("answers a lead that does not exist EXACTLY as one that is not yours", async () => {
    // If these differed, the RPC would tell a rep which lead ids exist in
    // other reps' books. Both must be refused by the policy, with one message.
    const errorFor = async (leadId: number): Promise<string> => {
      await asUser(db, AGENT_ID);
      try {
        await db.exec(createSql({ leadId, agentId: AGENT_ID }));
        return "no error";
      } catch (error) {
        return (error as Error).message;
      }
    };
    const notMine = await errorFor(otherLeadId);
    const missing = await errorFor(999999);
    expect(notMine).toMatch(/row-level security/);
    expect(missing).toBe(notMine);
  });
});

describe("customer_name is a snapshot", () => {
  it("copies a linked record's name over whatever the caller typed", async () => {
    const { id } = await createAs(AGENT_ID, {
      leadId: agentLeadId,
      customerName: "Somebody Else Entirely",
      agentId: AGENT_ID,
    });
    const [row] = await rows<{ customer_name: string }>(
      db,
      `select customer_name from quotes where id = ${id}`,
    );
    expect(row.customer_name).toBe("Agent Lead A");
  });

  it("does the same on a DIRECT insert, past the RPC", async () => {
    await asUser(db, AGENT_ID);
    await db.exec(
      `insert into quotes (merchant_id, customer_name, agent_id)
       values (${agentMerchantId}, 'Forged Name', '${AGENT_ID}')`,
    );
    await asPlatform(db);
    const [row] = await rows<{ customer_name: string }>(
      db,
      `select customer_name from quotes`,
    );
    expect(row.customer_name).toBe("Agent Active Co");
  });

  it("keeps the old name on the old version when the record is renamed", async () => {
    const first = await createAs(AGENT_ID, { leadId: agentLeadId, agentId: AGENT_ID });
    await asPlatform(db);
    await db.exec(`update leads set dba = 'Renamed Lead' where id = ${agentLeadId}`);
    await createAs(AGENT_ID, {
      leadId: agentLeadId,
      agentId: AGENT_ID,
      groupId: first.group,
    });
    const versions = await rows<{ version: number; customer_name: string }>(
      db,
      `select version, customer_name from quotes
        where quote_group_id = '${first.group}' order by version`,
    );
    expect(versions).toEqual([
      { version: 1, customer_name: "Agent Lead A" },
      { version: 2, customer_name: "Renamed Lead" },
    ]);
  });

  it("trims a typed name on an unlinked proposal", async () => {
    const { id } = await createAs(AGENT_ID, {
      customerName: "  Walk-in Bakery  ",
      agentId: AGENT_ID,
    });
    const [row] = await rows<{ customer_name: string }>(
      db,
      `select customer_name from quotes where id = ${id}`,
    );
    expect(row.customer_name).toBe("Walk-in Bakery");
  });

  it("an unlinked group cannot later be linked", async () => {
    const first = await createAs(AGENT_ID, {
      customerName: "Walk-in",
      agentId: AGENT_ID,
    });
    await asUser(db, AGENT_ID);
    await expect(
      db.exec(
        createSql({ leadId: agentLeadId, agentId: AGENT_ID, groupId: first.group }),
      ),
    ).rejects.toThrow(/different lead or merchant/);
  });
});

describe("create_quote_version()", () => {
  it("resolves to exactly one function, the nine-argument one", async () => {
    await asPlatform(db);
    const found = await rows<{ args: string }>(
      db,
      `select pg_get_function_identity_arguments(oid) as args
         from pg_proc where proname = 'create_quote_version'`,
    );
    expect(found).toEqual([
      {
        args:
          "lead_id_input integer, merchant_id_input integer, customer_name_input text, " +
          "agent_id_input uuid, quote_group_id_input uuid, status_input text, " +
          "title_input text, notes_input text, line_items_input jsonb",
      },
    ]);
  });
});

describe("the migration's backfill", () => {
  it("names every existing quote from its lead or merchant, and audits nothing", async () => {
    const before = await createTestDb(await migrationsBefore(MIGRATION));
    try {
      await seed(before);
      await asPlatform(before);
      await before.exec(`insert into products (name, category, list_price)
                         values ('B', 'T', '1.00')`);
      await before.exec(
        `insert into quotes (lead_id, agent_id)
           select id, agent_id from leads where dba = 'Agent Lead A';
         insert into quotes (merchant_id, agent_id)
           select id, agent_id from merchants where dba = 'Agent Active Co';`,
      );
      const auditBefore = await rows<{ n: number }>(
        before,
        `select count(*)::int as n from audit_log`,
      );

      await before.exec(await readMigration(MIGRATION));

      const named = await rows<{ customer_name: string }>(
        before,
        `select customer_name from quotes order by id`,
      );
      expect(named.map((r) => r.customer_name)).toEqual([
        "Agent Lead A",
        "Agent Active Co",
      ]);
      const auditAfter = await rows<{ n: number }>(
        before,
        `select count(*)::int as n from audit_log`,
      );
      expect(auditAfter[0].n).toBe(auditBefore[0].n);
    } finally {
      await before.close();
    }
  });
});
