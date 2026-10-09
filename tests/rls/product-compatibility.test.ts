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
 * product_compatibility, and the three columns the store browses products by.
 *
 * The THIRD client-readable table with no agent_id, and unlike products and
 * marketing_materials it did not choose that — a fact about two catalog rows
 * cannot be owned by a rep. So the CLAUDE.md checklist applies with step 1
 * struck out, and the claims that matter are the remaining three plus two the
 * checklist does not cover:
 *
 *   1. **Readable by every active user, writable by nobody but an admin** —
 *      and a DELETE that exists here while products withholds one. That is the
 *      one place these tables deliberately differ, so it is asserted in both
 *      directions rather than assumed.
 *   2. **A deactivated rep loses it.** is_active_agent() reads as decoration
 *      on a table with no ownership to check, and is not: the catalog's SHAPE
 *      is as much company information as its prices.
 *   3. **The grants exist at all.** A table with perfect policies and no grant
 *      answers every request with `permission denied`, and there is no
 *      sequence grant to assert because the PAIR is the primary key.
 *   4. **The kinds are enforced by a trigger**, because a CHECK cannot see
 *      another row. The failure this prevents is not a leak — it is a row that
 *      matches nothing, forever, while /admin/products looks correct.
 *   5. **Nothing here is an access boundary.** `archived_at` hides a product
 *      from a rep through the QUERY, not through a policy, and this file pins
 *      that by showing a rep can still read an archived row.
 */

let db: TestDb;
let flexId = 0;
let miniId = 0;
let caseId = 0;
let chargerId = 0;
let archivedDeviceId = 0;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

/**
 * Two devices, two add-ons and an archived device.
 *
 * TRUNCATES FIRST for the reason seedProducts() in products.test.ts does:
 * products has no profiles reference, so resetData()'s cascade from `profiles`
 * never reaches it and rows survive every reset. `cascade` carries
 * product_compatibility and quote_line_items with it.
 *
 * Names carry an E2E-style prefix-free but obviously-fake shape on purpose —
 * these are fixtures, and the real catalog is deliberately unseeded because a
 * quote snapshots the price it was built from.
 */
async function seedCatalog(): Promise<void> {
  await asPlatform(db);
  await db.exec(`truncate products restart identity cascade`);
  // products.brand is a foreign key to brands(name), so both brands have to
  // exist first. brands survives resetData() for products' reason, hence
  // `on conflict`.
  await db.exec(
    `insert into brands (name) values ('Testco'), ('Othervendor')
     on conflict (name) do nothing`,
  );

  const created = await rows<{ id: number; name: string }>(
    db,
    `insert into products (name, sku, category, brand, kind, billing, list_price)
     values
       ('TEST Flex Terminal',  'T-FLEX', 'Mobile / wireless',    'Testco', 'device', 'one_time', '499.00'),
       ('TEST Mini Terminal',  'T-MINI', 'Countertop terminals', 'Testco', 'device', 'one_time', '749.00'),
       ('TEST Carry Case',     'T-CASE', 'Accessories',          'Testco', 'addon',  'one_time',  '49.00'),
       ('TEST Charging Dock',  'T-DOCK', 'Accessories',          'Othervendor', 'addon', 'monthly', '9.00'),
       ('TEST Retired Device', 'T-OLD',  'POS systems',          'Testco', 'device', 'one_time', '999.00')
     returning id, name`,
  );
  flexId = created.find((r) => r.name === "TEST Flex Terminal")!.id;
  miniId = created.find((r) => r.name === "TEST Mini Terminal")!.id;
  caseId = created.find((r) => r.name === "TEST Carry Case")!.id;
  chargerId = created.find((r) => r.name === "TEST Charging Dock")!.id;
  archivedDeviceId = created.find((r) => r.name === "TEST Retired Device")!.id;

  await db.exec(
    `update products set archived_at = now() where id = ${archivedDeviceId}`,
  );

  // The case fits both terminals; the dock fits only the Flex. That asymmetry
  // is what makes "a non-fitting add-on is not offered" a real assertion
  // rather than a statement about an empty table.
  await db.exec(
    `insert into product_compatibility (addon_product_id, device_product_id)
     values (${caseId}, ${flexId}), (${caseId}, ${miniId}), (${chargerId}, ${flexId})`,
  );
}

