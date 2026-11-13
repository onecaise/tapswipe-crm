// Reads the encrypted pre-app secrets back.
//
// Two kinds of request (phase 5 of docs/design/intake-and-reports.md, A24):
//
//   default read   { pre_app_id }
//     EVERY caller -- rep and admin alike -- gets the last four of the SSNs,
//     the account/routing numbers and the business tax ID (with its kind, EIN
//     or SSN), and mere presence for the RP password. Audited as
//     read_pre_app_secrets:last4. No full value is in this response for anyone.
//
//   reveal         { pre_app_id, reveal: { field, pre_app_owner_id? } }
//     Admin only (a rep gets 403 before any record is looked up). Returns the
//     full value of that ONE field. record_pre_app_secret_reveal() writes the
//     audit row naming the admin, the pre-app and the field, and enforces 30
//     reveals per admin per hour; the value is decrypted only after it has
//     returned, so a failed audit write returns nothing (500).
//
// The RP password is presence-only on the default read on purpose, refining the
// "last-4" rule: four digits of an account number is a reasonable disclosure,
// four characters of a password removes most of its entropy for anyone who also
// knows the vendor's password rules.
//
// POST rather than GET, so the pre-app id and the field never land in a URL or
// an access log. Nothing here logs a value.

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
import {
  callerIsAdmin,
  parseRevealRequest,
  type RevealRequest,
} from "../_shared/pre-app-secrets.ts";

