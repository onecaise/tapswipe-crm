import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_ID,
  AGENT_ID,
  OTHER_AGENT_ID,
  PAYOUT_PERIOD,
  asPlatform,
  asUser,
  createTestDb,
  readMigration,
  resetData,
  rows,
  seedPayouts,
  type TestDb,
} from "../helpers/db";

/**
 * share_correction_posting_period() (20261019130000): the month a share
 * correction would post into, shown to the admin BEFORE they confirm.
 *
 * The claim worth testing is that the preview and the post agree, always.
 * They share one function -- post_share_correction() calls this one -- so the
 * agreement is structural; the tests below hold it to that across the states
 * that move the answer (a later month committed, adjustments posted, an empty
 * ledger), and check that the post refuses a month the admin did not confirm.
 */

const PARTNER_ID = "55555555-5555-5555-5555-555555555555";
const AUG = "2026-08-01";
const SEP = "2026-09-01";

type DbError = { code?: string; message: string };

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await resetData(db);
  await seedPayouts(db);
  await asPlatform(db);
  await db.exec(`
    insert into auth.users (id, email) values ('${PARTNER_ID}', 'partner@tapswipe.test');
    insert into profiles (id, full_name, role, is_active)
      values ('${PARTNER_ID}', 'Partner Agent', 'agent', true);
    delete from audit_log;
  `);
});

async function preview(caller: string | null = ADMIN_ID): Promise<string | null> {
  await asUser(db, caller);
  try {
    const [{ month }] = await rows<{ month: string | null }>(
      db,
      `select share_correction_posting_period()::text as month`,
    );
    return month;
  } finally {
    await asPlatform(db);
  }
}

async function attempt(caller: string | null, sql: string): Promise<DbError | null> {
  await asUser(db, caller);
  try {
    await db.query(sql);
    return null;
  } catch (error) {
    return error as DbError;
  } finally {
    await asPlatform(db);
  }
}

async function post(mid: string, expected?: string): Promise<string> {
  await asUser(db, ADMIN_ID);
  try {
    const [{ r }] = await rows<{ r: { posting_period: string } }>(
      db,
      `select post_share_correction((select id from merchants where mid = '${mid}'),
         '${PAYOUT_PERIOD}', '${PARTNER_ID}', 40, 10, 'agreed late',
         ${expected ? `'${expected}'` : "null"}) as r`,
    );
    return r.posting_period;
  } finally {
    await asPlatform(db);
  }
}

describe("the preview is the post", () => {
  it("is the month after the latest import line: July committed, so August", async () => {
    expect(await preview()).toBe(AUG);
  });

  it("agrees with what post_share_correction then does", async () => {
    const shown = await preview();
    expect(await post("MID-AGENT-1", shown!)).toBe(shown);
  });

  it("does not move for adjustment lines: posting one leaves August open", async () => {
    await post("MID-AGENT-1");
    expect(await preview()).toBe(AUG);
    expect(await post("MID-OTHER-1", AUG)).toBe(AUG);
  });

  it("moves when any rep's later month is committed, and the post moves with it", async () => {
    await db.exec(`
      insert into rep_payout_rows (agent_id, period, mid, merchant_name)
      values ('${OTHER_AGENT_ID}', '${AUG}', 'MID-ELSEWHERE', 'Elsewhere');
    `);
    expect(await preview()).toBe(SEP);
    expect(await post("MID-AGENT-1")).toBe(SEP);
  });

  it("is null on a ledger with no import line", async () => {
    await db.exec(`delete from rep_payout_rows`);
    expect(await preview()).toBeNull();
  });
});

describe("the confirmation holds", () => {
  it("refuses, writing nothing, when a commit lands between the preview and the post", async () => {
    const shown = await preview();
    await db.exec(`
      insert into rep_payout_rows (agent_id, period, mid, merchant_name)
      values ('${OTHER_AGENT_ID}', '${AUG}', 'MID-ELSEWHERE', 'Elsewhere');
    `);
    const error = await attempt(
      ADMIN_ID,
      `select post_share_correction((select id from merchants where mid = 'MID-AGENT-1'),
         '${PAYOUT_PERIOD}', '${PARTNER_ID}', 40, 10, 'agreed late', '${shown}')`,
    );
    expect(error?.code).toBe("PT409");
    expect(error?.message).toBe(
      "A month was committed after this correction was reviewed, so it would now post to September 2026, not August 2026. Review it again.",
    );
    const [{ n }] = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from rep_payout_rows where line_kind = 'adjustment'`,
    );
    expect(n).toBe(0);
  });

  it("still refuses a second correction of the same month, by the sentence the page shows", async () => {
    await post("MID-AGENT-1", AUG);
    const error = await attempt(
      ADMIN_ID,
      `select post_share_correction((select id from merchants where mid = 'MID-AGENT-1'),
         '${PAYOUT_PERIOD}', '${PARTNER_ID}', 25, 25, 'again', '${AUG}')`,
    );
    expect(error?.code).toBe("PT409");
    expect(error?.message).toBe(
      "A correction for MID MID-AGENT-1, July 2026 has already been posted.",
    );
  });
});

describe("who may ask", () => {
  it("refuses an agent, PT403: under their own rows the answer would be a different month", async () => {
    expect((await attempt(AGENT_ID, `select share_correction_posting_period()`))?.code).toBe(
      "PT403",
    );
  });

  it("refuses a deactivated admin", async () => {
    await db.exec(`update profiles set is_active = false where id = '${ADMIN_ID}'`);
    expect((await attempt(ADMIN_ID, `select share_correction_posting_period()`))?.code).toBe(
      "PT403",
    );
  });

  it("is definer, stable, search_path pinned, guarded first; executable by authenticated and service_role only", async () => {
    const [f] = await rows<{
      prosecdef: boolean;
      provolatile: string;
      proconfig: string[];
      src: string;
    }>(
      db,
      `select prosecdef, provolatile, proconfig, prosrc as src from pg_proc
        where proname = 'share_correction_posting_period'`,
    );
    expect(f.prosecdef).toBe(true);
    expect(f.provolatile).toBe("s");
    expect(f.proconfig).toEqual(["search_path=public"]);
    expect(f.src.trimStart()).toMatch(/^begin\s+if not is_admin\(\) then\s+raise exception 'admin only'/);

    const grantees = await rows<{ role: string; ok: boolean }>(
      db,
      `select r as role,
              has_function_privilege(r, 'public.share_correction_posting_period()', 'execute') as ok
         from unnest(array['anon', 'authenticated', 'service_role']) r order by r`,
    );
    expect(grantees).toEqual([
      { role: "anon", ok: false },
      { role: "authenticated", ok: true },
      { role: "service_role", ok: true },
    ]);
  });

  it("revert check: without the guard an agent IS answered (so the refusal above is the guard's)", async () => {
    const text = await readMigration("20261019130000_share_correction_posting_period.sql");
    const start = text.indexOf("create or replace function share_correction_posting_period");
    const original = text.slice(start, text.indexOf("$$;", start) + 3);
    const guard =
      "  if not is_admin() then\n    raise exception 'admin only' using errcode = 'PT403';\n  end if;\n";
    expect(original.split(guard)).toHaveLength(2);
    await db.exec(original.replace(guard, ""));
    try {
      expect(await preview(AGENT_ID)).toBe(AUG);
    } finally {
      await asPlatform(db);
      await db.exec(original);
    }
    expect((await attempt(AGENT_ID, `select share_correction_posting_period()`))?.code).toBe(
      "PT403",
    );
  });
});
