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
 * products — the product catalog.
 *
 * The second client-readable table in the schema with no agent_id, which is
 * what every claim here turns on. On an owner table the `agent_id = auth.uid()`
 * comparison is a second line of defence behind is_admin(); there is none here,
 * so a widened insert policy would hand the company's price list to every rep
 * to edit and nothing about the table's shape would look wrong.
 *
 * Four claims, each failing in a different direction:
 *
 *   1. **Readable by every active user, writable by nobody but an admin.**
 *      is_admin() is the ONLY check on a write.
 *   2. **A deactivated rep loses the catalog.** is_active_agent() in the select
 *      policy is the whole of that, and is easy to read as decoration on a
 *      table with no ownership to check. It is not: a deactivated rep holds a
 *      working JWT until it expires, and without it they keep reading the
 *      company's current pricing after being let go.
 *   3. **No delete path exists, for anyone.** Archiving is the retirement
 *      mechanism because quote_line_items references this table and a quote is
 *      evidence of what a merchant was offered.
 *   4. **The column constraints hold the two distinctions the money and the
 *      catch-all column depend on** — a null list_price is "not priced yet"
 *      rather than zero, and specs is an OBJECT rather than any valid JSON.
 */

type ProductRow = {
  id: number;
  name: string;
  sku: string | null;
  category: string;
  list_price: string | null;
  archived_at: string | null;
  specs: Record<string, unknown>;
};

let db: TestDb;

/** Ids created by seedProducts, so nothing hardcodes a serial. */
let terminalId = 0;
let archivedId = 0;
let unpricedId = 0;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db?.close();
});

/**
 * Three products: one ordinary, one archived, one with no list price.
 *
 * Kept here rather than in tests/helpers/db.ts `seed()` for the reason
 * seedPayouts() and seedMarketing() are: `seed()` also runs against migration
 * SUBSETS that predate this table (deactivation.test.ts calls
 * createTestDb([INITIAL_MIGRATION])), and anything it touches that a prefix has
 * not created yet fails those suites with `relation does not exist`, pointing
 * nowhere near the cause.
 *
 * TRUNCATES FIRST, and that line is load-bearing in a way the other seeders'
 * are not. resetData() clears the owner tables through the cascade from
 * `profiles` — but products deliberately has NO profiles reference (see the
 * migration), so the cascade never reaches it and rows survive every reset.
 * Without this the second test in the file dies on a duplicate sku, naming the
 * unique index rather than the fixture.
 *
 * `cascade` because quote_line_items references this table; `restart identity`
 * so the ids do not drift upward run after run. Module scope is assigned
 * anyway rather than hardcoding 1/2/3, so a future fixture row inserted above
 * these does not silently renumber them.
 */
async function seedProducts(): Promise<void> {
  await asPlatform(db);
  await db.exec(`truncate products restart identity cascade`);

  const created = await rows<{ id: number; name: string }>(
    db,
    `insert into products (name, sku, category, list_price, description)
     values
       ('Clover Flex',    'C401U', 'Mobile / wireless',     '499.00', 'Handheld, 4G + wifi'),
       ('Clover Mini',    'C301U', 'Countertop terminals',  '749.00', 'Discontinued'),
       ('Gateway monthly', null,   'Gateway & software',     null,    'Billed per month')
     returning id, name`,
  );
  terminalId = created.find((row) => row.name === "Clover Flex")!.id;
  archivedId = created.find((row) => row.name === "Clover Mini")!.id;
  unpricedId = created.find((row) => row.name === "Gateway monthly")!.id;

  await db.exec(
    `update products set archived_at = now() where id = ${archivedId}`,
  );
}

beforeEach(async () => {
  await resetData(db);
  await seedProducts();
});

