// The merchant bulk import against the running local stack (phase 14 of
// docs/design/intake-and-reports.md): stage-merchant-import in Deno behind its
// own JWT check, the review rows through PostgREST, commit_merchant_import()
// over HTTP, and two real connections racing the commit. Every merchant, MID
// and rep name is invented.
//
// tests/unit/merchant-import-parse.test.ts covers the parsing rules and
// tests/rls/merchant-import.test.ts the tables, the commit's re-derivation and
// the mutation proofs. What only this suite proves is that the pieces meet.

import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import {
  adminClient,
  anonClient,
  invoke,
  provisionFixtures,
  skipWhenFunctionsDown,
  teardownFixtures,
  userClient,
  warmFunctions,
  type Fixtures,
} from "./helpers/stack";

const FUNCTION = "stage-merchant-import";
const RUN = String(Date.now()).slice(-6);
const OWNER_LLC = `Live Import Owner ${RUN} LLC`;
const HEADER = "#,Type,MerchantÂ ID,Merchant Name,Split,Agent,Processor,Added By,Override Agent,Status";

const CONTAINER = `supabase_db_${/^project_id\s*=\s*"([^"]+)"/m.exec(readFileSync("supabase/config.toml", "utf8"))![1]}`;
const PSQL = ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"];
const ENV = { ...process.env, MSYS_NO_PATHCONV: "1" };

let fixtures: Fixtures;
const batchIds: number[] = [];
const skip = skipWhenFunctionsDown();

const mid = (n: number) => `LV${RUN}${String(n).padStart(5, "0")}`;

function csvLine(n: number, overrides: Partial<Record<"mid" | "name" | "split" | "agent" | "processor" | "status", string>> = {}): string {
  const v = { mid: mid(n), name: `Live Invented ${n}`, split: "0.5", agent: OWNER_LLC, processor: "TSYS", status: "Active", ...overrides };
  return `${n},MERCHANT,${v.mid},${v.name},${v.split},${v.agent},${v.processor},Someone,,${v.status}`;
}

const b64 = (data: string | Buffer) => Buffer.from(data).toString("base64");

async function stage(body: Record<string, unknown>, token = fixtures.tokens.admin) {
  const response = await invoke(FUNCTION, body, token);
  const id = response.body.batch_id;
  if (typeof id === "number" && !batchIds.includes(id)) batchIds.push(id);
  return response;
}

async function staged(batchId: number) {
  const { data, error } = await adminClient()
    .from("merchant_import_rows")
    .select("row_number, mid_raw, mid_source, mid, owner_id, rate, processor, status, blockers, notes, merged_into")
    .eq("batch_id", batchId)
    .order("row_number");
  if (error) throw new Error(error.message);
  return data ?? [];
}

function probe(sql: string): string {
  const r = spawnSync("docker", PSQL, { input: sql, encoding: "utf8", env: ENV, timeout: 30_000 });
  if (r.error) throw r.error;
  return r.stdout.trim();
}

type Session = { code: number | null; out: string; err: string; ms: number };
function session(sql: string): Promise<Session> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn("docker", PSQL, { env: ENV });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out, err, ms: Date.now() - started }));
    child.stdin.end(sql);
  });
}

