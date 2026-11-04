import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import {
  adminClient,
  getStackConfig,
  provisionFixtures,
  skipWhenFunctionsDown,
  teardownFixtures,
  userClient,
  warmFunctions,
  type Fixtures,
} from "./helpers/stack";
import {
  MERCHANT_FIGURES,
  MERCHANT_TEXT_HEADERS,
  REP_FIGURES,
  REP_TEXT_HEADERS,
  type MerchantSummaryRow,
  type RepSummaryRow,
} from "../../supabase/functions/_shared/report-sheets.ts";

/**
 * export-report (phase 12b of docs/design/intake-and-reports.md): the two
 * /admin/reports reports as an .xlsx, against the real running function.
 *
 * Two committed months seeded through the REAL path -- staging rows, then
 * commit_residual_import_v3 as the admin -- with a clawback, a shared account
 * (owner signs 40, intruder partners 10), a 5% override and the house profile
 * (a rep at rate 0 on a rate-0 merchant). The file is opened with SheetJS and
 * every figure, totals rows included, is compared with what the two SQL
 * functions return for the same selection, to the cent; the seeded reps'
 * figures with the ledger's own lines. Then the refusals: a rep, a
 * deactivated rep, no session and a forged session -- none of
 * which gets a file or writes an audit row -- and the admin's audit row.
 */

const FUNCTIONS = ["export-report"] as const;
const FUNCTIONS_DOWN = skipWhenFunctionsDown();

const HOSTILE_NAME = '=HYPERLINK("http://evil.example","x")';
const RUN = String(Date.now()).slice(-6);
const mid = (n: number) => `0${RUN}${String(n).padStart(5, "0")}`; // 12 digits, a leading zero

let fx: Fixtures;
const slots: { processor: string; period: string }[] = [];
const PROCESSORS = ["TSYS", "Red Fynn", "PayBright", "Netevia HQ", "Square"];

/** Two processor-months no batch on the stack uses: consecutive months, so a range covers both. */
async function freeSlots(): Promise<{ processor: string; period: string }[]> {
  const { data } = await adminClient().from("rep_payout_batches").select("processor, period");
  const used = new Set((data ?? []).map((b) => `${b.processor}|${b.period}`));
  const now = new Date();
  const monthAt = (back: number) => {
    const index = now.getUTCFullYear() * 12 + now.getUTCMonth() - back;
    const year = Math.floor(index / 12);
    return `${year}-${String(index - year * 12 + 1).padStart(2, "0")}-01`;
  };
  for (let back = 24; back >= 1; back -= 1) {
    const [first, second] = [monthAt(back), monthAt(back - 1)];
    for (const processor of PROCESSORS) {
      if (!used.has(`${processor}|${first}`) && !used.has(`${processor}|${second}`)) {
        return [{ processor, period: first }, { processor, period: second }];
      }
    }
  }
  throw new Error("no two free consecutive processor-months in the import window");
}

async function merchant(owner: string, merchantMid: string, dba: string, rate: number): Promise<number> {
  const { data, error } = await adminClient().from("merchants").insert({
    agent_id: owner, mid: merchantMid, dba, city: "Nashville", state: "TN",
    legal_business_name: `${dba} LLC`, status: "active", split_agent_pct: rate, split_company_pct: 100 - rate,
  }).select("id").single();
  if (error) throw new Error(`merchant: ${error.message}`);
  return data.id as number;
}

/** Stages and commits one processor-month through the real v3, as the admin. */
async function commitMonth(
  slot: { processor: string; period: string },
  lines: { merchantId: number; mid: string; name: string; owner: string; volume: number; residual: number }[],
): Promise<number> {
  const admin = adminClient();
  const { data: batch, error } = await admin.from("rep_payout_batches").insert({
    imported_by: fx.userIds.admin, file_key: `live/report-export-${slot.period}.xlsx`,
    file_name: "live-report-export.xlsx", status: "review", ...slot,
  }).select("id").single();
  if (error) throw new Error(`batch: ${error.message}`);
  const staged = lines.map((line, i) => ({
    batch_id: batch.id, period: slot.period, processor_raw: slot.processor, income_type_raw: "Residuals",
    row_number: i + 2, mid_raw: line.mid, merchant_name_raw: line.name, merchant_id: line.merchantId,
    agent_id: line.owner, volume: line.volume, residual_income: line.residual,
  }));
  const { error: stageError } = await admin.from("rep_payout_import_rows").insert(staged);
  if (stageError) throw new Error(`staging: ${stageError.message}`);
  const { error: commitError } = await userClient(fx.tokens.admin).rpc("commit_residual_import_v3", {
    batch_id_input: batch.id, confirmed_input: [],
  });
  if (commitError) throw new Error(`commit: ${commitError.message}`);
  return batch.id as number;
}

