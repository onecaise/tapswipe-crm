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

/**
 * The four values documents.owner_type allows, and the table each one's
 * agent_id comes from.
 *
 * Mirrors OWNER_TABLES in supabase/functions/_shared/documents.ts. Every one of
 * them is provisioned per persona, because "works for merchants" was true of the
 * document panel for months while three of the four were untested — and one of
 * them (support_ticket) had no UI at all.
 */
export const OWNER_TABLES = {
  merchant: "merchants",
  lead: "leads",
  pre_app: "pre_apps",
  support_ticket: "support_tickets",
} as const;

export type OwnerType = keyof typeof OWNER_TABLES;

export const OWNER_TYPES = Object.keys(OWNER_TABLES) as OwnerType[];

export type Fixtures = {
  userIds: Record<PersonaKey, string>;
  tokens: Record<PersonaKey, string>;
  /** merchants.id owned by each persona. */
  merchantIds: Record<PersonaKey, number>;
  /** One record of every document-owning type, per persona. */
  ownerIds: Record<PersonaKey, Record<OwnerType, number>>;
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
 * The per-bucket upload ceiling, mirroring MAX_DOCUMENT_BYTES in lib/documents.ts.
 *
 * Redeclared rather than imported because this suite runs against the stack and
 * not the app, and pulling an app module in for one number would make the fixture
 * helper depend on the `@/` alias. tests/live/document-urls.test.ts asserts the
 * server actually refuses at this boundary, which is what keeps the two honest.
 */
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

/**
 * The second private bucket, holding uploaded residual reports.
 *
 * Like `documents` it is created out-of-band — neither is in any migration — so a
 * freshly started local stack has neither and every signing call 404s until
 * provisionFixtures() creates them.
 */
export const RESIDUAL_BUCKET = "residual-imports";

/**
 * Agent numbers given to the personas, so an import file can name them.
 *
 * Only the two active agents get one. The admin and the deactivated agent are
 * deliberately left without: an unrecognised number has to be reachable in a test
 * without inventing a fifth persona, and a resolved-but-deactivated rep is its own
 * case that a test opts into by assigning one.
 */
export const PERSONA_AGENT_NUMBERS: Partial<Record<PersonaKey, string>> = {
  owner: "LIVE-4471",
  intruder: "LIVE-9902",
};

/** An agent number no persona holds, for the unknown_agent path. */
export const UNKNOWN_AGENT_NUMBER = "LIVE-0000";

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

  // Both buckets are created out-of-band in production (neither is in any
  // migration), so they have to be created here too or every signing call 404s.
  //
  // fileSizeLimit is applied on every run, not only at creation: a bucket that
  // predates the limit keeps accepting unbounded uploads and nothing says so.
  // It is also the ONLY thing that limits an upload — config.toml's
  // `[storage] file_size_limit` does not apply to a signed PUT (measured: 120 MiB
  // accepted with it set to 50MiB), and both buckets came back from listBuckets()
  // with file_size_limit = null.
  for (const bucket of [BUCKET, RESIDUAL_BUCKET]) {
    const { error: bucketError } = await admin.storage.createBucket(bucket, {
      public: false,
      fileSizeLimit: MAX_DOCUMENT_BYTES,
    });
    if (bucketError && !/exists/i.test(bucketError.message)) {
      throw new Error(`Could not create bucket ${bucket}: ${bucketError.message}`);
    }
    const { error: limitError } = await admin.storage.updateBucket(bucket, {
      public: false,
      fileSizeLimit: MAX_DOCUMENT_BYTES,
    });
    if (limitError) {
      throw new Error(`Could not limit bucket ${bucket}: ${limitError.message}`);
    }
  }

  const userIds = {} as Record<PersonaKey, string>;
  const tokens = {} as Record<PersonaKey, string>;
  const merchantIds = {} as Record<PersonaKey, number>;
  const ownerIds = {} as Record<PersonaKey, Record<OwnerType, number>>;
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
      // The denormalised copy of auth.users.email, which create-user also
      // writes. It was missing here, and that made these personas
      // unrepresentative of any real account: stage-user-import detects an
      // address that already exists by reading profiles.email, so a persona
      // with a null copy looked like a brand-new person to the importer. Any
      // feature that resolves a profile BY EMAIL is invisible to a fixture that
      // does not set one.
      email: persona.email,
      role: persona.role,
      is_active: persona.isActive,
      // Only the two active agents get one, so an import file can name them and
      // an unrecognised number is still reachable without a fifth persona.
      agent_number: PERSONA_AGENT_NUMBERS[persona.key] ?? null,
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

    // The other three document-owning types. Each function resolves the parent
    // record's agent_id through a per-owner_type table lookup, so "an agent
    // cannot upload against a record that isn't theirs" is four separate code
    // paths through OWNER_TABLES, not one — and only the merchant one was ever
    // exercised.
    const { data: lead, error: leadError } = await admin
      .from("leads")
      .insert({
        agent_id: created.user.id,
        dba: `Live ${persona.key} Lead`,
        merchant_legal_name: `Live ${persona.fullName} Lead LLC`,
        status: "open",
      })
      .select("id")
      .single();
    if (leadError || !lead) {
      throw new Error(`Could not insert lead for ${persona.email}: ${leadError?.message}`);
    }

    const { data: preApp, error: preAppError } = await admin
      .from("pre_apps")
      .insert({
        agent_id: created.user.id,
        dba_name: `Live ${persona.key} Pre-App`,
        legal_business_name: `Live ${persona.fullName} Pre-App LLC`,
        status: "draft",
      })
      .select("id")
      .single();
    if (preAppError || !preApp) {
      throw new Error(
        `Could not insert pre-app for ${persona.email}: ${preAppError?.message}`,
      );
    }

    const { data: ticket, error: ticketError } = await admin
      .from("support_tickets")
      .insert({
        agent_id: created.user.id,
        subject: `Live ${persona.key} Ticket`,
        message: "Document fixture.",
        status: "open",
      })
      .select("id")
      .single();
    if (ticketError || !ticket) {
      throw new Error(
        `Could not insert ticket for ${persona.email}: ${ticketError?.message}`,
      );
    }

    ownerIds[persona.key] = {
      merchant: merchant.id,
      lead: lead.id,
      pre_app: preApp.id,
      support_ticket: ticket.id,
    };

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
    ownerIds,
    documentIds: documentIds as Record<PersonaKey, number>,
    ownerDocumentBody,
    missingId: MISSING_ID,
  };
}

