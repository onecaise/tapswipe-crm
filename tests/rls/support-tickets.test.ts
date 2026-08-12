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
 * The same column list app/support-tickets/page.tsx reads, via
 * SUPPORT_TICKET_LIST_COLUMNS. Literal here so the test exercises the real
 * query rather than `select *`, which would hide a column the page cannot
 * actually read.
 */
const LIST_COLUMNS =
  "id, agent_id, merchant_id, subject, category, priority, status, created_at";

type TicketFilter = "all" | "open" | "pending" | "closed";

const listQuery = (filter: TicketFilter = "all") => `
  select ${LIST_COLUMNS}
  from support_tickets
  ${filter === "all" ? "" : `where status = '${filter}'`}
  order by id desc
`;

type TicketRow = {
  id: number;
  agent_id: string;
  subject: string;
  status: string;
  merchant_id: number | null;
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

describe("support tickets list scoping", () => {
  it("returns only the agent's own tickets", async () => {
    await asUser(db, AGENT_ID);

    const result = await rows<TicketRow>(db, listQuery());

    expect(result).toHaveLength(3);
    expect(result.every((t) => t.agent_id === AGENT_ID)).toBe(true);
    expect(result.map((t) => t.subject)).not.toContain("Reprint receipts");
  });

  it("returns every ticket to an admin", async () => {
    await asUser(db, ADMIN_ID);

    const result = await rows<TicketRow>(db, listQuery());

    // Stops the test above passing against an empty table or a deny-everyone
    // policy.
    expect(result).toHaveLength(4);
    expect(new Set(result.map((t) => t.agent_id))).toEqual(
      new Set([AGENT_ID, OTHER_AGENT_ID]),
    );
  });

  it("returns nothing to an unauthenticated caller", async () => {
    await asUser(db, null);

    expect(await rows<TicketRow>(db, listQuery())).toHaveLength(0);
  });

  it("hides every ticket from a deactivated agent", async () => {
    await asPlatform(db);
    await db.exec(
      `update profiles set is_active = false where id = '${AGENT_ID}';`,
    );

    await asUser(db, AGENT_ID);

    // A valid JWT proves who the caller is, not that the account is still
    // enabled — is_active_agent() is the half that re-checks per request.
    expect(await rows<TicketRow>(db, listQuery())).toHaveLength(0);
  });
});

describe("support tickets status filter", () => {
  it("intersects the status with ownership, not replacing it", async () => {
    await asUser(db, AGENT_ID);
    const agentOpen = await rows<TicketRow>(db, listQuery("open"));

    // The other agent's ticket is 'open' too, so a filter that had lost its
    // ownership half would pick it up here.
    expect(agentOpen.map((t) => t.subject)).toEqual([
      "Terminal will not batch",
    ]);

    await asUser(db, ADMIN_ID);
    const adminOpen = await rows<TicketRow>(db, listQuery("open"));

    // The admin seeing both is what proves the filter alone didn't exclude the
    // other agent's ticket above — ownership did.
    expect(adminOpen.map((t) => t.subject).sort()).toEqual([
      "Reprint receipts",
      "Terminal will not batch",
    ]);
  });

  it("separates the agent's own statuses", async () => {
    await asUser(db, AGENT_ID);

    expect((await rows<TicketRow>(db, listQuery("pending"))).map((t) => t.subject))
      .toEqual(["Statement copy request"]);
    expect((await rows<TicketRow>(db, listQuery("closed"))).map((t) => t.subject))
      .toEqual(["Old chargeback question"]);
  });
});

describe("support tickets status constraint", () => {
  it("rejects a status outside the vocabulary", async () => {
    await asUser(db, AGENT_ID);

    await expect(
      db.exec(
        `insert into support_tickets (agent_id, subject, status)
         values ('${AGENT_ID}', 'Bad status', 'escalated');`,
      ),
    ).rejects.toThrow(/support_tickets_status_check/i);
  });

  it("rejects a null status, which would defeat the check and every filter", async () => {
    await asUser(db, AGENT_ID);

    // The pre_apps.status lesson: a CHECK that evaluates to NULL passes, so
    // without NOT NULL this row would satisfy the constraint and then fall out
    // of every status tab at once.
    await expect(
      db.exec(
        `insert into support_tickets (agent_id, subject, status)
         values ('${AGENT_ID}', 'Null status', null);`,
      ),
    ).rejects.toThrow(/null value in column "status"|not-null/i);
  });

  it("defaults a new ticket to open", async () => {
    await asUser(db, AGENT_ID);

    await db.exec(
      `insert into support_tickets (agent_id, subject)
       values ('${AGENT_ID}', 'Defaulted ticket');`,
    );

    const [row] = await rows<{ status: string }>(
      db,
      `select status from support_tickets where subject = 'Defaulted ticket'`,
    );
    expect(row.status).toBe("open");
  });
});

describe("support tickets write scoping", () => {
  it("does not let an agent insert a ticket owned by someone else", async () => {
    await asUser(db, AGENT_ID);

    await expect(
      db.exec(
        `insert into support_tickets (agent_id, subject)
         values ('${OTHER_AGENT_ID}', 'Planted ticket');`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("does not let an agent update another agent's ticket", async () => {
    await asUser(db, AGENT_ID);

    // Filtered, not refused: the USING clause hides the row so this matches
    // nothing. This is why the form checks the affected row count.
    await db.exec(
      `update support_tickets set status = 'closed' where subject = 'Reprint receipts';`,
    );

    await asPlatform(db);
    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from support_tickets
        where subject = 'Reprint receipts' and status = 'open'`,
    );
    expect(n).toBe(1);
  });

  it("does not let an agent reassign their own ticket", async () => {
    await asUser(db, AGENT_ID);

    await expect(
      db.exec(
        `update support_tickets set agent_id = '${OTHER_AGENT_ID}'
          where subject = 'Statement copy request';`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("lets an agent insert and update tickets in their own book", async () => {
    await asUser(db, AGENT_ID);

    await db.exec(
      `insert into support_tickets (agent_id, subject, status)
       values ('${AGENT_ID}', 'My New Ticket', 'open');`,
    );
    await db.exec(
      `update support_tickets set status = 'closed' where subject = 'My New Ticket';`,
    );

    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from support_tickets
        where subject = 'My New Ticket' and status = 'closed'`,
    );
    expect(n).toBe(1);
  });

  it("does not let an agent delete even their own ticket", async () => {
    await asUser(db, AGENT_ID);

    await db.exec(
      `delete from support_tickets where subject = 'Statement copy request';`,
    );

    await asPlatform(db);
    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from support_tickets
        where subject = 'Statement copy request'`,
    );
    // Deletes are admin-only, as on every Tier 1 table except documents.
    expect(n).toBe(1);
  });

  it("lets an admin delete a ticket", async () => {
    await asUser(db, ADMIN_ID);

    await db.exec(
      `delete from support_tickets where subject = 'Statement copy request';`,
    );

    await asPlatform(db);
    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from support_tickets
        where subject = 'Statement copy request'`,
    );
    // Before 20260810171500 there was no delete policy at all, so this was zero
    // rows deleted rather than one — "admin only" and "nobody" look identical
    // from the client, which is how the gap survived.
    expect(n).toBe(0);
  });
});

describe("support tickets detail lookup", () => {
  it("lets the owning agent read their own ticket by id", async () => {
    await asPlatform(db);
    const [own] = await rows<{ id: number }>(
      db,
      `select id from support_tickets where subject = 'Terminal will not batch'`,
    );

    await asUser(db, AGENT_ID);
    const result = await rows<TicketRow>(
      db,
      // The detail page's own query shape: one row, by id, with no agent_id
      // filter of its own. The negative below is only meaningful next to this —
      // a deny-everyone policy would satisfy "cannot see another agent's" while
      // breaking every ticket page in the app.
      `select ${LIST_COLUMNS} from support_tickets where id = ${own.id}`,
    );

    expect(result).toHaveLength(1);
    expect(result[0].subject).toBe("Terminal will not batch");
  });

  it("cannot see another agent's ticket by id", async () => {
    await asPlatform(db);
    const [other] = await rows<{ id: number }>(
      db,
      `select id from support_tickets where subject = 'Reprint receipts'`,
    );

    await asUser(db, AGENT_ID);
    const result = await rows<TicketRow>(
      db,
      `select ${LIST_COLUMNS} from support_tickets where id = ${other.id}`,
    );

    // Zero rows, exactly as if the id didn't exist — which is why the detail
    // page 404s both cases rather than distinguishing them.
    expect(result).toHaveLength(0);
  });

  it("refuses to delete a merchant while a ticket still points at it", async () => {
    await asUser(db, ADMIN_ID);

    // support_tickets.merchant_id has no ON DELETE clause, so it defaults to
    // NO ACTION: the referenced merchant cannot be deleted while a ticket
    // points at it. Asserted rather than assumed, because the shape differs
    // from ghost_sheets.lead_id (`on delete set null`) and an admin hitting
    // this sees a bare FK error on the merchants page.
    //
    // 'Agent Inactive Co' is the referenced one; 'Agent Active Co' is left
    // clear for merchants.test.ts's own delete tests. See the fixture comment.
    await expect(
      db.exec(`delete from merchants where dba = 'Agent Inactive Co';`),
    ).rejects.toThrow(/foreign key|violates/i);
  });
});

describe("support ticket priority", () => {
  it("stores every level the form offers", async () => {
    await asPlatform(db);
    const [own] = await rows<{ id: number }>(
      db,
      `select id from support_tickets where subject = 'Terminal will not batch'`,
    );

    // priority is bare `text` — no check constraint, deliberately, so an admin
    // can introduce a level without a migration. Asserted rather than assumed:
    // the form was reported as offering only "Normal", and the question of
    // whether the database or the UI was the limit is exactly what this pins.
    // If someone ever adds a constraint, this fails and says so.
    for (const level of ["Low", "Normal", "High", "Urgent"]) {
      await asUser(db, AGENT_ID);
      await db.exec(
        `update support_tickets set priority = '${level}' where id = ${own.id};`,
      );

      const [row] = await rows<{ priority: string }>(
        db,
        `select priority from support_tickets where id = ${own.id}`,
      );
      expect(row.priority).toBe(level);
    }
  });

  it("lets an admin change priority and status on a ticket they do not own", async () => {
    await asPlatform(db);
    const [own] = await rows<{ id: number }>(
      db,
      `select id from support_tickets where subject = 'Terminal will not batch'`,
    );

    await asUser(db, ADMIN_ID);
    await db.exec(
      `update support_tickets set priority = 'Urgent', status = 'pending'
        where id = ${own.id};`,
    );

    await asPlatform(db);
    const [row] = await rows<{ priority: string; status: string }>(
      db,
      `select priority, status from support_tickets where id = ${own.id}`,
    );
    expect(row).toEqual({ priority: "Urgent", status: "pending" });
  });

  it("touches nothing when a non-owning agent tries the same edit", async () => {
    await asPlatform(db);
    const [other] = await rows<{ id: number }>(
      db,
      `select id from support_tickets where subject = 'Reprint receipts'`,
    );

    await asUser(db, AGENT_ID);
    // Filtered, not refused: the update policy matches zero rows, so the
    // statement succeeds and changes nothing. This is why the form passes
    // count: "exact" and treats 0 as a failure.
    await db.exec(
      `update support_tickets set priority = 'Urgent' where id = ${other.id};`,
    );

    await asPlatform(db);
    const [row] = await rows<{ priority: string }>(
      db,
      `select priority from support_tickets where id = ${other.id}`,
    );
    expect(row.priority).toBe("Normal");
  });
});

describe("support tickets scoping test is load-bearing", () => {
  it("would catch a fail-open select policy", async () => {
    const broken = await createTestDb();
    await resetData(broken);
    await asPlatform(broken);
    await broken.exec(`
      drop policy "select own or admin" on support_tickets;
      create policy "select own or admin" on support_tickets for select using (true);
    `);

    await asUser(broken, AGENT_ID);
    const leaked = await rows<TicketRow>(broken, listQuery());

    expect(leaked).toHaveLength(4);
    expect(leaked.map((t) => t.agent_id)).toContain(OTHER_AGENT_ID);

    await broken.close();
  });
});
