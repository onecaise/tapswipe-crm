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
