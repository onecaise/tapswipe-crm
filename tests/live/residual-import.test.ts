// The residual import cycle, against a real running stack.
//
// This belongs here rather than in tests/rls for things PGlite structurally cannot
// do: the parser runs in Deno, SheetJS has to load there at all, the file goes
// through Storage signed URLs, and the two functions authenticate their own JWTs.
// tests/rls/commit-residual-import.test.ts covers the merge rule exhaustively in
// SQL; tests/unit/residuals-parse.test.ts covers the parsing rules. What only this
// suite can prove is that the pieces meet.
//
// The single most valuable assertion here is the round trip in
// "reads a real workbook": a workbook built by SheetJS in Node, uploaded to
// Storage, and read back by SheetJS in Deno. If the CDN import specifier ever stops
// resolving, this is what fails — and it fails loudly rather than at deploy time.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import {
  PERSONA_AGENT_NUMBERS,
  RESIDUAL_BUCKET,
  UNKNOWN_AGENT_NUMBER,
  adminClient,
  anonClient,
  skipWhenFunctionsDown,
  getStackConfig,
  invoke,
  provisionFixtures,
  teardownFixtures,
  userClient,
  warmFunctions,
  type Fixtures,
} from "./helpers/stack";

const FUNCTIONS = [
  "residual-import-file-url",
  "parse-residual-import",
  "export-residuals",
] as const;

const PERIOD = "2026-07-01";
const OWNER_NUMBER = PERSONA_AGENT_NUMBERS.owner as string;

const HEADER = [
  "Period",
  "Agent #",
  "MID",
  "Merchant name",
  "Volume",
  "Average ticket",
  "Total cost",
];

let fixtures: Fixtures;

/** Batches created here, so each test can clean up after itself. */
const batchIds: number[] = [];

function workbook(rows: unknown[][]): Buffer {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), "Residuals");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

/** Mints an upload URL, PUTs the bytes, and parses — the browser's three steps. */
async function importFile(
  rows: unknown[][],
  fileName = "live-residuals.xlsx",
): Promise<{
  batchId: number;
  parse: Awaited<ReturnType<typeof invoke>>;
}> {
  const minted = await invoke(
    "residual-import-file-url",
    { file_name: fileName },
    fixtures.tokens.admin,
  );
  expect(minted.status, minted.raw).toBe(200);

  const batchId = minted.body.batch_id as number;
  batchIds.push(batchId);

  const asAdmin = userClient(fixtures.tokens.admin);
  const { error } = await asAdmin.storage
    .from(RESIDUAL_BUCKET)
    .uploadToSignedUrl(
      minted.body.path as string,
      minted.body.token as string,
      workbook(rows),
      {
        contentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    );
  expect(error, error?.message).toBeNull();

  const parse = await invoke(
    "parse-residual-import",
    { batch_id: batchId },
    fixtures.tokens.admin,
  );

  return { batchId, parse };
}

async function stagedRows(batchId: number) {
  const { data } = await adminClient()
    .from("rep_payout_import_rows")
    .select("row_number, period, agent_id, merchant_id, volume, blocker, error")
    .eq("batch_id", batchId)
    .order("row_number");
  return data ?? [];
}

async function ledgerFor(mid: string) {
  const { data } = await adminClient()
    .from("rep_payout_rows")
    .select("mid, volume, residual_income, rep_split_pct, rep_payout, batch_id")
    .eq("mid", mid)
    .eq("period", PERIOD)
    .maybeSingle();
  return data;
}

/** True only when functions are down and ALLOW_SKIPPED_FUNCTION_TESTS=1: every test here then skips. */
const FUNCTIONS_DOWN = skipWhenFunctionsDown();

beforeAll(async () => {
  // The run-level gate (tests/live/helpers/global-setup.ts) has already
  // failed the run if the functions runtime is down, unless the opt-in is set.
  if (FUNCTIONS_DOWN) return;
  // Before any status assertion. The first invocation of a function makes the
  // runtime restart, which 502s whatever is in flight and would read as "the
  // function returns 502 instead of 403".
  await warmFunctions(FUNCTIONS);
  fixtures = await provisionFixtures();
});

afterAll(async () => {
  // teardownFixtures clears the five payout FKs and the bucket, but batches
  // created here belong to the admin persona and are removed with them.
  await teardownFixtures();
});

/** Downloads the export as raw bytes, so a test can read the workbook back. */
async function exportWorkbook(
  token: string,
  body: Record<string, unknown> = {},
): Promise<{ status: number; rows: unknown[][] }> {
  const { apiUrl, anonKey } = await import("./helpers/stack").then((m) =>
    m.getStackConfig(),
  );
  const response = await fetch(`${apiUrl}/functions/v1/export-residuals`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      apikey: anonKey,
    },
    body: JSON.stringify(body),
  });

  if (response.status !== 200) return { status: response.status, rows: [] };

  const bytes = new Uint8Array(await response.arrayBuffer());
  const book = XLSX.read(bytes, { type: "array", cellDates: true });
  const sheet = book.Sheets[book.SheetNames[0]];
  return {
    status: response.status,
    rows: XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: true,
      defval: null,
    }) as unknown[][],
  };
}

describe("every residual function rejects a caller who is not an active admin", () => {
  for (const name of FUNCTIONS) {
    // export-residuals is deliberately NOT admin-only: RLS scopes the file, so a
    // rep exporting gets their own rows. Its own describe block below covers that.
    if (name === "export-residuals") continue;
    const body =
      name === "residual-import-file-url"
        ? { file_name: "should-not-exist.xlsx" }
        : { batch_id: 1 };

    it(`${name} rejects an agent's token with 403`, async () => {
      const response = await invoke(name, body, fixtures.tokens.owner);
      expect(response.status, response.raw).toBe(403);
      expect(String(response.body.error)).toMatch(/admin/i);
    });

    it(`${name} rejects a deactivated agent's token with 403`, async () => {
      // A different rejection: this token is valid and the account exists, it is
      // simply switched off. The message distinguishes them.
      const response = await invoke(name, body, fixtures.tokens.deactivated);
      expect(response.status, response.raw).toBe(403);
      expect(String(response.body.error)).toMatch(/not active/i);
    });

    it(`${name} rejects an unauthenticated caller with 401`, async () => {
      const response = await invoke(name, body);
      expect(response.status, response.raw).toBe(401);
    });
  }

  it("created no batch while refusing", async () => {
    // The rejection has to land before any privileged work. If authorization were
    // checked after the insert, the assertions above would still see a 403 while a
    // rep_payout_batches row had already been written.
    const { data } = await adminClient()
      .from("rep_payout_batches")
      .select("id")
      .eq("file_name", "should-not-exist.xlsx");
    expect(data ?? []).toEqual([]);
  });
});

