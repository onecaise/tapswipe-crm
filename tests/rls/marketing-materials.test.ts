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
 * marketing_materials + marketing_material_events.
 *
 * Four claims, each failing in a different direction, so they are kept in
 * separate describes:
 *
 *   1. **marketing_materials is readable by everyone and writable by nobody
 *      but an admin.** It is the only client-readable table in the schema with
 *      no agent_id, so the usual `agent_id = auth.uid()` half of the policy is
 *      absent — which means the ONLY thing standing between a rep and a write
 *      is `is_admin()`. There is no second line of defence here the way there
 *      is on an owner table, and nothing about the table's shape would look
 *      wrong if the insert policy were widened.
 *   2. **A deactivated rep loses the library.** `is_active_agent()` in the
 *      select policy is the whole of that, and it is easy to read as
 *      decoration on a table that has no ownership to check. It is not: a
 *      deactivated rep holds a working JWT until it expires, and without this
 *      they keep reading the company's current rate cards after being let go.
 *   3. **An event cannot be filed against somebody else's lead.** This is the
 *      documents.file_key lesson in its second form. lead_id is client-supplied
 *      and no other clause in the insert policy reads it, which is exactly the
 *      shape that made file_key a live cross-agent read. The failure here is
 *      not a disclosure — it is a rep writing fabricated engagement history
 *      into a book that is not theirs, which the admin reviewing that lead then
 *      sees as fact.
 *   4. **The log is append-only, in both layers.** No UPDATE or DELETE policy
 *      and no grant for either. Asserted because a log that can be rewritten is
 *      not a log, and this one gets read back in front of a merchant who says
 *      they were never told something.
 *
 * The file_key CHECK is covered too, in its own describe: it is narrower than
 * documents_file_key_matches_owner and pins an invariant the download path
 * depends on rather than closing a demonstrated hole.
 */

type MaterialRow = {
  id: number;
  category: string;
  title: string;
  file_key: string | null;
  archived_at: string | null;
};

type EventRow = {
  id: number;
  material_id: number;
  lead_id: number | null;
  agent_id: string;
  event_type: string;
};

let db: TestDb;

/** Ids created by seedMarketing, so nothing hardcodes a serial. */
let rateCardId = 0;
let archivedId = 0;
let agentLeadId = 0;
let otherLeadId = 0;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db?.close();
});

/**
 * Two materials (one live, one archived) and the two lead ids this file needs.
 *
 * Kept here rather than in tests/helpers/db.ts `seed()` for the reason
 * seedPayouts() is: `seed()` also runs against migration SUBSETS that predate
 * these tables (deactivation.test.ts calls createTestDb([INITIAL_MIGRATION])),
 * and anything it touches that a prefix has not created yet fails those suites
 * with `relation does not exist`, pointing nowhere near the cause.
 *
 * Returns nothing and assigns to module scope instead of hardcoding ids,
 * because resetData() clears these tables through the cascade from profiles
 * without naming them — so their sequences are never restarted and the ids
 * drift upward run after run.
 */
async function seedMarketing(): Promise<void> {
  await asPlatform(db);

  const [agentLead] = await rows<{ id: number }>(
    db,
    `select id from leads where dba = 'Agent Lead A'`,
  );
  const [otherLead] = await rows<{ id: number }>(
    db,
    `select id from leads where dba = 'Other Agent Lead'`,
  );
  agentLeadId = agentLead.id;
  otherLeadId = otherLead.id;

  const created = await rows<{ id: number; title: string }>(
    db,
    `insert into marketing_materials
       (category, title, file_key, file_name, mime_type, uploaded_by, archived_at)
     values
       ('Rate cards', 'Retail rate card 2026', null, 'retail.pdf', 'application/pdf', '${ADMIN_ID}', null),
       ('Rate cards', 'Retail rate card 2025', null, 'old.pdf',    'application/pdf', '${ADMIN_ID}', now())
     returning id, title`,
  );
  rateCardId = created.find((row) => row.title.endsWith("2026"))!.id;
  archivedId = created.find((row) => row.title.endsWith("2025"))!.id;

  // The file_key CHECK needs the row's own id, so it is written in a second
  // statement — the same two-step marketing-material-file-url performs, and the
  // reason file_key is nullable at all.
  await db.exec(
    `update marketing_materials set file_key = id::text || '/retail.pdf'
      where id = ${rateCardId}`,
  );

  // Seeded as the platform owner, which has no auth.uid() — so these would
  // stamp a cross_agent_insert if the audit trigger were attached. It is not,
  // deliberately, and the absence is asserted further down.
  await db.exec(
    `insert into marketing_material_events (material_id, lead_id, agent_id, event_type)
     values (${rateCardId}, ${agentLeadId}, '${AGENT_ID}', 'viewed')`,
  );
}

