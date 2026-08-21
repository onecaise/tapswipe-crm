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

/**
 * Closing a ticket, and the finality of it.
 *
 * Two separate rules, and they are enforced at two different layers on purpose:
 *
 *  - WHO may close is RLS. "update own or admin" already carried it, so these
 *    assertions pin the decision rather than a new mechanism — an owner and an
 *    admin can, a non-owning agent and a deactivated one cannot.
 *  - THAT IT IS FINAL is the support_tickets_guard_close() trigger from
 *    20260821113000, because neither RLS nor a CHECK can compare OLD to NEW.
 *
 * The distinction shows up in the failure MODE, which is why these assert on it
 * rather than only on the resulting row. A blocked close is RLS, so it is
 * *filtered*: the statement succeeds and changes nothing, which is why the form
 * passes count: "exact". A blocked reopen is the trigger, so it *raises*.
 */
describe("closing a support ticket", () => {
  const statusOf = async (subject: string): Promise<string> => {
    await asPlatform(db);
    const [row] = await rows<{ status: string }>(
      db,
      `select status from support_tickets where subject = '${subject}'`,
    );
    return row.status;
  };

  it("lets the owning agent close their own ticket", async () => {
    await asUser(db, AGENT_ID);
    await db.exec(
      `update support_tickets set status = 'closed'
        where subject = 'Terminal will not batch';`,
    );

    expect(await statusOf("Terminal will not batch")).toBe("closed");
  });

  it("lets an admin close a ticket they do not own", async () => {
    await asUser(db, ADMIN_ID);
    await db.exec(
      `update support_tickets set status = 'closed'
        where subject = 'Reprint receipts';`,
    );

    expect(await statusOf("Reprint receipts")).toBe("closed");
  });

  it("does not let a non-owning agent close someone else's ticket", async () => {
    await asUser(db, AGENT_ID);
    // 'Reprint receipts' belongs to OTHER_AGENT_ID. Filtered by the USING
    // clause, so this raises nothing and touches nothing.
    await db.exec(
      `update support_tickets set status = 'closed'
        where subject = 'Reprint receipts';`,
    );

    expect(await statusOf("Reprint receipts")).toBe("open");
  });

  it("does not let a deactivated agent close their own ticket", async () => {
    await asPlatform(db);
    await db.exec(
      `update profiles set is_active = false where id = '${AGENT_ID}';`,
    );

    await asUser(db, AGENT_ID);
    // The is_active_agent() half of the policy. A deactivated rep keeps a
    // working token until it expires, so the check has to be per request.
    await db.exec(
      `update support_tickets set status = 'closed'
        where subject = 'Terminal will not batch';`,
    );

    expect(await statusOf("Terminal will not batch")).toBe("open");
  });

  it("refuses to reopen a closed ticket, for its owner", async () => {
    await asUser(db, AGENT_ID);

    // 'Old chargeback question' is seeded closed and owned by this agent, so
    // RLS permits the write and the trigger is the only thing standing here.
    // That ordering is the point: a rejection that came from RLS instead would
    // pass this assertion for the wrong reason, which is what the admin case
    // below rules out.
    await expect(
      db.exec(
        `update support_tickets set status = 'open'
          where subject = 'Old chargeback question';`,
      ),
    ).rejects.toThrow(/closed ticket cannot be reopened/i);

    expect(await statusOf("Old chargeback question")).toBe("closed");
  });

  it("refuses to reopen a closed ticket, for an admin too", async () => {
    await asUser(db, ADMIN_ID);

    await expect(
      db.exec(
        `update support_tickets set status = 'pending'
          where subject = 'Old chargeback question';`,
      ),
    ).rejects.toThrow(/closed ticket cannot be reopened/i);

    expect(await statusOf("Old chargeback question")).toBe("closed");
  });

  it("refuses a reopen even for the platform owner, so no write path exists", async () => {
    // Postgres bypasses RLS for a table's owner, and a service-role Edge
    // Function would too. The trigger is not a policy, so it still fires —
    // this is what makes "final" a property of the table rather than of the
    // client that happens to be asking.
    await asPlatform(db);

    await expect(
      db.exec(
        `update support_tickets set status = 'open'
          where subject = 'Old chargeback question';`,
      ),
    ).rejects.toThrow(/closed ticket cannot be reopened/i);
  });

  it("still allows other fields to be edited on a closed ticket", async () => {
    await asUser(db, AGENT_ID);

    // The form PATCHes every field it renders, so a priority change on a closed
    // ticket re-sends status = 'closed'. If the guard had been written as
    // `new.status is distinct from old.status` this would raise, and closed
    // tickets would be wholly immutable — a decision nobody took.
    await db.exec(
      `update support_tickets set priority = 'Low', status = 'closed'
        where subject = 'Old chargeback question';`,
    );

    await asPlatform(db);
    const [row] = await rows<{ priority: string; status: string }>(
      db,
      `select priority, status from support_tickets
        where subject = 'Old chargeback question'`,
    );
    expect(row).toEqual({ priority: "Low", status: "closed" });
  });

  it("leaves open <-> pending free in both directions", async () => {
    await asUser(db, AGENT_ID);

    // Ordinary traffic, not a transition worth guarding: a ticket moves between
    // "working it" and "waiting on someone" repeatedly in its life.
    await db.exec(
      `update support_tickets set status = 'pending'
        where subject = 'Terminal will not batch';`,
    );
    expect(await statusOf("Terminal will not batch")).toBe("pending");

    await asUser(db, AGENT_ID);
    await db.exec(
      `update support_tickets set status = 'open'
        where subject = 'Terminal will not batch';`,
    );
    expect(await statusOf("Terminal will not batch")).toBe("open");
  });
});

