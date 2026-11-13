// The residual import cycle, against a real running stack.
//
// This belongs here rather than in tests/rls for things PGlite structurally cannot
// do: the parser runs in Deno, SheetJS has to load there at all, the file goes
// through Storage signed URLs, and the two functions authenticate their own JWTs.
// tests/rls/commit-residual-import*.test.ts cover the commit's rules in SQL;
// tests/unit/residuals-parse.test.ts covers the parsing rules. What only this
// suite can prove is that the pieces meet.
//
// THE FILE (phase 7 of docs/design/intake-and-reports.md): six columns,
// Processor, Merchant Number, Merchant Name, Income Type, Volume, Residual. The
// processor and month are chosen at upload and are the batch's; each row is
// paid to the owner of the merchant its Merchant Number names. So every MID a
// test imports belongs to a merchant this file creates (digits only, unique per
// run), and every batch takes a processor-month no other batch on the stack uses
// (freeSlot), because one committed batch per processor-month is the rule and the
// local database is shared with the e2e suite.
//
// The single most valuable assertion here is the round trip in
// "reads a real workbook": a workbook built by SheetJS in Node, uploaded to
// Storage, and read back by SheetJS in Deno, Merchant Numbers still text. If the
// CDN import specifier ever stops resolving, this is what fails -- loudly, rather
// than at deploy time.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import {
  PERSONA_AGENT_NUMBERS,
  RESIDUAL_BUCKET,
  adminClient,
  anonClient,
  skipWhenFunctionsDown,
  getStackConfig,
  invoke,
  provisionFixtures,
  teardownFixtures,
  toReachableUrl,
  userClient,
  warmFunctions,
  type Fixtures,
  type PersonaKey,
} from "./helpers/stack";

const FUNCTIONS = [
  "residual-import-file-url",
  "parse-residual-import",
  "export-residuals",
] as const;

const PROCESSOR = "TSYS";
const OWNER_NUMBER = PERSONA_AGENT_NUMBERS.owner as string;

const HEADER = [
  "Processor",
  "Merchant Number",
  "Merchant Name",
  "Income Type",
  "Volume",
  "Residual",
];

let fixtures: Fixtures;

/** Batches created here, so each test can clean up after itself. */
const batchIds: number[] = [];

/** 12-digit MIDs, unique to this run: one digit, six of the clock, a counter. */
const RUN = String(Date.now()).slice(-6);
let midCounter = 0;
function newMid(lead = "7"): string {
  midCounter += 1;
  return `${lead}${RUN}${String(midCounter).padStart(5, "0")}`;
}

/** The 1st of the month `offset` months from the current UTC month. */
function month(offset: number): string {
  const now = new Date();
  const index = now.getUTCFullYear() * 12 + now.getUTCMonth() + offset;
  const y = Math.floor(index / 12);
  return `${y}-${String(index - y * 12 + 1).padStart(2, "0")}-01`;
}

/** `period` moved by `n` months. Arithmetic, never Date. */
function shift(period: string, n: number): string {
  const [y, m] = period.split("-").map(Number);
  const index = y * 12 + (m - 1) + n;
  const yy = Math.floor(index / 12);
  return `${yy}-${String(index - yy * 12 + 1).padStart(2, "0")}-01`;
}

/** "July 2026", as the parser's notes write a month. */
function label(period: string): string {
  const names = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  return `${names[Number(period.slice(5, 7)) - 1]} ${period.slice(0, 4)}`;
}

/** Every processor the CRM has (20261023130000). */
const PROCESSORS = ["TSYS", "Red Fynn", "PayBright", "Netevia HQ", "Square"];

type Slot = { processor: string; period: string };

const taken = new Set<string>();
/**
 * A processor-month no batch on the stack uses yet, inside the import window,
 * newest first, across all five processors (one processor alone has only 25
 * months, fewer than this file imports). `processor` pins it; `also` needs
 * those processors free in the same month too (and reserves them); `before`
 * wants a month strictly earlier.
 */
async function freeSlot(
  options: { processor?: string; also?: string[]; before?: string } = {},
): Promise<Slot> {
  const { data, error } = await adminClient().from("rep_payout_batches").select("processor, period");
  expect(error, error?.message).toBeNull();
  const busy = (processor: string, period: string) =>
    taken.has(`${processor}|${period}`) ||
    (data ?? []).some((b) => b.processor === processor && b.period === period);
  for (let back = 0; back <= 24; back += 1) {
    const period = month(-back);
    if (options.before !== undefined && period >= options.before) continue;
    for (const processor of options.processor ? [options.processor] : PROCESSORS) {
      const all = [processor, ...(options.also ?? [])];
      if (all.some((p) => busy(p, period))) continue;
      for (const p of all) taken.add(`${p}|${period}`);
      return { processor, period };
    }
  }
  throw new Error(`no free processor-month in the import window`);
}

/**
 * A merchant owned by `persona`, with this MID. Teardown removes it with them.
 * Its split rate is 50 unless a test says otherwise: commit v3 pays at the
 * merchant's own rate and refuses a merchant with none (20261030160000).
 */
async function merchantFor(
  persona: PersonaKey,
  mid: string,
  fields: { status?: string; processor?: string | null; dba?: string; rate?: number } = {},
): Promise<number> {
  const rate = fields.rate ?? 50;
  const { data, error } = await adminClient()
    .from("merchants")
    .insert({
      agent_id: fixtures.userIds[persona],
      mid,
      dba: fields.dba ?? `Live ${mid} Co`,
      city: "Nashville",
      state: "TN",
      legal_business_name: `Live ${mid} Co LLC`,
      status: fields.status ?? "active",
      // No saved processor unless a test says so: that is never a mismatch
      // (A6), whichever processor the batch has.
      processor: fields.processor ?? null,
      split_agent_pct: rate,
      split_company_pct: 100 - rate,
    })
    .select("id")
    .single();
  expect(error, error?.message).toBeNull();
  return data!.id as number;
}

/** Stands for "the batch's processor" in a row; importFile fills it in. */
const BATCH = "<the batch's processor>";

/** One file row; every cell defaulted so a test varies only what it is about. */
function line(
  mid: unknown,
  cells: {
    processor?: unknown;
    name?: unknown;
    incomeType?: unknown;
    volume?: unknown;
    residual?: unknown;
  } = {},
): unknown[] {
  return [
    "processor" in cells ? cells.processor : BATCH,
    mid,
    "name" in cells ? cells.name : "Live Co",
    "incomeType" in cells ? cells.incomeType : "Residuals",
    "volume" in cells ? cells.volume : "$1,000.00",
    "residual" in cells ? cells.residual : "$25.00",
  ];
}

function workbook(rows: unknown[][]): Buffer {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), "Residuals");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

async function mint(fileName: string, processor: string, period: string, replaceBatchId?: number) {
  return invoke(
    "residual-import-file-url",
    {
      file_name: fileName,
      processor,
      period,
      ...(replaceBatchId === undefined ? {} : { replace_batch_id: replaceBatchId }),
    },
    fixtures.tokens.admin,
  );
}

/** Mints an upload URL, PUTs the bytes, and parses -- the browser's three steps. */
async function importFile(
  rows: unknown[][],
  options: { fileName?: string; processor?: string; period?: string; bytes?: Buffer; replaces?: number } = {},
): Promise<{
  batchId: number;
  period: string;
  processor: string;
  parse: Awaited<ReturnType<typeof invoke>>;
}> {
  const { processor, period } =
    options.period !== undefined
      ? { processor: options.processor ?? PROCESSOR, period: options.period }
      : await freeSlot({ processor: options.processor });
  rows = rows.map((row) => row.map((cell) => (cell === BATCH ? processor : cell)));
  const minted = await mint(options.fileName ?? "live-residuals.xlsx", processor, period, options.replaces);
  expect(minted.status, minted.raw).toBe(200);
  expect(minted.body.exists, minted.raw).toBeUndefined();

  const batchId = minted.body.batch_id as number;
  batchIds.push(batchId);

  const asAdmin = userClient(fixtures.tokens.admin);
  const { error } = await asAdmin.storage
    .from(RESIDUAL_BUCKET)
    .uploadToSignedUrl(
      minted.body.path as string,
      minted.body.token as string,
      options.bytes ?? workbook(rows),
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

  return { batchId, period, processor, parse };
}

type Staged = {
  row_number: number;
  period: string;
  agent_id: string | null;
  merchant_id: number | null;
  mid_raw: string | null;
  processor_raw: string | null;
  income_type_raw: string | null;
  volume: number | null;
  residual_income: number | null;
  rep_split_pct: number | null;
  blocker: string | null;
  blockers: string[];
  warnings: string[];
  preview_flag: string | null;
  preview_note: string | null;
  error: string | null;
};

async function stagedRows(batchId: number): Promise<Staged[]> {
  const { data } = await adminClient()
    .from("rep_payout_import_rows")
    .select(
      "row_number, period, agent_id, merchant_id, mid_raw, processor_raw, income_type_raw, volume, residual_income, rep_split_pct, blocker, blockers, warnings, preview_flag, preview_note, error",
    )
    .eq("batch_id", batchId)
    .order("row_number");
  return (data ?? []) as Staged[];
}

async function ledgerFor(mid: string, period: string) {
  const { data } = await adminClient()
    .from("rep_payout_rows")
    .select("mid, agent_id, processor, volume, residual_income, rep_split_pct, rep_payout, batch_id")
    .eq("mid", mid)
    .eq("period", period)
    .maybeSingle();
  return data;
}

/** commit_residual_import_v3, as the commit button calls it, with the yes answers. */
async function commitV3(batchId: number, confirmed: string[] = []) {
  return userClient(fixtures.tokens.admin).rpc("commit_residual_import_v3", {
    batch_id_input: batchId,
    confirmed_input: confirmed,
  });
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
  // teardownFixtures clears the payout FKs, the personas' merchants and the
  // bucket; batches created here belong to the admin persona and go with them.
  await teardownFixtures();
});

