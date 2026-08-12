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
 * support_ticket_replies is a child table: it carries no agent_id, and reaches
 * its access check through `exists (select 1 from support_tickets ...)` on the
 * parent, with is_active_agent() wrapping the exists() rather than sitting
 * inside it. Same shape as the pre-app children, and it has the same ways to be
 * subtly wrong.
 *
 * The property that decides the whole design is here: **both sides of a
 * conversation can read it.** That is why this is not a use of `notes`, whose
 * select policy is own-or-admin — an admin's reply on a rep's ticket would have
 * been invisible to the rep. The "sees the admin's reply" assertion below is the
 * one that would fail if anyone ever re-points this at notes.
 *
 * Two other things it must hold:
 *   1. Ownership through the parent — another agent sees nothing, a deactivated
 *      one sees nothing, an admin sees everything.
 *   2. Authorship — the insert policy pins author_id to auth.uid(), so a rep
 *      cannot post a reply under the admin's name on their own ticket.
 */
const REPLY_COLUMNS = "id, ticket_id, author_id, body, created_at";

const repliesFor = (ticketId: number) => `
  select ${REPLY_COLUMNS}
  from support_ticket_replies
  where ticket_id = ${ticketId}
  order by created_at asc, id asc
`;

type ReplyRow = {
  id: number;
  ticket_id: number;
  author_id: string;
  body: string;
};

type CountRow = { n: number };

let db: TestDb;

/**
 * Parent ids, resolved as the platform owner up front.
 *
 * Not inlined as `(select id from support_tickets where subject = '…')`, and
 * that matters more than it looks: such a subquery, evaluated in a query running
 * AS an agent, is itself scoped by RLS. The other agent's ticket is invisible,
 * so it yields NULL, `where ticket_id = NULL` matches nothing, and the assertion
 * then passes because it looked at no rows at all rather than because the policy
 * held.
 */
let agentTicketId: number;
let otherTicketId: number;

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(async () => {
  await resetData(db);
  await asPlatform(db);
  [{ id: agentTicketId }] = await rows<{ id: number }>(
    db,
    `select id from support_tickets where subject = 'Terminal will not batch'`,
  );
  [{ id: otherTicketId }] = await rows<{ id: number }>(
    db,
    `select id from support_tickets where subject = 'Reprint receipts'`,
  );

  // Seeded here rather than in the shared seed(): the regression suites build a
  // database from a prefix of the migrations and then call seed(), so a table
  // introduced in 20260812154523 cannot be named there without failing them
  // with "relation does not exist".
  //
  // A thread with the ADMIN in the middle, which is the case this whole table
  // exists for, plus a reply on the other agent's ticket so the cross-agent
  // negatives are not vacuous.
  await db.exec(`
    insert into support_ticket_replies (ticket_id, author_id, body)
    values
      (${agentTicketId}, '${AGENT_ID}', 'Merchant says it started after the 4.2 update.'),
      (${agentTicketId}, '${ADMIN_ID}', 'Swap unit dispatched, tracking to follow.'),
      (${agentTicketId}, '${AGENT_ID}', 'Thanks — merchant confirmed they received it.'),
      (${otherTicketId}, '${OTHER_AGENT_ID}', 'Other agent reply.');
    -- These run as the platform owner, which has no auth.uid(), so the reply
    -- trigger stamps a cross_agent_insert for each. Cleared for the same reason
    -- seed() clears it: a fixture should not leave audit rows behind.
    delete from audit_log;
  `);
});

afterAll(async () => {
  await db?.close();
});

describe("reply visibility reaches through the parent ticket", () => {
  it("gives the ticket's owner the whole thread, including the admin's reply", async () => {
    await asUser(db, AGENT_ID);
    const thread = await rows<ReplyRow>(db, repliesFor(agentTicketId));

    // The reason this table exists. Under notes' own-or-admin policy the middle
    // row would be missing, and the rep would be reading half a conversation.
    expect(thread.map((r) => r.body)).toEqual([
      "Merchant says it started after the 4.2 update.",
      "Swap unit dispatched, tracking to follow.",
      "Thanks — merchant confirmed they received it.",
    ]);
    expect(thread.map((r) => r.author_id)).toContain(ADMIN_ID);
  });

  it("shows another agent none of them", async () => {
    await asUser(db, OTHER_AGENT_ID);

    expect(await rows<ReplyRow>(db, repliesFor(agentTicketId))).toHaveLength(0);
  });

  it("shows a deactivated owner none of them", async () => {
    await asPlatform(db);
    await db.exec(
      `update profiles set is_active = false where id = '${AGENT_ID}';`,
    );

    await asUser(db, AGENT_ID);

    // This is what pins is_active_agent() being OUTSIDE the exists(). Inside it,
    // the subquery would still find the ticket and the thread would leak to a
    // disabled account holding a valid token.
    expect(await rows<ReplyRow>(db, repliesFor(agentTicketId))).toHaveLength(0);
  });

  it("gives an admin the threads on every agent's tickets", async () => {
    await asUser(db, ADMIN_ID);

    expect(
      (await rows<ReplyRow>(db, repliesFor(agentTicketId))).length,
    ).toBeGreaterThan(0);
    expect(await rows<ReplyRow>(db, repliesFor(otherTicketId))).toHaveLength(1);
  });
});

