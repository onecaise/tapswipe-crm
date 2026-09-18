// stage-user-import against a real running stack.
//
// This belongs here rather than in tests/rls for the things PGlite structurally
// cannot do: the parser runs in Deno, the function authenticates its own JWT,
// and the two collision lookups go through PostgREST rather than Postgres.
// tests/unit/user-import-parse.test.ts covers the parsing rules exhaustively and
// tests/rls/user-imports.test.ts covers the policies and grants. What only this
// suite can prove is that the pieces meet — and, specifically, that a rep whose
// email or agent number already exists is detected against the REAL profiles
// table rather than a fixture's idea of one.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PERSONA_AGENT_NUMBERS,
  PERSONA_EMAILS,
  adminClient,
  functionsAreServed,
  invoke,
  provisionFixtures,
  teardownFixtures,
  userClient,
  warmFunctions,
  type Fixtures,
} from "./helpers/stack";

const FUNCTIONS = ["stage-user-import"] as const;

const HEADER = "Full name,Email,Role,Agent #";

let fixtures: Fixtures;

/** Batches created here, so each test can clean up after itself. */
const batchIds: number[] = [];

function csv(rows: string[]): string {
  return [HEADER, ...rows].join("\n");
}

async function stage(
  body: Record<string, unknown>,
  token = fixtures.tokens.admin,
): Promise<Awaited<ReturnType<typeof invoke>>> {
  const response = await invoke("stage-user-import", body, token);
  const id = response.body.batch_id;
  if (typeof id === "number" && !batchIds.includes(id)) batchIds.push(id);
  return response;
}

/** The staged rows for a batch, in file order, read as the service role. */
async function stagedRows(batchId: number) {
  const { data, error } = await adminClient()
    .from("user_import_rows")
    .select("row_number, full_name, email, role, agent_number, blocker, outcome")
    .eq("batch_id", batchId)
    .order("row_number", { ascending: true });

  if (error) throw new Error(`Could not read staged rows: ${error.message}`);
  return data ?? [];
}

beforeAll(async () => {
  if (!(await functionsAreServed())) {
    throw new Error(
      "The functions runtime is not answering. Run `supabase start` and " +
        "`supabase functions serve` before this suite.",
    );
  }
  // Before any status-code assertion: the first invocation of a function in a
  // serve session triggers an .npmrc write and a runtime restart, which 502s
  // whatever is in flight.
  await warmFunctions(FUNCTIONS);
  fixtures = await provisionFixtures();
}, 180_000);

afterAll(async () => {
  const admin = adminClient();
  if (batchIds.length > 0) {
    await admin.from("user_import_batches").delete().in("id", batchIds);
  }
  await teardownFixtures();
}, 180_000);

describe("who may call it", () => {
  it("refuses an unauthenticated caller", async () => {
    const response = await invoke("stage-user-import", {
      file_name: "x.csv",
      source_text: csv(["Avery,a@tapswipe.test,agent,"]),
    });
    expect(response.status).toBe(401);
  });

  it("refuses an agent", async () => {
    const response = await stage(
      {
        file_name: "x.csv",
        source_text: csv(["Avery,a@tapswipe.test,agent,"]),
      },
      fixtures.tokens.owner,
    );
    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Admin only");
  });

  it("refuses a deactivated account before it says anything about admin", async () => {
    // A valid JWT proves who the caller is, not that the account is still
    // enabled — and the reason given has to be the accurate one.
    const response = await stage(
      {
        file_name: "x.csv",
        source_text: csv(["Avery,a@tapswipe.test,agent,"]),
      },
      fixtures.tokens.deactivated,
    );
    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Account is not active");
  });
});

