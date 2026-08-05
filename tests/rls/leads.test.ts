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
import { nextWeekBound } from "@/lib/leads";

/**
 * The same column list app/leads/page.tsx reads, via LEAD_LIST_COLUMNS in
 * lib/leads.ts. Literal here so the test exercises the real query rather than
 * `select *`, which would hide a column the page can't actually read.
 */
const LIST_COLUMNS =
  "id, agent_id, dba, contact_name, contact_phone, lead_source, industry_vertical, next_followup_date, status";

/**
 * Mirrors the switch in app/leads/page.tsx.
 *
 * The 'today' literals are the exact values the page sends — Postgres casts them
 * itself, so those boundaries are the database's date rather than a JS clock.
 * The next7 upper bound imports the page's own `nextWeekBound()` rather than
 * using `current_date + 7`, because that bound genuinely is computed in JS in
 * the page; using the DB's arithmetic here would test something the page doesn't
 * do and hide any drift between the two clocks.
 */
function predicate(filter: LeadFilter): string {
  switch (filter) {
    case "overdue":
      return "where next_followup_date < 'today'";
    case "today":
      return "where next_followup_date = 'today'";
    case "next7":
      return `where next_followup_date >= 'today' and next_followup_date <= '${nextWeekBound()}'`;
    case "unscheduled":
      return "where next_followup_date is null";
    case "all":
      return "";
  }
}

type LeadFilter = "all" | "overdue" | "today" | "next7" | "unscheduled";

const listQuery = (filter: LeadFilter = "all") => `
  select ${LIST_COLUMNS}
  from leads
  ${predicate(filter)}
  order by next_followup_date asc nulls last, id desc
`;

