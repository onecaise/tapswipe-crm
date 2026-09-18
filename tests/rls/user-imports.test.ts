import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_ID,
  AGENT_ID,
  asPlatform,
  asUser,
  createTestDb,
  resetData,
  rows,
  type TestDb,
} from "../helpers/db";

/**
 * The two user_import tables: who can read them, which verbs anyone actually
 * holds, and the constraints that keep a staging row meaningful.
 *
 * What makes this pair different from most Tier 1 tables here, and what most of
 * these assertions are really about:
 *
 *   1. **Neither is rep-readable at all.** Every other table with a policy has
 *      an own-row branch; these have only `is_admin()`. A rep must not be able
 *      to read a list of people being onboarded, and there is no agent_id to
 *      scope by even if we wanted one.
 *   2. **Neither is client-writable.** Every write comes from stage-user-import
 *      or provision-user-batch under the service role, so an `authenticated`
 *      insert has to be REFUSED rather than filtered to nothing — and it is
 *      refused twice over, by a missing policy and a missing grant. Either
 *      alone would do; both means a policy added by mistake still opens
 *      nothing.
 *   3. **orphaned_auth_user must accept a uuid that is NOT in profiles.** That
 *      is the entire point of the column: it names an auth.users row with no
 *      profile. A foreign key there could never be satisfied, so the absence of
 *      one is a correctness requirement rather than an oversight, and it is
 *      asserted here so nobody "tidies up" by adding it.
 *   4. **imported_by is the eighteenth NO ACTION reference to profiles(id).**
 *      A leftover batch blocks deleting a user, which is the trap
 *      scripts/seed-local-users.mjs's teardown list exists to avoid. Asserted
 *      so the count in CLAUDE.md and that list stay honest.
 */

type CountRow = { n: number };

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(async () => {
  await resetData(db);
  await seedImports();
});

afterAll(async () => {
  await db?.close();
});

/**
 * One batch with three rows: a clean one, a blocked one and a skippable one.
 *
 * Inline rather than in tests/helpers/db.ts seed(), for the reason seedPayouts()
 * is separate: seed() also runs against migration subsets that predate these
 * tables, and anything it touches that a prefix has not created yet fails those
 * suites with `relation does not exist`, pointing nowhere near the cause.
 *
 * Ids are read back rather than hardcoded. resetData() clears these tables
 * through the cascade from profiles without naming them, so their sequences are
 * never restarted and the ids drift upward run after run.
 */
async function seedImports(): Promise<number> {
  await asPlatform(db);
  const [batch] = await rows<{ id: number }>(
    db,
    `insert into user_import_batches (imported_by, file_name, source_text)
     values ('${ADMIN_ID}', 'reps.csv', 'Full name,Email\nAvery,a@tapswipe.test')
     returning id`,
  );

  await db.exec(`
    insert into user_import_rows
      (batch_id, row_number, full_name, email, role, blocker, error)
    values
      (${batch.id}, 2, 'Avery Agent', 'avery@tapswipe.test', 'agent', null, null),
      (${batch.id}, 3, null, 'nope', 'agent', 'invalid_email', 'Could not read it.'),
      (${batch.id}, 4, 'Blake', 'blake@tapswipe.test', 'agent', 'email_exists', 'Already has an account.');
  `);

  return batch.id;
}

async function currentBatchId(): Promise<number> {
  await asPlatform(db);
  const [row] = await rows<{ id: number }>(
    db,
    `select id from user_import_batches order by id desc limit 1`,
  );
  return row.id;
}

describe("row level security is enabled", () => {
  it("has RLS on both tables", async () => {
    await asPlatform(db);
    const found = await rows<{ relname: string; relrowsecurity: boolean }>(
      db,
      `select relname, relrowsecurity from pg_class
        where relname in ('user_import_batches','user_import_rows')`,
    );

    expect(found).toHaveLength(2);
    expect(found.every((table) => table.relrowsecurity)).toBe(true);
  });
});

describe("reading", () => {
  it("lets an admin read both tables", async () => {
    await asUser(db, ADMIN_ID);

    const [batches] = await rows<CountRow>(
      db,
      `select count(*)::int as n from user_import_batches`,
    );
    const [importRows] = await rows<CountRow>(
      db,
      `select count(*)::int as n from user_import_rows`,
    );

    expect(batches.n).toBe(1);
    expect(importRows.n).toBe(3);
  });

  it("shows an agent nothing at all, in either table", async () => {
    // Not "only their own" — there is no own here. A rep must not be able to
    // read a list of the people being onboarded alongside them.
    await asUser(db, AGENT_ID);

    const [batches] = await rows<CountRow>(
      db,
      `select count(*)::int as n from user_import_batches`,
    );
    const [importRows] = await rows<CountRow>(
      db,
      `select count(*)::int as n from user_import_rows`,
    );

    expect(batches.n).toBe(0);
    expect(importRows.n).toBe(0);
  });

  it("shows an unauthenticated caller nothing", async () => {
    await asUser(db, null);

    const [batches] = await rows<CountRow>(
      db,
      `select count(*)::int as n from user_import_batches`,
    );
    expect(batches.n).toBe(0);
  });
});

