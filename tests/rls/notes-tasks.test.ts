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
 * notes and tasks are the two polymorphic Tier 1 tables: one agent_id check, and
 * an owner_type + owner_id pair with no foreign key behind it.
 *
 * So there are two independent things to prove, and passing one says nothing
 * about the other:
 *
 *   1. **Ownership** — the standard rule. An agent sees only `agent_id =
 *      auth.uid()` while active; an admin sees everything.
 *   2. **Owner addressing** — the panels query `owner_type = $1 and owner_id =
 *      $2`, and owner_id values collide across types by construction (lead 1 and
 *      merchant 1 both exist in the fixtures). A query that dropped owner_type
 *      would return a merchant's notes on a lead page, which is a data-mixing
 *      bug RLS cannot catch: both rows are legitimately the caller's.
 *
 * The fixtures put two notes and two open tasks on lead 1, plus a note and a
 * task on merchant 1, precisely so (2) can fail loudly.
 */
const NOTE_COLUMNS = "id, agent_id, owner_type, owner_id, body, created_at";
const TASK_COLUMNS =
  "id, agent_id, owner_type, owner_id, title, due_date, completed";

const notesFor = (ownerType: string, ownerId: number) => `
  select ${NOTE_COLUMNS}
  from notes
  where owner_type = '${ownerType}' and owner_id = ${ownerId}
  order by created_at desc, id desc
`;

const tasksFor = (ownerType: string, ownerId: number) => `
  select ${TASK_COLUMNS}
  from tasks
  where owner_type = '${ownerType}' and owner_id = ${ownerId}
  order by completed asc, due_date asc nulls last, id desc
`;

type NoteRow = {
  id: number;
  agent_id: string;
  owner_type: string;
  owner_id: number;
  body: string;
};

type TaskRow = {
  id: number;
  agent_id: string;
  owner_type: string;
  owner_id: number;
  title: string;
  due_date: string | null;
  completed: boolean;
};

type CountRow = { n: number };

let db: TestDb;

/** Fixture ids are stable because resetData() restarts the sequences. */
async function idOf(table: string, column: string, value: string) {
  await asPlatform(db);
  const [row] = await rows<{ id: number }>(
    db,
    `select id from ${table} where ${column} = '${value}'`,
  );
  return row.id;
}

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(async () => {
  await resetData(db);
});

afterAll(async () => {
  await db?.close();
});

describe("notes scoping", () => {
  it("gives the agent their own notes on their own lead", async () => {
    const leadId = await idOf("leads", "dba", "Agent Lead A");

    await asUser(db, AGENT_ID);
    const result = await rows<NoteRow>(db, notesFor("lead", leadId));

    expect(result).toHaveLength(2);
    expect(result.every((n) => n.agent_id === AGENT_ID)).toBe(true);
  });

  it("gives an agent nothing on another agent's lead", async () => {
    const otherLeadId = await idOf("leads", "dba", "Other Agent Lead");

    await asUser(db, AGENT_ID);

    // Two independent reasons this is empty, and that is the point: the note's
    // own agent_id is the other agent's, so the notes policy filters it — the
    // caller never even reaches the question of whether they can see the lead.
    expect(await rows<NoteRow>(db, notesFor("lead", otherLeadId))).toHaveLength(
      0,
    );
  });

  it("gives an admin every note on a lead regardless of author", async () => {
    const otherLeadId = await idOf("leads", "dba", "Other Agent Lead");

    await asUser(db, ADMIN_ID);
    const result = await rows<NoteRow>(db, notesFor("lead", otherLeadId));

    expect(result).toHaveLength(1);
    expect(result[0].agent_id).toBe(OTHER_AGENT_ID);
  });

  it("returns nothing to an unauthenticated caller", async () => {
    const leadId = await idOf("leads", "dba", "Agent Lead A");

    await asUser(db, null);

    expect(await rows<NoteRow>(db, notesFor("lead", leadId))).toHaveLength(0);
  });

  it("hides notes from a deactivated agent", async () => {
    const leadId = await idOf("leads", "dba", "Agent Lead A");

    await asPlatform(db);
    await db.exec(
      `update profiles set is_active = false where id = '${AGENT_ID}';`,
    );

    await asUser(db, AGENT_ID);

    expect(await rows<NoteRow>(db, notesFor("lead", leadId))).toHaveLength(0);
  });
});

