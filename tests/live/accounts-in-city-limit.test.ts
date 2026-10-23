// accounts_in_city()'s rate limit under concurrency, over real HTTP.
//
// tests/rls/accounts-in-city-limits.test.ts pins the rule on PGlite, which has
// one connection and cannot race. The limit counts committed audit rows, so
// without the per-caller advisory lock, concurrent calls at 29 would each see
// 29 and all pass. Here forty calls go out at once from one rep; exactly thirty
// may answer.
//
// Needs `supabase start` but NOT `functions serve` — PostgREST and RPC only.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  adminClient,
  provisionFixtures,
  teardownFixtures,
  userClient,
  type Fixtures,
} from "./helpers/stack";

const LIMIT = 30;
let fx: Fixtures;

async function clearCitySearches(): Promise<void> {
  const { error } = await adminClient().from("audit_log").delete().like("action", "accounts_in_city:%");
  if (error) throw error;
}

async function citySearchRows(actor: string): Promise<number> {
  const { count, error } = await adminClient()
    .from("audit_log")
    .select("id", { count: "exact", head: true })
    .eq("actor_id", actor)
    .like("action", "accounts_in_city:%");
  if (error) throw error;
  return count ?? 0;
}

beforeAll(async () => {
  fx = await provisionFixtures();
});

beforeEach(clearCitySearches);

afterAll(async () => {
  await clearCitySearches();
  await teardownFixtures();
});

describe("accounts_in_city rate limit, concurrent calls", () => {
  it(`40 simultaneous searches by one rep: exactly ${LIMIT} answer, the rest are 429`, async () => {
    const rep = userClient(fx.tokens.owner);
    const results = await Promise.all(
      Array.from({ length: 40 }, () => rep.rpc("accounts_in_city", { city: "Nashville", state: null })),
    );
    const ok = results.filter((r) => !r.error);
    const limited = results.filter((r) => r.error);
    expect(ok).toHaveLength(LIMIT);
    expect(limited).toHaveLength(40 - LIMIT);
    for (const r of limited) {
      expect(r.status).toBe(429);
      expect(r.error?.code).toBe("PT429");
      expect(r.error?.message).toMatch(/^You have reached the limit of 30 city searches an hour\. Try again in \d+ minutes?\.$/);
    }
    expect(await citySearchRows(fx.userIds.owner)).toBe(LIMIT);
  }, 60_000);

  it("an admin is not limited, and every call is audited", async () => {
    const admin = userClient(fx.tokens.admin);
    const results = await Promise.all(
      Array.from({ length: LIMIT + 5 }, () => admin.rpc("accounts_in_city", { city: "Nashville", state: null })),
    );
    expect(results.filter((r) => r.error)).toEqual([]);
    expect(await citySearchRows(fx.userIds.admin)).toBe(LIMIT + 5);
  }, 60_000);

  it("a rep cannot clear their own count through the API", async () => {
    const rep = userClient(fx.tokens.owner);
    expect((await rep.rpc("accounts_in_city", { city: "Nashville", state: null })).error).toBeNull();
    const del = await rep.from("audit_log").delete().like("action", "accounts_in_city:%");
    expect(del.error?.message).toMatch(/permission denied/);
    expect(await citySearchRows(fx.userIds.owner)).toBe(1);
  });
});
