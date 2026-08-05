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

/** Matches DOCUMENT_LIST_COLUMNS in lib/documents.ts. */
const LIST_COLUMNS =
  "id, agent_id, owner_type, owner_id, doc_type, file_key, file_name, mime_type, uploaded_at";

const listQuery = `
  select ${LIST_COLUMNS}
  from documents
  order by uploaded_at desc, id desc
`;

type DocRow = {
  id: number;
  agent_id: string;
  owner_type: string;
  owner_id: number;
  file_key: string;
  file_name: string | null;
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

describe("documents list scoping", () => {
  it("returns only the agent's own documents", async () => {
    await asUser(db, AGENT_ID);

    const result = await rows<DocRow>(db, listQuery);

    expect(result).toHaveLength(2);
    expect(result.every((d) => d.agent_id === AGENT_ID)).toBe(true);
    expect(result.map((d) => d.file_name)).not.toContain("other-dl.jpg");
  });

  it("returns every document to an admin", async () => {
    await asUser(db, ADMIN_ID);

    const result = await rows<DocRow>(db, listQuery);

    expect(result).toHaveLength(3);
    expect(new Set(result.map((d) => d.agent_id))).toEqual(
      new Set([AGENT_ID, OTHER_AGENT_ID]),
    );
  });

  it("returns nothing to an unauthenticated caller", async () => {
    await asUser(db, null);

    expect(await rows<DocRow>(db, listQuery)).toHaveLength(0);
  });

  it("hides all documents from a deactivated agent", async () => {
    await asPlatform(db);
    await db.exec(
      `update profiles set is_active = false where id = '${AGENT_ID}';`,
    );

    await asUser(db, AGENT_ID);

    expect(await rows<DocRow>(db, listQuery)).toHaveLength(0);
  });

  it("scopes the per-owner query used on detail pages", async () => {
    await asPlatform(db);
    const [otherMerchant] = await rows<{ id: number }>(
      db,
      `select id from merchants where dba = 'Other Active Co'`,
    );

    await asUser(db, AGENT_ID);
    // The exact shape the merchant detail page runs. Even asking directly for
    // another agent's merchant, RLS returns nothing.
    const result = await rows<DocRow>(
      db,
      `select ${LIST_COLUMNS} from documents
       where owner_type = 'merchant' and owner_id = ${otherMerchant.id}`,
    );

    expect(result).toHaveLength(0);
  });
});

describe("documents write scoping", () => {
  it("does not let an agent insert a document owned by someone else", async () => {
    await asUser(db, AGENT_ID);

    await expect(
      db.exec(`
        insert into documents (agent_id, owner_type, owner_id, doc_type, file_key)
        values ('${OTHER_AGENT_ID}', 'merchant', 1, 'Planted', 'key/planted');
      `),
    ).rejects.toThrow(/row-level security/i);
  });

  it("lets an agent insert a document in their own book", async () => {
    await asUser(db, AGENT_ID);

    await db.exec(`
      insert into documents (agent_id, owner_type, owner_id, doc_type, file_key, file_name)
      values ('${AGENT_ID}', 'merchant', 1, 'Signed application', 'k/1', 'app.pdf');
    `);

    expect(await rows<DocRow>(db, listQuery)).toHaveLength(3);
  });

  it("lets an agent delete their own document", async () => {
    await asUser(db, AGENT_ID);

    await db.exec(
      `delete from documents where file_name = 'agent-voided-check.pdf';`,
    );

    await asPlatform(db);
    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from documents where file_name = 'agent-voided-check.pdf'`,
    );
    // Unlike every other table, documents lets an agent delete their own rows —
    // the policy is `delete own or admin`, not admin-only. Uploading the wrong
    // file is a mistake reps need to fix themselves.
    expect(n).toBe(0);
  });

  it("does not let an agent delete another agent's document", async () => {
    await asUser(db, AGENT_ID);

    await db.exec(`delete from documents where file_name = 'other-dl.jpg';`);

    await asPlatform(db);
    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from documents where file_name = 'other-dl.jpg'`,
    );
    expect(n).toBe(1);
  });

  it("does not let a deactivated agent delete their own document", async () => {
    await asPlatform(db);
    await db.exec(
      `update profiles set is_active = false where id = '${AGENT_ID}';`,
    );

    await asUser(db, AGENT_ID);
    await db.exec(
      `delete from documents where file_name = 'agent-voided-check.pdf';`,
    );

    await asPlatform(db);
    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from documents where file_name = 'agent-voided-check.pdf'`,
    );
    // The delete policy carries the is_active_agent() gating too — this is the
    // policy that was ungated in the schema doc before it was corrected.
    expect(n).toBe(1);
  });

  it("has no update policy at all", async () => {
    await asPlatform(db);

    const result = await rows<{ cmd: string }>(
      db,
      `select cmd from pg_policies where schemaname = 'public' and tablename = 'documents'
       order by cmd`,
    );

    // SELECT, INSERT, DELETE — deliberately no UPDATE. A document row is
    // insert-then-delete: you replace a file rather than edit its metadata. Any
    // UI offering an "edit document" form would silently do nothing.
    expect(result.map((r) => r.cmd).sort()).toEqual([
      "DELETE",
      "INSERT",
      "SELECT",
    ]);
  });
});

describe("documents owner_type / owner_id integrity", () => {
  it("rejects an owner_type outside the check constraint", async () => {
    await asUser(db, AGENT_ID);

    await expect(
      db.exec(`
        insert into documents (agent_id, owner_type, owner_id, doc_type, file_key)
        values ('${AGENT_ID}', 'ghost_sheet', 1, 'Notes', 'k/2');
      `),
    ).rejects.toThrow(/check constraint/i);
  });

  it("does NOT stop a document pointing at another agent's record", async () => {
    await asPlatform(db);
    const [otherMerchant] = await rows<{ id: number }>(
      db,
      `select id from merchants where dba = 'Other Active Co'`,
    );

    await asUser(db, AGENT_ID);

    // This is the gap the create-upload-url Edge Function exists to close, and
    // it's asserted rather than assumed so nobody later concludes the database
    // is handling it. owner_id is polymorphic, so it can't have a foreign key —
    // the insert policy only checks documents.agent_id, and says nothing about
    // whether the *owner* record belongs to the same person.
    await db.exec(`
      insert into documents (agent_id, owner_type, owner_id, doc_type, file_key, file_name)
      values ('${AGENT_ID}', 'merchant', ${otherMerchant.id}, 'Snooping', 'k/3', 'x.pdf');
    `);

    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from documents where file_name = 'x.pdf'`,
    );
    expect(n).toBe(1);

    // Note what is and isn't leaked: the row exists, but it grants no access to
    // the other agent's merchant, and the file_key it points at is one this
    // agent would have had to be given a signed URL for. The Edge Function is
    // what prevents the row being created with a real uploaded file behind it.
  });

  it("does not stop a document pointing at a nonexistent record", async () => {
    await asUser(db, AGENT_ID);

    await db.exec(`
      insert into documents (agent_id, owner_type, owner_id, doc_type, file_key, file_name)
      values ('${AGENT_ID}', 'merchant', 999999, 'Dangling', 'k/4', 'dangling.pdf');
    `);

    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from documents where file_name = 'dangling.pdf'`,
    );
    expect(n).toBe(1);
  });
});

describe("documents scoping test is load-bearing", () => {
  it("would catch a fail-open select policy", async () => {
    const broken = await createTestDb();
    await resetData(broken);
    await asPlatform(broken);
    await broken.exec(`
      drop policy "select own or admin" on documents;
      create policy "select own or admin" on documents for select using (true);
    `);

    await asUser(broken, AGENT_ID);
    const leaked = await rows<DocRow>(broken, listQuery);

    expect(leaked).toHaveLength(3);
    expect(leaked.map((d) => d.agent_id)).toContain(OTHER_AGENT_ID);

    await broken.close();
  });
});