describe("notes owner addressing", () => {
  it("does not mix a merchant's notes into a lead with the same id", async () => {
    const leadId = await idOf("leads", "dba", "Agent Lead A");
    const merchantId = await idOf("merchants", "dba", "Agent Active Co");

    // The collision the composite index comment describes: both are id 1, and
    // both belong to the same agent, so RLS cannot tell these apart. Only
    // owner_type can.
    expect(leadId).toBe(merchantId);

    await asUser(db, AGENT_ID);
    const leadNotes = await rows<NoteRow>(db, notesFor("lead", leadId));
    const merchantNotes = await rows<NoteRow>(
      db,
      notesFor("merchant", merchantId),
    );

    expect(leadNotes.map((n) => n.body).sort()).toEqual([
      "Called back, wants pricing by Friday.",
      "Left voicemail Tuesday.",
    ]);
    expect(merchantNotes.map((n) => n.body)).toEqual(["Owner prefers texts."]);
  });

  it("addresses a pre-app's notes separately again", async () => {
    const preAppId = await idOf("pre_apps", "dba_name", "Agent Draft App");

    await asUser(db, AGENT_ID);
    const result = await rows<NoteRow>(db, notesFor("pre_app", preAppId));

    expect(result.map((n) => n.body)).toEqual(["Waiting on the voided check."]);
  });

  it("rejects an owner_type outside the four the check constraint allows", async () => {
    await asUser(db, AGENT_ID);

    await expect(
      db.exec(
        `insert into notes (agent_id, owner_type, owner_id, body)
         values ('${AGENT_ID}', 'support_ticket', 1, 'Wrong owner type.');`,
      ),
    ).rejects.toThrow(/notes_owner_type_check|violates check/i);
  });
});