describe("it reads a real workbook end to end", () => {
  it("uploads, parses with SheetJS under Deno, and stages what it read", async () => {
    // The load-bearing round trip: built by SheetJS in Node, read by SheetJS in
    // Deno. Nothing else in the repo proves that import resolves at all.
    const { batchId, parse } = await importFile([
      HEADER,
      ["Jul-26", OWNER_NUMBER, "LIVE-MID-OWNER", "Live Owner Co", "12,400.00", "62.00", "$310.00"],
      ["Jul-26", OWNER_NUMBER, "LIVE-MID-NOMATCH", "No Such Merchant", 4200, 21, 105],
    ]);

    expect(parse.status, parse.raw).toBe(200);
    expect(parse.body).toMatchObject({
      batch_id: batchId,
      row_count: 2,
      blocked_count: 0,
    });

    const staged = await stagedRows(batchId);
    expect(staged).toHaveLength(2);

    // "Jul-26" normalised, "$310.00" and "12,400.00" coerced, the agent number
    // resolved, and the MID soft-linked in one direction but not the other.
    expect(staged[0]).toMatchObject({
      row_number: 2,
      period: PERIOD,
      agent_id: fixtures.userIds.owner,
      volume: 12400,
      blocker: null,
    });
    expect(staged[0].merchant_id).toBe(fixtures.merchantIds.owner);
    // An unmatched MID is ordinary, not an error: a residual report legitimately
    // names merchants nobody entered into the CRM.
    expect(staged[1].merchant_id).toBeNull();
    expect(staged[1].blocker).toBeNull();
  });

  it("blocks an unrecognised agent number, and nothing else", async () => {
    const { batchId, parse } = await importFile([
      HEADER,
      ["Jul-26", OWNER_NUMBER, "LIVE-MID-OWNER", "Live Owner Co", 1000, 10, 25],
      ["Jul-26", UNKNOWN_AGENT_NUMBER, "LIVE-MID-STRANGER", "Bayside Auto", 2300, 18, 61],
    ]);

    expect(parse.body).toMatchObject({ row_count: 2, blocked_count: 1 });

    const staged = await stagedRows(batchId);
    expect(staged[0].blocker).toBeNull();
    expect(staged[1].blocker).toBe("unknown_agent");
    // The message names the number, so the review screen can be acted on.
    expect(String(staged[1].error)).toContain(UNKNOWN_AGENT_NUMBER);
  });

  it("rejects a file missing a required column, before staging anything", async () => {
    const { batchId, parse } = await importFile([
      ["Period", "Agent #", "MID"],
      ["Jul-26", OWNER_NUMBER, "LIVE-MID-OWNER"],
    ]);

    expect(parse.status, parse.raw).toBe(400);
    // Names the columns rather than producing one blocker per row: a file with the
    // wrong shape has no rows worth reviewing.
    expect(String(parse.body.error)).toContain("Merchant name");
    expect(await stagedRows(batchId)).toEqual([]);
  });

  it("rejects something that is not a spreadsheet", async () => {
    const minted = await invoke(
      "residual-import-file-url",
      { file_name: "not-a-workbook.xlsx" },
      fixtures.tokens.admin,
    );
    const batchId = minted.body.batch_id as number;
    batchIds.push(batchId);

    const asAdmin = userClient(fixtures.tokens.admin);
    await asAdmin.storage
      .from(RESIDUAL_BUCKET)
      .uploadToSignedUrl(
        minted.body.path as string,
        minted.body.token as string,
        Buffer.from("Period,Agent #\nthis is a csv, not xlsx\n"),
        { contentType: "text/csv" },
      );

    const parse = await invoke(
      "parse-residual-import",
      { batch_id: batchId },
      fixtures.tokens.admin,
    );

    // Reported rather than thrown, so the review screen can say so. An accept
    // attribute on a file input does not stop a renamed file.
    expect(parse.status, parse.raw).toBe(400);
    expect(String(parse.body.error)).toMatch(/spreadsheet|column/i);
  });

  it("404s a batch that does not exist, rather than 403", async () => {
    // "Not yours" and "doesn't exist" must be indistinguishable, or the endpoint
    // becomes an oracle for which batch ids exist.
    const response = await invoke(
      "parse-residual-import",
      { batch_id: 987654 },
      fixtures.tokens.admin,
    );
    expect(response.status, response.raw).toBe(404);
  });

  it("404s a batch whose file never arrived", async () => {
    const minted = await invoke(
      "residual-import-file-url",
      { file_name: "never-uploaded.xlsx" },
      fixtures.tokens.admin,
    );
    const batchId = minted.body.batch_id as number;
    batchIds.push(batchId);

    const parse = await invoke(
      "parse-residual-import",
      { batch_id: batchId },
      fixtures.tokens.admin,
    );

    expect(parse.status, parse.raw).toBe(404);
    expect(String(parse.body.error)).toMatch(/no uploaded file/i);
  });

  it("re-parsing replaces the staged rows instead of duplicating them", async () => {
    // The mechanism behind the review screen's "Read again": resolution is one code
    // path, run twice, rather than a second route to keep in step with the first.
    const { batchId } = await importFile([
      HEADER,
      ["Jul-26", UNKNOWN_AGENT_NUMBER, "LIVE-MID-FIXME", "Pending Co", 900, 9, 22],
    ]);

    expect((await stagedRows(batchId))[0].blocker).toBe("unknown_agent");

    // Resolve it the way the UI does — give the number to an existing rep — then
    // read the same file again.
    const asAdmin = userClient(fixtures.tokens.admin);
    const { error: rpcError } = await asAdmin.rpc("set_agent_number", {
      target_user_id: fixtures.userIds.intruder,
      new_agent_number: UNKNOWN_AGENT_NUMBER,
    });
    expect(rpcError).toBeNull();

    const again = await invoke(
      "parse-residual-import",
      { batch_id: batchId },
      fixtures.tokens.admin,
    );
    expect(again.body).toMatchObject({ row_count: 1, blocked_count: 0 });

    const staged = await stagedRows(batchId);
    expect(staged).toHaveLength(1);
    expect(staged[0].agent_id).toBe(fixtures.userIds.intruder);

    // Put the persona back, so later tests see the fixture they expect.
    await asAdmin.rpc("set_agent_number", {
      target_user_id: fixtures.userIds.intruder,
      new_agent_number: PERSONA_AGENT_NUMBERS.intruder as string,
    });
  });

  it("signs a download of the stored original", async () => {
    // The provenance the retained file exists to provide: a committed period can
    // always be traced back to the bytes it came from.
    const { batchId } = await importFile(
      [HEADER, ["Jul-26", OWNER_NUMBER, "LIVE-MID-OWNER", "Live Owner Co", 1, 1, 1]],
      "traceable.xlsx",
    );

    const response = await invoke(
      "residual-import-file-url",
      { batch_id: batchId },
      fixtures.tokens.admin,
    );

    expect(response.status, response.raw).toBe(200);
    expect(String(response.body.signedUrl)).toContain(RESIDUAL_BUCKET);
    expect(response.body.fileName).toBe("traceable.xlsx");
  });
});

