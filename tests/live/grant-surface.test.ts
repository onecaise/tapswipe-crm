// The narrowed grant surface, over real HTTP through PostgREST.
//
// tests/rls/grants.test.ts already asserts which privileges each role holds, and
// proves the audit fix by reconstructing the legacy state. What it cannot do is
// show how PostgREST behaves with those privileges — and the two failure modes
// look nothing alike from the app's side:
//
//   * a missing GRANT is `permission denied for table X`, a 4xx that breaks the
//     page outright;
//   * a restrictive POLICY is an empty result set, a 200 with no rows.
//
// The security audit narrowed `authenticated` from GRANT ALL to explicit verbs
// and dropped audit_log to SELECT. That is exactly the kind of change that can
// turn a working page into the first failure mode, so this file drives the paths
// the app actually uses as a real signed-in user.
//
// It needs `supabase start` but NOT `functions serve` — everything here is
// PostgREST and RPC, no Edge Functions.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  adminClient,
  anonClient,
  provisionFixtures,
  teardownFixtures,
  userClient,
  type Fixtures,
} from "./helpers/stack";

let fx: Fixtures;

beforeAll(async () => {
  fx = await provisionFixtures();
});

afterAll(async () => {
  await teardownFixtures();
});

describe("audit_log is readable by an admin and writable by nobody", () => {
  it("lets an admin read the trail", async () => {
    // The regression this exists to catch. audit_log dropped to a SELECT-only
    // grant, and if that had been fumbled the trail would be invisible in the
    // app while every hermetic test still passed — the grant layer is below
    // where PGlite's assertions look, and above where the policies do.
    const asAdmin = userClient(fx.tokens.admin);

    // Guarantee there is something to read, written the way production writes
    // it: a service-role insert, since audit_log has no INSERT policy at all.
    const service = adminClient();
    await service.from("audit_log").insert({
      actor_id: fx.userIds.admin,
      action: "grant_surface_probe",
      table_name: "profiles",
      row_id: fx.userIds.owner,
    });

    const { data, error } = await asAdmin
      .from("audit_log")
      .select("actor_id, action, row_id")
      .eq("action", "grant_surface_probe");

    // Not `permission denied`, and not an empty set.
    expect(error, error?.message).toBeNull();
    expect(data).toEqual([
      {
        actor_id: fx.userIds.admin,
        action: "grant_surface_probe",
        row_id: fx.userIds.owner,
      },
    ]);

    await service
      .from("audit_log")
      .delete()
      .eq("action", "grant_surface_probe");
  });

  it("shows an agent nothing, without erroring", async () => {
    // The distinction that matters: the SELECT grant is held by `authenticated`
    // as a whole, so an agent's request is authorised at the privilege layer and
    // then filtered to nothing by the `admin reads audit log` policy. A 200 with
    // zero rows is the correct answer; `permission denied` would mean the grant
    // had been narrowed past what the policy needs.
    const asAgent = userClient(fx.tokens.owner);

    const { data, error } = await asAgent.from("audit_log").select("id");

    expect(error, error?.message).toBeNull();
    expect(data).toEqual([]);
  });

  it("refuses an agent's attempt to forge a row", async () => {
    // Two locks now, where there used to be one. Before the audit this was
    // blocked only by the absence of an INSERT policy; the INSERT privilege is
    // gone as well, so the request dies at the privilege layer.
    const asAgent = userClient(fx.tokens.owner);

    const { error } = await asAgent.from("audit_log").insert({
      actor_id: fx.userIds.owner,
      action: "forged",
      table_name: "profiles",
      row_id: fx.userIds.owner,
    });

    expect(error, "an agent must not be able to write audit_log").not.toBeNull();
  });

  it("refuses an admin's attempt to erase a row", async () => {
    // Admins are not exempt. The trail is evidence about admins in particular,
    // so DELETE is gone for `authenticated` outright rather than policy-gated.
    const service = adminClient();
    await service.from("audit_log").insert({
      actor_id: fx.userIds.admin,
      action: "grant_surface_undeletable",
      table_name: "profiles",
      row_id: fx.userIds.owner,
    });

    const asAdmin = userClient(fx.tokens.admin);
    await asAdmin
      .from("audit_log")
      .delete()
      .eq("action", "grant_surface_undeletable");

    // DELETE with no matching privilege removes nothing. Asserted by reading the
    // row back rather than by trusting the error, because PostgREST reports a
    // no-op delete as a success.
    const { data } = await service
      .from("audit_log")
      .select("id")
      .eq("action", "grant_surface_undeletable");
    expect(data?.length ?? 0).toBe(1);

    await service
      .from("audit_log")
      .delete()
      .eq("action", "grant_surface_undeletable");
  });
});