/**
 * Clears every payout row that references `userId`, in FK order.
 *
 * FIVE references to profiles, all NO ACTION: rep_payout_rows.agent_id,
 * rep_payout_import_rows.agent_id, rep_payout_batches.imported_by, and both
 * rep_payout_row_history.agent_id and .changed_by. Any one of them still present
 * makes deleteUser fail on the FK — and this is not hypothetical: it has already
 * happened once. A probe script's teardown deleted the profile without clearing
 * staging rows, did not check the error, and the surviving rep then resolved an
 * agent number the next run expected to be unknown. It presented as a parser bug.
 *
 * Order matters: history and staging first (they reference profiles directly),
 * then ledger rows, then batches — a batch cannot go while ledger rows point at it
 * either, since rep_payout_rows.batch_id is `set null` but the delete would still
 * have to run.
 *
 * Called by both teardownFixtures and deleteUserCompletely, so ad-hoc accounts
 * created inside a test get the same treatment.
 */
async function clearPayoutRows(
  admin: SupabaseClient,
  userId: string,
): Promise<void> {
  await admin.from("rep_payout_row_history").delete().eq("agent_id", userId);
  await admin.from("rep_payout_row_history").delete().eq("changed_by", userId);
  await admin.from("rep_payout_import_rows").delete().eq("agent_id", userId);
  await admin.from("rep_payout_rows").delete().eq("agent_id", userId);

  // Ledger rows belonging to OTHER reps can still point at a batch this user
  // imported (batch_id), so those have to be detached before the batch goes.
  // `set null` on the FK means an update, not a cascade.
  const { data: batches } = await admin
    .from("rep_payout_batches")
    .select("id")
    .eq("imported_by", userId);
  const batchIds = (batches ?? []).map((batch) => batch.id as number);

  if (batchIds.length > 0) {
    await admin
      .from("rep_payout_rows")
      .update({ batch_id: null })
      .in("batch_id", batchIds);
    await admin
      .from("rep_payout_import_rows")
      .delete()
      .in("batch_id", batchIds);
    await admin.from("rep_payout_batches").delete().eq("imported_by", userId);
  }
}

/**
 * Clears every user-import batch imported by `userId`.
 *
 * user_import_batches.imported_by is the EIGHTEENTH reference to profiles, and
 * like the other seventeen it is NO ACTION — so a batch left behind makes
 * deleteUser fail on the FK, the persona survives teardown, and the next run
 * dies on "user already registered". Exactly the trap clearPayoutRows documents,
 * with one more door.
 *
 * Only the batch needs deleting: user_import_rows.batch_id is `on delete
 * cascade`, and its user_id carries no FK at all (deliberately — an import row
 * is provenance and must outlive the account it names).
 */
async function clearUserImports(
  admin: SupabaseClient,
  userId: string,
): Promise<void> {
  await admin.from("user_import_batches").delete().eq("imported_by", userId);
}

