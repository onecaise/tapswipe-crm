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

type CountRow = { n: number };
type IdRow = { id: number };

const convert = (sheetId: number) =>
  `select convert_ghost_sheet_to_lead(${sheetId}) as id`;

async function sheetIdByDba(db: TestDb, dba: string): Promise<number> {
  await asPlatform(db);
  const [row] = await rows<IdRow>(
    db,
    `select id from ghost_sheets where dba = '${dba}'`,
  );
  return row.id;
}

async function countLeads(db: TestDb): Promise<number> {
  await asPlatform(db);
  const [{ n }] = await rows<CountRow>(
    db,
    `select count(*)::int as n from leads`,
  );
  return n;
}

async function countNotes(db: TestDb): Promise<number> {
  await asPlatform(db);
  const [{ n }] = await rows<CountRow>(
    db,
    `select count(*)::int as n from notes`,
  );
  return n;
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

describe("convert_ghost_sheet_to_lead — happy path", () => {
  it("creates a lead in the agent's own book and links the sheet", async () => {
    const sheetId = await sheetIdByDba(db, "Agent Sheet Open");

    await asUser(db, AGENT_ID);
    const [{ id: newLeadId }] = await rows<IdRow>(db, convert(sheetId));

    await asPlatform(db);
    const [lead] = await rows<{
      agent_id: string;
      dba: string;
      contact_name: string;
      contact_phone: string;
      lead_source: string;
      status: string;
    }>(
      db,
      `select agent_id, dba, contact_name, contact_phone, lead_source, status
       from leads where id = ${newLeadId}`,
    );

    expect(lead.agent_id).toBe(AGENT_ID);
    expect(lead.dba).toBe("Agent Sheet Open");
    expect(lead.contact_name).toBe("Ann Agent");
    expect(lead.contact_phone).toBe("555-0101");
    expect(lead.lead_source).toBe("ghost_sheet");
    expect(lead.status).toBe("open");

    const [sheet] = await rows<{ lead_id: number; status: string }>(
      db,
      `select lead_id, status from ghost_sheets where id = ${sheetId}`,
    );
    expect(sheet.lead_id).toBe(newLeadId);
    expect(sheet.status).toBe("converted");
  });

  it("copies the sheet's notes onto the new lead", async () => {
    const sheetId = await sheetIdByDba(db, "Agent Sheet Open");

    await asUser(db, AGENT_ID);
    const [{ id: newLeadId }] = await rows<IdRow>(db, convert(sheetId));

    await asPlatform(db);
    const notes = await rows<{
      agent_id: string;
      owner_type: string;
      owner_id: number;
      body: string;
    }>(
      db,
      `select agent_id, owner_type, owner_id, body from notes
       where owner_type = 'lead' and owner_id = ${newLeadId}`,
    );

    // leads has no notes column, so the text lands in the polymorphic notes
    // table instead of being dropped.
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toBe("Met at the diner. Wants terminal pricing.");
    expect(notes[0].agent_id).toBe(AGENT_ID);
  });

  it("creates no note when the sheet has none", async () => {
    const sheetId = await sheetIdByDba(db, "Agent Sheet No Notes");
    const notesBefore = await countNotes(db);

    await asUser(db, AGENT_ID);
    await rows<IdRow>(db, convert(sheetId));

    // notes.body is `not null`, so an unguarded insert would fail the whole
    // conversion for any sheet without notes.
    expect(await countNotes(db)).toBe(notesBefore);
  });

  it("lets the agent see the lead it just created", async () => {
    const sheetId = await sheetIdByDba(db, "Agent Sheet Open");

    await asUser(db, AGENT_ID);
    const [{ id: newLeadId }] = await rows<IdRow>(db, convert(sheetId));

    // Still as the agent: the new row has to be visible through their own RLS,
    // otherwise the redirect to /leads/:id would land on a 404.
    const visible = await rows<IdRow>(
      db,
      `select id from leads where id = ${newLeadId}`,
    );
    expect(visible).toHaveLength(1);
  });
});

describe("convert_ghost_sheet_to_lead — refusals", () => {
  it("refuses a sheet that is already converted", async () => {
    const sheetId = await sheetIdByDba(db, "Agent Sheet Converted");
    const before = await countLeads(db);

    await asUser(db, AGENT_ID);
    await expect(rows<IdRow>(db, convert(sheetId))).rejects.toThrow(
      /already converted/i,
    );

    expect(await countLeads(db)).toBe(before);
  });

  it("refuses converting the same sheet twice", async () => {
    const sheetId = await sheetIdByDba(db, "Agent Sheet Open");

    await asUser(db, AGENT_ID);
    await rows<IdRow>(db, convert(sheetId));
    const afterFirst = await countLeads(db);

    await asUser(db, AGENT_ID);
    await expect(rows<IdRow>(db, convert(sheetId))).rejects.toThrow(
      /already converted/i,
    );

    // The point of the guard: a double-click can't mint a second lead.
    expect(await countLeads(db)).toBe(afterFirst);
  });

  it("refuses another agent's sheet, reporting it as not found", async () => {
    const sheetId = await sheetIdByDba(db, "Other Sheet Open");
    const before = await countLeads(db);

    await asUser(db, AGENT_ID);
    // "not found" rather than "forbidden": RLS makes a sheet owned by someone
    // else indistinguishable from one that doesn't exist, so the error can't be
    // used to probe which ids are real.
    await expect(rows<IdRow>(db, convert(sheetId))).rejects.toThrow(
      /not found/i,
    );

    expect(await countLeads(db)).toBe(before);
  });

  it("refuses a nonexistent sheet with the same message", async () => {
    await asUser(db, AGENT_ID);

    await expect(rows<IdRow>(db, convert(999999))).rejects.toThrow(/not found/i);
  });

  it("refuses a deactivated agent", async () => {
    const sheetId = await sheetIdByDba(db, "Agent Sheet Open");
    const before = await countLeads(db);

    await asPlatform(db);
    await db.exec(
      `update profiles set is_active = false where id = '${AGENT_ID}';`,
    );

    await asUser(db, AGENT_ID);
    // is_active_agent() gating hides the sheet, so the function can't find it.
    await expect(rows<IdRow>(db, convert(sheetId))).rejects.toThrow(
      /not found/i,
    );

    expect(await countLeads(db)).toBe(before);
  });

  it("refuses an unauthenticated caller", async () => {
    const sheetId = await sheetIdByDba(db, "Agent Sheet Open");

    await asUser(db, null);
    await expect(rows<IdRow>(db, convert(sheetId))).rejects.toThrow(
      /not found/i,
    );
  });
});

describe("convert_ghost_sheet_to_lead — atomicity", () => {
  it("writes nothing at all when the conversion fails", async () => {
    const sheetId = await sheetIdByDba(db, "Other Sheet Open");
    const leadsBefore = await countLeads(db);
    const notesBefore = await countNotes(db);

    await asUser(db, AGENT_ID);
    await expect(rows<IdRow>(db, convert(sheetId))).rejects.toThrow();

    // The whole reason this is a function rather than two client-side calls: a
    // failure leaves no partial state behind. Done from the client, an
    // insert-then-fail would strand a lead with no link back to its sheet.
    expect(await countLeads(db)).toBe(leadsBefore);
    expect(await countNotes(db)).toBe(notesBefore);

    const [sheet] = await rows<{ lead_id: number | null }>(
      db,
      `select lead_id from ghost_sheets where id = ${sheetId}`,
    );
    expect(sheet.lead_id).toBeNull();
  });
});

describe("convert_ghost_sheet_to_lead — admin acting for an agent", () => {
  it("creates the lead in the sheet's agent's book, not the admin's", async () => {
    const sheetId = await sheetIdByDba(db, "Other Sheet Open");

    await asUser(db, ADMIN_ID);
    const [{ id: newLeadId }] = await rows<IdRow>(db, convert(sheetId));

    await asPlatform(db);
    const [lead] = await rows<{ agent_id: string }>(
      db,
      `select agent_id from leads where id = ${newLeadId}`,
    );
    const [note] = await rows<{ agent_id: string }>(
      db,
      `select agent_id from notes where owner_type = 'lead' and owner_id = ${newLeadId}`,
    );

    // The function takes agent_id from the sheet, not auth.uid(). If it used
    // auth.uid() this would silently move the rep's lead into the admin's book —
    // easy to write, invisible in normal use.
    expect(lead.agent_id).toBe(OTHER_AGENT_ID);
    expect(lead.agent_id).not.toBe(ADMIN_ID);
    expect(note.agent_id).toBe(OTHER_AGENT_ID);
  });
});

describe("regression: what this migration changes", () => {
  const BEFORE_CONVERSION = [
    "20260804201300_initial_schema.sql",
    "20260805103000_add_is_active_agent_and_profile_self_service.sql",
    "20260805143000_add_indexes_and_updated_at_triggers.sql",
  ];

  it("the function does not exist before this migration", async () => {
    const old = await createTestDb(BEFORE_CONVERSION);
    await asPlatform(old);

    const [{ n }] = await rows<CountRow>(
      old,
      `select count(*)::int as n from pg_proc
       where proname = 'convert_ghost_sheet_to_lead'`,
    );
    expect(n).toBe(0);

    await old.close();
  });

  it("lead_id was NO ACTION before this migration, blocking lead deletion", async () => {
    const old = await createTestDb(BEFORE_CONVERSION);
    await resetData(old);
    await asUser(old, ADMIN_ID);

    // The behaviour the ON DELETE SET NULL change fixes, asserted so the fix is
    // demonstrably load-bearing rather than assumed.
    await expect(
      old.exec(`delete from leads where dba = 'Agent Lead C';`),
    ).rejects.toThrow(/foreign key constraint/i);

    await old.close();
  });

  it("declares the constraint as SET NULL after this migration", async () => {
    await asPlatform(db);

    // confdeltype 'n' = SET NULL, 'a' = NO ACTION, 'c' = CASCADE.
    // Checked directly against the catalog because the doc expresses this
    // inline in `create table` while the migration has to ALTER — the two can't
    // be compared as text, so the resulting delete action is what's verified.
    const [{ confdeltype }] = await rows<{ confdeltype: string }>(
      db,
      `select confdeltype from pg_constraint
       where conname = 'ghost_sheets_lead_id_fkey'`,
    );
    expect(confdeltype).toBe("n");
  });
});
