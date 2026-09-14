/**
 * Creates the local development accounts: one agent, one admin.
 *
 *   npm run seed:local
 *
 * Why this is a script and not documentation: `supabase db reset` drops
 * `auth.users` along with everything else, so these accounts vanish every time
 * the schema is rebuilt — which is often while migrations are being written.
 * Re-running this is faster than rediscovering what the credentials were.
 *
 * Why not `supabase/seed.sql`, which would run automatically on reset: seeding
 * an account in SQL means hand-writing a bcrypt hash into `auth.users` and
 * hoping GoTrue's expectations don't shift. Going through the Auth admin API
 * uses the same path production does, so a password that works here works in
 * the app.
 *
 * Local stack only. It reads the URL and keys from `supabase status` and
 * refuses to run against anything that isn't localhost — a service-role key is
 * involved, and this creates accounts.
 */

import { execSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const ACCOUNTS = [
  {
    email: "agent@tapswipe.test",
    password: "local-dev-agent-123",
    full_name: "Avery Agent",
    role: "agent",
  },
  {
    email: "admin@tapswipe.test",
    password: "local-dev-admin-123",
    full_name: "Adrian Admin",
    role: "admin",
  },
];

function statusValue(raw, key) {
  const match = raw.match(new RegExp(`"?${key}"?\\s*[:=]\\s*"([^"]+)"`));
  if (!match) throw new Error(`supabase status did not report ${key}`);
  return match[1];
}

const raw = execSync("npx supabase status -o env", { encoding: "utf8" });
const url = statusValue(raw, "API_URL");
const secretKey = statusValue(raw, "SECRET_KEY");
const publishableKey = statusValue(raw, "PUBLISHABLE_KEY");

const host = new URL(url).hostname;
if (!["127.0.0.1", "localhost", "0.0.0.0"].includes(host)) {
  throw new Error(
    `Refusing to run: ${url} is not a local stack. This uses a service-role ` +
      `key and creates accounts, so it is local-only by design.`,
  );
}

const admin = createClient(url, secretKey, { auth: { persistSession: false } });
const anon = createClient(url, publishableKey, {
  auth: { persistSession: false },
});

// Recreate rather than skip-if-exists, so a half-seeded state (a user with no
// profile row, say) resolves itself instead of persisting as a puzzle.
const { data: existing } = await admin.auth.admin.listUsers();
const wanted = new Set(ACCOUNTS.map((account) => account.email));
/**
 * Every column that references profiles(id), in an order that satisfies the
 * FKs between the tables themselves — replies before tickets, history before
 * rows, rows before batches, children before leads.
 *
 * ALL SEVENTEEN of them are `ON DELETE NO ACTION`, so any single leftover row
 * blocks the delete. This list used to be two entries (audit_log, pre_apps),
 * which was fine only because nothing else had been seeded yet. Once
 * seed-dev-payouts.mjs had run, the rep owned rep_payout_rows, the delete below
 * failed on the FK, the user survived, and createUser then reported
 * `email_exists` (422) — an error naming the one thing that was not the
 * problem. That is the trap CLAUDE.md records a teardown walking into once
 * already, and a partial list is how you walk into it again.
 *
 * Regenerate after adding any table with an agent_id:
 *
 *   select c.conrelid::regclass, a.attname
 *   from pg_constraint c
 *   join unnest(c.conkey) with ordinality k(attnum, ord) on true
 *   join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
 *   where c.contype = 'f' and c.confrelid = 'public.profiles'::regclass;
 */
const PROFILE_REFERENCES = [
  ["rep_payout_row_history", "agent_id"],
  ["rep_payout_row_history", "changed_by"],
  ["rep_payout_rows", "agent_id"],
  ["rep_payout_import_rows", "agent_id"],
  ["rep_payout_batches", "imported_by"],
  ["support_ticket_replies", "author_id"],
  ["support_tickets", "agent_id"],
  ["documents", "agent_id"],
  ["notes", "agent_id"],
  ["tasks", "agent_id"],
  ["bug_reports", "agent_id"],
  ["bug_reports", "resolved_by"],
  ["ghost_sheets", "agent_id"],
  ["pre_apps", "agent_id"],
  ["merchants", "agent_id"],
  ["leads", "agent_id"],
  ["audit_log", "actor_id"],
];

for (const user of existing.users.filter((user) => wanted.has(user.email))) {
  for (const [table, column] of PROFILE_REFERENCES) {
    await admin.from(table).delete().eq(column, user.id);
  }

  // Checked, rather than fired and forgotten. An unchecked delete that fails is
  // exactly how the above presented as a puzzle instead of as a foreign key.
  const { error: deleteError } = await admin.auth.admin.deleteUser(user.id);
  if (deleteError) {
    throw new Error(
      `Could not delete the existing ${user.email}: ` +
        `${deleteError.message || JSON.stringify(deleteError)}\n` +
        `Something still references this profile — most likely a new table ` +
        `with an agent_id that is missing from PROFILE_REFERENCES above. ` +
        `Re-run the query in that comment to find it.`,
    );
  }
}

const results = [];
for (const account of ACCOUNTS) {
  const { data: created, error: createError } =
    await admin.auth.admin.createUser({
      email: account.email,
      password: account.password,
      email_confirm: true,
    });
  if (createError) throw createError;

  // profiles has no insert policy by design — rows are created by the
  // service role, which is what the create-user Edge Function does too.
  const { error: profileError } = await admin.from("profiles").insert({
    id: created.user.id,
    full_name: account.full_name,
    role: account.role,
    is_active: true,
  });
  if (profileError) throw profileError;

  // Prove the credentials actually work rather than assuming the create
  // succeeded — this is the exact call the login form makes.
  const { error: signInError } = await anon.auth.signInWithPassword({
    email: account.email,
    password: account.password,
  });

  results.push({
    email: account.email,
    password: account.password,
    role: account.role,
    signIn: signInError ? `FAILED: ${signInError.message}` : "ok",
  });
}

console.log(`\nLocal accounts on ${url}\n`);
for (const row of results) {
  console.log(`  ${row.role.padEnd(6)} ${row.email.padEnd(24)} ${row.password}`);
  console.log(`         sign-in check: ${row.signIn}`);
}
console.log(
  `\nThese live only in the local stack and are dropped by ` +
    `\`supabase db reset\`. Re-run \`npm run seed:local\` after a reset.\n`,
);
