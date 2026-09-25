import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  adminClient,
  anonClient,
  functionsAreServed,
  getStackConfig,
  invoke,
  MISSING_ID,
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

type Persona = { id: string; token: string };

let owner: Persona;
let intruder: Persona;
let admin: Persona;
let preAppId: number;
let ownerRowId: number;
let intruderPreAppId: number;
let intruderOwnerRowId: number;

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

beforeAll(async () => {
  // Hard error rather than skip: a silently skipped suite is worse than a red one.
  if (!(await functionsAreServed())) {
    throw new Error(
      "Edge Functions are not being served. Run:\n" +
        "  npx supabase start\n" +
        "  npx supabase functions serve --env-file ./supabase/functions/.env",
    );
  }

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
}, 120_000);

afterAll(async () => {
  const service = adminClient();
  for (const persona of [owner, intruder, admin].filter(Boolean)) {
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
  it("stores all four values and reads them back as plaintext for an admin", async () => {
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
    expect(read.body.tier).toBe("full");

    const owners = read.body.owners as Record<string, unknown>[];
    expect(owners[0].ssn).toBe(PLAINTEXT.ssn);
    const banking = read.body.banking as Record<string, unknown>;
    expect(banking.aba_routing).toBe(PLAINTEXT.routing);
    expect(banking.account_number).toBe(PLAINTEXT.account);
    const terminal = read.body.terminal as Record<string, unknown>;
    expect(terminal.rp_password).toBe(PLAINTEXT.rpPassword);
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

    const read = await invoke(
      "read-pre-app-secrets",
      { pre_app_id: preAppId },
      admin.token,
    );
    expect((read.body.banking as Record<string, unknown>).aba_routing).toBe(
      corrected,
    );
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
    expect(row!.action).toBe("read_pre_app_secrets:full");
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
