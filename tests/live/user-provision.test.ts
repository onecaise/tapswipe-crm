// provision-user-batch against a real running stack.
//
// This one HAS to be a live test. Everything it does crosses a boundary PGlite
// cannot reach: it creates real auth.users rows through GoTrue, it calls the
// same provisionUser core create-user uses, and the whole point of the design —
// that a row's outcome is durable before the next row starts — is only
// observable by stopping a run part-way and looking at the table.
//
// The single most valuable assertions here are the two resume ones: a batch
// provisioned in chunks reaches exactly the same state as one done in a single
// pass, and a row that failed can be retried rather than being stuck forever.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PERSONA_EMAILS,
  adminClient,
  functionsAreServed,
  invoke,
  provisionFixtures,
  teardownFixtures,
  warmFunctions,
  type Fixtures,
} from "./helpers/stack";

const FUNCTIONS = ["stage-user-import", "provision-user-batch"] as const;

const HEADER = "Full name,Email,Role,Agent #";

/** Every address these tests create, so teardown can find them. */
const CREATED_EMAILS = new Set<string>();
const batchIds: number[] = [];

let fixtures: Fixtures;

function csv(rows: string[]): string {
  return [HEADER, ...rows].join("\n");
}

/** A unique address per test, so one test's accounts never collide with another's. */
function address(tag: string): string {
  const email = `live-prov-${tag}@tapswipe.test`;
  CREATED_EMAILS.add(email);
  return email;
}

async function stage(sourceText: string): Promise<number> {
  const response = await invoke(
    "stage-user-import",
    { file_name: "provision.csv", source_text: sourceText },
    fixtures.tokens.admin,
  );
  if (response.status !== 200) {
    throw new Error(`staging failed: ${response.raw}`);
  }
  const id = response.body.batch_id as number;
  batchIds.push(id);
  return id;
}

async function provision(
  body: Record<string, unknown>,
  token = fixtures.tokens.admin,
) {
  return invoke("provision-user-batch", body, token);
}

/** Runs chunks until the batch reports nothing left. Returns how many calls. */
async function provisionToCompletion(
  batchId: number,
  limit?: number,
): Promise<number> {
  let calls = 0;
  for (;;) {
    const response = await provision(
      limit === undefined ? { batch_id: batchId } : { batch_id: batchId, limit },
    );
    calls += 1;
    if (response.status !== 200) {
      throw new Error(`provisioning failed: ${response.raw}`);
    }
    if ((response.body.remaining as number) === 0) break;
    if (calls > 50) throw new Error("provisioning did not converge");
  }
  return calls;
}

async function stagedRows(batchId: number) {
  const { data, error } = await adminClient()
    .from("user_import_rows")
    .select("row_number, email, outcome, outcome_detail, user_id, orphaned_auth_user")
    .eq("batch_id", batchId)
    .order("row_number", { ascending: true });

  if (error) throw new Error(`Could not read staged rows: ${error.message}`);
  return data ?? [];
}

async function batchRow(batchId: number) {
  const { data } = await adminClient()
    .from("user_import_batches")
    .select("status, committed_at, row_count")
    .eq("id", batchId)
    .single();
  return data;
}

beforeAll(async () => {
  if (!(await functionsAreServed())) {
    throw new Error(
      "The functions runtime is not answering. Run `supabase start` and " +
        "`supabase functions serve` before this suite.",
    );
  }
  await warmFunctions(FUNCTIONS);
  fixtures = await provisionFixtures();
}, 180_000);

afterAll(async () => {
  const admin = adminClient();

  // Accounts first: they are the thing that blocks everything else, and they
  // are real auth.users rows rather than fixtures.
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
  for (const user of list?.users ?? []) {
    if (!user.email || !CREATED_EMAILS.has(user.email)) continue;
    // audit_log.actor_id / row_id reference profiles with no ON DELETE, and
    // provisionUser writes a create_user row for every account it makes.
    await admin.from("audit_log").delete().eq("actor_id", user.id);
    await admin.from("audit_log").delete().eq("row_id", user.id);
    await admin.auth.admin.deleteUser(user.id);
  }

  if (batchIds.length > 0) {
    await admin.from("user_import_batches").delete().in("id", batchIds);
  }
  // The batch-level rows are keyed on the batch id, not a user, so they survive
  // the loop above.
  await admin
    .from("audit_log")
    .delete()
    .eq("action", "commit_user_import")
    .in("row_id", batchIds.map(String));

  await teardownFixtures();
}, 180_000);

describe("who may call it", () => {
  it("refuses an unauthenticated caller", async () => {
    const response = await invoke("provision-user-batch", { batch_id: 1 });
    expect(response.status).toBe(401);
  });

  it("refuses an agent", async () => {
    const batchId = await stage(csv([`Avery,${address("agent-guard")},agent,`]));
    const response = await provision(
      { batch_id: batchId },
      fixtures.tokens.owner,
    );
    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Admin only");
  });

  it("refuses a deactivated admin with the accurate reason", async () => {
    const response = await provision(
      { batch_id: 1 },
      fixtures.tokens.deactivated,
    );
    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Account is not active");
  });

  it("404s on a batch that does not exist", async () => {
    const response = await provision({ batch_id: 987654 });
    expect(response.status).toBe(404);
  });
});

