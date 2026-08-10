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
 * dashboard_counts() and search_crm() are plain SECURITY INVOKER functions, and
 * that is the only thing making them safe: they carry no ownership check of
 * their own, so if RLS did not apply inside them an agent would read the
 * company's numbers and find records belonging to other reps.
 *
 * So these tests are not really about arithmetic or string matching. Each one
 * asks the same question — does the caller's own policy still scope the reads
 * inside the function — because the day someone adds `security definer` to
 * either signature, every count and every hit silently widens to the whole
 * table and nothing else in the suite would notice.
 *
 * Queries run as `authenticated` via asUser(). Running them as the owner would
 * pass whatever the policies said, since Postgres bypasses RLS for a table's
 * owner.
 */

type CountsRow = {
  active_merchants: string;
  active_leads: string;
  ghost_sheets_total: string;
  pre_apps_total: string;
  open_tickets: string;
};

type HitRow = {
  kind: string;
  record_id: number;
  title: string;
  subtitle: string | null;
};

/** count(*) is bigint, which arrives as a string. */
type Counts = Record<keyof CountsRow, number>;

async function counts(db: TestDb, userId: string | null): Promise<Counts> {
  await asUser(db, userId);
  const [row] = await rows<CountsRow>(db, `select * from dashboard_counts()`);
  return {
    active_merchants: Number(row.active_merchants),
    active_leads: Number(row.active_leads),
    ghost_sheets_total: Number(row.ghost_sheets_total),
    pre_apps_total: Number(row.pre_apps_total),
    open_tickets: Number(row.open_tickets),
  };
}

async function search(
  db: TestDb,
  userId: string | null,
  query: string,
  limit?: number,
): Promise<HitRow[]> {
  await asUser(db, userId);
  const args = limit === undefined ? `'${query}'` : `'${query}', ${limit}`;
  return rows<HitRow>(db, `select * from search_crm(${args})`);
}

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

describe("dashboard_counts is scoped by the caller's own RLS", () => {
  it("counts only the agent's rows for an agent", async () => {
    // Fixtures for AGENT_ID: 1 active + 1 inactive merchant, 3 leads (none with
    // a pre-app), 3 ghost sheets, 2 pre-apps, and 3 tickets of which 1 is open.
    expect(await counts(db, AGENT_ID)).toEqual({
      active_merchants: 1,
      active_leads: 3,
      ghost_sheets_total: 3,
      pre_apps_total: 2,
      open_tickets: 1,
    });
  });

  it("counts the whole company for an admin", async () => {
    // Every number is strictly larger than the agent's, which is what makes the
    // previous assertion meaningful rather than a coincidence of the fixtures.
    expect(await counts(db, ADMIN_ID)).toEqual({
      active_merchants: 2,
      active_leads: 4,
      ghost_sheets_total: 4,
      pre_apps_total: 3,
      open_tickets: 2,
    });
  });

  it("gives the other agent their own, different numbers", async () => {
    expect(await counts(db, OTHER_AGENT_ID)).toEqual({
      active_merchants: 1,
      active_leads: 1,
      ghost_sheets_total: 1,
      pre_apps_total: 1,
      open_tickets: 1,
    });
  });

  it("returns zeros for a caller with no JWT rather than the whole table", async () => {
    // auth.uid() is null, so no own-row branch matches and is_admin() is false.
    // The function has no guard of its own — this passing is entirely RLS.
    expect(await counts(db, null)).toEqual({
      active_merchants: 0,
      active_leads: 0,
      ghost_sheets_total: 0,
      pre_apps_total: 0,
      open_tickets: 0,
    });
  });

  it("stops counting a lead once a pre-app points at it", async () => {
    await asPlatform(db);
    await db.exec(`
      update pre_apps
         set lead_id = (select id from leads where dba = 'Agent Lead A')
       where dba_name = 'Agent Draft App'
    `);

    // The lead moved from Leads to Pre-Apps rather than being counted twice.
    const after = await counts(db, AGENT_ID);
    expect(after.active_leads).toBe(2);
    expect(after.pre_apps_total).toBe(2);
  });

  it("counts only active merchants, not the whole book", async () => {
    await asPlatform(db);
    await db.exec(
      `update merchants set status = 'inactive' where dba = 'Agent Active Co'`,
    );

    expect((await counts(db, AGENT_ID)).active_merchants).toBe(0);
  });

  it("counts open tickets only, not pending or closed", async () => {
    // The agent's three fixture tickets are one of each status, so 1 of 3 being
    // counted is the status filter working rather than a coincidence.
    expect((await counts(db, AGENT_ID)).open_tickets).toBe(1);

    await asPlatform(db);
    await db.exec(
      `update support_tickets set status = 'open'
        where agent_id = '${AGENT_ID}' and status = 'closed'`,
    );

    expect((await counts(db, AGENT_ID)).open_tickets).toBe(2);
  });
});

