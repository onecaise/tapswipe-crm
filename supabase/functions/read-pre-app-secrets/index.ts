// Reads the encrypted pre-app secrets back, decrypting only for an admin.
//
// Two tiers:
//   admin        -> full plaintext
//   owning agent -> last four of the SSN and account/routing numbers, and mere
//                   presence for the RP password
//
// The RP password is presence-only on purpose, refining the "agent gets last-4"
// rule: four digits of an account number is a reasonable disclosure, four
// characters of a password removes most of its entropy for anyone who also knows
// the vendor's password rules.
//
// POST rather than GET, so the pre-app id never lands in a URL or an access log.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

import { callerIsActive, isPositiveInt, json } from "../_shared/documents.ts";
import {
  cachedSecretsKey,
  decryptSecret,
  last4,
  secretAad,
  SecretsKeyError,
} from "../_shared/crypto.ts";
import { getSecretsKeyEnv } from "../_shared/secrets-env.ts";
import { callerIsAdmin } from "../_shared/pre-app-secrets.ts";

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    if (req.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    const userId = ctx.userClaims?.id;
    if (!userId) {
      return json({ error: "Not authenticated" }, 401);
    }

    let key: CryptoKey;
    try {
      key = await cachedSecretsKey(getSecretsKeyEnv());
    } catch (err) {
      if (err instanceof SecretsKeyError) {
        console.error(`[read-pre-app-secrets] ${err.message}`);
        return json({ error: "Secrets encryption is not configured" }, 500);
      }
      throw err;
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Body must be JSON" }, 400);
    }

    const preAppId = body.pre_app_id;
    if (!isPositiveInt(preAppId)) {
      return json({ error: "pre_app_id must be a positive integer" }, 400);
    }

    if (!(await callerIsActive(ctx.supabase))) {
      return json({ error: "Account is not active" }, 403);
    }

    // Through the caller's client, so RLS answers. Absent and not-yours are the
    // same 404.
    const { data: preApp } = await ctx.supabase
      .from("pre_apps")
      .select("id")
      .eq("id", preAppId)
      .maybeSingle();
    if (!preApp) return json({ error: "Pre-app not found" }, 404);

    const isAdmin = await callerIsAdmin(ctx.supabase);

    // Written BEFORE decrypting. If the audit insert fails, nothing is decrypted
    // and the caller gets a 500: an audit outage blocking reads is the right
    // trade for this data, whereas plaintext returned with no trail is not.
    const { error: auditError } = await ctx.supabaseAdmin
      .from("audit_log")
      .insert({
        actor_id: userId,
        action: `read_pre_app_secrets:${isAdmin ? "full" : "last4"}`,
        table_name: "pre_apps",
        row_id: String(preAppId),
      });
    if (auditError) {
      console.error(`[read-pre-app-secrets] audit write: ${auditError.message}`);
      return json({ error: "Could not record the access" }, 500);
    }

    // supabaseAdmin is the only path into these tables.
    const [{ data: ownerRows }, { data: banking }, { data: terminal }] =
      await Promise.all([
        ctx.supabaseAdmin
          .from("pre_app_owners")
          .select("id, owner_name, pre_app_owner_secrets(ssn_encrypted)")
          .eq("pre_app_id", preAppId)
          .order("id"),
        ctx.supabaseAdmin
          .from("pre_app_banking_secrets")
          .select("aba_routing_encrypted, account_number_encrypted")
          .eq("pre_app_id", preAppId)
          .maybeSingle(),
        ctx.supabaseAdmin
          .from("pre_app_terminal_secrets")
          .select("rp_password_encrypted")
          .eq("pre_app_id", preAppId)
          .maybeSingle(),
      ]);

    const owners = [];
    for (const row of (ownerRows ?? []) as Record<string, unknown>[]) {
      const secret = row.pre_app_owner_secrets as
        | { ssn_encrypted: string }
        | null;
      if (!secret) {
        owners.push({
          pre_app_owner_id: row.id,
          owner_name: row.owner_name,
          ssn_on_file: false,
        });
        continue;
      }
      const ssn = await decryptSecret(
        key,
        secret.ssn_encrypted,
        secretAad("pre_app_owner_secrets", "ssn_encrypted", row.id as number),
      );
      owners.push({
        pre_app_owner_id: row.id,
        owner_name: row.owner_name,
        ssn_on_file: true,
        ...(isAdmin ? { ssn } : { ssn_last4: last4(ssn) }),
      });
    }

    let bankingOut: Record<string, unknown> = { on_file: false };
    if (banking) {
      const [routing, account] = await Promise.all([
        decryptSecret(
          key,
          (banking as Record<string, string>).aba_routing_encrypted,
          secretAad("pre_app_banking_secrets", "aba_routing_encrypted", preAppId),
        ),
        decryptSecret(
          key,
          (banking as Record<string, string>).account_number_encrypted,
          secretAad("pre_app_banking_secrets", "account_number_encrypted", preAppId),
        ),
      ]);
      bankingOut = isAdmin
        ? { on_file: true, aba_routing: routing, account_number: account }
        : {
            on_file: true,
            aba_routing_last4: last4(routing),
            account_number_last4: last4(account),
          };
    }

    let terminalOut: Record<string, unknown> = { on_file: false };
    if (terminal) {
      if (isAdmin) {
        const password = await decryptSecret(
          key,
          (terminal as Record<string, string>).rp_password_encrypted,
          secretAad("pre_app_terminal_secrets", "rp_password_encrypted", preAppId),
        );
        terminalOut = { on_file: true, rp_password: password };
      } else {
        // Presence only — not even a suffix. See the header.
        terminalOut = { on_file: true };
      }
    }

    return new Response(
      JSON.stringify({
        tier: isAdmin ? "full" : "last4",
        owners,
        banking: bankingOut,
        terminal: terminalOut,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          // Decrypted values must not sit in a shared cache or the browser's
          // disk cache.
          "Cache-Control": "no-store",
        },
      },
    );
  }),
};