async function until(check: () => boolean, what: string, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeAll(async () => {
  if (skip) return;
  fixtures = await provisionFixtures();
  await warmFunctions([FUNCTION]);
  const { error } = await userClient(fixtures.tokens.admin).rpc("set_rep_identity", {
    user_id: fixtures.userIds.owner,
    legal_name: "Live Owner Agent",
    llc_legal_name: OWNER_LLC,
  });
  if (error) throw new Error(`set_rep_identity: ${error.message}`);
}, 120_000);

afterAll(async () => {
  if (skip) return;
  // The merchants this suite made, then its batches (no client or service-role
  // DELETE on batches: removed as the database owner).
  probe(`delete from merchants where mid ilike 'LV${RUN}%';
         delete from merchant_import_batches where id in (${[0, ...batchIds].join(",")});`);
  await teardownFixtures();
}, 120_000);

describe("who may call stage-merchant-import", () => {
  it("refuses no JWT (401), a rep and a deactivated rep (403)", async () => {
    const body = { file_name: "x.csv", file_base64: b64(`${HEADER}\n${csvLine(1)}`) };
    expect((await invoke(FUNCTION, body)).status).toBe(401);
    expect((await invoke(FUNCTION, body, fixtures.tokens.owner)).status).toBe(403);
    expect((await invoke(FUNCTION, body, fixtures.tokens.deactivated)).status).toBe(403);
  });

  it("refuses a file that cannot be read, and leaves no batch behind", async () => {
    const before = (await adminClient().from("merchant_import_batches").select("id")).data?.length ?? 0;
    const missing = await stage({ file_name: "x.csv", file_base64: b64("Type,Merchant ID\nMERCHANT,1") });
    expect(missing.status).toBe(400);
    expect(String(missing.body.error)).toMatch(/missing the columns Merchant Name, Split, Agent, Processor, Status/);
    const xls = await stage({ file_name: "old.xls", file_base64: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2]).toString("base64") });
    expect(xls.status).toBe(400);
    expect(String(xls.body.error)).toMatch(/old-style \.xls/);
    expect((await adminClient().from("merchant_import_batches").select("id")).data?.length ?? 0).toBe(before);
  });

  it("a rep reads no batch or row over the Data API; anon is refused", async () => {
    const res = await stage({ file_name: "live.csv", file_base64: b64(`${HEADER}\n${csvLine(90)}`) });
    expect(res.status).toBe(200);
    const rep = userClient(fixtures.tokens.owner);
    expect((await rep.from("merchant_import_batches").select("id")).data).toEqual([]);
    expect((await rep.from("merchant_import_rows").select("id")).data).toEqual([]);
    const anon = await anonClient().from("merchant_import_batches").select("id");
    expect(anon.error?.code).toBe("42501");
  });
});