const MIDS = { plain: mid(1), shared: mid(2), clawback: mid(3), house: mid(4) };

beforeAll(async () => {
  if (FUNCTIONS_DOWN) return;
  await warmFunctions(FUNCTIONS);
  fx = await provisionFixtures();
  slots.push(...(await freeSlots()));
  const [first, second] = slots;
  const { owner, intruder } = fx.userIds;
  const asAdmin = userClient(fx.tokens.admin);

  // The house profile: rate 0 on the profile and on its merchant.
  const { error: splitError } = await asAdmin.rpc("set_rep_split", { user_id: intruder, rate: 0 });
  if (splitError) throw new Error(`set_rep_split: ${splitError.message}`);

  const plain = await merchant(owner, MIDS.plain, HOSTILE_NAME, 50);
  const shared = await merchant(owner, MIDS.shared, "Live Export Shared", 50);
  const clawback = await merchant(owner, MIDS.clawback, "Live Export Clawback", 50);
  const house = await merchant(intruder, MIDS.house, "Live Export House", 0);

  const { error: shareError } = await adminClient().from("merchant_rep_shares").insert({
    merchant_id: shared, primary_agent_id: owner, secondary_agent_id: intruder,
    primary_rep_pct: 40, secondary_rep_pct: 10, effective_from: first.period,
  });
  if (shareError) throw new Error(`share: ${shareError.message}`);
  const { error: overrideError } = await asAdmin.rpc("set_merchant_override", {
    merchant_id_input: plain, recipient_id_input: fx.userIds.admin, override_pct_input: 5,
    effective_from_input: first.period,
  });
  if (overrideError) throw new Error(`override: ${overrideError.message}`);

  const lines = (scale: number) => [
    { merchantId: plain, mid: MIDS.plain, name: HOSTILE_NAME, owner, volume: 40000 * scale, residual: 200 * scale },
    { merchantId: shared, mid: MIDS.shared, name: "Live Export Shared", owner, volume: 50000, residual: 1234.56 * scale },
    // A clawback on a ZERO-volume line, committed with nothing confirmed: the
    // regression check for 20261104120000 (zero volume is not a bad number).
    { merchantId: clawback, mid: MIDS.clawback, name: "Live Export Clawback", owner, volume: 0, residual: -11.76 },
    { merchantId: house, mid: MIDS.house, name: "Live Export House", owner: intruder, volume: 20000, residual: 500.01 },
  ];
  await commitMonth(first, lines(1));
  await commitMonth(second, lines(2));
});

afterAll(async () => {
  if (FUNCTIONS_DOWN) return;
  await teardownFixtures();
});

type Body = { report: "reps" | "merchants"; from: string; to: string; processor: string | null };

