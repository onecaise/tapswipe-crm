// commit_residual_import_v3's locks under two REAL connections (phase 9 of
// docs/design/intake-and-reports.md). PGlite is one connection, so nothing
// hermetic can race; this file runs against the local stack's Postgres 17.
//
// Run with:  npm run test:live   (needs `supabase start` and Docker; no Edge
// Function is called, so this file does not need skipWhenFunctionsDown)
//
// Two `docker exec ... psql` sessions, each acting as the admin the way
// PostgREST does (role authenticated, request.jwt.claims carrying the sub).
// The first commits and then HOLDS its transaction open with pg_sleep, so its
// locks are held; the second starts while it sleeps. A third connection reads
// pg_stat_activity to prove the second is really waiting on a lock -- the
// overlap is observed, not assumed -- and only then is the first released.
//
// What each race shows, exactly one winner and a clean refusal (PT409 with
// the function's own sentence, never a unique-index error or a deadlock):
//   1. two DIFFERENT batches for one processor-month: the advisory
//      processor-month lock makes the second see the first committed;
//   2. two replacements of ONE committed batch: the second finds it replaced;
//   3. one batch committed twice: the batch row lock makes the second see
//      'committed'.

import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  adminClient,
  provisionFixtures,
  teardownFixtures,
  type Fixtures,
} from "./helpers/stack";

const CONTAINER = `supabase_db_${/^project_id\s*=\s*"([^"]+)"/m.exec(
  readFileSync("supabase/config.toml", "utf8"),
)![1]}`;
const PSQL = ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1"];
const ENV = { ...process.env, MSYS_NO_PATHCONV: "1" };
const PROCESSOR = "Netevia HQ";
const HOLD_SECONDS = 4;

type Session = { code: number | null; out: string; err: string; ms: number };

/** One psql session, started now; resolves when it exits. */
function session(sql: string): Promise<Session> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn("docker", PSQL, { env: ENV });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out, err, ms: Date.now() - started }));
    child.stdin.end(sql);
  });
}

/** A quick read on a third connection. */
function probe(sql: string): string {
  const r = spawnSync("docker", PSQL, { input: sql, encoding: "utf8", env: ENV, timeout: 30_000 });
  if (r.error) throw r.error;
  return r.stdout.trim();
}