/** Downloads the export as raw bytes, so a test can read the workbook back. */
async function exportWorkbook(
  token: string,
  body: Record<string, unknown> = {},
): Promise<{ status: number; rows: unknown[][] }> {
  const { apiUrl, anonKey } = getStackConfig();
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
        ? { file_name: "should-not-exist.xlsx", processor: PROCESSOR, period: month(-1) }
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

describe("the upload takes the processor and month, and is the replace prompt's source", () => {
  const nothingNamed = async (fileName: string) => {
    const { data } = await adminClient()
      .from("rep_payout_batches")
      .select("id")
      .eq("file_name", fileName);
    return data ?? [];
  };

  it("refuses a missing or unknown processor, creating nothing", async () => {
    const missing = await invoke(
      "residual-import-file-url",
      { file_name: "no-processor.xlsx", period: month(-1) },
      fixtures.tokens.admin,
    );
    expect(missing.status, missing.raw).toBe(400);
    expect(missing.body.error).toBe("Choose the processor this file is from.");

    const unknown = await mint("no-processor.xlsx", "Tsys", month(-1));
    expect(unknown.status, unknown.raw).toBe(400);
    expect(unknown.body.error).toBe('"Tsys" is not a processor in the CRM.');
    expect(await nothingNamed("no-processor.xlsx")).toEqual([]);
  });

  it("refuses a malformed month, creating nothing", async () => {
    for (const period of [undefined, "2026-07", "2026-07-15", "2026-13-01", 202607]) {
      const response = await invoke(
        "residual-import-file-url",
        { file_name: "bad-month.xlsx", processor: PROCESSOR, period },
        fixtures.tokens.admin,
      );
      expect(response.status, `${String(period)}: ${response.raw}`).toBe(400);
      expect(String(response.body.error)).toMatch(/Choose the month/);
    }
    expect(await nothingNamed("bad-month.xlsx")).toEqual([]);
  });

  it("refuses a future month and one more than 24 months back, with the database's sentence (A11)", async () => {
    const future = await mint("out-of-window.xlsx", PROCESSOR, month(1));
    expect(future.status, future.raw).toBe(400);
    expect(String(future.body.error)).toMatch(/is in the future/);

    const old = await mint("out-of-window.xlsx", PROCESSOR, month(-25));
    expect(old.status, old.raw).toBe(400);
    expect(String(old.body.error)).toMatch(/more than 24 months ago/);
    expect(await nothingNamed("out-of-window.xlsx")).toEqual([]);
  });

  it("stores the chosen processor and month on the batch", async () => {
    const { period } = await freeSlot({ processor: "Red Fynn" });
    const minted = await mint("stored.xlsx", "Red Fynn", period);
    expect(minted.status, minted.raw).toBe(200);
    batchIds.push(minted.body.batch_id as number);
    const { data } = await adminClient()
      .from("rep_payout_batches")
      .select("processor, period, status")
      .eq("id", minted.body.batch_id as number)
      .single();
    expect(data).toEqual({ processor: "Red Fynn", period, status: "review" });
  });

  it("answers a committed processor-month with its facts, and creates NO batch until the admin says Yes", async () => {
    const mid = newMid();
    await merchantFor("owner", mid);
    // A month where TSYS and Square are both free, so the second processor's
    // answer below is about the pair, not about some other batch.
    const { period } = await freeSlot({ processor: PROCESSOR, also: ["Square"] });
    const { batchId } = await importFile([HEADER, line(mid)], { fileName: "first.xlsx", processor: PROCESSOR, period });
    expect((await commitV3(batchId)).error).toBeNull();

    const again = await mint("second.xlsx", PROCESSOR, period);
    expect(again.status, again.raw).toBe(200);
    expect(again.body).toEqual({
      exists: {
        batch_id: batchId,
        file_name: "first.xlsx",
        committed_at: expect.any(String),
        paid: false,
      },
    });
    expect(await nothingNamed("second.xlsx")).toEqual([]);

    // Another processor, same month: a different pair, so a batch is created.
    const other = await mint("other-processor.xlsx", "Square", period);
    expect(other.status, other.raw).toBe(200);
    expect(other.body.batch_id).toEqual(expect.any(Number));
    batchIds.push(other.body.batch_id as number);
  });
});

describe("replace over HTTP: Yes, read, review, commit (phase 9)", () => {
  const asAdmin = () => userClient(fixtures.tokens.admin);
  const typed = (period: string) => `${PROCESSOR} ${label(period)}`;
  const reopen = (period: string) =>
    asAdmin().rpc("reopen_payout_period", {
      period_input: period,
      processor_input: PROCESSOR,
      reason_input: "Live test cleanup: reopening its own month.",
    });

  async function committedMonth(mid: string, residual = "$25.00") {
    const slot = await freeSlot({ processor: PROCESSOR });
    const { batchId } = await importFile([HEADER, line(mid, { residual })], { fileName: "original.xlsx", ...slot });
    expect((await commitV3(batchId)).error).toBeNull();
    return { batchId, period: slot.period };
  }

  it("Yes creates a batch that replaces the committed one; it is read, reviewed and committed through v3", async () => {
    const mid = newMid();
    const other = newMid();
    await merchantFor("owner", mid);
    await merchantFor("owner", other);
    const old = await committedMonth(mid);

    const next = await importFile([HEADER, line(mid, { residual: "$40.00" }), line(other, { residual: "$2.00" })], {
      fileName: "corrected.xlsx",
      processor: PROCESSOR,
      period: old.period,
      replaces: old.batchId,
    });
    expect(next.parse.status, next.parse.raw).toBe(200);
    const { data: batch } = await adminClient()
      .from("rep_payout_batches")
      .select("status, replaces_batch_id, processor, period")
      .eq("id", next.batchId)
      .single();
    expect(batch).toEqual({ status: "review", replaces_batch_id: old.batchId, processor: PROCESSOR, period: old.period });
    // Nothing changes until the commit.
    expect((await ledgerFor(mid, old.period))?.residual_income).toBe(25);

    const { data: result, error } = await commitV3(next.batchId);
    expect(error, error?.message).toBeNull();
    expect(result).toMatchObject({ written: 2, rows: 2, replaced_lines: 1 });
    expect(await ledgerFor(mid, old.period)).toMatchObject({ residual_income: 40, batch_id: next.batchId });
    expect(await ledgerFor(other, old.period)).toMatchObject({ residual_income: 2, batch_id: next.batchId });

    const { data: replaced } = await adminClient()
      .from("rep_payout_batches")
      .select("status, replaced_by_batch_id")
      .eq("id", old.batchId)
      .single();
    expect(replaced).toEqual({ status: "replaced", replaced_by_batch_id: next.batchId });

    // The old file is kept, and still signs for download.
    const download = await invoke("residual-import-file-url", { batch_id: old.batchId }, fixtures.tokens.admin);
    expect(download.status, download.raw).toBe(200);
    const bytes = await fetch(toReachableUrl(download.body.signedUrl as string));
    expect(bytes.status).toBe(200);

    // One audit row each: both commits, then the replace of the old one.
    const { data: audit } = await adminClient()
      .from("audit_log")
      .select("action, row_id")
      .in("action", ["commit_residual_import", "replace_residual_import"])
      .in("row_id", [String(old.batchId), String(next.batchId)])
      .order("id");
    expect(audit).toEqual([
      { action: "commit_residual_import", row_id: String(old.batchId) },
      { action: "commit_residual_import", row_id: String(next.batchId) },
      { action: "replace_residual_import", row_id: String(old.batchId) },
    ]);
  });

  it("refuses the Yes once the month is marked paid, and says so; the prompt carries paid: true", async () => {
    const mid = newMid();
    await merchantFor("owner", mid);
    const old = await committedMonth(mid);
    const close = await asAdmin().rpc("close_payout_period", {
      period_input: old.period,
      processor_input: PROCESSOR,
      confirmation_input: typed(old.period),
    });
    expect(close.error, close.error?.message).toBeNull();
    try {
      const prompt = await mint("paid.xlsx", PROCESSOR, old.period);
      expect(prompt.body.exists).toMatchObject({ batch_id: old.batchId, paid: true });

      const yes = await mint("paid.xlsx", PROCESSOR, old.period, old.batchId);
      expect(yes.status, yes.raw).toBe(409);
      expect(yes.body.error).toBe(
        `${PROCESSOR} for ${label(old.period)} is marked paid and cannot be replaced. Reopen it (with a reason) on the Payouts page, or post an adjustment instead.`,
      );
      const { data } = await adminClient().from("rep_payout_batches").select("id").eq("file_name", "paid.xlsx");
      expect(data).toEqual([]);
    } finally {
      expect((await reopen(old.period)).error).toBeNull();
    }
  });

  it("refuses a Yes naming a batch that is not the committed one, creating nothing", async () => {
    const mid = newMid();
    await merchantFor("owner", mid);
    const old = await committedMonth(mid);
    const wrong = await mint("wrong.xlsx", PROCESSOR, old.period, old.batchId + 100000);
    expect(wrong.status, wrong.raw).toBe(409);
    expect(wrong.body.error).toMatch(/is no longer the committed import for/);
    const free = await freeSlot({ processor: PROCESSOR });
    const nothing = await mint("wrong.xlsx", PROCESSOR, free.period, old.batchId);
    expect(nothing.status, nothing.raw).toBe(409);
    const bad = await mint("wrong.xlsx", PROCESSOR, old.period, -1);
    expect(bad.status, bad.raw).toBe(400);
    const { data } = await adminClient().from("rep_payout_batches").select("id").eq("file_name", "wrong.xlsx");
    expect(data).toEqual([]);
  });

  it("the database refuses the replace when the month was marked paid AFTER the Yes", async () => {
    const mid = newMid();
    await merchantFor("owner", mid);
    const old = await committedMonth(mid);
    const next = await importFile([HEADER, line(mid, { residual: "$1.00" })], {
      fileName: "late.xlsx",
      processor: PROCESSOR,
      period: old.period,
      replaces: old.batchId,
    });
    const close = await asAdmin().rpc("close_payout_period", {
      period_input: old.period,
      processor_input: PROCESSOR,
      confirmation_input: typed(old.period),
    });
    expect(close.error, close.error?.message).toBeNull();
    try {
      const { error } = await commitV3(next.batchId);
      expect(error?.code).toBe("PT409");
      expect(error?.message).toMatch(/is marked paid and cannot be replaced/);
      expect((await ledgerFor(mid, old.period))?.batch_id).toBe(old.batchId);
    } finally {
      expect((await reopen(old.period)).error).toBeNull();
    }
  });

  it("a rep and anon reach none of the phase 9 functions over PostgREST, and nobody DELETEs ledger lines", async () => {
    const calls: [string, Record<string, unknown>][] = [
      ["close_payout_period", { period_input: month(-1), processor_input: PROCESSOR, confirmation_input: "x" }],
      ["reopen_payout_period", { period_input: month(-1), processor_input: PROCESSOR, reason_input: "a reason here" }],
      ["delete_payout_period", { period_input: month(-1), processor_input: PROCESSOR }],
      ["post_payout_adjustment", {
        agent_id_input: fixtures.userIds.owner, mid_input: "x", adjusts_period_input: month(-1),
        processor_input: PROCESSOR, amount_input: 1, note_input: "note",
      }],
    ];
    for (const [fn, args] of calls) {
      const rep = await userClient(fixtures.tokens.owner).rpc(fn, args);
      expect(rep.error?.code, fn).toBe("PT403");
      const anon = await anonClient().rpc(fn, args);
      expect(anon.error?.code, fn).toBe("42501");
    }
    const { error } = await asAdmin().from("rep_payout_rows").delete().eq("mid", "nothing-here");
    expect(error?.code).toBe("42501");
  });
});

describe("it reads a real workbook end to end", () => {
  it("uploads, parses with SheetJS under Deno, and stages what it read", async () => {
    // The load-bearing round trip: built by SheetJS in Node, read by SheetJS in
    // Deno. Nothing else in the repo proves that import resolves at all.
    const zeroLed = newMid("0");
    const twelve = newMid("8");
    const ownerMerchant = await merchantFor("owner", zeroLed);
    const intruderMerchant = await merchantFor("intruder", twelve);

    const sheet = XLSX.utils.aoa_to_sheet([
      // A BOM, an apostrophe and stray whitespace on the headers, in any case.
      ["\uFEFFprocessor", "'Merchant Number", "  merchant name ", "INCOME TYPE", "Volume", " Residual"],
      // Text MID with a leading zero; currency text.
      line(zeroLed, { volume: "$76,877.18", residual: "-$11.76", incomeType: " residuals " }),
      // A 12-digit MID stored as a NUMBER cell, shown in full by a "0" format
      // (in General format it shows as 7.12345E+11 and is refused: below).
      line(Number(twelve), { volume: 12400, residual: 310.5 }),
    ]);
    sheet.B3.z = "0";
    delete sheet.B3.w;
    const slot = await freeSlot();
    for (const cell of ["A2", "A3"]) sheet[cell].v = slot.processor;
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "Residuals");
    const { batchId, period, processor, parse } = await importFile([], {
      ...slot,
      bytes: XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer,
    });

    expect(parse.status, parse.raw).toBe(200);
    expect(parse.body).toEqual({
      batch_id: batchId,
      row_count: 2,
      blocked_count: 0,
      flagged_count: 0,
      warning_counts: {},
      skipped_count: 0,
      blank_as_zero_count: 0,
    });

    const staged = await stagedRows(batchId);
    expect(staged).toEqual([
      expect.objectContaining({
        row_number: 2,
        period,
        mid_raw: zeroLed,
        // The payee is the merchant's owner, found by MID.
        agent_id: fixtures.userIds.owner,
        merchant_id: ownerMerchant,
        processor_raw: processor,
        income_type_raw: "residuals",
        volume: 76877.18,
        residual_income: -11.76,
        // Not read from the file and not decided by the parser (phase 8).
        rep_split_pct: null,
        blocker: null,
        blockers: [],
        warnings: [],
      }),
      expect.objectContaining({
        row_number: 3,
        mid_raw: twelve,
        agent_id: fixtures.userIds.intruder,
        merchant_id: intruderMerchant,
        volume: 12400,
        residual_income: 310.5,
        blocker: null,
      }),
    ]);
  });

  it("refuses every unknown MID, listing each, and nothing else -- then Read again clears it", async () => {
    const known = newMid();
    const unknownA = newMid();
    const unknownB = newMid();
    await merchantFor("owner", known);

    const { batchId, parse } = await importFile([
      HEADER,
      line(known),
      line(unknownA),
      line(unknownB),
    ]);
    expect(parse.body).toMatchObject({ row_count: 3, blocked_count: 2 });

    const staged = await stagedRows(batchId);
    expect(staged.map((r) => [r.mid_raw, r.blocker, r.blockers])).toEqual([
      [known, null, []],
      [unknownA, "unknown_mid", ["unknown_mid"]],
      [unknownB, "unknown_mid", ["unknown_mid"]],
    ]);
    expect(staged[1].error).toBe(
      `MID ${unknownA} is not a merchant in the CRM. Add the merchant (or correct its MID), then Read again.`,
    );

    // The whole batch is refused: v3 will not commit it.
    const refused = await commitV3(batchId);
    expect(refused.error?.message).toMatch(/2 of 3 rows are still blocked/);

    // The fix the review screen asks for: add the merchants, then read the SAME
    // file again. No re-upload.
    await merchantFor("intruder", unknownA);
    await merchantFor("owner", unknownB);
    const again = await invoke("parse-residual-import", { batch_id: batchId }, fixtures.tokens.admin);
    expect(again.body).toMatchObject({ row_count: 3, blocked_count: 0 });
    const reread = await stagedRows(batchId);
    expect(reread).toHaveLength(3);
    expect(reread.map((r) => r.agent_id)).toEqual([
      fixtures.userIds.owner,
      fixtures.userIds.intruder,
      fixtures.userIds.owner,
    ]);
  });

  it("refuses a MID repeated in the file, on every row it appears", async () => {
    const mid = newMid();
    await merchantFor("owner", mid);
    const { batchId, parse } = await importFile([HEADER, line(mid), line(newMidKnown()), line(mid)]);
    expect(parse.body).toMatchObject({ row_count: 3, blocked_count: 2 });
    const staged = await stagedRows(batchId);
    expect(staged.map((r) => r.blocker)).toEqual(["duplicate_mid", null, "duplicate_mid"]);
    expect(staged[0].error).toBe(`MID ${mid} appears on rows 2, 4. Fix the file and upload it again.`);
  });

  it("stages another Income Type for the other_income_type warning, not a refusal (phase 15)", async () => {
    const a = newMid();
    const b = newMid();
    await merchantFor("owner", a);
    await merchantFor("owner", b);
    const { batchId, parse } = await importFile([
      HEADER,
      line(a),
      line(b, { incomeType: "ACH" }),
    ]);
    expect(parse.body).toMatchObject({ row_count: 2, blocked_count: 0, warning_counts: { other_income_type: 1 } });
    const staged = await stagedRows(batchId);
    expect(staged[1]).toMatchObject({ blocker: null, income_type_raw: "ACH", warnings: ["other_income_type"] });
    expect((await commitV3(batchId)).error?.details).toBe("other_income_type");
    expect((await commitV3(batchId, ["other_income_type"])).error).toBeNull();
  });

  it("reads a blank figure on a row with a MID as 0, refuses an unreadable one, and keeps every problem a row has", async () => {
    const a = newMid();
    await merchantFor("owner", a);
    const stranger = newMid();
    const { batchId, parse } = await importFile([
      HEADER,
      line(a, { residual: null }),
      line(stranger, { incomeType: "Bonus", volume: "12,99" }),
    ]);
    expect(parse.body).toMatchObject({ blank_as_zero_count: 1 });
    const staged = await stagedRows(batchId);
    expect(staged[0]).toMatchObject({ blocker: null, blockers: [], residual_income: 0 });
    // The raw cell stays blank: the review screen counts blank-as-zero rows by it.
    const { data: raw } = await adminClient()
      .from("rep_payout_import_rows")
      .select("residual_income_raw")
      .eq("batch_id", batchId)
      .eq("row_number", 2)
      .single();
    expect(raw?.residual_income_raw).toBeNull();
    expect(staged[1].blockers).toEqual(["unknown_mid", "unreadable_number"]);
    expect(staged[1].blocker).toBe("unknown_mid");
    expect(staged[1].error).toContain(`MID ${stranger} is not a merchant in the CRM.`);
    expect(staged[1].error).toContain('Volume "12,99" has a comma that is not a thousands separator');
  });

  it("refuses a MID another processor's import already paid this month (a NULL processor counts)", async () => {
    const tagged = newMid();
    const legacy = newMid();
    await merchantFor("owner", tagged);
    await merchantFor("owner", legacy);
    // A TSYS batch, so the Square line below is another processor's.
    const { period } = await freeSlot({ processor: PROCESSOR });
    // A Square line for `tagged`, and a line with no processor (as everything
    // committed before phase 7 has) for `legacy`, in the same month.
    const { error } = await adminClient()
      .from("rep_payout_rows")
      .insert([
        { line_kind: "import", agent_id: fixtures.userIds.owner, period, mid: tagged, processor: "Square", volume: 1 },
        { line_kind: "import", agent_id: fixtures.userIds.owner, period, mid: legacy, processor: null, volume: 1 },
      ]);
    expect(error, error?.message).toBeNull();

    const { batchId } = await importFile([HEADER, line(tagged), line(legacy)], { processor: PROCESSOR, period });
    const staged = await stagedRows(batchId);
    expect(staged.map((r) => r.blocker)).toEqual(["mid_in_other_batch", "mid_in_other_batch"]);
    expect(staged[0].error).toBe(
      `MID ${tagged} already has a line for ${label(period)} from another processor's import. Two processors cannot both pay one MID for one month.`,
    );
  });

  it("rejects a file missing a required column, before staging anything", async () => {
    const { batchId, parse } = await importFile([
      ["Processor", "Merchant Number"],
      [PROCESSOR, newMid()],
    ]);

    expect(parse.status, parse.raw).toBe(400);
    // Names the columns rather than producing one blocker per row: a file with the
    // wrong shape has no rows worth reviewing.
    expect(String(parse.body.error)).toContain("Merchant Name, Income Type, Volume, Residual");
    expect(await stagedRows(batchId)).toEqual([]);
  });

  it("rejects the old Agent # file, and the CRM's own export, as not a processor file", async () => {
    const { batchId, parse } = await importFile([
      ["Period", "Agent #", "MID", "Merchant name", "Volume", "Average ticket", "Total cost"],
      ["Jul-26", OWNER_NUMBER, newMid(), "Old Format Co", 1, 1, 1],
    ]);
    expect(parse.status, parse.raw).toBe(400);
    expect(String(parse.body.error)).toMatch(/looks like a CRM export, not a processor file/);
    expect(await stagedRows(batchId)).toEqual([]);
  });

  it("rejects something that is not a spreadsheet", async () => {
    const { parse } = await importFile([], {
      fileName: "not-a-workbook.xlsx",
      bytes: Buffer.from("Processor,Merchant Number\nthis is a csv, not xlsx\n"),
    });

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
    const slot = await freeSlot();
    const minted = await mint("never-uploaded.xlsx", slot.processor, slot.period);
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

  it("the database refuses a batch with no processor and month, the service role included", async () => {
    // Which is also why parse-residual-import's 409 for such a batch cannot be
    // reached from here: only a batch from before 20261030140000 has none.
    const { error } = await adminClient()
      .from("rep_payout_batches")
      .insert({ imported_by: fixtures.userIds.admin, file_key: "old/x.xlsx", file_name: "legacy.xlsx", status: "review" });
    expect(error?.code).toBe("PT400");
    expect(error?.message).toBe(
      "A residual import needs its processor and month. Choose both when uploading the file.",
    );
  });

  it("signs a download of the stored original", async () => {
    // The provenance the retained file exists to provide: a committed period can
    // always be traced back to the bytes it came from.
    const mid = newMid();
    await merchantFor("owner", mid);
    const { batchId } = await importFile([HEADER, line(mid)], { fileName: "traceable.xlsx" });

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

/** A 13-character lettered MID unique to this run, as a Square MID looks (invented). */
function newLetteredMid(): string {
  midCounter += 1;
  return `SQ${RUN}K${String(midCounter).padStart(4, "0")}`;
}

describe("MIDs with letters, matched in any case (20261106140000)", () => {
  it("reads lettered MIDs written in lower and mixed case, and commits each to its merchant at the merchant's spelling", async () => {
    const lettered = newLetteredMid();
    const mixed = newLetteredMid();
    // Stored in lower case: the file's upper case must still find it.
    const storedLower = newLetteredMid().toLowerCase();
    const a = await merchantFor("owner", lettered);
    const b = await merchantFor("intruder", mixed);
    const c = await merchantFor("owner", storedLower);
    const mixedInFile = mixed
      .split("")
      .map((ch, i) => (i % 2 === 0 ? ch.toLowerCase() : ch))
      .join("");

    const { batchId, period, parse } = await importFile([
      HEADER,
      line(lettered.toLowerCase()),
      line(` ${mixedInFile} `),
      line(storedLower.toUpperCase()),
    ]);
    expect(parse.body).toMatchObject({ row_count: 3, blocked_count: 0 });
    const staged = await stagedRows(batchId);
    expect(staged.map((r) => [r.mid_raw, r.merchant_id, r.agent_id, r.blockers])).toEqual([
      [lettered.toLowerCase(), a, fixtures.userIds.owner, []],
      [mixedInFile, b, fixtures.userIds.intruder, []],
      [storedLower.toUpperCase(), c, fixtures.userIds.owner, []],
    ]);

    const { data, error } = await commitV3(batchId);
    expect(error, error?.message).toBeNull();
    expect(data).toMatchObject({ written: 3, rows: 3 });
    expect(await ledgerFor(lettered, period)).toMatchObject({ mid: lettered, agent_id: fixtures.userIds.owner, rep_payout: 12.5 });
    expect(await ledgerFor(mixed, period)).toMatchObject({ mid: mixed, agent_id: fixtures.userIds.intruder });
    expect(await ledgerFor(storedLower, period)).toMatchObject({ mid: storedLower, agent_id: fixtures.userIds.owner });
  });

  it("refuses a MID repeated in another case on every row, naming both spellings", async () => {
    const mid = newLetteredMid();
    await merchantFor("owner", mid);
    const { batchId, parse } = await importFile([HEADER, line(mid), line(newMidKnown()), line(mid.toLowerCase())]);
    expect(parse.body).toMatchObject({ row_count: 3, blocked_count: 2 });
    const staged = await stagedRows(batchId);
    expect(staged.map((r) => r.blocker)).toEqual(["duplicate_mid", null, "duplicate_mid"]);
    expect(staged[0].error).toBe(
      `MID ${mid} / ${mid.toLowerCase()} appears on rows 2, 4. Fix the file and upload it again.`,
    );
  });

  it("refuses an unknown lettered MID, and a short or punctuated one as unreadable", async () => {
    const unknown = newLetteredMid();
    const { batchId } = await importFile([HEADER, line(unknown), line("SQ12"), line("SQ-1234-5678")]);
    const staged = await stagedRows(batchId);
    expect(staged.map((r) => [r.mid_raw, r.blockers])).toEqual([
      [unknown, ["unknown_mid"]],
      ["SQ12", ["missing_mid"]],
      ["SQ-1234-5678", ["missing_mid"]],
    ]);
    expect(staged[1].error).toMatch(/"SQ12" is not 6 to 20 letters and digits/);
  });

  it("refuses a MID another processor's import already paid this month, whatever the case", async () => {
    const mid = newLetteredMid();
    await merchantFor("owner", mid);
    const slot = await freeSlot({ processor: PROCESSOR, also: ["Square"] });
    const first = await importFile([HEADER, line(mid)], slot);
    expect((await commitV3(first.batchId)).error).toBeNull();
    const elsewhere = await importFile([HEADER, line(mid.toLowerCase(), { processor: "Square" })], {
      processor: "Square",
      period: first.period,
    });
    expect((await stagedRows(elsewhere.batchId))[0].blockers).toEqual(["mid_in_other_batch"]);
  });

  it("reads a CSV's Merchant Number as its own text: 19 digits, leading zeros and letters", async () => {
    const long = `4${RUN}${String((midCounter += 1)).padStart(12, "0")}`;
    const zeroLed = newMid("0");
    const lettered = newLetteredMid();
    for (const mid of [long, zeroLed, lettered]) await merchantFor("owner", mid);
    const slot = await freeSlot();
    const csv = [
      HEADER.join(","),
      `${slot.processor},${long},Long Co,Residuals,1000,25`,
      `${slot.processor},${zeroLed},Zero Co,Residuals,"1,000.00",25`,
      `${slot.processor},${lettered.toLowerCase()},Lettered Co,Residuals,1000,25`,
    ].join("\n");
    const { batchId, parse } = await importFile([], { ...slot, fileName: "live-residuals.csv", bytes: Buffer.from(csv) });
    expect(parse.status, parse.raw).toBe(200);
    expect(parse.body).toMatchObject({ row_count: 3, blocked_count: 0 });
    expect((await stagedRows(batchId)).map((r) => [r.mid_raw, r.volume])).toEqual([
      [long, 1000],
      [zeroLed, 1000],
      [lettered.toLowerCase(), 1000],
    ]);
  });

  it("reads a 12-digit NUMBER cell in General format (shown in exponent form) by its stored value (phase 15)", async () => {
    const twelve = newMid("8");
    await merchantFor("owner", twelve);
    const { batchId } = await importFile([HEADER, line(Number(twelve))]);
    const [row] = await stagedRows(batchId);
    expect(row.blockers).toEqual([]);
    expect(row.mid_raw).toBe(twelve);
  });

  it("still refuses a 16-digit NUMBER cell with the use-the-CSV message", async () => {
    const { batchId } = await importFile([HEADER, line(4400123456789012)]);
    const [row] = await stagedRows(batchId);
    expect(row.blockers).toEqual(["missing_mid"]);
    expect(row.error).toMatch(/was stored as a spreadsheet number.*original CSV/);
  });
});

/** A MID with a merchant owned by the owner persona, for rows a test is not about. */
const knownMids: string[] = [];
function newMidKnown(): string {
  const mid = knownMids.shift();
  if (!mid) throw new Error("call seedKnownMids() first");
  return mid;
}
beforeAll(async () => {
  if (FUNCTIONS_DOWN) return;
  for (let i = 0; i < 8; i += 1) {
    const mid = newMid("6");
    await merchantFor("owner", mid);
    knownMids.push(mid);
  }
});

describe("the four warnings are stored per row, once per type, and block nothing", () => {
  it("processor mismatch (file or merchant), inactive merchant, bad numbers, other income type; A6, A25, A26, zero volume and phase 15 silent", async () => {
    const mids = {
      fileSays: newMid(),
      merchantSays: newMid(),
      noProcessor: newMid(),
      inactive: newMid(),
      other: newMid(),
      zeroVolume: newMid(),
      overVolume: newMid(),
      clawback: newMid(),
      negativeVolume: newMid(),
      blankProcessor: newMid(),
      goat: newMid(),
      ach: newMid(),
      blankVolume: newMid(),
    };
    await merchantFor("owner", mids.fileSays, { processor: PROCESSOR });
    await merchantFor("owner", mids.merchantSays, { processor: "Square" });
    await merchantFor("owner", mids.noProcessor);
    await merchantFor("owner", mids.inactive, { status: "inactive" });
    await merchantFor("owner", mids.other, { status: "other" });
    await merchantFor("owner", mids.zeroVolume);
    await merchantFor("owner", mids.overVolume);
    await merchantFor("owner", mids.clawback);
    await merchantFor("owner", mids.negativeVolume);
    for (const mid of [mids.blankProcessor, mids.goat, mids.ach, mids.blankVolume]) {
      await merchantFor("owner", mid);
    }

    const { batchId, parse } = await importFile([
      HEADER,
      line(mids.fileSays, { processor: "Netevia HQ" }),
      line(mids.merchantSays),
      line(mids.noProcessor, { processor: " tsys " }),
      line(mids.inactive),
      line(mids.other),
      line(mids.zeroVolume, { volume: "$0.00", residual: "$1.50" }),
      line(mids.overVolume, { volume: "100", residual: "100.01" }),
      line(mids.clawback, { volume: "$500.00", residual: "-$11.76" }),
      line(mids.negativeVolume, { volume: "-$500.00", residual: "-$11.76" }),
      // Phase 15: a blank Processor cell and the alias Goat (TSYS) are silent,
      // ACH is other_income_type, a blank Volume is 0, a filler row is skipped.
      line(mids.blankProcessor, { processor: null }),
      line(mids.goat, { processor: "Goat " }),
      line(mids.ach, { incomeType: "ACH" }),
      line(mids.blankVolume, { volume: null }),
      ["Goat", null, null, "ACH", null, null],
    ], { processor: PROCESSOR });

    expect(parse.status, parse.raw).toBe(200);
    expect(parse.body).toMatchObject({
      row_count: 13,
      blocked_count: 0,
      warning_counts: { processor_mismatch: 2, inactive_merchant: 1, bad_numbers: 2, other_income_type: 1 },
      skipped_count: 1,
      blank_as_zero_count: 1,
    });
    const staged = await stagedRows(batchId);
    expect(staged.map((r) => [r.mid_raw, r.warnings])).toEqual([
      [mids.fileSays, ["processor_mismatch"]],
      [mids.merchantSays, ["processor_mismatch"]],
      // A merchant with no saved processor, and the file's own spelling in
      // another case: neither is a mismatch (A6).
      [mids.noProcessor, []],
      [mids.inactive, ["inactive_merchant"]],
      // 'other' is not inactive (A26).
      [mids.other, []],
      // A zero-volume row is not a bad number, whatever its residual (20261104120000).
      [mids.zeroVolume, []],
      [mids.overVolume, ["bad_numbers"]],
      // A clawback on a positive volume is not a bad number (A25).
      [mids.clawback, []],
      // A negative volume (a refund month) still is.
      [mids.negativeVolume, ["bad_numbers"]],
      [mids.blankProcessor, []],
      [mids.goat, []],
      [mids.ach, ["other_income_type"]],
      [mids.blankVolume, []],
    ]);

    // THE PARSER AND v3 AGREE (memo §2.4): with nothing confirmed, v3 refuses,
    // and the types it demands (DETAIL) are exactly the types the parser
    // stored. Nothing type-checks this TS/SQL pair; this is where it is pinned.
    const stored = [...new Set(staged.flatMap((r) => r.warnings))].sort();
    const refused = await commitV3(batchId);
    expect(refused.error?.code).toBe("PT409");
    expect(refused.error?.details?.split(",")).toEqual(stored);
    // One yes short is still refused, naming the one left.
    const short = await commitV3(batchId, stored.slice(1));
    expect(short.error?.details).toBe(stored[0]);

    // Warnings are not refusals: confirmed, the batch commits, at each
    // merchant's rate (50 here), and keeps what was confirmed.
    const { data, error } = await commitV3(batchId, stored);
    expect(error, error?.message).toBeNull();
    expect(data).toEqual({ written: 13, rows: 13, shared: 0, overrides: 0, replaced_lines: 0 });
    const { data: batch } = await adminClient()
      .from("rep_payout_batches")
      .select("confirmed_warnings")
      .eq("id", batchId)
      .single();
    expect(batch?.confirmed_warnings).toEqual({
      bad_numbers: [8, 10],
      inactive_merchant: [5],
      processor_mismatch: [2, 3],
      other_income_type: [13],
    });

    // Confirming never changed the merchant's processor.
    const { data: merchant } = await adminClient()
      .from("merchants")
      .select("processor")
      .eq("mid", mids.merchantSays)
      .single();
    expect(merchant?.processor).toBe("Square");
  });
});

describe("payee_changed (A10): a MID that now pays a different rep than last month", () => {
  it("notes it on the row, naming both, and blocks nothing", async () => {
    const mid = newMid();
    const merchantId = await merchantFor("intruder", mid);
    const { processor, period: thisMonth } = await freeSlot();
    const lastMonth = shift(thisMonth, -1);
    // Last month this MID paid the intruder...
    const { error } = await adminClient().from("rep_payout_rows").insert({
      line_kind: "import",
      agent_id: fixtures.userIds.intruder,
      period: lastMonth,
      mid,
      processor: PROCESSOR,
      volume: 1,
    });
    expect(error, error?.message).toBeNull();
    // ...and since then the merchant moved to the owner.
    const { error: moveError } = await adminClient()
      .from("merchants")
      .update({ agent_id: fixtures.userIds.owner })
      .eq("id", merchantId);
    expect(moveError, moveError?.message).toBeNull();

    const { batchId, parse } = await importFile([HEADER, line(mid)], { processor, period: thisMonth });
    expect(parse.body).toMatchObject({ blocked_count: 0, flagged_count: 1 });
    const [row] = await stagedRows(batchId);
    expect(row.agent_id).toBe(fixtures.userIds.owner);
    expect(row.preview_flag).toBe("payee_changed");
    expect(row.preview_note).toBe(
      `Last month (${label(lastMonth)}) MID ${mid} paid Live Intruder Agent; this month it pays Live Owner Agent, the merchant's current owner. If moving the merchant was not meant to change who is paid, correct its owner before committing.`,
    );
  });
});

const scopeMids = { owner: "", intruder: "" };
let scopePeriod = "";

describe("committing over HTTP", () => {
  // The RPC's guards are covered exhaustively in
  // tests/rls/commit-residual-import-v3.test.ts. What only this suite proves is
  // that it is reachable over the Data API with a real JWT and that
  // `authenticated` actually holds EXECUTE on it -- a missing grant is invisible
  // below PostgREST, which is exactly how this repo once shipped with no Data
  // API grants at all.
  // commit_residual_import_v3 is what the commit button calls (phase 8). This
  // proves PostgREST exposes it with the right grant: anon holds no EXECUTE, an
  // agent meets the hand-written guard, and an admin gets the jsonb shape back.
  it("exposes commit_residual_import_v3: anon refused, agent refused, admin commits", async () => {
    const { batchId } = await importFile([HEADER, line(newMidKnown())]);

    const anon = await anonClient().rpc("commit_residual_import_v3", {
      batch_id_input: batchId,
      confirmed_input: [],
    });
    expect(anon.error?.code).toBe("42501");

    const agent = await userClient(fixtures.tokens.owner).rpc(
      "commit_residual_import_v3",
      { batch_id_input: batchId, confirmed_input: [] },
    );
    expect(agent.error?.message).toMatch(/admin only/i);

    const admin = await commitV3(batchId);
    expect(admin.error).toBeNull();
    expect(admin.data).toEqual({ written: 1, rows: 1, shared: 0, overrides: 0, replaced_lines: 0 });

    // v2 is gone from the Data API (20261030160000), and the old
    // commit_residual_import(int) since 20261104140000.
    for (const retired of ["commit_residual_import_v2", "commit_residual_import"]) {
      const gone = await userClient(fixtures.tokens.admin).rpc(retired, { batch_id_input: batchId });
      expect(gone.error?.code, retired).toBe("PGRST202");
    }
  });

  it("v3 pays each line at its MERCHANT's rate: 30 pays 30%, the house at 0 still writes its line", async () => {
    const at30 = newMid();
    const house = newMid();
    await merchantFor("owner", at30, { rate: 30 });
    await merchantFor("owner", house, { rate: 0 });
    const { batchId } = await importFile([
      HEADER,
      line(at30, { volume: "$10,000.00", residual: "$100.01" }),
      line(house, { volume: "$76,877.18", residual: "$250.00" }),
    ]);
    expect((await commitV3(batchId)).error).toBeNull();
    const { data } = await adminClient()
      .from("rep_payout_rows")
      .select("mid, volume, residual_income, rep_split_pct, rep_payout")
      .eq("batch_id", batchId)
      .order("mid");
    // 100.01 x 30% = 30.003 -> 30.00; the house line keeps its volume and net.
    expect(data).toEqual(
      [
        { mid: at30, volume: 10000, residual_income: 100.01, rep_split_pct: 30, rep_payout: 30 },
        { mid: house, volume: 76877.18, residual_income: 250, rep_split_pct: 0, rep_payout: 0 },
      ].sort((a, b) => a.mid.localeCompare(b.mid)),
    );
  });

  it("refuses while a row is still blocked", async () => {
    const { batchId } = await importFile([HEADER, line(newMid())]);

    const { error } = await commitV3(batchId);

    expect(error?.code).toBe("PT409");
    expect(error?.message).toBe("1 of 1 rows are still blocked");
  });

  it("commits to the owner; nobody edits the line after (20261102140000); a second file for the month is the replace prompt", async () => {
    const asAdmin = userClient(fixtures.tokens.admin);
    const mid = newMid();
    await merchantFor("owner", mid);

    // 1. Import and commit a clean file (TSYS, in a month Square is free too).
    const slot = await freeSlot({ processor: PROCESSOR, also: ["Square"] });
    const first = await importFile([HEADER, line(mid, { volume: "1,000.00", residual: "$25.00" })], slot);
    const { data: imported, error: commitError } = await commitV3(first.batchId);
    expect(commitError).toBeNull();
    expect(imported).toMatchObject({ written: 1, rows: 1 });

    const row = await ledgerFor(mid, first.period);
    expect(row).toMatchObject({
      agent_id: fixtures.userIds.owner,
      processor: PROCESSOR,
      volume: 1000,
      // The file's Residual, pre-split, and the MERCHANT's rate (v3; the old
      // commit_residual_import(int) this test used until phase 13 left the
      // split for the admin to fill in).
      residual_income: 25,
      rep_split_pct: 50,
      rep_payout: 12.5,
    });

    // 2. Nobody edits a committed line, an admin included, through PostgREST:
    // the figures the removed cell sent, and any other column, are refused by
    // the grant (42501), loudly -- not filtered to zero rows -- and nothing
    // moves. A fix is a replace (below: the prompt) or an adjustment.
    for (const patch of [
      { residual_income: 88.4, rep_split_pct: 60 },
      { rep_split_pct: 60 },
      { volume: 1 },
      { merchant_name: "Forged Co" },
    ]) {
      const { error: refused } = await asAdmin
        .from("rep_payout_rows")
        .update(patch)
        .eq("mid", mid)
        .eq("period", first.period);
      expect(refused?.code, JSON.stringify(patch)).toBe("42501");
    }
    expect(await ledgerFor(mid, first.period)).toEqual(row);

    // 3. A corrected file for the same processor and month is no longer a
    // merge: the upload answers with the committed batch (the replace prompt)
    // and creates nothing.
    const again = await mint("corrected.xlsx", PROCESSOR, first.period);
    expect(again.body.exists).toMatchObject({ batch_id: first.batchId });
    // The same MID under ANOTHER processor that month is refused outright.
    const elsewhere = await importFile([HEADER, line(mid, { processor: "Square" })], {
      processor: "Square",
      period: first.period,
    });
    expect((await stagedRows(elsewhere.batchId))[0].blocker).toBe("mid_in_other_batch");

    expect(await ledgerFor(mid, first.period)).toEqual(row);

    // 4. And no edit left a trail, because none happened.
    const { data: history } = await adminClient()
      .from("rep_payout_row_history")
      .select("id")
      .eq("mid", mid);
    expect(history).toEqual([]);
  });

  it("cannot be committed twice", async () => {
    const asAdmin = userClient(fixtures.tokens.admin);
    const { batchId } = await importFile([HEADER, line(newMidKnown())]);

    expect(
      (await asAdmin.rpc("commit_residual_import_v3", { batch_id_input: batchId, confirmed_input: [] }))
        .error,
    ).toBeNull();

    const { error } = await asAdmin.rpc("commit_residual_import_v3", {
      batch_id_input: batchId,
      confirmed_input: [],
    });
    expect(error?.code).toBe("PT409");
    expect(error?.message).toBe("this import is already committed");
  });
});

describe("a rep sees only their own committed rows", () => {
  it("scopes the ledger by RLS, not by a filter in the app", async () => {
    scopeMids.owner = newMid();
    scopeMids.intruder = newMid();
    await merchantFor("owner", scopeMids.owner);
    await merchantFor("intruder", scopeMids.intruder);

    // One row for each active agent's merchant, in one file, committed together.
    const { batchId, period } = await importFile([
      HEADER,
      line(scopeMids.owner, { volume: 100, residual: 3 }),
      line(scopeMids.intruder, { volume: 200, residual: 4 }),
    ]);
    scopePeriod = period;
    expect((await commitV3(batchId)).error).toBeNull();

    const both = [scopeMids.owner, scopeMids.intruder];
    const { data: ownerRows } = await userClient(fixtures.tokens.owner)
      .from("rep_payout_rows")
      .select("mid")
      .in("mid", both);
    expect((ownerRows ?? []).map((r) => r.mid)).toEqual([scopeMids.owner]);

    const { data: adminRows } = await userClient(fixtures.tokens.admin)
      .from("rep_payout_rows")
      .select("mid")
      .in("mid", both);
    expect((adminRows ?? []).length).toBe(2);
  });

  it("refuses a rep's attempt to edit their own figure, outright", async () => {
    // Was filtered to zero rows while authenticated held a column grant for
    // admins; since 20261102140000 there is none, so it is a 42501.
    const { error } = await userClient(fixtures.tokens.owner)
      .from("rep_payout_rows")
      .update({ residual_income: 999 }, { count: "exact" })
      .eq("mid", scopeMids.owner);
    expect(error?.code).toBe("42501");

    const row = await ledgerFor(scopeMids.owner, scopePeriod);
    expect(row?.residual_income).toBe(3);
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
    // Its own row, every numeric column filled. The six-column file writes no
    // average ticket or total cost, so no imported line has all six; this line
    // is planted rather than read from whatever the shared database holds.
    const mid = newMid();
    const { data: planted, error: plantError } = await adminClient()
      .from("rep_payout_rows")
      .insert({
        line_kind: "import",
        agent_id: fixtures.userIds.owner,
        period: month(-30),
        mid,
        processor: PROCESSOR,
        volume: 1000,
        average_ticket: 10,
        total_cost: 25,
        residual_income: 50.5,
        rep_split_pct: 50,
      })
      .select("id")
      .single();
    expect(plantError, plantError?.message).toBeNull();

    const { data, error } = await adminClient()
      .from("rep_payout_rows")
      .select("volume, average_ticket, total_cost, residual_income, rep_split_pct, rep_payout")
      .eq("id", planted!.id as number)
      .single();

    expect(error).toBeNull();
    const row = data as Record<string, unknown>;
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

describe("the export is scoped by RLS, and is no longer an import format", () => {
  it("gives a rep only their own rows, and an admin everyone's", async () => {
    // The reason this function is not admin-gated: it reads through the caller's own
    // client, so the file *is* the caller's scope. Reaching for supabaseAdmin
    // anywhere in it — even to join agent names — would silently turn a rep's export
    // into the whole company's, which is exactly the disclosure shape search_crm is
    // security invoker to avoid.
    const asAdmin = await exportWorkbook(fixtures.tokens.admin, {
      period: scopePeriod,
    });
    expect(asAdmin.status).toBe(200);

    const asOwner = await exportWorkbook(fixtures.tokens.owner, {
      period: scopePeriod,
    });
    expect(asOwner.status).toBe(200);

    const mids = (rows: unknown[][]) => {
      const at = (rows[0] as string[]).indexOf("MID");
      return rows.slice(1).map((r) => String(r[at]));
    };
    expect(mids(asOwner.rows).length).toBeGreaterThan(0);
    expect(mids(asAdmin.rows).length).toBeGreaterThan(
      mids(asOwner.rows).length,
    );
    // Nothing of the intruder's reached the owner's file.
    expect(mids(asOwner.rows)).not.toContain(scopeMids.intruder);
    expect(mids(asAdmin.rows)).toContain(scopeMids.intruder);
  });

  it("refuses a deactivated caller", async () => {
    const response = await exportWorkbook(fixtures.tokens.deactivated);
    expect(response.status).toBe(403);
  });

  it("has the header memo §2.6 gives it (phase 11)", async () => {
    const { rows } = await exportWorkbook(fixtures.tokens.admin, {
      period: scopePeriod,
    });

    expect(rows[0]).toEqual([
      "Period",
      "Processor",
      "Agent #",
      "Agent",
      "MID",
      "Merchant name",
      "Volume",
      "Residual",
      "Rep split",
      "Rep payout",
      // Blank, "Adjustment" or "Override".
      "Line",
      // The row's own share on a shared account, blank otherwise.
      "Account share",
    ]);
  });

  it("has NO total row: every data row carries a MID", async () => {
    const { rows } = await exportWorkbook(fixtures.tokens.admin, {
      period: scopePeriod,
    });

    for (const row of rows.slice(1)) {
      expect(
        String(row[(rows[0] as string[]).indexOf("MID")] ?? "").trim(),
        `every data row must carry a MID, got ${JSON.stringify(row)}`,
      ).not.toBe("");
    }
  });

  it("is refused when uploaded as a residual file, before anything is staged (memo §2.6)", async () => {
    // The round trip ended in phase 7: an export re-imported would count each
    // shared account's volume once per rep. The parser says what it is.
    const exported = await exportWorkbook(fixtures.tokens.admin, { period: scopePeriod });
    expect(exported.rows.length).toBeGreaterThan(1);

    const back = await importFile(exported.rows, { fileName: "round-trip.xlsx" });
    expect(back.parse.status, back.parse.raw).toBe(400);
    expect(back.parse.body.error).toBe(
      "This looks like a CRM export, not a processor file: it has an Agent # or Rep payout column. Upload the processor's own residual report.",
    );
    expect(await stagedRows(back.batchId)).toEqual([]);
  });

  it("labels an override's two lines \"Override\" with their signed Rep payout, under the batch's processor; that export is refused too", async () => {
    // Phase 10 wrote the label and never tested it. A 10% override on a rate-50
    // merchant (owner), paid to the intruder persona, committed through the
    // real path: set_merchant_override as the admin, then import and v3.
    const mid = newMid();
    const merchantId = await merchantFor("owner", mid);
    const slot = await freeSlot();
    const asAdmin = userClient(fixtures.tokens.admin);
    const { error: setError } = await asAdmin.rpc("set_merchant_override", {
      merchant_id_input: merchantId,
      recipient_id_input: fixtures.userIds.intruder,
      override_pct_input: 10,
      effective_from_input: slot.period,
    });
    expect(setError, setError?.message).toBeNull();
    const { batchId } = await importFile([HEADER, line(mid, { residual: "$100.00" })], slot);
    expect((await commitV3(batchId)).error).toBeNull();

    const exported = await exportWorkbook(fixtures.tokens.admin, { period: slot.period });
    const header = exported.rows[0] as string[];
    const at = (name: string) => header.indexOf(name);
    const lines = exported.rows
      .slice(1)
      .filter((row) => row[at("MID")] === mid)
      .map((row) => [row[at("Line")] ?? "", row[at("Processor")], row[at("Agent #")], row[at("Rep payout")],
                     row[at("Volume")] ?? null, row[at("Residual")] ?? null, row[at("Rep split")] ?? null]);
    const sorted = (list: unknown[][]) => [...list].sort((a, b) => Number(a[3]) - Number(b[3]));
    expect(sorted(lines)).toEqual(sorted([
      // The import line: the file's residual at the merchant's rate.
      ["", slot.processor, OWNER_NUMBER, 50, 1000, 100, 50],
      // The override pair: no figures, the signed amount.
      ["Override", slot.processor, OWNER_NUMBER, -10, null, null, null],
      ["Override", slot.processor, PERSONA_AGENT_NUMBERS.intruder, 10, null, null, null],
    ]));

    const back = await importFile(exported.rows, { fileName: "override-export.xlsx" });
    expect(back.parse.status, back.parse.raw).toBe(400);
    expect(back.parse.body.error).toMatch(/^This looks like a CRM export, not a processor file/);
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
// The shared-account cycle the app runs -- upload, preview, commit through v3
// -- with the same calls the browser makes, against the running stack.
//
// Under the owner rule (phase 8 of docs/design/intake-and-reports.md, §2.5) a
// share's signer IS the merchant's owner, so v2's three fates (partner named,
// share not applied, line not shared) cannot arise: set_merchant_rep_share
// refuses any other signer, and v3 pays the signer and the partner directly,
// at the merchant's rate, from the file's Residual. Nothing is skipped.
// ---------------------------------------------------------------------------

describe("a shared account, through upload, preview and commit (v3)", () => {
  const INTRUDER_NUMBER = PERSONA_AGENT_NUMBERS.intruder as string;
  const mids = { shared: "", plain: "", notOwned: "" };
  const merchants = { shared: 0, notOwned: 0 };

  let period: string;
  let processor: string;
  /** A free slot the share also covers, for the old commit's refusal. */
  let later: Slot;
  let batchId: number;
  let parse: Awaited<ReturnType<typeof invoke>>;

  beforeAll(async () => {
    if (FUNCTIONS_DOWN) return;
    // The share starts in the earlier month and still covers the later one.
    later = await freeSlot();
    ({ processor, period } = await freeSlot({ before: later.period }));

    for (const key of Object.keys(mids) as (keyof typeof mids)[]) mids[key] = newMid("5");
    merchants.shared = await merchantFor("owner", mids.shared);
    merchants.notOwned = await merchantFor("intruder", mids.notOwned);
    await merchantFor("owner", mids.plain);

    // Signer = owner (40), partner = intruder (10), from the batch's month, set
    // the way the app sets one -- the admin's own session.
    const { error: shareError } = await userClient(fixtures.tokens.admin).rpc(
      "set_merchant_rep_share",
      {
        merchant_id_input: merchants.shared,
        primary_agent_id_input: fixtures.userIds.owner,
        secondary_agent_id_input: fixtures.userIds.intruder,
        primary_rep_pct_input: 40,
        secondary_rep_pct_input: 10,
        effective_from_input: period,
      },
    );
    expect(shareError, shareError?.message).toBeNull();

    ({ batchId, parse } = await importFile(
      [
        HEADER,
        // row 2: the shared MID -> the pair
        line(mids.shared, { name: "Live Shared Co", residual: "$25.00" }),
        // row 3: an unshared MID -> one line
        line(mids.plain, { name: "Live Owner Co", residual: "$25.00" }),
      ],
      { fileName: "live-shared.xlsx", processor, period },
    ));
  });

  it("refuses, over PostgREST, a share whose signer is not the merchant's owner", async () => {
    const { error } = await userClient(fixtures.tokens.admin).rpc("set_merchant_rep_share", {
      merchant_id_input: merchants.notOwned,
      primary_agent_id_input: fixtures.userIds.owner,
      secondary_agent_id_input: fixtures.userIds.intruder,
      primary_rep_pct_input: 40,
      secondary_rep_pct_input: 10,
      effective_from_input: period,
    });
    expect(error?.code).toBe("PT409");
    expect(error?.message).toBe(
      "The signer of a shared account is the merchant's owner, Live Intruder Agent. Name them as the signer, or move the merchant first.",
    );
  });

  it("refuses, over PostgREST, moving a merchant that has a live share", async () => {
    const { error } = await userClient(fixtures.tokens.admin)
      .from("merchants")
      .update({ agent_id: fixtures.userIds.intruder })
      .eq("id", merchants.shared);
    expect(error?.code).toBe("PT409");
    expect(error?.message).toBe("This merchant has a shared-account split. End it before moving the merchant.");
  });

  it("previews nothing to warn about, and blocks nothing", async () => {
    expect(parse.status, parse.raw).toBe(200);
    expect(parse.body).toMatchObject({ row_count: 2, blocked_count: 0, flagged_count: 0 });
    const staged = await stagedRows(batchId);
    expect(staged.map((r) => [r.row_number, r.blocker, r.preview_flag])).toEqual([
      [2, null, null],
      [3, null, null],
    ]);
  });

  it("gives a rep none of the preview", async () => {
    const { data } = await userClient(fixtures.tokens.owner)
      .from("rep_payout_import_rows")
      .select("preview_flag")
      .eq("batch_id", batchId);
    expect(data ?? []).toEqual([]);
  });

  it("commits through v3, paying the pair from the file at the merchant's rate, skipping nothing", async () => {
    const { data, error } = await commitV3(batchId);
    expect(error, error?.message).toBeNull();
    expect(data).toEqual({ written: 3, rows: 2, shared: 1, overrides: 0, replaced_lines: 0 });

    const { data: batch } = await adminClient()
      .from("rep_payout_batches")
      .select("status, row_count, confirmed_warnings")
      .eq("id", batchId)
      .single();
    expect(batch).toEqual({ status: "committed", row_count: 2, confirmed_warnings: {} });

    const { data: lines } = await adminClient()
      .from("rep_payout_rows")
      .select("mid, agent_id, share_role, volume, residual_income, account_residual_income, rep_split_pct, rep_payout")
      .eq("batch_id", batchId);
    const key = (l: { mid: string; share_role: string | null }) => `${l.mid}|${l.share_role ?? ""}`;
    // R = 25.00 at rate 50: T = 12.50, the partner's 10 of 50 is 2.50, the
    // signer's 40 is 10.00; the residual pieces 5.00 and 20.00. The volume is
    // on the signer's line only.
    expect([...(lines ?? [])].sort((a, b) => key(a).localeCompare(key(b)))).toEqual(
      [
        { mid: mids.plain, agent_id: fixtures.userIds.owner, share_role: null, volume: 1000, residual_income: 25, account_residual_income: null, rep_split_pct: 50, rep_payout: 12.5 },
        { mid: mids.shared, agent_id: fixtures.userIds.owner, share_role: "primary", volume: 1000, residual_income: 20, account_residual_income: 25, rep_split_pct: 50, rep_payout: 10 },
        { mid: mids.shared, agent_id: fixtures.userIds.intruder, share_role: "secondary", volume: null, residual_income: 5, account_residual_income: 25, rep_split_pct: 50, rep_payout: 2.5 },
      ].sort((a, b) => key(a).localeCompare(key(b))),
    );
  });

  it("exports each line's OWN share, and each rep's export holds only their own line", async () => {
    // RLS decides which lines, the column decides which share.
    const mine = (exported: { rows: unknown[][] }) => {
      const header = exported.rows[0] as string[];
      const at = (name: string) => header.indexOf(name);
      return exported.rows
        .slice(1)
        .filter((row) => String(row[at("MID")]) === mids.shared)
        .map((row) => [row[at("Agent #")], row[at("Account share")] ?? null]);
    };
    const sortRows = (rows: unknown[][]) => [...rows].sort((a, b) => String(a[0]).localeCompare(String(b[0])));

    const admin = await exportWorkbook(fixtures.tokens.admin, { period });
    expect(sortRows(mine(admin))).toEqual(sortRows([[OWNER_NUMBER, 40], [INTRUDER_NUMBER, 10]]));
    expect(mine(await exportWorkbook(fixtures.tokens.owner, { period }))).toEqual([[OWNER_NUMBER, 40]]);
    expect(mine(await exportWorkbook(fixtures.tokens.intruder, { period }))).toEqual([[INTRUDER_NUMBER, 10]]);
  });

  it("my_share_partners over PostgREST: each party gets the other's name and their own share, nobody else anything", async () => {
    const shape = (data: unknown) =>
      (data as Record<string, unknown>[]).map((entry) => ({
        keys: Object.keys(entry).sort(),
        partner_name: entry.partner_name,
        own_rep_pct: entry.own_rep_pct,
        effective_from: entry.effective_from,
      }));
    const keys = ["effective_from", "effective_to", "own_rep_pct", "partner_name", "rep_share_id"];

    const owner = await userClient(fixtures.tokens.owner).rpc("my_share_partners", {
      merchant_id_input: merchants.shared,
    });
    expect(owner.error, owner.error?.message).toBeNull();
    expect(shape(owner.data)).toEqual([
      { keys, partner_name: "Live Intruder Agent", own_rep_pct: 40, effective_from: period },
    ]);

    const intruder = await userClient(fixtures.tokens.intruder).rpc("my_share_partners", {
      merchant_id_input: merchants.shared,
    });
    expect(shape(intruder.data)).toEqual([
      { keys, partner_name: "Live Owner Agent", own_rep_pct: 10, effective_from: period },
    ]);

    // Party-only for every caller: the admin is not a party.
    const admin = await userClient(fixtures.tokens.admin).rpc("my_share_partners", {
      merchant_id_input: merchants.shared,
    });
    expect(admin.data).toEqual([]);

    const deactivated = await userClient(fixtures.tokens.deactivated).rpc("my_share_partners", {});
    expect(deactivated.error?.code).toBe("PT403");

    const anon = await anonClient().rpc("my_share_partners", {});
    expect(anon.data ?? null).toBeNull();
    expect(anon.error).not.toBeNull();

    // And the table itself stays shut to the parties.
    const direct = await userClient(fixtures.tokens.intruder).from("merchant_rep_shares").select("id");
    expect(direct.data ?? []).toEqual([]);
  });

  it("will not let an admin's session write the commit's record over PATCH", async () => {
    // The batch UPDATE grant is (status) alone (20261016140000). This pinned
    // the skip record until phase 13 dropped it; the commit's other two
    // fields are the same grant's business.
    const asAdmin = userClient(fixtures.tokens.admin);
    for (const patch of [
      { row_count: 0 },
      { confirmed_warnings: { bad_numbers: [2] } },
    ]) {
      const { error } = await asAdmin.from("rep_payout_batches").update(patch).eq("id", batchId);
      expect(error?.code, JSON.stringify(patch)).toBe("42501");
    }
    const { data } = await adminClient()
      .from("rep_payout_batches")
      .select("row_count, confirmed_warnings")
      .eq("id", batchId)
      .single();
    expect(data).toEqual({ row_count: 2, confirmed_warnings: {} });
  });

  it("keeps the batch record from every rep, including the ones it pays", async () => {
    for (const persona of ["owner", "intruder"] as const) {
      const { data } = await userClient(fixtures.tokens[persona])
        .from("rep_payout_batches")
        .select("status, confirmed_warnings")
        .eq("id", batchId);
      expect(data ?? [], persona).toEqual([]);
    }
  });
});

/**
 * Phase 5 of docs/design/residual-splits.md, end to end: a correction posted
 * through PostgREST and exported with Line = Adjustment; and share_not_in_force,
 * written by the real parser under Deno. (The re-import of that export ended in
 * phase 7 of docs/design/intake-and-reports.md: an export is refused as a file,
 * above.)
 *
 * The correction's months are in 2029 so nothing else in the suite is anywhere
 * near them; they are ledger lines written directly, never a batch, so the
 * import window does not apply. The posting month is whatever
 * post_share_correction() computes on this stack -- the month after the latest
 * import line anywhere -- so it is read from the result, never assumed.
 */
describe("phase 5: a correction exports as Line = Adjustment, and share_not_in_force previews", () => {
  const JAN = "2029-01-01";
  const INTRUDER_NUMBER = PERSONA_AGENT_NUMBERS.intruder as string;
  const NOTE = "Shared 40/10 with the intruder from January, agreed later";
  let signerMid: string;
  let signerMerchant: number;

  let posting: string;
  let partnerLine: number;
  let signerLine: number;

  beforeAll(async () => {
    if (FUNCTIONS_DOWN) return;
    signerMid = newMid("4");
    signerMerchant = await merchantFor("owner", signerMid);
    // January 2029: the signer's committed month, 100.01 at 50% -> T 50.01.
    const { error } = await adminClient().from("rep_payout_rows").insert({
      agent_id: fixtures.userIds.owner,
      period: JAN,
      mid: signerMid,
      merchant_name: "Live Owner Co",
      merchant_id: signerMerchant,
      residual_income: 100.01,
      rep_split_pct: 50,
    });
    expect(error, error?.message).toBeNull();
  });

  const args = () => ({
    merchant_id_input: signerMerchant,
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
    const mine = admin.rows.slice(1).filter((row) => row[at("MID")] === signerMid);
    expect(mine.map((row) => [row[at("Agent #")], row[at("Residual")], row[at("Rep split")], row[at("Rep payout")], row[at("Line")]])).toEqual(
      expect.arrayContaining([
        [OWNER_NUMBER, null, null, -10, "Adjustment"],
        [INTRUDER_NUMBER, null, null, 10, "Adjustment"],
      ]),
    );

    const owner = await exportWorkbook(fixtures.tokens.owner, { period: posting });
    const ownRows = owner.rows.slice(1).filter((row) => row[at("MID")] === signerMid);
    expect(ownRows).toHaveLength(1);
    expect(ownRows[0][at("Rep payout")]).toBe(-10);
    expect(ownRows[0][at("Line")]).toBe("Adjustment");
  });

  describe("share_not_in_force", () => {
    let batchId: number;
    let batchPeriod: string;
    let batchProcessor: string;
    let parse: Awaited<ReturnType<typeof invoke>>;
    let sharedMid: string;
    let plainMid: string;

    beforeAll(async () => {
      if (FUNCTIONS_DOWN) return;
      sharedMid = newMid("3");
      plainMid = newMid("3");
      const sharedMerchant = await merchantFor("intruder", sharedMid);
      await merchantFor("owner", plainMid);
      ({ processor: batchProcessor, period: batchPeriod } = await freeSlot());
      // A share on the intruder's merchant that starts the month AFTER the
      // batch's: the batch's month is outside it.
      const next = shift(batchPeriod, 1);
      const { error: shareError } = await userClient(fixtures.tokens.admin).rpc("set_merchant_rep_share", {
        merchant_id_input: sharedMerchant,
        primary_agent_id_input: fixtures.userIds.intruder,
        secondary_agent_id_input: fixtures.userIds.owner,
        primary_rep_pct_input: 25,
        secondary_rep_pct_input: 25,
        effective_from_input: next,
      });
      expect(shareError, shareError?.message).toBeNull();

      ({ batchId, parse } = await importFile(
        [
          HEADER,
          // row 2: a share on the MID that does not cover the month -> share_not_in_force
          line(sharedMid, { name: "Live Intruder Co" }),
          // row 3: an unshared MID -> nothing
          line(plainMid, { name: "Live Owner Co" }),
        ],
        { fileName: "live-phase5-flags.xlsx", processor: batchProcessor, period: batchPeriod },
      ));
    });

    it("stores share_not_in_force on the staged row, blocking nothing", async () => {
      expect(parse.status, parse.raw).toBe(200);
      expect(parse.body).toMatchObject({ row_count: 2, blocked_count: 0, flagged_count: 1 });

      const staged = await stagedRows(batchId);
      expect(staged.map((r) => [r.row_number, r.blocker, r.preview_flag])).toEqual([
        [2, null, "share_not_in_force"],
        [3, null, null],
      ]);
      const next = shift(batchPeriod, 1);
      expect(staged[0].preview_note).toBe(
        `MID ${sharedMid} has a share (Live Intruder Agent / Live Owner Agent, from ${label(next)}), but it does not cover ${label(batchPeriod)}. This row imports as an ordinary line paying Live Intruder Agent the whole rep side.`,
      );
    });

    it("commits every flagged row through v3: the note is advisory", async () => {
      const { data, error } = await commitV3(batchId);
      expect(error, error?.message).toBeNull();
      expect(data).toEqual({ written: 2, rows: 2, shared: 0, overrides: 0, replaced_lines: 0 });
    });
  });
});

/**
 * guard_batch_status_transition() (20261016170000) through PostgREST: the role
 * a client request actually runs as. The parses above have already updated
 * batches as the service role, which the guard leaves alone.
 */
describe("a signed-in admin may only abandon a batch in review", () => {
  it("abandons a review batch, and is refused every other status change over PATCH", async () => {
    const asAdmin = userClient(fixtures.tokens.admin);
    const { batchId } = await importFile([HEADER, line(newMidKnown())], { fileName: "live-status.xlsx" });

    const committedJump = await asAdmin
      .from("rep_payout_batches")
      .update({ status: "committed" })
      .eq("id", batchId);
    expect(committedJump.error?.code).toBe("PT409");

    const abandon = await asAdmin
      .from("rep_payout_batches")
      .update({ status: "abandoned" }, { count: "exact" })
      .eq("id", batchId);
    expect(abandon.error, abandon.error?.message).toBeNull();
    expect(abandon.count).toBe(1);

    const back = await asAdmin
      .from("rep_payout_batches")
      .update({ status: "review" })
      .eq("id", batchId);
    expect(back.error?.code).toBe("PT409");
    expect(back.error?.message).toBe(
      "Only an import still in review can be changed here, and only to abandoned. This one is abandoned.",
    );

    const { data } = await adminClient()
      .from("rep_payout_batches")
      .select("status")
      .eq("id", batchId)
      .single();
    expect(data?.status).toBe("abandoned");
  });
});