async function download(token: string | null, body: Body, apikey?: string) {
  const { apiUrl, anonKey } = getStackConfig();
  const headers: Record<string, string> = { "Content-Type": "application/json", apikey: apikey ?? anonKey };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${apiUrl}/functions/v1/export-report`, {
    method: "POST", headers, body: JSON.stringify(body),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, bytes };
}

function open(bytes: Buffer) {
  const book = XLSX.read(bytes, { cellNF: true, cellFormula: true });
  const name = book.SheetNames[0];
  const sheet = book.Sheets[name];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null, blankrows: true });
  return { name, sheet, rows };
}

/** The rows after the column-header row (the row that starts with these headers). */
function body(rows: unknown[][], headers: readonly string[]): unknown[][] {
  const at = rows.findIndex((r) => headers.every((h, i) => r[i] === h));
  expect(at, "the column headers").toBeGreaterThan(0);
  return rows.slice(at + 1);
}

const cents = (value: unknown) => Math.round(Number(value) * 100);

async function exportAudits(): Promise<{ table_name: string; row_id: string }[]> {
  const { data } = await adminClient().from("audit_log").select("table_name, row_id")
    .eq("action", "export_report").eq("actor_id", fx.userIds.admin);
  return (data ?? []) as { table_name: string; row_id: string }[];
}

describe.skipIf(FUNCTIONS_DOWN)("export-report", () => {
  const range = (): Body => ({ report: "reps", from: slots[0].period, to: slots[1].period, processor: null });

  it("Report 1 over two months: every row and total equals rep_payout_summary to the cent", async () => {
    const selection = range();
    const res = await download(fx.tokens.admin, selection);
    expect(res.status, res.bytes.toString("utf8").slice(0, 200)).toBe(200);
    expect(res.headers.get("content-disposition")).toContain(
      `residual-report-1-${selection.from.slice(0, 7)}-to-${selection.to.slice(0, 7)}-all-processors.xlsx`);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const { data, error } = await userClient(fx.tokens.admin).rpc("rep_payout_summary", {
      period_from_input: selection.from, period_to_input: selection.to, processor_input: null,
    });
    expect(error).toBeNull();
    const fnRows = data as RepSummaryRow[];

    const { name, rows } = open(res.bytes);
    expect(name).toBe("Rep payout summary");
    const lines = body(rows, REP_TEXT_HEADERS);

    // The same rows in the same order: month headings, reps, month totals, the total.
    const expected: unknown[][] = [];
    const reps = fnRows.filter((r) => r.row_kind === "rep");
    for (const month of [...new Set(reps.map((r) => r.period!))]) {
      expected.push([month.slice(0, 7)]);
      for (const r of reps.filter((x) => x.period === month)) {
        expected.push([r.agent_code, r.legal_name, r.full_name, ...REP_FIGURES.map(([k]) => cents(r[k]))]);
      }
    }
    for (const r of fnRows.filter((x) => x.row_kind !== "rep")) {
      const label = r.row_kind === "month" ? `${r.period!.slice(0, 7)} total` : "Total";
      expected.push([label, null, null, ...REP_FIGURES.map(([k]) => cents(r[k]))]);
    }
    const actual = lines.map((r) => r.length <= 1 || r.slice(1).every((c) => c === null)
      ? [r[0]]
      : [r[0], r[1], r[2], ...r.slice(3, 9).map(cents)]);
    expect(actual).toEqual(expected);

    // The seeded reps against the ledger itself: the house is at 0, the owner's total is their lines.
    const NAMES = { [fx.userIds.owner]: "Live Owner Agent", [fx.userIds.intruder]: "Live Intruder Agent" };
    const totalOf = (agentId: string, period: string) => {
      let month: unknown = null;
      for (const r of lines) {
        if (r.length <= 1 || r.slice(1).every((c) => c === null)) month = r[0];
        else if (month === period.slice(0, 7) && r[2] === NAMES[agentId]) return r[8];
      }
      return undefined;
    };
    for (const slot of slots) {
      const { data: ledger } = await adminClient().from("rep_payout_rows").select("agent_id, rep_payout")
        .eq("period", slot.period).eq("processor", slot.processor);
      for (const agentId of [fx.userIds.owner, fx.userIds.intruder]) {
        const sum = (ledger ?? []).filter((l) => l.agent_id === agentId).reduce((s, l) => s + cents(l.rep_payout), 0);
        expect(cents(totalOf(agentId, slot.period)), `${agentId} ${slot.period}`).toBe(sum);
      }
    }
    // Every money cell is a currency number; the deductions header is there.
    expect(rows.some((r) => r.includes("Deductions (info only, not in total)"))).toBe(true);
  });

  it("Report 2 for one processor-month: rows, subtotal and grand total equal merchant_processor_summary; MIDs stay text", async () => {
    const selection: Body = { report: "merchants", from: slots[0].period, to: slots[0].period, processor: slots[0].processor };
    const res = await download(fx.tokens.admin, selection);
    expect(res.status).toBe(200);
    const { data } = await userClient(fx.tokens.admin).rpc("merchant_processor_summary", {
      period_from_input: selection.from, period_to_input: selection.to, processor_input: selection.processor,
    });
    const fnRows = data as MerchantSummaryRow[];
    const { sheet, rows } = open(res.bytes);
    const lines = body(rows, MERCHANT_TEXT_HEADERS);

    const figures = (r: MerchantSummaryRow) => MERCHANT_FIGURES.map(([k]) => cents(r[k]));
    const merchants = fnRows.filter((r) => r.row_kind === "merchant");
    expect(merchants.map((r) => r.mid).sort()).toEqual(Object.values(MIDS).sort());
    expect(lines.slice(0, merchants.length).map((r) => [r[2], ...r.slice(5).map(cents)]))
      .toEqual(merchants.map((r) => [r.mid, ...figures(r)]));
    const subtotal = fnRows.find((r) => r.row_kind === "processor")!;
    const total = fnRows.find((r) => r.row_kind === "total")!;
    expect(lines[merchants.length][0]).toBe(`${slots[0].processor} subtotal (not marked paid)`);
    expect(lines[merchants.length].slice(5).map(cents)).toEqual(figures(subtotal));
    expect(lines[merchants.length + 1][0]).toBe("Grand total");
    expect(lines[merchants.length + 1].slice(5).map(cents)).toEqual(figures(total));

    // The clawback and the house, as the ledger has them.
    const row = (m: string) => lines.find((r) => r[2] === m)!;
    expect(cents(row(MIDS.clawback)[6])).toBe(-1176);
    expect(cents(row(MIDS.house)[7])).toBe(0); // rep side at rate 0
    expect(cents(row(MIDS.house)[8])).toBe(50001); // company share: all of it
    // The shared account once, under its signer, with the account's residual.
    expect(cents(row(MIDS.shared)[6])).toBe(123456);
    expect(row(MIDS.shared)[4]).toBe("Live Owner Agent");

    // Leading-zero 12-digit MIDs are text; the hostile merchant name is quoted text, no formula anywhere.
    for (const [address, cell] of Object.entries(sheet).filter(([k]) => !k.startsWith("!")) as [string, XLSX.CellObject][]) {
      expect(cell.f, address).toBeUndefined();
      if (cell.v === MIDS.plain) expect(cell.t).toBe("s");
    }
    expect(row(MIDS.plain)[1]).toBe(`'${HOSTILE_NAME}`);
    expect(Object.values(MIDS).every((m) => m.length === 12 && m.startsWith("0"))).toBe(true);
  });

  it("writes an audit row naming the report and the selection", async () => {
    const audits = await exportAudits();
    expect(audits).toEqual(expect.arrayContaining([
      { table_name: "rep_payout_summary", row_id: `${slots[0].period}..${slots[1].period} all processors` },
      { table_name: "merchant_processor_summary", row_id: `${slots[0].period}..${slots[0].period} ${slots[0].processor}` },
    ]));
  });

  it("refuses a rep and a deactivated rep with 403, and no file, no audit row", async () => {
    const before = (await adminClient().from("audit_log").select("id").eq("action", "export_report")).data!.length;
    for (const persona of ["owner", "deactivated"] as const) {
      const res = await download(fx.tokens[persona], range());
      expect(res.status, persona).toBe(403);
      expect(JSON.parse(res.bytes.toString("utf8")).error).toBe(persona === "owner" ? "Admin only" : "Account is not active");
    }
    const after = (await adminClient().from("audit_log").select("id").eq("action", "export_report")).data!.length;
    expect(after).toBe(before);
  });

  it("refuses no session and a forged token with 401", async () => {
    expect((await download(null, range())).status).toBe(401);
    const [h, p] = fx.tokens.admin.split(".");
    expect((await download(`${h}.${p}.AAAA`, range())).status).toBe(401);

  });

  it("refuses a bad selection with 400, and an empty one with 404", async () => {
    const bad: Body[] = [
      { ...range(), report: "other" as "reps" },
      { ...range(), from: "2026-07-15" },
      { ...range(), from: range().to, to: range().from },
      { ...range(), processor: "Not A Processor" },
    ];
    if (range().from === range().to) throw new Error("range must span two months");
    for (const selection of bad) {
      expect((await download(fx.tokens.admin, selection)).status, JSON.stringify(selection)).toBe(400);
    }
    // A month nothing is committed for: three years on, past the import window.
    const future = `${Number(slots[1].period.slice(0, 4)) + 3}-01-01`;
    expect((await download(fx.tokens.admin, { report: "reps", from: future, to: future, processor: null })).status).toBe(404);
  });
});
