// Encrypts SSN, bank routing/account and the terminal RP password, and stores
// them in the three *_secrets tables.
//
// This is the ONLY write path into those tables. They have RLS enabled with zero
// policies AND no grant to anon or authenticated, so nothing else can reach them
// — including the rep's own initial submission, which is why the browser POSTs
// here rather than inserting via supabase-js.
//
// verify_jwt = false in config.toml, so this function authenticates its own
// caller. The order below is fixed and matters:
//   1. withSupabase({ auth: "user" }) rejects a missing/invalid JWT (the 401).
//   2. callerIsActive() through the CALLER-scoped client — a valid JWT proves who
//      the caller is, not that their account is still enabled.
//   3. authorization through the caller-scoped client, so RLS decides.
//   4. only then supabaseAdmin, and only for the privileged write.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

import { callerIsActive, json } from "../_shared/documents.ts";
import {
  cachedSecretsKey,
  encryptSecret,
  secretAad,
  SecretsKeyError,
} from "../_shared/crypto.ts";
import { getSecretsKeyEnv } from "../_shared/secrets-env.ts";
import { callerIsAdmin, parseSecretsBody } from "../_shared/pre-app-secrets.ts";

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    if (req.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    const userId = ctx.userClaims?.id;
    if (!userId) {
      return json({ error: "Not authenticated" }, 401);
    }

    // Load the key BEFORE parsing or touching the database. Fail-fast, so a
    // misconfigured deployment fails identically for every caller and can never
    // half-write a pre-app's secrets.
    let key: CryptoKey;
    try {
      key = await cachedSecretsKey(getSecretsKeyEnv());
    } catch (err) {
      if (err instanceof SecretsKeyError) {
        console.error(`[submit-pre-app-secrets] ${err.message}`);
        return json({ error: "Secrets encryption is not configured" }, 500);
      }
      throw err;
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Body must be JSON" }, 400);
    }

    const parsed = parseSecretsBody(body);
    if (!parsed.ok) {
      // The message names the rule, never the value.
      return json({ error: parsed.error }, 400);
    }

    if (!(await callerIsActive(ctx.supabase))) {
      return json({ error: "Account is not active" }, 403);
    }

    // Resolve every entry to a pre-app THROUGH THE CALLER'S CLIENT, so RLS is
    // what answers. Two different resolutions: an SSN hangs off pre_app_owners,
    // banking and terminal off pre_apps.
    const preAppIds = new Set<number>();
    for (const entry of parsed.entries) {
      if (entry.kind === "owner_ssn") {
        const { data } = await ctx.supabase
          .from("pre_app_owners")
          .select("id, pre_app_id")
          .eq("id", entry.pre_app_owner_id)
          .maybeSingle();
        // Absent and not-yours are indistinguishable here, deliberately —
        // otherwise this endpoint is an id oracle.
        if (!data) return json({ error: "Pre-app record not found" }, 404);
        preAppIds.add(data.pre_app_id as number);
      } else {
        preAppIds.add(entry.pre_app_id);
      }
    }

    if (preAppIds.size !== 1) {
      return json(
        { error: "All secrets in one request must belong to the same pre-app" },
        400,
      );
    }
    const preAppId = [...preAppIds][0];

    const { data: preApp } = await ctx.supabase
      .from("pre_apps")
      .select("id, status")
      .eq("id", preAppId)
      .maybeSingle();
    if (!preApp) return json({ error: "Pre-app record not found" }, 404);

    // Reps edit drafts; admins edit anything. Same rule the guard trigger
    // enforces for pre_apps itself.
    const isAdmin = await callerIsAdmin(ctx.supabase);
    if (preApp.status !== "draft" && !isAdmin) {
      return json({ error: "Pre-app is not editable" }, 409);
    }

    // ---- privileged section. Nothing above this line used supabaseAdmin. ----
    const stored: { kind: string; fields: string[] }[] = [];

    for (const entry of parsed.entries) {
      if (entry.kind === "owner_ssn") {
        const ciphertext = await encryptSecret(
          key,
          entry.ssn,
          secretAad("pre_app_owner_secrets", "ssn_encrypted", entry.pre_app_owner_id),
        );
        // No .select(), so supabase-js sends Prefer: return=minimal and the
        // ciphertext never travels back over the wire.
        const { error } = await ctx.supabaseAdmin
          .from("pre_app_owner_secrets")
          .upsert(
            {
              pre_app_owner_id: entry.pre_app_owner_id,
              ssn_encrypted: ciphertext,
              key_version: 1,
            },
            { onConflict: "pre_app_owner_id" },
          );
        if (error) {
          console.error(`[submit-pre-app-secrets] ssn write: ${error.message}`);
          return json({ error: "Could not store the SSN" }, 500);
        }
        stored.push({ kind: "owner_ssn", fields: ["ssn"] });
      }

      if (entry.kind === "banking") {
        const [routing, account] = await Promise.all([
          encryptSecret(
            key,
            entry.aba_routing,
            secretAad("pre_app_banking_secrets", "aba_routing_encrypted", entry.pre_app_id),
          ),
          encryptSecret(
            key,
            entry.account_number,
            secretAad("pre_app_banking_secrets", "account_number_encrypted", entry.pre_app_id),
          ),
        ]);
        const { error } = await ctx.supabaseAdmin
          .from("pre_app_banking_secrets")
          .upsert(
            {
              pre_app_id: entry.pre_app_id,
              aba_routing_encrypted: routing,
              account_number_encrypted: account,
              key_version: 1,
            },
            { onConflict: "pre_app_id" },
          );
        if (error) {
          console.error(`[submit-pre-app-secrets] banking write: ${error.message}`);
          return json({ error: "Could not store the banking details" }, 500);
        }
        stored.push({ kind: "banking", fields: ["aba_routing", "account_number"] });
      }

      if (entry.kind === "terminal") {
        const ciphertext = await encryptSecret(
          key,
          entry.rp_password,
          secretAad("pre_app_terminal_secrets", "rp_password_encrypted", entry.pre_app_id),
        );
        const { error } = await ctx.supabaseAdmin
          .from("pre_app_terminal_secrets")
          .upsert(
            {
              pre_app_id: entry.pre_app_id,
              rp_password_encrypted: ciphertext,
              key_version: 1,
            },
            { onConflict: "pre_app_id" },
          );
        if (error) {
          console.error(`[submit-pre-app-secrets] terminal write: ${error.message}`);
          return json({ error: "Could not store the terminal password" }, 500);
        }
        stored.push({ kind: "terminal", fields: ["rp_password"] });
      }
    }

    // actor_id is passed explicitly: a service-role connection has no
    // auth.uid(), so relying on the default would record NULL.
    await ctx.supabaseAdmin.from("audit_log").insert(
      stored.map((entry) => ({
        actor_id: userId,
        action: `submit_pre_app_secrets:${entry.kind}`,
        table_name: "pre_apps",
        row_id: String(preAppId),
      })),
    );

    // Reports what is on file. No plaintext, no ciphertext.
    return json({ ok: true, stored });
  }),
};
