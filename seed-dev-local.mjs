// Throwaway local-dev bootstrap: two users + a little demo data.
//
//   node seed-dev-local.mjs          # then optionally seed-dev-payouts.mjs
//
// Run against the LOCAL stack only. It hard-refuses any other host, because it
// holds the service-role key and creates accounts with known passwords.
//
// THIS COLLIDES WITH `npm run seed:local`, deliberately and unavoidably. Both
// claim admin@tapswipe.test and agent@tapswipe.test, both delete-then-recreate,
// and the passwords differ — TapswipeDev123! here, local-dev-<role>-123 there.
// Whichever ran last owns the login. They are not redundant: scripts/
// seed-local-users.mjs is two bare accounts and nothing else, which is what you
// want when testing migrations; this one fills the app with merchants, leads,
// pre-apps, tickets, notes and tasks so the pages have something on them.
// Pick one per session rather than alternating, and see the README.
//
// Users are created the same way create-user does it — auth.admin.createUser
// plus a service-role insert into profiles, since profiles has no insert
// policy. must_change_password is left false here on purpose: this is a
// look-around login, not a provisioning drill.

import { execSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const raw = execSync("npx supabase status -o env", { encoding: "utf8" });
const cfg = new Map();
for (const line of raw.split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)="?(.*?)"?$/.exec(line.trim());
  if (m) cfg.set(m[1], m[2]);
}
const API_URL = cfg.get("API_URL");
const SERVICE_KEY = cfg.get("SERVICE_ROLE_KEY");
if (!API_URL || !SERVICE_KEY) throw new Error("Local stack is not running.");
if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(API_URL)) {
  throw new Error(`Refusing to seed a non-local host: ${API_URL}`);
}

