// Throwaway local-dev bootstrap for the payouts module. Local stack only.
// Adds agent numbers, a committed period of ledger rows, and one review batch
// left blocked on an unknown agent number — so all four /payouts pages have
// something on them.
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

const { data: batch } = await db
  .from("rep_payout_batches")
  .insert({
    imported_by: adminId,
    file_key: "seed/June-2026.xlsx",
    file_name: "June-2026.xlsx",
    status: "committed",
    row_count: 4,
    committed_at: new Date().toISOString(),
  })
  .select("id")
  .single();

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
});

const { error: ledgerError } = await db.from("rep_payout_rows").insert(ledger);
if (ledgerError) throw new Error(`ledger: ${ledgerError.message}`);
console.log(`ledger rows: ${ledger.length} across ${periods.length} periods`);

// A review batch, uploaded and parsed for real so it is blocked the way a real
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
  file_name: "August 2026 residuals.xlsx",
});
if (minted.status !== 200) throw new Error(JSON.stringify(minted.body));

const rows = [
  [
    "Period",
    "Agent #",
    "MID",
    "Merchant name",
    "Volume",
    "Average ticket",
    "Total cost",
  ],
  ["Aug-26", "4471", merchants?.[0]?.mid ?? "MID-1", merchants?.[0]?.dba ?? "A Co", "14,200.00", "58.00", "$355.00"],
  ["Aug-26", "4471", "MID-NEWSHOP", "New Shop LLC", 6100, 33, 152],
  ["Aug-26", "7788", "MID-STRANGER", "Bayside Auto", 2300, 18, 61],
  ["Aug-26", "7788", "MID-STRANGER-2", "Bayside Tyres", 1900, 22, 47],
  ["Q3 2026", "4471", "MID-ODD", "Odd Period Co", 100, 5, 3],
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
