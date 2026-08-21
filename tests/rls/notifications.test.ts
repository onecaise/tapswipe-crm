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
 * The topbar bell: one watermark column, one narrow RPC to advance it, and two
 * ordinary RLS-scoped reads.
 *
 * There is no notifications table, so there is no new policy surface to test.
 * What there is instead splits cleanly in two, and both halves matter:
 *
 *  - **mark_notifications_viewed() is `security definer`**, because profiles has
 *    no UPDATE policy for anyone. So it is privileged code, and the tests below
 *    pin what stops that mattering: it takes no arguments, writes only
 *    auth.uid()'s row, and refuses a deactivated caller.
 *  - **The panel's contents are plain selects**, so RLS is the whole
 *    authorization story. The scoping tests run the same `created_at > since`
 *    query the app issues, as `authenticated`, because that is the only way the
 *    policies are actually in play — Postgres bypasses RLS for a table's owner.
 */

/** The floor the app compares against, as mark_notifications_viewed returns it. */
const PAST = "2026-01-01T00:00:00Z";
const OLDER = "2025-06-01T00:00:00Z";

/**
 * The two queries lib/notifications.ts issues, as one union so a single
 * assertion can cover the merged list the panel renders.
 *
 * Written out here rather than imported because the app builds them through
 * supabase-js; this is the SQL PostgREST would produce, and running it under a
 * real role is what proves the policies apply to it.
 */
const feedQuery = (since: string) => `
  select 'support_ticket' as kind, id, subject as title, created_at
    from support_tickets
   where created_at > '${since}'
  union all
  select 'ghost_sheet' as kind, id, dba as title, created_at
    from ghost_sheets
   where created_at > '${since}'
   order by created_at desc, kind, id desc
`;

type FeedRow = { kind: string; id: number; title: string };
type WatermarkRow = { last_viewed_notifications_at: string | null };

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(async () => {
  await resetData(db);

  // The seed inserts everything at now(), which is useless for a
  // "created after" test. Push the fixtures onto a known timeline instead:
  // two rows in 2026 (new, after PAST) and the rest back in 2025 (old).
  await asPlatform(db);
  await db.exec(`
    update profiles set created_at = '2024-01-01T00:00:00Z';
    update support_tickets set created_at = '${OLDER}';
    update ghost_sheets set created_at = '${OLDER}';

    -- One new ticket and one new sheet for each of the two agents, so "mine"
    -- and "everyone's" are distinguishable in every assertion below.
    update support_tickets set created_at = '2026-03-01T00:00:00Z'
      where subject = 'Terminal will not batch';
    update support_tickets set created_at = '2026-03-02T00:00:00Z'
      where subject = 'Reprint receipts';
    update ghost_sheets set created_at = '2026-03-03T00:00:00Z'
      where dba = 'Agent Sheet Open';
    update ghost_sheets set created_at = '2026-03-04T00:00:00Z'
      where dba = 'Other Sheet Open';
  `);
});

afterAll(async () => {
  await db?.close();
});

const watermarkOf = async (userId: string): Promise<string | null> => {
  await asPlatform(db);
  const [row] = await rows<WatermarkRow>(
    db,
    `select last_viewed_notifications_at from profiles where id = '${userId}'`,
  );
  return row.last_viewed_notifications_at;
};

