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
 * A quote belongs to a LEAD or a MERCHANT, and a rep cannot put a price on it.
 *
 * tests/rls/quotes.test.ts already covers the lead side, the versioning and
 * the one-column append-only grant. This file is the two things 20261007150000
 * added, and they fail in different directions:
 *
 *   1. **EXACTLY ONE OWNER, with the merchant branch mirroring merchants'
 *      own scoping.** The insert policy's second `exists` is the
 *      documents.file_key lesson in its fourth form: merchant_id is
 *      client-supplied and nothing else in the policy reads it. The failure is
 *      not a disclosure — it is a rep filing a document the merchant never saw
 *      against another rep's book.
 *
 *   2. **THE PRICE LOCK.** This is the one claim here that no policy test
 *      could make, and the hole it closes is real rather than theoretical:
 *      `grant select, insert on quote_line_items to authenticated` plus an
 *      insert policy that only asks whether the parent quote is the caller's
 *      means a rep's own session can POST a line item with any unit_price it
 *      likes, on their own quote, and every policy agrees. So the tests below
 *      do exactly that — a DIRECT insert, bypassing create_quote_version() —
 *      because testing only the RPC would be testing the path that was never
 *      the problem.
 */

let db: TestDb;
let flexId = 0;
let dockId = 0;
let unpricedId = 0;
let archivedId = 0;
let agentLeadId = 0;
let agentMerchantId = 0;
let otherMerchantId = 0;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

/**
 * TRUNCATES products first, for the reason the other catalog seeders do:
 * products has no profiles reference, so resetData()'s cascade from `profiles`
 * never reaches it and rows survive every reset.
 */
async function seedCatalog(): Promise<void> {
  await asPlatform(db);
  await db.exec(`truncate products restart identity cascade`);

  const created = await rows<{ id: number; name: string }>(
    db,
    `insert into products (name, sku, category, brand, kind, billing, list_price)
     values
       ('TEST Flex Terminal', 'T-FLEX', 'Mobile / wireless', 'Testco', 'device', 'one_time', '499.00'),
       ('TEST Monthly Dock',  'T-DOCK', 'Accessories',       'Testco', 'addon',  'monthly',   '19.00'),
       ('TEST Unpriced Svc',   null,    'Services',          null,     'device', 'monthly',   null),
       ('TEST Retired Term',  'T-OLD',  'POS systems',       'Testco', 'device', 'one_time', '999.00')
     returning id, name`,
  );
  flexId = created.find((r) => r.name === "TEST Flex Terminal")!.id;
  dockId = created.find((r) => r.name === "TEST Monthly Dock")!.id;
  unpricedId = created.find((r) => r.name === "TEST Unpriced Svc")!.id;
  archivedId = created.find((r) => r.name === "TEST Retired Term")!.id;

  await db.exec(
    `update products set archived_at = now() where id = ${archivedId}`,
  );

  const [lead] = await rows<{ id: number }>(
    db,
    `select id from leads where dba = 'Agent Lead A'`,
  );
  agentLeadId = lead.id;

  const [mine] = await rows<{ id: number }>(
    db,
    `select id from merchants where dba = 'Agent Active Co'`,
  );
  agentMerchantId = mine.id;

  const [theirs] = await rows<{ id: number }>(
    db,
    `select id from merchants where dba = 'Other Active Co'`,
  );
  otherMerchantId = theirs.id;
}