describe("creating the accounts", () => {
  it("creates every row, and the accounts really exist", async () => {
    const one = address("create-1");
    const two = address("create-2");
    const batchId = await stage(
      csv([`Avery Agent,${one},agent,LIVE-P1`, `Blake Boss,${two},admin,`]),
    );

    const response = await provision({ batch_id: batchId });

    expect(response.status).toBe(200);
    expect(response.body.created).toBe(2);
    expect(response.body.remaining).toBe(0);
    expect(response.body.committed).toBe(true);

    const rows = await stagedRows(batchId);
    expect(rows.map((row) => row.outcome)).toEqual(["created", "created"]);
    expect(rows.every((row) => row.user_id !== null)).toBe(true);

    // The profiles rows exist, with the role and agent number the file asked
    // for, and forced onto a password change.
    const admin = adminClient();
    const { data: profiles } = await admin
      .from("profiles")
      .select("email, role, agent_number, is_active, must_change_password")
      .in("email", [one, two])
      .order("email", { ascending: true });

    expect(profiles).toHaveLength(2);
    const byEmail = Object.fromEntries(
      (profiles ?? []).map((p) => [p.email as string, p]),
    );
    expect(byEmail[one].role).toBe("agent");
    expect(byEmail[one].agent_number).toBe("LIVE-P1");
    expect(byEmail[two].role).toBe("admin");
    expect(
      (profiles ?? []).every((p) => p.must_change_password === true),
    ).toBe(true);
    expect((profiles ?? []).every((p) => p.is_active === true)).toBe(true);
  });

  it("returns nothing whatsoever about a temporary password", async () => {
    // The credential decision made structural. A batch must not hand out
    // secrets; an admin issues one per rep at onboarding time instead.
    const batchId = await stage(csv([`Avery,${address("no-secret")},agent,`]));
    const response = await provision({ batch_id: batchId });

    expect(response.status).toBe(200);
    const serialised = JSON.stringify(response.body).toLowerCase();
    expect(serialised).not.toContain("password");
    expect(serialised).not.toContain("temporary");
  });

  it("marks the batch committed with a timestamp, and audits it once", async () => {
    const batchId = await stage(csv([`Avery,${address("audited")},agent,`]));
    await provision({ batch_id: batchId });

    const batch = await batchRow(batchId);
    expect(batch?.status).toBe("committed");
    expect(batch?.committed_at).not.toBeNull();

    const { data: audits } = await adminClient()
      .from("audit_log")
      .select("action, table_name, row_id")
      .eq("action", "commit_user_import")
      .eq("row_id", String(batchId));

    expect(audits).toHaveLength(1);
    expect(audits?.[0].table_name).toBe("user_import_batches");
  });

  it("writes a per-account audit row as well as the batch one", async () => {
    // Two granularities on purpose. audit_log has no detail column, so one
    // level would either lose the per-account trail or bury the batch.
    const email = address("two-levels");
    const batchId = await stage(csv([`Avery,${email},agent,`]));
    await provision({ batch_id: batchId });

    const rows = await stagedRows(batchId);
    const userId = rows[0].user_id as string;

    const { data: audits } = await adminClient()
      .from("audit_log")
      .select("action")
      .eq("row_id", userId);

    expect(audits?.map((a) => a.action)).toContain("create_user");
  });
});

describe("skipping rows that already have accounts", () => {
  it("skips a colliding row and still creates the rest", async () => {
    const fresh = address("mixed-new");
    const batchId = await stage(
      csv([
        `Existing,${PERSONA_EMAILS.owner},agent,`,
        `Newcomer,${fresh},agent,`,
      ]),
    );

    const response = await provision({ batch_id: batchId });

    expect(response.status).toBe(200);
    expect(response.body.skipped).toBe(1);
    expect(response.body.created).toBe(1);
    expect(response.body.committed).toBe(true);

    const rows = await stagedRows(batchId);
    expect(rows[0].outcome).toBe("skipped_duplicate");
    expect(rows[1].outcome).toBe("created");
    // No account was invented for the skipped row.
    expect(rows[0].user_id).toBeNull();
  });

  it("commits a batch in which every row is skipped", async () => {
    const batchId = await stage(
      csv([`Existing,${PERSONA_EMAILS.intruder},agent,`]),
    );
    const response = await provision({ batch_id: batchId });

    expect(response.body.skipped).toBe(1);
    expect(response.body.remaining).toBe(0);
    expect(response.body.committed).toBe(true);
  });
});