type LeadRow = {
  id: number;
  agent_id: string;
  dba: string | null;
  next_followup_date: string | null;
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

describe("leads list scoping", () => {
  it("returns only the agent's own leads", async () => {
    await asUser(db, AGENT_ID);

    const result = await rows<LeadRow>(db, listQuery());

    expect(result).toHaveLength(3);
    expect(result.every((l) => l.agent_id === AGENT_ID)).toBe(true);
    expect(result.map((l) => l.agent_id)).not.toContain(OTHER_AGENT_ID);
    expect(result.map((l) => l.dba)).not.toContain("Other Agent Lead");
  });

  it("returns every lead to an admin", async () => {
    await asUser(db, ADMIN_ID);

    const result = await rows<LeadRow>(db, listQuery());

    // Stops the test above passing against an empty table or a
    // deny-everyone policy.
    expect(result).toHaveLength(4);
    expect(new Set(result.map((l) => l.agent_id))).toEqual(
      new Set([AGENT_ID, OTHER_AGENT_ID]),
    );
  });

  it("returns nothing to an unauthenticated caller", async () => {
    await asUser(db, null);

    expect(await rows<LeadRow>(db, listQuery())).toHaveLength(0);
  });
});

describe("leads follow-up date filter", () => {
  it("finds the agent's overdue lead", async () => {
    await asUser(db, AGENT_ID);

    const result = await rows<LeadRow>(db, listQuery("overdue"));

    expect(result).toHaveLength(1);
    expect(result[0].dba).toBe("Agent Lead A");
  });

  it("finds the agent's lead due today", async () => {
    await asUser(db, AGENT_ID);

    const result = await rows<LeadRow>(db, listQuery("today"));

    expect(result).toHaveLength(1);
    expect(result[0].dba).toBe("Agent Lead B");
  });

  it("finds the agent's unscheduled lead", async () => {
    await asUser(db, AGENT_ID);

    const result = await rows<LeadRow>(db, listQuery("unscheduled"));

    // The bucket that would otherwise be invisible under every filter but All —
    // and the lead most likely to have been forgotten.
    expect(result).toHaveLength(1);
    expect(result[0].dba).toBe("Agent Lead C");
    expect(result[0].next_followup_date).toBeNull();
  });

  it("intersects the date window with ownership, not replacing it", async () => {
    await asUser(db, AGENT_ID);
    const agentNext7 = await rows<LeadRow>(db, listQuery("next7"));

    // Only 'Agent Lead B' (due today) is both in the window and theirs.
    // 'Other Agent Lead' is +2 days — inside the window, but not theirs.
    expect(agentNext7.map((l) => l.dba)).toEqual(["Agent Lead B"]);

    await asUser(db, ADMIN_ID);
    const adminNext7 = await rows<LeadRow>(db, listQuery("next7"));

    // The admin sees both, which is what proves the filter alone didn't exclude
    // the other agent's lead above — ownership did.
    expect(adminNext7.map((l) => l.dba).sort()).toEqual([
      "Agent Lead B",
      "Other Agent Lead",
    ]);
  });

  it("excludes undated leads from every date window", async () => {
    await asUser(db, AGENT_ID);

    for (const filter of ["overdue", "today", "next7"] as const) {
      const result = await rows<LeadRow>(db, listQuery(filter));
      expect(result.map((l) => l.dba)).not.toContain("Agent Lead C");
    }
  });
});

describe("leads and deactivation", () => {
  it("hides all leads from a deactivated agent", async () => {
    await asPlatform(db);
    await db.exec(
      `update profiles set is_active = false where id = '${AGENT_ID}';`,
    );

    await asUser(db, AGENT_ID);

    expect(await rows<LeadRow>(db, listQuery())).toHaveLength(0);
  });
});

describe("leads write scoping", () => {
  it("does not let an agent update another agent's lead", async () => {
    await asUser(db, AGENT_ID);

    // Filtered, not refused: the USING clause hides the row so this matches
    // nothing. This is why the edit form checks the affected row count.
    await db.exec(
      `update leads set dba = 'Hijacked' where dba = 'Other Agent Lead';`,
    );

    await asPlatform(db);
    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from leads where dba = 'Other Agent Lead'`,
    );
    expect(n).toBe(1);
  });

  it("does not let an agent reassign their own lead to someone else", async () => {
    await asUser(db, AGENT_ID);

    await expect(
      db.exec(
        `update leads set agent_id = '${OTHER_AGENT_ID}' where dba = 'Agent Lead A';`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("does not let an agent insert a lead owned by someone else", async () => {
    await asUser(db, AGENT_ID);

    await expect(
      db.exec(
        `insert into leads (agent_id, dba) values ('${OTHER_AGENT_ID}', 'Planted Lead');`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("lets an agent insert and update leads in their own book", async () => {
    await asUser(db, AGENT_ID);

    await db.exec(
      `insert into leads (agent_id, dba) values ('${AGENT_ID}', 'My New Lead');`,
    );
    await db.exec(
      `update leads set status = 'contacted' where dba = 'My New Lead';`,
    );

    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from leads where dba = 'My New Lead' and status = 'contacted'`,
    );
    expect(n).toBe(1);
  });

  it("bumps updated_at when a lead is edited", async () => {
    await asPlatform(db);
    const [before] = await rows<{ updated_at: string }>(
      db,
      `select updated_at from leads where dba = 'Agent Lead A'`,
    );

    await asUser(db, AGENT_ID);
    await db.exec(
      `update leads set status = 'contacted' where dba = 'Agent Lead A';`,
    );

    await asPlatform(db);
    const [after] = await rows<{ updated_at: string }>(
      db,
      `select updated_at from leads where dba = 'Agent Lead A'`,
    );

    // leads is covered by set_updated_at() from 20260805143000, same as
    // merchants.
    expect(new Date(after.updated_at).getTime()).toBeGreaterThan(
      new Date(before.updated_at).getTime(),
    );
  });

  it("does not let an agent delete even their own lead", async () => {
    await asUser(db, AGENT_ID);

    await db.exec(`delete from leads where dba = 'Agent Lead A';`);

    await asPlatform(db);
    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from leads where dba = 'Agent Lead A'`,
    );
    // Deletes are admin-only across the board (§5).
    expect(n).toBe(1);
  });

  it("lets an admin delete a lead", async () => {
    await asUser(db, ADMIN_ID);

    await db.exec(`delete from leads where dba = 'Agent Lead A';`);

    await asPlatform(db);
    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from leads where dba = 'Agent Lead A'`,
    );
    expect(n).toBe(0);
  });
});

describe("leads scoping test is load-bearing", () => {
  it("would catch a fail-open select policy", async () => {
    const broken = await createTestDb();
    await resetData(broken);
    await asPlatform(broken);
    await broken.exec(`
      drop policy "select own or admin" on leads;
      create policy "select own or admin" on leads for select using (true);
    `);

    await asUser(broken, AGENT_ID);
    const leaked = await rows<LeadRow>(broken, listQuery());

    expect(leaked).toHaveLength(4);
    expect(leaked.map((l) => l.agent_id)).toContain(OTHER_AGENT_ID);

    await broken.close();
  });
});

describe("leads detail lookup", () => {
  it("cannot see another agent's lead by id", async () => {
    await asPlatform(db);
    const [other] = await rows<{ id: number }>(
      db,
      `select id from leads where dba = 'Other Agent Lead'`,
    );

    await asUser(db, AGENT_ID);
    const result = await rows<LeadRow>(
      db,
      `select ${LIST_COLUMNS} from leads where id = ${other.id}`,
    );

    // Zero rows, exactly as if the id didn't exist — which is why the detail
    // page 404s both cases rather than distinguishing them.
    expect(result).toHaveLength(0);
  });
});
