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
 * The LEGACY `documents` table, closed by 20261013121000.
 *
 * Reps used to upload merchant paperwork (voided checks, driver's licences)
 * onto leads, merchants, pre-apps and tickets. The CRM no longer accepts it,
 * and the UI change alone would have left the path open to anyone calling
 * PostgREST directly. So it is closed in both layers, and this file asserts
 * each separately:
 *
 *   1. **Nobody signed in can write.** INSERT and DELETE are revoked from
 *      `authenticated` (UPDATE never existed), so every write is
 *      "permission denied" -- for an admin too, and before RLS is consulted.
 *   2. **Only an admin can read.** One policy remains, `select admin`. A rep's
 *      SELECT succeeds and returns nothing, even for rows filed under them.
 *   3. **The CHECK still holds** for the only writer left, the service role
 *      (scripts/purge-legacy-documents.mjs deletes; nothing inserts).
 *
 * The seed (tests/helpers/db.ts) still writes three documents as the platform
 * owner -- two the agent's, one another agent's -- which is the state a hosted
 * project is in until the purge runs.
 */

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

/** A key that satisfies documents_file_key_matches_owner, so a refusal below
 *  is about the closure and never about the constraint. */
const OWN_KEY = `${AGENT_ID}/merchant/1/44444444-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const ownInsert = `
  insert into documents (agent_id, owner_type, owner_id, doc_type, file_key, file_name)
  values ('${AGENT_ID}', 'merchant', 1, 'Voided check', '${OWN_KEY}', 'check.pdf');
`;

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

async function countByName(fileName: string): Promise<number> {
  await asPlatform(db);
  const [{ n }] = await rows<CountRow>(
    db,
    `select count(*)::int as n from documents where file_name = '${fileName}'`,
  );
  return n;
}

describe("nobody signed in can write to documents", () => {
  it("refuses an agent inserting a document in their own book", async () => {
    // THE assertion of this file: the one write the old insert policy admitted.
    // The key is valid, the agent_id is the caller's and the merchant is theirs,
    // so nothing but the closure can be what refuses it.
    await asUser(db, AGENT_ID);
    await expect(db.exec(ownInsert)).rejects.toThrow(/permission denied/i);
    expect(await countByName("check.pdf")).toBe(0);
  });

  it("refuses an admin inserting, too", async () => {
    // The old policy's is_admin() branch is gone with it. An admin publishing a
    // company document uses business_documents; nothing goes in here.
    await asUser(db, ADMIN_ID);
    await expect(db.exec(ownInsert)).rejects.toThrow(/permission denied/i);
  });

  it("refuses an agent deleting their own document", async () => {
    // The old `delete own or admin` policy let a rep remove their own upload.
    // Refused loudly now rather than filtered to zero rows.
    await asUser(db, AGENT_ID);
    await expect(
      db.exec(`delete from documents where file_name = 'agent-voided-check.pdf';`),
    ).rejects.toThrow(/permission denied/i);
    expect(await countByName("agent-voided-check.pdf")).toBe(1);
  });

  it("refuses an admin deleting, too", async () => {
    // Removal is the purge script's job, through the Storage API, so the row and
    // its object go together. A PostgREST delete could only ever reach the row.
    await asUser(db, ADMIN_ID);
    await expect(
      db.exec(`delete from documents where file_name = 'other-dl.jpg';`),
    ).rejects.toThrow(/permission denied/i);
    expect(await countByName("other-dl.jpg")).toBe(1);
  });

  it("refuses an update", async () => {
    await asUser(db, ADMIN_ID);
    await expect(
      db.exec(`update documents set doc_type = 'Renamed';`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("holds SELECT and nothing else, on the table and the sequence", async () => {
    await asPlatform(db);
    const privileges = await rows<{ privilege_type: string }>(
      db,
      `select privilege_type from information_schema.role_table_grants
        where grantee = 'authenticated' and table_name = 'documents'
        order by privilege_type`,
    );
    expect(privileges.map((p) => p.privilege_type)).toEqual(["SELECT"]);

    const [{ usage }] = await rows<{ usage: boolean }>(
      db,
      `select has_sequence_privilege('authenticated', 'documents_id_seq', 'USAGE') as usage`,
    );
    expect(usage).toBe(false);
  });
});

describe("only an admin can read documents", () => {
  it("returns nothing to an agent, even their own uploads", async () => {
    // Two of the three seeded rows are filed under this agent.
    await asPlatform(db);
    const [{ n: own }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from documents where agent_id = '${AGENT_ID}'`,
    );
    expect(own).toBe(2);

    await asUser(db, AGENT_ID);
    expect(await rows<DocRow>(db, listQuery)).toHaveLength(0);
  });

  it("returns every document to an admin", async () => {
    await asUser(db, ADMIN_ID);
    const result = await rows<DocRow>(db, listQuery);
    expect(result).toHaveLength(3);
    expect(new Set(result.map((d) => d.agent_id))).toEqual(
      new Set([AGENT_ID, OTHER_AGENT_ID]),
    );
  });

  it("returns nothing to a deactivated admin or an unauthenticated caller", async () => {
    await asUser(db, null);
    expect(await rows<DocRow>(db, listQuery)).toHaveLength(0);

    await asPlatform(db);
    await db.exec(`update profiles set is_active = false where id = '${ADMIN_ID}';`);
    await asUser(db, ADMIN_ID);
    expect(await rows<DocRow>(db, listQuery)).toHaveLength(0);
  });

  it("carries exactly one policy, and it is the admin SELECT", async () => {
    // Named, so a re-added own-row policy cannot hide behind the same count.
    await asPlatform(db);
    const policies = await rows<{ policyname: string; cmd: string }>(
      db,
      `select policyname, cmd from pg_policies
        where schemaname = 'public' and tablename = 'documents'`,
    );
    expect(policies).toEqual([{ policyname: "select admin", cmd: "SELECT" }]);
  });
});

