// Fixtures for tests that run against a REAL local Supabase stack
// (`supabase start` + `supabase functions serve`), not PGlite.
//
// The RLS tests under tests/rls prove what Postgres enforces. They cannot prove
// anything about the Edge Functions: those are Deno, they authenticate the JWT
// themselves, they call PostgREST rather than Postgres directly, and they talk
// to Storage. Every one of those layers is a place the deployed behaviour can
// diverge from what the policies alone imply, so these tests drive the real
// HTTP endpoints with real access tokens.
//
// Everything here is namespaced with a `live-` prefix and torn down afterwards,
// so a developer's own local data survives a run.

import { execSync } from "node:child_process";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type StackConfig = {
  apiUrl: string;
  anonKey: string;
  serviceRoleKey: string;
};

let cachedConfig: StackConfig | null = null;

/**
 * Local stack credentials.
 *
 * Read from `supabase status -o env` rather than hardcoded, so this keeps
 * working when the CLI rotates the demo keys (it did once already — the old
 * long-lived `super-secret-jwt-token...` anon key is gone in recent versions).
 * Env vars win, so the same suite can be pointed at a branch/preview stack.
 */
export function getStackConfig(): StackConfig {
  if (cachedConfig) return cachedConfig;

  const fromEnv = {
    apiUrl: process.env.SUPABASE_URL,
    anonKey: process.env.SUPABASE_ANON_KEY,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };

  if (fromEnv.apiUrl && fromEnv.anonKey && fromEnv.serviceRoleKey) {
    cachedConfig = fromEnv as StackConfig;
    return cachedConfig;
  }

  const raw = execSync("npx supabase status -o env", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const values = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const match = /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim());
    if (match) values.set(match[1], match[2]);
  }

  const apiUrl = fromEnv.apiUrl ?? values.get("API_URL");
  const anonKey = fromEnv.anonKey ?? values.get("ANON_KEY");
  const serviceRoleKey =
    fromEnv.serviceRoleKey ?? values.get("SERVICE_ROLE_KEY");

  if (!apiUrl || !anonKey || !serviceRoleKey) {
    throw new Error(
      "Could not read API_URL / ANON_KEY / SERVICE_ROLE_KEY from `supabase status`. " +
        "Is the local stack running?",
    );
  }

  cachedConfig = { apiUrl, anonKey, serviceRoleKey };
  return cachedConfig;
}

/**
 * True when the functions runtime is actually answering.
 *
 * Deliberately probes a function rather than the REST endpoint: `supabase start`
 * can be up while `functions serve` is not, and a suite that "passed" because
 * every request failed to connect is the exact false negative these tests exist
 * to avoid.
 */