describe("committing over HTTP", () => {
  // The RPC's guards are covered exhaustively in
  // tests/rls/commit-residual-import.test.ts. What only this suite proves is that
  // it is reachable over the Data API with a real JWT and that `authenticated`
  // actually holds EXECUTE on it — a missing grant is invisible below PostgREST,
  // which is exactly how this repo once shipped with no Data API grants at all.
  it("refuses an agent over HTTP", async () => {
    const { batchId } = await importFile([
      HEADER,
      ["Jul-26", OWNER_NUMBER, "LIVE-MID-OWNER", "Live Owner Co", 100, 5, 3],
    ]);

    const { error } = await userClient(fixtures.tokens.owner).rpc(
      "commit_residual_import",
      { batch_id_input: batchId },
    );

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/admin only/i);
  });

  // commit_residual_import_v2 is what the commit button calls (phase 4b). This
  // proves PostgREST exposes it with the right grant: anon holds no EXECUTE, an
  // agent meets the hand-written guard, and an admin gets the jsonb shape back.
  // The shared-account cycle is the last describe in this file.
  it("exposes commit_residual_import_v2: anon refused, agent refused, admin commits", async () => {
    const { batchId } = await importFile([
      HEADER,
      ["Jul-26", OWNER_NUMBER, "LIVE-MID-V2", "Live V2 Co", 100, 5, 3],
    ]);

    const anon = await anonClient().rpc("commit_residual_import_v2", {
      batch_id_input: batchId,
    });
    expect(anon.error?.code).toBe("42501");

    const agent = await userClient(fixtures.tokens.owner).rpc(
      "commit_residual_import_v2",
      { batch_id_input: batchId },
    );
    expect(agent.error?.message).toMatch(/admin only/i);

    const admin = await userClient(fixtures.tokens.admin).rpc(
      "commit_residual_import_v2",
      { batch_id_input: batchId },
    );
    expect(admin.error).toBeNull();
    expect(admin.data).toEqual({ written: 1, skipped: 0 });
  });

  it("refuses while a row is still blocked", async () => {
    const { batchId } = await importFile([
      HEADER,
      ["Jul-26", UNKNOWN_AGENT_NUMBER, "LIVE-MID-BLOCKED", "Blocked Co", 100, 5, 3],
    ]);

    const { error } = await userClient(fixtures.tokens.admin).rpc(
      "commit_residual_import",
      { batch_id_input: batchId },
    );

    expect(error?.message).toMatch(/blocked/i);
  });

  it("commits, then merges a re-import without clearing entered figures", async () => {
    const asAdmin = userClient(fixtures.tokens.admin);

    // 1. Import and commit a clean file.
    const first = await importFile([
      HEADER,
      ["Jul-26", OWNER_NUMBER, "LIVE-MID-MERGE", "Merge Co", "1,000.00", "10.00", "$25.00"],
    ]);
    const { data: imported, error: commitError } = await asAdmin.rpc(
      "commit_residual_import",
      { batch_id_input: first.batchId },
    );
    expect(commitError).toBeNull();
    expect(imported).toBe(1);

    let row = await ledgerFor("LIVE-MID-MERGE");
    expect(row).toMatchObject({
      volume: 1000,
      // A fresh processor file carries no figures, so these arrive empty.
      residual_income: null,
      rep_split_pct: null,
      rep_payout: null,
    });

    // 2. An admin enters the figures, the way the period page does.
    const { error: editError, count } = await asAdmin
      .from("rep_payout_rows")
      .update(
        { residual_income: 88.4, rep_split_pct: 60 },
        { count: "exact" },
      )
      .eq("mid", "LIVE-MID-MERGE")
      .eq("period", PERIOD);
    expect(editError).toBeNull();
    expect(count).toBe(1);

    row = await ledgerFor("LIVE-MID-MERGE");
    // The generated column computed in the database, not here.
    expect(row?.rep_payout).toBe(53.04);

    // 2b. Those two figures are ALL an admin's session may write
    // (20261014160000). Any other column is refused by the grant, loudly, as a
    // 42501 through PostgREST -- not filtered to zero rows -- and nothing moves,
    // even when an allowed column rides in the same request.
    for (const patch of [
      { volume: 1 },
      { merchant_name: "Forged Co" },
      { residual_income: 1, merchant_name: "Forged Co" },
    ]) {
      const { error: refused } = await asAdmin
        .from("rep_payout_rows")
        .update(patch)
        .eq("mid", "LIVE-MID-MERGE")
        .eq("period", PERIOD);
      expect(refused?.code, JSON.stringify(patch)).toBe("42501");
    }
    expect(await ledgerFor("LIVE-MID-MERGE")).toEqual(row);

    // 3. A corrected processor file for the same period is re-imported.
    const second = await importFile([
      HEADER,
      ["Jul-26", OWNER_NUMBER, "LIVE-MID-MERGE", "Merge Co Renamed", "1,100.00", "11.00", "$27.00"],
    ]);
    const { error: mergeError } = await asAdmin.rpc("commit_residual_import", {
      batch_id_input: second.batchId,
    });
    expect(mergeError).toBeNull();

    row = await ledgerFor("LIVE-MID-MERGE");
    // The file's own columns moved…
    expect(row?.volume).toBe(1100);
    // …and the hand-entered ones did not. This is the assertion the whole merge
    // rule exists for: re-importing a corrected report must not wipe a month of
    // typed-in commission figures.
    expect(row?.residual_income).toBe(88.4);
    expect(row?.rep_split_pct).toBe(60);
    expect(row?.rep_payout).toBe(53.04);

    // 4. And the edit left a trail, attributed to the admin who made it.
    const { data: history } = await adminClient()
      .from("rep_payout_row_history")
      .select("field, old_value, new_value, changed_by")
      .eq("mid", "LIVE-MID-MERGE")
      .order("id");

    expect((history ?? []).map((h) => h.field)).toEqual([
      "residual_income",
      "rep_split_pct",
    ]);
    expect(history?.[0]).toMatchObject({
      old_value: null,
      new_value: 88.4,
      changed_by: fixtures.userIds.admin,
    });
  });

  it("cannot be committed twice", async () => {
    const asAdmin = userClient(fixtures.tokens.admin);
    const { batchId } = await importFile([
      HEADER,
      ["Jul-26", OWNER_NUMBER, "LIVE-MID-ONCE", "Once Co", 500, 5, 12],
    ]);

    expect(
      (await asAdmin.rpc("commit_residual_import", { batch_id_input: batchId }))
        .error,
    ).toBeNull();

    const { error } = await asAdmin.rpc("commit_residual_import", {
      batch_id_input: batchId,
    });
    expect(error?.message).toMatch(/already committed/i);
  });
});