describe("search_crm is scoped by the caller's own RLS", () => {
  it("never returns another agent's records", async () => {
    // "Other" appears in the other agent's merchant, lead, sheet and pre-app.
    expect(await search(db, AGENT_ID, "Other")).toEqual([]);

    const asOther = await search(db, OTHER_AGENT_ID, "Other");
    expect(asOther.length).toBeGreaterThan(0);
  });

  it("lets an admin find any rep's record", async () => {
    const hits = await search(db, ADMIN_ID, "Other Active Co");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: "merchant", title: "Other Active Co" });
  });

  it("returns nothing at all for a caller with no JWT", async () => {
    // The term matches rows in four tables; every one is filtered out by RLS.
    expect(await search(db, null, "Agent")).toEqual([]);
  });

  it("spans record kinds and orders them by kind then title", async () => {
    const hits = await search(db, AGENT_ID, "Agent");

    // Leads before pre-apps before merchants before ghost sheets — the rank
    // column, which is deliberately not exposed in the result shape.
    expect(hits.map((h) => h.kind)).toEqual([
      "lead",
      "lead",
      "lead",
      "pre_app",
      "pre_app",
      "merchant",
      "merchant",
      "ghost_sheet",
      "ghost_sheet",
      "ghost_sheet",
    ]);
  });

  it("matches a contact name and a phone number, not just the DBA", async () => {
    const byContact = await search(db, AGENT_ID, "Ann Agent");
    expect(byContact.map((h) => h.title)).toContain("Agent Sheet Open");

    const byPhone = await search(db, AGENT_ID, "555-0102");
    expect(byPhone.map((h) => h.title)).toEqual(["Agent Sheet No Notes"]);
  });

  it("matches a merchant by MID", async () => {
    const hits = await search(db, AGENT_ID, "MID-AGENT-1");
    expect(hits).toEqual([
      {
        kind: "merchant",
        record_id: expect.any(Number),
        title: "Agent Active Co",
        subtitle: "Agent Active Co LLC",
      },
    ]);
  });

  it("is case-insensitive", async () => {
    const lower = await search(db, AGENT_ID, "agent active co");
    expect(lower.map((h) => h.title)).toContain("Agent Active Co");
  });

  it("returns nothing for a term under two characters", async () => {
    // Otherwise an empty box, or the first keystroke, dumps the caller's book.
    expect(await search(db, AGENT_ID, "")).toEqual([]);
    expect(await search(db, AGENT_ID, " ")).toEqual([]);
    expect(await search(db, AGENT_ID, "A")).toEqual([]);
    // Two characters is where results start.
    expect((await search(db, AGENT_ID, "Ag")).length).toBeGreaterThan(0);
  });

  it("treats LIKE metacharacters as literal text", async () => {
    // The bug this prevents: '%%' reaching ILIKE unescaped matches every row the
    // caller can see, so a rep who typed a stray % gets their whole book and no
    // indication why.
    expect(await search(db, AGENT_ID, "%%")).toEqual([]);
    expect(await search(db, AGENT_ID, "__")).toEqual([]);
    // '_' would otherwise match any single character, so this would find
    // 'Agent ...' rows.
    expect(await search(db, AGENT_ID, "Age_t")).toEqual([]);

    await asPlatform(db);
    await db.exec(
      `insert into leads (agent_id, dba) values ('${AGENT_ID}', '100% Diner')`,
    );
    const literal = await search(db, AGENT_ID, "100%");
    expect(literal.map((h) => h.title)).toEqual(["100% Diner"]);
  });

  it("limits per kind rather than overall", async () => {
    await asPlatform(db);
    await db.exec(`
      insert into leads (agent_id, dba) values
        ('${AGENT_ID}', 'Limit Lead 1'),
        ('${AGENT_ID}', 'Limit Lead 2'),
        ('${AGENT_ID}', 'Limit Lead 3');
      insert into merchants (agent_id, dba, status) values
        ('${AGENT_ID}', 'Limit Merchant 1', 'active'),
        ('${AGENT_ID}', 'Limit Merchant 2', 'active');
    `);

    const hits = await search(db, AGENT_ID, "Limit", 1);

    // One of each kind, not one row in total — otherwise a busy table crowds
    // every other kind out of the list.
    expect(hits.map((h) => h.kind)).toEqual(["lead", "merchant"]);
  });

  it("falls back to a placeholder title when the DBA is null", async () => {
    // dba is nullable on leads and ghost sheets, and a blank row in a search
    // list is unclickable in practice — the user cannot tell it is there.
    await asPlatform(db);
    await db.exec(
      `insert into leads (agent_id, dba, contact_name)
       values ('${AGENT_ID}', null, 'Nameless Nick')`,
    );

    const hits = await search(db, AGENT_ID, "Nameless");
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe("Nameless Nick");
  });
});

describe("both functions are locked down like every other RPC", () => {
  const SIGNATURES = ["dashboard_counts()", "search_crm(text, int)"];

  it("is not executable by anon", async () => {
    await asPlatform(db);
    for (const signature of SIGNATURES) {
      const [{ ok }] = await rows<{ ok: boolean }>(
        db,
        `select has_function_privilege('anon', '${signature}', 'execute') as ok`,
      );
      expect(ok, `anon should not execute ${signature}`).toBe(false);
    }
  });

  it("is executable by authenticated and service_role", async () => {
    await asPlatform(db);
    for (const signature of SIGNATURES) {
      for (const role of ["authenticated", "service_role"]) {
        const [{ ok }] = await rows<{ ok: boolean }>(
          db,
          `select has_function_privilege('${role}', '${signature}', 'execute') as ok`,
        );
        expect(ok, `${role} should execute ${signature}`).toBe(true);
      }
    }
  });

  it("is NOT security definer", async () => {
    // The property every test above depends on. prosecdef true here would make
    // the function run as its owner, bypass RLS, and turn the scoping
    // assertions into assertions about nothing.
    await asPlatform(db);
    const definers = await rows<{ proname: string }>(
      db,
      `select proname from pg_proc
        where proname in ('dashboard_counts', 'search_crm')
          and prosecdef`,
    );
    expect(definers).toEqual([]);
  });
});
