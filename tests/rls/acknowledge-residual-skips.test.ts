import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_ID,
  AGENT_ID,
  OTHER_AGENT_ID,
  PAYOUT_PERIOD,
  asPlatform,
  asUser,
  createTestDb,
  migrationsBefore,
  migrationsThrough,
  resetData,
  rows,
  seedPayouts,
  type PayoutFixtures,
  type TestDb,
} from "../helpers/db";

/**
 * 20261016140000 (phase 4b of docs/design/residual-splits.md, the database
 * part): acknowledge_residual_skips(), authenticated's UPDATE on
 * rep_payout_batches narrowed to (status), and the preview-flag columns on the
 * staging rows.
 *
 * What this file pins:
 *
 *   1. The acknowledgement: sets skips_acknowledged_at once, writes one audit
 *      row naming the admin, and refuses a second time, a batch with nothing
 *      skipped, a batch not yet committed, and a missing one -- writing
 *      nothing on any refusal. Its audit insert fails closed.
 *   2. Who may call it: an agent and a deactivated admin are refused, with the
 *      same answer for a real batch and a missing one (no id oracle).
 *   3. Catalog: definer, search_path pinned, guard first, batch locked,
 *      EXECUTE to authenticated and service_role only.
 *   4. The grant: the catalog changes in exactly the way intended; an admin's
 *      session can still abandon a batch and can no longer PATCH the skip
 *      record; no rep can read a batch's skip record before or after review.
 *   5. The staging columns' vocabulary.
 */

const MIGRATION = "20261016140000_residual_skips_and_preview_flags.sql";
const ACK = "acknowledge_residual_skips";

const PARTNER_ID = "55555555-5555-5555-5555-555555555555";
const PARTNER_NUMBER = "5555";

type DbError = { code?: string; message: string };

async function attempt(fn: () => Promise<unknown>): Promise<DbError | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error as DbError;
  }
}

async function count(db: TestDb, sql: string): Promise<number> {
  await asPlatform(db);
  const [{ n }] = await rows<{ n: number }>(db, `select (${sql})::int as n`);
  return n;
}

async function addPartner(db: TestDb): Promise<void> {
  await asPlatform(db);
  await db.exec(`
    insert into auth.users (id, email) values ('${PARTNER_ID}', 'partner@tapswipe.test');
    insert into profiles (id, full_name, role, is_active, agent_number)
    values ('${PARTNER_ID}', 'Partner Agent', 'agent', true, '${PARTNER_NUMBER}');
  `);
}

/** A review batch of one row on MID-AGENT-2 for `agentId`. */
async function stageOne(db: TestDb, agentId: string, agentNumber: string): Promise<number> {
  await asPlatform(db);
  const [{ id }] = await rows<{ id: number }>(
    db,
    `insert into rep_payout_batches (imported_by, file_key, file_name, status)
     values ('${ADMIN_ID}', 'test/file.xlsx', 'file.xlsx', 'review') returning id`,
  );
  await db.exec(`
    insert into rep_payout_import_rows
      (batch_id, row_number, agent_number_raw, mid_raw, merchant_name_raw,
       period, agent_id, merchant_id, volume)
    values (${id}, 2, '${agentNumber}', 'MID-AGENT-2', 'Shared Co',
            '${PAYOUT_PERIOD}', '${agentId}',
            (select id from merchants where mid = 'MID-AGENT-2'), 100.00);
  `);
  return id;
}

async function commitV2(db: TestDb, batchId: number): Promise<{ written: number; skipped: number }> {
  await asUser(db, ADMIN_ID);
  const [{ result }] = await rows<{ result: { written: number; skipped: number } }>(
    db,
    `select commit_residual_import_v2(${batchId}) as result`,
  );
  await asPlatform(db);
  return result;
}

async function acknowledge(db: TestDb, caller: string | null, batchId: number): Promise<string> {
  await asUser(db, caller);
  try {
    const [{ stamp }] = await rows<{ stamp: string }>(db, `select ${ACK}(${batchId}) as stamp`);
    return stamp;
  } finally {
    await asPlatform(db);
  }
}

type BatchState = { status: string; skipped: number; acknowledged: string | null };