describe("chunking and resume", () => {
  it("reaches the same state in chunks as it would in one pass", async () => {
    // The central claim of the design. Five accounts at one row per call: every
    // row created exactly once, and the batch committed by the last call.
    const emails = [1, 2, 3, 4, 5].map((n) => address(`chunk-${n}`));
    const batchId = await stage(
      csv(emails.map((email, i) => `Rep ${i},${email},agent,`)),
    );

    const calls = await provisionToCompletion(batchId, 1);

    // Five rows at one per call, and no more. The call that provisions the last
    // row already reports remaining: 0, so a caller never has to make an extra
    // round trip just to discover it has finished.
    expect(calls).toBe(5);

    const rows = await stagedRows(batchId);
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.outcome === "created")).toBe(true);
    // Five distinct accounts — no row provisioned twice.
    expect(new Set(rows.map((row) => row.user_id)).size).toBe(5);

    const { count } = await adminClient()
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .in("email", emails);
    expect(count).toBe(5);

    expect((await batchRow(batchId))?.status).toBe("committed");
  });

  it("leaves a stopped run resumable, with the done rows already durable", async () => {
    // Stop after one chunk and look at the table — this is the property the
    // whole design rests on, and the only way to see it is to stop.
    const emails = [1, 2, 3].map((n) => address(`resume-${n}`));
    const batchId = await stage(
      csv(emails.map((email, i) => `Rep ${i},${email},agent,`)),
    );

    const first = await provision({ batch_id: batchId, limit: 1 });
    expect(first.body.created).toBe(1);
    expect(first.body.remaining).toBe(2);
    expect(first.body.committed).toBe(false);

    // Mid-run: one row is durably done, two are still work.
    let rows = await stagedRows(batchId);
    expect(rows.filter((row) => row.outcome === "created")).toHaveLength(1);
    expect(rows.filter((row) => row.outcome === null)).toHaveLength(2);
    // And the batch is holding the lock, which is what lets the UI offer to
    // resume rather than to start over.
    expect((await batchRow(batchId))?.status).toBe("provisioning");

    await provisionToCompletion(batchId);

    rows = await stagedRows(batchId);
    expect(rows.every((row) => row.outcome === "created")).toBe(true);
    expect(new Set(rows.map((row) => row.user_id)).size).toBe(3);
  });

  it("does nothing on a second run over a finished batch", async () => {
    // Re-running must not create a second account for anyone. The status guard
    // refuses first, which is the cheaper of the two protections.
    const batchId = await stage(csv([`Avery,${address("rerun")},agent,`]));
    await provision({ batch_id: batchId });

    const again = await provision({ batch_id: batchId });
    expect(again.status).toBe(409);
    expect(String(again.body.error)).toMatch(/committed/);
  });

  it("caps the chunk size however large a limit is asked for", async () => {
    const emails = [1, 2, 3].map((n) => address(`cap-${n}`));
    const batchId = await stage(
      csv(emails.map((email, i) => `Rep ${i},${email},agent,`)),
    );

    // Far above MAX_LIMIT; the batch is smaller than the cap, so what this
    // really asserts is that an absurd limit is clamped rather than refused.
    const response = await provision({ batch_id: batchId, limit: 5000 });
    expect(response.status).toBe(200);
    expect(response.body.created).toBe(3);
  });

  it("rejects a limit that is not a positive integer", async () => {
    const batchId = await stage(csv([`Avery,${address("bad-limit")},agent,`]));
    const response = await provision({ batch_id: batchId, limit: 0 });
    expect(response.status).toBe(400);
  });
});

describe("refusing to start on a file that still has problems", () => {
  it("will not provision a batch with blocking rows", async () => {
    // Half-importing a file the admin still has to correct is the outcome the
    // staged flow exists to prevent.
    const batchId = await stage(
      csv([
        `Fine,${address("blocked-ok")},agent,`,
        `,${address("blocked-bad")},agent,`,
      ]),
    );

    const response = await provision({ batch_id: batchId });

    expect(response.status).toBe(409);
    expect(String(response.body.error)).toMatch(/correct the file/i);

    // And nothing was created — not even the row that was fine.
    const rows = await stagedRows(batchId);
    expect(rows.every((row) => row.outcome === null)).toBe(true);
    expect((await batchRow(batchId))?.status).toBe("review");
  });
});

describe("retrying rows that failed", () => {
  it("clears a failed outcome and provisions it on the retry", async () => {
    // Without retry_failed a transient fault is permanent: 'failed' takes the
    // row out of the work list for good. Simulated by marking a row failed
    // directly, which is exactly the state an Auth blip would leave.
    const email = address("retry");
    const batchId = await stage(csv([`Avery,${email},agent,`]));

    const admin = adminClient();
    await admin
      .from("user_import_rows")
      .update({
        outcome: "failed",
        outcome_detail: "Simulated transient failure.",
      })
      .eq("batch_id", batchId);

    // Nothing to do: the row is out of the work list.
    const stuck = await provision({ batch_id: batchId });
    expect(stuck.body.created).toBe(0);
    expect(stuck.body.remaining).toBe(0);

    // Reopen the batch, since the call above committed an empty work list.
    await admin
      .from("user_import_batches")
      .update({ status: "provisioning", committed_at: null })
      .eq("id", batchId);

    const retried = await provision({ batch_id: batchId, retry_failed: true });
    expect(retried.status).toBe(200);
    expect(retried.body.created).toBe(1);

    const rows = await stagedRows(batchId);
    expect(rows[0].outcome).toBe("created");
    expect(rows[0].outcome_detail).toBeNull();
    expect(rows[0].user_id).not.toBeNull();
  });
});
