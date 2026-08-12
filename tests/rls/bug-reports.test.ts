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
 * bug_reports — the floating report bubble's table.
 *
 * Ordinary Tier 1 ownership, with two departures worth pinning because each is
 * a decision rather than an accident:
 *
 *   1. **Insert is pinned to the caller**, not the usual own-or-admin shape. A
 *      report is a first-hand account, so nobody — admin included — files one
 *      under another name.
 *   2. **There is no delete policy, and no delete grant.** Clearing a report is
 *      an UPDATE that sets status; the row survives. The test that matters most
 *      here is the one proving the row is still there afterwards, because that
 *      is the entire reason this was not built as a delete.
 */
const LIST_COLUMNS =
  "id, agent_id, page, description, status, resolved_at, resolved_by, created_at";

const openQueue = `
  select ${LIST_COLUMNS}
  from bug_reports
  where status = 'open'
  order by created_at desc, id desc
`;

type ReportRow = {
  id: number;
  agent_id: string;
  page: string;
  description: string;
  status: string;
  resolved_by: string | null;
};

type CountRow = { n: number };

let db: TestDb;

beforeEach(async () => {
  await resetData(db);

  // Seeded here rather than in the shared seed(): the regression suites build a
  // database from a PREFIX of the migrations and then call seed(), so a table
  // introduced in 20260812175050 cannot be named there without failing them
  // with "relation does not exist".
  await asPlatform(db);
  await db.exec(`
    insert into bug_reports (agent_id, page, description) values
      ('${AGENT_ID}', '/merchants', 'Merchant list sorts by id, not name.'),
      ('${AGENT_ID}', '/leads/7', 'Follow-up date shows a day early.'),
      ('${OTHER_AGENT_ID}', '/documents', 'Upload spins forever on big PDFs.');
    -- Inserted by the platform owner, which has no auth.uid(), so the audit
    -- trigger stamps a cross_agent_insert for each. Cleared for the same reason
    -- seed() clears it.
    delete from audit_log;
  `);
});

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db?.close();
});

describe("bug report visibility", () => {
  it("shows an agent only their own reports", async () => {
    await asUser(db, AGENT_ID);
    const result = await rows<ReportRow>(db, openQueue);

    expect(result.map((r) => r.page).sort()).toEqual(["/leads/7", "/merchants"]);
    expect(result.map((r) => r.agent_id)).not.toContain(OTHER_AGENT_ID);
  });

  it("shows an admin every report", async () => {
    await asUser(db, ADMIN_ID);

    expect(await rows<ReportRow>(db, openQueue)).toHaveLength(3);
  });

  it("shows a deactivated agent none of their own", async () => {
    await asPlatform(db);
    await db.exec(
      `update profiles set is_active = false where id = '${AGENT_ID}';`,
    );

    await asUser(db, AGENT_ID);

    expect(await rows<ReportRow>(db, openQueue)).toHaveLength(0);
  });
});

