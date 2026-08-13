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
 * The same column list app/merchants/page.tsx reads, via MERCHANT_LIST_COLUMNS
 * in lib/merchants.ts. Kept literal here so the test exercises the real query
 * rather than `select *`, which would hide a column the page can't actually see.
 */
const LIST_COLUMNS =
  "id, agent_id, mid, dba, legal_business_name, status, processor, split_agent_pct, date_added";

const listQuery = (statusFilter?: string) => `
  select ${LIST_COLUMNS}
  from merchants
  ${statusFilter ? `where status = '${statusFilter}'` : ""}
  order by date_added desc, id desc
`;

type MerchantRow = {
  id: number;
  agent_id: string;
  dba: string;
  status: string;
};

type CountRow = { n: number };

// One database for the file, data reset before each test. Several of these
// mutate rows or deactivate the agent, so without the reset the suite would be
// order-dependent.
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

describe("merchants list scoping", () => {
  it("returns only the agent's own merchants", async () => {
    await asUser(db, AGENT_ID);

    const result = await rows<MerchantRow>(db, listQuery());

    expect(result).toHaveLength(2);
    expect(result.every((m) => m.agent_id === AGENT_ID)).toBe(true);
    expect(result.map((m) => m.dba).sort()).toEqual([
      "Agent Active Co",
      "Agent Inactive Co",
    ]);

    // The assertion that catches a leak: nothing belonging to the other agent.
    expect(result.map((m) => m.agent_id)).not.toContain(OTHER_AGENT_ID);
  });

  it("returns every merchant to an admin", async () => {
    await asUser(db, ADMIN_ID);

    const result = await rows<MerchantRow>(db, listQuery());

    // Without this the test above could pass against an empty table or a
    // deny-everyone policy.
    expect(result).toHaveLength(4);
    expect(new Set(result.map((m) => m.agent_id))).toEqual(
      new Set([AGENT_ID, OTHER_AGENT_ID]),
    );
  });

  it("returns nothing to an unauthenticated caller", async () => {
    await asUser(db, null);

    expect(await rows<MerchantRow>(db, listQuery())).toHaveLength(0);
  });
});

describe("merchants status filter", () => {
  it("intersects the status filter with the agent's own rows", async () => {
    await asUser(db, AGENT_ID);

    const active = await rows<MerchantRow>(db, listQuery("active"));

    // One of the four seeded merchants is both active and theirs. If the filter
    // ignored ownership this would be 2; if ownership ignored the filter, 2 also.
    expect(active).toHaveLength(1);
    expect(active[0].dba).toBe("Agent Active Co");
  });

  it("gives an admin every active merchant across agents", async () => {
    await asUser(db, ADMIN_ID);

    const active = await rows<MerchantRow>(db, listQuery("active"));

    expect(active).toHaveLength(2);
    expect(active.map((m) => m.dba).sort()).toEqual([
      "Agent Active Co",
      "Other Active Co",
    ]);
  });

  it("scopes the inactive and other filters the same way", async () => {
    await asUser(db, AGENT_ID);

    expect(await rows<MerchantRow>(db, listQuery("inactive"))).toHaveLength(1);
    // 'Other Other Co' is status 'other' but belongs to the other agent.
    expect(await rows<MerchantRow>(db, listQuery("other"))).toHaveLength(0);
  });
});

describe("merchants and deactivation", () => {
  it("hides all merchants from a deactivated agent", async () => {
    await asPlatform(db);
    await db.exec(
      `update profiles set is_active = false where id = '${AGENT_ID}';`,
    );

    await asUser(db, AGENT_ID);

    // Covered by the is_active_agent() gating in 20260805103000.
    expect(await rows<MerchantRow>(db, listQuery())).toHaveLength(0);
  });
});