async function batchState(db: TestDb, batchId: number): Promise<BatchState> {
  await asPlatform(db);
  const [row] = await rows<BatchState>(
    db,
    `select status, jsonb_array_length(skipped_rows) as skipped,
            skips_acknowledged_at::text as acknowledged
       from rep_payout_batches where id = ${batchId}`,
  );
  return row;
}

const ackAudits = (db: TestDb) =>
  count(db, `select count(*) from audit_log where action = '${ACK}'`);

/**
 * A committed batch with one skipped row: the partner named on a shared MID
 * and month (v2's partner_named), plus a committed batch that skipped nothing.
 */
async function scenario(db: TestDb): Promise<{ skippedBatch: number; cleanBatch: number; fx: PayoutFixtures }> {
  await resetData(db);
  const fx = await seedPayouts(db);
  await addPartner(db);
  await asUser(db, ADMIN_ID);
  await db.query(
    `select set_merchant_rep_share((select id from merchants where mid = 'MID-AGENT-2'),
       '${AGENT_ID}', '${PARTNER_ID}', 40, 10, '${PAYOUT_PERIOD}')`,
  );
  await asPlatform(db);

  const skippedBatch = await stageOne(db, PARTNER_ID, PARTNER_NUMBER);
  expect(await commitV2(db, skippedBatch)).toEqual({ written: 0, skipped: 1 });

  const cleanBatch = await stageOne(db, OTHER_AGENT_ID, "9902");
  // MID-AGENT-2 under a third rep: share_not_applied, imported as ordinary.
  expect(await commitV2(db, cleanBatch)).toEqual({ written: 1, skipped: 0 });

  await db.exec(`delete from audit_log`);
  return { skippedBatch, cleanBatch, fx };
}

// -------------------------------------------------------------------------
// 1 and 2. The acknowledgement and who may make it.
// -------------------------------------------------------------------------