describe("notes writes", () => {
  it("lets an agent add a note under their own agent_id", async () => {
    const leadId = await idOf("leads", "dba", "Agent Lead A");

    await asUser(db, AGENT_ID);
    await db.exec(
      `insert into notes (agent_id, owner_type, owner_id, body)
       values ('${AGENT_ID}', 'lead', ${leadId}, 'Fresh note.');`,
    );

    expect(await rows<NoteRow>(db, notesFor("lead", leadId))).toHaveLength(3);
  });

  it("does not let an agent write a note as someone else", async () => {
    const leadId = await idOf("leads", "dba", "Agent Lead A");

    await asUser(db, AGENT_ID);
    await expect(
      db.exec(
        `insert into notes (agent_id, owner_type, owner_id, body)
         values ('${OTHER_AGENT_ID}', 'lead', ${leadId}, 'Planted note.');`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("cannot rewrite a note — notes are append-only", async () => {
    const leadId = await idOf("leads", "dba", "Agent Lead A");

    await asUser(db, AGENT_ID);
    // No update policy exists, for anyone. Note this is FILTERED, not refused:
    // zero rows match, so the statement succeeds and changes nothing. That is
    // exactly why the UI must not offer an edit affordance — the rep would get
    // a successful save that did nothing.
    await db.exec(
      `update notes set body = 'Rewritten.' where owner_id = ${leadId};`,
    );

    await asPlatform(db);
    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from notes where body = 'Rewritten.'`,
    );
    expect(n).toBe(0);
  });

  it("does not let even an admin rewrite a note", async () => {
    await asUser(db, ADMIN_ID);
    await db.exec(`update notes set body = 'Admin rewrite.';`);

    await asPlatform(db);
    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from notes where body = 'Admin rewrite.'`,
    );
    // is_admin() appears in no update policy here because there is no update
    // policy at all. Append-only means append-only.
    expect(n).toBe(0);
  });

  it("does not let an agent delete their own note, but lets an admin", async () => {
    await asUser(db, AGENT_ID);
    await db.exec(`delete from notes where body = 'Left voicemail Tuesday.';`);

    await asPlatform(db);
    let [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from notes where body = 'Left voicemail Tuesday.'`,
    );
    expect(n).toBe(1);

    await asUser(db, ADMIN_ID);
    await db.exec(`delete from notes where body = 'Left voicemail Tuesday.';`);

    await asPlatform(db);
    [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from notes where body = 'Left voicemail Tuesday.'`,
    );
    // The delete policy added in 20260810171500. Before it, an admin could not
    // remove a note either — and since notes cannot be updated, a wrong one was
    // permanent.
    expect(n).toBe(0);
  });
});

describe("tasks scoping", () => {
  it("gives the agent their own tasks on their own lead", async () => {
    const leadId = await idOf("leads", "dba", "Agent Lead A");

    await asUser(db, AGENT_ID);
    const result = await rows<TaskRow>(db, tasksFor("lead", leadId));

    expect(result.map((t) => t.title)).toEqual([
      "Send pricing sheet",
      "Confirm terminal count",
    ]);
    expect(result.every((t) => t.agent_id === AGENT_ID)).toBe(true);
  });

  it("orders open tasks before completed ones, soonest due first", async () => {
    const merchantId = await idOf("merchants", "dba", "Agent Active Co");

    await asUser(db, AGENT_ID);
    const result = await rows<TaskRow>(db, tasksFor("merchant", merchantId));

    // 'Order paper rolls' is undated and open; 'Emailed statement' is completed
    // with a due date five days back. Open-before-done has to win over the date,
    // or the panel buries a live task under finished ones.
    expect(result.map((t) => t.title)).toEqual([
      "Order paper rolls",
      "Emailed statement",
    ]);
    expect(result[0].completed).toBe(false);
    expect(result[1].completed).toBe(true);
  });

  it("gives an agent nothing on another agent's lead", async () => {
    const otherLeadId = await idOf("leads", "dba", "Other Agent Lead");

    await asUser(db, AGENT_ID);

    expect(await rows<TaskRow>(db, tasksFor("lead", otherLeadId))).toHaveLength(
      0,
    );
  });

  it("gives an admin every task on a lead", async () => {
    const otherLeadId = await idOf("leads", "dba", "Other Agent Lead");

    await asUser(db, ADMIN_ID);
    const result = await rows<TaskRow>(db, tasksFor("lead", otherLeadId));

    expect(result.map((t) => t.title)).toEqual(["Other agent task"]);
    expect(result[0].agent_id).toBe(OTHER_AGENT_ID);
  });

  it("hides tasks from a deactivated agent", async () => {
    const leadId = await idOf("leads", "dba", "Agent Lead A");

    await asPlatform(db);
    await db.exec(
      `update profiles set is_active = false where id = '${AGENT_ID}';`,
    );

    await asUser(db, AGENT_ID);

    expect(await rows<TaskRow>(db, tasksFor("lead", leadId))).toHaveLength(0);
  });

  it("does not mix a merchant's tasks into a lead with the same id", async () => {
    const leadId = await idOf("leads", "dba", "Agent Lead A");

    await asUser(db, AGENT_ID);
    const leadTasks = await rows<TaskRow>(db, tasksFor("lead", leadId));

    expect(leadTasks.map((t) => t.title)).not.toContain("Order paper rolls");
  });
});

describe("tasks writes", () => {
  it("lets an agent complete and reopen their own task", async () => {
    const leadId = await idOf("leads", "dba", "Agent Lead A");

    await asUser(db, AGENT_ID);
    await db.exec(
      `update tasks set completed = true where title = 'Send pricing sheet';`,
    );

    let result = await rows<TaskRow>(db, tasksFor("lead", leadId));
    expect(result.find((t) => t.title === "Send pricing sheet")?.completed).toBe(
      true,
    );

    // Both directions: the checkbox is the whole reason tasks have an update
    // policy where notes deliberately do not.
    await db.exec(
      `update tasks set completed = false where title = 'Send pricing sheet';`,
    );
    result = await rows<TaskRow>(db, tasksFor("lead", leadId));
    expect(result.find((t) => t.title === "Send pricing sheet")?.completed).toBe(
      false,
    );
  });

  it("does not let an agent complete another agent's task", async () => {
    await asUser(db, AGENT_ID);
    await db.exec(
      `update tasks set completed = true where title = 'Other agent task';`,
    );

    await asPlatform(db);
    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from tasks
        where title = 'Other agent task' and completed = false`,
    );
    expect(n).toBe(1);
  });

  it("does not let an agent insert a task owned by someone else", async () => {
    const leadId = await idOf("leads", "dba", "Agent Lead A");

    await asUser(db, AGENT_ID);
    await expect(
      db.exec(
        `insert into tasks (agent_id, owner_type, owner_id, title)
         values ('${OTHER_AGENT_ID}', 'lead', ${leadId}, 'Planted task.');`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("does not let an agent delete their own task, but lets an admin", async () => {
    await asUser(db, AGENT_ID);
    await db.exec(`delete from tasks where title = 'Order paper rolls';`);

    await asPlatform(db);
    let [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from tasks where title = 'Order paper rolls'`,
    );
    expect(n).toBe(1);

    await asUser(db, ADMIN_ID);
    await db.exec(`delete from tasks where title = 'Order paper rolls';`);

    await asPlatform(db);
    [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from tasks where title = 'Order paper rolls'`,
    );
    expect(n).toBe(0);
  });
});

describe("notes and tasks survive their owner", () => {
  it("leaves a lead's notes and tasks behind when the lead is deleted", async () => {
    const leadId = await idOf("leads", "dba", "Agent Lead A");

    await asUser(db, ADMIN_ID);
    await db.exec(`delete from leads where id = ${leadId};`);

    await asPlatform(db);
    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from notes
        where owner_type = 'lead' and owner_id = ${leadId}`,
    );

    // Asserted because it is the documented consequence of a polymorphic
    // owner_id, not because it is desirable: there is no FK to cascade from, so
    // these rows are orphans. They are invisible to every page — nothing asks
    // for that owner_id again — and a future lead cannot inherit them, because
    // serial ids are never reused. If this ever needs cleaning up it is a
    // deliberate job, not a cascade.
    expect(n).toBe(2);
  });
});

describe("notes and tasks scoping tests are load-bearing", () => {
  it("would catch a fail-open select policy on either table", async () => {
    const broken = await createTestDb();
    await resetData(broken);
    await asPlatform(broken);
    await broken.exec(`
      drop policy "select own or admin" on notes;
      create policy "select own or admin" on notes for select using (true);
      drop policy "select own or admin" on tasks;
      create policy "select own or admin" on tasks for select using (true);
    `);

    const [{ id: otherLeadId }] = await rows<{ id: number }>(
      broken,
      `select id from leads where dba = 'Other Agent Lead'`,
    );

    await asUser(broken, AGENT_ID);
    const leakedNotes = await rows<NoteRow>(
      broken,
      notesFor("lead", otherLeadId),
    );
    const leakedTasks = await rows<TaskRow>(
      broken,
      tasksFor("lead", otherLeadId),
    );

    expect(leakedNotes.map((n) => n.agent_id)).toContain(OTHER_AGENT_ID);
    expect(leakedTasks.map((t) => t.agent_id)).toContain(OTHER_AGENT_ID);

    await broken.close();
  });
});
