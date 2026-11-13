import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  adminClient,
  anonClient,
  skipWhenFunctionsDown,
  getStackConfig,
  invoke,
  MISSING_ID,
  userClient,
  warmFunctions,
} from "./helpers/stack";

/**
 * The two secrets Edge Functions, over real HTTP.
 *
 * This suite covers what the hermetic one structurally cannot: the Deno runtime,
 * real JWTs, the tier decision made from `is_admin()` through a caller-scoped
 * client, PostgREST's `bytea` wire format, and the upsert semantics that depend
 * on the unique constraints.
 *
 * It provisions its own fixtures rather than extending `provisionFixtures()`:
 * pre-app rows with owners are wanted by no other live test, and keeping them
 * here means the shared helper does not grow a shape only one file uses.
 *
 * It also pins the DUPLICATED validators in
 * supabase/functions/_shared/pre-app-secrets.ts against lib/masks.ts. TypeScript
 * cannot see that pair — Deno cannot import from `lib/` — so this behavioural
 * check is the only thing that catches the two drifting apart.
 */

const PASSWORD = "live-secrets-password-123";
const PLAINTEXT = {
  ssn: "123-45-6789",
  routing: "021000021", // Chase; ABA-valid
  account: "000123456789",
  rpPassword: "terminal-secret-pw",
};

/**
 * Business tax IDs (pre_app_tax_secrets, 20261026140000) that no real holder
 * has: the IRS does not assign EIN prefix 07, and the SSA lists 123-45-6789
 * as never valid. 1357 is a run no other fixture here contains, so a raw-body
 * check for it cannot pass or fail by coincidence.
 */
const TAX = {
  ein: "07-1351357",
  einLast4: "1357",
  ssn: "123-45-6789",
};

type Persona = { id: string; token: string };

let owner: Persona;
let intruder: Persona;
let admin: Persona;
let preAppId: number;
let ownerRowId: number;
let intruderPreAppId: number;
let intruderOwnerRowId: number;
let deactivated: Persona;
let deactivatedPreAppId: number;

async function makePersona(
  email: string,
  role: "agent" | "admin",
): Promise<Persona> {
  const service = adminClient();
  const { data: existing } = await service.auth.admin.listUsers();
  for (const user of existing.users.filter((u) => u.email === email)) {
    await service.from("audit_log").delete().eq("actor_id", user.id);
    await service.from("pre_apps").delete().eq("agent_id", user.id);
    await service.auth.admin.deleteUser(user.id);
  }
  const { data: created, error } = await service.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error) throw error;
  await service.from("profiles").insert({
    id: created.user.id,
    full_name: email,
    role,
    is_active: true,
  });
  const { data: session, error: signInError } = await anonClient()
    .auth.signInWithPassword({ email, password: PASSWORD });
  if (signInError) throw signInError;
  return { id: created.user.id, token: session.session!.access_token };
}

async function makePreApp(agentId: string, dba: string) {
  const service = adminClient();
  const { data: preApp, error } = await service
    .from("pre_apps")
    .insert({ agent_id: agentId, dba_name: dba, legal_business_name: `${dba} LLC` })
    .select("id")
    .single();
  if (error) throw error;
  const { data: ownerRow, error: ownerError } = await service
    .from("pre_app_owners")
    .insert({ pre_app_id: preApp.id, owner_name: "Live Owner", percent_owned: 100 })
    .select("id")
    .single();
  if (ownerError) throw ownerError;
  return { preAppId: preApp.id as number, ownerRowId: ownerRow.id as number };
}

const CONTAINER = `supabase_db_${/^project_id\s*=\s*"([^"]+)"/m.exec(
  readFileSync("supabase/config.toml", "utf8"),
)![1]}`;

/**
 * One psql session as `postgres` in the local DB container (the
 * tests/live/reset-business-data.test.ts helper): only the audit-failure test
 * uses it, to make the reveal's audit insert fail for real.
 */
function psql(sql: string): { ok: boolean; out: string; err: string } {
  const r = spawnSync(
    "docker",
    ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-A", "-t",
     "-v", "ON_ERROR_STOP=1"],
    { input: sql, encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" }, timeout: 120_000 },
  );
  if (r.error) throw r.error;
  return { ok: r.status === 0, out: r.stdout, err: r.stderr };
}

/** An admin's one-field reveal (phase 5). */
function reveal(id: number, field: Record<string, unknown>, token = admin.token) {
  return invoke("read-pre-app-secrets", { pre_app_id: id, reveal: field }, token);
}

/** True only when functions are down and ALLOW_SKIPPED_FUNCTION_TESTS=1: every test here then skips. */
const FUNCTIONS_DOWN = skipWhenFunctionsDown();

beforeAll(async () => {
  // Hard error rather than skip: a silently skipped suite is worse than a red one.
  // The run-level gate (tests/live/helpers/global-setup.ts) has already
  // failed the run if the functions runtime is down, unless the opt-in is set.
  if (FUNCTIONS_DOWN) return;

  // See warmFunctions: the first invocation of each function restarts the
  // runtime (the CLI writes a .npmrc, its own watcher notices), which 502s
  // anything in flight. Without this a cold `functions serve` fails most of this
  // file with "expected 502", pointing nowhere near the cause.
  await warmFunctions(["submit-pre-app-secrets", "read-pre-app-secrets"]);

  owner = await makePersona("live-secrets-owner@tapswipe.test", "agent");
  intruder = await makePersona("live-secrets-intruder@tapswipe.test", "agent");
  admin = await makePersona("live-secrets-admin@tapswipe.test", "admin");

  ({ preAppId, ownerRowId } = await makePreApp(owner.id, "Secrets Live Co"));
  ({ preAppId: intruderPreAppId, ownerRowId: intruderOwnerRowId } =
    await makePreApp(intruder.id, "Intruder Co"));

  // Signed in FIRST, then deactivated: a deactivated rep holds a working JWT
  // until it expires, which is exactly the caller callerIsActive() exists for.
  // They own their own pre-app, so a refusal cannot be RLS saying "not yours".
  deactivated = await makePersona("live-secrets-deactivated@tapswipe.test", "agent");
  ({ preAppId: deactivatedPreAppId } = await makePreApp(deactivated.id, "Deactivated Co"));
  const { error: deactivateError } = await adminClient()
    .from("profiles")
    .update({ is_active: false })
    .eq("id", deactivated.id);
  if (deactivateError) throw deactivateError;
}, 120_000);

