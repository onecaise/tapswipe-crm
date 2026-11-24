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
 * Override funding (20261116120000, docs/design/override-funding.md) through
 * PostgREST, with real GoTrue sessions: what PGlite cannot show is the Data
 * API's view of the new and changed functions -- the five-argument
 * set_merchant_override and no four-argument one, set_merchant_override_
 * funding and override_funding_pending callable by an admin, refused to a rep
 * and to anon. The money is tests/rls/override-funding.test.ts's.
 *
 * No Edge Function is called, so this file does not need skipWhenFunctionsDown.
 */

let fx: Fixtures;
let overrideId: number;
const REASON = "Live test: paid from the company's share, as ISO Hub pays it.";

beforeAll(async () => {
  fx = await provisionFixtures();
});

afterAll(async () => {
  await teardownFixtures();
});

describe("override funding over the Data API", () => {
  it("an admin sets an override that says who pays it; the four-argument call no longer exists", async () => {
    const asAdmin = userClient(fx.tokens.admin);
    const { data, error } = await asAdmin.rpc("set_merchant_override", {
      merchant_id_input: fx.merchantIds.owner,
      recipient_id_input: fx.userIds.intruder,
      override_pct_input: 5,
      effective_from_input: "2099-01-01",
      funded_by_input: "company",
    });
    expect(error).toBeNull();
    overrideId = data as number;
    const { data: row } = await adminClient().from("merchant_overrides").select("funded_by").eq("id", overrideId).single();
    expect(row).toEqual({ funded_by: "company" });

    const old = await asAdmin.rpc("set_merchant_override", {
      merchant_id_input: fx.merchantIds.owner,
      recipient_id_input: fx.userIds.intruder,
      override_pct_input: 5,
      effective_from_input: "2099-06-01",
    });
    expect(old.error?.code).toBe("PGRST202");

    const missing = await asAdmin.rpc("set_merchant_override", {
      merchant_id_input: fx.merchantIds.owner,
      recipient_id_input: fx.userIds.intruder,
      override_pct_input: 5,
      effective_from_input: "2099-06-01",
      funded_by_input: null,
    });
    expect(missing.error?.code).toBe("22023");
  });

  it("an admin changes who pays it, with a reason; a rep and anon cannot", async () => {
    const args = { override_id_input: overrideId, funded_by_input: "owner", reason_input: REASON };
    const rep = await userClient(fx.tokens.owner).rpc("set_merchant_override_funding", args);
    expect(rep.error?.code).toBe("PT403");
    const anon = await anonClient().rpc("set_merchant_override_funding", args);
    expect(anon.error).not.toBeNull();

    const { data, error } = await userClient(fx.tokens.admin).rpc("set_merchant_override_funding", args);
    expect(error).toBeNull();
    expect(data).toEqual({ changed: true, from: "company", to: "owner", replace: [] });
    const { data: audit } = await adminClient().from("audit_log").select("actor_id, detail")
      .eq("action", "set_override_funding").eq("row_id", String(overrideId));
    expect(audit).toEqual([{ actor_id: fx.userIds.admin, detail: `company -> owner; replace: none; reason: ${REASON}` }]);
  });

  it("override_funding_pending answers an admin and refuses a rep and anon", async () => {
    const admin = await userClient(fx.tokens.admin).rpc("override_funding_pending");
    expect(admin.error).toBeNull();
    expect(Array.isArray(admin.data)).toBe(true);
    const rep = await userClient(fx.tokens.owner).rpc("override_funding_pending");
    expect(rep.error?.code).toBe("PT403");
    const anon = await anonClient().rpc("override_funding_pending");
    expect(anon.error).not.toBeNull();
  });
});
