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
 * quotes + quote_line_items.
 *
 * Six claims, each failing in a different direction, so they are kept in
 * separate describes:
 *
 *   1. **Ordinary own-or-admin scoping**, on both tables — the child reaching
 *      it through the parent, like the pre_apps children.
 *   2. **A quote cannot be filed against somebody else's lead.** The
 *      documents.file_key lesson in its third form: lead_id is client-supplied
 *      and no other clause in the insert policy reads it. The failure is not a
 *      disclosure — it is a rep putting a document the merchant never saw in
 *      front of the admin reviewing another rep's deal.
 *   3. **Versions are assigned by the database and groups cannot be
 *      hijacked.** enforce_quote_version() is `security definer`, which in
 *      this repo always owes a reason; both of its jobs are about rows the
 *      caller cannot see, and the hijack check in particular CANNOT be a
 *      policy — an `exists` in the insert policy is itself filtered by the
 *      select policy, so another rep's group reads as an absent group and the
 *      forged row is admitted as a brand-new quote.
 *   4. **Append-only is enforced by the GRANT, one column wide.** `status`
 *      moves; everything else fails with `permission denied for column`. This
 *      is the one claim in the file that no policy test could make, because
 *      RLS has nothing to say about columns.
 *   5. **create_quote_version() is atomic and snapshots server-side.** The
 *      price, name and sku are read off the catalog inside the transaction;
 *      an unpriced or archived product is refused rather than coalesced to
 *      zero; a quote can never exist with no lines.
 *   6. **The audit trigger is on quotes and not on quote_line_items.** Both
 *      halves asserted, because attaching the second would look like a
 *      tidy-up and detaching the first would look like a simplification.
 */

type QuoteRow = {
  id: number;
  quote_group_id: string;
  version: number;
  lead_id: number;
  agent_id: string;
  status: string;
  title: string | null;
};

type LineRow = {
  id: number;
  quote_id: number;
  product_id: number;
  quantity: number;
  unit_price: string;
  product_name: string;
  product_sku: string | null;
  line_total: string;
  sort_order: number;
};

let db: TestDb;

let flexId = 0;
let miniId = 0;
let unpricedId = 0;
let archivedProductId = 0;
let agentLeadId = 0;
let otherLeadId = 0;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db?.close();
});

/**
 * Four products and the two lead ids this file needs.
 *
 * TRUNCATES products first for the reason tests/rls/products.test.ts does:
 * resetData() clears the owner tables through the cascade from `profiles`, and
 * products deliberately has no profiles reference, so the cascade never
 * reaches it. quotes and quote_line_items DO come down with that cascade
 * (quotes.agent_id references profiles), which is why only products is named
 * here — but `cascade` on this truncate is what takes the quote lines with it,
 * so the two are cleared in a consistent order either way.
 */
async function seedCatalog(): Promise<void> {
  await asPlatform(db);
  await db.exec(`truncate products restart identity cascade`);

  const created = await rows<{ id: number; name: string }>(
    db,
    `insert into products (name, sku, category, list_price)
     values
       ('Clover Flex',     'C401U', 'Mobile / wireless',    '499.00'),
       ('Clover Mini',     'C301U', 'Countertop terminals', '749.00'),
       ('Gateway monthly',  null,   'Gateway & software',    null),
       ('Clover Station',  'C500',  'POS systems',          '1299.00')
     returning id, name`,
  );
  flexId = created.find((r) => r.name === "Clover Flex")!.id;
  miniId = created.find((r) => r.name === "Clover Mini")!.id;
  unpricedId = created.find((r) => r.name === "Gateway monthly")!.id;
  archivedProductId = created.find((r) => r.name === "Clover Station")!.id;

  await db.exec(
    `update products set archived_at = now() where id = ${archivedProductId}`,
  );

  const [agentLead] = await rows<{ id: number }>(
    db,
    `select id from leads where dba = 'Agent Lead A'`,
  );
  const [otherLead] = await rows<{ id: number }>(
    db,
    `select id from leads where dba = 'Other Agent Lead'`,
  );
  agentLeadId = agentLead.id;
  otherLeadId = otherLead.id;
}

