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
 * business_documents — the company library behind /documents.
 *
 * Modelled on marketing_materials (tests/rls/marketing-materials.test.ts), and
 * the claims are the same where the design is the same:
 *
 *   1. **Every active user reads the live library; only an admin writes.** No
 *      agent_id, so is_admin() is the only thing between a rep and a write.
 *   2. **A deactivated rep loses it.** is_active_agent() is the whole of that.
 *   3. **There is no delete path in either layer.** The UI's "Delete" is an
 *      UPDATE of archived_at.
 *   4. **file_key belongs to its own row**, validated.
 *
 * And one claim marketing does NOT make, because the design differs on purpose:
 *
 *   5. **An archived ("deleted") document is hidden from a rep BY RLS.** For
 *      marketing and products, hiding archived rows is the query's job, since
 *      an archived row is still history somebody reads. Here archived means
 *      deleted, so a rep calling PostgREST directly must not list it.
 */

type DocRow = {
  id: number;
  category: string;
  title: string;
  file_key: string | null;
  archived_at: string | null;
};

let db: TestDb;
let liveId = 0;
let deletedId = 0;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db?.close();
});

/**
 * One live document with a file and one archived one. Ids are read back, not
 * hardcoded: resetData() clears this table through the cascade from profiles
 * without restarting its sequence.
 */
async function seedLibrary(): Promise<void> {
  await asPlatform(db);
  const created = await rows<{ id: number; title: string }>(
    db,
    `insert into business_documents
       (category, title, file_name, mime_type, size_bytes, uploaded_by, archived_at)
     values
       ('Policies', 'Chargeback policy',  'chargebacks.pdf', 'application/pdf', 2048, '${ADMIN_ID}', null),
       ('Policies', 'Old refund policy',  'refunds.pdf',     'application/pdf', 1024, '${ADMIN_ID}', now())
     returning id, title`,
  );
  liveId = created.find((r) => r.title === "Chargeback policy")!.id;
  deletedId = created.find((r) => r.title === "Old refund policy")!.id;

  // The key needs the row's own id, so it is written second -- the two-step
  // business-document-file-url performs, and why file_key is nullable.
  await db.exec(
    `update business_documents set file_key = id::text || '/' || file_name`,
  );
}

beforeEach(async () => {
  await resetData(db);
  await seedLibrary();
});

async function titlesAs(userId: string | null): Promise<string[]> {
  await asUser(db, userId);
  const list = await rows<DocRow>(
    db,
    `select id, category, title, file_key, archived_at
       from business_documents order by title`,
  );
  return list.map((r) => r.title);
}

describe("every active user reads the live library", () => {
  it("lets an agent read every live document, including an admin's upload", async () => {
    expect(await titlesAs(AGENT_ID)).toEqual(["Chargeback policy"]);
  });

  it("lets a second agent read the same rows", async () => {
    // Separate from the first: a select policy that compared anything to
    // auth.uid() could still pass for whichever user the fixture favoured.
    expect(await titlesAs(OTHER_AGENT_ID)).toEqual(["Chargeback policy"]);
  });

  it("returns nothing to an unauthenticated caller", async () => {
    expect(await titlesAs(null)).toEqual([]);
  });
});

describe("a deleted document is hidden from reps by the database", () => {
  it("does not list an archived document to an agent, even asked for by id", async () => {
    await asUser(db, AGENT_ID);
    const found = await rows<DocRow>(
      db,
      `select id from business_documents where id = ${deletedId}`,
    );
    expect(found).toEqual([]);
  });

  it("still shows it to an admin, so a mistaken delete is recoverable", async () => {
    expect(await titlesAs(ADMIN_ID)).toEqual([
      "Chargeback policy",
      "Old refund policy",
    ]);
  });

  it("would leak the deleted row if the policy stopped checking archived_at", async () => {
    // Non-vacuity: the marketing-shaped policy (no archived_at clause) is what
    // the assertion above would otherwise be measuring.
    const leaky = await createTestDb();
    await resetData(leaky);
    await asPlatform(leaky);
    await leaky.exec(`
      insert into business_documents (category, title, uploaded_by, archived_at)
      values ('Policies', 'Gone', '${ADMIN_ID}', now());
      drop policy "select live to active users, all to admin" on business_documents;
      create policy "select active or admin" on business_documents
        for select using (is_active_agent() or is_admin());
    `);
    await asUser(leaky, AGENT_ID);
    const seen = await rows<{ title: string }>(
      leaky,
      `select title from business_documents`,
    );
    expect(seen.map((r) => r.title)).toEqual(["Gone"]);
    await leaky.close();
  });
});

