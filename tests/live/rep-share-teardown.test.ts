import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PERSONA_EMAILS,
  adminClient,
  provisionFixtures,
  teardownFixtures,
  type Fixtures,
} from "./helpers/stack";

/**
 * teardownFixtures() against the shared-account case it was written for, with
 * the table NON-EMPTY (20261014130000 / 20261014140000).
 *
 * The hard case: a share on the OWNER persona's merchant between two OTHER
 * personas (the intruder signs, the admin is the partner), plus the shared
 * pair of ledger lines naming it. Two RESTRICT foreign keys stand in the way
 * of an ordinary teardown:
 *
 *   * merchant_rep_shares.merchant_id -- the owner's merchant cannot go while
 *     the share exists, and the share names neither of the reps a by-owner
 *     delete would look for;
 *   * rep_payout_rows.rep_share_id -- the share cannot go while ledger lines
 *     name it, and one of those lines belongs to a rep other than whoever is
 *     being torn down at the time.
 *
 * clearRepShares() collects shares by merchant and by either rep, deletes the
 * lines naming them, then the shares. This file proves the case is real (the
 * merchant delete is refused first) and that the teardown then succeeds and
 * leaves nothing behind.
 *
 * No Edge Function is called, so this file does not need skipWhenFunctionsDown.
 */

let fx: Fixtures;
let shareId: number;

beforeAll(async () => {
  fx = await provisionFixtures();
  const admin = adminClient();

  const { data: share, error: shareError } = await admin
    .from("merchant_rep_shares")
    .insert({
      merchant_id: fx.merchantIds.owner,
      primary_agent_id: fx.userIds.intruder,
      secondary_agent_id: fx.userIds.admin,
      primary_rep_pct: 40,
      secondary_rep_pct: 10,
      effective_from: "2027-08-01",
    })
    .select("id")
    .single();
  if (shareError || !share) throw new Error(`share insert: ${shareError?.message}`);
  shareId = share.id as number;

  const { error: linesError } = await admin.from("rep_payout_rows").insert(
    [
      { agent_id: fx.userIds.intruder, share_role: "primary" },
      { agent_id: fx.userIds.admin, share_role: "secondary" },
    ].map((line) => ({
      ...line,
      period: "2027-08-01",
      mid: "LIVE-MID-OWNER",
      merchant_id: fx.merchantIds.owner,
      rep_share_id: shareId,
      primary_rep_pct: 40,
      secondary_rep_pct: 10,
    })),
  );
  if (linesError) throw new Error(`shared lines insert: ${linesError.message}`);
});

afterAll(async () => {
  // Idempotent: a no-op when the test below already tore everything down, and
  // the safety net when it failed part-way.
  await teardownFixtures();
});

describe("teardownFixtures with a share between two other reps on a rep's own merchant", () => {
  it("is a real obstacle: the share cannot be deleted while the shared lines name it", async () => {
    // The trap a share-first teardown walks into. Asserted on the SHARE rather
    // than on the owner's merchant: provisionFixtures hangs other records off
    // that merchant too, so a merchant delete fails on one of those first and
    // would prove nothing about shares. The merchant half of the obstacle is
    // pinned by e2e/rep-share-teardown.spec.ts on a merchant nothing else
    // references, and in tests/rls.
    //
    // The constraint NAME is pinned, not the code: Postgres 17 (this stack,
    // 17.6) reports an ON DELETE RESTRICT violation as 23503, Postgres 18
    // (PGlite, 18.3) as 23001.
    const admin = adminClient();
    const { error } = await admin
      .from("merchant_rep_shares")
      .delete()
      .eq("id", shareId);
    expect(["23001", "23503"]).toContain(error?.code);
    expect(error?.message).toMatch(/rep_payout_rows_rep_share_id_fkey/);
  });

  it("tears down every persona, the shared lines and the share", async () => {
    await expect(teardownFixtures()).resolves.toBeUndefined();

    const admin = adminClient();
    const { data: shares } = await admin
      .from("merchant_rep_shares")
      .select("id")
      .eq("id", shareId);
    expect(shares).toEqual([]);

    const { data: lines } = await admin
      .from("rep_payout_rows")
      .select("id")
      .eq("rep_share_id", shareId);
    expect(lines).toEqual([]);

    const { data: merchants } = await admin
      .from("merchants")
      .select("id")
      .eq("id", fx.merchantIds.owner);
    expect(merchants).toEqual([]);

    const { data: profiles } = await admin
      .from("profiles")
      .select("email")
      .in("email", Object.values(PERSONA_EMAILS));
    expect(profiles).toEqual([]);
  });
});