describe(`${ACK}()`, () => {
  let db: TestDb;
  let skippedBatch: number;
  let cleanBatch: number;
  let fx: PayoutFixtures;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    ({ skippedBatch, cleanBatch, fx } = await scenario(db));
  });

  it("records the review once: timestamp, one audit row naming the admin", async () => {
    expect((await batchState(db, skippedBatch)).acknowledged).toBeNull();

    const stamp = await acknowledge(db, ADMIN_ID, skippedBatch);
    expect(stamp).not.toBeNull();

    const state = await batchState(db, skippedBatch);
    expect(state.acknowledged).not.toBeNull();
    expect(new Date(state.acknowledged!).getTime()).toBe(new Date(stamp).getTime());
    // The skip record itself is untouched: reviewed, not cleared.
    expect(state.skipped).toBe(1);

    const audit = await rows<{ actor_id: string; table_name: string; row_id: string }>(
      db,
      `select actor_id, table_name, row_id from audit_log where action = '${ACK}'`,
    );
    expect(audit).toEqual([
      { actor_id: ADMIN_ID, table_name: "rep_payout_batches", row_id: String(skippedBatch) },
    ]);
  });

  it("refuses a second acknowledgement, and moves nothing", async () => {
    await acknowledge(db, ADMIN_ID, skippedBatch);
    const first = await batchState(db, skippedBatch);

    const error = await attempt(() => acknowledge(db, ADMIN_ID, skippedBatch));
    expect(error?.code).toBe("PT409");
    expect(error?.message).toBe("these skipped rows have already been reviewed");

    expect(await batchState(db, skippedBatch)).toEqual(first);
    expect(await ackAudits(db)).toBe(1);
  });

  it("refuses a committed batch that skipped nothing", async () => {
    const error = await attempt(() => acknowledge(db, ADMIN_ID, cleanBatch));
    expect(error?.code).toBe("PT409");
    expect(error?.message).toBe("this import skipped no rows");
    expect((await batchState(db, cleanBatch)).acknowledged).toBeNull();
    expect(await ackAudits(db)).toBe(0);
  });

  it("refuses a batch still in review, and an abandoned one", async () => {
    const review = await stageOne(db, PARTNER_ID, PARTNER_NUMBER);
    const reviewError = await attempt(() => acknowledge(db, ADMIN_ID, review));
    expect(reviewError?.code).toBe("PT409");
    expect(reviewError?.message).toBe("this import is review, so nothing has been skipped yet");

    // Even a batch carrying a skip record (set by hand here) is refused unless
    // committed: the status check comes first.
    await db.exec(
      `update rep_payout_batches
          set status = 'abandoned', skipped_rows = '[{"row_number": 2}]'
        where id = ${review}`,
    );
    const abandoned = await attempt(() => acknowledge(db, ADMIN_ID, review));
    expect(abandoned?.message).toBe("this import is abandoned, so nothing has been skipped yet");
    expect(await ackAudits(db)).toBe(0);
  });

  it("answers PT404 for a missing batch", async () => {
    const error = await attempt(() => acknowledge(db, ADMIN_ID, 999_999));
    expect(error?.code).toBe("PT404");
    expect(error?.message).toBe("import not found");
  });

  it("refuses every agent, including the rep the skip names, and writes nothing", async () => {
    for (const rep of [AGENT_ID, PARTNER_ID, OTHER_AGENT_ID]) {
      const error = await attempt(() => acknowledge(db, rep, skippedBatch));
      expect(error?.code, rep).toBe("PT403");
      expect(error?.message, rep).toBe("admin only");
    }
    expect((await batchState(db, skippedBatch)).acknowledged).toBeNull();
    expect(await ackAudits(db)).toBe(0);
  });

  it("answers an agent identically for a real batch and a missing one (no id oracle)", async () => {
    const real = await attempt(() => acknowledge(db, AGENT_ID, skippedBatch));
    const missing = await attempt(() => acknowledge(db, AGENT_ID, 999_999));
    const review = await attempt(() => acknowledge(db, AGENT_ID, fx.batchIds.review));
    expect(real?.message).toBe("admin only");
    // The guard runs before the batch is read, so every id gets one answer.
    for (const other of [missing, review]) {
      expect(other?.message).toBe(real?.message);
      expect(other?.code).toBe(real?.code);
    }
  });

  it("refuses a deactivated admin, and an anonymous caller", async () => {
    await db.exec(`update profiles set is_active = false where id = '${ADMIN_ID}'`);
    try {
      expect((await attempt(() => acknowledge(db, ADMIN_ID, skippedBatch)))?.message).toBe("admin only");
    } finally {
      await db.exec(`update profiles set is_active = true where id = '${ADMIN_ID}'`);
    }
    expect((await attempt(() => acknowledge(db, null, skippedBatch)))?.message).toBe("admin only");
    expect((await batchState(db, skippedBatch)).acknowledged).toBeNull();
  });

  it("fails closed: if the audit row cannot be written, the acknowledgement is not recorded", async () => {
    await db.exec(`
      create function pg_temp.refuse_ack() returns trigger language plpgsql as $$
      begin
        if new.action = '${ACK}' then raise exception 'audit refused'; end if;
        return new;
      end $$;
      create trigger refuse_ack before insert on audit_log
        for each row execute function pg_temp.refuse_ack();
    `);
    try {
      const error = await attempt(() => acknowledge(db, ADMIN_ID, skippedBatch));
      expect(error?.message).toBe("audit refused");
      expect((await batchState(db, skippedBatch)).acknowledged).toBeNull();
    } finally {
      await db.exec(`drop trigger refuse_ack on audit_log`);
    }
    // And with the audit path back, it works: the refusal above was the trigger.
    await acknowledge(db, ADMIN_ID, skippedBatch);
    expect(await ackAudits(db)).toBe(1);
  });
});

// -------------------------------------------------------------------------
// 3. Catalog.
// -------------------------------------------------------------------------