export async function functionsAreServed(): Promise<boolean> {
  try {
    const { apiUrl } = getStackConfig();
    const response = await fetch(`${apiUrl}/functions/v1/create-upload-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    // Any HTTP answer means the runtime is alive. An unauthenticated POST
    // should be rejected, which is itself worth knowing about.
    return response.status > 0;
  } catch {
    return false;
  }
}

/**
 * Invokes each function once and waits for it to stop 502-ing.
 *
 * Call this before asserting on status codes. The CLI writes a `.npmrc` into a
 * function's directory the first time that function is invoked, its own file
 * watcher sees the write, and the whole runtime restarts — so the *first*
 * request to each new function tends to come back 502 "invalid response from the
 * upstream server", and so does anything else in flight during the restart.
 *
 * Without this the failure is thoroughly misleading: a correct function looks
 * like it returns 502 instead of 403, and only the functions that happened to be
 * warmed earlier pass.
 */
export async function warmFunctions(names: readonly string[]): Promise<void> {
  for (const name of names) {
    for (let attempt = 0; attempt < 15; attempt++) {
      // Unauthenticated and empty-bodied: the point is to boot the isolate, and
      // whatever it answers is fine as long as it is not a restart.
      const { status } = await invoke(name, {});
      if (status !== 502) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

export function adminClient(): SupabaseClient {
  const { apiUrl, serviceRoleKey } = getStackConfig();
  return createClient(apiUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function anonClient(): SupabaseClient {
  const { apiUrl, anonKey } = getStackConfig();
  return createClient(apiUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** A client that acts as a specific signed-in user, RLS and all. */
export function userClient(accessToken: string): SupabaseClient {
  const { apiUrl, anonKey } = getStackConfig();
  return createClient(apiUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/**
 * Exported because the Manage Users suite has to sign a persona in by password
 * — proving a deactivated account is refused needs the *correct* password to be
 * the thing that gets refused, or the test proves nothing.
 */
export const PASSWORD = "live-test-password-123";

type Persona = {
  key: "admin" | "owner" | "intruder" | "deactivated";
  email: string;
  fullName: string;
  role: "admin" | "agent";
  isActive: boolean;
};

const PERSONAS: Persona[] = [
  {
    key: "admin",
    email: "live-admin@tapswipe.test",
    fullName: "Live Admin",
    role: "admin",
    isActive: true,
  },
  {
    key: "owner",
    email: "live-owner@tapswipe.test",
    fullName: "Live Owner Agent",
    role: "agent",
    isActive: true,
  },
  {
    key: "intruder",
    email: "live-intruder@tapswipe.test",
    fullName: "Live Intruder Agent",
    role: "agent",
    isActive: true,
  },
  {
    key: "deactivated",
    email: "live-deactivated@tapswipe.test",
    fullName: "Live Deactivated Agent",
    role: "agent",
    isActive: false,
  },
];

export type PersonaKey = Persona["key"];

/** Persona key -> the email they sign in with. */
export const PERSONA_EMAILS = Object.fromEntries(
  PERSONAS.map((persona) => [persona.key, persona.email]),
) as Record<PersonaKey, string>;

export type Fixtures = {
  userIds: Record<PersonaKey, string>;
  tokens: Record<PersonaKey, string>;
  /** merchants.id owned by each persona. */
  merchantIds: Record<PersonaKey, number>;
  /** documents.id owned by each persona, each with real bytes in Storage. */
  documentIds: Record<PersonaKey, number>;
  /** The bytes behind the owner's document, for a round-trip comparison. */
  ownerDocumentBody: string;
  /** An owner_id / document_id that has never existed. */
  missingId: number;
};

export const MISSING_ID = 987654;
export const BUCKET = "documents";

/**
 * Creates the bucket, four users, four merchants and four documents, and signs
 * everyone in.
 *
 * Four personas rather than two: with only an owner and an intruder, a
 * deactivated caller and a stranger produce the same rejection and neither
 * assertion means much. Each persona owns their *own* merchant, so the
 * deactivated case is testing deactivation and not ownership — if the
 * deactivated agent pointed at someone else's merchant, a 404 would look like a
 * pass for entirely the wrong reason.
 */
export async function provisionFixtures(): Promise<Fixtures> {
  const admin = adminClient();

  await teardownFixtures();

  // The bucket is created out-of-band in production (it isn't in any
  // migration), so it has to be created here too or every signing call 404s.
  const { error: bucketError } = await admin.storage.createBucket(BUCKET, {
    public: false,
  });
  if (bucketError && !/exists/i.test(bucketError.message)) {
    throw new Error(`Could not create bucket: ${bucketError.message}`);
  }

  const userIds = {} as Record<PersonaKey, string>;
  const tokens = {} as Record<PersonaKey, string>;
  const merchantIds = {} as Record<PersonaKey, number>;
  const documentIds = {} as Record<PersonaKey, string | number>;
  const ownerDocumentBody = "live round-trip payload";

  for (const persona of PERSONAS) {
    const { data: created, error: createError } =
      await admin.auth.admin.createUser({
        email: persona.email,
        password: PASSWORD,
        email_confirm: true,
      });
    if (createError || !created.user) {
      throw new Error(
        `Could not create ${persona.email}: ${createError?.message}`,
      );
    }
    userIds[persona.key] = created.user.id;

    // profiles has no insert policy by design — rows are written by the
    // service role, exactly as the create-user function does it.
    const { error: profileError } = await admin.from("profiles").insert({
      id: created.user.id,
      full_name: persona.fullName,
      role: persona.role,
      is_active: persona.isActive,
    });
    if (profileError) {
      throw new Error(
        `Could not insert profile for ${persona.email}: ${profileError.message}`,
      );
    }

    const { data: merchant, error: merchantError } = await admin
      .from("merchants")
      .insert({
        agent_id: created.user.id,
        mid: `LIVE-MID-${persona.key.toUpperCase()}`,
        dba: `Live ${persona.fullName} Co`,
        legal_business_name: `Live ${persona.fullName} Co LLC`,
        status: "active",
        processor: "TSYS",
      })
      .select("id")
      .single();
    if (merchantError || !merchant) {
      throw new Error(
        `Could not insert merchant for ${persona.email}: ${merchantError?.message}`,
      );
    }
    merchantIds[persona.key] = merchant.id;

    // A real object in Storage, because createSignedUrl fails on a key that
    // isn't there — a download test against a dangling file_key would report
    // 500 and prove nothing about authorization.
    const fileKey = `${created.user.id}/merchant/${merchant.id}/live-fixture.txt`;
    const body =
      persona.key === "owner"
        ? ownerDocumentBody
        : `live fixture for ${persona.key}`;
    const { error: uploadError } = await admin.storage
      .from(BUCKET)
      .upload(fileKey, new Blob([body], { type: "text/plain" }), {
        upsert: true,
        contentType: "text/plain",
      });
    if (uploadError) {
      throw new Error(
        `Could not upload fixture object for ${persona.email}: ${uploadError.message}`,
      );
    }

    const { data: document, error: documentError } = await admin
      .from("documents")
      .insert({
        agent_id: created.user.id,
        owner_type: "merchant",
        owner_id: merchant.id,
        doc_type: "Voided check",
        file_key: fileKey,
        file_name: `live-${persona.key}.txt`,
        mime_type: "text/plain",
      })
      .select("id")
      .single();
    if (documentError || !document) {
      throw new Error(
        `Could not insert document for ${persona.email}: ${documentError?.message}`,
      );
    }
    documentIds[persona.key] = document.id;

    // Sign in as the persona. A deactivated profile is not a banned auth.users
    // row, so this succeeds for all four — which is the whole point of the
    // is_active_agent() check inside the functions: a deactivated agent walks
    // in holding a perfectly valid token.
    const { data: session, error: signInError } = await anonClient()
      .auth.signInWithPassword({ email: persona.email, password: PASSWORD });
    if (signInError || !session.session) {
      throw new Error(
        `Could not sign in ${persona.email}: ${signInError?.message}`,
      );
    }
    tokens[persona.key] = session.session.access_token;
  }

  return {
    userIds,
    tokens,
    merchantIds,
    documentIds: documentIds as Record<PersonaKey, number>,
    ownerDocumentBody,
    missingId: MISSING_ID,
  };
}

/**
 * Removes everything provisionFixtures created, in FK order.
 *
 * merchants.agent_id and documents.agent_id reference profiles with no ON
 * DELETE clause, so deleting the auth user first would fail on the profiles
 * cascade. Storage objects are removed by prefix, keyed on the user id.
 */
export async function teardownFixtures(): Promise<void> {
  const admin = adminClient();
  const emails = new Set(PERSONAS.map((p) => p.email));

  const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const stale = (list?.users ?? []).filter(
    (u) => u.email && emails.has(u.email),
  );

  for (const user of stale) {
    const { data: objects } = await admin.storage
      .from(BUCKET)
      .list(`${user.id}/merchant`, { limit: 1000 });
    // list() is one level deep, so walk merchant/<id>/ to reach the files.
    for (const dir of objects ?? []) {
      const { data: files } = await admin.storage
        .from(BUCKET)
        .list(`${user.id}/merchant/${dir.name}`, { limit: 1000 });
      const paths = (files ?? []).map(
        (f) => `${user.id}/merchant/${dir.name}/${f.name}`,
      );
      if (paths.length > 0) await admin.storage.from(BUCKET).remove(paths);
    }

    // Collected before the delete, because the delete is what makes them
    // unfindable — and the cross-agent audit trigger keys its rows on the
    // merchant id, not the agent.
    const { data: merchants } = await admin
      .from("merchants")
      .select("id")
      .eq("agent_id", user.id);
    const merchantIds = (merchants ?? []).map((m) => String(m.id));

    await admin.from("documents").delete().eq("agent_id", user.id);
    await admin.from("merchants").delete().eq("agent_id", user.id);

    // The delete above fires log_cross_agent_change() — a service-role
    // connection has no auth.uid(), so it counts as cross-agent and each removed
    // merchant leaves a cross_agent_delete row behind. Cleared here, after the
    // delete rather than before, or the rows this generates would outlive it.
    if (merchantIds.length > 0) {
      await admin
        .from("audit_log")
        .delete()
        .eq("table_name", "merchants")
        .in("row_id", merchantIds);
    }

    // Before deleteUser, not after, and not optional: audit_log.actor_id
    // references profiles(id) with no ON DELETE clause, so a persona who has
    // performed an audited admin action cannot be deleted while those rows
    // exist. deleteUser would fail on the FK, the persona would survive, and
    // the next run would collide with a "user already registered" error that
    // says nothing about the real cause.
    //
    // Both sides: as the actor of an action, and as the target of one.
    await admin.from("audit_log").delete().eq("actor_id", user.id);
    await admin.from("audit_log").delete().eq("row_id", user.id);

    await admin.auth.admin.deleteUser(user.id);
  }
}

/**
 * Deletes an ad-hoc user created inside a test, with the same FK ordering.
 *
 * Tests that create accounts through the create-user function own the cleanup:
 * teardownFixtures only knows about the four named personas.
 */
export async function deleteUserCompletely(userId: string): Promise<void> {
  const admin = adminClient();
  await admin.from("audit_log").delete().eq("actor_id", userId);
  await admin.from("audit_log").delete().eq("row_id", userId);
  await admin.auth.admin.deleteUser(userId);
}

export type FunctionResponse = {
  status: number;
  body: Record<string, unknown>;
  /** Verbatim text, for reporting when the body isn't JSON (e.g. a 500 page). */
  raw: string;
};

/** POSTs to a served Edge Function as `accessToken`, or unauthenticated. */
export async function invoke(
  name: string,
  body: unknown,
  accessToken?: string,
): Promise<FunctionResponse> {
  const { apiUrl, anonKey } = getStackConfig();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    apikey: anonKey,
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const response = await fetch(`${apiUrl}/functions/v1/${name}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const raw = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Left empty; `raw` carries the detail.
  }

  return { status: response.status, body: parsed, raw };
}

/**
 * Rewrites a signed URL's origin to the host-reachable one.
 *
 * Inside the containers SUPABASE_URL is `http://kong:8000`, so that's the
 * origin supabase-js stamps onto the URLs it signs. The path and token are what
 * matter; only the hostname is unreachable from the test process. This is a
 * local-stack artifact — in production the function's SUPABASE_URL is already
 * the public one.
 */
export function toReachableUrl(signedUrl: string): string {
  const { apiUrl } = getStackConfig();
  const signed = new URL(signedUrl);
  const target = new URL(apiUrl);
  signed.protocol = target.protocol;
  signed.host = target.host;
  return signed.toString();
}