describe("posting a reply", () => {
  it("lets the ticket's owner reply to their own ticket", async () => {
    await asUser(db, AGENT_ID);
    await db.exec(
      `insert into support_ticket_replies (ticket_id, author_id, body)
       values (${agentTicketId}, '${AGENT_ID}', 'Following up.');`,
    );

    expect(await rows<ReplyRow>(db, repliesFor(agentTicketId))).toHaveLength(4);
  });

  it("lets an admin reply to a ticket they do not own", async () => {
    await asUser(db, ADMIN_ID);
    await db.exec(
      `insert into support_ticket_replies (ticket_id, author_id, body)
       values (${agentTicketId}, '${ADMIN_ID}', 'Escalated to the processor.');`,
    );

    // And the owning agent can read it — responding is only useful if it
    // arrives.
    await asUser(db, AGENT_ID);
    const thread = await rows<ReplyRow>(db, repliesFor(agentTicketId));
    expect(thread.map((r) => r.body)).toContain("Escalated to the processor.");
  });

  it("refuses a reply on another agent's ticket", async () => {
    await asUser(db, AGENT_ID);

    await expect(
      db.exec(
        `insert into support_ticket_replies (ticket_id, author_id, body)
         values (${otherTicketId}, '${AGENT_ID}', 'Reaching into another book.');`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("refuses a reply posted under someone else's name", async () => {
    await asUser(db, AGENT_ID);

    // The author_id = auth.uid() conjunct. Without it a rep could put words in
    // the admin's mouth on their own ticket, which the parent check alone would
    // happily allow.
    await expect(
      db.exec(
        `insert into support_ticket_replies (ticket_id, author_id, body)
         values (${agentTicketId}, '${ADMIN_ID}', 'Approved, refund issued.');`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("refuses a reply from a deactivated agent", async () => {
    await asPlatform(db);
    await db.exec(
      `update profiles set is_active = false where id = '${AGENT_ID}';`,
    );

    await asUser(db, AGENT_ID);
    await expect(
      db.exec(
        `insert into support_ticket_replies (ticket_id, author_id, body)
         values (${agentTicketId}, '${AGENT_ID}', 'Still here.');`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe("replies are append-only", () => {
  it("does not let the author rewrite their own reply", async () => {
    await asUser(db, AGENT_ID);

    // No update policy AND no update grant, so this is refused rather than
    // filtered — the same end state notes reached in 20260812143407.
    await expect(
      db.exec(
        `update support_ticket_replies set body = 'Rewritten.'
          where ticket_id = ${agentTicketId};`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("does not let even an admin rewrite one", async () => {
    await asUser(db, ADMIN_ID);

    await expect(
      db.exec(`update support_ticket_replies set body = 'Admin rewrite.';`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("lets an admin delete a reply but not the agent who wrote it", async () => {
    await asUser(db, AGENT_ID);
    // DELETE under RLS is FILTERED, not refused, so this succeeds and changes
    // nothing — hence counting survivors rather than expecting a throw.
    await db.exec(
      `delete from support_ticket_replies where ticket_id = ${agentTicketId};`,
    );

    await asPlatform(db);
    let [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from support_ticket_replies
        where ticket_id = ${agentTicketId}`,
    );
    expect(n).toBe(3);

    await asUser(db, ADMIN_ID);
    await db.exec(
      `delete from support_ticket_replies where ticket_id = ${agentTicketId};`,
    );

    await asPlatform(db);
    [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from support_ticket_replies
        where ticket_id = ${agentTicketId}`,
    );
    expect(n).toBe(0);
  });
});

describe("replies follow their ticket", () => {
  it("goes away when the ticket is deleted", async () => {
    await asUser(db, ADMIN_ID);
    await db.exec(`delete from support_tickets where id = ${agentTicketId};`);

    await asPlatform(db);
    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from support_ticket_replies
        where ticket_id = ${agentTicketId}`,
    );

    // `on delete cascade`, unlike notes and tasks, whose polymorphic owner_id
    // has no FK to cascade from and which are therefore left orphaned. A reply
    // has a real parent, so it can be cleaned up properly — and without the
    // cascade the parent's admin-only DELETE would fail on the FK instead.
    expect(n).toBe(0);
  });
});

describe("the reply scoping tests are load-bearing", () => {
  it("would catch a policy that stopped checking the parent's owner", async () => {
    // Break the policy on purpose and prove the negative assertion notices.
    // Without this, a test that passes because it queried nothing looks
    // identical to one that passes because the policy works.
    await asPlatform(db);
    await db.exec(`
      drop policy "select via parent ticket" on support_ticket_replies;
      create policy "select via parent ticket" on support_ticket_replies
        for select using (true);
    `);

    await asUser(db, OTHER_AGENT_ID);
    const leaked = await rows<ReplyRow>(db, repliesFor(agentTicketId));

    expect(leaked.length).toBeGreaterThan(0);
  });
});