describe("a rep sees only their own committed rows", () => {
  it("scopes the ledger by RLS, not by a filter in the app", async () => {
    const asAdmin = userClient(fixtures.tokens.admin);

    // One row for each active agent, in one file, committed together.
    const { batchId } = await importFile([
      HEADER,
      ["Jul-26", OWNER_NUMBER, "LIVE-MID-SCOPE-A", "Owner Co", 100, 5, 3],
      [
        "Jul-26",
        PERSONA_AGENT_NUMBERS.intruder as string,
        "LIVE-MID-SCOPE-B",
        "Intruder Co",
        200,
        6,
        4,
      ],
    ]);
    expect(
      (await asAdmin.rpc("commit_residual_import", { batch_id_input: batchId }))
        .error,
    ).toBeNull();

    const { data: ownerRows } = await userClient(fixtures.tokens.owner)
      .from("rep_payout_rows")
      .select("mid")
      .in("mid", ["LIVE-MID-SCOPE-A", "LIVE-MID-SCOPE-B"]);
    expect((ownerRows ?? []).map((r) => r.mid)).toEqual(["LIVE-MID-SCOPE-A"]);

    const { data: adminRows } = await asAdmin
      .from("rep_payout_rows")
      .select("mid")
      .in("mid", ["LIVE-MID-SCOPE-A", "LIVE-MID-SCOPE-B"]);
    expect((adminRows ?? []).length).toBe(2);
  });

  it("refuses a rep's attempt to edit their own figure", async () => {
    // Filtered rather than errored — `authenticated` holds the UPDATE grant, since
    // an admin is authenticated too, so the admin-only USING clause is what hides
    // the row. A count of zero is the only signal, which is why the inline cell
    // checks it.
    const { count, error } = await userClient(fixtures.tokens.owner)
      .from("rep_payout_rows")
      .update({ residual_income: 999 }, { count: "exact" })
      .eq("mid", "LIVE-MID-SCOPE-A");

    expect(error).toBeNull();
    expect(count).toBe(0);

    const row = await ledgerFor("LIVE-MID-SCOPE-A");
    expect(row?.residual_income).toBeNull();
  });

  it("hides the edit history from the rep whose figure it is", async () => {
    const { data } = await userClient(fixtures.tokens.owner)
      .from("rep_payout_row_history")
      .select("id");
    // Admin-only by policy: a rep reads their own figures, but the trail behind
    // them is a payroll-administration record.
    expect(data ?? []).toEqual([]);
  });

  it("gives a rep nothing on the batches and staging tables", async () => {
    const asOwner = userClient(fixtures.tokens.owner);
    const { data: batches } = await asOwner
      .from("rep_payout_batches")
      .select("id");
    const { data: staging } = await asOwner
      .from("rep_payout_import_rows")
      .select("id");

    expect(batches ?? []).toEqual([]);
    expect(staging ?? []).toEqual([]);
  });
});

describe("PostgREST's wire types for the ledger", () => {
  // The assertion that would have prevented a real crash, and the reason it lives
  // in the live suite rather than the hermetic one: only a running PostgREST can
  // say what it puts on the wire.
  //
  // lib/payouts.ts once declared these columns as `string | null`, on the stated
  // belief that PostgREST sends `numeric` as a quoted string to preserve exactness.
  // It does not. PayoutFigureCell then seeded a string-typed useState with a number
  // and threw `text.trim is not a function` when rendering a period. Nothing caught
  // it because the pages cast query results with `as PayoutRow[]`, and an assertion
  // is not a check.
  //
  // So: pin the wire format itself. If PostgREST ever changes this, or if someone
  // "corrects" the types back, this fails and names the reason.
  it("sends numeric as a JSON number, not a string", async () => {
    const { data, error } = await adminClient()
      .from("rep_payout_rows")
      .select("volume, average_ticket, total_cost, residual_income, rep_split_pct, rep_payout")
      .not("residual_income", "is", null)
      .limit(1);

    expect(error).toBeNull();
    expect(data ?? [], "seed a committed row with figures first").not.toHaveLength(0);

    const row = (data ?? [])[0] as Record<string, unknown>;
    for (const column of [
      "volume",
      "average_ticket",
      "total_cost",
      "residual_income",
      "rep_split_pct",
      "rep_payout",
    ]) {
      expect(
        typeof row[column],
        `${column} must arrive as a number — lib/payouts.ts types it that way`,
      ).toBe("number");
    }
  });

  it("sends date and text columns as strings", async () => {
    // The other half, so the rule is "numeric is a number", not "everything is".
    const { data } = await adminClient()
      .from("rep_payout_rows")
      .select("period, mid")
      .limit(1);

    const row = (data ?? [])[0] as Record<string, unknown>;
    expect(typeof row.period).toBe("string");
    expect(typeof row.mid).toBe("string");
  });
});

describe("the export is scoped by RLS and re-importable", () => {
  it("gives a rep only their own rows, and an admin everyone's", async () => {
    // The reason this function is not admin-gated: it reads through the caller's own
    // client, so the file *is* the caller's scope. Reaching for supabaseAdmin
    // anywhere in it — even to join agent names — would silently turn a rep's export
    // into the whole company's, which is exactly the disclosure shape search_crm is
    // security invoker to avoid.
    const asAdmin = await exportWorkbook(fixtures.tokens.admin, {
      period: PERIOD,
    });
    expect(asAdmin.status).toBe(200);

    const asOwner = await exportWorkbook(fixtures.tokens.owner, {
      period: PERIOD,
    });
    expect(asOwner.status).toBe(200);

    const mids = (rows: unknown[][]) => rows.slice(1).map((r) => String(r[3]));
    expect(mids(asOwner.rows).length).toBeGreaterThan(0);
    expect(mids(asAdmin.rows).length).toBeGreaterThan(
      mids(asOwner.rows).length,
    );
    // Nothing of the intruder's reached the owner's file.
    expect(mids(asOwner.rows)).not.toContain("LIVE-MID-SCOPE-B");
    expect(mids(asAdmin.rows)).toContain("LIVE-MID-SCOPE-B");
  });

  it("refuses a deactivated caller", async () => {
    const response = await exportWorkbook(fixtures.tokens.deactivated);
    expect(response.status).toBe(403);
  });

  it("carries the nine importable headers, two the parser ignores, and Line", async () => {
    const { rows } = await exportWorkbook(fixtures.tokens.admin, {
      period: PERIOD,
    });

    expect(rows[0]).toEqual([
      "Period",
      "Agent #",
      "Agent",
      "MID",
      "Merchant name",
      "Volume",
      "Average ticket",
      "Total cost",
      "Residual income",
      "Rep split",
      "Rep payout",
      // Phase 5: "Adjustment" or blank. The one extra the parser reads -- it
      // skips a row so marked -- which is what keeps the round trip from
      // turning a correction into an import line.
      "Line",
    ]);
  });

  it("has NO total row, because a total row would break the round trip", async () => {
    // A total has no MID, so re-importing this file would block that row with
    // missing_mid and refuse the whole batch — breaking the one thing the export
    // exists for. The pages show the totals instead.
    const { rows } = await exportWorkbook(fixtures.tokens.admin, {
      period: PERIOD,
    });

    for (const row of rows.slice(1)) {
      expect(
        String(row[3] ?? "").trim(),
        `every data row must carry a MID, got ${JSON.stringify(row)}`,
      ).not.toBe("");
    }
  });

  it("round-trips: export, fill the figures, re-import, and they land", async () => {
    // The bulk-entry path end to end, and the assertion that ties this feature
    // together. If the export's headers ever stop matching what the parser reads,
    // this is what fails.
    const asAdmin = userClient(fixtures.tokens.admin);

    const { batchId } = await importFile([
      HEADER,
      ["Jul-26", OWNER_NUMBER, "LIVE-MID-ROUNDTRIP", "Round Trip Co", 3000, 30, 75],
    ]);
    expect(
      (await asAdmin.rpc("commit_residual_import", { batch_id_input: batchId }))
        .error,
    ).toBeNull();

    // Export it, and confirm the two money columns come out blank rather than zero —
    // a zero would be a figure nobody entered.
    const exported = await exportWorkbook(fixtures.tokens.admin, {
      period: PERIOD,
    });
    const line = exported.rows
      .slice(1)
      .find((row) => String(row[3]) === "LIVE-MID-ROUNDTRIP");
    expect(line, "the committed row should be in the export").toBeDefined();
    expect(line?.[8]).toBeNull();
    expect(line?.[9]).toBeNull();

    // Fill them in, as an admin would in Excel, and feed the same shape back.
    const filled = exported.rows.map((row, index) =>
      index === 0 || String(row[3]) !== "LIVE-MID-ROUNDTRIP"
        ? row
        : [...row.slice(0, 8), 120.5, 45, row[10]],
    );

    const back = await importFile(filled as unknown[][], "round-trip.xlsx");
    expect(back.parse.status, back.parse.raw).toBe(200);
    expect(back.parse.body).toMatchObject({ blocked_count: 0 });

    expect(
      (
        await asAdmin.rpc("commit_residual_import", {
          batch_id_input: back.batchId,
        })
      ).error,
    ).toBeNull();

    const row = await ledgerFor("LIVE-MID-ROUNDTRIP");
    expect(row?.residual_income).toBe(120.5);
    expect(row?.rep_split_pct).toBe(45);
    // Recomputed by the database from the two figures the spreadsheet supplied.
    expect(row?.rep_payout).toBe(54.23);
  });
});

