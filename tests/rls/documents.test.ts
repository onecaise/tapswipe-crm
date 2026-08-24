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

    // The file_key has to be the real thing now — see
    // documents_file_key_matches_owner below. It used to read 'k/1', which is
    // what a forged row looks like.
    await db.exec(`
      insert into documents (agent_id, owner_type, owner_id, doc_type, file_key, file_name)
      values ('${AGENT_ID}', 'merchant', 1, 'Signed application',
        '${AGENT_ID}/merchant/1/44444444-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'app.pdf');
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

  it("stops a document pointing at another agent's record", async () => {
    await asPlatform(db);
    const [otherMerchant] = await rows<{ id: number }>(
      db,
      `select id from merchants where dba = 'Other Active Co'`,
    );

    await asUser(db, AGENT_ID);

    // owner_id is polymorphic, so it can never have a foreign key, and the
    // insert policy only checks agent_id — it says nothing about whether the
    // *owner* record belongs to the same person. For a long time that gap was
    // left to create-upload-url, and this test asserted the database let it
    // through.
    //
    // documents_file_key_matches_owner closes it from the other direction, and
    // is the reason the assertion flipped: the key encodes the owner triple, so
    // aiming the row at somebody else's merchant no longer matches the key that
    // was actually signed. A forger has to choose between a key the constraint
    // rejects and an owner_id that is genuinely theirs.
    await expect(
      db.exec(`
        insert into documents (agent_id, owner_type, owner_id, doc_type, file_key, file_name)
        values ('${AGENT_ID}', 'merchant', ${otherMerchant.id}, 'Snooping',
          '${AGENT_ID}/merchant/1/55555555-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'x.pdf');
      `),
    ).rejects.toThrow(/documents_file_key_matches_owner/);
  });

  it("stops a document carrying another agent's file_key", async () => {
    await asPlatform(db);
    const [victim] = await rows<{ file_key: string }>(
      db,
      `select file_key from documents where file_name = 'other-dl.jpg'`,
    );

    await asUser(db, AGENT_ID);

    // The forgery that mattered, and the one that was a live cross-agent read
    // before this constraint: agent_id = self, so the insert policy is happy,
    // and file_key = an object belonging to somebody else. create-download-url
    // then signed that key with the service role because RLS said the ROW was
    // the caller's. Reproduced against the running stack, HTTP 200, other
    // agent's bytes.
    await expect(
      db.exec(`
        insert into documents (agent_id, owner_type, owner_id, doc_type, file_key, file_name)
        values ('${AGENT_ID}', 'merchant', 1, 'Stealing', '${victim.file_key}', 'stolen.jpg');
      `),
    ).rejects.toThrow(/documents_file_key_matches_owner/);
  });

  it("still does not stop a document pointing at a nonexistent record", async () => {
    await asUser(db, AGENT_ID);

    // Deliberately still allowed, and worth pinning as such: the constraint
    // checks that file_key AGREES with owner_id, not that owner_id exists.
    // Nothing in the database can check the latter — owner_id is polymorphic and
    // has no foreign key — so a dangling pointer remains create-upload-url's job
    // (it resolves the parent through the caller's client and 404s), and this
    // asserts the constraint did not quietly grow a second responsibility it
    // cannot actually discharge.
    await db.exec(`
      insert into documents (agent_id, owner_type, owner_id, doc_type, file_key, file_name)
      values ('${AGENT_ID}', 'merchant', 999999, 'Dangling',
        '${AGENT_ID}/merchant/999999/66666666-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'dangling.pdf');
    `);

    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from documents where file_name = 'dangling.pdf'`,
    );
    expect(n).toBe(1);
  });

  it("stops a key whose owner_type is not the row's owner_type", async () => {
    await asUser(db, AGENT_ID);

    // The subtle one, and the reason the constraint uses starts_with() rather
    // than LIKE. Two of the four owner types contain an underscore ('pre_app',
    // 'support_ticket'), and LIKE reads `_` as "any single character" — so a
    // pattern built by concatenation would have accepted 'preXapp' as a match.
    // Here the mismatch is blunter: a lead row wearing a merchant's key, which
    // is how document 7 of one type would read document 7 of another.
    await expect(
      db.exec(`
        insert into documents (agent_id, owner_type, owner_id, doc_type, file_key, file_name)
        values ('${AGENT_ID}', 'lead', 1, 'Wrong type',
          '${AGENT_ID}/merchant/1/77777777-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'crossed.pdf');
      `),
    ).rejects.toThrow(/documents_file_key_matches_owner/);
  });

  it("stops a key that is a prefix rather than an object", async () => {
    await asUser(db, AGENT_ID);

    // Three shapes that all "start with the right thing" and are none of them a
    // key create-upload-url would mint. Checked because the constraint and
    // fileKeyMatchesOwner() in the Edge Functions are meant to agree exactly —
    // a prefix-only test would have accepted the last two, and a row whose key
    // is a directory signs a URL that can never resolve.
    const badKeys = [
      // No trailing slash: not even the prefix.
      `${AGENT_ID}/merchant/1`,
      // The prefix and nothing else — a folder.
      `${AGENT_ID}/merchant/1/`,
      // Deeper than the four segments the key format has.
      `${AGENT_ID}/merchant/1/nested/deeper`,
    ];

    for (const key of badKeys) {
      await expect(
        db.exec(`
          insert into documents (agent_id, owner_type, owner_id, doc_type, file_key, file_name)
          values ('${AGENT_ID}', 'merchant', 1, 'Bad key', '${key}', 'bad.pdf');
        `),
        `should have rejected ${key}`,
      ).rejects.toThrow(/documents_file_key_matches_owner/);
    }
  });

  it("stops a key whose owner_id is a prefix of the row's", async () => {
    await asPlatform(db);
    // merchant 1 is the agent's; the key claims merchant 10, which does not
    // exist. Aimed the other way round on purpose: without the trailing slash in
    // the prefix, owner 1's row would accept owner 10's key and vice versa.
    await asUser(db, AGENT_ID);

    await expect(
      db.exec(`
        insert into documents (agent_id, owner_type, owner_id, doc_type, file_key, file_name)
        values ('${AGENT_ID}', 'merchant', 1, 'Off by a digit',
          '${AGENT_ID}/merchant/10/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'offby.pdf');
      `),
    ).rejects.toThrow(/documents_file_key_matches_owner/);
  });
});

