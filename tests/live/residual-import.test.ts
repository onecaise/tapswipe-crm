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
  functionsAreServed,
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

beforeAll(async () => {
  if (!(await functionsAreServed())) {
    throw new Error(
      "The local functions runtime is not answering. Run `supabase start` and " +
        "`supabase functions serve` before this suite.",
    );
  }
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

  it("carries the nine importable headers, plus two the parser ignores", async () => {
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
