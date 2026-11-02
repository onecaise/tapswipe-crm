import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PERSONA_EMAILS,
  adminClient,
  provisionFixtures,
  teardownFixtures,
  userClient,
  type Fixtures,
} from "./helpers/stack";

/**
 * teardownFixtures() against an override (20261102120000), with the table
 * NON-EMPTY -- the shape of tests/live/rep-share-teardown.test.ts.
 *
 * The hard case: an override on the OWNER persona's merchant paid to ANOTHER
 * persona (the intruder), and its pair of ledger lines -- the owner's debit,
 * the intruder's credit -- on a batch the ADMIN imported. Three foreign keys
 * stand in the way of an ordinary teardown:
 *
 *   * merchant_overrides.merchant_id (RESTRICT): the owner's merchant cannot
 *     go while the override exists, and it names a different persona;
 *   * rep_payout_rows.override_id (RESTRICT): the override cannot go while
 *     either line names it, and one belongs to somebody else;
 *   * rep_payout_rows.batch_id (SET NULL): the admin's batch cannot go while
 *     an override line points at it, because an override line must carry a
 *     batch -- detaching it is refused.
 *
 * clearOverrides() collects overrides by merchant and by recipient and deletes
 * their lines first; clearPayoutRows() deletes override lines on the user's
 * own batches before it detaches the rest. This file proves the obstacles are
 * real and that the teardown then succeeds and leaves nothing behind.
 *
 * No Edge Function is called, so this file does not need skipWhenFunctionsDown.
 */

let fx: Fixtures;
let overrideId: number;
let batchId: number;

/** This month (UTC), inside the import window the batch trigger enforces. */
function thisMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

beforeAll(async () => {
  fx = await provisionFixtures();
  const admin = adminClient();
  const period = thisMonth();

  // Inserted as the service role: the shape a teardown must survive, whatever
  // path made it. (The RPC path is the hermetic suite's.)
  const { data: override, error: overrideError } = await admin
    .from("merchant_overrides")
    .insert({
      merchant_id: fx.merchantIds.owner,
      recipient_id: fx.userIds.intruder,
      override_pct: 10,
      effective_from: period,
    })
    .select("id");
  // service_role holds SELECT and DELETE only, never INSERT: the definer
  // functions are the one write path. So the row is made as the admin would.
  if (!overrideError) throw new Error("service_role inserted into merchant_overrides; it must not be able to");
  expect(override).toBeNull();

  const asAdmin = userClient(fx.tokens.admin);
  const { data: id, error: setError } = await asAdmin.rpc("set_merchant_override", {
    merchant_id_input: fx.merchantIds.owner,
    recipient_id_input: fx.userIds.intruder,
    override_pct_input: 10,
    effective_from_input: "2099-01-01",
  });
  if (setError) throw new Error(`set_merchant_override: ${setError.message}`);
  overrideId = id as number;

  const { data: batch, error: batchError } = await admin
    .from("rep_payout_batches")
    .insert({
      imported_by: fx.userIds.admin,
      file_key: "live/override-teardown.xlsx",
      file_name: "override-teardown.xlsx",
      processor: "Square",
      period,
    })
    .select("id")
    .single();
  if (batchError || !batch) throw new Error(`batch insert: ${batchError?.message}`);
  batchId = batch.id as number;

  const { error: linesError } = await admin.from("rep_payout_rows").insert(
    [
      { agent_id: fx.userIds.owner, override_role: "debit", override_amount: -10 },
      { agent_id: fx.userIds.intruder, override_role: "credit", override_amount: 10 },
    ].map((line) => ({
      ...line,
      period: "2099-01-01",
      processor: "Square",
      mid: "LIVE-MID-OWNER",
      merchant_id: fx.merchantIds.owner,
      batch_id: batchId,
      line_kind: "override",
      override_id: overrideId,
    })),
  );
  if (linesError) throw new Error(`override lines insert: ${linesError.message}`);
});

afterAll(async () => {
  // Idempotent: a no-op when the test below already tore everything down, and
  // the safety net when it failed part-way.
  await teardownFixtures();
});

describe("teardownFixtures with an override paid to another persona on a rep's own merchant", () => {
  it("is a real obstacle: the override cannot go while its lines name it, nor its lines lose their batch", async () => {
    const admin = adminClient();
    const { error: overrideError } = await admin
      .from("merchant_overrides")
      .delete()
      .eq("id", overrideId);
    // The constraint NAME is pinned, not the code: 23503 on Postgres 17 (this
    // stack), 23001 on 18 (PGlite).
    expect(["23001", "23503"]).toContain(overrideError?.code);
    expect(overrideError?.message).toMatch(/rep_payout_rows_override_id_fkey/);

    const { error: detachError } = await admin
      .from("rep_payout_rows")
      .update({ batch_id: null })
      .eq("override_id", overrideId);
    expect(detachError?.message).toMatch(/rep_payout_rows_adjustment_no_figures/);
  });

  it("tears down every persona, the override lines, the override and the batch", async () => {
    await expect(teardownFixtures()).resolves.toBeUndefined();

    const admin = adminClient();
    expect((await admin.from("merchant_overrides").select("id").eq("id", overrideId)).data).toEqual([]);
    expect((await admin.from("rep_payout_rows").select("id").eq("override_id", overrideId)).data).toEqual([]);
    expect((await admin.from("rep_payout_batches").select("id").eq("id", batchId)).data).toEqual([]);
    expect((await admin.from("merchants").select("id").eq("id", fx.merchantIds.owner)).data).toEqual([]);
    const { data: profiles } = await admin
      .from("profiles")
      .select("email")
      .in("email", Object.values(PERSONA_EMAILS));
    expect(profiles).toEqual([]);
  });
});
