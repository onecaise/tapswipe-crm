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
import { makeSubmittable } from "../helpers/pre-app-submittable";

/**
 * Phase 5 (docs/design/intake-and-reports.md §1.E): "Reps cannot edit pre-app
 * data after it is submitted; admins can edit a pre-app through the existing
 * admin paths." The memo says no rule change is needed and a test pins the
 * rule as it stands. This file is that pin, for the parts no other file
 * covered at every status:
 *
 *   - the PARENT row (pre_apps): the rep's UPDATE and DELETE on a submitted,
 *     approved and declined pre-app (pre_app-state-machine covers submitted
 *     only), and the admin's edit at each of those statuses;
 *   - the children on an approved and a declined pre-app for the ADMIN
 *     (pre-app-children-draft-only covers the admin on submitted only);
 *   - the four *_secrets tables, which no client role can touch at any status
 *     (the zero-grant lock), so the rep's only write path to a secret is
 *     submit-pre-app-secrets, whose 409 after submit is pinned in
 *     tests/live/pre-app-secrets.test.ts.
 *
 * The rep's child writes at every status are in
 * tests/rls/pre-app-children-draft-only.test.ts and are not repeated here.
 */

type DbError = { code?: string; message: string };

async function attempt(sql: string): Promise<{ n: number; error: DbError | null }> {
  try {
    const result = await db.query(sql);
    return { n: result.affectedRows ?? 0, error: null };
  } catch (error) {
    return { n: 0, error: error as DbError };
  }
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

/** The agent's seeded draft, made complete and submitted by the rep through the RPC. */
async function submitted(): Promise<number> {
  await asPlatform(db);
  const [{ id }] = await rows<{ id: number }>(db, `select id from pre_apps where dba_name = 'Agent Draft App'`);
  await makeSubmittable(db, id, { keepOwners: true });
  await asUser(db, AGENT_ID);
  await db.query(`select submit_pre_app(${id})`);
  await asPlatform(db);
  return id;
}

async function atStatus(status: "submitted" | "approved" | "declined"): Promise<number> {
  const id = await submitted();
  if (status === "approved") {
    await asUser(db, ADMIN_ID);
    await db.query(`select approve_pre_app(${id})`);
  } else if (status === "declined") {
    await asUser(db, ADMIN_ID);
    await db.query(`select decline_pre_app(${id}, 'Need a voided check')`);
  }
  await asPlatform(db);
  return id;
}

async function parentRow(id: number): Promise<string> {
  await asPlatform(db);
  const [{ s }] = await rows<{ s: string }>(db, `select to_jsonb(p)::text as s from pre_apps p where id = ${id}`);
  return s;
}

const STATUSES = ["submitted", "approved", "declined"] as const;

describe("a rep cannot change the parent row once it has left draft", () => {
  for (const status of STATUSES) {
    it(`refuses the rep's UPDATE on a ${status} pre-app, and changes nothing`, async () => {
      const id = await atStatus(status);
      const before = await parentRow(id);
      for (const set of [
        `dba_name = 'Rewritten'`,
        `bank_name = 'Other Bank'`,
        `ein_type = 'SSN'`,
        `est_annual_volume = 1`,
      ]) {
        await asUser(db, AGENT_ID);
        const r = await attempt(`update pre_apps set ${set} where id = ${id}`);
        expect(r.error, `${status}: ${set}`).not.toBeNull();
        expect(r.error?.message, `${status}: ${set}`).toMatch(new RegExp(`^an? ${status} pre-app can only be edited by an admin`));
      }
      expect(await parentRow(id)).toBe(before);
    });

    it(`refuses the rep's DELETE on a ${status} pre-app (deletes are admin-only)`, async () => {
      const id = await atStatus(status);
      await asUser(db, AGENT_ID);
      const r = await attempt(`delete from pre_apps where id = ${id}`);
      expect(r.n).toBe(0);
      await asPlatform(db);
      expect(await rows(db, `select id from pre_apps where id = ${id}`)).toHaveLength(1);
    });
  }

  it("still lets the rep edit their own draft (the rule's other half)", async () => {
    await asPlatform(db);
    const [{ id }] = await rows<{ id: number }>(db, `select id from pre_apps where dba_name = 'Agent Draft App'`);
    await asUser(db, AGENT_ID);
    const r = await attempt(`update pre_apps set bank_name = 'Draft Bank' where id = ${id}`);
    expect(r.error).toBeNull();
    expect(r.n).toBe(1);
  });
});

describe("an admin edits a pre-app at any status, through the ordinary paths", () => {
  for (const status of STATUSES) {
    it(`lets an admin change the parent's columns on a ${status} pre-app`, async () => {
      const id = await atStatus(status);
      await asUser(db, ADMIN_ID);
      const r = await attempt(`update pre_apps set bank_name = 'Corrected Bank', fax_number = '615-555-0199' where id = ${id}`);
      expect(r.error).toBeNull();
      expect(r.n).toBe(1);
      await asPlatform(db);
      const [row] = await rows<{ bank_name: string; status: string }>(db, `select bank_name, status from pre_apps where id = ${id}`);
      expect(row).toEqual({ bank_name: "Corrected Bank", status });
    });

    it(`lets an admin change every child on a ${status} pre-app`, async () => {
      const id = await atStatus(status);
      for (const sql of [
        `update pre_app_owners set title = 'Managing member' where pre_app_id = ${id}`,
        `update pre_app_terminal set terminal_type = 'Corrected' where pre_app_id = ${id}`,
        `update pre_app_business_profile set notes = 'admin note' where pre_app_id = ${id}`,
      ]) {
        await asUser(db, ADMIN_ID);
        const r = await attempt(sql);
        expect(r.error, sql).toBeNull();
        expect(r.n, sql).toBeGreaterThan(0);
      }
    });

    it(`still refuses even an admin a direct status change on a ${status} pre-app`, async () => {
      const id = await atStatus(status);
      await asUser(db, ADMIN_ID);
      const r = await attempt(`update pre_apps set status = 'draft' where id = ${id}`);
      expect(r.error).not.toBeNull();
      await asPlatform(db);
      const [row] = await rows<{ status: string }>(db, `select status from pre_apps where id = ${id}`);
      expect(row.status).toBe(status);
    });
  }
});

describe("the secrets tables take no client write at any status", () => {
  const TABLES = [
    "pre_app_owner_secrets",
    "pre_app_banking_secrets",
    "pre_app_terminal_secrets",
    "pre_app_tax_secrets",
  ] as const;

  for (const table of TABLES) {
    it(`refuses ${table} to the rep and the admin alike, read or write (42501)`, async () => {
      await submitted();
      for (const caller of [AGENT_ID, ADMIN_ID]) {
        await asUser(db, caller);
        const read = await attempt(`select * from ${table}`);
        expect(read.error?.code, `${caller} select`).toBe("42501");
        await asUser(db, caller);
        const del = await attempt(`delete from ${table}`);
        expect(del.error?.code, `${caller} delete`).toBe("42501");
      }
    });
  }
});