const db = createClient(API_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const PASSWORD = "TapswipeDev123!";
const PEOPLE = [
  {
    email: "admin@tapswipe.test",
    fullName: "Dev Admin",
    role: "admin",
    key: "admin",
  },
  {
    email: "agent@tapswipe.test",
    fullName: "Dev Agent",
    role: "agent",
    key: "agent",
  },
];

const ids = {};

// Idempotent: drop any previous run's accounts first, in FK order.
const { data: existing } = await db.auth.admin.listUsers({ perPage: 1000 });
const emails = new Set(PEOPLE.map((p) => p.email));
for (const user of existing?.users ?? []) {
  if (!user.email || !emails.has(user.email)) continue;
  for (const table of [
    "documents",
    "notes",
    "tasks",
    "support_tickets",
    "pre_apps",
    "ghost_sheets",
    "merchants",
    "leads",
  ]) {
    await db.from(table).delete().eq("agent_id", user.id);
  }
  await db.from("audit_log").delete().eq("actor_id", user.id);
  await db.from("audit_log").delete().eq("row_id", user.id);
  await db.auth.admin.deleteUser(user.id);
  console.log(`removed previous ${user.email}`);
}
// The seeds above run as service role, which has no auth.uid(), so every one
// of them trips log_cross_agent_change() and leaves a cross_agent_* row.
await db.from("audit_log").delete().is("actor_id", null);

for (const person of PEOPLE) {
  const { data, error } = await db.auth.admin.createUser({
    email: person.email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error) throw new Error(`${person.email}: ${error.message}`);
  ids[person.key] = data.user.id;

  const { error: profileError } = await db.from("profiles").insert({
    id: data.user.id,
    full_name: person.fullName,
    // Mirrors create-user, which copies it from the created auth user so the
    // Manage Users page has something to show. Without it seeded accounts
    // render an em dash where every real account shows an address.
    email: data.user.email,
    role: person.role,
    is_active: true,
    must_change_password: false,
  });
  if (profileError) throw new Error(`${person.email}: ${profileError.message}`);
  console.log(`created ${person.email} (${person.role})`);
}

// The documents bucket is created out-of-band in production — it is in no
// migration, so a freshly reset stack has none and every signing call 404s.
//
// fileSizeLimit is set here AND re-asserted below, because config.toml's
// `[storage] file_size_limit` does not constrain a signed upload — measured, a
// 120 MiB PUT went through with it set to 50MiB. The per-bucket limit is the real
// ceiling, and it was null.
//
// BOTH buckets, not just documents. residual-imports is what seed-dev-payouts
// uploads its XLSX into, and it used to be missing here — so that script died on
// a fresh stack with `Could not create upload URL: The related resource does not
// exist`, which names neither the bucket nor the fix. Cheap to create, and the
// pair is meant to be runnable back to back.
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
for (const bucket of ["documents", "residual-imports"]) {
  const { error: bucketError } = await db.storage.createBucket(bucket, {
    public: false,
    fileSizeLimit: MAX_DOCUMENT_BYTES,
  });
  if (bucketError && !/exists/i.test(bucketError.message)) {
    throw new Error(`${bucket} bucket: ${bucketError.message}`);
  }
  // A bucket created before the limit existed keeps accepting unbounded uploads
  // and says nothing about it, so the limit is applied on every run rather than
  // only at creation.
  const { error: bucketLimitError } = await db.storage.updateBucket(bucket, {
    public: false,
    fileSizeLimit: MAX_DOCUMENT_BYTES,
  });
  if (bucketLimitError) {
    throw new Error(`${bucket} bucket limit: ${bucketLimitError.message}`);
  }
  console.log(`${bucket} bucket ready (50 MiB limit)`);
}

const insert = async (table, rows) => {
  const { data, error } = await db.from(table).insert(rows).select("id");
  if (error) throw new Error(`${table}: ${error.message}`);
  return data.map((r) => r.id);
};

const agent = ids.agent;
const admin = ids.admin;

const merchants = await insert("merchants", [
  {
    agent_id: agent,
    mid: "TS-4410221",
    dba: "Bayside Coffee Roasters",
    legal_business_name: "Bayside Coffee Roasters LLC",
    status: "active",
    processor: "TSYS",
    split_agent_pct: 55,
    split_company_pct: 45,
  },
  {
    agent_id: agent,
    mid: "TS-4410318",
    dba: "Northgate Auto Detailing",
    legal_business_name: "Northgate Auto Detailing Inc",
    status: "active",
    processor: "First Data",
    split_agent_pct: 50,
    split_company_pct: 50,
  },
  {
    agent_id: agent,
    mid: "TS-4409877",
    dba: "Rivera Family Dentistry",
    legal_business_name: "Rivera Family Dentistry PC",
    status: "inactive",
    processor: "TSYS",
  },
  {
    agent_id: admin,
    mid: "TS-4410990",
    dba: "Summit Hardware Supply",
    legal_business_name: "Summit Hardware Supply Co",
    status: "active",
    processor: "Elavon",
  },
]);

const leads = await insert("leads", [
  {
    agent_id: agent,
    lead_source: "Referral",
    merchant_legal_name: "Ocean Ave Pizza LLC",
    dba: "Ocean Ave Pizza",
    contact_name: "Marco Ruiz",
    contact_phone: "(555) 201-8834",
    contact_email: "marco@oceanavepizza.test",
    city: "San Diego",
    state: "CA",
    zip: "92109",
    status: "open",
    probability_to_close: "High",
    industry_vertical: "Restaurant",
    next_followup_date: "2026-08-14",
  },
  {
    agent_id: agent,
    lead_source: "Cold call",
    merchant_legal_name: "Trailhead Outfitters Inc",
    dba: "Trailhead Outfitters",
    contact_name: "Dana Whitfield",
    contact_phone: "(555) 447-1120",
    contact_email: "dana@trailheadout.test",
    city: "Boulder",
    state: "CO",
    zip: "80302",
    status: "contacted",
    probability_to_close: "Medium",
    industry_vertical: "Retail",
    next_followup_date: "2026-08-18",
  },
  {
    agent_id: agent,
    lead_source: "Web form",
    merchant_legal_name: "Lumen Wellness Studio LLC",
    dba: "Lumen Wellness",
    contact_name: "Priya Raman",
    contact_phone: "(555) 908-6612",
    contact_email: "priya@lumenwellness.test",
    city: "Austin",
    state: "TX",
    zip: "78704",
    status: "open",
    probability_to_close: "Low",
    industry_vertical: "Health & Fitness",
  },
  {
    agent_id: admin,
    lead_source: "Trade show",
    merchant_legal_name: "Cascade Print Works LLC",
    dba: "Cascade Print Works",
    contact_name: "Ellis Grant",
    contact_phone: "(555) 330-7781",
    city: "Portland",
    state: "OR",
    status: "open",
  },
]);

await insert("ghost_sheets", [
  {
    agent_id: agent,
    dba: "Harbor Bistro",
    contact_name: "Nils Andersen",
    contact_phone: "(555) 662-4417",
    notes: "Walked in off the street. Wants rates on a Clover Mini.",
    status: "open",
  },
  {
    agent_id: agent,
    lead_id: leads[1],
    dba: "Trailhead Outfitters",
    contact_name: "Dana Whitfield",
    contact_phone: "(555) 447-1120",
    notes: "Converted from the ghost sheet after the second call.",
    status: "converted",
  },
]);

const preApps = await insert("pre_apps", [
  {
    agent_id: agent,
    lead_id: leads[0],
    status: "draft",
    dba_name: "Ocean Ave Pizza",
    legal_business_name: "Ocean Ave Pizza LLC",
    contact_name: "Marco Ruiz",
    contact_phone: "(555) 201-8834",
    email_address: "marco@oceanavepizza.test",
    physical_address: "3312 Ocean Ave",
    city: "San Diego",
    state: "CA",
    zip: "92109",
    legal_entity_type: "LLC",
    business_type: "Restaurant",
    goods_sold: "Prepared food and beverages",
    billing_type: "gross",
    bank_name: "Pacific Coast Bank",
    split_agent_pct: 55,
    split_company_pct: 45,
  },
  {
    agent_id: agent,
    // Was 'submitted' with a date_submitted of 2026-08-10, and could not stay
    // that way: pre_apps_guard_transitions became BEFORE INSERT OR UPDATE in
    // 20260916104500, so a pre-app is born a draft for everyone — the
    // service-role key this script holds is not an exemption, and the escape
    // hatch is a session GUC that PostgREST gives no way to set.
    //
    // Seeding a genuinely submitted pre-app now means driving submit_pre_app()
    // as a signed-in user, which wants an SSN ciphertext per owner, and this
    // script deliberately seeds no owner secrets (see the note further down).
    // So the demo data is drafts only, and the admin approval queue starts
    // empty. If that queue is what you came to look at, submit this one from
    // the wizard at /pre-apps — which is the flow it was skipping anyway.
    status: "draft",
    dba_name: "Lumen Wellness",
    legal_business_name: "Lumen Wellness Studio LLC",
    contact_name: "Priya Raman",
    contact_phone: "(555) 908-6612",
    email_address: "priya@lumenwellness.test",
    physical_address: "1140 S Lamar Blvd",
    city: "Austin",
    state: "TX",
    zip: "78704",
    legal_entity_type: "LLC",
    business_type: "Health & Fitness",
    goods_sold: "Class packages and memberships",
    billing_type: "net",
    bank_name: "Lone Star Credit Union",
    // Stated rather than left to the column default: a multi-row insert unions
    // the keys across rows and fills the gaps with NULL, not with the default,
    // and split_agent_pct is not null.
    split_agent_pct: 50,
    split_company_pct: 50,
  },
]);

// Owners, so each pre-app's detail page is not an empty section. The SSN lives
// in pre_app_owner_secrets and is deliberately NOT seeded here: it is reachable
// only through submit-pre-app-secrets, which encrypts it.
//
// Priya holds 100%, so the Lumen Wellness draft already satisfies
// submit_pre_app's "one owner at 51%+" rule — supply the SSN in the wizard and
// it submits. That is the only route to a submitted pre-app in dev now; see the
// note on its status above.
await insert("pre_app_owners", [
  {
    pre_app_id: preApps[1],
    owner_name: "Priya Raman",
    title: "Managing Member",
    percent_owned: 100,
    home_city: "Austin",
    home_state: "TX",
    home_zip: "78704",
    length_of_ownership: "4 years",
  },
  {
    pre_app_id: preApps[0],
    owner_name: "Marco Ruiz",
    title: "Owner",
    percent_owned: 60,
    home_city: "San Diego",
    home_state: "CA",
    home_zip: "92109",
  },
]);

await insert("support_tickets", [
  {
    agent_id: agent,
    merchant_id: merchants[0],
    category: "Terminal",
    sub_category: "Hardware",
    priority: "High",
    serial_number_imei: "C030UQ52340118",
    subject: "Clover Mini will not boot after firmware update",
    message:
      "Merchant reports the terminal hangs on the splash screen since Tuesday. Needs a swap unit.",
    status: "open",
  },
  {
    agent_id: agent,
    merchant_id: merchants[1],
    category: "Statements",
    priority: "Normal",
    subject: "July statement shows a duplicate monthly fee",
    message: "Two $19.95 gateway fees on the same statement. Requesting a refund.",
    status: "pending",
  },
]);

await insert("notes", [
  {
    agent_id: agent,
    owner_type: "merchant",
    owner_id: merchants[0],
    body: "Owner asked about adding a second terminal for the patio in the spring.",
  },
  {
    agent_id: agent,
    owner_type: "lead",
    owner_id: leads[0],
    body: "Left voicemail Tuesday. Callback window is after 3pm on weekdays.",
  },
  {
    agent_id: agent,
    owner_type: "lead",
    owner_id: leads[0],
    body: "Reached Marco — wants a rate comparison against his current processor.",
  },
]);

await insert("tasks", [
  {
    agent_id: agent,
    owner_type: "lead",
    owner_id: leads[0],
    title: "Send rate comparison sheet",
    due_date: "2026-08-14",
    completed: false,
  },
  {
    agent_id: agent,
    owner_type: "lead",
    owner_id: leads[1],
    title: "Follow up on the Clover demo",
    due_date: "2026-08-18",
    completed: false,
  },
  {
    agent_id: agent,
    owner_type: "merchant",
    owner_id: merchants[0],
    title: "Confirm the swap terminal shipped",
    due_date: "2026-08-13",
    completed: true,
  },
]);

// Same reason as above: every insert here ran as service role, so each one
// stamped a cross_agent_insert with a null actor. Clearing them keeps the audit
// trail readable — what is left will be real actions taken through the UI.
await db.from("audit_log").delete().is("actor_id", null);

console.log("\nseeded:");
console.log(`  merchants       ${merchants.length} (3 agent, 1 admin)`);
console.log(`  leads           ${leads.length} (3 agent, 1 admin)`);
console.log("  ghost sheets    2   pre-apps 2 (1 draft, 1 submitted)");
console.log("  tickets         2   notes 3   tasks 3");