describe("products is company reference data", () => {
  it("lets an agent read every product, archived ones included", async () => {
    // The point of the table: no agent_id, so no scoping. A rep sees the whole
    // catalog or the quote builder has nothing to pick from. Archived rows are
    // filtered by the UI, not by a policy — a quote that already names one
    // still has to render.
    await asUser(db, AGENT_ID);
    const list = await rows<ProductRow>(
      db,
      `select id, name, archived_at from products order by name`,
    );
    expect(list.map((row) => row.name)).toEqual([
      "Clover Flex",
      "Clover Mini",
      "Gateway monthly",
    ]);
  });

  it("lets a second agent read the same rows", async () => {
    // Asserted separately from the first agent, because a select policy that
    // accidentally compared something to auth.uid() could still pass for
    // whichever user the fixture happened to favour.
    await asUser(db, OTHER_AGENT_ID);
    const [{ n }] = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from products`,
    );
    expect(n).toBe(3);
  });

  it("refuses an agent inserting a product", async () => {
    // is_admin() is the ONLY check on this table's writes. There is no
    // agent_id for a second condition to fall back on.
    await asUser(db, AGENT_ID);
    await expect(
      db.exec(
        `insert into products (name, category, list_price)
         values ('Forged terminal', 'Accessories', '1.00')`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("refuses an agent repricing a product", async () => {
    // The failure this guards is specific and quiet: a rep who could write
    // list_price could discount the company's catalog for everyone, and the
    // next quote anybody built would snapshot the altered figure.
    await asUser(db, AGENT_ID);
    await db.exec(
      `update products set list_price = '1.00' where id = ${terminalId}`,
    );

    // An UPDATE blocked by RLS is not an error — it matches zero rows. So the
    // assertion has to be on the data, not on a rejection.
    await asPlatform(db);
    const [row] = await rows<ProductRow>(
      db,
      `select list_price from products where id = ${terminalId}`,
    );
    expect(row.list_price).toBe("499.00");
  });

  it("lets an admin insert, edit and archive", async () => {
    await asUser(db, ADMIN_ID);
    await db.exec(
      `insert into products (name, sku, category, list_price)
       values ('PAX A920', 'A920', 'Mobile / wireless', '399.00')`,
    );
    await db.exec(
      `update products set archived_at = now() where id = ${terminalId}`,
    );

    const live = await rows<ProductRow>(
      db,
      `select name from products where archived_at is null order by name`,
    );
    expect(live.map((row) => row.name)).toEqual([
      "Gateway monthly",
      "PAX A920",
    ]);
  });

  it("has no delete path, even for an admin", async () => {
    // Archiving is the retirement mechanism: a product exists to be referenced
    // by quote_line_items, and a delete would either cascade historical quote
    // lines away or be blocked by the FK forever. No policy and no grant, so
    // this is denied at the privilege layer rather than filtered to zero rows.
    await asUser(db, ADMIN_ID);
    await expect(
      db.exec(`delete from products where id = ${archivedId}`),
    ).rejects.toThrow(/permission denied|policy/i);
  });

  it("stamps updated_at on an admin edit", async () => {
    await asPlatform(db);
    await db.exec(
      `update products set updated_at = '2020-01-01' where id = ${terminalId}`,
    );

    await asUser(db, ADMIN_ID);
    await db.exec(
      `update products set name = 'Clover Flex 3' where id = ${terminalId}`,
    );

    await asPlatform(db);
    const [row] = await rows<{ recent: boolean }>(
      db,
      `select updated_at > '2021-01-01' as recent
         from products where id = ${terminalId}`,
    );
    expect(row.recent).toBe(true);
  });
});

describe("a deactivated rep loses the catalog", () => {
  beforeEach(async () => {
    await asPlatform(db);
    await db.exec(
      `update profiles set is_active = false where id = '${AGENT_ID}'`,
    );
  });

  it("reads no products once deactivated", async () => {
    // The whole of this is is_active_agent() in the select policy. On an owner
    // table that check sits next to an agent_id comparison; here it is the only
    // thing there is, and without it a let-go rep keeps the current price list.
    await asUser(db, AGENT_ID);
    const [{ n }] = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from products`,
    );
    expect(n).toBe(0);
  });

  it("still lets an admin read them", async () => {
    // is_admin() is the other half of the same policy, and deactivating one
    // rep must not have touched it.
    await asUser(db, ADMIN_ID);
    const [{ n }] = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from products`,
    );
    expect(n).toBe(3);
  });
});

describe("the column constraints", () => {
  it("accepts a null list_price, because that is not the same as zero", async () => {
    // "Not priced yet" has to be storable and has to stay distinguishable from
    // free. create_quote_version() refuses to put one of these on a quote;
    // this asserts the catalog can hold it in the first place.
    await asPlatform(db);
    const [row] = await rows<ProductRow>(
      db,
      `select list_price from products where id = ${unpricedId}`,
    );
    expect(row.list_price).toBeNull();
  });

  it("refuses a negative list price", async () => {
    // Unsigned, unlike rep_payout_rows.total_cost. A clawback is a real
    // negative residual; a negative list price is a typo.
    await asPlatform(db);
    await expect(
      db.exec(
        `insert into products (name, category, list_price)
         values ('Impossible', 'Accessories', '-1.00')`,
      ),
    ).rejects.toThrow(/list_price/i);
  });

  it("refuses a duplicate sku", async () => {
    await asPlatform(db);
    await expect(
      db.exec(
        `insert into products (name, sku, category)
         values ('Clone', 'C401U', 'Accessories')`,
      ),
    ).rejects.toThrow(/idx_products_sku|unique/i);
  });

  it("allows many products with no sku at all", async () => {
    // The reason the unique index is PARTIAL. NULLs are distinct from one
    // another, so several unpriced service lines coexist — which is exactly
    // what a plain unique index would have forbidden the moment two of them
    // normalised to the empty string instead.
    await asPlatform(db);
    await db.exec(
      `insert into products (name, sku, category)
       values ('PCI compliance', null, 'Services'),
              ('Paper rolls',    null, 'Accessories')`,
    );

    const [{ n }] = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from products where sku is null`,
    );
    expect(n).toBe(3);
  });

  it("refuses specs that are valid JSON but not an object", async () => {
    // The whole reason the CHECK exists. Each of these is a perfectly valid
    // jsonb document, and each one turns every `specs ->> 'key'` in the app
    // into a silent NULL rather than an error.
    await asPlatform(db);
    for (const value of ["'4'::jsonb", "'null'::jsonb", `'[1,2]'::jsonb`, `'"text"'::jsonb`]) {
      await expect(
        db.exec(
          `insert into products (name, category, specs)
           values ('Bad specs', 'Accessories', ${value})`,
        ),
        `specs must reject ${value}`,
      ).rejects.toThrow(/specs/i);
    }
  });

  it("accepts an arbitrary object in specs, which is the point of the column", async () => {
    // The lineup is not finalised, so the test asserts that an unforeseen shape
    // is storable rather than asserting any particular key.
    await asUser(db, ADMIN_ID);
    await db.exec(
      `insert into products (name, category, specs)
       values ('Unknown future device', 'Accessories',
               '{"connectivity": ["wifi", "4g"], "ports": 3, "nested": {"psu": "12V"}}'::jsonb)`,
    );

    const [row] = await rows<ProductRow>(
      db,
      `select specs from products where name = 'Unknown future device'`,
    );
    expect(row.specs).toEqual({
      connectivity: ["wifi", "4g"],
      ports: 3,
      nested: { psu: "12V" },
    });
  });

  it("defaults specs to an empty object rather than null", async () => {
    // `not null default '{}'` so every reader can do a key lookup without a
    // null guard first.
    await asPlatform(db);
    const [row] = await rows<ProductRow>(
      db,
      `select specs from products where id = ${terminalId}`,
    );
    expect(row.specs).toEqual({});
  });
});

describe("no cross-agent audit trigger is attached", () => {
  it("writes no audit_log row when an admin edits a product", async () => {
    // Deliberate, and the same answer marketing_materials gives: there is no
    // agent_id, so log_cross_agent_change() would read NULL out of
    // to_jsonb(NEW) and log EVERY write — the support_ticket_replies trap.
    // Asserted because attaching it would look like a tidy-up.
    await asUser(db, ADMIN_ID);
    await db.exec(
      `update products set name = 'Clover Flex 3' where id = ${terminalId}`,
    );

    await asPlatform(db);
    const [{ n }] = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from audit_log where table_name = 'products'`,
    );
    expect(n).toBe(0);
  });
});