describe("filing a report", () => {
  it("lets an agent file one against any page", async () => {
    await asUser(db, AGENT_ID);
    await db.exec(
      `insert into bug_reports (agent_id, page, description)
       values ('${AGENT_ID}', '/pre-apps/3/edit', 'Step 2 loses the EIN.');`,
    );

    const result = await rows<ReportRow>(db, openQueue);
    expect(result.map((r) => r.page)).toContain("/pre-apps/3/edit");
  });

  it("lets an admin file their own", async () => {
    await asUser(db, ADMIN_ID);
    await db.exec(
      `insert into bug_reports (agent_id, page, description)
       values ('${ADMIN_ID}', '/admin/users', 'Role select does not persist.');`,
    );

    // is_active_agent() gates on is_active without checking role, which is what
    // lets an admin satisfy the same insert policy.
    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from bug_reports where agent_id = '${ADMIN_ID}'`,
    );
    expect(n).toBe(1);
  });

  it("refuses a report filed under someone else's name", async () => {
    await asUser(db, AGENT_ID);

    await expect(
      db.exec(
        `insert into bug_reports (agent_id, page, description)
         values ('${OTHER_AGENT_ID}', '/leads', 'Planted report.');`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("refuses one from an admin on a rep's behalf", async () => {
    await asUser(db, ADMIN_ID);

    // The deliberate departure from the usual own-or-admin insert shape: a bug
    // report is a first-hand account, so even an admin cannot author one as
    // somebody else.
    await expect(
      db.exec(
        `insert into bug_reports (agent_id, page, description)
         values ('${AGENT_ID}', '/leads', 'Filed on their behalf.');`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("refuses one from a deactivated agent", async () => {
    await asPlatform(db);
    await db.exec(
      `update profiles set is_active = false where id = '${AGENT_ID}';`,
    );

    await asUser(db, AGENT_ID);
    await expect(
      db.exec(
        `insert into bug_reports (agent_id, page, description)
         values ('${AGENT_ID}', '/leads', 'Still here.');`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe("clearing a report keeps it", () => {
  it("lets an admin resolve a rep's report, and the row survives", async () => {
    await asPlatform(db);
    const [target] = await rows<{ id: number }>(
      db,
      `select id from bug_reports where page = '/merchants'`,
    );

    await asUser(db, ADMIN_ID);
    await db.exec(
      `update bug_reports
          set status = 'resolved', resolved_at = now(), resolved_by = '${ADMIN_ID}'
        where id = ${target.id};`,
    );

    // Out of the queue...
    const queue = await rows<ReportRow>(db, openQueue);
    expect(queue.map((r) => r.id)).not.toContain(target.id);

    // ...but still on file, with who cleared it. This is the whole reason the
    // feature does not delete: a dismissed report is worth more than a missing
    // one when the same bug arrives again.
    await asPlatform(db);
    const [row] = await rows<ReportRow>(
      db,
      `select ${LIST_COLUMNS} from bug_reports where id = ${target.id}`,
    );
    expect(row.status).toBe("resolved");
    expect(row.resolved_by).toBe(ADMIN_ID);
    expect(row.description).toBe("Merchant list sorts by id, not name.");
  });

  it("accepts dismissed as well as resolved, and nothing else", async () => {
    await asPlatform(db);
    const [target] = await rows<{ id: number }>(
      db,
      `select id from bug_reports where page = '/merchants'`,
    );

    await asUser(db, ADMIN_ID);
    await db.exec(
      `update bug_reports set status = 'dismissed' where id = ${target.id};`,
    );

    await expect(
      db.exec(
        `update bug_reports set status = 'wontfix' where id = ${target.id};`,
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it("does not let a rep clear their own report", async () => {
    await asUser(db, AGENT_ID);
    // Filtered, not refused: "admin resolves" matches zero rows for a rep, so
    // the statement succeeds and changes nothing. The UPDATE grant is held by
    // authenticated; the policy is what makes it unreachable.
    await db.exec(`update bug_reports set status = 'dismissed';`);

    await asPlatform(db);
    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from bug_reports where status <> 'open'`,
    );
    expect(n).toBe(0);
  });

  it("lets nobody delete one, admins included", async () => {
    // Refused, not filtered — and the distinction is the belt-and-braces the
    // schema intends. No policy admits a DELETE, AND no DELETE grant exists, so
    // this fails at the privilege check before RLS is consulted at all. Either
    // lock alone would hold; both means a delete policy added later by mistake
    // still opens nothing.
    for (const persona of [AGENT_ID, ADMIN_ID]) {
      await asUser(db, persona);
      await expect(db.exec(`delete from bug_reports;`)).rejects.toThrow(
        /permission denied/i,
      );
    }

    await asPlatform(db);
    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from bug_reports`,
    );
    expect(n).toBe(3);
  });
});

describe("the bug report scoping tests are load-bearing", () => {
  it("would catch a fail-open select policy", async () => {
    const broken = await createTestDb();
    await resetData(broken);
    await asPlatform(broken);
    await broken.exec(`
      insert into bug_reports (agent_id, page, description) values
        ('${OTHER_AGENT_ID}', '/documents', 'Upload spins forever on big PDFs.');
      drop policy "select own or admin" on bug_reports;
      create policy "select own or admin" on bug_reports
        for select using (true);
    `);

    await asUser(broken, AGENT_ID);
    const leaked = await rows<ReportRow>(broken, openQueue);

    expect(leaked.map((r) => r.agent_id)).toContain(OTHER_AGENT_ID);

    await broken.close();
  });
});