beforeEach(async () => {
  await resetData(db);
  await seedCatalog();
});

describe("the catalog's new columns", () => {
  it("defaults kind and billing rather than allowing null", async () => {
    // Both columns are NOT NULL with a default, which is what let them be
    // added to a populated table with no backfill decision. A product nobody
    // marked as an accessory is a standalone thing — the safe reading, because
    // it stays visible in the store rather than vanishing into an add-on list.
    await asUser(db, ADMIN_ID);
    await db.exec(
      `insert into products (name, category) values ('TEST Bare', 'Accessories')`,
    );

    const [row] = await rows<{ kind: string; billing: string; brand: null }>(
      db,
      `select kind, billing, brand from products where name = 'TEST Bare'`,
    );
    expect(row.kind).toBe("device");
    expect(row.billing).toBe("one_time");
    // Brand is nullable, unlike category: the catalog holds things no
    // manufacturer makes, and NOT NULL would force an admin to type a value
    // that then appears in a rep's brand list as if it were a vendor.
    expect(row.brand).toBeNull();
  });

  it("refuses a kind or billing outside its vocabulary", async () => {
    // Closed vocabularies, unlike category and brand, because CODE reads
    // these — the compatibility trigger, the store's device list, the
    // proposal's two totals. A third value is a row all three silently skip.
    await asUser(db, ADMIN_ID);
    await expect(
      db.exec(
        `insert into products (name, category, kind) values ('TEST X', 'A', 'bundle')`,
      ),
    ).rejects.toThrow(/products_kind_vocabulary/);
    await expect(
      db.exec(
        `insert into products (name, category, billing) values ('TEST Y', 'A', 'annual')`,
      ),
    ).rejects.toThrow(/products_billing_vocabulary/);
  });

  it("refuses a blank brand, which sku is not protected from", async () => {
    // The asymmetry is deliberate. A blank sku collides with the next blank
    // sku on idx_products_sku, so it fails loudly on the second one; brand has
    // no uniqueness to trip over, so '' would render as an empty heading in
    // the store and nothing would object.
    await asUser(db, ADMIN_ID);
    await expect(
      db.exec(
        `insert into products (name, category, brand) values ('TEST Z', 'A', '   ')`,
      ),
    ).rejects.toThrow(/products_brand_not_blank/);

    // Null is the way to say "no brand", and it is accepted.
    await db.exec(
      `insert into products (name, category, brand) values ('TEST Z', 'A', null)`,
    );
  });
});