describe("only an admin writes", () => {
  it("refuses an agent inserting a document", async () => {
    await asUser(db, AGENT_ID);
    await expect(
      db.exec(
        `insert into business_documents (category, title, uploaded_by)
         values ('Policies', 'Forged', '${AGENT_ID}')`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("refuses an agent renaming or deleting a document", async () => {
    // An UPDATE blocked by RLS is not an error -- it matches zero rows -- so
    // the assertion is on the data.
    await asUser(db, AGENT_ID);
    await db.exec(
      `update business_documents set title = 'Renamed' where id = ${liveId}`,
    );
    await db.exec(
      `update business_documents set archived_at = now() where id = ${liveId}`,
    );

    await asPlatform(db);
    const [row] = await rows<DocRow>(
      db,
      `select title, archived_at from business_documents where id = ${liveId}`,
    );
    expect(row.title).toBe("Chargeback policy");
    expect(row.archived_at).toBeNull();
  });

  it("lets an admin add, rename, recategorise and delete", async () => {
    await asUser(db, ADMIN_ID);
    await db.exec(
      `insert into business_documents (category, title, uploaded_by)
       values ('Forms', 'W-9 request', '${ADMIN_ID}')`,
    );
    await db.exec(
      `update business_documents set title = 'Chargebacks', category = 'Procedures'
        where id = ${liveId}`,
    );

    const renamed = await rows<DocRow>(
      db,
      `select category, title from business_documents where id = ${liveId}`,
    );
    expect(renamed).toEqual([{ category: "Procedures", title: "Chargebacks" }]);

    await db.exec(
      `update business_documents set archived_at = now() where id = ${liveId}`,
    );
    expect(await titlesAs(AGENT_ID)).toEqual(["W-9 request"]);
  });

  it("has no delete path, even for an admin", async () => {
    await asUser(db, ADMIN_ID);
    await expect(
      db.exec(`delete from business_documents where id = ${deletedId}`),
    ).rejects.toThrow(/permission denied|policy/i);
  });

  it("would let an agent write if the policy dropped is_admin()", async () => {
    // Non-vacuity for the refusal above: with the grant unchanged and the
    // policy opened, the same insert lands. is_admin() is the only check.
    const open = await createTestDb();
    await resetData(open);
    await asPlatform(open);
    await open.exec(`
      drop policy "admin inserts" on business_documents;
      create policy "admin inserts" on business_documents
        for insert with check (true);
    `);
    await asUser(open, AGENT_ID);
    await open.exec(
      `insert into business_documents (category, title, uploaded_by)
       values ('Policies', 'Forged', '${AGENT_ID}')`,
    );
    await asPlatform(open);
    const [{ n }] = await rows<{ n: number }>(
      open,
      `select count(*)::int as n from business_documents where title = 'Forged'`,
    );
    expect(n).toBe(1);
    await open.close();
  });
});

describe("a deactivated rep loses the library", () => {
  it("reads nothing once deactivated", async () => {
    await asPlatform(db);
    await db.exec(`update profiles set is_active = false where id = '${AGENT_ID}'`);
    expect(await titlesAs(AGENT_ID)).toEqual([]);
  });

  it("a deactivated admin reads nothing and writes nothing", async () => {
    await asPlatform(db);
    await db.exec(`update profiles set is_active = false where id = '${ADMIN_ID}'`);
    expect(await titlesAs(ADMIN_ID)).toEqual([]);

    await asUser(db, ADMIN_ID);
    await expect(
      db.exec(
        `insert into business_documents (category, title, uploaded_by)
         values ('Policies', 'Post-exit', '${ADMIN_ID}')`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe("file_key must belong to its own document", () => {
  it("accepts a null, which is the pre-upload row", async () => {
    await asPlatform(db);
    await db.exec(
      `insert into business_documents (category, title, uploaded_by)
       values ('Forms', 'Not uploaded yet', '${ADMIN_ID}')`,
    );
    const [row] = await rows<DocRow>(
      db,
      `select file_key from business_documents where title = 'Not uploaded yet'`,
    );
    expect(row.file_key).toBeNull();
  });

  it("refuses a key belonging to a different document", async () => {
    await asPlatform(db);
    await expect(
      db.exec(
        `update business_documents set file_key = '${deletedId}/stolen.pdf'
          where id = ${liveId}`,
      ),
    ).rejects.toThrow(/business_documents_file_key_matches_id/);
  });

  it("refuses a bare directory and refuses extra depth", async () => {
    await asPlatform(db);
    for (const key of [`${liveId}/`, `${liveId}/a/b.pdf`]) {
      await expect(
        db.exec(
          `update business_documents set file_key = '${key}' where id = ${liveId}`,
        ),
        `should have rejected ${key}`,
      ).rejects.toThrow(/business_documents_file_key_matches_id/);
    }
  });

  it("is a validated constraint", async () => {
    await asPlatform(db);
    const [{ convalidated }] = await rows<{ convalidated: boolean }>(
      db,
      `select convalidated from pg_constraint
        where conname = 'business_documents_file_key_matches_id'`,
    );
    expect(convalidated).toBe(true);
  });

  it("refuses a negative size", async () => {
    await asPlatform(db);
    await expect(
      db.exec(`update business_documents set size_bytes = -1 where id = ${liveId}`),
    ).rejects.toThrow(/check constraint/i);
  });
});

describe("no cross-agent audit trigger, and no anon access", () => {
  it("has no trigger", async () => {
    // No agent_id, so log_cross_agent_change() would read NULL and log every
    // write. Uploads are audited in business-document-file-url instead.
    await asPlatform(db);
    const triggers = await rows<{ tgname: string }>(
      db,
      `select t.tgname from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
        where not t.tgisinternal and c.relname = 'business_documents'`,
    );
    expect(triggers).toEqual([]);
  });

  it("gives anon nothing", async () => {
    await asPlatform(db);
    const granted = await rows<{ privilege_type: string }>(
      db,
      `select privilege_type from information_schema.role_table_grants
        where grantee = 'anon' and table_name = 'business_documents'`,
    );
    expect(granted).toEqual([]);
  });
});