async function until(check: () => boolean, what: string, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

let fixtures: Fixtures;
const RUN = String(Date.now()).slice(-6);

/** The commit as the admin, inside a transaction; `hold` keeps it open afterwards. */
function commitAsAdmin(batchId: number, hold: boolean, tag: string): string {
  return `
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"${fixtures.userIds.admin}","role":"authenticated"}', true);
select '${tag}', commit_residual_import_v3(${batchId}, '{}'::text[]);
${hold ? `select '${tag}-holding', pg_sleep(${HOLD_SECONDS});` : ""}
commit;
`;
}

async function freeMonth(): Promise<string> {
  const { data } = await adminClient().from("rep_payout_batches").select("period").eq("processor", PROCESSOR);
  const used = new Set((data ?? []).map((b) => b.period as string));
  const now = new Date();
  for (let back = 0; back <= 24; back += 1) {
    const index = now.getUTCFullYear() * 12 + now.getUTCMonth() - back;
    const y = Math.floor(index / 12);
    const period = `${y}-${String(index - y * 12 + 1).padStart(2, "0")}-01`;
    if (!used.has(period)) return period;
  }
  throw new Error(`no free ${PROCESSOR} month: clear old batches`);
}

let midCounter = 0;
async function merchant(): Promise<string> {
  midCounter += 1;
  const mid = `5${RUN}${String(midCounter).padStart(5, "0")}`;
  const { error } = await adminClient().from("merchants").insert({
    agent_id: fixtures.userIds.owner,
    mid,
    dba: `Race ${mid} Co`,
    city: "Nashville",
    state: "TN",
  });
  expect(error, error?.message).toBeNull();
  return mid;
}

/** A review batch for the month, staged as parse-residual-import leaves it. */
async function batch(period: string, mids: string[], replaces?: number): Promise<number> {
  const admin = adminClient();
  const { data, error } = await admin
    .from("rep_payout_batches")
    .insert({
      imported_by: fixtures.userIds.admin,
      file_key: `race/${RUN}.xlsx`,
      file_name: `race-${RUN}.xlsx`,
      status: "review",
      row_count: mids.length,
      processor: PROCESSOR,
      period,
      replaces_batch_id: replaces ?? null,
    })
    .select("id")
    .single();
  expect(error, error?.message).toBeNull();
  const id = data!.id as number;
  const { data: merchants } = await admin.from("merchants").select("id, mid, agent_id").in("mid", mids);
  const { error: stageError } = await admin.from("rep_payout_import_rows").insert(
    mids.map((mid, i) => {
      const m = (merchants ?? []).find((x) => x.mid === mid)!;
      return {
        batch_id: id, row_number: i + 2, mid_raw: mid, merchant_name_raw: "Race Co",
        processor_raw: PROCESSOR, income_type_raw: "Residuals", period,
        agent_id: m.agent_id, merchant_id: m.id, volume: 1000, residual_income: 100,
      };
    }),
  );
  expect(stageError, stageError?.message).toBeNull();
  return id;
}

/** Runs `first` holding its transaction, starts `second` once `first` holds, and proves `second` waited. */
async function race(first: string, second: string, tag: string): Promise<[Session, Session]> {
  const a = session(first);
  await until(
    () => probe(`select count(*) from pg_stat_activity where query like '%${tag}-A-holding%' and state = 'active' and pid <> pg_backend_pid()`) === "1",
    `session A to commit and hold (${tag})`,
  );
  const b = session(second);
  // The second is blocked on a LOCK while the first still holds its
  // transaction: the two really overlap.
  await until(
    () => probe(`select count(*) from pg_stat_activity
                  where query like '%${tag}-B%' and wait_event_type = 'Lock' and pid <> pg_backend_pid()`) === "1",
    `session B to wait on a lock (${tag})`,
  );
  return Promise.all([a, b]);
}

async function batchStatus(id: number): Promise<string> {
  const { data } = await adminClient().from("rep_payout_batches").select("status").eq("id", id).single();
  return data!.status as string;
}

beforeAll(async () => {
  fixtures = await provisionFixtures();
});

afterAll(async () => {
  await teardownFixtures();
});

describe("two real connections race v3; exactly one wins and the other is refused cleanly", () => {
  it("two different batches for one processor-month: the second sees the first committed", async () => {
    const period = await freeMonth();
    const mids = [await merchant(), await merchant()];
    const one = await batch(period, [mids[0]]);
    const two = await batch(period, [mids[1]]);

    const [a, b] = await race(commitAsAdmin(one, true, "month-A"), commitAsAdmin(two, false, "month-B"), "month");

    expect(a.code, a.err).toBe(0);
    expect(b.code).not.toBe(0);
    expect(b.ms).toBeGreaterThan(1000);
    expect(b.err).toContain(`is already committed (import #${one}). A second file for that month replaces it`);
    expect(b.err).not.toMatch(/duplicate key|deadlock/);
    expect(await batchStatus(one)).toBe("committed");
    expect(await batchStatus(two)).toBe("review");
    const { data: lines } = await adminClient().from("rep_payout_rows").select("mid, batch_id").eq("period", period).eq("processor", PROCESSOR);
    expect(lines).toEqual([{ mid: mids[0], batch_id: one }]);
  });

  it("two replacements of one committed batch: the second finds it already replaced", async () => {
    const period = await freeMonth();
    const mid = await merchant();
    const original = await batch(period, [mid]);
    expect(probe(commitAsAdmin(original, false, "orig")).length).toBeGreaterThan(0);
    expect(await batchStatus(original)).toBe("committed");
    const r1 = await batch(period, [mid], original);
    const r2 = await batch(period, [mid], original);

    const [a, b] = await race(commitAsAdmin(r1, true, "replace-A"), commitAsAdmin(r2, false, "replace-B"), "replace");

    expect(a.code, a.err).toBe(0);
    expect(a.out).toMatch(/"replaced_lines": 1/);
    expect(b.code).not.toBe(0);
    expect(b.err).toContain(`was uploaded to replace import #${original}, which is no longer the committed import`);
    expect(b.err).not.toMatch(/duplicate key|deadlock/);
    expect(await batchStatus(original)).toBe("replaced");
    expect(await batchStatus(r1)).toBe("committed");
    expect(await batchStatus(r2)).toBe("review");
    const { data: lines } = await adminClient().from("rep_payout_rows").select("mid, batch_id").eq("period", period).eq("processor", PROCESSOR);
    expect(lines).toEqual([{ mid, batch_id: r1 }]);
    const { data: audit } = await adminClient()
      .from("audit_log").select("action").eq("action", "replace_residual_import").eq("row_id", String(original));
    expect(audit).toEqual([{ action: "replace_residual_import" }]);
  });

  it("mutation proof: without the processor-month lock the loser is NOT refused cleanly (the unique index catches it)", async () => {
    // The lock, not the index, is what makes the refusal a sentence. This
    // file runs alone (fileParallelism: false), so v3 is swapped on the local
    // database for the race and put back, byte for byte, in `finally`.
    const SIG = "commit_residual_import_v3(int, text[])";
    const original = probe(`select pg_get_functiondef('${SIG}'::regprocedure);`);
    const LOCK = "pg_advisory_xact_lock(hashtext(\n    'tapswipe.residual_month:'";
    expect(original).toContain(LOCK);
    const mutated = original.replace(LOCK, "abs(hashtext(\n    'tapswipe.residual_month:'");
    try {
      expect(spawnSync("docker", PSQL, { input: `${mutated};`, encoding: "utf8", env: ENV }).status).toBe(0);
      const period = await freeMonth();
      const mids = [await merchant(), await merchant()];
      const one = await batch(period, [mids[0]]);
      const two = await batch(period, [mids[1]]);
      // B waits on the share lock instead, then commits on a stale "nothing
      // committed yet" read, and the unique index refuses it.
      const [a, b] = await race(commitAsAdmin(one, true, "nolock-A"), commitAsAdmin(two, false, "nolock-B"), "nolock");
      expect(a.code, a.err).toBe(0);
      expect(b.code).not.toBe(0);
      expect(b.err).toMatch(/duplicate key value violates unique constraint "rep_payout_batches_one_committed_per_month"/);
      expect(b.err).not.toContain("A second file for that month replaces it");
    } finally {
      const restore = spawnSync("docker", PSQL, { input: `${original};`, encoding: "utf8", env: ENV });
      expect(restore.status, restore.stderr).toBe(0);
      expect(probe(`select pg_get_functiondef('${SIG}'::regprocedure);`)).toBe(original);
    }
  });

  it("one batch committed twice at once: the second sees it committed", async () => {
    const period = await freeMonth();
    const mid = await merchant();
    const only = await batch(period, [mid]);

    const [a, b] = await race(commitAsAdmin(only, true, "same-A"), commitAsAdmin(only, false, "same-B"), "same");

    expect(a.code, a.err).toBe(0);
    expect(b.code).not.toBe(0);
    expect(b.err).toContain("this import is already committed");
    const { data: lines } = await adminClient().from("rep_payout_rows").select("mid").eq("batch_id", only);
    expect(lines).toEqual([{ mid }]);
  });
});

/**
 * A commit racing an override change on the SAME merchant and month (phase 11
 * of docs/design/intake-and-reports.md). Both take the share lock
 * (hashtext('tapswipe.merchant_rep_shares')), and set_merchant_override also
 * takes the merchant row FOR UPDATE where v3 holds it FOR SHARE, so whichever
 * starts first finishes first and the other decides on what it committed:
 *   * commit first: the override then finds the month committed and is
 *     refused by the month rule (PT409, its sentence) -- the month has no
 *     override lines and never will;
 *   * override first: the commit then reads it and writes the pair.
 * Never a raw constraint error, never a deadlock.
 */
describe("a commit and an override change on the same merchant and month", () => {
  function overrideAsAdmin(merchantId: number, period: string, hold: boolean, tag: string): string {
    return `
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"${fixtures.userIds.admin}","role":"authenticated"}', true);
select '${tag}', set_merchant_override(${merchantId}, '${fixtures.userIds.intruder}', 10, '${period}');
${hold ? `select '${tag}-holding', pg_sleep(${HOLD_SECONDS});` : ""}
commit;
`;
  }

  async function merchantId(mid: string): Promise<number> {
    const { data } = await adminClient().from("merchants").select("id").eq("mid", mid).single();
    return data!.id as number;
  }

  async function overrideLinesOf(batchId: number) {
    const { data } = await adminClient()
      .from("rep_payout_rows")
      .select("override_role, override_amount")
      .eq("batch_id", batchId)
      .eq("line_kind", "override")
      .order("override_amount");
    return data ?? [];
  }

  async function overridesOn(id: number) {
    const { data } = await adminClient().from("merchant_overrides").select("effective_from").eq("merchant_id", id);
    return data ?? [];
  }

  it("commit first: the override is refused by the month rule, cleanly, and the month has no override lines", async () => {
    const period = await freeMonth();
    const mid = await merchant();
    const id = await merchantId(mid);
    const only = await batch(period, [mid]);

    const [a, b] = await race(commitAsAdmin(only, true, "covr-A"), overrideAsAdmin(id, period, false, "covr-B"), "covr");

    expect(a.code, a.err).toBe(0);
    expect(b.code).not.toBe(0);
    expect(b.ms).toBeGreaterThan(1000);
    expect(b.err).toContain("is already committed for this MID. An override can only start after it");
    expect(b.err).not.toMatch(/duplicate key|deadlock|violates/);
    expect(await overrideLinesOf(only)).toEqual([]);
    expect(await overridesOn(id)).toEqual([]);
  });

  it("override first: the commit waits, reads it, and writes the pair", async () => {
    const period = await freeMonth();
    const mid = await merchant();
    const id = await merchantId(mid);
    const only = await batch(period, [mid]);

    const [a, b] = await race(overrideAsAdmin(id, period, true, "ocov-A"), commitAsAdmin(only, false, "ocov-B"), "ocov");

    expect(a.code, a.err).toBe(0);
    expect(b.code, b.err).toBe(0);
    expect(b.ms).toBeGreaterThan(1000);
    expect(b.out).toMatch(/"overrides": 1/);
    // R 100 at 10%: the owner's debit -10, the intruder's credit +10.
    expect(await overrideLinesOf(only)).toEqual([
      { override_role: "debit", override_amount: -10 },
      { override_role: "credit", override_amount: 10 },
    ]);
  });

  it("mutation proof: without set_merchant_override's locks, it slips in under the commit and breaks the month rule", async () => {
    const SIG = "set_merchant_override(int, uuid, numeric, date)";
    const original = probe(`select pg_get_functiondef('${SIG}'::regprocedure);`);
    const LOCK = "perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));";
    const ROW = "select * into m from merchants where id = merchant_id_input for update;";
    expect(original).toContain(LOCK);
    expect(original).toContain(ROW);
    const mutated = original
      .replace(LOCK, "perform 1;")
      .replace(ROW, "select * into m from merchants where id = merchant_id_input;");
    try {
      expect(spawnSync("docker", PSQL, { input: `${mutated};`, encoding: "utf8", env: ENV }).status).toBe(0);
      const period = await freeMonth();
      const mid = await merchant();
      const id = await merchantId(mid);
      const only = await batch(period, [mid]);

      const a = session(commitAsAdmin(only, true, "nolockovr-A"));
      await until(
        () => probe(`select count(*) from pg_stat_activity where query like '%nolockovr-A-holding%' and state = 'active' and pid <> pg_backend_pid()`) === "1",
        "the commit to hold",
      );
      // Nothing makes it wait now: it reads "nothing committed" and inserts.
      const b = await session(overrideAsAdmin(id, period, false, "nolockovr-B"));
      const done = await a;
      expect(done.code, done.err).toBe(0);
      expect(b.code, b.err).toBe(0);
      // The broken outcome the locks prevent: an override starting AT a
      // committed month that paid no override.
      expect(await overridesOn(id)).toEqual([{ effective_from: period }]);
      expect(await overrideLinesOf(only)).toEqual([]);
    } finally {
      const restore = spawnSync("docker", PSQL, { input: `${original};`, encoding: "utf8", env: ENV });
      expect(restore.status, restore.stderr).toBe(0);
      expect(probe(`select pg_get_functiondef('${SIG}'::regprocedure);`)).toBe(original);
    }
  });
});