describe("the closure is what refuses the write", () => {
  it("lets the same agent insert once the old grant and policy are put back", async () => {
    // Non-vacuity, in-suite. If ownInsert failed for some reason other than
    // the closure (a bad key, a missing merchant) the refusals above would pass
    // for nothing. Restoring exactly what 20261013121000 removed makes the very
    // same statement succeed.
    const reopened = await createTestDb();
    await resetData(reopened);
    await asPlatform(reopened);
    await reopened.exec(`
      grant insert on documents to authenticated;
      grant usage on documents_id_seq to authenticated;
      create policy "insert own" on documents
        for insert with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());
    `);

    await asUser(reopened, AGENT_ID);
    await reopened.exec(ownInsert);

    await asPlatform(reopened);
    const [{ n }] = await rows<CountRow>(
      reopened,
      `select count(*)::int as n from documents where file_name = 'check.pdf'`,
    );
    expect(n).toBe(1);

    await reopened.close();
  });

  it("still refuses with only the grant put back, because the policy is gone", async () => {
    // Each layer holds on its own. A grant restored by mistake meets no policy
    // that admits the write.
    const halfOpen = await createTestDb();
    await resetData(halfOpen);
    await asPlatform(halfOpen);
    await halfOpen.exec(`
      grant insert on documents to authenticated;
      grant usage on documents_id_seq to authenticated;
    `);

    await asUser(halfOpen, AGENT_ID);
    await expect(halfOpen.exec(ownInsert)).rejects.toThrow(/row-level security/i);

    await halfOpen.close();
  });
});

describe("documents_file_key_matches_owner still holds for the service role", () => {
  // The constraint is kept with the table. Nothing inserts any more, but a
  // CHECK applies to every writer -- the platform owner included, which is what
  // asPlatform() runs as -- and these pin that it was not dropped along with
  // the policies.

  it("rejects an owner_type outside the check constraint", async () => {
    await asPlatform(db);
    await expect(
      db.exec(`
        insert into documents (agent_id, owner_type, owner_id, doc_type, file_key)
        values ('${AGENT_ID}', 'ghost_sheet', 1, 'Notes', 'k/2');
      `),
    ).rejects.toThrow(/check constraint/i);
  });

  it("rejects a row carrying another agent's file_key", async () => {
    await asPlatform(db);
    const [victim] = await rows<{ file_key: string }>(
      db,
      `select file_key from documents where file_name = 'other-dl.jpg'`,
    );
    await expect(
      db.exec(`
        insert into documents (agent_id, owner_type, owner_id, doc_type, file_key, file_name)
        values ('${AGENT_ID}', 'merchant', 1, 'Stealing', '${victim.file_key}', 'stolen.jpg');
      `),
    ).rejects.toThrow(/documents_file_key_matches_owner/);
  });

  it("rejects a key whose owner_type is not the row's owner_type", async () => {
    await asPlatform(db);
    await expect(
      db.exec(`
        insert into documents (agent_id, owner_type, owner_id, doc_type, file_key, file_name)
        values ('${AGENT_ID}', 'lead', 1, 'Wrong type',
          '${AGENT_ID}/merchant/1/77777777-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'crossed.pdf');
      `),
    ).rejects.toThrow(/documents_file_key_matches_owner/);
  });

  it("rejects a key that is a prefix rather than an object", async () => {
    await asPlatform(db);
    for (const key of [
      `${AGENT_ID}/merchant/1`,
      `${AGENT_ID}/merchant/1/`,
      `${AGENT_ID}/merchant/1/nested/deeper`,
      `${AGENT_ID}/merchant/10/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    ]) {
      await expect(
        db.exec(`
          insert into documents (agent_id, owner_type, owner_id, doc_type, file_key, file_name)
          values ('${AGENT_ID}', 'merchant', 1, 'Bad key', '${key}', 'bad.pdf');
        `),
        `should have rejected ${key}`,
      ).rejects.toThrow(/documents_file_key_matches_owner/);
    }
  });

  it("checks agreement, not existence: a dangling owner_id still passes", async () => {
    // Pinned as before: the constraint ties the key to the owner triple, and
    // nothing can check the owner exists (owner_id is polymorphic, no FK).
    await asPlatform(db);
    await db.exec(`
      insert into documents (agent_id, owner_type, owner_id, doc_type, file_key, file_name)
      values ('${AGENT_ID}', 'merchant', 999999, 'Dangling',
        '${AGENT_ID}/merchant/999999/66666666-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'dangling.pdf');
    `);
    expect(await countByName("dangling.pdf")).toBe(1);
  });

  it("is what refuses the mismatched key", async () => {
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
    await broken.exec(`
      insert into documents (agent_id, owner_type, owner_id, doc_type, file_key, file_name)
      values ('${AGENT_ID}', 'merchant', 1, 'Stealing', '${victim.file_key}', 'stolen.jpg');
    `);
    const [row] = await rows<DocRow>(
      broken,
      `select ${LIST_COLUMNS} from documents where file_name = 'stolen.jpg'`,
    );
    expect(row.file_key.startsWith(OTHER_AGENT_ID)).toBe(true);
    await broken.close();
  });
});
