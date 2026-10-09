import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_ID,
  AGENT_ID,
  asPlatform,
  asUser,
  createTestDb,
  resetData,
  rows,
  type TestDb,
} from "../helpers/db";

/**
 * brands — the manufacturers /admin/products is organised by.
 *
 * The FOURTH client-readable table with no agent_id, so the CLAUDE.md
 * checklist applies with step 1 struck out. The claims:
 *
 *   1. **Every active user reads it; only an admin writes it** — insert,
 *      update and delete each refused for a rep, and each asserted by its
 *      effect (the row is unchanged / still there), not only by an error,
 *      because an UPDATE or DELETE that RLS filters reports success.
 *   2. **A deactivated rep loses it**, for products' reason.
 *   3. **A brand cannot be deleted while any product names it** — archived
 *      products included, because they are history a quote line may name.
 *   4. **A rename cascades** to every product naming the brand, so no
 *      product is ever left pointing at a name that no longer exists.
 *   5. **The name is the identity**, so it is trimmed, non-blank and unique
 *      regardless of case — "Square" and "square" would be two boxes.
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

/**
 * TRUNCATES both catalog tables first: neither has a profiles reference, so
 * resetData()'s cascade from `profiles` never reaches them. `cascade` on
 * brands carries products (its FK child) and everything below products.
 */
beforeEach(async () => {
  await resetData(db);
  await asPlatform(db);
  await db.exec(`truncate brands, products restart identity cascade`);
  await db.exec(
    `insert into brands (name) values ('Testco'), ('Emptyco'), ('Pastco')`,
  );
  await db.exec(
    `insert into products (name, sku, category, brand, kind)
     values
       ('TEST Live Terminal', 'B-LIVE', 'Countertop terminals', 'Testco', 'device'),
       ('TEST Live Case',     'B-CASE', 'Accessories',          'Testco', 'addon'),
       ('TEST Old Terminal',  'B-OLD',  'Countertop terminals', 'Pastco', 'device')`,
  );
  // Pastco's only product is archived. It must still pin the brand.
  await db.exec(`update products set archived_at = now() where sku = 'B-OLD'`);
});

async function brandNames(): Promise<string[]> {
  await asPlatform(db);
  const found = await rows<{ name: string }>(
    db,
    `select name from brands order by name`,
  );
  return found.map((r) => r.name);
}

describe("who can read brands", () => {
  it("an active rep reads every brand", async () => {
    await asUser(db, AGENT_ID);
    const found = await rows<{ name: string }>(
      db,
      `select name from brands order by name`,
    );
    expect(found.map((r) => r.name)).toEqual(["Emptyco", "Pastco", "Testco"]);
  });

  it("a deactivated rep reads none", async () => {
    await asPlatform(db);
    await db.exec(`update profiles set is_active = false where id = '${AGENT_ID}'`);
    await asUser(db, AGENT_ID);
    expect(await rows(db, `select name from brands`)).toEqual([]);
  });
});

describe("only an admin writes brands", () => {
  it("an admin adds a brand that has no products yet", async () => {
    await asUser(db, ADMIN_ID);
    await db.exec(`insert into brands (name) values ('Material POS')`);
    expect(await brandNames()).toContain("Material POS");
  });

  it("a rep cannot add one", async () => {
    await asUser(db, AGENT_ID);
    await expect(
      db.exec(`insert into brands (name) values ('Rogue Brand')`),
    ).rejects.toThrow(/row-level security/);
    expect(await brandNames()).not.toContain("Rogue Brand");
  });

  it("a rep cannot rename one — the update matches nothing and the name stands", async () => {
    await asUser(db, AGENT_ID);
    const changed = await rows(
      db,
      `update brands set name = 'Hijacked' where name = 'Testco' returning id`,
    );
    expect(changed).toEqual([]);
    expect(await brandNames()).toContain("Testco");
    expect(await brandNames()).not.toContain("Hijacked");
  });

  it("a rep cannot delete one — even an empty brand survives", async () => {
    await asUser(db, AGENT_ID);
    const deleted = await rows(
      db,
      `delete from brands where name = 'Emptyco' returning id`,
    );
    expect(deleted).toEqual([]);
    expect(await brandNames()).toContain("Emptyco");
  });

  it("an admin deletes a brand with no products", async () => {
    await asUser(db, ADMIN_ID);
    await db.exec(`delete from brands where name = 'Emptyco'`);
    expect(await brandNames()).not.toContain("Emptyco");
  });
});

