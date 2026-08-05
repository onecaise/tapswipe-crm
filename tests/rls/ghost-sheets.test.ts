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

/** Matches GHOST_SHEET_LIST_COLUMNS in lib/ghost-sheets.ts. */
const LIST_COLUMNS =
  "id, agent_id, lead_id, dba, contact_name, contact_phone, status, created_at";

/**
 * Mirrors app/ghost-sheets/page.tsx, which filters on `lead_id is null` rather
 * than on `status`. status is unconstrained text, but lead_id is the column
 * conversion actually writes, so it can't drift from reality.
 */
const listQuery = (filter: "all" | "open" | "converted" = "all") => `
  select ${LIST_COLUMNS}
  from ghost_sheets
  ${filter === "open" ? "where lead_id is null" : ""}
  ${filter === "converted" ? "where lead_id is not null" : ""}
  order by created_at desc, id desc
`;

type SheetRow = {
  id: number;
  agent_id: string;
  lead_id: number | null;
  dba: string | null;
};

type CountRow = { n: number };

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

describe("ghost sheets list scoping", () => {
  it("returns only the agent's own sheets", async () => {
    await asUser(db, AGENT_ID);

    const result = await rows<SheetRow>(db, listQuery());

    expect(result).toHaveLength(3);
    expect(result.every((s) => s.agent_id === AGENT_ID)).toBe(true);
    expect(result.map((s) => s.dba)).not.toContain("Other Sheet Open");
  });

  it("returns every sheet to an admin", async () => {
    await asUser(db, ADMIN_ID);

    const result = await rows<SheetRow>(db, listQuery());

    // Stops the test above passing against an empty table.
    expect(result).toHaveLength(4);
    expect(new Set(result.map((s) => s.agent_id))).toEqual(
      new Set([AGENT_ID, OTHER_AGENT_ID]),
    );
  });

  it("returns nothing to an unauthenticated caller", async () => {
    await asUser(db, null);

    expect(await rows<SheetRow>(db, listQuery())).toHaveLength(0);
  });
});

describe("ghost sheets conversion-state filter", () => {
  it("intersects the filter with ownership", async () => {
    await asUser(db, AGENT_ID);

    const open = await rows<SheetRow>(db, listQuery("open"));
    const converted = await rows<SheetRow>(db, listQuery("converted"));

    expect(open.map((s) => s.dba).sort()).toEqual([
      "Agent Sheet No Notes",
      "Agent Sheet Open",
    ]);
    expect(converted.map((s) => s.dba)).toEqual(["Agent Sheet Converted"]);

    // The other agent's open sheet is excluded by ownership, not by the filter —
    // the admin view below is what proves that.
    await asUser(db, ADMIN_ID);
    const adminOpen = await rows<SheetRow>(db, listQuery("open"));
    expect(adminOpen).toHaveLength(3);
    expect(adminOpen.map((s) => s.dba)).toContain("Other Sheet Open");
  });
});

describe("ghost sheets and deactivation", () => {
  it("hides all sheets from a deactivated agent", async () => {
    await asPlatform(db);
    await db.exec(
      `update profiles set is_active = false where id = '${AGENT_ID}';`,
    );

    await asUser(db, AGENT_ID);

    expect(await rows<SheetRow>(db, listQuery())).toHaveLength(0);
  });
});

describe("ghost sheets write scoping", () => {
  it("does not let an agent update another agent's sheet", async () => {
    await asUser(db, AGENT_ID);

    await db.exec(
      `update ghost_sheets set dba = 'Hijacked' where dba = 'Other Sheet Open';`,
    );

    await asPlatform(db);
    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from ghost_sheets where dba = 'Other Sheet Open'`,
    );
    expect(n).toBe(1);
  });

  it("does not let an agent reassign their own sheet to someone else", async () => {
    await asUser(db, AGENT_ID);

    await expect(
      db.exec(
        `update ghost_sheets set agent_id = '${OTHER_AGENT_ID}' where dba = 'Agent Sheet Open';`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("does not let an agent insert a sheet owned by someone else", async () => {
    await asUser(db, AGENT_ID);

    await expect(
      db.exec(
        `insert into ghost_sheets (agent_id, dba) values ('${OTHER_AGENT_ID}', 'Planted Sheet');`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("lets an agent insert and update sheets in their own book", async () => {
    await asUser(db, AGENT_ID);

    await db.exec(
      `insert into ghost_sheets (agent_id, dba) values ('${AGENT_ID}', 'My New Sheet');`,
    );
    await db.exec(
      `update ghost_sheets set contact_name = 'Someone' where dba = 'My New Sheet';`,
    );

    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from ghost_sheets where dba = 'My New Sheet' and contact_name = 'Someone'`,
    );
    expect(n).toBe(1);
  });

  it("does not let an agent delete even their own sheet", async () => {
    await asUser(db, AGENT_ID);

    await db.exec(`delete from ghost_sheets where dba = 'Agent Sheet Open';`);

    await asPlatform(db);
    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from ghost_sheets where dba = 'Agent Sheet Open'`,
    );
    expect(n).toBe(1);
  });

  it("lets an admin delete a sheet", async () => {
    await asUser(db, ADMIN_ID);

    await db.exec(`delete from ghost_sheets where dba = 'Agent Sheet Open';`);

    await asPlatform(db);
    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from ghost_sheets where dba = 'Agent Sheet Open'`,
    );
    expect(n).toBe(0);
  });
});

describe("ghost sheets scoping test is load-bearing", () => {
  it("would catch a fail-open select policy", async () => {
    const broken = await createTestDb();
    await resetData(broken);
    await asPlatform(broken);
    await broken.exec(`
      drop policy "select own or admin" on ghost_sheets;
      create policy "select own or admin" on ghost_sheets for select using (true);
    `);

    await asUser(broken, AGENT_ID);
    const leaked = await rows<SheetRow>(broken, listQuery());

    expect(leaked).toHaveLength(4);
    expect(leaked.map((s) => s.agent_id)).toContain(OTHER_AGENT_ID);

    await broken.close();
  });
});

describe("ghost sheets detail lookup", () => {
  it("cannot see another agent's sheet by id", async () => {
    await asPlatform(db);
    const [other] = await rows<{ id: number }>(
      db,
      `select id from ghost_sheets where dba = 'Other Sheet Open'`,
    );

    await asUser(db, AGENT_ID);
    const result = await rows<SheetRow>(
      db,
      `select ${LIST_COLUMNS} from ghost_sheets where id = ${other.id}`,
    );

    expect(result).toHaveLength(0);
  });
});
