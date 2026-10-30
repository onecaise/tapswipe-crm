// Throwaway local-dev bootstrap for the payouts module. Local stack only.
// Adds agent numbers (a display code), a committed period of ledger rows, and
// one review batch in the six-column processor format (phase 7 of
// docs/design/intake-and-reports.md), refused for unknown MIDs and a wrong
// Income Type and carrying a processor-mismatch warning -- so all four
// /payouts pages have something on them.
import { execSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";

const raw = execSync("npx supabase status -o env", { encoding: "utf8" });
const cfg = new Map();
for (const line of raw.split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)="?(.*?)"?$/.exec(line.trim());
  if (m) cfg.set(m[1], m[2]);
}
const API = cfg.get("API_URL");
const ANON = cfg.get("ANON_KEY");
const SRK = cfg.get("SERVICE_ROLE_KEY");
if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(API ?? "")) {
  throw new Error(`Refusing to seed a non-local host: ${API}`);
}

const db = createClient(API, SRK, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data: users } = await db.auth.admin.listUsers({ perPage: 1000 });
const byEmail = new Map((users?.users ?? []).map((u) => [u.email, u.id]));
const adminId = byEmail.get("admin@tapswipe.test");
const agentId = byEmail.get("agent@tapswipe.test");
if (!adminId || !agentId) throw new Error("Run seed-dev-local.mjs first.");

await db.from("profiles").update({ agent_number: "4471" }).eq("id", agentId);
await db.from("profiles").update({ agent_number: "0001" }).eq("id", adminId);
console.log("agent numbers: agent=4471 admin=0001");

// Reset payout data so this is re-runnable.
await db.from("rep_payout_row_history").delete().neq("id", 0);
await db.from("rep_payout_rows").delete().neq("id", 0);
await db.from("rep_payout_import_rows").delete().neq("id", 0);
await db.from("rep_payout_batches").delete().neq("id", 0);

const { data: merchants } = await db
  .from("merchants")
  .select("id, mid, dba, agent_id")
  .not("mid", "is", null);
console.log(
  "merchants:",
  (merchants ?? []).map((m) => `${m.mid}=${m.dba}`).join(", "),
);

// Batches carry a processor and month (required since 20261030140000), inside
// the import window: last month for the committed one, this month for the one
// in review. The ledger lines keep the fixed months the pages are read at.
const monthsBack = (n) => {
  const now = new Date();
  const index = now.getUTCFullYear() * 12 + now.getUTCMonth() - n;
  const year = Math.floor(index / 12);
  return `${year}-${String(index - year * 12 + 1).padStart(2, "0")}-01`;
};

const { data: batch, error: batchError } = await db
  .from("rep_payout_batches")
  .insert({
    imported_by: adminId,
    file_key: "seed/June-2026.xlsx",
    file_name: "June-2026.xlsx",
    status: "committed",
    row_count: 4,
    committed_at: new Date().toISOString(),
    processor: "TSYS",
    period: monthsBack(1),
  })
  .select("id")
  .single();
if (batchError) throw new Error(`batch: ${batchError.message}`);

// Two periods, and one row deliberately left without figures so the "awaiting
// figures" states have something to show.
const ledger = [];
const periods = ["2026-06-01", "2026-07-01"];
for (const period of periods) {
  for (const [index, merchant] of (merchants ?? []).entries()) {
    const filled = !(period === "2026-07-01" && index === 0);
    ledger.push({
      agent_id: merchant.agent_id,
      period,
      mid: merchant.mid,
      merchant_name: merchant.dba,
      merchant_id: merchant.id,
      volume: 8000 + index * 2100,
      average_ticket: 40 + index * 7,
      total_cost: 190 + index * 35,
      residual_income: filled ? 60 + index * 14.5 : null,
      rep_split_pct: filled ? 60 : null,
      batch_id: batch.id,
      processor: "TSYS",
    });
  }
}
// One clawback, so a negative renders somewhere.
ledger.push({
  agent_id: agentId,
  period: "2026-07-01",
  mid: "MID-CHARGEBACK",
  merchant_name: "Adjustment — chargeback",
  merchant_id: null,
  volume: 0,
  average_ticket: 0,
  total_cost: -12.5,
  residual_income: -18.5,
  rep_split_pct: 60,
  batch_id: batch.id,
  processor: "TSYS",
});

const { error: ledgerError } = await db.from("rep_payout_rows").insert(ledger);
if (ledgerError) throw new Error(`ledger: ${ledgerError.message}`);
console.log(`ledger rows: ${ledger.length} across ${periods.length} periods`);

// A review batch, uploaded and parsed for real so it is refused the way a real
// one would be.
const anon = createClient(API, ANON, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const { data: session, error: signInError } = await anon.auth.signInWithPassword({
  email: "admin@tapswipe.test",
  password: "TapswipeDev123!",
});
if (signInError) throw new Error(`sign in: ${signInError.message}`);
const token = session.session.access_token;

const call = async (name, body) => {
  const res = await fetch(`${API}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      apikey: ANON,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const minted = await call("residual-import-file-url", {
  file_name: "TSYS residuals.xlsx",
  processor: "TSYS",
  period: monthsBack(0),
});
if (minted.status !== 200 || !minted.body.batch_id) {
  throw new Error(JSON.stringify(minted.body));
}

const rows = [
  ["Processor", "Merchant Number", "Merchant Name", "Income Type", "Volume", "Residual"],
  ["TSYS", merchants?.[0]?.mid ?? "000000000001", merchants?.[0]?.dba ?? "A Co", "Residuals", "$14,200.00", "$355.00"],
  ["Netevia HQ", merchants?.[1]?.mid ?? "000000000002", merchants?.[1]?.dba ?? "B Co", "Residuals", "$6,100.00", "$152.00"],
  ["TSYS", "440012345678", "Bayside Auto", "Residuals", "$2,300.00", "$61.00"],
  ["TSYS", "440012345679", "Bayside Tyres", "Residuals", "$1,900.00", "-$11.76"],
  ["TSYS", merchants?.[2]?.mid ?? "000000000003", "Odd Co", "Fees", "$100.00", "$3.00"],
];
const buffer = XLSX.write(
  (() => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), "Residuals");
    return book;
  })(),
  { type: "buffer", bookType: "xlsx" },
);

const asAdmin = createClient(API, ANON, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { Authorization: `Bearer ${token}` } },
});
const up = await asAdmin.storage
  .from("residual-imports")
  .uploadToSignedUrl(minted.body.path, minted.body.token, buffer, {
    contentType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
if (up.error) throw new Error(`upload: ${up.error.message}`);

const parsed = await call("parse-residual-import", {
  batch_id: minted.body.batch_id,
});
console.log(
  `review batch ${minted.body.batch_id}: ${JSON.stringify(parsed.body)}`,
);

console.log("\nsign in at http://localhost:3000 as:");
console.log("  admin@tapswipe.test / TapswipeDev123!");
console.log("  agent@tapswipe.test / TapswipeDev123!");