describe("ordinary CRUD still works after the revoke", () => {
  // The other half of the risk: revoking too much. Each of these needs both the
  // table grant and USAGE on the table's sequence, which the migration re-grants
  // explicitly — a serial insert with no sequence USAGE fails with
  // `permission denied for sequence X`, and nothing in the hermetic suite
  // exercises nextval() through PostgREST.
  it("lets an agent insert and read a lead", async () => {
    const asAgent = userClient(fx.tokens.owner);

    const { data, error } = await asAgent
      .from("leads")
      .insert({ agent_id: fx.userIds.owner, dba: "Grant Surface Lead" })
      .select("id, dba")
      .single();

    expect(error, error?.message).toBeNull();
    expect(data?.dba).toBe("Grant Surface Lead");

    const service = adminClient();
    await service.from("leads").delete().eq("id", data!.id);
    // The delete above fires the cross-agent trigger as service role; clear its
    // row so the suite leaves nothing behind.
    await service
      .from("audit_log")
      .delete()
      .eq("table_name", "leads")
      .eq("row_id", String(data!.id));
  });

  it("lets an agent insert a note and a task", async () => {
    // notes and tasks are the two tables whose sequences are easiest to forget:
    // they are the only Tier 1 tables reached exclusively through panels rather
    // than a page of their own.
    const asAgent = userClient(fx.tokens.owner);
    const service = adminClient();

    const note = await asAgent
      .from("notes")
      .insert({
        agent_id: fx.userIds.owner,
        owner_type: "merchant",
        owner_id: fx.merchantIds.owner,
        body: "Grant surface note",
      })
      .select("id")
      .single();
    expect(note.error, note.error?.message).toBeNull();

    const task = await asAgent
      .from("tasks")
      .insert({
        agent_id: fx.userIds.owner,
        owner_type: "merchant",
        owner_id: fx.merchantIds.owner,
        title: "Grant surface task",
      })
      .select("id")
      .single();
    expect(task.error, task.error?.message).toBeNull();

    await service.from("notes").delete().eq("id", note.data!.id);
    await service.from("tasks").delete().eq("id", task.data!.id);
    for (const [table, id] of [
      ["notes", note.data!.id],
      ["tasks", task.data!.id],
    ] as const) {
      await service
        .from("audit_log")
        .delete()
        .eq("table_name", table)
        .eq("row_id", String(id));
    }
  });

  it("still serves the dashboard counts and search RPCs", async () => {
    // Both are `security invoker`, so they read through the caller's own grants
    // and policies — which makes them the most sensitive thing to a
    // grant-narrowing mistake, and neither had a live test before.
    const asAgent = userClient(fx.tokens.owner);

    const counts = await asAgent.rpc("dashboard_counts").maybeSingle();
    expect(counts.error, counts.error?.message).toBeNull();
    expect(counts.data).toHaveProperty("active_merchants");

    const search = await asAgent.rpc("search_crm", {
      query_input: "Live Owner",
      limit_input: 5,
    });
    expect(search.error, search.error?.message).toBeNull();
    expect(Array.isArray(search.data)).toBe(true);
  });
});

describe("processors over PostgREST (phase 1, docs/design/intake-and-reports.md)", () => {
  // tests/rls/processors.test.ts asserts the privileges; this asserts what the
  // app actually gets back through the Data API, where a missing grant and a
  // restrictive policy look nothing alike.
  it("serves a signed-in rep the five processors in drop-down order", async () => {
    const { data, error } = await userClient(fx.tokens.owner)
      .from("processors")
      .select("code")
      .order("sort_order");
    expect(error).toBeNull();
    expect(data?.map((r) => r.code)).toEqual([
      "TSYS",
      "Red Fynn",
      "PayBright",
      "Netevia HQ",
      "Square",
    ]);
  });

  it("refuses an admin's write at the privilege layer, not with an empty 200", async () => {
    const { error } = await userClient(fx.tokens.admin)
      .from("processors")
      .insert({ code: "Fake", label: "Fake", sort_order: 99 });
    expect(error?.code).toBe("42501");
  });

  it("gives anon nothing", async () => {
    const { data, error } = await anonClient().from("processors").select("code");
    // The TABLE privilege, by name. A bare 42501 is not enough: with an anon
    // grant added, the policy's is_active_agent() call is refused instead (anon
    // cannot execute it) and returns the same code -- measured, that version of
    // this test stayed green with the grant in place.
    expect(error?.message).toMatch(/permission denied for table processors/);
    expect(data).toBeNull();
  });

  it("refuses a free-text merchant processor from an admin's session", async () => {
    const { error } = await userClient(fx.tokens.admin)
      .from("merchants")
      .update({ processor: "First Data" })
      .eq("id", fx.merchantIds.owner);
    expect(error?.code).toBe("23503");
  });
});