describe("the export survives the path the browser actually takes", () => {
  /**
   * WHY THIS EXISTS, AND WHY THE SUITE ABOVE COULD NOT CATCH IT.
   *
   * `exportWorkbook` uses raw fetch + arrayBuffer(), so it reads the body itself
   * and the response's Content-Type never matters. The browser does not: it goes
   * through supabase-js's `functions.invoke()`, which picks its parser FROM that
   * header against a fixed list — application/json -> .json(), octet-stream and
   * pdf -> .blob(), event-stream, form-data, and everything else -> **.text()**.
   *
   * The function used to send the real spreadsheet media type
   * (application/vnd.openxmlformats-officedocument.spreadsheetml.sheet), which is
   * correct and is not on that list. So invoke() resolved
   * { error: null, data: <string> }, the export button's `data instanceof Blob`
   * guard failed, and a 200 carrying a perfectly good workbook was reported to
   * the user as "Could not build the export." Every assertion in this file stayed
   * green throughout, because none of them went through supabase-js.
   *
   * Worse than the message: decoding a zip as UTF-8 is lossy — 16,597 bytes came
   * back as a 16,509-character string — so "just accept the string" would have
   * produced a silently corrupt .xlsx.
   *
   * The assertions below are therefore about the CLIENT-VISIBLE shape, not about
   * spreadsheet contents (covered above). Byte length is compared against a raw
   * fetch of the same call, because that is the assertion that fails on a lossy
   * decode while `instanceof Blob` alone would not.
   */
  it("invoke() hands the caller a Blob, byte-identical to the raw response", async () => {
    const supabase = userClient(fixtures.tokens.admin);

    const { data, error } = await supabase.functions.invoke("export-residuals", {
      body: {},
    });

    expect(error).toBeNull();
    // The exact guard components/payout-export-button.tsx applies before it
    // builds the download. A string here is the bug this test exists for.
    expect(data instanceof Blob, `invoke returned ${typeof data}`).toBe(true);

    const viaInvoke = new Uint8Array(await (data as Blob).arrayBuffer());

    // PK — a zip local file header. A truncated or re-encoded body loses this.
    expect(Array.from(viaInvoke.slice(0, 2))).toEqual([0x50, 0x4b]);

    const { apiUrl, anonKey } = getStackConfig();
    const raw = await fetch(`${apiUrl}/functions/v1/export-residuals`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fixtures.tokens.admin}`,
        "Content-Type": "application/json",
        apikey: anonKey,
      },
      body: "{}",
    });
    expect(raw.status).toBe(200);

    // Not a fixed number: the fixtures' row count moves. Equality with the raw
    // read is what proves nothing was lost in transport.
    const viaFetch = new Uint8Array(await raw.arrayBuffer());
    expect(viaInvoke.byteLength).toBe(viaFetch.byteLength);

    // And the bytes invoke() produced still open as a workbook.
    const book = XLSX.read(viaInvoke, { type: "array" });
    expect(book.SheetNames).toContain("Residuals");
  });

  it("declares a Content-Type that supabase-js parses as binary", async () => {
    // Pinned directly, because it is the single line that decides the above and
    // it looks wrong: the generic type is deliberate, the accurate one is the
    // bug. Asserting the header — not just the parsed result — is what makes a
    // future "correction" back to the spreadsheet MIME type fail HERE, naming the
    // cause, rather than in the UI as an unexplained error message.
    const { apiUrl, anonKey } = getStackConfig();
    const response = await fetch(`${apiUrl}/functions/v1/export-residuals`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fixtures.tokens.admin}`,
        "Content-Type": "application/json",
        apikey: anonKey,
      },
      body: "{}",
    });

    expect(response.status).toBe(200);
    // The two types supabase-js reads with .blob(). Not a single-value equality,
    // so application/pdf would also pass — either is a legitimate fix.
    expect(
      (response.headers.get("content-type") ?? "").split(";")[0].trim(),
    ).toMatch(/^application\/(octet-stream|pdf)$/);

    // The filename still travels, for a direct fetch or the curl example. The
    // browser download is named by the component's own anchor.download — a Blob
    // URL carries no headers — so this is documentation of intent, not the
    // mechanism.
    expect(response.headers.get("content-disposition")).toContain(
      'filename="residuals-all-periods.xlsx"',
    );

    await response.arrayBuffer();
  });
});

// ---------------------------------------------------------------------------
// Phase 4b: the whole shared-account cycle the app runs -- upload, preview
// flags, commit through v2, acknowledge the skipped rows -- with the same
// calls the browser makes, against the running stack.
//
// What only this suite can prove: that parse-residual-import's preview (Deno,
// _shared/residuals.ts) and commit_residual_import_v2 (SQL) agree about which
// rows a share skips. Nothing type-checks that pair; this is where it is
// pinned, row by row.
//
// Last in the file on purpose: it writes ledger lines in 2027, and nothing
// after it reads the ledger.
// ---------------------------------------------------------------------------