/** Shorthand for the RPC, which has seven positional arguments. */
function createQuoteSql(args: {
  leadId: number;
  agentId: string;
  groupId: string | null;
  status?: string;
  title?: string | null;
  notes?: string | null;
  lines: { product_id: number; quantity: number }[];
}): string {
  const group = args.groupId === null ? "null" : `'${args.groupId}'`;
  const title = args.title == null ? "null" : `'${args.title}'`;
  const notes = args.notes == null ? "null" : `'${args.notes}'`;
  const lines = JSON.stringify(args.lines).replace(/'/g, "''");
  return `select create_quote_version(
    ${args.leadId}, '${args.agentId}', ${group},
    '${args.status ?? "draft"}', ${title}, ${notes}, '${lines}'::jsonb
  ) as id`;
}

beforeEach(async () => {
  await resetData(db);
  await seedCatalog();
});

describe("quotes are scoped own-or-admin", () => {
  beforeEach(async () => {
    await asUser(db, AGENT_ID);
    await db.exec(
      createQuoteSql({
        leadId: agentLeadId,
        agentId: AGENT_ID,
        groupId: null,
        title: "Agent quote",
        lines: [{ product_id: flexId, quantity: 2 }],
      }),
    );
    await asUser(db, OTHER_AGENT_ID);
    await db.exec(
      createQuoteSql({
        leadId: otherLeadId,
        agentId: OTHER_AGENT_ID,
        groupId: null,
        title: "Other quote",
        lines: [{ product_id: miniId, quantity: 1 }],
      }),
    );
  });

  it("lets an agent read only their own quotes", async () => {
    await asUser(db, AGENT_ID);
    const list = await rows<QuoteRow>(
      db,
      `select title from quotes order by title`,
    );
    expect(list.map((r) => r.title)).toEqual(["Agent quote"]);
  });

  it("lets an admin read everyone's", async () => {
    await asUser(db, ADMIN_ID);
    const list = await rows<QuoteRow>(
      db,
      `select title from quotes order by title`,
    );
    expect(list.map((r) => r.title)).toEqual(["Agent quote", "Other quote"]);
  });

  it("scopes line items through the parent quote", async () => {
    // quote_line_items has no agent_id — ownership is reached by an `exists`
    // on quotes, the pre_apps child-table pattern. Asserted separately from
    // the parent because a child policy that forgot the subquery would leak
    // every line in the table while the quotes list still looked correct.
    await asUser(db, AGENT_ID);
    const mine = await rows<LineRow>(
      db,
      `select product_name from quote_line_items order by product_name`,
    );
    expect(mine.map((r) => r.product_name)).toEqual(["Clover Flex"]);

    await asUser(db, ADMIN_ID);
    const all = await rows<LineRow>(
      db,
      `select product_name from quote_line_items order by product_name`,
    );
    expect(all.map((r) => r.product_name)).toEqual([
      "Clover Flex",
      "Clover Mini",
    ]);
  });

  it("hides both tables from a deactivated rep", async () => {
    // A valid JWT proves who the caller is, not that the account is still
    // enabled. The own-row branch re-checks per request on both tables.
    await asPlatform(db);
    await db.exec(
      `update profiles set is_active = false where id = '${AGENT_ID}'`,
    );

    await asUser(db, AGENT_ID);
    const [{ q }] = await rows<{ q: number }>(
      db,
      `select count(*)::int as q from quotes`,
    );
    const [{ l }] = await rows<{ l: number }>(
      db,
      `select count(*)::int as l from quote_line_items`,
    );
    expect(q).toBe(0);
    expect(l).toBe(0);
  });

  it("has no delete path, even for an admin", async () => {
    // A quote is evidence of what a merchant was offered. No DELETE policy and
    // no DELETE grant on either table, so this is refused at the privilege
    // layer rather than filtered to zero rows.
    await asUser(db, ADMIN_ID);
    await expect(db.exec(`delete from quotes`)).rejects.toThrow(
      /permission denied|policy/i,
    );
    await expect(db.exec(`delete from quote_line_items`)).rejects.toThrow(
      /permission denied|policy/i,
    );
  });
});

describe("a quote cannot be filed against another rep's lead", () => {
  it("refuses an agent quoting a lead that is not theirs", async () => {
    // The documents.file_key lesson in its third form. lead_id is
    // client-supplied and nothing else in the insert policy reads it, so
    // without the `exists` on leads this succeeds: the rep is not READING
    // anything of the other rep's, they are writing a commercial document into
    // a book that is not theirs, which the admin reviewing that deal then sees.
    await asUser(db, AGENT_ID);
    await expect(
      db.exec(
        createQuoteSql({
          leadId: otherLeadId,
          agentId: AGENT_ID,
          groupId: null,
          lines: [{ product_id: flexId, quantity: 1 }],
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("refuses an agent quoting as another agent", async () => {
    // The other half of the same policy — the ordinary agent_id = auth.uid()
    // check. Asserted so a future edit cannot drop it while the lead_id
    // subquery keeps the file green.
    await asUser(db, AGENT_ID);
    await expect(
      db.exec(
        createQuoteSql({
          leadId: agentLeadId,
          agentId: OTHER_AGENT_ID,
          groupId: null,
          lines: [{ product_id: flexId, quantity: 1 }],
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("lets an admin quote on a rep's lead, in the rep's name", async () => {
    // The admin branch, and note the quote stays the REP's: agent_id comes
    // from the argument, not from auth.uid(), the same call
    // convert_ghost_sheet_to_lead makes. An admin helping must not move the
    // deal into their own book.
    await asUser(db, ADMIN_ID);
    await db.exec(
      createQuoteSql({
        leadId: agentLeadId,
        agentId: AGENT_ID,
        groupId: null,
        title: "Built by admin",
        lines: [{ product_id: flexId, quantity: 1 }],
      }),
    );

    await asUser(db, AGENT_ID);
    const [row] = await rows<QuoteRow>(
      db,
      `select title, agent_id from quotes`,
    );
    expect(row.title).toBe("Built by admin");
    expect(row.agent_id).toBe(AGENT_ID);
  });
});

describe("versions are assigned by the database", () => {
  let groupId = "";

  beforeEach(async () => {
    await asUser(db, AGENT_ID);
    await db.exec(
      createQuoteSql({
        leadId: agentLeadId,
        agentId: AGENT_ID,
        groupId: null,
        title: "v1",
        lines: [{ product_id: flexId, quantity: 1 }],
      }),
    );
    const [row] = await rows<QuoteRow>(db, `select quote_group_id from quotes`);
    groupId = row.quote_group_id;
  });

  it("starts a new quote at version 1", async () => {
    await asUser(db, AGENT_ID);
    const [row] = await rows<QuoteRow>(db, `select version from quotes`);
    expect(row.version).toBe(1);
  });

  it("increments within a group, leaving the old version untouched", async () => {
    // The whole design: an edit INSERTS, it does not update. v1 must still say
    // what it said.
    await asUser(db, AGENT_ID);
    await db.exec(
      createQuoteSql({
        leadId: agentLeadId,
        agentId: AGENT_ID,
        groupId,
        title: "v2",
        lines: [{ product_id: miniId, quantity: 3 }],
      }),
    );

    const list = await rows<QuoteRow>(
      db,
      `select version, title from quotes
        where quote_group_id = '${groupId}' order by version`,
    );
    expect(list.map((r) => [r.version, r.title])).toEqual([
      [1, "v1"],
      [2, "v2"],
    ]);

    // And v1's lines are still v1's lines, which is what the snapshot is for.
    const lines = await rows<LineRow>(
      db,
      `select q.version, l.product_name, l.quantity
         from quote_line_items l join quotes q on q.id = l.quote_id
        where q.quote_group_id = '${groupId}'
        order by q.version`,
    );
    expect(lines.map((r) => r.product_name)).toEqual([
      "Clover Flex",
      "Clover Mini",
    ]);
  });

  it("overwrites a client-supplied version rather than trusting it", async () => {
    // A direct insert naming version 99. The trigger assigns 2 regardless,
    // which is what stops two tabs that both read "the latest is v1" from
    // racing into a constraint violation on an ordinary second edit.
    await asUser(db, AGENT_ID);
    await db.exec(
      `insert into quotes (quote_group_id, version, lead_id, agent_id, title)
       values ('${groupId}', 99, ${agentLeadId}, '${AGENT_ID}', 'forced')`,
    );

    const [row] = await rows<QuoteRow>(
      db,
      `select version from quotes where title = 'forced'`,
    );
    expect(row.version).toBe(2);
  });

  it("refuses an insert into another rep's quote group", async () => {
    // This is the check that CANNOT be a policy, and the reason
    // enforce_quote_version() is `security definer`. An `exists` subquery in
    // the insert policy is itself filtered by the select policy, so the other
    // rep's group reads as an ABSENT group — and the forged row is admitted as
    // a brand-new quote at version 1, silently joining a group whose other
    // versions the writer cannot see.
    await asUser(db, OTHER_AGENT_ID);
    await expect(
      db.exec(
        createQuoteSql({
          leadId: otherLeadId,
          agentId: OTHER_AGENT_ID,
          groupId,
          lines: [{ product_id: flexId, quantity: 1 }],
        }),
      ),
    ).rejects.toThrow(/another agent/i);
  });

  it("lets an admin add a version to a rep's group, keeping the rep as owner", async () => {
    await asUser(db, ADMIN_ID);
    await db.exec(
      createQuoteSql({
        leadId: agentLeadId,
        agentId: AGENT_ID,
        groupId,
        title: "revised by admin",
        lines: [{ product_id: miniId, quantity: 1 }],
      }),
    );

    await asUser(db, AGENT_ID);
    const list = await rows<QuoteRow>(
      db,
      `select version, title from quotes
        where quote_group_id = '${groupId}' order by version`,
    );
    expect(list.map((r) => r.version)).toEqual([1, 2]);
    expect(list[1].title).toBe("revised by admin");
  });

  it("cannot hold two rows at the same version", async () => {
    // What makes "the highest version is the current one" well-defined — and
    // the backstop the trigger leans on, since two transactions reading the
    // same max(version) at the same instant both compute the same next number.
    //
    // The trigger has to be disabled to reach this, which is the point: the
    // constraint is unreachable through the ordinary path and exists for the
    // race the ordinary path cannot see. If a duplicate ever did land, every
    // page resolving "current" would silently pick one of two.
    await asPlatform(db);
    await db.exec(`alter table quotes disable trigger quotes_enforce_version`);
    try {
      await expect(
        db.exec(
          `insert into quotes (quote_group_id, version, lead_id, agent_id)
           values ('${groupId}', 1, ${agentLeadId}, '${AGENT_ID}')`,
        ),
      ).rejects.toThrow(/unique|duplicate key/i);
    } finally {
      await db.exec(`alter table quotes enable trigger quotes_enforce_version`);
    }
  });
});

describe("append-only is enforced one column wide, by the grant", () => {
  let quoteId = 0;

  beforeEach(async () => {
    await asUser(db, AGENT_ID);
    const [created] = await rows<{ id: number }>(
      db,
      createQuoteSql({
        leadId: agentLeadId,
        agentId: AGENT_ID,
        groupId: null,
        title: "original",
        lines: [{ product_id: flexId, quantity: 1 }],
      }),
    );
    quoteId = created.id;
  });

  it("lets a rep move the status", async () => {
    await asUser(db, AGENT_ID);
    await db.exec(`update quotes set status = 'sent' where id = ${quoteId}`);

    const [row] = await rows<QuoteRow>(
      db,
      `select status from quotes where id = ${quoteId}`,
    );
    expect(row.status).toBe("sent");
  });

  it("refuses an update to the title with permission denied, not silence", async () => {
    // The distinction this whole arrangement exists for. A write RLS filters
    // is a save that silently did nothing; a write the GRANT refuses is an
    // error the rep can act on. Policies cannot express "this column only" —
    // only a column-level grant can — which is why this claim is untestable
    // from pg_policies and is asserted behaviourally.
    await asUser(db, AGENT_ID);
    await expect(
      db.exec(`update quotes set title = 'rewritten' where id = ${quoteId}`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("refuses an update to the line items at all", async () => {
    // Stricter than quotes: no UPDATE and no DELETE in either layer. Changing
    // a line is the edit that is supposed to produce a new version.
    await asUser(db, AGENT_ID);
    await expect(
      db.exec(`update quote_line_items set quantity = 99`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("refuses reassigning a quote to another rep", async () => {
    // agent_id is not in the column grant either, so a rep cannot push a quote
    // into somebody else's book — nor can an admin do it by a plain update,
    // which is deliberate: moving a deal is a different act from revising one.
    await asUser(db, ADMIN_ID);
    await expect(
      db.exec(
        `update quotes set agent_id = '${OTHER_AGENT_ID}' where id = ${quoteId}`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("holds the column grant on status and nothing else", async () => {
    // The grant surface stated directly, so widening it reds a test here as
    // well as in grants.test.ts.
    const [row] = await rows<{
      status: boolean;
      title: boolean;
      version: boolean;
      agent_id: boolean;
    }>(
      db,
      `select
         has_column_privilege('authenticated','quotes','status','UPDATE')   as status,
         has_column_privilege('authenticated','quotes','title','UPDATE')    as title,
         has_column_privilege('authenticated','quotes','version','UPDATE')  as version,
         has_column_privilege('authenticated','quotes','agent_id','UPDATE') as agent_id`,
    );
    expect(row).toEqual({
      status: true,
      title: false,
      version: false,
      agent_id: false,
    });
  });

  it("refuses a status outside the vocabulary", async () => {
    await asUser(db, AGENT_ID);
    await expect(
      db.exec(`update quotes set status = 'maybe' where id = ${quoteId}`),
    ).rejects.toThrow(/quotes_status_check|check constraint/i);
  });
});

describe("create_quote_version snapshots server-side and is atomic", () => {
  it("copies name, sku and price off the catalog", async () => {
    await asUser(db, AGENT_ID);
    await db.exec(
      createQuoteSql({
        leadId: agentLeadId,
        agentId: AGENT_ID,
        groupId: null,
        lines: [{ product_id: flexId, quantity: 2 }],
      }),
    );

    const [line] = await rows<LineRow>(
      db,
      `select product_name, product_sku, unit_price, quantity, line_total, sort_order
         from quote_line_items`,
    );
    expect(line.product_name).toBe("Clover Flex");
    expect(line.product_sku).toBe("C401U");
    expect(line.unit_price).toBe("499.00");
    expect(line.line_total).toBe("998.00");
    expect(line.sort_order).toBe(0);
  });

  it("keeps the snapshot when the catalog price later changes", async () => {
    // The reason this table exists rather than joining products live. A
    // re-derived total would silently restate what a merchant was offered last
    // month, and the restatement would look exactly like the original.
    await asUser(db, AGENT_ID);
    await db.exec(
      createQuoteSql({
        leadId: agentLeadId,
        agentId: AGENT_ID,
        groupId: null,
        lines: [{ product_id: flexId, quantity: 1 }],
      }),
    );

    await asUser(db, ADMIN_ID);
    await db.exec(
      `update products set list_price = '599.00', name = 'Clover Flex 3'
        where id = ${flexId}`,
    );

    await asUser(db, AGENT_ID);
    const [line] = await rows<LineRow>(
      db,
      `select product_name, unit_price, line_total from quote_line_items`,
    );
    expect(line.product_name).toBe("Clover Flex");
    expect(line.unit_price).toBe("499.00");
    expect(line.line_total).toBe("499.00");
  });

  it("refuses a product with no list price rather than pricing it at zero", async () => {
    // Null means "not priced yet", never zero. Coalescing here would put a
    // free terminal on a document a merchant reads and raise nothing.
    await asUser(db, AGENT_ID);
    await expect(
      db.exec(
        createQuoteSql({
          leadId: agentLeadId,
          agentId: AGENT_ID,
          groupId: null,
          lines: [{ product_id: unpricedId, quantity: 1 }],
        }),
      ),
    ).rejects.toThrow(/list price/i);
  });

  it("refuses an archived product", async () => {
    await asUser(db, AGENT_ID);
    await expect(
      db.exec(
        createQuoteSql({
          leadId: agentLeadId,
          agentId: AGENT_ID,
          groupId: null,
          lines: [{ product_id: archivedProductId, quantity: 1 }],
        }),
      ),
    ).rejects.toThrow(/in the catalog/i);
  });

  it("refuses a product id that does not exist", async () => {
    await asUser(db, AGENT_ID);
    await expect(
      db.exec(
        createQuoteSql({
          leadId: agentLeadId,
          agentId: AGENT_ID,
          groupId: null,
          lines: [{ product_id: 999999, quantity: 1 }],
        }),
      ),
    ).rejects.toThrow(/in the catalog/i);
  });

  it("refuses a zero or negative quantity, naming the quantity", async () => {
    await asUser(db, AGENT_ID);
    for (const quantity of [0, -3]) {
      await expect(
        db.exec(
          createQuoteSql({
            leadId: agentLeadId,
            agentId: AGENT_ID,
            groupId: null,
            lines: [{ product_id: flexId, quantity }],
          }),
        ),
        `quantity ${quantity} must be refused`,
      ).rejects.toThrow(/quantity/i);
    }
  });

  it("refuses a quote with no line items", async () => {
    await asUser(db, AGENT_ID);
    await expect(
      db.exec(
        createQuoteSql({
          leadId: agentLeadId,
          agentId: AGENT_ID,
          groupId: null,
          lines: [],
        }),
      ),
    ).rejects.toThrow(/at least one line item/i);
  });

  it("writes NOTHING when a later line is bad", async () => {
    // Atomicity is the entire reason this is an RPC rather than two
    // supabase-js calls. The first line is fine and the second is not; if the
    // quote row survived, the lead would carry a $499 quote the rep never
    // approved — and nothing on the page would say it was half-written.
    //
    // The bad line is a NONEXISTENT product rather than an unpriced one, so
    // this test fails for one reason only. Written with the unpriced product
    // first, reverting the price guard reddened this spec as well as the one
    // that actually covers that guard — and a spec that goes red for two
    // different causes tells you less than two specs that each go red for one.
    await asUser(db, AGENT_ID);
    await expect(
      db.exec(
        createQuoteSql({
          leadId: agentLeadId,
          agentId: AGENT_ID,
          groupId: null,
          lines: [
            { product_id: flexId, quantity: 1 },
            { product_id: 999999, quantity: 1 },
          ],
        }),
      ),
    ).rejects.toThrow(/in the catalog/i);

    await asPlatform(db);
    const [{ q }] = await rows<{ q: number }>(
      db,
      `select count(*)::int as q from quotes`,
    );
    const [{ l }] = await rows<{ l: number }>(
      db,
      `select count(*)::int as l from quote_line_items`,
    );
    expect(q).toBe(0);
    expect(l).toBe(0);
  });

  it("orders the lines by the array's own order, not by product id", async () => {
    // `with ordinality`, so the document renders as the rep built it.
    await asUser(db, AGENT_ID);
    await db.exec(
      createQuoteSql({
        leadId: agentLeadId,
        agentId: AGENT_ID,
        groupId: null,
        lines: [
          { product_id: miniId, quantity: 1 },
          { product_id: flexId, quantity: 1 },
        ],
      }),
    );

    const lines = await rows<LineRow>(
      db,
      `select product_name, sort_order from quote_line_items order by sort_order`,
    );
    expect(lines.map((r) => r.product_name)).toEqual([
      "Clover Mini",
      "Clover Flex",
    ]);
  });

  it("is security invoker, so the caller's policies scope every write", async () => {
    // The opposite assertion to the one on enforce_quote_version below. If
    // this gained `security definer`, the lead_id check in the insert policy
    // would stop applying to it — and a rep could quote another rep's lead
    // through the very function the UI uses, with no policy failing.
    const [row] = await rows<{ prosecdef: boolean }>(
      db,
      `select prosecdef from pg_proc where proname = 'create_quote_version'`,
    );
    expect(row.prosecdef).toBe(false);
  });

  it("enforce_quote_version is security definer, which is the point of it", async () => {
    const [row] = await rows<{ prosecdef: boolean }>(
      db,
      `select prosecdef from pg_proc where proname = 'enforce_quote_version'`,
    );
    expect(row.prosecdef).toBe(true);
  });
});

describe("the cross-agent audit trigger", () => {
  it("stays quiet when a rep quotes their own lead", async () => {
    // The ordinary case, and the reason attaching the trigger here is not the
    // rep_payout_rows mistake: actor = agent_id, so nothing is logged.
    await asUser(db, AGENT_ID);
    await db.exec(
      createQuoteSql({
        leadId: agentLeadId,
        agentId: AGENT_ID,
        groupId: null,
        lines: [{ product_id: flexId, quantity: 1 }],
      }),
    );

    await asPlatform(db);
    const [{ n }] = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from audit_log where table_name = 'quotes'`,
    );
    expect(n).toBe(0);
  });

  it("logs an admin building a quote on a rep's lead", async () => {
    await asUser(db, ADMIN_ID);
    await db.exec(
      createQuoteSql({
        leadId: agentLeadId,
        agentId: AGENT_ID,
        groupId: null,
        lines: [{ product_id: flexId, quantity: 1 }],
      }),
    );

    await asPlatform(db);
    const trail = await rows<{ action: string; actor_id: string }>(
      db,
      `select action, actor_id from audit_log where table_name = 'quotes'`,
    );
    expect(trail.map((r) => r.action)).toEqual(["cross_agent_insert"]);
    expect(trail[0].actor_id).toBe(ADMIN_ID);
  });

  it("logs an admin moving a rep's quote to accepted", async () => {
    // The status UPDATE arm is reachable here, unlike the one on notes: the
    // column grant is a real privilege. An admin marking somebody else's quote
    // accepted is a change to a commercial record on another rep's deal.
    await asUser(db, AGENT_ID);
    const [created] = await rows<{ id: number }>(
      db,
      createQuoteSql({
        leadId: agentLeadId,
        agentId: AGENT_ID,
        groupId: null,
        lines: [{ product_id: flexId, quantity: 1 }],
      }),
    );

    await asUser(db, ADMIN_ID);
    await db.exec(
      `update quotes set status = 'accepted' where id = ${created.id}`,
    );

    await asPlatform(db);
    const trail = await rows<{ action: string }>(
      db,
      `select action from audit_log where table_name = 'quotes'`,
    );
    expect(trail.map((r) => r.action)).toEqual(["cross_agent_update"]);
  });

  it("is NOT attached to quote_line_items", async () => {
    // Deliberate, and asserted because attaching it would read as a tidy-up.
    // The table has no agent_id (the support_ticket_replies trap), and even a
    // working variant would write N+1 audit rows for one admin edit, N of them
    // naming a table nobody looks up by id. The parent row records the event.
    const [{ n }] = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from pg_trigger
        where tgrelid = 'quote_line_items'::regclass and not tgisinternal`,
    );
    expect(n).toBe(0);

    await asUser(db, ADMIN_ID);
    await db.exec(
      createQuoteSql({
        leadId: agentLeadId,
        agentId: AGENT_ID,
        groupId: null,
        lines: [
          { product_id: flexId, quantity: 1 },
          { product_id: miniId, quantity: 1 },
        ],
      }),
    );

    await asPlatform(db);
    const [{ n: logged }] = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from audit_log
        where table_name = 'quote_line_items'`,
    );
    expect(logged).toBe(0);
  });
});