describe("catalog", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("is security definer, search_path pinned, guarded first, batch locked, one overload", async () => {
    await asPlatform(db);
    const [fn] = await rows<{ prosecdef: boolean; proconfig: string[] | null; body: string; ret: string; acl: string | null }>(
      db,
      `select p.prosecdef, p.proconfig, p.prosrc as body,
              pg_get_function_result(p.oid) as ret, p.proacl::text as acl
         from pg_proc p where p.oid = 'public.${ACK}(int)'::regprocedure`,
    );
    expect(fn.prosecdef).toBe(true);
    expect(fn.proconfig).toContain("search_path=public");
    expect(fn.body.trimStart()).toMatch(/^declare[\s\S]*?begin\s+if not is_admin\(\) then/);
    expect(fn.body).toMatch(/from rep_payout_batches where id = batch_id_input for update/);
    // Fails closed: no exception block anywhere in the body.
    expect(fn.body).not.toMatch(/\bexception\s+when\b/i);
    expect(fn.ret).toBe("timestamp with time zone");
    expect(await count(db, `select count(*) from pg_proc where proname = '${ACK}'`)).toBe(1);
    // No PUBLIC entry in the ACL: "=X/..." is how PUBLIC's EXECUTE prints.
    expect(fn.acl).not.toBeNull();
    expect(fn.acl).not.toMatch(/(^|[{,])=X/);
  });

  it("is executable by authenticated and service_role only", async () => {
    for (const [role, ok] of [
      ["authenticated", 1],
      ["service_role", 1],
      ["anon", 0],
    ] as const) {
      expect(
        await count(db, `select has_function_privilege('${role}', 'public.${ACK}(int)', 'execute')::int`),
        role,
      ).toBe(ok);
    }
  });

  it("the old commit's guard no longer tells anyone to reload the page", async () => {
    await asPlatform(db);
    const [{ body }] = await rows<{ body: string }>(
      db,
      `select prosrc as body from pg_proc where oid = 'public.commit_residual_import(int)'::regprocedure`,
    );
    expect(body).toContain(
      "This import contains shared accounts, which this version of the CRM cannot commit.",
    );
    expect(body.toLowerCase()).not.toContain("reload");
  });
});

// -------------------------------------------------------------------------
// 4. The batch UPDATE grant.
// -------------------------------------------------------------------------

type Privilege = { grantee: string; column_name?: string; privilege_type: string; is_grantable: string };

async function batchPrivileges(db: TestDb, view: "column_privileges" | "table_privileges"): Promise<string[]> {
  await asPlatform(db);
  const columns = view === "column_privileges" ? "grantee, column_name, privilege_type, is_grantable" : "grantee, privilege_type, is_grantable";
  const list = await rows<Privilege>(
    db,
    `select ${columns} from information_schema.${view}
      where table_schema = 'public' and table_name = 'rep_payout_batches'
      order by 1, 2, 3`,
  );
  return list.map((p) => [p.grantee, p.column_name ?? "", p.privilege_type, p.is_grantable].join("|"));
}

describe("the rep_payout_batches privilege catalog, before and after", () => {
  let before: TestDb;
  let after: TestDb;

  beforeAll(async () => {
    before = await createTestDb(await migrationsBefore(MIGRATION));
    after = await createTestDb(await migrationsThrough(MIGRATION));
  });
  afterAll(async () => {
    await Promise.all([before.close(), after.close()]);
  });

  it("column privileges: authenticated's UPDATE goes from every column but status; nothing is added", async () => {
    const was = await batchPrivileges(before, "column_privileges");
    const is = await batchPrivileges(after, "column_privileges");

    const names = await rows<{ name: string }>(
      after,
      `select attname as name from pg_attribute
        where attrelid = 'rep_payout_batches'::regclass and attnum > 0 and not attisdropped`,
    );
    const expectedRemoved = names
      .map((c) => c.name)
      .filter((name) => name !== "status")
      .map((name) => `authenticated|${name}|UPDATE|NO`)
      .sort();

    // Non-vacuous: before, authenticated could PATCH the skip record.
    expect(was).toContain("authenticated|skipped_rows|UPDATE|NO");
    expect(was).toContain("authenticated|skips_acknowledged_at|UPDATE|NO");
    expect(expectedRemoved.every((k) => was.includes(k))).toBe(true);

    expect(was.filter((k) => !is.includes(k)).sort()).toEqual(expectedRemoved);
    expect(is.filter((k) => !was.includes(k))).toEqual([]);
    expect(is).toContain("authenticated|status|UPDATE|NO");
  });

  it("table privileges: only authenticated's table-level UPDATE goes", async () => {
    const was = await batchPrivileges(before, "table_privileges");
    const is = await batchPrivileges(after, "table_privileges");
    expect(was.filter((k) => !is.includes(k))).toEqual(["authenticated||UPDATE|NO"]);
    expect(is.filter((k) => !was.includes(k))).toEqual([]);
    expect(is.filter((k) => k.startsWith("anon|"))).toEqual([]);
  });
});