/**
 * What closing actually does to the list — the reason the feature exists.
 *
 * The list page reads SUPPORT_TICKET_LIST_COLUMNS with
 * DEFAULT_SUPPORT_TICKET_FILTER = "open", so these run the real query rather
 * than asserting on a status column in isolation. Closing has to remove the row
 * from the default view and leave it reachable under the "closed" tab; a change
 * that broke either half would leave the status correct and the page wrong.
 */
describe("closing a ticket changes what the list shows", () => {
  it("drops the ticket out of the default open queue and into closed", async () => {
    await asUser(db, AGENT_ID);

    expect((await rows<TicketRow>(db, listQuery("open"))).map((t) => t.subject))
      .toEqual(["Terminal will not batch"]);

    await db.exec(
      `update support_tickets set status = 'closed'
        where subject = 'Terminal will not batch';`,
    );

    await asUser(db, AGENT_ID);
    expect(await rows<TicketRow>(db, listQuery("open"))).toHaveLength(0);

    // Not gone, just no longer in the queue — the "closed" tab is where a rep
    // goes looking for it, and "all" still holds every one of theirs.
    expect(
      (await rows<TicketRow>(db, listQuery("closed"))).map((t) => t.subject).sort(),
    ).toEqual(["Old chargeback question", "Terminal will not batch"]);
    expect(await rows<TicketRow>(db, listQuery())).toHaveLength(3);
  });

  it("removes it from the admin's open queue without touching the other rep's", async () => {
    await asUser(db, ADMIN_ID);
    await db.exec(
      `update support_tickets set status = 'closed'
        where subject = 'Terminal will not batch';`,
    );

    await asUser(db, ADMIN_ID);
    // The other agent's open ticket surviving is what proves the close was
    // scoped to one row rather than to a status.
    expect((await rows<TicketRow>(db, listQuery("open"))).map((t) => t.subject))
      .toEqual(["Reprint receipts"]);

    // And the owning rep sees their own queue empty, from their own side.
    await asUser(db, AGENT_ID);
    expect(await rows<TicketRow>(db, listQuery("open"))).toHaveLength(0);
  });

  it("keeps a closed ticket out of the dashboard's open count", async () => {
    // dashboard_counts() counts support_tickets where status = 'open'
    // (20260810180000:54) and is security invoker, so it is scoped to the
    // caller's own book. That number feeds the sidebar's count pill and the
    // dashboard card, so a close has to move it too. bigint comes back as a
    // string from PGlite, hence Number().
    const openCount = async (userId: string): Promise<number> => {
      await asUser(db, userId);
      const [row] = await rows<{ open_tickets: string }>(
        db,
        `select open_tickets from dashboard_counts()`,
      );
      return Number(row.open_tickets);
    };

    // The agent's own single open ticket, and the company's two.
    expect(await openCount(AGENT_ID)).toBe(1);
    expect(await openCount(ADMIN_ID)).toBe(2);

    await asUser(db, AGENT_ID);
    await db.exec(
      `update support_tickets set status = 'closed'
        where subject = 'Terminal will not batch';`,
    );

    expect(await openCount(AGENT_ID)).toBe(0);
    // The other rep's open ticket is still counted for the admin, so the close
    // moved exactly one row out of the figure.
    expect(await openCount(ADMIN_ID)).toBe(1);
  });
});

describe("support tickets close tests are load-bearing", () => {
  it("would catch the close guard being dropped", async () => {
    // Without this, every reopen-refused assertion above could be passing for
    // some incidental reason and nothing would say so. Dropping the trigger has
    // to make the reopen succeed — that is what proves the trigger, and not the
    // policies or the check constraint, is what enforces finality.
    const broken = await createTestDb();
    await resetData(broken);
    await asPlatform(broken);
    await broken.exec(
      `drop trigger support_tickets_guard_close on support_tickets;`,
    );

    await asUser(broken, AGENT_ID);
    await broken.exec(
      `update support_tickets set status = 'open'
        where subject = 'Old chargeback question';`,
    );

    await asPlatform(broken);
    const [row] = await rows<{ status: string }>(
      broken,
      `select status from support_tickets where subject = 'Old chargeback question'`,
    );
    // Reopened, and RLS never objected — the owning rep's UPDATE policy covers
    // this write. So the trigger is the only thing standing between a closed
    // ticket and an open one.
    expect(row.status).toBe("open");

    await broken.close();
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