describe("documents_file_key_matches_owner is load-bearing", () => {
  it("would let the cross-agent read back in if dropped", async () => {
    const broken = await createTestDb();
    await resetData(broken);
    await asPlatform(broken);
    await broken.exec(
      `alter table documents drop constraint documents_file_key_matches_owner;`,
    );

    const [victim] = await rows<{ file_key: string }>(
      broken,
      `select file_key from documents where file_name = 'other-dl.jpg'`,
    );

    await asUser(broken, AGENT_ID);
    await broken.exec(`
      insert into documents (agent_id, owner_type, owner_id, doc_type, file_key, file_name)
      values ('${AGENT_ID}', 'merchant', 1, 'Stealing', '${victim.file_key}', 'stolen.jpg');
    `);

    // Visible to the forger, under their own agent_id, carrying somebody else's
    // key — which is all create-download-url needs to sign it. This is the exact
    // row the constraint exists to refuse, and it inserts cleanly without it.
    const [row] = await rows<DocRow>(
      broken,
      `select ${LIST_COLUMNS} from documents where file_name = 'stolen.jpg'`,
    );
    expect(row.agent_id).toBe(AGENT_ID);
    expect(row.file_key).toBe(victim.file_key);
    expect(row.file_key.startsWith(OTHER_AGENT_ID)).toBe(true);

    await broken.close();
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