describe("staging a clean file", () => {
  it("creates the batch and stages every row", async () => {
    const response = await stage({
      file_name: "reps.csv",
      source_text: csv([
        "Avery Agent,live-import-a@tapswipe.test,agent,LIVE-A1",
        "Blake Boss,live-import-b@tapswipe.test,admin,",
      ]),
    });

    expect(response.status).toBe(200);
    expect(response.body.row_count).toBe(2);
    expect(response.body.blocked_count).toBe(0);
    expect(response.body.skipped_count).toBe(0);
    expect(response.body.ready).toBe(true);

    const rows = await stagedRows(response.body.batch_id as number);
    expect(rows).toHaveLength(2);
    // Row numbers are the file's, so an error can name where to look.
    expect(rows.map((row) => row.row_number)).toEqual([2, 3]);
    expect(rows[0].email).toBe("live-import-a@tapswipe.test");
    expect(rows[0].agent_number).toBe("LIVE-A1");
    expect(rows[1].role).toBe("admin");
    // Blank agent number is null, never '' — the partial unique index treats
    // empty string as a value, so two reps cleared that way would collide.
    expect(rows[1].agent_number).toBeNull();
    // Nothing has been provisioned, which is what makes this the work list.
    expect(rows.every((row) => row.outcome === null)).toBe(true);
  });

  it("stores the batch so the review screen can read it back", async () => {
    const response = await stage({
      file_name: "provenance.csv",
      source_text: csv(["Avery,live-import-c@tapswipe.test,agent,"]),
    });

    const { data } = await adminClient()
      .from("user_import_batches")
      .select("file_name, status, row_count, source_text")
      .eq("id", response.body.batch_id as number)
      .single();

    expect(data?.file_name).toBe("provenance.csv");
    expect(data?.status).toBe("review");
    expect(data?.row_count).toBe(1);
    // Kept verbatim: it is the provenance and what a re-read parses again.
    expect(data?.source_text).toContain("live-import-c@tapswipe.test");
  });
});

describe("collisions with accounts that already exist", () => {
  it("flags an email that already has an account, and does NOT block the batch", async () => {
    // The whole point of the skippable/blocking split: one existing rep must not
    // stop the others being onboarded.
    const response = await stage({
      file_name: "one-exists.csv",
      source_text: csv([
        `Existing Person,${PERSONA_EMAILS.owner},agent,`,
        "New Person,live-import-d@tapswipe.test,agent,",
      ]),
    });

    expect(response.status).toBe(200);
    expect(response.body.skipped_count).toBe(1);
    expect(response.body.blocked_count).toBe(0);
    expect(response.body.ready).toBe(true);

    const rows = await stagedRows(response.body.batch_id as number);
    expect(rows[0].blocker).toBe("email_exists");
    expect(rows[1].blocker).toBeNull();
  });

  it("flags an agent number that already belongs to a rep", async () => {
    const taken = PERSONA_AGENT_NUMBERS.owner as string;
    const response = await stage({
      file_name: "number-taken.csv",
      source_text: csv([`New Person,live-import-e@tapswipe.test,agent,${taken}`]),
    });

    expect(response.status).toBe(200);
    expect(response.body.skipped_count).toBe(1);

    const rows = await stagedRows(response.body.batch_id as number);
    expect(rows[0].blocker).toBe("agent_number_taken");
  });

  it("matches an existing email regardless of case", async () => {
    const shouted = (PERSONA_EMAILS.intruder as string).toUpperCase();
    const response = await stage({
      file_name: "shouted.csv",
      source_text: csv([`Existing,${shouted},agent,`]),
    });

    const rows = await stagedRows(response.body.batch_id as number);
    expect(rows[0].blocker).toBe("email_exists");
  });
});

describe("problems that DO block the batch", () => {
  it("blocks the file and reports why, per row", async () => {
    const response = await stage({
      file_name: "messy.csv",
      source_text: csv([
        "Fine Person,live-import-f@tapswipe.test,agent,",
        ",live-import-g@tapswipe.test,agent,",
        "No Email,not-an-email,agent,",
        "Bad Role,live-import-h@tapswipe.test,Manger,",
        "Dupe One,live-import-i@tapswipe.test,agent,",
        "Dupe Two,live-import-i@tapswipe.test,agent,",
      ]),
    });

    expect(response.status).toBe(200);
    expect(response.body.blocked_count).toBe(4);
    expect(response.body.ready).toBe(false);

    const rows = await stagedRows(response.body.batch_id as number);
    expect(rows.map((row) => row.blocker)).toEqual([
      null,
      "missing_name",
      "invalid_email",
      "invalid_role",
      null,
      "duplicate_email_in_file",
    ]);
  });

  it("names the row a duplicate collides with", async () => {
    const response = await stage({
      file_name: "dupes.csv",
      source_text: csv([
        "First,live-import-j@tapswipe.test,agent,",
        "Second,live-import-j@tapswipe.test,agent,",
      ]),
    });

    const { data } = await adminClient()
      .from("user_import_rows")
      .select("error")
      .eq("batch_id", response.body.batch_id as number)
      .eq("row_number", 3)
      .single();

    // Row 2 is where it was first used, and saying so is what lets an admin
    // open the file and see both.
    expect(data?.error).toContain("row 2");
  });
});