describe("a brand with products cannot be deleted", () => {
  it("refuses while a live product names it", async () => {
    await asUser(db, ADMIN_ID);
    await expect(
      db.exec(`delete from brands where name = 'Testco'`),
    ).rejects.toThrow(/products_brand_fkey/);
    expect(await brandNames()).toContain("Testco");
  });

  it("refuses while only an ARCHIVED product names it", async () => {
    // An archived product is history a quote line may name. `set null` here
    // would silently move it to the unbranded bucket; `restrict` refuses.
    await asUser(db, ADMIN_ID);
    await expect(
      db.exec(`delete from brands where name = 'Pastco'`),
    ).rejects.toThrow(/products_brand_fkey/);
    expect(await brandNames()).toContain("Pastco");
  });

  it("a product cannot name a brand that does not exist", async () => {
    await asUser(db, ADMIN_ID);
    await expect(
      db.exec(
        `insert into products (name, category, brand) values ('TEST X', 'A', 'Nobody Inc')`,
      ),
    ).rejects.toThrow(/products_brand_fkey/);
  });
});

describe("renaming a brand cascades", () => {
  it("rewrites every product that named it, archived included", async () => {
    await asUser(db, ADMIN_ID);
    await db.exec(`update brands set name = 'Testco Global' where name = 'Testco'`);
    await db.exec(`update brands set name = 'Pastco Ltd' where name = 'Pastco'`);

    await asPlatform(db);
    const products = await rows<{ sku: string; brand: string }>(
      db,
      `select sku, brand from products order by sku`,
    );
    expect(products).toEqual([
      { sku: "B-CASE", brand: "Testco Global" },
      { sku: "B-LIVE", brand: "Testco Global" },
      { sku: "B-OLD", brand: "Pastco Ltd" },
    ]);
  });

  it("keeps the id, so the brand's admin page keeps its address", async () => {
    await asPlatform(db);
    const [before] = await rows<{ id: number }>(
      db,
      `select id from brands where name = 'Testco'`,
    );
    await asUser(db, ADMIN_ID);
    await db.exec(`update brands set name = 'Testco Global' where id = ${before.id}`);
    await asPlatform(db);
    const [after] = await rows<{ name: string }>(
      db,
      `select name from brands where id = ${before.id}`,
    );
    expect(after.name).toBe("Testco Global");
  });
});

describe("the name is the identity", () => {
  it("refuses a case-only duplicate", async () => {
    await asUser(db, ADMIN_ID);
    await expect(
      db.exec(`insert into brands (name) values ('TESTCO')`),
    ).rejects.toThrow(/idx_brands_name_lower/);
  });

  it("refuses a padded or blank name", async () => {
    await asUser(db, ADMIN_ID);
    await expect(
      db.exec(`insert into brands (name) values (' Padded ')`),
    ).rejects.toThrow(/brands_name_trimmed/);
    await expect(
      db.exec(`insert into brands (name) values ('')`),
    ).rejects.toThrow(/brands_name_trimmed/);
  });
});

describe("nothing about a brand is an access boundary", () => {
  it("no policy anywhere reads the brands table or the brand column", async () => {
    // Brand is a browse axis. Wiring it into a policy would make renaming a
    // vendor change who can see what — profiles.territory's lesson.
    await asPlatform(db);
    const hits = await rows<{ tablename: string; policyname: string }>(
      db,
      `select tablename, policyname from pg_policies
        where coalesce(qual, '') ~* 'brand'
           or coalesce(with_check, '') ~* 'brand'`,
    );
    expect(hits).toEqual([]);
  });
});