describe("staging, Read again and commit over HTTP", () => {
  it("stages a CSV as text (mojibake header, leading zeros, alphanumeric MID), refuses an unknown rep, then commits after the fix", async () => {
    const lateLlc = `Live Late Rep ${RUN} LLC`;
    const csv = [
      HEADER,
      csvLine(1, { mid: `0${RUN}0000001` }),
      csvLine(2, { mid: `SQ${RUN}X9`, split: "", processor: "365 Pay" }),
      csvLine(3, { agent: `  ${lateLlc.toLowerCase()} ` }),
      csvLine(4, { mid: `0${RUN}0000001`, name: "Second Name", processor: "" }),
    ].join("\r\n");
    const res = await stage({ file_name: "live-merchants.csv", file_base64: b64(csv) });
    expect(res.status, res.raw).toBe(200);
    expect(res.body).toMatchObject({ row_count: 4, refused_count: 1, merchant_count: 2, ready: false });
    const id = res.body.batch_id as number;

    let rows = await staged(id);
    expect(rows.map((r) => [r.row_number, r.mid_raw, r.mid_source])).toEqual([
      [2, `0${RUN}0000001`, "text"],
      [3, `SQ${RUN}X9`, "text"],
      [4, mid(3), "text"],
      [5, `0${RUN}0000001`, "text"],
    ]);
    expect(rows[1]).toMatchObject({ rate: null, processor: "365 Pay", notes: ["rate_from_profile"] });
    expect(rows[2].blockers).toEqual(["unknown_agent"]);
    expect(rows[3]).toMatchObject({ merged_into: 2, notes: ["merged", "name_differs"] });

    // The commit refuses while the refusal stands, over HTTP.
    const admin = userClient(fixtures.tokens.admin);
    const early = await admin.rpc("commit_merchant_import", { batch_id_input: id });
    expect(early.error?.code).toBe("PT409");
    expect(early.error?.message).toMatch(/unknown_agent \(row 4\)/);

    // Fix the CRM, not the file: give the intruder persona that LLC name.
    const { error } = await admin.rpc("set_rep_identity", {
      user_id: fixtures.userIds.intruder, legal_name: "Live Intruder Agent", llc_legal_name: lateLlc,
    });
    expect(error).toBeNull();
    const again = await stage({ batch_id: id });
    expect(again.body).toMatchObject({ refused_count: 0, merchant_count: 3, ready: true });
    rows = await staged(id);
    expect(rows[2]).toMatchObject({ owner_id: fixtures.userIds.intruder, blockers: [] });

    // A rep cannot commit; anon has no EXECUTE.
    const rep = await userClient(fixtures.tokens.owner).rpc("commit_merchant_import", { batch_id_input: id });
    expect(rep.error?.code).toBe("PT403");
    const anon = await anonClient().rpc("commit_merchant_import", { batch_id_input: id });
    expect(anon.error?.code).toBe("42501");

    const done = await admin.rpc("commit_merchant_import", { batch_id_input: id });
    expect(done.error).toBeNull();
    expect(done.data).toEqual({ created: 3, rows: 4, merged: 1 });

    const { data: merchants } = await adminClient()
      .from("merchants")
      .select("mid, agent_id, dba, processor, split_agent_pct, status, city, state")
      .in("mid", [`0${RUN}0000001`, `SQ${RUN}X9`, mid(3)])
      .order("mid");
    expect(merchants).toEqual([
      { mid: `0${RUN}0000001`, agent_id: fixtures.userIds.owner, dba: "Live Invented 1", processor: "TSYS", split_agent_pct: 50, status: "active", city: null, state: null },
      { mid: mid(3), agent_id: fixtures.userIds.intruder, dba: "Live Invented 3", processor: "TSYS", split_agent_pct: 50, status: "active", city: null, state: null },
      // Blank Split: the owner's profile rate (the persona's default, 50).
      { mid: `SQ${RUN}X9`, agent_id: fixtures.userIds.owner, dba: "Live Invented 2", processor: "365 Pay", split_agent_pct: 50, status: "active", city: null, state: null },
    ]);

    const { data: audit } = await adminClient()
      .from("audit_log").select("actor_id, detail").eq("action", "commit_merchant_import").eq("row_id", String(id));
    expect(audit).toEqual([{ actor_id: fixtures.userIds.admin, detail: "live-merchants.csv: 4 rows, 3 merchants created, 1 duplicate rows merged" }]);

    // Settled: no second commit, no re-read.
    expect((await admin.rpc("commit_merchant_import", { batch_id_input: id })).error?.message).toMatch(/is committed and cannot be committed/);
    expect((await stage({ batch_id: id })).status).toBe(409);
  });

  it("reads an XLSX: a short numeric MID with a note; a long or fractional one refused", async () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      ["#", "Type", "Merchant ID", "Merchant Name", "Split", "Agent", "Processor", "Added By", "Override Agent", "Status"],
      [1, "MERCHANT", 912345678, "Xlsx Short", 0.3, OWNER_LLC, "Square", "", "", "Active"],
      [2, "MERCHANT", 1234567890123456, "Xlsx Long", 0.3, OWNER_LLC, "Square", "", "", "Active"],
      [3, "MERCHANT", 912345678.5, "Xlsx Float", 0.3, OWNER_LLC, "Square", "", "", "Active"],
      [4, "MERCHANT", `XL${RUN}TEXT`, "Xlsx Text", "25%", OWNER_LLC, "", "", "", "Inactive"],
    ]);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "Merchants");
    const bytes = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;

    const res = await stage({ file_name: "live.xlsx", file_base64: bytes.toString("base64") });
    expect(res.status, res.raw).toBe(200);
    const rows = await staged(res.body.batch_id as number);
    expect(rows.map((r) => [r.mid_raw, r.mid_source, r.blockers, r.notes])).toEqual([
      // The owner's profile rate is 50, so every explicit rate here is noted.
      ["912345678", "number", [], ["mid_from_number", "rate_differs"]],
      // Shown as the spreadsheet displays it, for the admin to recognise.
      ["1.23457E+15", "unsafe_number", ["mid_precision"], ["rate_differs"]],
      ["912345678.5", "unsafe_number", ["mid_precision"], ["rate_differs"]],
      [`XL${RUN}TEXT`, "text", [], ["rate_differs"]],
    ]);
    expect(rows[0].rate).toBe(30);
    expect(rows[3]).toMatchObject({ rate: 25, status: "inactive" });
  });

  it("refuses at commit what the staged rows were tampered to hide", async () => {
    const res = await stage({ file_name: "tamper.csv", file_base64: b64(`${HEADER}\n${csvLine(40, { processor: "Fiserv Nova" })}`) });
    const id = res.body.batch_id as number;
    expect((await staged(id))[0].blockers).toEqual(["unknown_processor"]);
    probe(`update merchant_import_rows set blockers = '{}', processor = null where batch_id = ${id};`);
    const out = await userClient(fixtures.tokens.admin).rpc("commit_merchant_import", { batch_id_input: id });
    expect(out.error?.message).toMatch(/unknown_processor \(row 2\)/);
    expect((await adminClient().from("merchants").select("id").eq("mid", mid(40))).data).toEqual([]);
  });

  it("stages and commits 500 merchants quickly", async () => {
    const lines = Array.from({ length: 500 }, (_, i) => csvLine(1000 + i, { split: i % 2 ? "0.5" : "" }));
    const started = Date.now();
    const res = await stage({ file_name: "five-hundred.csv", file_base64: b64([HEADER, ...lines].join("\n")) });
    expect(res.body).toMatchObject({ row_count: 500, merchant_count: 500, ready: true });
    const staging = Date.now() - started;
    const commitStarted = Date.now();
    const done = await userClient(fixtures.tokens.admin).rpc("commit_merchant_import", { batch_id_input: res.body.batch_id });
    const committing = Date.now() - commitStarted;
    expect(done.data).toEqual({ created: 500, rows: 500, merged: 0 });
    expect(staging, "staging 500 rows").toBeLessThan(15_000);
    expect(committing, "committing 500 merchants").toBeLessThan(5_000);
  }, 60_000);
});