/**
 * Removes everything provisionFixtures created, in FK order.
 *
 * merchants.agent_id and documents.agent_id reference profiles with no ON
 * DELETE clause, so deleting the auth user first would fail on the profiles
 * cascade. The five rep_payout references are the same trap with five doors —
 * see clearPayoutRows, and clearUserImports for the eighteenth. Storage objects
 * are removed by prefix, keyed on the user id.
 */
export async function teardownFixtures(): Promise<void> {
  const admin = adminClient();
  const emails = new Set(PERSONAS.map((p) => p.email));

  const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const stale = (list?.users ?? []).filter(
    (u) => u.email && emails.has(u.email),
  );

  for (const user of stale) {
    // All four owner types, not just merchant. The key is
    // {agent_id}/{owner_type}/{owner_id}/{uuid}, so anything filed against a
    // lead, pre-app or ticket used to survive teardown — invisible, since the
    // bucket is private, and cumulative across runs.
    for (const ownerType of OWNER_TYPES) {
      const { data: objects } = await admin.storage
        .from(BUCKET)
        .list(`${user.id}/${ownerType}`, { limit: 1000 });
      // list() is one level deep, so walk {owner_type}/<id>/ to reach the files.
      for (const dir of objects ?? []) {
        const { data: files } = await admin.storage
          .from(BUCKET)
          .list(`${user.id}/${ownerType}/${dir.name}`, { limit: 1000 });
        const paths = (files ?? []).map(
          (f) => `${user.id}/${ownerType}/${dir.name}/${f.name}`,
        );
        if (paths.length > 0) await admin.storage.from(BUCKET).remove(paths);
      }
    }

    // Collected before the delete, because the delete is what makes them
    // unfindable — and the cross-agent audit trigger keys its rows on the owner
    // record's id, not the agent.
    //
    // All four document-owning tables, in FK order: pre_apps.lead_id references
    // leads (`on delete set null`, so it does not block, but the pre-app has to
    // be reachable) and support_tickets.merchant_id references merchants, so
    // tickets and pre-apps go before the records they point at.
    const ownerRowIds = new Map<string, string[]>();
    for (const table of [
      "support_tickets",
      "pre_apps",
      "merchants",
      "leads",
    ] as const) {
      const { data: found } = await admin
        .from(table)
        .select("id")
        .eq("agent_id", user.id);
      ownerRowIds.set(table, (found ?? []).map((row) => String(row.id)));
    }

    await admin.from("documents").delete().eq("agent_id", user.id);
    for (const table of ownerRowIds.keys()) {
      const { error: ownerDeleteError } = await admin
        .from(table)
        .delete()
        .eq("agent_id", user.id);
      // Checked for the same reason deleteUser's error is: a silent FK failure
      // here leaves the record behind, deleteUser then fails on the profiles
      // reference, and the persona survives into the next run.
      if (ownerDeleteError) {
        throw new Error(
          `Could not delete ${table} for ${user.email}: ${ownerDeleteError.message}`,
        );
      }
    }

    // The deletes above fire log_cross_agent_change() — a service-role
    // connection has no auth.uid(), so every removed row counts as cross-agent
    // and leaves a cross_agent_delete behind. Cleared here, after the delete
    // rather than before, or the rows this generates would outlive it.
    for (const [table, ids] of ownerRowIds) {
      if (ids.length > 0) {
        await admin
          .from("audit_log")
          .delete()
          .eq("table_name", table)
          .in("row_id", ids);
      }
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

    await clearPayoutRows(admin, user.id);
    await clearUserImports(admin, user.id);

    // Residual import files, removed by the {batch_id}/ prefix. Listed rather
    // than guessed at, because the filename is whatever was uploaded.
    const { data: batchDirs } = await admin.storage
      .from(RESIDUAL_BUCKET)
      .list("", { limit: 1000 });
    for (const dir of batchDirs ?? []) {
      const { data: files } = await admin.storage
        .from(RESIDUAL_BUCKET)
        .list(dir.name, { limit: 1000 });
      const paths = (files ?? []).map((f) => `${dir.name}/${f.name}`);
      if (paths.length > 0) {
        await admin.storage.from(RESIDUAL_BUCKET).remove(paths);
      }
    }

    const { error: deleteError } = await admin.auth.admin.deleteUser(user.id);
    // Checked, not ignored. A silent FK failure here leaves the persona behind and
    // the next run dies on "user already registered", which says nothing about the
    // real cause — and a surviving persona can make a later assertion pass or fail
    // for reasons unrelated to the code under test.
    if (deleteError) {
      throw new Error(
        `Could not delete ${user.email}: ${deleteError.message}. ` +
          "Something still references their profiles row — check the five " +
          "rep_payout FKs and audit_log.",
      );
    }
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
  await clearPayoutRows(admin, userId);
  await clearUserImports(admin, userId);

  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) {
    throw new Error(`Could not delete ${userId}: ${error.message}`);
  }
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