describe("through a signed-in session", () => {
  let db: TestDb;
  let skippedBatch: number;
  let fx: PayoutFixtures;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    ({ skippedBatch, fx } = await scenario(db));
  });

  it("an admin still abandons a batch: lib/residual-batches.ts's exact statement", async () => {
    await asUser(db, ADMIN_ID);
    await db.query(`update rep_payout_batches set status = 'abandoned' where id = ${fx.batchIds.review}`);
    expect((await batchState(db, fx.batchIds.review)).status).toBe("abandoned");
  });

  it.each([
    ["skipped_rows", `'[]'::jsonb`],
    ["skips_acknowledged_at", "now()"],
    ["row_count", "0"],
    ["committed_at", "null"],
  ])("an admin's session cannot write %s", async (column, value) => {
    await asUser(db, ADMIN_ID);
    const error = await attempt(() =>
      db.query(`update rep_payout_batches set ${column} = ${value} where id = ${skippedBatch}`),
    );
    expect(error?.code).toBe("42501");
    expect(error?.message).toMatch(/permission denied/);
    const state = await batchState(db, skippedBatch);
    expect(state.skipped).toBe(1);
    expect(state.acknowledged).toBeNull();
  });

  it("refuses the column even when status rides along", async () => {
    await asUser(db, ADMIN_ID);
    const error = await attempt(() =>
      db.query(`update rep_payout_batches set status = 'committed', skipped_rows = '[]' where id = ${skippedBatch}`),
    );
    expect(error?.code).toBe("42501");
    expect((await batchState(db, skippedBatch)).skipped).toBe(1);
  });

  it("no rep can read a batch's skip record, before or after review", async () => {
    const look = async () => {
      for (const rep of [AGENT_ID, PARTNER_ID, OTHER_AGENT_ID]) {
        await asUser(db, rep);
        expect(await rows(db, `select skipped_rows, skips_acknowledged_at from rep_payout_batches`), rep).toEqual([]);
        // Nor who reviewed it: audit_log is admin-only.
        expect(await rows(db, `select id from audit_log where action = '${ACK}'`), rep).toEqual([]);
      }
      await asPlatform(db);
    };
    await look();
    await acknowledge(db, ADMIN_ID, skippedBatch);
    await look();

    // Not vacuous: the admin reads both.
    await asUser(db, ADMIN_ID);
    expect(await rows(db, `select id from rep_payout_batches where id = ${skippedBatch} and skips_acknowledged_at is not null`)).toHaveLength(1);
    expect(await rows(db, `select id from audit_log where action = '${ACK}'`)).toHaveLength(1);
    await asPlatform(db);
  });

  it("a rep's status write reaches no batch", async () => {
    await asUser(db, AGENT_ID);
    await db.query(`update rep_payout_batches set status = 'abandoned'`);
    await asPlatform(db);
    expect((await batchState(db, fx.batchIds.review)).status).toBe("review");
  });
});

// -------------------------------------------------------------------------
// 5. The staging columns.
// -------------------------------------------------------------------------

describe("rep_payout_import_rows preview columns", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
    await resetData(db);
    await seedPayouts(db);
  });
  afterAll(async () => {
    await db.close();
  });

  it("accept the three codes and null, and refuse anything else", async () => {
    await asPlatform(db);
    for (const flag of ["share_not_applied", "partner_named", "line_not_shared"]) {
      await db.query(`update rep_payout_import_rows set preview_flag = '${flag}', preview_note = 'x'`);
    }
    await db.query(`update rep_payout_import_rows set preview_flag = null, preview_note = null`);
    const error = await attempt(() => db.query(`update rep_payout_import_rows set preview_flag = 'looks_shared'`));
    expect(error?.message).toMatch(/preview_flag_check/);
  });

  it("are readable by an admin and by no rep", async () => {
    await asUser(db, ADMIN_ID);
    expect((await rows(db, `select preview_flag, preview_note from rep_payout_import_rows`)).length).toBeGreaterThan(0);
    await asUser(db, AGENT_ID);
    expect(await rows(db, `select preview_flag from rep_payout_import_rows`)).toEqual([]);
    await asPlatform(db);
  });
});