/** Decrypted values must not sit in a shared cache or the browser's disk cache. */
function noStore(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

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
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return json({ error: "Body must be a JSON object" }, 400);
    }

    const preAppId = body.pre_app_id;
    if (!isPositiveInt(preAppId)) {
      return json({ error: "pre_app_id must be a positive integer" }, 400);
    }
    const parsedReveal = parseRevealRequest(body);
    if (!parsedReveal.ok) {
      return json({ error: parsedReveal.error }, 400);
    }
    const reveal = parsedReveal.reveal;

    if (!(await callerIsActive(ctx.supabase))) {
      return json({ error: "Account is not active" }, 403);
    }

    // The role check comes before any record is looked up, so a rep asking to
    // reveal learns nothing about which pre-app ids exist: every such request
    // is the same 403.
    if (reveal && !(await callerIsAdmin(ctx.supabase))) {
      return json({ error: "Only an admin can reveal a full value" }, 403);
    }

    // Through the caller's client, so RLS answers. Absent and not-yours are the
    // same 404.
    const { data: preApp } = await ctx.supabase
      .from("pre_apps")
      .select("id")
      .eq("id", preAppId)
      .maybeSingle();
    if (!preApp) return json({ error: "Pre-app not found" }, 404);

    if (reveal) {
      return await revealOne(preAppId, reveal);
    }

    // Written BEFORE decrypting. If the audit insert fails, nothing is decrypted
    // and the caller gets a 500: an audit outage blocking reads is the right
    // trade for this data, whereas values returned with no trail are not.
    const { error: auditError } = await ctx.supabaseAdmin
      .from("audit_log")
      .insert({
        actor_id: userId,
        action: "read_pre_app_secrets:last4",
        table_name: "pre_apps",
        row_id: String(preAppId),
      });
    if (auditError) {
      console.error(`[read-pre-app-secrets] audit write: ${auditError.message}`);
      return json({ error: "Could not record the access" }, 500);
    }

    // supabaseAdmin is the only path into these tables.
    const [
      { data: ownerRows },
      { data: banking },
      { data: terminal },
      { data: taxRow },
    ] =
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
        // Presence only: the password is never decrypted for a default read.
        ctx.supabaseAdmin
          .from("pre_app_terminal_secrets")
          .select("pre_app_id")
          .eq("pre_app_id", preAppId)
          .maybeSingle(),
        ctx.supabaseAdmin
          .from("pre_app_tax_secrets")
          .select("tax_id_type, tax_id_encrypted")
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
        ssn_last4: last4(ssn),
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
      bankingOut = {
        on_file: true,
        aba_routing_last4: last4(routing),
        account_number_last4: last4(account),
      };
    }

    // Presence only — not even a suffix. See the header.
    const terminalOut = { on_file: Boolean(terminal) };

    // The business tax ID: same tier as an SSN. tax_id_type is the stored
    // row's kind; the wizard compares it with the pre-app's current ein_type
    // and asks for the number again when they differ.
    let taxIdOut: Record<string, unknown> = { on_file: false };
    if (taxRow) {
      const row = taxRow as Record<string, string>;
      const taxId = await decryptSecret(
        key,
        row.tax_id_encrypted,
        secretAad("pre_app_tax_secrets", "tax_id_encrypted", preAppId),
      );
      taxIdOut = { on_file: true, tax_id_type: row.tax_id_type, tax_id_last4: last4(taxId) };
    }

    return noStore({
      tier: "last4",
      owners,
      banking: bankingOut,
      terminal: terminalOut,
      tax_id: taxIdOut,
    });

    /**
     * One field, in full, for an admin whose role and access to the pre-app are
     * already settled. Order: the owner (caller-scoped) → the ciphertext's
     * existence (service role, nothing decrypted) → the audit row and rate limit
     * (caller-scoped RPC, so auth.uid() is the admin) → only then decrypt.
     */
    async function revealOne(
      preAppId: number,
      reveal: RevealRequest,
    ): Promise<Response> {
      if (reveal.field === "owner_ssn") {
        const { data: ownerRow } = await ctx.supabase
          .from("pre_app_owners")
          .select("id")
          .eq("id", reveal.pre_app_owner_id)
          .eq("pre_app_id", preAppId)
          .maybeSingle();
        if (!ownerRow) return json({ error: "Pre-app not found" }, 404);
      }

      const located = await locateCiphertext(preAppId, reveal);
      if (!located) return json({ error: "Not on file" }, 404);

      const { error: auditError } = await ctx.supabase.rpc("record_pre_app_secret_reveal", {
        pre_app_id_input: preAppId,
        field_input: reveal.field,
        pre_app_owner_id_input: reveal.field === "owner_ssn" ? reveal.pre_app_owner_id : null,
      });
      if (auditError) {
        const code = (auditError as { code?: string }).code;
        if (code === "PT429") {
          // The function's own sentence ("…limit of 30 reveals an hour…"); it
          // names no value.
          return json({ error: auditError.message }, 429);
        }
        console.error(`[read-pre-app-secrets] reveal audit: ${code ?? "unknown"}`);
        return json({ error: "Could not record the access" }, 500);
      }

      const value = await decryptSecret(key, located.ciphertext, located.aad);
      return noStore({
        field: reveal.field,
        ...(reveal.field === "owner_ssn" ? { pre_app_owner_id: reveal.pre_app_owner_id } : {}),
        ...(located.taxIdType ? { tax_id_type: located.taxIdType } : {}),
        value,
      });
    }

    /** The one ciphertext a reveal names, or null when it is not on file. */
    async function locateCiphertext(
      preAppId: number,
      reveal: RevealRequest,
    ): Promise<{ ciphertext: string; aad: string; taxIdType?: string } | null> {
      const admin = ctx.supabaseAdmin;
      switch (reveal.field) {
        case "owner_ssn": {
          const { data } = await admin
            .from("pre_app_owner_secrets")
            .select("ssn_encrypted")
            .eq("pre_app_owner_id", reveal.pre_app_owner_id)
            .maybeSingle();
          if (!data) return null;
          return {
            ciphertext: (data as Record<string, string>).ssn_encrypted,
            aad: secretAad("pre_app_owner_secrets", "ssn_encrypted", reveal.pre_app_owner_id),
          };
        }
        case "aba_routing":
        case "account_number": {
          const column = reveal.field === "aba_routing"
            ? "aba_routing_encrypted"
            : "account_number_encrypted";
          const { data } = await admin
            .from("pre_app_banking_secrets")
            .select(column)
            .eq("pre_app_id", preAppId)
            .maybeSingle();
          if (!data) return null;
          return {
            ciphertext: (data as Record<string, string>)[column],
            aad: secretAad("pre_app_banking_secrets", column, preAppId),
          };
        }
        case "rp_password": {
          const { data } = await admin
            .from("pre_app_terminal_secrets")
            .select("rp_password_encrypted")
            .eq("pre_app_id", preAppId)
            .maybeSingle();
          if (!data) return null;
          return {
            ciphertext: (data as Record<string, string>).rp_password_encrypted,
            aad: secretAad("pre_app_terminal_secrets", "rp_password_encrypted", preAppId),
          };
        }
        case "tax_id": {
          const { data } = await admin
            .from("pre_app_tax_secrets")
            .select("tax_id_type, tax_id_encrypted")
            .eq("pre_app_id", preAppId)
            .maybeSingle();
          if (!data) return null;
          const row = data as Record<string, string>;
          return {
            ciphertext: row.tax_id_encrypted,
            aad: secretAad("pre_app_tax_secrets", "tax_id_encrypted", preAppId),
            taxIdType: row.tax_id_type,
          };
        }
      }
    }
  }),
};