/** The RPC's eight positional arguments — lead_id, then merchant_id. */
function createQuoteSql(args: {
  leadId?: number | null;
  merchantId?: number | null;
  agentId: string;
  groupId?: string | null;
  lines: { product_id: number; quantity: number }[];
}): string {
  const lead = args.leadId == null ? "null" : String(args.leadId);
  const merchant = args.merchantId == null ? "null" : String(args.merchantId);
  const group = args.groupId == null ? "null" : `'${args.groupId}'`;
  const lines = JSON.stringify(args.lines).replace(/'/g, "''");
  return `select create_quote_version(
    ${lead}, ${merchant}, '${args.agentId}', ${group},
    'draft', 'TEST proposal', null, '${lines}'::jsonb
  ) as id`;
}

beforeEach(async () => {
  await resetData(db);
  await seedCatalog();
});

describe("exactly one owner, enforced by the constraint", () => {
  it("accepts a lead quote and a merchant quote", async () => {
    await asUser(db, AGENT_ID);
    await db.exec(
      createQuoteSql({
        leadId: agentLeadId,
        agentId: AGENT_ID,
        lines: [{ product_id: flexId, quantity: 1 }],
      }),
    );
    await db.exec(
      createQuoteSql({
        merchantId: agentMerchantId,
        agentId: AGENT_ID,
        lines: [{ product_id: flexId, quantity: 1 }],
      }),
    );

    const found = await rows<{ lead_id: number | null; merchant_id: number | null }>(
      db,
      `select lead_id, merchant_id from quotes order by id`,
    );
    expect(found).toEqual([
      { lead_id: agentLeadId, merchant_id: null },
      { lead_id: null, merchant_id: agentMerchantId },
    ]);
  });

  it("refuses BOTH owners, at the RPC with a message that says what to do", async () => {
    await asUser(db, AGENT_ID);
    await expect(
      db.exec(
        createQuoteSql({
          leadId: agentLeadId,
          merchantId: agentMerchantId,
          agentId: AGENT_ID,
          lines: [{ product_id: flexId, quantity: 1 }],
        }),
      ),
    ).rejects.toThrow(/exactly one of a lead or a merchant/);
  });

  it("refuses NEITHER owner", async () => {
    await asUser(db, AGENT_ID);
    await expect(
      db.exec(
        createQuoteSql({
          agentId: AGENT_ID,
          lines: [{ product_id: flexId, quantity: 1 }],
        }),
      ),
    ).rejects.toThrow(/exactly one of a lead or a merchant/);
  });

  it("refuses both owners at the CONSTRAINT too, past the RPC", async () => {
    // The RPC's check produces the readable message; the constraint is the
    // layer a direct insert cannot skip. Both exist and both are asserted,
    // because a reader of the RPC would otherwise have no way to know which
    // one is load-bearing.
    //
    // With BOTH set the policy admits the row — the lead branch's `exists`
    // succeeds — so the constraint is what rejects it. Which is the point: the
    // policy's job is ownership, not arity.
    await asUser(db, AGENT_ID);
    await expect(
      db.exec(
        `insert into quotes (lead_id, merchant_id, agent_id)
         values (${agentLeadId}, ${agentMerchantId}, '${AGENT_ID}')`,
      ),
    ).rejects.toThrow(/quotes_exactly_one_owner/);
  });

  it("refuses NEITHER owner at the policy for a rep, the constraint for an admin", async () => {
    // Measured, and not what the first draft of this test expected. For a rep
    // an ownerless quote never reaches the constraint: both of the insert
    // policy's owner branches are guarded by `is not null`, so with neither
    // column set the policy itself denies the row. Two layers refusing the
    // same thing in a particular ORDER, and the order is worth pinning —
    // otherwise someone removing the `is not null` guards would see this test
    // still pass on the constraint and conclude the guards were decoration.
    await asUser(db, AGENT_ID);
    await expect(
      db.exec(`insert into quotes (agent_id) values ('${AGENT_ID}')`),
    ).rejects.toThrow(/row-level security/);

    // An admin's branch short-circuits the owner check, so for them the
    // constraint is the only thing standing between an ownerless quote and the
    // table. This is the assertion that proves the constraint is real rather
    // than shadowed everywhere.
    await asUser(db, ADMIN_ID);
    await expect(
      db.exec(`insert into quotes (agent_id) values ('${AGENT_ID}')`),
    ).rejects.toThrow(/quotes_exactly_one_owner/);
  });

  it("is an ORDINARY constraint, not NOT VALID", async () => {
    // The whole reason it could be added without NOT VALID: lead_id was
    // `not null` until the migration, and merchant_id was added by it, so
    // num_nonnulls was 1 for every existing row by construction. A NOT VALID
    // constraint looks identical in the schema and enforces nothing on the
    // rows that were there first, so the difference has to be asserted.
    await asPlatform(db);
    const [row] = await rows<{ convalidated: boolean }>(
      db,
      `select convalidated from pg_constraint
        where conname = 'quotes_exactly_one_owner'`,
    );
    expect(row.convalidated).toBe(true);
  });
});

describe("a merchant quote is scoped exactly as the merchant is", () => {
  it("refuses a rep quoting a merchant that is not theirs", async () => {
    // The documents.file_key lesson in its fourth form. merchant_id is
    // client-supplied and no other clause in the insert policy reads it, so
    // without the `exists` a rep could put a document the merchant never saw
    // in front of the admin reviewing somebody else's book.
    await asUser(db, AGENT_ID);
    await expect(
      db.exec(
        createQuoteSql({
          merchantId: otherMerchantId,
          agentId: AGENT_ID,
          lines: [{ product_id: flexId, quantity: 1 }],
        }),
      ),
    ).rejects.toThrow();
  });

  it("refuses a rep quoting as another agent on their own merchant", async () => {
    await asUser(db, AGENT_ID);
    await expect(
      db.exec(
        createQuoteSql({
          merchantId: agentMerchantId,
          agentId: OTHER_AGENT_ID,
          lines: [{ product_id: flexId, quantity: 1 }],
        }),
      ),
    ).rejects.toThrow();
  });

  it("lets an admin quote on a rep's merchant, in the rep's name", async () => {
    // The admin branch short-circuits the owner `exists`, which is what lets
    // an admin build on a rep's behalf — and the quote must land in the REP's
    // book, not the admin's. Same call convert_ghost_sheet_to_lead makes.
    await asUser(db, ADMIN_ID);
    await db.exec(
      createQuoteSql({
        merchantId: agentMerchantId,
        agentId: AGENT_ID,
        lines: [{ product_id: flexId, quantity: 1 }],
      }),
    );

    await asPlatform(db);
    const [row] = await rows<{ agent_id: string; merchant_id: number }>(
      db,
      `select agent_id, merchant_id from quotes`,
    );
    expect(row.agent_id).toBe(AGENT_ID);
    expect(row.merchant_id).toBe(agentMerchantId);
  });

  it("hides another rep's merchant quote completely", async () => {
    await asUser(db, OTHER_AGENT_ID);
    await db.exec(
      createQuoteSql({
        merchantId: otherMerchantId,
        agentId: OTHER_AGENT_ID,
        lines: [{ product_id: flexId, quantity: 1 }],
      }),
    );

    // Zero rows, not an error — which is what makes the print route's 404
    // correct rather than a 403. "Not yours" and "does not exist" have to be
    // the same answer or the URL becomes an id oracle.
    await asUser(db, AGENT_ID);
    expect(await rows(db, `select id from quotes`)).toHaveLength(0);
    expect(
      await rows(db, `select id from quote_line_items`),
    ).toHaveLength(0);

    await asUser(db, ADMIN_ID);
    expect(await rows(db, `select id from quotes`)).toHaveLength(1);
  });

  it("refuses a merchant quote from a deactivated rep who still holds a JWT", async () => {
    await asPlatform(db);
    await db.exec(
      `update profiles set is_active = false where id = '${AGENT_ID}'`,
    );

    await asUser(db, AGENT_ID);
    await expect(
      db.exec(
        createQuoteSql({
          merchantId: agentMerchantId,
          agentId: AGENT_ID,
          lines: [{ product_id: flexId, quantity: 1 }],
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("a group cannot change who it is about", () => {
  it("refuses adding a version under a different owner", async () => {
    // Reachable, and not hypothetically: create_quote_version() takes a group
    // id and an owner as separate arguments, so a rep passing their own group
    // id with a different (also their own) record would add a "version 2"
    // about another business. Nothing leaks — both records are theirs — but
    // the print route filters by owner, so it would render "version 2 of 1" on
    // one page and "version 1 of 1" on the other.
    await asUser(db, AGENT_ID);
    await db.exec(
      createQuoteSql({
        leadId: agentLeadId,
        agentId: AGENT_ID,
        lines: [{ product_id: flexId, quantity: 1 }],
      }),
    );
    const [{ quote_group_id: groupId }] = await rows<{
      quote_group_id: string;
    }>(db, `select quote_group_id from quotes`);

    await expect(
      db.exec(
        createQuoteSql({
          merchantId: agentMerchantId,
          agentId: AGENT_ID,
          groupId,
          lines: [{ product_id: flexId, quantity: 1 }],
        }),
      ),
    ).rejects.toThrow(/different lead or merchant/);
  });

  it("refuses moving a group between two of the rep's own leads", async () => {
    await asPlatform(db);
    const [otherOwn] = await rows<{ id: number }>(
      db,
      `select id from leads where dba = 'Agent Lead B'`,
    );

    await asUser(db, AGENT_ID);
    await db.exec(
      createQuoteSql({
        leadId: agentLeadId,
        agentId: AGENT_ID,
        lines: [{ product_id: flexId, quantity: 1 }],
      }),
    );
    const [{ quote_group_id: groupId }] = await rows<{
      quote_group_id: string;
    }>(db, `select quote_group_id from quotes`);

    await expect(
      db.exec(
        createQuoteSql({
          leadId: otherOwn.id,
          agentId: AGENT_ID,
          groupId,
          lines: [{ product_id: flexId, quantity: 1 }],
        }),
      ),
    ).rejects.toThrow(/different lead or merchant/);
  });

  it("still allows an ordinary second version on the same owner", async () => {
    // The guard must not break the thing it guards. A merchant group revises
    // exactly as a lead group does.
    await asUser(db, AGENT_ID);
    await db.exec(
      createQuoteSql({
        merchantId: agentMerchantId,
        agentId: AGENT_ID,
        lines: [{ product_id: flexId, quantity: 1 }],
      }),
    );
    const [{ quote_group_id: groupId }] = await rows<{
      quote_group_id: string;
    }>(db, `select quote_group_id from quotes`);

    await db.exec(
      createQuoteSql({
        merchantId: agentMerchantId,
        agentId: AGENT_ID,
        groupId,
        lines: [{ product_id: flexId, quantity: 2 }],
      }),
    );

    const versions = await rows<{ version: number }>(
      db,
      `select version from quotes order by version`,
    );
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
  });
});

describe("THE PRICE LOCK — a rep cannot save a price of their own", () => {
  let quoteId = 0;

  beforeEach(async () => {
    await asUser(db, AGENT_ID);
    const [created] = await rows<{ id: number }>(
      db,
      createQuoteSql({
        leadId: agentLeadId,
        agentId: AGENT_ID,
        lines: [{ product_id: flexId, quantity: 1 }],
      }),
    );
    quoteId = created.id;
  });

  it("overwrites a forged unit_price on a DIRECT insert", async () => {
    // THE test of this file. Not through the RPC — the RPC has no parameter
    // for a price, so it was never the path at risk. This is the path the
    // GRANT allows: a rep's own session POSTing a line item to PostgREST, on
    // their own quote, with every policy agreeing.
    await asUser(db, AGENT_ID);
    await db.exec(
      `insert into quote_line_items
         (quote_id, product_id, quantity, unit_price, product_name,
          product_sku, product_billing, product_kind, sort_order)
       values (${quoteId}, ${flexId}, 1, '1.00', 'Free terminal',
               'FAKE', 'monthly', 'addon', 99)`,
    );

    await asPlatform(db);
    const [line] = await rows<{
      unit_price: string;
      product_name: string;
      product_sku: string;
      product_billing: string;
      product_kind: string;
      line_total: string;
    }>(
      db,
      `select unit_price, product_name, product_sku, product_billing,
              product_kind, line_total
         from quote_line_items where sort_order = 99`,
    );

    // Every snapshot column comes from the catalog, not from the request.
    expect(Number(line.unit_price)).toBe(499);
    expect(line.product_name).toBe("TEST Flex Terminal");
    expect(line.product_sku).toBe("T-FLEX");
    expect(line.product_billing).toBe("one_time");
    expect(line.product_kind).toBe("device");
    // And line_total is generated from the corrected price, so the forged
    // figure cannot survive in a derived column either.
    expect(Number(line.line_total)).toBe(499);
  });

  it("is not fooled by a price that merely looks plausible", async () => {
    // A $1.00 terminal is obviously forged; $489.00 is what somebody shaving
    // a discount onto a proposal would actually send, and it has to be
    // corrected just as completely.
    await asUser(db, AGENT_ID);
    await db.exec(
      `insert into quote_line_items
         (quote_id, product_id, quantity, unit_price, product_name,
          product_billing, product_kind, sort_order)
       values (${quoteId}, ${flexId}, 2, '489.00', 'TEST Flex Terminal',
               'one_time', 'device', 98)`,
    );

    await asPlatform(db);
    const [line] = await rows<{ unit_price: string; line_total: string }>(
      db,
      `select unit_price, line_total from quote_line_items where sort_order = 98`,
    );
    expect(Number(line.unit_price)).toBe(499);
    expect(Number(line.line_total)).toBe(998);
  });

  it("refuses an archived product on a direct insert", async () => {
    // create_quote_version() refuses this by name too; the trigger covers the
    // path where the RPC never ran. Without it the assignment would set
    // unit_price from a row the join never found and the insert would fail on
    // product_name being null — naming a column rather than the cause.
    await asUser(db, AGENT_ID);
    await expect(
      db.exec(
        `insert into quote_line_items
           (quote_id, product_id, quantity, unit_price, product_name,
            product_billing, product_kind)
         values (${quoteId}, ${archivedId}, 1, '999.00', 'x', 'one_time', 'device')`,
      ),
    ).rejects.toThrow(/archived product/);
  });

  it("refuses an unpriced product rather than pricing it at zero", async () => {
    await asUser(db, AGENT_ID);
    await expect(
      db.exec(
        `insert into quote_line_items
           (quote_id, product_id, quantity, unit_price, product_name,
            product_billing, product_kind)
         values (${quoteId}, ${unpricedId}, 1, '0.00', 'x', 'monthly', 'device')`,
      ),
    ).rejects.toThrow(/list price/);
  });

  it("refuses a product that does not exist, naming the catalog", async () => {
    await asUser(db, AGENT_ID);
    await expect(
      db.exec(
        `insert into quote_line_items
           (quote_id, product_id, quantity, unit_price, product_name,
            product_billing, product_kind)
         values (${quoteId}, 999999, 1, '1.00', 'x', 'one_time', 'device')`,
      ),
    ).rejects.toThrow(/in the catalog/);
  });

  it("still cannot touch a line once written, at either layer", async () => {
    // The lock is insert-time because that is the only window: there is no
    // UPDATE grant or policy on this table, so a price cannot be edited
    // afterwards either. Asserted so "insert only" stays a complete answer.
    await asUser(db, AGENT_ID);
    await expect(
      db.exec(
        `update quote_line_items set unit_price = '1.00' where quote_id = ${quoteId}`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("is SECURITY DEFINER, which enforce_compatibility_kinds deliberately is not", async () => {
    // Not for reach — every active user can already read every product. It is
    // definer so the figure on a document cannot be changed by changing a
    // POLICY: an invoker trigger reads products through the caller's select
    // policy, so narrowing that later would break the snapshot inside the one
    // function whose job is to be unweakenable.
    await asPlatform(db);
    const [row] = await rows<{ prosecdef: boolean }>(
      db,
      `select prosecdef from pg_proc where proname = 'snapshot_quote_line_item'`,
    );
    expect(row.prosecdef).toBe(true);
  });

  it("holds no EXECUTE grant, because a trigger does not need one", async () => {
    await asPlatform(db);
    const [row] = await rows<{ can: boolean }>(
      db,
      `select has_function_privilege('authenticated',
                'snapshot_quote_line_item()', 'EXECUTE') as can`,
    );
    expect(row.can).toBe(false);
  });
});

describe("the snapshot survives the catalog moving on", () => {
  it("keeps billing and kind as they were when the quote was sent", async () => {
    // The reason product_billing is a column and not a join. An admin moving a
    // gateway from one-time to monthly would otherwise silently move a figure
    // between the totals on every proposal ever printed, and the restated
    // sheet would look exactly like the original.
    await asUser(db, AGENT_ID);
    await db.exec(
      createQuoteSql({
        leadId: agentLeadId,
        agentId: AGENT_ID,
        lines: [
          { product_id: flexId, quantity: 1 },
          { product_id: dockId, quantity: 2 },
        ],
      }),
    );

    await asUser(db, ADMIN_ID);
    await db.exec(
      `update products
          set billing = 'monthly', kind = 'addon', list_price = '1.00',
              name = 'Renamed Terminal'
        where id = ${flexId}`,
    );

    await asUser(db, AGENT_ID);
    const lines = await rows<{
      product_name: string;
      product_billing: string;
      product_kind: string;
      unit_price: string;
    }>(
      db,
      `select product_name, product_billing, product_kind, unit_price
         from quote_line_items order by sort_order`,
    );

    expect(lines[0].product_name).toBe("TEST Flex Terminal");
    expect(lines[0].product_billing).toBe("one_time");
    expect(lines[0].product_kind).toBe("device");
    expect(Number(lines[0].unit_price)).toBe(499);
    // And the add-on is untouched, which is what says the first row's survival
    // is a snapshot rather than a failed update.
    expect(lines[1].product_billing).toBe("monthly");
    expect(lines[1].product_kind).toBe("addon");
  });

  it("writes sort_order from the array's order, which is the grouping", async () => {
    // Load-bearing rather than cosmetic: the printed proposal reads its
    // device/add-on structure off (sort_order, product_kind) and nothing else,
    // so the cart's order is what puts each add-on under its device.
    await asUser(db, AGENT_ID);
    await db.exec(
      createQuoteSql({
        merchantId: agentMerchantId,
        agentId: AGENT_ID,
        lines: [
          { product_id: flexId, quantity: 1 },
          { product_id: dockId, quantity: 1 },
        ],
      }),
    );

    const lines = await rows<{ sort_order: number; product_kind: string }>(
      db,
      `select sort_order, product_kind from quote_line_items order by sort_order`,
    );
    expect(lines).toEqual([
      { sort_order: 0, product_kind: "device" },
      { sort_order: 1, product_kind: "addon" },
    ]);
  });
});

describe("the RPC's signature", () => {
  it("resolves to exactly one function, so no call is ambiguous", async () => {
    // `create or replace function` with a different number of parameters
    // creates a SECOND function rather than replacing the first, and Postgres
    // reports the resulting ambiguity at CALL time — from the browser, as a
    // failed save. The migration drops the 7-argument version; this is what
    // notices if a future change leaves two behind. dashboard_counts() carries
    // the same assertion for the same reason.
    await asPlatform(db);
    const found = await rows<{ nargs: number }>(
      db,
      `select pronargs as nargs from pg_proc where proname = 'create_quote_version'`,
    );
    expect(found).toHaveLength(1);
    expect(found[0].nargs).toBe(8);
  });

  it("is still security INVOKER, so the caller's policies scope every write", async () => {
    // The property every scoping assertion in this file depends on. Flip it
    // and a rep could file a quote against any lead or merchant in the
    // database, and nothing else here would notice.
    await asPlatform(db);
    const [row] = await rows<{ prosecdef: boolean }>(
      db,
      `select prosecdef from pg_proc where proname = 'create_quote_version'`,
    );
    expect(row.prosecdef).toBe(false);
  });
});