describe("merchants write scoping", () => {
  it("does not let an agent update another agent's merchant", async () => {
    await asUser(db, AGENT_ID);

    // Filtered, not refused: the USING clause hides the row, so this matches
    // nothing. This is why the edit form checks the affected row count.
    await db.exec(
      `update merchants set dba = 'Hijacked' where dba = 'Other Active Co';`,
    );

    await asPlatform(db);
    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from merchants where dba = 'Other Active Co'`,
    );
    expect(n).toBe(1);
  });

  it("does not let an agent reassign their own merchant to someone else", async () => {
    await asUser(db, AGENT_ID);

    // The update policy's `with check` catches the outgoing row, so this is a
    // hard error rather than a silent no-op.
    await expect(
      db.exec(
        `update merchants set agent_id = '${OTHER_AGENT_ID}' where dba = 'Agent Active Co';`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("does not let an agent insert a merchant owned by someone else", async () => {
    await asUser(db, AGENT_ID);

    await expect(
      db.exec(
        `insert into merchants (agent_id, dba) values ('${OTHER_AGENT_ID}', 'Planted Co');`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("lets an agent insert a merchant in their own book", async () => {
    await asUser(db, AGENT_ID);

    await db.exec(
      `insert into merchants (agent_id, dba) values ('${AGENT_ID}', 'My New Co');`,
    );

    const result = await rows<MerchantRow>(db, listQuery());
    expect(result).toHaveLength(3);
    expect(result.map((m) => m.dba)).toContain("My New Co");
  });

  it("bumps updated_at when a merchant is edited", async () => {
    await asPlatform(db);
    const [before] = await rows<{ updated_at: string; created_at: string }>(
      db,
      `select updated_at, created_at from merchants where dba = 'Agent Active Co'`,
    );

    await asUser(db, AGENT_ID);
    await db.exec(
      `update merchants set processor = 'Nuvei' where dba = 'Agent Active Co';`,
    );

    await asPlatform(db);
    const [after] = await rows<{ updated_at: string }>(
      db,
      `select updated_at from merchants where dba = 'Agent Active Co'`,
    );

    // set_updated_at() fires on update. Before the trigger existed, updated_at
    // kept its insert-time default forever, so the detail page's "Last updated"
    // was really showing the creation time.
    expect(new Date(after.updated_at).getTime()).toBeGreaterThan(
      new Date(before.updated_at).getTime(),
    );
  });

  it("does not let the client dictate updated_at", async () => {
    await asUser(db, AGENT_ID);

    // The trigger overwrites whatever is supplied, so a wrong clock or a
    // hostile client can't backdate a row. This is why the form doesn't send
    // the column at all.
    await db.exec(`
      update merchants
      set processor = 'Nuvei', updated_at = '2000-01-01T00:00:00Z'
      where dba = 'Agent Active Co';
    `);

    await asPlatform(db);
    const [after] = await rows<{ updated_at: string }>(
      db,
      `select updated_at from merchants where dba = 'Agent Active Co'`,
    );

    expect(new Date(after.updated_at).getUTCFullYear()).toBeGreaterThan(2000);
  });

  it("lets an agent update their own merchant", async () => {
    await asUser(db, AGENT_ID);

    await db.exec(
      `update merchants set processor = 'Nuvei' where dba = 'Agent Active Co';`,
    );

    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from merchants where dba = 'Agent Active Co' and processor = 'Nuvei'`,
    );
    expect(n).toBe(1);
  });

  it("does not let an agent delete even their own merchant", async () => {
    await asUser(db, AGENT_ID);

    await db.exec(`delete from merchants where dba = 'Agent Active Co';`);

    await asPlatform(db);
    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from merchants where dba = 'Agent Active Co'`,
    );
    // Deletes are admin-only across the board (§5): reps edit, they don't remove
    // company records.
    expect(n).toBe(1);
  });

  it("lets an admin delete a merchant", async () => {
    await asUser(db, ADMIN_ID);

    await db.exec(`delete from merchants where dba = 'Agent Active Co';`);

    await asPlatform(db);
    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from merchants where dba = 'Agent Active Co'`,
    );
    expect(n).toBe(0);
  });
});

describe("regression: what the trigger migration changes", () => {
  const BEFORE_TRIGGERS = [
    "20260804201300_initial_schema.sql",
    "20260805103000_add_is_active_agent_and_profile_self_service.sql",
  ];

  it("without the trigger migration, updated_at never advances", async () => {
    const old = await createTestDb(BEFORE_TRIGGERS);
    await resetData(old);

    const [before] = await rows<{ updated_at: string }>(
      old,
      `select updated_at from merchants where dba = 'Agent Active Co'`,
    );

    await asUser(old, AGENT_ID);
    await old.exec(
      `update merchants set processor = 'Nuvei' where dba = 'Agent Active Co';`,
    );

    await asPlatform(old);
    const [after] = await rows<{ updated_at: string }>(
      old,
      `select updated_at from merchants where dba = 'Agent Active Co'`,
    );

    // The bug the trigger fixes: the column keeps its insert-time default, so
    // "last updated" was really "created". Asserted here so the fix above is
    // demonstrably load-bearing rather than assumed.
    expect(after.updated_at).toEqual(before.updated_at);

    await old.close();
  });
});