describe("a shared account, through upload, preview, commit and acknowledge", () => {
  const MID = "LIVE-MID-ADMIN"; // the admin persona's merchant; no other test imports it
  const MAR = "2027-03-01";
  const APR = "2027-04-01";
  const THIRD_NUMBER = "LIVE-3333";
  const INTRUDER_NUMBER = PERSONA_AGENT_NUMBERS.intruder as string;

  let batchId: number;
  let parse: Awaited<ReturnType<typeof invoke>>;

  beforeAll(async () => {
    if (FUNCTIONS_DOWN) return;
    const service = adminClient();

    // A rep outside the pair, for "share not applied". The deactivated persona
    // is the only spare one; resolving a deactivated rep is ordinary (decision 10).
    const { error: numberError } = await service
      .from("profiles")
      .update({ agent_number: THIRD_NUMBER })
      .eq("id", fixtures.userIds.deactivated);
    expect(numberError).toBeNull();

    // The share, the way the app makes one: the admin's own session, through
    // PostgREST. Signer = owner (40), partner = intruder (10), from March 2027.
    const { error: shareError } = await userClient(fixtures.tokens.admin).rpc(
      "set_merchant_rep_share",
      {
        merchant_id_input: fixtures.merchantIds.admin,
        primary_agent_id_input: fixtures.userIds.owner,
        secondary_agent_id_input: fixtures.userIds.intruder,
        primary_rep_pct_input: 40,
        secondary_rep_pct_input: 10,
        effective_from_input: MAR,
      },
    );
    expect(shareError, shareError?.message).toBeNull();

    // A hand-made, UNSHARED line for the partner in April: the state
    // line_not_shared exists for. (The share RPCs refuse a share over a
    // committed month, so only a direct write reaches it.)
    const { error: lineError } = await service.from("rep_payout_rows").insert({
      agent_id: fixtures.userIds.intruder,
      period: APR,
      mid: MID,
      merchant_name: "Hand-made line",
    });
    expect(lineError, lineError?.message).toBeNull();

    ({ batchId, parse } = await importFile(
      [
        HEADER,
        // row 2: the signer -> shared, no flag
        ["Mar-27", OWNER_NUMBER, MID, "Live Shared Co", 1000, 10, 25],
        // row 3: the partner -> partner_named, skipped
        ["Mar-27", INTRUDER_NUMBER, MID, "Live Shared Co", 1000, 10, 25],
        // row 4: a third rep -> share_not_applied, imported as ordinary
        ["Mar-27", THIRD_NUMBER, MID, "Live Shared Co", 1000, 10, 25],
        // row 5: the signer, but April holds the partner's unshared line -> skipped
        ["Apr-27", OWNER_NUMBER, MID, "Live Shared Co", 1000, 10, 25],
        // row 6: an unshared MID -> nothing to say
        ["Mar-27", OWNER_NUMBER, "LIVE-MID-OWNER", "Live Owner Co", 500, 5, 3],
      ],
      "live-shared.xlsx",
    ));
  });

  afterAll(async () => {
    if (FUNCTIONS_DOWN) return;
    await adminClient()
      .from("profiles")
      .update({ agent_number: null })
      .eq("id", fixtures.userIds.deactivated);
  });

  it("previews each row's fate on the staged row, and blocks nothing", async () => {
    expect(parse.status, parse.raw).toBe(200);
    expect(parse.body).toMatchObject({ row_count: 5, blocked_count: 0, flagged_count: 3 });

    const { data } = await adminClient()
      .from("rep_payout_import_rows")
      .select("row_number, blocker, preview_flag, preview_note")
      .eq("batch_id", batchId)
      .order("row_number");
    const staged = data ?? [];

    expect(staged.map((r) => [r.row_number, r.blocker, r.preview_flag])).toEqual([
      [2, null, null],
      [3, null, "partner_named"],
      [4, null, "share_not_applied"],
      [5, null, "line_not_shared"],
      [6, null, null],
    ]);

    // The note names the pair and, for "not applied", who the row imports for.
    const note = (n: number) => staged.find((r) => r.row_number === n)?.preview_note as string | null;
    expect(note(4)).toBe(
      `Share Live Owner Agent / Live Intruder Agent not applied to MID ${MID} for March 2027: the file names Live Deactivated Agent. This row imports as an ordinary line for Live Deactivated Agent.`,
    );
    expect(note(3)).toContain("This row will be skipped");
    expect(note(5)).toContain("This row will be skipped");
    expect(note(2)).toBeNull();
  });

  it("gives a rep none of the preview", async () => {
    const { data } = await userClient(fixtures.tokens.owner)
      .from("rep_payout_import_rows")
      .select("preview_flag")
      .eq("batch_id", batchId);
    expect(data ?? []).toEqual([]);
  });

  it("commits through v2, and skips exactly the rows the preview said it would", async () => {
    const { data, error } = await userClient(fixtures.tokens.admin).rpc(
      "commit_residual_import_v2",
      { batch_id_input: batchId },
    );
    expect(error, error?.message).toBeNull();
    expect(data).toEqual({ written: 3, skipped: 2 });

    const { data: batch } = await adminClient()
      .from("rep_payout_batches")
      .select("status, row_count, skipped_rows, skips_acknowledged_at")
      .eq("id", batchId)
      .single();
    expect(batch?.status).toBe("committed");
    expect(batch?.skips_acknowledged_at).toBeNull();
    // What the commit result page shows: row_count - skipped = written.
    expect((batch?.row_count as number) - (batch?.skipped_rows as unknown[]).length).toBe(3);
    expect(batch?.skipped_rows).toEqual([
      { row_number: 3, period: MAR, mid: MID, agent_number: INTRUDER_NUMBER, reason: "partner_named" },
      { row_number: 5, period: APR, mid: MID, agent_number: OWNER_NUMBER, reason: "line_not_shared" },
    ]);
  });

  it("wrote the pair, and the third rep's ordinary line, as the preview said", async () => {
    const { data } = await adminClient()
      .from("rep_payout_rows")
      .select("agent_id, share_role, rep_share_id, volume")
      .eq("mid", MID)
      .eq("period", MAR);
    const byAgent = new Map((data ?? []).map((l) => [l.agent_id as string, l]));

    expect(byAgent.get(fixtures.userIds.owner)?.share_role).toBe("primary");
    expect(byAgent.get(fixtures.userIds.intruder)?.share_role).toBe("secondary");
    expect(byAgent.get(fixtures.userIds.intruder)?.volume).toBeNull();
    expect(byAgent.get(fixtures.userIds.deactivated)?.share_role).toBeNull();
    expect(byAgent.get(fixtures.userIds.deactivated)?.rep_share_id).toBeNull();
    expect(byAgent.size).toBe(3);

    // April: the hand-made partner line untouched, no signer line written.
    const { data: april } = await adminClient()
      .from("rep_payout_rows")
      .select("agent_id, merchant_name")
      .eq("mid", MID)
      .eq("period", APR);
    expect(april).toEqual([{ agent_id: fixtures.userIds.intruder, merchant_name: "Hand-made line" }]);
  });

  it("will not let an admin's session clear the skip record over PATCH", async () => {
    const asAdmin = userClient(fixtures.tokens.admin);
    for (const patch of [{ skipped_rows: [] }, { skips_acknowledged_at: new Date().toISOString() }]) {
      const { error } = await asAdmin.from("rep_payout_batches").update(patch).eq("id", batchId);
      expect(error?.code, JSON.stringify(patch)).toBe("42501");
    }
    const { data } = await adminClient()
      .from("rep_payout_batches")
      .select("skipped_rows, skips_acknowledged_at")
      .eq("id", batchId)
      .single();
    expect((data?.skipped_rows as unknown[]).length).toBe(2);
    expect(data?.skips_acknowledged_at).toBeNull();
  });

  it("keeps the skip record from every rep, including the ones it names", async () => {
    for (const persona of ["owner", "intruder"] as const) {
      const { data } = await userClient(fixtures.tokens[persona])
        .from("rep_payout_batches")
        .select("skipped_rows")
        .eq("id", batchId);
      expect(data ?? [], persona).toEqual([]);
    }
  });

  it("acknowledges once: an agent is refused, the admin records it, a second time is refused", async () => {
    const agent = await userClient(fixtures.tokens.owner).rpc("acknowledge_residual_skips", {
      batch_id_input: batchId,
    });
    expect(agent.error?.message).toMatch(/admin only/i);

    const anon = await anonClient().rpc("acknowledge_residual_skips", { batch_id_input: batchId });
    expect(anon.error?.code).toBe("42501");

    const asAdmin = userClient(fixtures.tokens.admin);
    const first = await asAdmin.rpc("acknowledge_residual_skips", { batch_id_input: batchId });
    expect(first.error, first.error?.message).toBeNull();
    expect(typeof first.data).toBe("string");

    const second = await asAdmin.rpc("acknowledge_residual_skips", { batch_id_input: batchId });
    expect(second.error?.message).toBe("these skipped rows have already been reviewed");

    const { data: batch } = await adminClient()
      .from("rep_payout_batches")
      .select("skips_acknowledged_at, skipped_rows")
      .eq("id", batchId)
      .single();
    expect(batch?.skips_acknowledged_at).not.toBeNull();
    expect((batch?.skipped_rows as unknown[]).length).toBe(2);

    // Who reviewed it: one audit row, the admin, readable by the admin's session.
    const { data: audit } = await asAdmin
      .from("audit_log")
      .select("actor_id")
      .eq("action", "acknowledge_residual_skips")
      .eq("row_id", String(batchId));
    expect(audit).toEqual([{ actor_id: fixtures.userIds.admin }]);
  });

  it("the old commit refuses a shared batch with the reworded message", async () => {
    const { batchId: other } = await importFile(
      [HEADER, ["Mar-27", OWNER_NUMBER, MID, "Live Shared Co", 1000, 10, 25]],
      "live-shared-old.xlsx",
    );
    const { error } = await userClient(fixtures.tokens.admin).rpc("commit_residual_import", {
      batch_id_input: other,
    });
    expect(error?.code).toBe("PT409");
    expect(error?.message).toBe(
      "This import contains shared accounts, which this version of the CRM cannot commit. It needs the current version of the app.",
    );
  });
});