describe("mark_notifications_viewed", () => {
  it("returns the previous watermark and advances it to now", async () => {
    await asPlatform(db);
    await db.exec(
      `update profiles set last_viewed_notifications_at = '${PAST}'
        where id = '${AGENT_ID}';`,
    );

    await asUser(db, AGENT_ID);
    const [{ mark }] = await rows<{ mark: string }>(
      db,
      `select mark_notifications_viewed() as mark`,
    );

    // The OLD value, not now(). This is the whole reason the function exists:
    // `returning` on the UPDATE would yield the new row, and the panel would
    // report against a watermark of now() and always render empty.
    expect(new Date(mark).toISOString()).toBe(new Date(PAST).toISOString());

    const after = await watermarkOf(AGENT_ID);
    expect(new Date(after as string).getTime()).toBeGreaterThan(
      new Date(PAST).getTime(),
    );
  });

  it("falls back to the profile's created_at when never opened", async () => {
    // Null is a real state meaning "has never opened the panel". Falling back to
    // the epoch instead would dump the company's entire history into a first
    // click; falling back to now() would swallow whatever was genuinely new.
    expect(await watermarkOf(AGENT_ID)).toBeNull();

    await asUser(db, AGENT_ID);
    const [{ mark }] = await rows<{ mark: string }>(
      db,
      `select mark_notifications_viewed() as mark`,
    );

    expect(new Date(mark).toISOString()).toBe(
      new Date("2024-01-01T00:00:00Z").toISOString(),
    );
  });

  it("never hands out the same watermark twice", async () => {
    await asUser(db, AGENT_ID);
    const [first] = await rows<{ mark: string }>(
      db,
      `select mark_notifications_viewed() as mark`,
    );

    await asUser(db, AGENT_ID);
    const [second] = await rows<{ mark: string }>(
      db,
      `select mark_notifications_viewed() as mark`,
    );

    // The second call sees the first call's now(). This is what makes an item
    // impossible to report twice — and equally, it is why the client fetches
    // once per mount rather than once per open.
    expect(new Date(second.mark).getTime()).toBeGreaterThan(
      new Date(first.mark).getTime(),
    );
  });

  it("touches only the caller's own row", async () => {
    await asPlatform(db);
    await db.exec(
      `update profiles set last_viewed_notifications_at = '${PAST}'
        where id in ('${AGENT_ID}', '${OTHER_AGENT_ID}');`,
    );

    await asUser(db, AGENT_ID);
    await db.exec(`select mark_notifications_viewed();`);

    // It takes no arguments, so there is no way to name another user's row —
    // the ownership check is structural. This asserts the structure holds.
    const other = await watermarkOf(OTHER_AGENT_ID);
    expect(new Date(other as string).toISOString()).toBe(
      new Date(PAST).toISOString(),
    );
  });

  it("refuses a deactivated caller", async () => {
    await asPlatform(db);
    await db.exec(
      `update profiles set is_active = false where id = '${AGENT_ID}';`,
    );

    await asUser(db, AGENT_ID);
    await expect(
      db.exec(`select mark_notifications_viewed();`),
    ).rejects.toThrow(/deactivated/i);
  });

  it("is not executable by anon", async () => {
    // Postgres grants EXECUTE to PUBLIC on every new function and PUBLIC
    // includes anon. Without the revoke this is callable unauthenticated.
    await asPlatform(db);
    const [{ ok }] = await rows<{ ok: boolean }>(
      db,
      `select has_function_privilege('anon', 'mark_notifications_viewed()', 'execute') as ok`,
    );
    expect(ok).toBe(false);
  });

  it("is executable by authenticated, and is security definer", async () => {
    await asPlatform(db);
    const [row] = await rows<{ ok: boolean; prosecdef: boolean }>(
      db,
      `select has_function_privilege('authenticated', 'mark_notifications_viewed()', 'execute') as ok,
              (select prosecdef from pg_proc where proname = 'mark_notifications_viewed') as prosecdef`,
    );
    // Definer is REQUIRED here, unlike the read path: profiles has no UPDATE
    // policy at all, so an invoker function could not write the column.
    expect(row).toEqual({ ok: true, prosecdef: true });
  });

  it("did not add an UPDATE policy to profiles as a shortcut", async () => {
    // The forward constraint stated in the profiles block of the spec: a new
    // write to this table gets a narrow RPC, never a policy. Re-adding one
    // re-opens every guard in set_user_role(). manage-users.test.ts asserts this
    // too; it is repeated here because this migration is exactly the kind of
    // change that would be tempted to take the shortcut.
    await asPlatform(db);
    const [{ n }] = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from pg_policies
        where tablename = 'profiles' and cmd = 'UPDATE'`,
    );
    expect(n).toBe(0);
  });
});

describe("the notification feed is scoped by the caller's own RLS", () => {
  it("shows an agent only their own new records", async () => {
    await asUser(db, AGENT_ID);
    const feed = await rows<FeedRow>(db, feedQuery(PAST));

    // The other agent's ticket and sheet are newer than PAST too, so a query
    // that had lost its ownership scoping would visibly pick them up here.
    expect(feed.map((r) => r.title)).toEqual([
      "Agent Sheet Open",
      "Terminal will not batch",
    ]);
  });

  it("shows an admin every rep's new records", async () => {
    await asUser(db, ADMIN_ID);
    const feed = await rows<FeedRow>(db, feedQuery(PAST));

    // The admin seeing all four is what proves the agent's two above were
    // withheld by ownership rather than by the timestamp filter.
    expect(feed.map((r) => r.title)).toEqual([
      "Other Sheet Open",
      "Agent Sheet Open",
      "Reprint receipts",
      "Terminal will not batch",
    ]);
  });

  it("shows a deactivated agent nothing", async () => {
    await asPlatform(db);
    await db.exec(
      `update profiles set is_active = false where id = '${AGENT_ID}';`,
    );

    await asUser(db, AGENT_ID);
    // is_active_agent() is the half of every own-row branch that re-checks per
    // request, because a valid JWT proves identity and not that the account is
    // still enabled.
    expect(await rows<FeedRow>(db, feedQuery(PAST))).toHaveLength(0);
  });

  it("shows an unauthenticated caller nothing", async () => {
    await asUser(db, null);
    expect(await rows<FeedRow>(db, feedQuery(PAST))).toHaveLength(0);
  });

  it("excludes records older than the watermark", async () => {
    await asUser(db, AGENT_ID);
    // Everything the seed created sits at OLDER or in 2026, so a watermark just
    // after the 2026 rows leaves nothing new — this is the "nothing new since
    // you last looked" state, and it must be empty rather than falling back to
    // showing everything.
    expect(
      await rows<FeedRow>(db, feedQuery("2026-12-31T00:00:00Z")),
    ).toHaveLength(0);
  });

  it("includes both kinds, and keys them apart where ids collide", async () => {
    await asUser(db, ADMIN_ID);
    const feed = await rows<FeedRow>(db, feedQuery(OLDER));

    const kinds = new Set(feed.map((r) => r.kind));
    expect(kinds).toEqual(new Set(["support_ticket", "ghost_sheet"]));

    // Both id spaces start at 1, so a ticket and a sheet sharing an id is the
    // normal case rather than an edge one. notificationKey() prefixes the kind
    // for exactly this reason — a bare id would make dismissing one dismiss the
    // other. Asserted here so the collision is known to be real.
    const ticketIds = feed.filter((r) => r.kind === "support_ticket").map((r) => r.id);
    const sheetIds = feed.filter((r) => r.kind === "ghost_sheet").map((r) => r.id);
    expect(ticketIds.some((id) => sheetIds.includes(id))).toBe(true);
  });
});

describe("the feed scoping test is load-bearing", () => {
  it("would catch a fail-open select policy on either table", async () => {
    const broken = await createTestDb();
    await resetData(broken);
    await asPlatform(broken);
    await broken.exec(`
      update profiles set created_at = '2024-01-01T00:00:00Z';
      update support_tickets set created_at = '2026-03-01T00:00:00Z';
      update ghost_sheets set created_at = '2026-03-01T00:00:00Z';
      drop policy "select own or admin" on ghost_sheets;
      create policy "select own or admin" on ghost_sheets for select using (true);
    `);

    await asUser(broken, AGENT_ID);
    const feed = await rows<FeedRow>(broken, feedQuery(PAST));

    // The other agent's sheet leaking in is the disclosure this feed is one
    // careless change away from. Nothing in the feature's own code would notice
    // — which is why the read path is deliberately left as plain selects with no
    // function whose prosecdef could be flipped.
    expect(feed.map((r) => r.title)).toContain("Other Sheet Open");

    await broken.close();
  });
});