describe("reading the stored file again", () => {
  it("replaces the staged rows rather than adding to them", async () => {
    // Idempotency is what makes "fix something, then read again" one code path
    // run twice, rather than a second import.
    const first = await stage({
      file_name: "reread.csv",
      source_text: csv([
        "Avery,live-import-k@tapswipe.test,agent,",
        "Blake,live-import-l@tapswipe.test,agent,",
      ]),
    });
    const batchId = first.body.batch_id as number;
    expect(await stagedRows(batchId)).toHaveLength(2);

    const second = await stage({ batch_id: batchId });
    expect(second.status).toBe(200);
    expect(second.body.row_count).toBe(2);
    // Not four.
    expect(await stagedRows(batchId)).toHaveLength(2);
  });

  it("picks up a collision created since the first read", async () => {
    // The point of offering a re-read at all: the database changed underneath
    // the batch, and re-reading is how the review screen catches up.
    const created = await stage({
      file_name: "catch-up.csv",
      source_text: csv(["Newcomer,live-import-m@tapswipe.test,agent,"]),
    });
    const batchId = created.body.batch_id as number;

    let rows = await stagedRows(batchId);
    expect(rows[0].blocker).toBeNull();

    // Give that address an account out of band, exactly as creating the rep
    // from another screen would.
    const admin = adminClient();
    const { data: made } = await admin.auth.admin.createUser({
      email: "live-import-m@tapswipe.test",
      password: "live-test-password-123",
      email_confirm: true,
    });
    const newId = made?.user?.id as string;
    await admin.from("profiles").insert({
      id: newId,
      full_name: "Newcomer",
      email: "live-import-m@tapswipe.test",
      role: "agent",
      is_active: true,
      must_change_password: true,
    });

    try {
      const again = await stage({ batch_id: batchId });
      expect(again.body.skipped_count).toBe(1);

      rows = await stagedRows(batchId);
      expect(rows[0].blocker).toBe("email_exists");
    } finally {
      // Before the user goes, or the profiles FK blocks the delete.
      await admin.from("audit_log").delete().eq("actor_id", newId);
      await admin.from("audit_log").delete().eq("row_id", newId);
      await admin.auth.admin.deleteUser(newId);
    }
  });

  it("refuses a batch that is no longer in review", async () => {
    const created = await stage({
      file_name: "settled.csv",
      source_text: csv(["Avery,live-import-n@tapswipe.test,agent,"]),
    });
    const batchId = created.body.batch_id as number;

    await adminClient()
      .from("user_import_batches")
      .update({ status: "committed" })
      .eq("id", batchId);

    const again = await stage({ batch_id: batchId });
    expect(again.status).toBe(409);
    expect(String(again.body.error)).toMatch(/committed/);
  });

  it("404s on a batch that does not exist", async () => {
    const response = await stage({ batch_id: 987654 });
    expect(response.status).toBe(404);
  });
});

describe("RLS still governs the tables themselves", () => {
  it("does not let an agent read a batch over PostgREST", async () => {
    // The function is admin-only, but the tables are reachable directly too —
    // and a rep must not be able to read a list of people being onboarded.
    const created = await stage({
      file_name: "private.csv",
      source_text: csv(["Avery,live-import-o@tapswipe.test,agent,"]),
    });

    const { data } = await userClient(fixtures.tokens.owner)
      .from("user_import_batches")
      .select("id")
      .eq("id", created.body.batch_id as number);

    expect(data ?? []).toHaveLength(0);
  });
});