/**
 * Phase 5 of docs/design/residual-splits.md, end to end: a correction posted
 * through PostgREST, exported with Line = Adjustment, re-imported with the
 * adjustment lines skipped and counted on the batch; and the two new preview
 * flags, written by the real parser under Deno.
 *
 * Months are in 2029 so nothing else in the suite (2026 here, 2027 in the
 * shared describe and in e2e) is anywhere near them. The posting month is
 * whatever post_share_correction() computes on this stack -- the month after
 * the latest import line anywhere -- so it is read from the result, never
 * assumed.
 */
describe("phase 5: a correction round-trips as Line = Adjustment, and the new flags preview", () => {
  const JAN = "2029-01-01";
  const SIGNER_MID = "LIVE-MID-OWNER";
  const PARTNER_SHARE_MID = "LIVE-MID-INTRUDER";
  const LOOKS_MID = "LIVE-MID-LOOKS";
  const TWICE_MID = "LIVE-MID-TWICE";
  const INTRUDER_NUMBER = PERSONA_AGENT_NUMBERS.intruder as string;
  const NOTE = "Shared 40/10 with the intruder from January, agreed later";

  let posting: string;
  let partnerLine: number;
  let signerLine: number;

  const adjustmentColumns =
    "id, agent_id, period, mid, line_kind, adjustment_amount, adjusts_period, adjustment_note, rep_payout, residual_income, rep_split_pct, volume, batch_id";

  beforeAll(async () => {
    if (FUNCTIONS_DOWN) return;
    const service = adminClient();
    // January 2029: the signer's committed month, 100.01 at 50% -> T 50.01.
    const { error } = await service.from("rep_payout_rows").insert({
      agent_id: fixtures.userIds.owner,
      period: JAN,
      mid: SIGNER_MID,
      merchant_name: "Live Owner Co",
      merchant_id: fixtures.merchantIds.owner,
      residual_income: 100.01,
      rep_split_pct: 50,
    });
    expect(error, error?.message).toBeNull();
  });

  const args = () => ({
    merchant_id_input: fixtures.merchantIds.owner,
    original_period_input: JAN,
    partner_agent_id_input: fixtures.userIds.intruder,
    primary_rep_pct_input: 40,
    secondary_rep_pct_input: 10,
    note_input: NOTE,
  });

  it("refuses anon and an agent over PostgREST, and posts the pair for an admin", async () => {
    const anon = await anonClient().rpc("post_share_correction", args());
    expect(anon.error).not.toBeNull();

    const agent = await userClient(fixtures.tokens.owner).rpc("post_share_correction", args());
    expect(agent.error?.message).toBe("admin only");

    const { data, error } = await userClient(fixtures.tokens.admin).rpc("post_share_correction", args());
    expect(error, error?.message).toBeNull();
    // 50.01 x 10/50 = 10.002 -> 10.00; the signer keeps 40.01.
    expect(data).toMatchObject({ amount: 10 });
    posting = data.posting_period as string;
    partnerLine = data.partner_line_id as number;
    signerLine = data.signer_line_id as number;
    expect(posting > JAN).toBe(true);

    const { data: lines } = await adminClient()
      .from("rep_payout_rows")
      .select("agent_id, rep_payout, line_kind, adjusts_period")
      .in("id", [partnerLine, signerLine])
      .order("id");
    expect(lines).toEqual([
      { agent_id: fixtures.userIds.intruder, rep_payout: 10, line_kind: "adjustment", adjusts_period: JAN },
      { agent_id: fixtures.userIds.owner, rep_payout: -10, line_kind: "adjustment", adjusts_period: JAN },
    ]);
  });

  it("exports the pair with Line = Adjustment and blank figures, and a rep only their own line", async () => {
    const admin = await exportWorkbook(fixtures.tokens.admin, { period: posting });
    const header = admin.rows[0] as string[];
    const at = (name: string) => header.indexOf(name);
    const mine = admin.rows.slice(1).filter((row) => row[at("MID")] === SIGNER_MID);
    expect(mine.map((row) => [row[at("Agent #")], row[at("Residual income")], row[at("Rep split")], row[at("Rep payout")], row[at("Line")]])).toEqual(
      expect.arrayContaining([
        [OWNER_NUMBER, null, null, -10, "Adjustment"],
        [INTRUDER_NUMBER, null, null, 10, "Adjustment"],
      ]),
    );

    const owner = await exportWorkbook(fixtures.tokens.owner, { period: posting });
    const ownRows = owner.rows.slice(1).filter((row) => row[at("MID")] === SIGNER_MID);
    expect(ownRows).toHaveLength(1);
    expect(ownRows[0][at("Rep payout")]).toBe(-10);
    expect(ownRows[0][at("Line")]).toBe("Adjustment");
  });

  it("re-imports the export with the adjustment lines skipped, counted on the batch, and untouched", async () => {
    // The posting month gets an ordinary import line too, so the export is a
    // real month: one import line beside the two adjustments on the same MID.
    const { error: lineError } = await adminClient().from("rep_payout_rows").insert({
      agent_id: fixtures.userIds.owner,
      period: posting,
      mid: SIGNER_MID,
      merchant_name: "Live Owner Co",
      merchant_id: fixtures.merchantIds.owner,
      volume: 700,
    });
    expect(lineError, lineError?.message).toBeNull();

    const before = await adminClient()
      .from("rep_payout_rows")
      .select(adjustmentColumns)
      .in("id", [partnerLine, signerLine])
      .order("id");

    const exported = await exportWorkbook(fixtures.tokens.admin, { period: posting });
    const header = exported.rows[0] as string[];
    const adjustmentRows = exported.rows.slice(1).filter((row) => row[header.indexOf("Line")] === "Adjustment").length;
    expect(adjustmentRows).toBeGreaterThanOrEqual(2);

    const back = await importFile(exported.rows, "round-trip-adjustments.xlsx");
    expect(back.parse.status, back.parse.raw).toBe(200);
    expect(back.parse.body).toMatchObject({
      blocked_count: 0,
      adjustments_ignored: adjustmentRows,
      row_count: exported.rows.length - 1 - adjustmentRows,
    });

    const { data: batch } = await adminClient()
      .from("rep_payout_batches")
      .select("adjustment_rows_ignored")
      .eq("id", back.batchId)
      .single();
    expect(batch?.adjustment_rows_ignored).toBe(adjustmentRows);

    // No staged row is an adjustment's: the signer's MID is staged once.
    const staged = await stagedRows(back.batchId);
    const { data: stagedMids } = await adminClient()
      .from("rep_payout_import_rows")
      .select("mid_raw, agent_number_raw")
      .eq("batch_id", back.batchId)
      .eq("mid_raw", SIGNER_MID);
    expect(stagedMids).toEqual([{ mid_raw: SIGNER_MID, agent_number_raw: OWNER_NUMBER }]);
    expect(staged.every((row) => row.blocker === null)).toBe(true);

    const { data, error } = await userClient(fixtures.tokens.admin).rpc("commit_residual_import_v2", {
      batch_id_input: back.batchId,
    });
    expect(error, error?.message).toBeNull();
    expect(data).toMatchObject({ skipped: 0 });

    const after = await adminClient()
      .from("rep_payout_rows")
      .select(adjustmentColumns)
      .in("id", [partnerLine, signerLine])
      .order("id");
    expect(after.data).toEqual(before.data);

    // The import line merged as always; still exactly three lines on the MID.
    const { data: onMid } = await adminClient()
      .from("rep_payout_rows")
      .select("line_kind, volume")
      .eq("mid", SIGNER_MID)
      .eq("period", posting)
      .order("id");
    expect(onMid).toEqual([
      { line_kind: "adjustment", volume: null },
      { line_kind: "adjustment", volume: null },
      { line_kind: "import", volume: 700 },
    ]);
  });

  describe("the two new preview flags", () => {
    let batchId: number;
    let parse: Awaited<ReturnType<typeof invoke>>;

    beforeAll(async () => {
      if (FUNCTIONS_DOWN) return;
      const service = adminClient();
      // A share on the intruder's merchant that starts in June 2029: March is
      // outside it.
      const { error: shareError } = await userClient(fixtures.tokens.admin).rpc("set_merchant_rep_share", {
        merchant_id_input: fixtures.merchantIds.intruder,
        primary_agent_id_input: fixtures.userIds.intruder,
        secondary_agent_id_input: fixtures.userIds.owner,
        primary_rep_pct_input: 25,
        secondary_rep_pct_input: 25,
        effective_from_input: "2029-06-01",
      });
      expect(shareError, shareError?.message).toBeNull();

      // The intruder was paid on a MID no merchant has, in January.
      const { error } = await service.from("rep_payout_rows").insert({
        agent_id: fixtures.userIds.intruder,
        period: JAN,
        mid: LOOKS_MID,
        merchant_name: "Looks Shared Co",
      });
      expect(error, error?.message).toBeNull();

      ({ batchId, parse } = await importFile(
        [
          HEADER,
          // row 2: a share on the MID that does not cover March -> share_not_in_force
          ["Mar-29", INTRUDER_NUMBER, PARTNER_SHARE_MID, "Live Intruder Co", 100, 10, 1],
          // row 3: another rep paid in January, no share -> looks_shared (no merchant)
          ["Mar-29", OWNER_NUMBER, LOOKS_MID, "Looks Shared Co", 100, 10, 1],
          // rows 4-5: the same MID under two Agent #s in this file -> both looks_shared
          ["Mar-29", OWNER_NUMBER, TWICE_MID, "Twice Co", 100, 10, 1],
          ["Mar-29", INTRUDER_NUMBER, TWICE_MID, "Twice Co", 100, 10, 1],
          // row 6: the signer's MID, where the only other rep is on an ADJUSTMENT line -> nothing
          ["Mar-29", OWNER_NUMBER, SIGNER_MID, "Live Owner Co", 100, 10, 1],
        ],
        "live-phase5-flags.xlsx",
      ));
    });

    it("stores share_not_in_force and looks_shared on the staged rows, blocking nothing", async () => {
      expect(parse.status, parse.raw).toBe(200);
      expect(parse.body).toMatchObject({ row_count: 5, blocked_count: 0, flagged_count: 4, adjustments_ignored: 0 });

      const { data } = await adminClient()
        .from("rep_payout_import_rows")
        .select("row_number, blocker, preview_flag, preview_note")
        .eq("batch_id", batchId)
        .order("row_number");
      const staged = data ?? [];
      expect(staged.map((r) => [r.row_number, r.blocker, r.preview_flag])).toEqual([
        [2, null, "share_not_in_force"],
        [3, null, "looks_shared"],
        [4, null, "looks_shared"],
        [5, null, "looks_shared"],
        [6, null, null],
      ]);
      const note = (n: number) => staged.find((r) => r.row_number === n)?.preview_note as string;
      expect(note(2)).toBe(
        `MID ${PARTNER_SHARE_MID} has a share (Live Intruder Agent / Live Owner Agent, from June 2029), but it does not cover March 2029. This row imports as an ordinary line paying Live Intruder Agent the whole rep side.`,
      );
      expect(note(3)).toBe(
        `MID ${LOOKS_MID} is also paid to Live Intruder Agent within the six months to March 2029, and no share is set on it. This row imports for Live Owner Agent alone. No merchant in the CRM has this MID, so a share cannot be set on it until one is added.`,
      );
      expect(note(4)).toContain("is also paid to Live Intruder Agent");
      expect(note(5)).toContain("is also paid to Live Owner Agent");
    });

    it("commits every flagged row through v2: the flags predict no skip", async () => {
      const { data, error } = await userClient(fixtures.tokens.admin).rpc("commit_residual_import_v2", {
        batch_id_input: batchId,
      });
      expect(error, error?.message).toBeNull();
      expect(data).toEqual({ written: 5, skipped: 0 });
    });
  });
});
