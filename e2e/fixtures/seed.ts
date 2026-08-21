import { execSync } from "node:child_process";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Fixtures for the e2e suite: three personas and five period states.
 *
 * **This suite provisions its own data and does not depend on the seed-dev-*
 * scripts.** That is the difference between a suite and a script that works on
 * one machine: those scripts are throwaway bootstraps an operator runs by hand,
 * and a spec that assumed their output would pass or fail according to what
 * somebody last clicked. Everything the specs assert on is created here.
 *
 * Runs against the LOCAL stack only, and refuses anything else — it holds the
 * service-role key and creates accounts with a known password. Same guard, and
 * same reason, as tests/live/helpers/stack.ts.
 *
 * Idempotent by construction: personas are looked up before being created, and
 * the payout rows for the periods below are deleted and rewritten on every run.
 * So `npm run test:e2e` twice in a row is the same as once, which matters
 * because a failed run leaves whatever it had done behind.
 */

/** Known, throwaway, local-only. Mirrors PASSWORD in tests/live/helpers. */
export const E2E_PASSWORD = "e2e-test-password-123";

export const PERSONAS = {
  admin: { email: "e2e-admin@tapswipe.test", fullName: "E2E Admin", role: "admin", agentNumber: "9001" },
  agent: { email: "e2e-agent@tapswipe.test", fullName: "E2E Agent", role: "agent", agentNumber: "9002" },
  agent2: { email: "e2e-agent2@tapswipe.test", fullName: "E2E Agent Two", role: "agent", agentNumber: "9003" },
} as const;

export type PersonaKey = keyof typeof PERSONAS;

/**
 * Where auth.setup.ts saves each persona's cookies, and where every spec reads
 * them from. Repo-root-relative: Playwright resolves storageState from the cwd,
 * and npm run test:e2e runs from the root.
 *
 * Lives here rather than in auth.setup.ts because Playwright forbids a spec
 * importing a test file — so anything shared between setup and the specs has to
 * sit in a plain module.
 */
export const storageStateFor = (persona: PersonaKey): string =>
  `e2e/.auth/${persona}.json`;

/**
 * The period states the specs exercise. Kept here rather than inline in the
 * specs so a spec names the state it is about ("EMPTY_PERIOD") instead of a
 * bare date whose significance is invisible.
 */
export const PERIODS = {
  /** Many rows, three reps — the scoping and grouping case. */
  many: "2027-04",
  /** Exactly one row, for the singular/plural and one-group case. */
  single: "2027-05",
  /** The value edge cases: null, zero, negative, huge, long text. */
  edge: "2027-03",
  /** Valid format, deliberately no rows — the empty-state case. */
  empty: "2027-09",
} as const;

/** The long merchant name whose nowrap once pushed six money columns off screen. */
export const LONG_MERCHANT_NAME =
  "Extremely Long Merchant Trading Name That Will Not Fit In A Table Cell Without Being Truncated Somehow";

/** The largest value numeric(14,2) holds, and the one StatCard used to clip. */
export const HUGE_FIGURE = 999999999999.99;

/**
 * The API URL and PUBLISHABLE key, for specs that forge a request the way
 * someone with devtools open would.
 *
 * Read from `supabase status` rather than scraped from the page: Next inlines
 * NEXT_PUBLIC_* at build time, so `process.env` does not exist in the browser
 * and `page.evaluate(() => process.env.X)` throws a ReferenceError rather than
 * returning undefined. The service-role key is deliberately NOT exposed here —
 * a spec that could bypass RLS could not prove anything about it.
 */
export function publicStackConfig(): { apiUrl: string; publishableKey: string } {
  const { apiUrl } = localStackConfig();
  const raw = execSync("npx supabase status -o env", { encoding: "utf8" });
  const match = /^PUBLISHABLE_KEY="?(.*?)"?$/m.exec(raw);
  if (!match) throw new Error("No PUBLISHABLE_KEY from supabase status");
  return { apiUrl, publishableKey: match[1] };
}

export type SeedResult = {
  ids: Record<PersonaKey, string>;
  apiUrl: string;
};