afterAll(async () => {
  const service = adminClient();
  for (const persona of [owner, intruder, admin, deactivated].filter(Boolean)) {
    // audit_log.actor_id references profiles(id) with no ON DELETE, and profiles
    // cascades from auth.users — so audit rows block the user delete.
    await service.from("audit_log").delete().eq("actor_id", persona.id);

    // The cross-agent trigger keys its rows on the pre-app id, not the agent, and
    // fires on this suite's inserts AND on the delete below — a service-role
    // connection has no auth.uid(), so both count as cross-agent. Ids are
    // collected before the delete makes them unfindable, and the audit rows are
    // cleared after it, or the delete's own rows would outlive the cleanup.
    const { data: preApps } = await service
      .from("pre_apps")
      .select("id")
      .eq("agent_id", persona.id);
    const preAppIds = (preApps ?? []).map((row) => String(row.id));

    await service.from("pre_apps").delete().eq("agent_id", persona.id);

    if (preAppIds.length > 0) {
      await service
        .from("audit_log")
        .delete()
        .eq("table_name", "pre_apps")
        .in("row_id", preAppIds);
    }

    await service.auth.admin.deleteUser(persona.id);
  }
});

describe("submit-pre-app-secrets access control", () => {
  it("rejects an unauthenticated caller with 401", async () => {
    const { status } = await invoke("submit-pre-app-secrets", {
      secrets: [{ kind: "terminal", pre_app_id: preAppId, rp_password: "x" }],
    });
    expect(status).toBe(401);
  });

  it("rejects a non-POST with 405", async () => {
    const { apiUrl, anonKey } = getStackConfig();
    const res = await fetch(`${apiUrl}/functions/v1/submit-pre-app-secrets`, {
      method: "GET",
      headers: { apikey: anonKey, Authorization: `Bearer ${owner.token}` },
    });
    expect(res.status).toBe(405);
  });

  it("gives another agent's pre-app the same 404 as one that never existed", async () => {
    // The property is that the two are indistinguishable — asserting each
    // matches /not found/ separately would pass while still leaking.
    const notYours = await invoke(
      "submit-pre-app-secrets",
      {
        secrets: [
          { kind: "terminal", pre_app_id: intruderPreAppId, rp_password: "x" },
        ],
      },
      owner.token,
    );
    const missing = await invoke(
      "submit-pre-app-secrets",
      {
        secrets: [
          { kind: "terminal", pre_app_id: MISSING_ID, rp_password: "x" },
        ],
      },
      owner.token,
    );
    expect(notYours.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(notYours.body).toEqual(missing.body);
  });

  it("rejects another agent's owner row with 404", async () => {
    const { status } = await invoke(
      "submit-pre-app-secrets",
      {
        secrets: [
          {
            kind: "owner_ssn",
            pre_app_owner_id: intruderOwnerRowId,
            ssn: PLAINTEXT.ssn,
          },
        ],
      },
      owner.token,
    );
    expect(status).toBe(404);
  });

  it("rejects a mixed-parent request with 400", async () => {
    const { status, body } = await invoke(
      "submit-pre-app-secrets",
      {
        secrets: [
          { kind: "terminal", pre_app_id: preAppId, rp_password: "x" },
          { kind: "banking", pre_app_id: intruderPreAppId, aba_routing: PLAINTEXT.routing, account_number: PLAINTEXT.account },
        ],
      },
      owner.token,
    );
    expect(status).toBe(400);
    expect(String(body.error)).toMatch(/same pre-app/i);
  });
});

describe("a deactivated caller is refused by both functions", () => {
  // The false branch of callerIsActive() in _shared/documents.ts, which both
  // functions import. It was only ever exercised through the legacy document
  // functions' tests, deleted on 13 Oct 2026.
  it("submit-pre-app-secrets refuses them on their own pre-app, storing nothing", async () => {
    const { status, body, raw } = await invoke(
      "submit-pre-app-secrets",
      {
        secrets: [
          { kind: "terminal", pre_app_id: deactivatedPreAppId, rp_password: PLAINTEXT.rpPassword },
        ],
      },
      deactivated.token,
    );
    console.log(`  deactivated submit -> ${status} ${raw}`);
    expect(status, raw).toBe(403);
    expect(body.error).toBe("Account is not active");

    const { data } = await adminClient()
      .from("pre_app_terminal_secrets")
      .select("pre_app_id")
      .eq("pre_app_id", deactivatedPreAppId);
    expect(data).toEqual([]);
  });

  it("read-pre-app-secrets refuses them on their own pre-app", async () => {
    const { status, body, raw } = await invoke(
      "read-pre-app-secrets",
      { pre_app_id: deactivatedPreAppId },
      deactivated.token,
    );
    console.log(`  deactivated read -> ${status} ${raw}`);
    expect(status, raw).toBe(403);
    expect(body.error).toBe("Account is not active");
  });
});

describe("read-pre-app-secrets rejects a pre_app_id that is not a positive integer", () => {
  // isPositiveInt() from _shared/documents.ts. Driven as the OWNER, whose own
  // pre-app id would succeed, so each 400 is about the shape of the id alone.
  // Built lazily: preAppId only exists once beforeAll has run.
  const cases: [string, () => Record<string, unknown>][] = [
    ["missing", () => ({})],
    ["null", () => ({ pre_app_id: null })],
    // The owner's REAL id, as a string: the one a lax check would let through.
    ["a numeric string", () => ({ pre_app_id: String(preAppId) })],
    ["a decimal", () => ({ pre_app_id: 1.5 })],
    ["zero", () => ({ pre_app_id: 0 })],
    ["negative", () => ({ pre_app_id: -1 })],
    ["an injection attempt", () => ({ pre_app_id: "1; drop table pre_apps" })],
  ];

  for (const [label, payload] of cases) {
    it(`rejects ${label} with 400`, async () => {
      const { status, body: response, raw } = await invoke(
        "read-pre-app-secrets",
        payload(),
        owner.token,
      );
      expect(status, raw).toBe(400);
      expect(response.error).toBe("pre_app_id must be a positive integer");
    });
  }

  it("accepts the same owner's real id, so the cases above are about the id", async () => {
    const { status, raw } = await invoke(
      "read-pre-app-secrets",
      { pre_app_id: preAppId },
      owner.token,
    );
    expect(status, raw).toBe(200);
  });
});

describe("submit-pre-app-secrets validation mirrors lib/masks.ts", () => {
  const cases: [string, unknown, RegExp][] = [
    ["an 8-digit routing number", { aba_routing: "02100002", account_number: PLAINTEXT.account }, /nine digits/i],
    ["a 10-digit routing number", { aba_routing: "0210000211", account_number: PLAINTEXT.account }, /nine digits/i],
    ["a 3-digit account number", { aba_routing: PLAINTEXT.routing, account_number: "123" }, /4 to 17/i],
    ["an 18-digit account number", { aba_routing: PLAINTEXT.routing, account_number: "123456789012345678" }, /4 to 17/i],
  ];

  for (const [label, fields, expected] of cases) {
    it(`rejects ${label} with 400, without echoing the value`, async () => {
      const { status, body, raw } = await invoke(
        "submit-pre-app-secrets",
        {
          secrets: [{ kind: "banking", pre_app_id: preAppId, ...(fields as object) }],
        },
        owner.token,
      );
      expect(status, raw).toBe(400);
      expect(String(body.error)).toMatch(expected);
      // The endpoint exists so these values are never logged or reflected.
      expect(raw).not.toContain(PLAINTEXT.account);
    });
  }

  it("rejects a malformed SSN with 400", async () => {
    const { status, body, raw } = await invoke(
      "submit-pre-app-secrets",
      {
        secrets: [
          { kind: "owner_ssn", pre_app_owner_id: ownerRowId, ssn: "123456789" },
        ],
      },
      owner.token,
    );
    expect(status, raw).toBe(400);
    expect(String(body.error)).toMatch(/123-45-6789/);
    expect(raw).not.toContain("123456789");
  });

  // Phase 4: the owner SSN takes the tax-ID SSN rule (isSsn = isTaxSsn on
  // both sides). Before, the shape alone passed, so 000-00-0000 was stored.
  for (const [label, ssn] of [
    ["an all-zero SSN", "000-00-0000"],
    ["an SSN in area 000", "000-45-6789"],
    ["an SSN in area 666", "666-45-6789"],
    ["an SSN in area 9xx (an ITIN)", "912-45-6789"],
    ["an SSN with group 00", "123-00-6789"],
    ["an SSN with serial 0000", "123-45-0000"],
  ] as const) {
    it(`rejects ${label} for an owner with 400, without echoing it`, async () => {
      const { status, body, raw } = await invoke(
        "submit-pre-app-secrets",
        { secrets: [{ kind: "owner_ssn", pre_app_owner_id: ownerRowId, ssn }] },
        owner.token,
      );
      expect(status, raw).toBe(400);
      expect(String(body.error)).toBe("ssn must be a valid SSN, formatted 123-45-6789");
      expect(raw).not.toContain(ssn);
    });
  }

  it("accepts a nine-digit routing number", async () => {
    const { status, raw } = await invoke(
      "submit-pre-app-secrets",
      {
        secrets: [
          {
            kind: "banking",
            pre_app_id: preAppId,
            aba_routing: PLAINTEXT.routing,
            account_number: PLAINTEXT.account,
          },
        ],
      },
      owner.token,
    );
    expect(status, raw).toBe(200);
  });

  /**
   * The checksum was removed on 25 Sep 2026. 021000022 is a single-digit typo
   * of Chase's 021000021 and fails the old 3-7-1 weighted mod-10 check, so this
   * exact body returned a 400 before that change.
   *
   * It is asserted HERE rather than only in the unit suite because the two
   * validators are duplicated across a boundary TypeScript cannot see, and this
   * is the side that issues the 400. Restoring the checksum in lib/masks.ts
   * alone would leave this green while the form silently refuses what the
   * function accepts; restoring it here alone reds this immediately.
   */
  it("accepts a nine-digit routing number that fails the old checksum", async () => {
    const { status, raw } = await invoke(
      "submit-pre-app-secrets",
      {
        secrets: [
          {
            kind: "banking",
            pre_app_id: preAppId,
            aba_routing: "021000022",
            account_number: PLAINTEXT.account,
          },
        ],
      },
      owner.token,
    );
    expect(status, raw).toBe(200);
  });
});

describe("encryption round trip", () => {
  // Since phase 5 (A24) an admin's default read is masked too; the round trip
  // is proven one field at a time through reveal, which is the only way a
  // full value leaves the function now.
  it("stores all four values, and an admin reads each back in full by revealing it", async () => {
    const write = await invoke(
      "submit-pre-app-secrets",
      {
        secrets: [
          { kind: "owner_ssn", pre_app_owner_id: ownerRowId, ssn: PLAINTEXT.ssn },
          {
            kind: "banking",
            pre_app_id: preAppId,
            aba_routing: PLAINTEXT.routing,
            account_number: PLAINTEXT.account,
          },
          { kind: "terminal", pre_app_id: preAppId, rp_password: PLAINTEXT.rpPassword },
        ],
      },
      owner.token,
    );
    expect(write.status, write.raw).toBe(200);
    // The write response reports status, never a value.
    expect(write.raw).not.toContain(PLAINTEXT.ssn);
    expect(write.raw).not.toContain(PLAINTEXT.account);

    const read = await invoke(
      "read-pre-app-secrets",
      { pre_app_id: preAppId },
      admin.token,
    );
    expect(read.status, read.raw).toBe(200);
    expect(read.body.tier).toBe("last4");

    expect((await reveal(preAppId, { field: "owner_ssn", pre_app_owner_id: ownerRowId })).body.value)
      .toBe(PLAINTEXT.ssn);
    expect((await reveal(preAppId, { field: "aba_routing" })).body.value).toBe(PLAINTEXT.routing);
    expect((await reveal(preAppId, { field: "account_number" })).body.value).toBe(PLAINTEXT.account);
    expect((await reveal(preAppId, { field: "rp_password" })).body.value).toBe(PLAINTEXT.rpPassword);
  });

  it("stores bytea in the \\x-hex wire form, of the documented length", async () => {
    // This is the assertion that pins the encoding claim against real PostgREST
    // rather than against reasoning. A base64 payload would be accepted by
    // Postgres as literal ASCII, silently.
    const { data } = await adminClient()
      .from("pre_app_banking_secrets")
      .select("aba_routing_encrypted, key_version")
      .eq("pre_app_id", preAppId)
      .single();

    const stored = (data as Record<string, string>).aba_routing_encrypted;
    expect(stored).toMatch(/^\\x[0-9a-f]+$/);
    // 12-byte IV + 9-byte ciphertext + 16-byte tag = 37 bytes = 74 hex chars.
    expect(stored.length - 2).toBe(2 * (12 + PLAINTEXT.routing.length + 16));
    expect(stored).not.toContain(PLAINTEXT.routing);
    expect((data as Record<string, number>).key_version).toBe(1);
  });

  it("upserts rather than accumulating, so a correction replaces", async () => {
    const corrected = "011401533"; // KeyBank; ABA-valid, Luhn-invalid
    const write = await invoke(
      "submit-pre-app-secrets",
      {
        secrets: [
          {
            kind: "banking",
            pre_app_id: preAppId,
            aba_routing: corrected,
            account_number: PLAINTEXT.account,
          },
        ],
      },
      owner.token,
    );
    expect(write.status, write.raw).toBe(200);

    const { data, count } = await adminClient()
      .from("pre_app_banking_secrets")
      .select("pre_app_id", { count: "exact" })
      .eq("pre_app_id", preAppId);
    expect(count).toBe(1);
    expect(data).toHaveLength(1);

    expect((await reveal(preAppId, { field: "aba_routing" })).body.value).toBe(corrected);
  });
});

describe("read-pre-app-secrets tiering", () => {
  it("gives the owning agent last-4 only, and never the full value", async () => {
    const read = await invoke(
      "read-pre-app-secrets",
      { pre_app_id: preAppId },
      owner.token,
    );
    expect(read.status, read.raw).toBe(200);
    expect(read.body.tier).toBe("last4");

    const owners = read.body.owners as Record<string, unknown>[];
    expect(owners[0].ssn_last4).toBe("6789");
    expect(owners[0].ssn).toBeUndefined();

    // The strongest form of the assertion: no plaintext anywhere in the body.
    expect(read.raw).not.toContain(PLAINTEXT.ssn);
    expect(read.raw).not.toContain(PLAINTEXT.account);
    expect(read.raw).not.toContain(PLAINTEXT.rpPassword);
  });

  it("gives presence only for the RP password, not a suffix", async () => {
    // Four characters of a password removes most of its entropy, unlike four
    // digits of an account number.
    const read = await invoke(
      "read-pre-app-secrets",
      { pre_app_id: preAppId },
      owner.token,
    );
    const terminal = read.body.terminal as Record<string, unknown>;
    expect(terminal.on_file).toBe(true);
    expect(terminal.rp_password).toBeUndefined();
    expect(Object.keys(terminal)).toEqual(["on_file"]);
  });

  it("404s another agent's pre-app and a missing one identically", async () => {
    const notYours = await invoke(
      "read-pre-app-secrets",
      { pre_app_id: intruderPreAppId },
      owner.token,
    );
    const missing = await invoke(
      "read-pre-app-secrets",
      { pre_app_id: MISSING_ID },
      owner.token,
    );
    expect(notYours.status).toBe(404);
    expect(notYours.body).toEqual(missing.body);
  });

  it("sets Cache-Control: no-store", async () => {
    const { apiUrl, anonKey } = getStackConfig();
    const res = await fetch(`${apiUrl}/functions/v1/read-pre-app-secrets`, {
      method: "POST",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${admin.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ pre_app_id: preAppId }),
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("every access is audited", () => {
  // The admin's default read is the masked tier since phase 5, so it is
  // recorded as last4; a reveal has its own action (below).
  it("records the reader, with the tier and a real actor_id", async () => {
    await invoke("read-pre-app-secrets", { pre_app_id: preAppId }, admin.token);

    const { data } = await adminClient()
      .from("audit_log")
      .select("actor_id, action, row_id")
      .eq("actor_id", admin.id)
      .like("action", "read_pre_app_secrets%")
      .order("id", { ascending: false })
      .limit(1);

    const row = (data ?? [])[0] as Record<string, string> | undefined;
    expect(row).toBeDefined();
    // actor_id being correct is the point: a service-role connection has no
    // auth.uid(), so a function that forgot to pass it would store NULL.
    expect(row!.actor_id).toBe(admin.id);
    expect(row!.action).toBe("read_pre_app_secrets:last4");
    expect(row!.row_id).toBe(String(preAppId));
  });

  it("records the writer too", async () => {
    const { data } = await adminClient()
      .from("audit_log")
      .select("action")
      .eq("actor_id", owner.id)
      .like("action", "submit_pre_app_secrets%");
    expect((data ?? []).length).toBeGreaterThan(0);
  });
});

/**
 * Security fix phase 2 (docs/claude/security-fixes.md): once a pre-app is
 * submitted, the rep can change neither its secrets (this function's own
 * draft-or-admin check, which had no test) nor its owner rows
 * (pre_app_children_guard, here through PostgREST). An admin still can.
 */
describe("after submission", () => {
  let submittedId: number;
  let submittedOwnerId: number;

  beforeAll(async () => {
    if (FUNCTIONS_DOWN) return;
    ({ preAppId: submittedId, ownerRowId: submittedOwnerId } = await makePreApp(
      owner.id,
      "Submitted Live Co",
    ));
    // Every item pre_app_missing_fields() requires (phase 4, 20261028120000),
    // apart from the secrets, which go through the function below.
    const service = adminClient();
    const { error: locationError } = await service
      .from("pre_apps")
      .update({
        city: "Nashville", state: "TN", zip: "37201", ein_type: "EIN",
        contact_phone: "615-555-0100", physical_address: "100 Main St",
        legal_entity_type: "LLC", state_incorporated: "TN", business_type: "Retail",
        bank_name: "First Bank", est_annual_volume: 1200000, est_monthly_volume: 100000,
        est_average_ticket: 45, est_high_ticket: 900,
      })
      .eq("id", submittedId);
    if (locationError) throw locationError;
    const { error: ownerFieldsError } = await service
      .from("pre_app_owners")
      .update({
        title: "Owner", dob: "1980-01-02", home_phone: "615-555-0101",
        id_type: "Driver license", id_number: "D1234567", id_state: "TN",
        id_issue_date: "2020-01-01", id_expiration_date: "2030-01-01",
        home_address: "1 Home Rd", home_city: "Nashville", home_state: "TN",
        home_zip: "37203", length_of_ownership: "5 years",
      })
      .eq("id", submittedOwnerId);
    if (ownerFieldsError) throw ownerFieldsError;
    // The rep's legal names, which an admin sets (set_rep_identity); the
    // service role stands in for that admin here.
    const { error: identityError } = await service
      .from("profiles")
      .update({ legal_name: "Live Owner Legal", llc_legal_name: "Live Owner LLC" })
      .eq("id", owner.id);
    if (identityError) throw identityError;

    const secrets = await invoke(
      "submit-pre-app-secrets",
      {
        secrets: [
          { kind: "owner_ssn", pre_app_owner_id: submittedOwnerId, ssn: PLAINTEXT.ssn },
          { kind: "banking", pre_app_id: submittedId, aba_routing: PLAINTEXT.routing, account_number: PLAINTEXT.account },
          // submit_pre_app() requires the tax ID of the chosen kind (20261026140000).
          { kind: "tax_id", pre_app_id: submittedId, tax_id_type: "EIN", tax_id: TAX.ein },
        ],
      },
      owner.token,
    );
    expect(secrets.status, secrets.raw).toBe(200);

    const { error: submitError } = await userClient(owner.token).rpc("submit_pre_app", {
      pre_app_id_input: submittedId,
    });
    if (submitError) throw submitError;
  });

  it("refuses the rep's secrets with 409, before any write", async () => {
    const { status, body } = await invoke(
      "submit-pre-app-secrets",
      { secrets: [{ kind: "terminal", pre_app_id: submittedId, rp_password: "late-change" }] },
      owner.token,
    );
    expect(status).toBe(409);
    expect(body.error).toBe("Pre-app is not editable");
    const { data } = await adminClient()
      .from("pre_app_terminal_secrets")
      .select("pre_app_id")
      .eq("pre_app_id", submittedId);
    expect(data).toEqual([]);
  });

  it("refuses the rep's tax ID with 409 too, and the stored one stays", async () => {
    const { status } = await invoke(
      "submit-pre-app-secrets",
      { secrets: [{ kind: "tax_id", pre_app_id: submittedId, tax_id_type: "EIN", tax_id: "07-2462468" }] },
      owner.token,
    );
    expect(status).toBe(409);
    const read = await invoke("read-pre-app-secrets", { pre_app_id: submittedId }, owner.token);
    expect((read.body.tax_id as Record<string, unknown>).tax_id_last4).toBe(TAX.einLast4);
  });

  it("refuses the rep's owner edit and owner delete with 409, and the SSN row stays", async () => {
    const rep = userClient(owner.token);
    const update = await rep
      .from("pre_app_owners")
      .update({ owner_name: "Rewritten" })
      .eq("id", submittedOwnerId);
    expect(update.status).toBe(409);
    expect(update.error?.message).toMatch(/submitted pre-app can only be changed by an admin/);

    const remove = await rep.from("pre_app_owners").delete().eq("id", submittedOwnerId);
    expect(remove.status).toBe(409);

    const { data } = await adminClient()
      .from("pre_app_owner_secrets")
      .select("pre_app_owner_id")
      .eq("pre_app_owner_id", submittedOwnerId);
    expect(data).toEqual([{ pre_app_owner_id: submittedOwnerId }]);
  });

  it("still lets an admin change the secrets and the owner", async () => {
    const { status } = await invoke(
      "submit-pre-app-secrets",
      { secrets: [{ kind: "terminal", pre_app_id: submittedId, rp_password: "admin-change" }] },
      admin.token,
    );
    expect(status).toBe(200);

    const { error, count } = await userClient(admin.token)
      .from("pre_app_owners")
      .update({ owner_name: "Corrected by admin" }, { count: "exact" })
      .eq("id", submittedOwnerId);
    expect(error).toBeNull();
    expect(count).toBe(1);
  });
});

/**
 * The business tax ID (pre_app_tax_secrets, 20261026140000; phase 3 of
 * docs/design/intake-and-reports.md). Its own pre-app, so nothing above can
 * make a tier or no-plaintext assertion here pass by accident.
 */
describe("the business tax ID", () => {
  let taxPreAppId: number;

  async function setEinType(type: "EIN" | "SSN" | null) {
    const { error } = await adminClient()
      .from("pre_apps")
      .update({ ein_type: type })
      .eq("id", taxPreAppId);
    if (error) throw error;
  }

  async function storedRows() {
    const { data } = await adminClient()
      .from("pre_app_tax_secrets")
      .select("tax_id_type, tax_id_encrypted, key_version")
      .eq("pre_app_id", taxPreAppId);
    return (data ?? []) as Record<string, string | number>[];
  }

  const submitTax = (tax_id_type: unknown, tax_id: unknown, token = owner.token) =>
    invoke(
      "submit-pre-app-secrets",
      { secrets: [{ kind: "tax_id", pre_app_id: taxPreAppId, tax_id_type, tax_id }] },
      token,
    );

  beforeAll(async () => {
    if (FUNCTIONS_DOWN) return;
    ({ preAppId: taxPreAppId } = await makePreApp(owner.id, "Tax Live Co"));
  });

  describe("validation mirrors lib/masks.ts isTaxEin / isTaxSsn", () => {
    const rejected: [string, "EIN" | "SSN", string][] = [
      ["an all-zero EIN", "EIN", "00-0000000"],
      ["an EIN with prefix 00", "EIN", "00-1351357"],
      ["an eight-digit EIN", "EIN", "07-135135"],
      ["an undashed EIN", "EIN", "071351357"],
      ["an SSN-shaped EIN", "EIN", "071-35-1357"],
      ["an all-zero SSN", "SSN", "000-00-0000"],
      ["an SSN in area 666", "SSN", "666-35-1357"],
      ["an SSN in area 9xx (an ITIN)", "SSN", "913-35-1357"],
      ["an SSN with group 00", "SSN", "123-00-1357"],
      ["an SSN with serial 0000", "SSN", "123-35-0000"],
      ["an EIN-shaped SSN", "SSN", "07-1351357"],
    ];

    for (const [label, type, value] of rejected) {
      it(`rejects ${label} with 400, without echoing the value, storing nothing`, async () => {
        await setEinType(type);
        const { status, body, raw } = await submitTax(type, value);
        expect(status, raw).toBe(400);
        expect(String(body.error)).toMatch(/tax_id must be a valid/);
        expect(raw).not.toContain(value);
        expect(await storedRows()).toEqual([]);
      });
    }

    for (const kind of ["ein", "ITIN", "", null]) {
      it(`rejects a tax_id_type of ${JSON.stringify(kind)} with 400`, async () => {
        await setEinType("EIN");
        const { status, body } = await submitTax(kind, TAX.ein);
        expect(status).toBe(400);
        expect(body.error).toBe("tax_id_type must be EIN or SSN");
        expect(await storedRows()).toEqual([]);
      });
    }
  });

  describe("the kind must be the pre-app's current EIN type", () => {
    it("refuses any tax ID while no EIN type is chosen", async () => {
      await setEinType(null);
      const { status, body, raw } = await submitTax("EIN", TAX.ein);
      expect(status, raw).toBe(400);
      expect(String(body.error)).toMatch(/must match the pre-app's EIN type/);
      expect(raw).not.toContain(TAX.ein);
      expect(await storedRows()).toEqual([]);
    });

    it("refuses an SSN when the EIN type says EIN, and the reverse", async () => {
      await setEinType("EIN");
      expect((await submitTax("SSN", TAX.ssn)).status).toBe(400);
      await setEinType("SSN");
      expect((await submitTax("EIN", TAX.ein)).status).toBe(400);
      expect(await storedRows()).toEqual([]);
    });
  });

  describe("round trip and tiers", () => {
    beforeAll(async () => {
      if (FUNCTIONS_DOWN) return;
      await setEinType("EIN");
      const write = await submitTax("EIN", TAX.ein);
      expect(write.status, write.raw).toBe(200);
      // The write response reports status, never a value.
      expect(write.raw).not.toContain(TAX.ein);
      expect(write.body.stored).toEqual([{ kind: "tax_id", fields: ["tax_id"] }]);
    });

    it("stores ciphertext in the \\x-hex wire form, with the kind and key_version 1", async () => {
      const [row] = await storedRows();
      expect(row.tax_id_type).toBe("EIN");
      expect(row.key_version).toBe(1);
      const stored = String(row.tax_id_encrypted);
      expect(stored).toMatch(/^\\x[0-9a-f]+$/);
      // 12-byte IV + 10-byte plaintext + 16-byte tag.
      expect(stored.length - 2).toBe(2 * (12 + TAX.ein.length + 16));
    });

    it("gives the owning rep the kind and the last four only", async () => {
      const read = await invoke("read-pre-app-secrets", { pre_app_id: taxPreAppId }, owner.token);
      expect(read.status, read.raw).toBe(200);
      expect(read.body.tax_id).toEqual({
        on_file: true,
        tax_id_type: "EIN",
        tax_id_last4: TAX.einLast4,
      });
      // The strongest form: the full number is nowhere in the body.
      expect(read.raw).not.toContain(TAX.ein);
      expect(read.raw).not.toContain(TAX.ein.replace("-", ""));
    });

    // Phase 5 (A24): the admin's default read is masked like the rep's; the
    // full number comes only from a reveal of this one field.
    it("gives an admin the last four too, and the full number only by reveal", async () => {
      const read = await invoke("read-pre-app-secrets", { pre_app_id: taxPreAppId }, admin.token);
      expect(read.status, read.raw).toBe(200);
      expect(read.body.tax_id).toEqual({ on_file: true, tax_id_type: "EIN", tax_id_last4: TAX.einLast4 });
      expect(read.raw).not.toContain(TAX.ein);
      const shown = await reveal(taxPreAppId, { field: "tax_id" });
      expect(shown.status, shown.raw).toBe(200);
      expect(shown.body).toEqual({ field: "tax_id", tax_id_type: "EIN", value: TAX.ein });
    });

    it("404s another agent identically to a missing pre-app", async () => {
      const notYours = await submitTax("EIN", TAX.ein, intruder.token);
      expect(notYours.status).toBe(404);
      const read = await invoke("read-pre-app-secrets", { pre_app_id: taxPreAppId }, intruder.token);
      expect(read.status).toBe(404);
      expect(read.raw).not.toContain(TAX.einLast4);
    });

    it("audits the write as submit_pre_app_secrets:tax_id", async () => {
      const { data } = await adminClient()
        .from("audit_log")
        .select("action")
        .eq("actor_id", owner.id)
        .eq("row_id", String(taxPreAppId))
        .eq("action", "submit_pre_app_secrets:tax_id");
      expect((data ?? []).length).toBeGreaterThan(0);
    });
  });

  describe("switching the EIN type after the number was entered", () => {
    it("leaves the stored EIN uncounted until the SSN is entered, which replaces it", async () => {
      await setEinType("SSN");

      // The stored row is still an EIN; the read says so, so the wizard can
      // ask for the SSN, and the presence RPC no longer counts it.
      const before = await invoke("read-pre-app-secrets", { pre_app_id: taxPreAppId }, owner.token);
      expect((before.body.tax_id as Record<string, unknown>).tax_id_type).toBe("EIN");
      const presence = await userClient(owner.token)
        .rpc("pre_app_secrets_presence", { pre_app_id_input: taxPreAppId })
        .single();
      expect(presence.error).toBeNull();
      expect(presence.data).toMatchObject({ tax_id_on_file: false, tax_id_type_on_file: "EIN" });

      const write = await submitTax("SSN", TAX.ssn);
      expect(write.status, write.raw).toBe(200);

      const rowsAfter = await storedRows();
      expect(rowsAfter).toHaveLength(1);
      expect(rowsAfter[0].tax_id_type).toBe("SSN");
      const after = await invoke("read-pre-app-secrets", { pre_app_id: taxPreAppId }, owner.token);
      expect(after.body.tax_id).toEqual({
        on_file: true,
        tax_id_type: "SSN",
        tax_id_last4: TAX.ssn.slice(-4),
      });
      expect(after.raw).not.toContain(TAX.ssn);
    });
  });
});

/**
 * Phase 5 (docs/design/intake-and-reports.md §1.E, A24): every default read is
 * masked, admin included, and an admin sees a full value only by revealing ONE
 * field. record_pre_app_secret_reveal() (20261028140000) writes the audit row
 * and enforces 30 reveals per admin per hour before anything is decrypted.
 *
 * Its own fully-populated pre-app, so no other block's writes can make an
 * assertion here pass by accident.
 */
describe("admin reveal, one field at a time", () => {
  let revealPreAppId: number;
  let revealOwnerId: number;
  let emptyPreAppId: number;
  const VALUES = {
    ssn: "234-56-7891",
    routing: "021000021",
    account: "000987654321",
    rpPassword: "reveal-rp-secret",
    ein: "07-2462468",
  };
  /** Every full value, for "nowhere in this body" checks. */
  const ALL = Object.values(VALUES);

  async function revealRows(id = revealPreAppId) {
    const { data } = await adminClient()
      .from("audit_log")
      .select("actor_id, action, row_id, created_at")
      .eq("row_id", String(id))
      .like("action", "read_pre_app_secrets:reveal:%")
      .order("id");
    return (data ?? []) as Record<string, string>[];
  }

  async function clearAdminReveals() {
    await adminClient()
      .from("audit_log")
      .delete()
      .eq("actor_id", admin.id)
      .like("action", "read_pre_app_secrets:reveal:%");
  }

  beforeAll(async () => {
    if (FUNCTIONS_DOWN) return;
    ({ preAppId: revealPreAppId, ownerRowId: revealOwnerId } = await makePreApp(
      owner.id,
      "Reveal Live Co",
    ));
    ({ preAppId: emptyPreAppId } = await makePreApp(owner.id, "Reveal Empty Co"));
    const { error } = await adminClient()
      .from("pre_apps")
      .update({ ein_type: "EIN" })
      .eq("id", revealPreAppId);
    if (error) throw error;
    const write = await invoke(
      "submit-pre-app-secrets",
      {
        secrets: [
          { kind: "owner_ssn", pre_app_owner_id: revealOwnerId, ssn: VALUES.ssn },
          { kind: "banking", pre_app_id: revealPreAppId, aba_routing: VALUES.routing, account_number: VALUES.account },
          { kind: "terminal", pre_app_id: revealPreAppId, rp_password: VALUES.rpPassword },
          { kind: "tax_id", pre_app_id: revealPreAppId, tax_id_type: "EIN", tax_id: VALUES.ein },
        ],
      },
      owner.token,
    );
    expect(write.status, write.raw).toBe(200);
  });

  // The limit counts every reveal this admin made in the last hour, including
  // the blocks above; each test here starts from none.
  beforeEach(async () => {
    if (FUNCTIONS_DOWN) return;
    await clearAdminReveals();
  });

  describe("the default read is masked for everyone", () => {
    it("gives the rep the last four of every secret, presence for the password, and no full value", async () => {
      const read = await invoke("read-pre-app-secrets", { pre_app_id: revealPreAppId }, owner.token);
      expect(read.status, read.raw).toBe(200);
      expect(read.body).toEqual({
        tier: "last4",
        owners: [{ pre_app_owner_id: revealOwnerId, owner_name: "Live Owner", ssn_on_file: true, ssn_last4: "7891" }],
        banking: { on_file: true, aba_routing_last4: "0021", account_number_last4: "4321" },
        terminal: { on_file: true },
        tax_id: { on_file: true, tax_id_type: "EIN", tax_id_last4: "2468" },
      });
      for (const value of ALL) expect(read.raw).not.toContain(value);
      expect(read.raw).not.toContain(VALUES.ein.replace("-", ""));
      expect(read.raw).not.toContain(VALUES.ssn.replace(/-/g, ""));
    });

    it("gives an admin exactly the rep's masked body, and writes no reveal row", async () => {
      const rep = await invoke("read-pre-app-secrets", { pre_app_id: revealPreAppId }, owner.token);
      const asAdmin = await invoke("read-pre-app-secrets", { pre_app_id: revealPreAppId }, admin.token);
      expect(asAdmin.status, asAdmin.raw).toBe(200);
      expect(asAdmin.body).toEqual(rep.body);
      for (const value of ALL) expect(asAdmin.raw).not.toContain(value);
      expect(await revealRows()).toEqual([]);
    });
  });

  describe("a reveal returns one value and writes one audit row", () => {
    const cases: [string, () => Record<string, unknown>, string, () => string][] = [
      ["an owner SSN", () => ({ field: "owner_ssn", pre_app_owner_id: revealOwnerId }), VALUES.ssn,
        () => `read_pre_app_secrets:reveal:owner_ssn:${revealOwnerId}`],
      ["the routing number", () => ({ field: "aba_routing" }), VALUES.routing, () => "read_pre_app_secrets:reveal:aba_routing"],
      ["the account number", () => ({ field: "account_number" }), VALUES.account, () => "read_pre_app_secrets:reveal:account_number"],
      ["the RP password", () => ({ field: "rp_password" }), VALUES.rpPassword, () => "read_pre_app_secrets:reveal:rp_password"],
      ["the tax ID", () => ({ field: "tax_id" }), VALUES.ein, () => "read_pre_app_secrets:reveal:tax_id"],
    ];

    for (const [label, field, value, action] of cases) {
      it(`reveals ${label}, and nothing else, naming the admin, the pre-app and the field`, async () => {
        const before = Date.now();
        const shown = await reveal(revealPreAppId, field());
        expect(shown.status, shown.raw).toBe(200);
        expect(shown.body.value).toBe(value);
        expect(shown.body.field).toBe(field().field);
        // No other secret rides along with the one asked for.
        for (const other of ALL.filter((v) => v !== value)) expect(shown.raw).not.toContain(other);

        const rows = await revealRows();
        expect(rows).toHaveLength(1);
        expect(rows[0].actor_id).toBe(admin.id);
        expect(rows[0].action).toBe(action());
        expect(rows[0].row_id).toBe(String(revealPreAppId));
        expect(new Date(rows[0].created_at).getTime()).toBeGreaterThanOrEqual(before - 60_000);
      });
    }

    it("writes one row per reveal: the same field twice is two rows", async () => {
      await reveal(revealPreAppId, { field: "tax_id" });
      await reveal(revealPreAppId, { field: "tax_id" });
      expect((await revealRows()).map((r) => r.action)).toEqual([
        "read_pre_app_secrets:reveal:tax_id",
        "read_pre_app_secrets:reveal:tax_id",
      ]);
    });

    it("sets Cache-Control: no-store on a reveal", async () => {
      const { apiUrl, anonKey } = getStackConfig();
      const res = await fetch(`${apiUrl}/functions/v1/read-pre-app-secrets`, {
        method: "POST",
        headers: { apikey: anonKey, Authorization: `Bearer ${admin.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ pre_app_id: revealPreAppId, reveal: { field: "account_number" } }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
    });
  });

  describe("a rep cannot reveal", () => {
    it("refuses the owning rep with 403, returning no value and writing no row", async () => {
      for (const field of [
        { field: "owner_ssn", pre_app_owner_id: revealOwnerId },
        { field: "aba_routing" },
        { field: "account_number" },
        { field: "rp_password" },
        { field: "tax_id" },
      ]) {
        const asRep = await reveal(revealPreAppId, field, owner.token);
        expect(asRep.status, asRep.raw).toBe(403);
        expect(asRep.body).toEqual({ error: "Only an admin can reveal a full value" });
        for (const value of ALL) expect(asRep.raw).not.toContain(value);
      }
      const { data } = await adminClient()
        .from("audit_log")
        .select("id")
        .eq("actor_id", owner.id)
        .like("action", "read_pre_app_secrets:reveal:%");
      expect(data).toEqual([]);
    });

    it("gives another rep, a missing pre-app and the owner the same 403 (no id oracle)", async () => {
      const notYours = await reveal(revealPreAppId, { field: "tax_id" }, intruder.token);
      const missing = await reveal(MISSING_ID, { field: "tax_id" }, intruder.token);
      const own = await reveal(revealPreAppId, { field: "tax_id" }, owner.token);
      expect(notYours.status).toBe(403);
      expect(notYours.body).toEqual(missing.body);
      expect(notYours.body).toEqual(own.body);
    });

    it("refuses a deactivated caller before the role check", async () => {
      const r = await reveal(deactivatedPreAppId, { field: "tax_id" }, deactivated.token);
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ error: "Account is not active" });
    });

    it("refuses an unauthenticated reveal with 401", async () => {
      const r = await invoke("read-pre-app-secrets", { pre_app_id: revealPreAppId, reveal: { field: "tax_id" } });
      expect(r.status).toBe(401);
    });

    it("cannot be reached through the SQL function either: a rep calling it is refused", async () => {
      const { error } = await userClient(owner.token).rpc("record_pre_app_secret_reveal", {
        pre_app_id_input: revealPreAppId,
        field_input: "tax_id",
      });
      expect(error?.code).toBe("PT403");
    });
  });

  describe("malformed or impossible reveals", () => {
    const bad: [string, () => Record<string, unknown>][] = [
      ["an unknown field", () => ({ field: "ssn" })],
      ["a field that is not a string", () => ({ field: 1 })],
      ["an owner SSN with no owner", () => ({ field: "owner_ssn" })],
      ["an owner id on a pre-app field", () => ({ field: "tax_id", pre_app_owner_id: revealOwnerId })],
      ["an extra member", () => ({ field: "tax_id", all: true })],
      ["a list of fields", () => ({ field: ["tax_id", "aba_routing"] })],
    ];
    for (const [label, field] of bad) {
      it(`refuses ${label} with 400, revealing nothing`, async () => {
        const r = await reveal(revealPreAppId, field());
        expect(r.status, r.raw).toBe(400);
        for (const value of ALL) expect(r.raw).not.toContain(value);
        expect(await revealRows()).toEqual([]);
      });
    }

    it("refuses a reveal that is not an object with 400", async () => {
      const r = await invoke("read-pre-app-secrets", { pre_app_id: revealPreAppId, reveal: "tax_id" }, admin.token);
      expect(r.status).toBe(400);
    });

    it("404s an owner from another pre-app, without revealing their SSN", async () => {
      const r = await reveal(revealPreAppId, { field: "owner_ssn", pre_app_owner_id: ownerRowId });
      expect(r.status).toBe(404);
      expect(r.raw).not.toContain(PLAINTEXT.ssn);
      expect(await revealRows()).toEqual([]);
    });

    it("404s a field that is not on file, and writes no row", async () => {
      const r = await reveal(emptyPreAppId, { field: "account_number" });
      expect(r.status).toBe(404);
      expect(r.body).toEqual({ error: "Not on file" });
      expect(await revealRows(emptyPreAppId)).toEqual([]);
    });
  });

  describe("no audit row, no value", () => {
    it("returns 500 and no value when the audit write fails, and nothing is recorded", async () => {
      const install = psql(`
        create function public.zz_fail_reveal_audit() returns trigger language plpgsql as $$
        begin raise exception 'audit store unavailable'; end $$;
        create trigger zz_fail_reveal_audit before insert on public.audit_log
          for each row when (new.action like 'read_pre_app_secrets:reveal:%')
          execute function public.zz_fail_reveal_audit();`);
      expect(install.ok, install.err).toBe(true);
      try {
        for (const field of [
          { field: "tax_id" },
          { field: "owner_ssn", pre_app_owner_id: revealOwnerId },
          { field: "rp_password" },
        ]) {
          const r = await reveal(revealPreAppId, field);
          expect(r.status, r.raw).toBe(500);
          expect(r.body).toEqual({ error: "Could not record the access" });
          for (const value of ALL) expect(r.raw).not.toContain(value);
        }
      } finally {
        const drop = psql(`
          drop trigger if exists zz_fail_reveal_audit on public.audit_log;
          drop function if exists public.zz_fail_reveal_audit();`);
        expect(drop.ok, drop.err).toBe(true);
      }
      expect(await revealRows()).toEqual([]);
      // And the same request works once the store is back.
      expect((await reveal(revealPreAppId, { field: "tax_id" })).body.value).toBe(VALUES.ein);
    });
  });

  describe("rate limit: 30 reveals per admin per rolling hour", () => {
    afterEach(async () => {
      if (FUNCTIONS_DOWN) return;
      await clearAdminReveals();
    });

    it("refuses the 31st with 429 and the function's sentence, revealing nothing and recording nothing", async () => {
      // 30 reveals in the last hour, written as the function would, so the
      // test does not decrypt thirty times to get there.
      const { error } = await adminClient().from("audit_log").insert(
        Array.from({ length: 30 }, () => ({
          actor_id: admin.id,
          action: "read_pre_app_secrets:reveal:tax_id",
          table_name: "pre_apps",
          row_id: String(emptyPreAppId),
        })),
      );
      if (error) throw error;

      const r = await reveal(revealPreAppId, { field: "tax_id" });
      expect(r.status, r.raw).toBe(429);
      expect(String(r.body.error)).toMatch(/^You have reached the limit of 30 reveals an hour\. Try again in \d+ minutes?\.$/);
      for (const value of ALL) expect(r.raw).not.toContain(value);
      expect(await revealRows()).toEqual([]);

      // Default reads are not limited: the masked view still works.
      const masked = await invoke("read-pre-app-secrets", { pre_app_id: revealPreAppId }, admin.token);
      expect(masked.status).toBe(200);
    });

    it("allows the 30th, and counts only the last hour", async () => {
      const old = new Date(Date.now() - 61 * 60_000).toISOString();
      const row = {
        actor_id: admin.id,
        action: "read_pre_app_secrets:reveal:aba_routing",
        table_name: "pre_apps",
        row_id: String(emptyPreAppId),
      };
      // Two inserts, not one: a bulk insert whose rows differ in keys sends
      // NULL for a missing column rather than its default (PostgREST), which
      // would leave the 29 recent rows with no created_at.
      const recent = await adminClient().from("audit_log").insert(Array.from({ length: 29 }, () => row));
      if (recent.error) throw recent.error;
      const stale = await adminClient()
        .from("audit_log")
        .insert(Array.from({ length: 5 }, () => ({ ...row, created_at: old })));
      if (stale.error) throw stale.error;
      const thirtieth = await reveal(revealPreAppId, { field: "aba_routing" });
      expect(thirtieth.status, thirtieth.raw).toBe(200);
      expect(thirtieth.body.value).toBe(VALUES.routing);
      expect((await reveal(revealPreAppId, { field: "aba_routing" })).status).toBe(429);
    });
  });
});