beforeEach(async () => {
  await resetData(db);
  await seedMarketing();
});

describe("marketing_materials is company reference data", () => {
  it("lets an agent read every material, including another admin's", async () => {
    // The point of the table: no agent_id, so no scoping. A rep sees the whole
    // library or the feature does not work.
    await asUser(db, AGENT_ID);
    const list = await rows<MaterialRow>(
      db,
      `select id, category, title, file_key, archived_at
         from marketing_materials order by title`,
    );
    expect(list.map((row) => row.title)).toEqual([
      "Retail rate card 2025",
      "Retail rate card 2026",
    ]);
  });

  it("lets a second agent read the same rows", async () => {
    // Asserted separately from the first agent, because a select policy that
    // accidentally compared something to auth.uid() could still pass for
    // whichever user the fixture happened to favour.
    await asUser(db, OTHER_AGENT_ID);
    const [{ n }] = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from marketing_materials`,
    );
    expect(n).toBe(2);
  });

  it("refuses an agent inserting a material", async () => {
    // is_admin() is the ONLY check on this table's writes. There is no
    // agent_id for a second condition to fall back on.
    await asUser(db, AGENT_ID);
    await expect(
      db.exec(
        `insert into marketing_materials (category, title, uploaded_by)
         values ('Rate cards', 'Forged', '${AGENT_ID}')`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("refuses an agent updating a material", async () => {
    await asUser(db, AGENT_ID);
    await db.exec(
      `update marketing_materials set title = 'Renamed' where id = ${rateCardId}`,
    );

    // An UPDATE blocked by RLS is not an error — it matches zero rows. So the
    // assertion has to be on the data, not on a rejection.
    await asPlatform(db);
    const [row] = await rows<MaterialRow>(
      db,
      `select title from marketing_materials where id = ${rateCardId}` as string,
    );
    expect(row.title).toBe("Retail rate card 2026");
  });

  it("lets an admin insert, update and archive", async () => {
    await asUser(db, ADMIN_ID);
    await db.exec(
      `insert into marketing_materials (category, title, uploaded_by)
       values ('One-pagers', 'Restaurant one-pager', '${ADMIN_ID}')`,
    );
    await db.exec(
      `update marketing_materials set archived_at = now() where id = ${rateCardId}`,
    );

    const live = await rows<MaterialRow>(
      db,
      `select title from marketing_materials where archived_at is null order by title`,
    );
    expect(live.map((row) => row.title)).toEqual(["Restaurant one-pager"]);
  });

  it("has no delete path, even for an admin", async () => {
    // Archiving is the retirement mechanism; a delete would either cascade the
    // engagement log away or be blocked by the FK forever. No policy and no
    // grant, so this is denied at the privilege layer rather than filtered.
    await asUser(db, ADMIN_ID);
    await expect(
      db.exec(`delete from marketing_materials where id = ${archivedId}`),
    ).rejects.toThrow(/permission denied|policy/i);
  });
});

describe("a deactivated rep loses the library", () => {
  beforeEach(async () => {
    await asPlatform(db);
    await db.exec(
      `update profiles set is_active = false where id = '${AGENT_ID}'`,
    );
  });

  it("reads no materials once deactivated", async () => {
    // The whole of this is is_active_agent() in the select policy. On an owner
    // table that check is belt-and-braces next to the agent_id comparison;
    // here it is the only thing there is.
    await asUser(db, AGENT_ID);
    const [{ n }] = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from marketing_materials`,
    );
    expect(n).toBe(0);
  });

  it("cannot log an event once deactivated", async () => {
    await asUser(db, AGENT_ID);
    await expect(
      db.exec(
        `insert into marketing_material_events (material_id, lead_id, agent_id, event_type)
         values (${rateCardId}, ${agentLeadId}, '${AGENT_ID}', 'downloaded')`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe("events cannot be filed against another rep's lead", () => {
  it("lets an agent log against their own lead", async () => {
    await asUser(db, AGENT_ID);
    await db.exec(
      `insert into marketing_material_events (material_id, lead_id, agent_id, event_type)
       values (${rateCardId}, ${agentLeadId}, '${AGENT_ID}', 'emailed')`,
    );

    const mine = await rows<EventRow>(
      db,
      `select event_type from marketing_material_events
        where lead_id = ${agentLeadId} order by event_type`,
    );
    expect(mine.map((row) => row.event_type)).toEqual(["emailed", "viewed"]);
  });

  it("lets an agent log with no lead at all", async () => {
    // The library page's own usage. lead_id is nullable precisely so reading a
    // rate card outside any deal is still recorded rather than dropped.
    await asUser(db, AGENT_ID);
    await db.exec(
      `insert into marketing_material_events (material_id, lead_id, agent_id, event_type)
       values (${rateCardId}, null, '${AGENT_ID}', 'viewed')`,
    );

    const [{ n }] = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from marketing_material_events where lead_id is null`,
    );
    expect(n).toBe(1);
  });

  it("refuses an agent logging against a lead that is not theirs", async () => {
    // THE assertion in this file. Without the `exists` clause in the insert
    // policy this succeeds: agent_id is the caller's own, so every other check
    // passes, and the row lands on another rep's lead as fabricated history.
    await asUser(db, AGENT_ID);
    await expect(
      db.exec(
        `insert into marketing_material_events (material_id, lead_id, agent_id, event_type)
         values (${rateCardId}, ${otherLeadId}, '${AGENT_ID}', 'emailed')`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("refuses an agent logging under another rep's agent_id", async () => {
    // The other half of the same policy, and the one an owner table would
    // normally be carrying alone.
    await asUser(db, AGENT_ID);
    await expect(
      db.exec(
        `insert into marketing_material_events (material_id, lead_id, agent_id, event_type)
         values (${rateCardId}, ${agentLeadId}, '${OTHER_AGENT_ID}', 'emailed')`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("lets an admin log against any rep's lead", async () => {
    // An admin demoing a material on a rep's deal. The is_admin() branch is
    // what allows it, and it is deliberately a separate disjunct rather than
    // the exists() happening to pass — an admin's own `leads` policy would let
    // the subquery succeed too, but only because admins see every lead, which
    // is a different fact and would tie this policy to that one.
    await asUser(db, ADMIN_ID);
    await db.exec(
      `insert into marketing_material_events (material_id, lead_id, agent_id, event_type)
       values (${rateCardId}, ${otherLeadId}, '${ADMIN_ID}', 'printed')`,
    );

    await asPlatform(db);
    const [{ n }] = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from marketing_material_events
        where lead_id = ${otherLeadId}`,
    );
    expect(n).toBe(1);
  });

  it("scopes reads own-or-admin", async () => {
    await asPlatform(db);
    await db.exec(
      `insert into marketing_material_events (material_id, lead_id, agent_id, event_type)
       values (${rateCardId}, ${otherLeadId}, '${OTHER_AGENT_ID}', 'viewed')`,
    );

    await asUser(db, AGENT_ID);
    const mine = await rows<EventRow>(
      db,
      `select agent_id from marketing_material_events`,
    );
    expect(mine.map((row) => row.agent_id)).toEqual([AGENT_ID]);

    await asUser(db, ADMIN_ID);
    const [{ n }] = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from marketing_material_events`,
    );
    expect(n).toBe(2);
  });
});

describe("the event log is append-only", () => {
  it("refuses an update, even from an admin", async () => {
    await asUser(db, ADMIN_ID);
    await expect(
      db.exec(
        `update marketing_material_events set event_type = 'printed'
          where material_id = ${rateCardId}`,
      ),
    ).rejects.toThrow(/permission denied|policy/i);
  });

  it("refuses a delete, even from an admin", async () => {
    await asUser(db, ADMIN_ID);
    await expect(
      db.exec(
        `delete from marketing_material_events where material_id = ${rateCardId}`,
      ),
    ).rejects.toThrow(/permission denied|policy/i);
  });

  it("constrains event_type to the four verbs", async () => {
    await asPlatform(db);
    await expect(
      db.exec(
        `insert into marketing_material_events (material_id, lead_id, agent_id, event_type)
         values (${rateCardId}, null, '${AGENT_ID}', 'faxed')`,
      ),
    ).rejects.toThrow(/marketing_material_events_event_type_check|check constraint/i);
  });
});

describe("file_key must belong to its own material", () => {
  it("accepts a null, which is the pre-upload row", async () => {
    // Not laxness: the row is created before the upload because the key needs
    // the id. A CHECK that rejected null would make the two-step impossible.
    await asPlatform(db);
    await db.exec(
      `insert into marketing_materials (category, title, uploaded_by)
       values ('One-pagers', 'Not uploaded yet', '${ADMIN_ID}')`,
    );
    const [row] = await rows<MaterialRow>(
      db,
      `select file_key from marketing_materials where title = 'Not uploaded yet'`,
    );
    expect(row.file_key).toBeNull();
  });

  it("refuses a key belonging to a different material", async () => {
    // The invariant the download path depends on. Nothing client-supplied
    // reaches this column today, so this is not closing a demonstrated hole the
    // way the documents constraint is — it is what stops a future shortcut
    // making {material_id}/ mean nothing.
    await asPlatform(db);
    await expect(
      db.exec(
        `update marketing_materials
            set file_key = '${archivedId}/stolen.pdf'
          where id = ${rateCardId}`,
      ),
    ).rejects.toThrow(/marketing_materials_file_key_matches_id/);
  });

  it("refuses a bare directory and refuses extra depth", async () => {
    await asPlatform(db);
    await expect(
      db.exec(
        `update marketing_materials set file_key = '${rateCardId}/'
          where id = ${rateCardId}`,
      ),
    ).rejects.toThrow(/marketing_materials_file_key_matches_id/);

    await expect(
      db.exec(
        `update marketing_materials set file_key = '${rateCardId}/a/b.pdf'
          where id = ${rateCardId}`,
      ),
    ).rejects.toThrow(/marketing_materials_file_key_matches_id/);
  });

  it("is a validated constraint, unlike the documents one", async () => {
    // documents_file_key_matches_owner ships NOT VALID because rows written by
    // hand-rolled fixtures predate it. This table is new, so there is nothing to
    // exempt — and a NOT VALID here would silently leave the same gap that
    // forces fileKeyMatchesOwner() to exist as a second layer.
    await asPlatform(db);
    const [{ convalidated }] = await rows<{ convalidated: boolean }>(
      db,
      `select convalidated from pg_constraint
        where conname = 'marketing_materials_file_key_matches_id'`,
    );
    expect(convalidated).toBe(true);
  });
});

describe("neither table carries the cross-agent audit trigger", () => {
  it("has no trigger on either table", async () => {
    // marketing_materials has no agent_id, so log_cross_agent_change() would
    // read NULL and log every write — the support_ticket_replies trap.
    // marketing_material_events does have one and the trigger would work, which
    // is the omission worth pinning: the table is already an audit trail, and a
    // second one would record that an admin looked at something in a table
    // whose entire content is a record of who looked at what.
    await asPlatform(db);
    const triggers = await rows<{ tgname: string }>(
      db,
      `select t.tgname
         from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
        where not t.tgisinternal
          and c.relname in ('marketing_materials', 'marketing_material_events')`,
    );
    expect(triggers).toEqual([]);
  });

  it("writes no audit_log row when a rep logs an event", async () => {
    // The behavioural half, so this does not pass merely because the trigger
    // was renamed.
    await asPlatform(db);
    await db.exec(`delete from audit_log`);

    await asUser(db, AGENT_ID);
    await db.exec(
      `insert into marketing_material_events (material_id, lead_id, agent_id, event_type)
       values (${rateCardId}, ${agentLeadId}, '${AGENT_ID}', 'downloaded')`,
    );

    await asPlatform(db);
    const [{ n }] = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from audit_log`,
    );
    expect(n).toBe(0);
  });
});

describe("anon reaches neither table", () => {
  it("holds no privileges on either", async () => {
    // Never grant anon anything. 20260805210000 removed the default privileges
    // that used to auto-grant new tables precisely so this cannot be skipped by
    // accident, and the migration revokes explicitly on top.
    await asPlatform(db);
    const granted = await rows<{ table_name: string; privilege_type: string }>(
      db,
      `select table_name, privilege_type
         from information_schema.role_table_grants
        where grantee = 'anon'
          and table_name in ('marketing_materials', 'marketing_material_events')`,
    );
    expect(granted).toEqual([]);
  });
});
