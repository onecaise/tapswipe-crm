import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_ID,
  AGENT_ID,
  PAYOUT_PERIOD,
  asPlatform,
  asUser,
  createTestDb,
  resetData,
  rows,
  seedPayouts,
  type PayoutFixtures,
  type TestDb,
} from "../helpers/db";

/**
 * guard_batch_status_transition() (20261016170000): a signed-in user may move
 * a residual import batch from review to abandoned, and nothing else. The
 * definer commits, the acknowledgement and the service role are unaffected.
 */

type DbError = { code?: string; message: string };

const STATUSES = ["review", "committed", "abandoned"] as const;
type Status = (typeof STATUSES)[number];

describe("rep_payout_batches status transitions", () => {
  let db: TestDb;
  let fx: PayoutFixtures;

  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await resetData(db);
    fx = await seedPayouts(db);
  });

  async function batchIn(status: Status): Promise<number> {
    await asPlatform(db);
    const [{ id }] = await rows<{ id: number }>(
      db,
      `insert into rep_payout_batches (imported_by, file_key, file_name, status)
       values ('${ADMIN_ID}', 't/x.xlsx', 'x.xlsx', '${status}') returning id`,
    );
    return id;
  }

  async function statusOf(id: number): Promise<string> {
    await asPlatform(db);
    const [{ status }] = await rows<{ status: string }>(db, `select status from rep_payout_batches where id = ${id}`);
    return status;
  }

  /** As a signed-in user, the way PostgREST runs a PATCH. Returns the row count. */
  async function patch(caller: string, id: number, to: string): Promise<{ count: number; error: DbError | null }> {
    await asUser(db, caller);
    try {
      const result = await rows<{ id: number }>(
        db,
        `update rep_payout_batches set status = '${to}' where id = ${id} returning id`,
      );
      return { count: result.length, error: null };
    } catch (error) {
      return { count: 0, error: error as DbError };
    } finally {
      await asPlatform(db);
    }
  }

  it("lets an admin abandon a batch in review", async () => {
    const id = await batchIn("review");
    expect(await patch(ADMIN_ID, id, "abandoned")).toEqual({ count: 1, error: null });
    expect(await statusOf(id)).toBe("abandoned");
  });

  const refused: [Status, Status][] = [];
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      if (!(from === "review" && to === "abandoned")) refused.push([from, to]);
    }
  }

  it.each(refused)("refuses an admin's %s -> %s, changing nothing", async (from, to) => {
    const id = await batchIn(from);
    const { error } = await patch(ADMIN_ID, id, to);
    expect(error?.code).toBe("PT409");
    expect(error?.message).toBe(
      `Only an import still in review can be changed here, and only to abandoned. This one is ${from}.`,
    );
    expect(await statusOf(id)).toBe(from);
  });

  it("gives an agent nothing to change: RLS filters the row before the trigger is reached", async () => {
    const id = await batchIn("review");
    expect(await patch(AGENT_ID, id, "abandoned")).toEqual({ count: 0, error: null });
    expect(await statusOf(id)).toBe("review");
  });

  it("leaves the definer commit free to flip review -> committed", async () => {
    await asPlatform(db);
    await db.exec(`delete from rep_payout_import_rows where batch_id = ${fx.batchIds.review} and blocker is not null`);
    await asUser(db, ADMIN_ID);
    await db.query(`select commit_residual_import_v2(${fx.batchIds.review})`);
    expect(await statusOf(fx.batchIds.review)).toBe("committed");
  });

  it("leaves the acknowledgement free to stamp a committed batch", async () => {
    await asPlatform(db);
    const [{ id }] = await rows<{ id: number }>(
      db,
      `insert into rep_payout_batches (imported_by, file_key, file_name, status, skipped_rows, committed_at)
       values ('${ADMIN_ID}', 't/y.xlsx', 'y.xlsx', 'committed',
               '[{"row_number": 2, "period": "${PAYOUT_PERIOD}", "mid": "M", "agent_number": "1", "reason": "partner_named"}]', now())
       returning id`,
    );
    await asUser(db, ADMIN_ID);
    await db.query(`select acknowledge_residual_skips(${id})`);
    await asPlatform(db);
    const [{ ack }] = await rows<{ ack: string | null }>(
      db,
      `select skips_acknowledged_at::text as ack from rep_payout_batches where id = ${id}`,
    );
    expect(ack).not.toBeNull();
  });

  // The service role is the other unguarded writer (parse-residual-import's
  // row_count update, residual-import-file-url's status). PGlite's shim gives
  // service_role no RLS bypass, so it is exercised where it is real: every
  // parse in tests/live/residual-import.test.ts updates a batch as that role.
  it("leaves the owner free to write any status", async () => {
    const id = await batchIn("committed");
    await asPlatform(db);
    await db.exec(`update rep_payout_batches set status = 'review' where id = ${id}`);
    expect(await statusOf(id)).toBe("review");
    await db.exec(`update rep_payout_batches set status = 'committed' where id = ${id}`);
    expect(await statusOf(id)).toBe("committed");
  });

  it("is a security-invoker trigger function nobody can call, firing before every update", async () => {
    await asPlatform(db);
    const [fn] = await rows<{ prosecdef: boolean; acl: string | null }>(
      db,
      `select prosecdef, proacl::text as acl from pg_proc where proname = 'guard_batch_status_transition'`,
    );
    expect(fn.prosecdef).toBe(false);
    expect(fn.acl ?? "").not.toMatch(/(^|[{,])=X/);
    const [{ def }] = await rows<{ def: string }>(
      db,
      `select pg_get_triggerdef(oid) as def from pg_trigger where tgname = 'rep_payout_batches_status_transition'`,
    );
    expect(def).toBe(
      "CREATE TRIGGER rep_payout_batches_status_transition BEFORE UPDATE ON public.rep_payout_batches FOR EACH ROW EXECUTE FUNCTION guard_batch_status_transition()",
    );
  });
});
