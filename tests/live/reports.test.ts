import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  adminClient,
  anonClient,
  provisionFixtures,
  teardownFixtures,
  userClient,
  type Fixtures,
} from "./helpers/stack";

/**
 * The two report functions (20261102160000, phase 12 of
 * docs/design/intake-and-reports.md) over the real PostgREST: what the page
 * actually receives. tests/rls/reports.test.ts owns the arithmetic; this file
 * pins the wire (numbers arrive as JSON numbers, as lib/reports.ts types
 * them), that an admin gets the rows, that a rep is refused PT403 and anon
 * is refused, and that a batch left in review is not counted.
 *
 * No Edge Function is called, so this file does not need skipWhenFunctionsDown.
 */

let fx: Fixtures;
let slot: { processor: string; period: string };

const PROCESSORS = ["Netevia HQ", "PayBright", "Red Fynn", "Square", "TSYS"];

/** A processor-month inside the import window that no batch on this stack uses. */
async function freeSlot(): Promise<{ processor: string; period: string }> {
  const { data } = await adminClient().from("rep_payout_batches").select("processor, period");
  const used = new Set((data ?? []).map((b) => `${b.processor}|${b.period}`));
  const now = new Date();
  for (let back = 24; back >= 0; back -= 1) {
    const index = now.getUTCFullYear() * 12 + now.getUTCMonth() - back;
    const year = Math.floor(index / 12);
    const period = `${year}-${String(index - year * 12 + 1).padStart(2, "0")}-01`;
    for (const processor of PROCESSORS) {
      if (!used.has(`${processor}|${period}`)) return { processor, period };
    }
  }
  throw new Error("no free processor-month in the import window");
}

beforeAll(async () => {
  fx = await provisionFixtures();
  const admin = adminClient();
  slot = await freeSlot();

  // A committed batch with one owner line, and a review batch of another
  // processor with one line that must not count. As the service role: the
  // commit path is the hermetic suite's.
  const batches = await admin
    .from("rep_payout_batches")
    .insert([
      { imported_by: fx.userIds.admin, file_key: "live/reports.xlsx", file_name: "live-reports.xlsx",
        status: "committed", committed_at: new Date().toISOString(), ...slot },
      { imported_by: fx.userIds.admin, file_key: "live/reports-review.xlsx", file_name: "live-reports-review.xlsx",
        status: "review", processor: slot.processor === "TSYS" ? "Square" : "TSYS", period: slot.period },
    ])
    .select("id, status");
  if (batches.error) throw new Error(`batches: ${batches.error.message}`);
  const committed = batches.data!.find((b) => b.status === "committed")!.id as number;
  const review = batches.data!.find((b) => b.status === "review")!.id as number;

  const { error } = await admin.from("rep_payout_rows").insert([
    { agent_id: fx.userIds.owner, period: slot.period, processor: slot.processor, mid: "LIVE-REPORT-1",
      merchant_name: "Live Report Merchant", volume: 1000, residual_income: 123.45, rep_split_pct: 50,
      batch_id: committed },
    { agent_id: fx.userIds.owner, period: slot.period, processor: "TSYS", mid: "LIVE-REPORT-2",
      merchant_name: "Live Review Merchant", volume: 1000, residual_income: 999, rep_split_pct: 50,
      batch_id: review },
  ]);
  if (error) throw new Error(`lines: ${error.message}`);
});

afterAll(async () => {
  await teardownFixtures();
});

const args = () => ({
  period_from_input: slot.period,
  period_to_input: slot.period,
  processor_input: slot.processor,
});

describe("rep_payout_summary and merchant_processor_summary over PostgREST", () => {
  it("an admin gets Report 1's rows, figures as JSON numbers, the review batch not counted", async () => {
    const { data, error } = await userClient(fx.tokens.admin).rpc("rep_payout_summary", args());
    expect(error).toBeNull();
    const rep = (data as Record<string, unknown>[]).find((r) => r.row_kind === "rep");
    expect(rep).toMatchObject({
      agent_id: fx.userIds.owner,
      full_name: "Live Owner Agent",
      sales_volume: 1000,
      net_residual: 123.45,
      agent_split: 61.73,
      deductions: 0,
      overrides_received: 0,
      total_commission: 61.73,
    });
    expect(typeof rep!.total_commission).toBe("number");

    // All processors: still only the committed line.
    const all = await userClient(fx.tokens.admin).rpc("rep_payout_summary", { ...args(), processor_input: null });
    const owner = (all.data as Record<string, unknown>[]).find((r) => r.agent_id === fx.userIds.owner);
    expect(owner?.net_residual).toBe(123.45);
  });

  it("an admin gets Report 2's rows", async () => {
    const { data, error } = await userClient(fx.tokens.admin).rpc("merchant_processor_summary", args());
    expect(error).toBeNull();
    expect((data as Record<string, unknown>[]).map((r) => [r.row_kind, r.mid, r.residual, r.rep_side, r.company_overrides, r.company_share]))
      .toEqual([
        ["merchant", "LIVE-REPORT-1", 123.45, 61.73, 0, 61.72],
        ["processor", null, 123.45, 61.73, 0, 61.72],
        ["total", null, 123.45, 61.73, 0, 61.72],
      ]);
  });

  for (const fn of ["rep_payout_summary", "merchant_processor_summary"]) {
    it(`${fn}: a rep is refused PT403, over their own line`, async () => {
      const { data, error } = await userClient(fx.tokens.owner).rpc(fn, args());
      expect(error?.code).toBe("PT403");
      expect(data).toBeNull();
    });

    it(`${fn}: anon is refused`, async () => {
      const { data, error } = await anonClient().rpc(fn, args());
      expect(error?.code).toBe("42501");
      expect(data).toBeNull();
    });
  }
});