describe("merchants scoping test is load-bearing", () => {
  it("would catch a fail-open select policy", async () => {
    // Break the policy on a throwaway database and confirm the leak assertion in
    // "returns only the agent's own merchants" actually trips. Without this, that
    // test could be passing for an unrelated reason and we'd never know.
    const broken = await createTestDb();
    await resetData(broken);
    await asPlatform(broken);
    await broken.exec(`
      drop policy "select own or admin" on merchants;
      create policy "select own or admin" on merchants for select using (true);
    `);

    await asUser(broken, AGENT_ID);
    const leaked = await rows<MerchantRow>(broken, listQuery());

    expect(leaked).toHaveLength(4);
    expect(leaked.map((m) => m.agent_id)).toContain(OTHER_AGENT_ID);

    await broken.close();
  });
});

describe("merchants detail lookup", () => {
  it("cannot see another agent's merchant by id", async () => {
    await asPlatform(db);
    const [other] = await rows<{ id: number }>(
      db,
      `select id from merchants where dba = 'Other Active Co'`,
    );

    await asUser(db, AGENT_ID);
    const result = await rows<MerchantRow>(
      db,
      `select ${LIST_COLUMNS} from merchants where id = ${other.id}`,
    );

    // Zero rows, exactly as if the id didn't exist — which is why the detail
    // page 404s both cases instead of distinguishing them.
    expect(result).toHaveLength(0);
  });
});

/**
 * The split constraint added by 20260813162634.
 *
 * pre_apps has enforced agent + company = 100 since 20260806140000 and the
 * wizard derives the company half from the agent half, so an approved merchant
 * was always consistent. A hand-edited one was not — the merchant form takes
 * both numbers as free input, and 60/45 saved without complaint.
 *
 * Declared `not valid`, so these assert the half that is actually enforced:
 * every insert and update from here on. Pre-existing rows are deliberately
 * unchecked, and the last test pins that rather than leaving it to chance.
 */
describe("merchant split must total 100", () => {
  const insertSplit = (agent: string, company: string) => `
    insert into merchants (agent_id, dba, split_agent_pct, split_company_pct)
    values ('${AGENT_ID}', 'Split Test', ${agent}, ${company})
  `;

  it("accepts a pair totalling 100", async () => {
    await asUser(db, AGENT_ID);
    await db.exec(insertSplit("55", "45"));

    await asPlatform(db);
    const [m] = await rows<{ a: string; c: string }>(
      db,
      `select split_agent_pct::text as a, split_company_pct::text as c
         from merchants where dba = 'Split Test'`,
    );
    expect([m.a, m.c]).toEqual(["55.00", "45.00"]);
  });

  it("rejects a pair that does not total 100", async () => {
    await asUser(db, AGENT_ID);
    await expect(db.exec(insertSplit("60", "45"))).rejects.toThrow(
      /merchants_split_totals_100/,
    );
  });

  it("rejects one half on its own, which would read as the other being zero", async () => {
    await asUser(db, AGENT_ID);
    await expect(db.exec(insertSplit("55", "null"))).rejects.toThrow(
      /merchants_split_totals_100/,
    );
  });

  it("allows both halves null — a split simply not recorded yet", async () => {
    await asUser(db, AGENT_ID);
    await db.exec(insertSplit("null", "null"));

    await asPlatform(db);
    const [m] = await rows<{ a: string | null }>(
      db,
      `select split_agent_pct::text as a from merchants where dba = 'Split Test'`,
    );
    expect(m.a).toBeNull();
  });

  it("catches an UPDATE that breaks the total, not just an INSERT", async () => {
    // The form path that produced the 105% row in the first place.
    await asPlatform(db);
    const [m] = await rows<{ id: number }>(
      db,
      `select id from merchants where dba = 'Agent Active Co'`,
    );

    // Seeded 60/40, so raising the agent half alone takes it to 110. NOT VALID
    // skips the initial scan but still binds every later write, including
    // writes to rows that predate the constraint — which is the whole point.
    await asUser(db, AGENT_ID);
    await expect(
      db.exec(`update merchants set split_agent_pct = 70 where id = ${m.id}`),
    ).rejects.toThrow(/merchants_split_totals_100/);
  });

  it("is NOT VALID, so rows written before it are left alone", async () => {
    // The reason the migration does not normalise: nothing there can tell a
    // typo from a deal someone struck. Pinned so a later `validate constraint`
    // is a deliberate decision rather than an accident.
    await asPlatform(db);
    const [c] = await rows<{ convalidated: boolean }>(
      db,
      `select convalidated from pg_constraint
        where conname = 'merchants_split_totals_100'`,
    );
    expect(c.convalidated).toBe(false);
  });
});