describe("product_compatibility is company reference data", () => {
  it("lets every active user read it, including a second rep", async () => {
    for (const id of [AGENT_ID, OTHER_AGENT_ID, ADMIN_ID]) {
      await asUser(db, id);
      const found = await rows<{ addon_product_id: number }>(
        db,
        `select addon_product_id from product_compatibility`,
      );
      expect(found).toHaveLength(3);
    }
  });

  it("refuses a rep writing a compatibility row", async () => {
    // The failure this prevents is not a disclosure. A rep who could write
    // here would be editing the company's catalog — and with no agent_id on
    // the table there is no ownership check behind is_admin() to catch it.
    await asUser(db, AGENT_ID);
    await expect(
      db.exec(
        `insert into product_compatibility (addon_product_id, device_product_id)
         values (${chargerId}, ${miniId})`,
      ),
    ).rejects.toThrow();

    await asUser(db, AGENT_ID);
    await db.exec(
      `delete from product_compatibility where addon_product_id = ${caseId}`,
    );
    // Filtered to zero rows rather than refused, which is what an RLS DELETE
    // does — so the assertion is on the rows, not on an error.
    await asUser(db, ADMIN_ID);
    const survived = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from product_compatibility`,
    );
    expect(survived[0].n).toBe(3);
  });

  it("lets an admin link and UNLINK, which products has no path for", async () => {
    // The one place these two tables deliberately differ. A product is
    // archived rather than deleted because quote_line_items snapshots what it
    // said, so the row is history; a compatibility row is a current-state
    // claim nothing snapshots, so removing it is correct and an archived_at
    // here would mean tombstones every reader has to filter.
    await asUser(db, ADMIN_ID);
    await db.exec(
      `insert into product_compatibility (addon_product_id, device_product_id)
       values (${chargerId}, ${miniId})`,
    );
    expect(
      (
        await rows<{ n: number }>(
          db,
          `select count(*)::int as n from product_compatibility`,
        )
      )[0].n,
    ).toBe(4);

    await db.exec(
      `delete from product_compatibility
        where addon_product_id = ${chargerId} and device_product_id = ${miniId}`,
    );
    expect(
      (
        await rows<{ n: number }>(
          db,
          `select count(*)::int as n from product_compatibility`,
        )
      )[0].n,
    ).toBe(3);
  });

  it("cannot hold the same pair twice", async () => {
    await asUser(db, ADMIN_ID);
    await expect(
      db.exec(
        `insert into product_compatibility (addon_product_id, device_product_id)
         values (${caseId}, ${flexId})`,
      ),
    ).rejects.toThrow(/product_compatibility_pkey/);
  });

  it("refuses a row linking a product to itself", async () => {
    // Refused by the TRIGGER, not by product_compatibility_distinct, and the
    // reason is worth knowing: a BEFORE trigger runs ahead of the CHECK, and a
    // product is either 'addon' or 'device' — so for any pair (X, X) one of
    // the trigger's two kind tests always fails first. The constraint is
    // therefore unreachable through the normal path.
    await asUser(db, ADMIN_ID);
    await expect(
      db.exec(
        `insert into product_compatibility (addon_product_id, device_product_id)
         values (${caseId}, ${caseId})`,
      ),
    ).rejects.toThrow(/add-on side|device side/);
  });

  it("refuses a self-reference at the CONSTRAINT too, with the trigger out", async () => {
    // So the declarative half is proved on its own, by taking the trigger out
    // of the way. This is the documents_file_key_matches_owner arrangement:
    // two layers that each refuse the same thing, where the constraint is the
    // one that survives somebody deciding the trigger looks redundant.
    await asPlatform(db);
    await db.exec(
      `alter table product_compatibility
         disable trigger product_compatibility_enforce_kinds`,
    );
    try {
      await expect(
        db.exec(
          `insert into product_compatibility (addon_product_id, device_product_id)
           values (${caseId}, ${caseId})`,
        ),
      ).rejects.toThrow(/product_compatibility_distinct/);
    } finally {
      await db.exec(
        `alter table product_compatibility
           enable trigger product_compatibility_enforce_kinds`,
      );
    }
  });

  it("refuses a device id that is not a product at all", async () => {
    await asUser(db, ADMIN_ID);
    await expect(
      db.exec(
        `insert into product_compatibility (addon_product_id, device_product_id)
         values (${caseId}, 999999)`,
      ),
    ).rejects.toThrow();
  });
});

describe("a deactivated rep loses the compatibility table too", () => {
  beforeEach(async () => {
    await asPlatform(db);
    await db.exec(`update profiles set is_active = false where id = '${AGENT_ID}'`);
  });

  it("reads no compatibility rows once deactivated", async () => {
    // is_active_agent() is the only check in the select policy, and on a table
    // with no ownership to compare it is easy to read as decoration. A
    // deactivated rep holds a working JWT until it expires, and the catalog's
    // shape is company information.
    await asUser(db, AGENT_ID);
    expect(
      await rows(db, `select addon_product_id from product_compatibility`),
    ).toHaveLength(0);
  });

  it("still lets an admin read them", async () => {
    await asUser(db, ADMIN_ID);
    expect(
      await rows(db, `select addon_product_id from product_compatibility`),
    ).toHaveLength(3);
  });
});

describe("the kinds are enforced where a CHECK cannot reach", () => {
  it("refuses an add-on side that is not of kind addon", async () => {
    // A CHECK sees only its own row; this rule is about two OTHER rows, the
    // same reason set_manager()'s one-hop rule lives in a function.
    await asUser(db, ADMIN_ID);
    await expect(
      db.exec(
        `insert into product_compatibility (addon_product_id, device_product_id)
         values (${miniId}, ${flexId})`,
      ),
    ).rejects.toThrow(/add-on side/);
  });

  it("refuses a device side that is not of kind device", async () => {
    await asUser(db, ADMIN_ID);
    await expect(
      db.exec(
        `insert into product_compatibility (addon_product_id, device_product_id)
         values (${chargerId}, ${caseId})`,
      ),
    ).rejects.toThrow(/device side/);
  });

  it("catches the two ids written the wrong way round", async () => {
    // The actual mistake this trigger exists for, and why it is worth having
    // even though a wrong row is inert rather than dangerous: the store only
    // ever asks "which add-ons fit this device", so a reversed row matches
    // nothing, forever, and nothing reports it.
    await asUser(db, ADMIN_ID);
    await expect(
      db.exec(
        `insert into product_compatibility (addon_product_id, device_product_id)
         values (${flexId}, ${caseId})`,
      ),
    ).rejects.toThrow(/add-on side|device side/);
  });

  it("fires on UPDATE as well as INSERT", async () => {
    await asUser(db, ADMIN_ID);
    await expect(
      db.exec(
        `update product_compatibility set device_product_id = ${caseId}
          where addon_product_id = ${chargerId}`,
      ),
    ).rejects.toThrow(/device side/);
  });

  it("is security INVOKER, unlike the snapshot trigger", async () => {
    // Only an admin may write this table and an admin reads every product, so
    // there is nothing here the caller may not already see. definer in this
    // repo always owes a reason, and this function has none —
    // snapshot_quote_line_item() does, and the pair is worth reading together.
    await asPlatform(db);
    const [row] = await rows<{ prosecdef: boolean }>(
      db,
      `select prosecdef from pg_proc where proname = 'enforce_compatibility_kinds'`,
    );
    expect(row.prosecdef).toBe(false);
  });
});

describe("the grants, which RLS cannot stand in for", () => {
  it("holds exactly the four verbs for authenticated", async () => {
    // A table with perfect policies and no grant answers every request with
    // `permission denied for table`. DELETE is present here and absent on
    // products, which is the deliberate difference between them.
    await asPlatform(db);
    const [row] = await rows<Record<string, boolean>>(
      db,
      `select
         has_table_privilege('authenticated', 'product_compatibility', 'SELECT') as sel,
         has_table_privilege('authenticated', 'product_compatibility', 'INSERT') as ins,
         has_table_privilege('authenticated', 'product_compatibility', 'UPDATE') as upd,
         has_table_privilege('authenticated', 'product_compatibility', 'DELETE') as del,
         has_table_privilege('anon', 'product_compatibility', 'SELECT') as anon_sel`,
    );
    expect(row.sel).toBe(true);
    expect(row.ins).toBe(true);
    expect(row.upd).toBe(true);
    expect(row.del).toBe(true);
    // Never anon, on anything.
    expect(row.anon_sel).toBe(false);
  });

  it("has no sequence to grant, which is why that line is absent", async () => {
    // The checklist's step 4 names `grant usage on <t>_id_seq`. Asserted as an
    // absence so a future surrogate key cannot arrive without someone
    // noticing the missing grant: the PAIR is the primary key.
    await asPlatform(db);
    const seqs = await rows<{ relname: string }>(
      db,
      `select c.relname from pg_class c
        where c.relkind = 'S' and c.relname like 'product_compatibility%'`,
    );
    expect(seqs).toHaveLength(0);
  });
});

describe("archiving is a lifecycle state, not an access boundary", () => {
  it("still lets a rep READ an archived product", async () => {
    // What hides retired hardware from a rep is the QUERY
    // (`.is("archived_at", null)` plus isQuotable), never a policy. Three
    // reasons, and this test pins the third: a quote outlives the product on
    // it, so a policy hiding archived rows would make any future join from a
    // historical line come back empty while looking perfectly correct.
    await asUser(db, AGENT_ID);
    const found = await rows<{ id: number }>(
      db,
      `select id from products where id = ${archivedDeviceId}`,
    );
    expect(found).toHaveLength(1);
  });

  it("reads the word archived in no policy on either table", async () => {
    // The profiles.territory guard, applied here: a label that reads like an
    // access rule must not be wired into one, because then changing the label
    // silently changes who can see what. Un-archiving a terminal should put it
    // back in the picker, not re-grant a row.
    await asPlatform(db);
    const hits = await rows<{ policyname: string }>(
      db,
      `select policyname from pg_policies
        where tablename in ('products', 'product_compatibility')
          and (coalesce(qual, '') || coalesce(with_check, '')) like '%archived%'`,
    );
    expect(hits).toEqual([]);
  });
});