describe("two real connections commit at once; exactly one wins, cleanly", () => {
  const asAdmin = (batchId: number, hold: boolean, tag: string) => `
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"${fixtures.userIds.admin}","role":"authenticated"}', true);
select '${tag}', commit_merchant_import(${batchId});
${hold ? `select '${tag}-holding', pg_sleep(4);` : ""}
commit;
`;

  async function race(first: string, second: string, tag: string): Promise<[Session, Session]> {
    const a = session(first);
    await until(
      () => probe(`select count(*) from pg_stat_activity where query like '%${tag}-A-holding%' and state = 'active' and pid <> pg_backend_pid()`) === "1",
      `session A to commit and hold (${tag})`,
    );
    const b = session(second);
    await until(
      () => probe(`select count(*) from pg_stat_activity where query like '%${tag}-B%' and wait_event_type = 'Lock' and pid <> pg_backend_pid()`) === "1",
      `session B to wait on a lock (${tag})`,
    );
    return Promise.all([a, b]);
  }

  it("one batch committed twice: the second sees it committed", async () => {
    const res = await stage({ file_name: "race-same.csv", file_base64: b64(`${HEADER}\n${csvLine(70)}`) });
    const id = res.body.batch_id as number;
    const [a, b] = await race(asAdmin(id, true, "same-A"), asAdmin(id, false, "same-B"), "same");
    expect(a.code, a.err).toBe(0);
    expect(b.code).not.toBe(0);
    expect(b.err).toContain("This import is committed and cannot be committed");
    expect(b.err).not.toMatch(/duplicate key|deadlock/);
    expect((await adminClient().from("merchants").select("id").eq("mid", mid(70))).data?.length).toBe(1);
  });

  it("two batches naming one MID in different case: the second refuses it as already a merchant", async () => {
    const one = await stage({ file_name: "race-a.csv", file_base64: b64(`${HEADER}\n${csvLine(71)}`) });
    const two = await stage({ file_name: "race-b.csv", file_base64: b64(`${HEADER}\n${csvLine(71, { mid: mid(71).toLowerCase() })}`) });
    expect(one.body.ready && two.body.ready).toBe(true);
    const [a, b] = await race(
      asAdmin(one.body.batch_id as number, true, "case-A"),
      asAdmin(two.body.batch_id as number, false, "case-B"),
      "case",
    );
    expect(a.code, a.err).toBe(0);
    expect(b.code).not.toBe(0);
    expect(b.err).toMatch(/mid_exists \(row 2\)/);
    const { data } = await adminClient().from("merchants").select("mid").ilike("mid", mid(71));
    expect(data).toEqual([{ mid: mid(71) }]);
  });
});