describe("writing — refused by BOTH a missing policy and a missing grant", () => {
  it("refuses an admin's direct insert into user_import_batches", async () => {
    // Admins included. Batches are created by stage-user-import under the
    // service role; there is no client insert path at all.
    await asUser(db, ADMIN_ID);
    await expect(
      db.exec(
        `insert into user_import_batches (imported_by, file_name, source_text)
         values ('${ADMIN_ID}', 'x.csv', 'a,b')`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("refuses an admin's direct insert into user_import_rows", async () => {
    const batchId = await currentBatchId();
    await asUser(db, ADMIN_ID);
    await expect(
      db.exec(
        `insert into user_import_rows (batch_id, row_number)
         values (${batchId}, 9)`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("refuses an admin's update of a staging row", async () => {
    // A blocked row is fixed by correcting the file and re-reading, never by
    // editing staging. Offering the verb would let someone retype a value the
    // file never contained.
    await asUser(db, ADMIN_ID);
    await expect(
      db.exec(`update user_import_rows set full_name = 'Edited'`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("refuses an admin's delete from either table", async () => {
    await asUser(db, ADMIN_ID);
    await expect(
      db.exec(`delete from user_import_batches`),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      db.exec(`delete from user_import_rows`),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("abandoning a batch — the one client write that exists", () => {
  it("lets an admin change the status", async () => {
    await asUser(db, ADMIN_ID);
    await db.exec(
      `update user_import_batches set status = 'abandoned'`,
    );

    await asPlatform(db);
    const [batch] = await rows<{ status: string }>(
      db,
      `select status from user_import_batches order by id desc limit 1`,
    );
    expect(batch.status).toBe("abandoned");
  });

  it("does not let an agent change it", async () => {
    // The grant exists for `authenticated`, so this is the policy doing the
    // work: the update is filtered to zero rows rather than refused.
    await asUser(db, AGENT_ID);
    await db.exec(`update user_import_batches set status = 'abandoned'`);

    await asPlatform(db);
    const [batch] = await rows<{ status: string }>(
      db,
      `select status from user_import_batches order by id desc limit 1`,
    );
    expect(batch.status).toBe("review");
  });
});

describe("anon holds nothing", () => {
  it("has no privilege on either table", async () => {
    // Never grant anon anything. Asserted rather than assumed, because
    // 20260805210000 removed the default privileges that used to auto-grant new
    // tables precisely so this cannot happen by accident.
    await asPlatform(db);
    const granted = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from information_schema.role_table_grants
        where grantee = 'anon'
          and table_name in ('user_import_batches','user_import_rows')`,
    );
    expect(granted[0].n).toBe(0);
  });

  it("does not hold usage on either sequence", async () => {
    await asPlatform(db);
    const granted = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from information_schema.role_usage_grants
        where grantee in ('anon','authenticated')
          and object_name in
            ('user_import_batches_id_seq','user_import_rows_id_seq')`,
    );
    // Not authenticated either: neither table grants it INSERT, so nothing it
    // can do consumes them.
    expect(granted[0].n).toBe(0);
  });
});

describe("constraints", () => {
  it("accepts every status in the vocabulary and refuses one outside it", async () => {
    await asPlatform(db);
    for (const status of ["review", "provisioning", "committed", "abandoned"]) {
      await db.exec(
        `update user_import_batches set status = '${status}'`,
      );
    }
    await expect(
      db.exec(`update user_import_batches set status = 'done'`),
    ).rejects.toThrow(/check constraint/i);
  });

  it("accepts every blocker in the vocabulary and refuses one outside it", async () => {
    const batchId = await currentBatchId();
    await asPlatform(db);

    const blockers = [
      "missing_name",
      "invalid_email",
      "invalid_role",
      "invalid_agent_number",
      "duplicate_email_in_file",
      "duplicate_agent_number_in_file",
      "email_exists",
      "agent_number_taken",
    ];
    for (const blocker of blockers) {
      await db.exec(
        `insert into user_import_rows (batch_id, row_number, blocker)
         values (${batchId}, 50, '${blocker}')`,
      );
    }

    await expect(
      db.exec(
        `insert into user_import_rows (batch_id, row_number, blocker)
         values (${batchId}, 51, 'probably_fine')`,
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it("accepts every outcome in the vocabulary and refuses one outside it", async () => {
    const batchId = await currentBatchId();
    await asPlatform(db);

    for (const outcome of ["created", "resumed", "skipped_duplicate", "failed"]) {
      await db.exec(
        `insert into user_import_rows (batch_id, row_number, outcome)
         values (${batchId}, 60, '${outcome}')`,
      );
    }

    await expect(
      db.exec(
        `insert into user_import_rows (batch_id, row_number, outcome)
         values (${batchId}, 61, 'sort_of_worked')`,
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it("refuses a role outside the two profiles allows", async () => {
    const batchId = await currentBatchId();
    await asPlatform(db);
    await expect(
      db.exec(
        `insert into user_import_rows (batch_id, row_number, role)
         values (${batchId}, 70, 'superadmin')`,
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it("leaves outcome null on a freshly staged row", async () => {
    // Null is the work list. A default of anything else would make every row
    // look already processed.
    await asPlatform(db);
    const [pending] = await rows<CountRow>(
      db,
      `select count(*)::int as n from user_import_rows where outcome is null`,
    );
    expect(pending.n).toBe(3);
  });
});

describe("the two columns with deliberately no foreign key", () => {
  it("stores an orphaned_auth_user that has NO profiles row", async () => {
    // The entire purpose of the column. A reference to profiles(id) could never
    // be satisfied here, because an orphaned auth user is by definition one
    // with no profile — so this is a correctness requirement, not an oversight.
    const batchId = await currentBatchId();
    const ghost = "99999999-9999-9999-9999-999999999999";

    await asPlatform(db);
    await db.exec(
      `insert into user_import_rows
         (batch_id, row_number, outcome, orphaned_auth_user)
       values (${batchId}, 80, 'failed', '${ghost}')`,
    );

    const [found] = await rows<{ orphaned_auth_user: string }>(
      db,
      `select orphaned_auth_user from user_import_rows where row_number = 80`,
    );
    expect(found.orphaned_auth_user).toBe(ghost);
  });

  it("keeps user_id after the profile it names is gone", async () => {
    // Provenance outlives its subject, the same property
    // rep_payout_row_history.row_id has. A cascade here would erase the record
    // that the import ever created that account.
    const batchId = await currentBatchId();

    await asPlatform(db);
    await db.exec(
      `insert into user_import_rows (batch_id, row_number, outcome, user_id)
       values (${batchId}, 81, 'created', '${AGENT_ID}')`,
    );
    // Clear the one FK that would block it, then remove the profile.
    await db.exec(`
      delete from audit_log where actor_id = '${AGENT_ID}' or row_id = '${AGENT_ID}';
      delete from notes where agent_id = '${AGENT_ID}';
      delete from tasks where agent_id = '${AGENT_ID}';
      delete from documents where agent_id = '${AGENT_ID}';
      delete from support_tickets where agent_id = '${AGENT_ID}';
      delete from pre_apps where agent_id = '${AGENT_ID}';
      delete from merchants where agent_id = '${AGENT_ID}';
      delete from leads where agent_id = '${AGENT_ID}';
      delete from ghost_sheets where agent_id = '${AGENT_ID}';
      delete from bug_reports where agent_id = '${AGENT_ID}' or resolved_by = '${AGENT_ID}';
      delete from profiles where id = '${AGENT_ID}';
    `);

    const [found] = await rows<{ user_id: string }>(
      db,
      `select user_id from user_import_rows where row_number = 81`,
    );
    expect(found.user_id).toBe(AGENT_ID);
  });
});

describe("imported_by is the eighteenth NO ACTION reference to profiles", () => {
  it("blocks deleting the admin while their batch exists", async () => {
    // The trap scripts/seed-local-users.mjs's teardown list exists to avoid: an
    // unchecked delete fails on the FK, the user survives, and the next
    // createUser reports `email_exists` — naming the one thing that is not
    // wrong.
    await asPlatform(db);
    await expect(
      db.exec(`delete from profiles where id = '${ADMIN_ID}'`),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it("counts eighteen columns referencing profiles(id), all NO ACTION", async () => {
    // Pinned so CLAUDE.md's count and the teardown list cannot drift from the
    // schema without something going red.
    await asPlatform(db);
    const refs = await rows<{ n: number }>(
      db,
      `select count(*)::int as n
         from pg_constraint c
         join pg_class t on t.oid = c.confrelid
        where c.contype = 'f' and t.relname = 'profiles'`,
    );
    expect(refs[0].n).toBe(18);

    const nonDefault = await rows<{ n: number }>(
      db,
      `select count(*)::int as n
         from pg_constraint c
         join pg_class t on t.oid = c.confrelid
        where c.contype = 'f' and t.relname = 'profiles'
          and (c.confdeltype <> 'a')`,
    );
    expect(nonDefault[0].n).toBe(0);
  });
});

describe("cascade", () => {
  it("removes a batch's rows when the batch goes", async () => {
    // on delete cascade, so tidying an abandoned batch cannot leave orphaned
    // staging rows behind.
    const batchId = await currentBatchId();
    await asPlatform(db);
    await db.exec(`delete from user_import_batches where id = ${batchId}`);

    const [remaining] = await rows<CountRow>(
      db,
      `select count(*)::int as n from user_import_rows where batch_id = ${batchId}`,
    );
    expect(remaining.n).toBe(0);
  });
});