function localStackConfig(): { apiUrl: string; serviceKey: string } {
  const raw = execSync("npx supabase status -o env", { encoding: "utf8" });
  const cfg = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)="?(.*?)"?$/.exec(line.trim());
    if (match) cfg.set(match[1], match[2]);
  }

  const apiUrl = cfg.get("API_URL");
  const serviceKey = cfg.get("SERVICE_ROLE_KEY");
  if (!apiUrl || !serviceKey) {
    throw new Error(
      "Local Supabase stack is not running. Start it with `npx supabase start`.",
    );
  }
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(apiUrl)) {
    throw new Error(`Refusing to seed a non-local host: ${apiUrl}`);
  }

  return { apiUrl, serviceKey };
}

async function ensurePersona(
  db: SupabaseClient,
  key: PersonaKey,
): Promise<string> {
  const persona = PERSONAS[key];

  const { data: existing } = await db.auth.admin.listUsers({ perPage: 1000 });
  const found = (existing?.users ?? []).find((u) => u.email === persona.email);

  if (found) {
    // Re-assert the profile so a half-provisioned run from a previous failure
    // converges rather than persisting. agent_number in particular is what the
    // period page renders beside the rep's name.
    const { error } = await db
      .from("profiles")
      .update({
        full_name: persona.fullName,
        role: persona.role,
        is_active: true,
        must_change_password: false,
        agent_number: persona.agentNumber,
      })
      .eq("id", found.id);
    if (error) throw new Error(`${persona.email} profile: ${error.message}`);
    return found.id;
  }

  const { data, error } = await db.auth.admin.createUser({
    email: persona.email,
    password: E2E_PASSWORD,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(`${persona.email}: ${error?.message ?? "no user"}`);
  }

  // profiles has no insert policy — rows are created by service role alongside
  // auth.users, exactly as the create-user Edge Function does it.
  const { error: profileError } = await db.from("profiles").insert({
    id: data.user.id,
    full_name: persona.fullName,
    email: data.user.email,
    role: persona.role,
    is_active: true,
    must_change_password: false,
    agent_number: persona.agentNumber,
  });
  if (profileError) {
    // Half an account is the ghost-user state lib/auth.ts routes to
    // /auth/error?error=no-profile. Undo rather than leave one behind.
    await db.auth.admin.deleteUser(data.user.id);
    throw new Error(`${persona.email} profile: ${profileError.message}`);
  }

  return data.user.id;
}

const firstOfMonth = (period: string) => `${period}-01`;

type LedgerRow = {
  agent_id: string;
  period: string;
  mid: string;
  merchant_name: string | null;
  volume: number | null;
  average_ticket: number | null;
  total_cost: number | null;
  residual_income: number | null;
  rep_split_pct: number | null;
};

function ledgerRows(ids: Record<PersonaKey, string>): LedgerRow[] {
  const rows: LedgerRow[] = [];

  // --- many: three reps, so "an agent sees only their own" can actually fail.
  for (let i = 0; i < 6; i += 1) {
    rows.push({
      agent_id: ids.agent, period: firstOfMonth(PERIODS.many),
      mid: `E2E-A${1000 + i}`, merchant_name: `E2E Agent Merchant ${i + 1}`,
      volume: 10000 + i * 100, average_ticket: 40, total_cost: 300,
      residual_income: 500 + i * 10, rep_split_pct: 55,
    });
  }
  for (let i = 0; i < 4; i += 1) {
    rows.push({
      agent_id: ids.agent2, period: firstOfMonth(PERIODS.many),
      mid: `E2E-B${2000 + i}`, merchant_name: `E2E Agent Two Merchant ${i + 1}`,
      volume: 8000, average_ticket: 30, total_cost: 200,
      residual_income: 400, rep_split_pct: 50,
    });
  }
  rows.push({
    agent_id: ids.admin, period: firstOfMonth(PERIODS.many),
    mid: "E2E-C3000", merchant_name: "E2E Admin Merchant",
    volume: 25000, average_ticket: 99, total_cost: 900,
    residual_income: 1200, rep_split_pct: 60,
  });
  // The long-name regression lives HERE, in a period of otherwise ordinary
  // figures, and deliberately not only in the edge period. The edge period also
  // contains a trillion-dollar row, which makes that table genuinely wider than
  // the viewport on its own — so an "all columns visible" assertion there would
  // be testing two variables at once and would fail for the wrong reason. With
  // normal figures alongside it, a long name is the only thing that could push
  // the money columns off screen, which is exactly the bug.
  rows.push({
    agent_id: ids.agent, period: firstOfMonth(PERIODS.many),
    mid: "E2E-A-LONGNAME", merchant_name: LONG_MERCHANT_NAME,
    volume: 9000, average_ticket: 35, total_cost: 250,
    residual_income: 450, rep_split_pct: 55,
  });

  // --- single: exactly one row, one group.
  rows.push({
    agent_id: ids.agent, period: firstOfMonth(PERIODS.single),
    mid: "E2E-SOLO", merchant_name: "E2E Only Merchant",
    volume: 1234.56, average_ticket: 12.34, total_cost: 100,
    residual_income: 250.5, rep_split_pct: 55,
  });

  // --- edge: one row per value case the ledger can actually hold.
  const edge: Omit<LedgerRow, "agent_id" | "period">[] = [
    { mid: "E2E-NULL-BOTH", merchant_name: "Both figures null",
      volume: 5000, average_ticket: 20, total_cost: 100,
      residual_income: null, rep_split_pct: null },
    { mid: "E2E-ZERO", merchant_name: "All zeroes",
      volume: 0, average_ticket: 0, total_cost: 0,
      residual_income: 0, rep_split_pct: 0 },
    { mid: "E2E-ZERO-SPLIT", merchant_name: "Zero split real residual",
      volume: 900, average_ticket: 9, total_cost: 9,
      residual_income: 750.25, rep_split_pct: 0 },
    { mid: "E2E-CLAWBACK", merchant_name: "Clawback month",
      volume: 0, average_ticket: 0, total_cost: -450.75,
      residual_income: -820.4, rep_split_pct: 55 },
    { mid: "E2E-HUGE", merchant_name: "Enormous figures",
      volume: HUGE_FIGURE, average_ticket: HUGE_FIGURE,
      total_cost: HUGE_FIGURE, residual_income: HUGE_FIGURE,
      rep_split_pct: 100 },
    // Postgres rounds these to the column's scale on the way in, which is what
    // makes "more precision than the UI expects" unreachable from the database.
    { mid: "E2E-PRECISION", merchant_name: "Over-precise input",
      volume: 1234.5678, average_ticket: 9.876543,
      total_cost: 0.005, residual_income: 88.4567, rep_split_pct: 33.333 },
    { mid: "E2E-NULL-NAME", merchant_name: null,
      volume: 700, average_ticket: 7, total_cost: 70,
      residual_income: 70, rep_split_pct: 50 },
    { mid: "E2E-INJECTION", merchant_name: "<script>alert('xss')</script>",
      volume: 700, average_ticket: 7, total_cost: 70,
      residual_income: 70, rep_split_pct: 50 },
    { mid: "E2E-LONG-NAME", merchant_name: LONG_MERCHANT_NAME,
      volume: 700, average_ticket: 7, total_cost: 70,
      residual_income: 70, rep_split_pct: 50 },
  ];
  for (const row of edge) {
    rows.push({ agent_id: ids.agent, period: firstOfMonth(PERIODS.edge), ...row });
  }
  // One edge-period row for the other rep, so the edge period is also a
  // scoping case rather than only a rendering one.
  rows.push({
    agent_id: ids.agent2, period: firstOfMonth(PERIODS.edge),
    mid: "E2E-OTHER-REP", merchant_name: "Belongs to agent two",
    volume: 100, average_ticket: 1, total_cost: 10,
    residual_income: 10, rep_split_pct: 50,
  });

  return rows;
}

/**
 * Provision everything the specs need. Safe to call repeatedly.
 *
 * The five payout tables are cleared only for the periods this suite owns, so
 * running it does not wipe whatever an operator has been looking at in the dev
 * database — the periods are deliberately in 2027 to keep them out of the way of
 * the seed-dev scripts' 2026.
 */
export async function seedE2E(): Promise<SeedResult> {
  const { apiUrl, serviceKey } = localStackConfig();
  const db = createClient(apiUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const ids = {
    admin: await ensurePersona(db, "admin"),
    agent: await ensurePersona(db, "agent"),
    agent2: await ensurePersona(db, "agent2"),
  } satisfies Record<PersonaKey, string>;

  const ownedPeriods = Object.values(PERIODS).map(firstOfMonth);

  // History first: rep_payout_row_history.row_id references the ledger, and the
  // FK is NO ACTION — the same five-door trap CLAUDE.md documents for deleting
  // a user. Deleting rows without clearing history fails on the FK.
  const { data: doomed } = await db
    .from("rep_payout_rows")
    .select("id")
    .in("period", ownedPeriods);
  const doomedIds = (doomed ?? []).map((r) => r.id as number);
  if (doomedIds.length > 0) {
    await db.from("rep_payout_row_history").delete().in("row_id", doomedIds);
  }
  await db.from("rep_payout_rows").delete().in("period", ownedPeriods);

  const rows = ledgerRows(ids);
  const { error } = await db.from("rep_payout_rows").insert(rows);
  if (error) throw new Error(`ledger seed: ${error.message}`);

  return { ids, apiUrl };
}

/**
 * A clean batch staged and ready to commit, for the commit specs.
 *
 * Returned rather than created in a fixture, because a commit is destructive to
 * its own batch: each commit spec needs its own, and reusing one would make the
 * second spec depend on the first having not run.
 */
export async function createCommittableBatch(
  agentPeriod: string,
  rowCount = 3,
): Promise<number> {
  const { apiUrl, serviceKey } = localStackConfig();
  const db = createClient(apiUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: adminUsers } = await db.auth.admin.listUsers({ perPage: 1000 });
  const adminId = (adminUsers?.users ?? []).find(
    (u) => u.email === PERSONAS.admin.email,
  )?.id;
  const agentId = (adminUsers?.users ?? []).find(
    (u) => u.email === PERSONAS.agent.email,
  )?.id;
  if (!adminId || !agentId) throw new Error("Run seedE2E() first.");

  const { data: batch, error: batchError } = await db
    .from("rep_payout_batches")
    .insert({
      imported_by: adminId,
      file_key: `e2e/${agentPeriod}.xlsx`,
      file_name: `e2e-${agentPeriod}.xlsx`,
      status: "review",
    })
    .select("id")
    .single();
  if (batchError || !batch) {
    throw new Error(`batch: ${batchError?.message ?? "no row"}`);
  }

  const batchId = batch.id as number;
  const staged = Array.from({ length: rowCount }, (_, i) => ({
    batch_id: batchId,
    row_number: i + 1,
    mid_raw: `E2E-COMMIT-${batchId}-${i + 1}`,
    merchant_name_raw: `E2E Commit Merchant ${i + 1}`,
    period: firstOfMonth(agentPeriod),
    agent_id: agentId,
    volume: 1000 * (i + 1),
    average_ticket: 10,
    total_cost: 50,
    residual_income: 200 * (i + 1),
    rep_split_pct: 55,
  }));

  const { error: rowsError } = await db
    .from("rep_payout_import_rows")
    .insert(staged);
  if (rowsError) throw new Error(`staging: ${rowsError.message}`);

  return batchId;
}

/** Counts that prove a commit happened exactly once. */
export async function commitEvidence(batchId: number): Promise<{
  auditRows: number;
  ledgerRows: number;
  status: string | null;
  stagingLeft: number;
}> {
  const { apiUrl, serviceKey } = localStackConfig();
  const db = createClient(apiUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const [audit, ledger, batch, staging] = await Promise.all([
    db.from("audit_log").select("id", { count: "exact", head: true })
      .eq("action", "commit_residual_import").eq("row_id", String(batchId)),
    db.from("rep_payout_rows").select("id", { count: "exact", head: true })
      .eq("batch_id", batchId),
    db.from("rep_payout_batches").select("status").eq("id", batchId).maybeSingle(),
    db.from("rep_payout_import_rows").select("id", { count: "exact", head: true })
      .eq("batch_id", batchId),
  ]);

  return {
    auditRows: audit.count ?? 0,
    ledgerRows: ledger.count ?? 0,
    status: (batch.data?.status as string | undefined) ?? null,
    stagingLeft: staging.count ?? 0,
  };
}
