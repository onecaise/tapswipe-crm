// Issues a new temporary password for an account and returns it to the calling
// admin, to be handed over out-of-band.
//
// verify_jwt = false in config.toml, so this function authenticates the caller
// itself — withSupabase({ auth: "user" }) rejects a missing or invalid JWT
// before the handler runs.
//
// What this deliberately cannot do:
//
//   - Reveal the rep's chosen password. Nothing can: GoTrue stores a bcrypt
//     hash, so there is no plaintext anywhere to return. This overwrites.
//   - Leave a password the admin knows in working order. It sets
//     must_change_password, so the rep is forced to replace it at next login
//     before reaching any CRM page.
//
// Returning the password rather than emailing a reset link is the pattern master
// plan §8 chose: Tapswipe's rep list is small and known, and the admin already
// has an out-of-band channel to the person. An email flow is a later upgrade,
// and would slot in here.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

import {
  callerIsActive,
  callerIsAdmin,
  generateTempPassword,
  isUuid,
  json,
  writeAudit,
} from "../_shared/admin-users.ts";

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    if (req.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    const actorId = ctx.userClaims?.id;
    if (!actorId) {
      return json({ error: "Not authenticated" }, 401);
    }

    if (!(await callerIsActive(ctx.supabase))) {
      return json({ error: "Account is not active" }, 403);
    }
    if (!(await callerIsAdmin(ctx.supabase))) {
      return json({ error: "Admin only" }, 403);
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Body must be JSON" }, 400);
    }

    const { user_id: userId } = body;
    if (!isUuid(userId)) {
      return json({ error: "user_id must be a uuid" }, 400);
    }

    // Through the caller-scoped client, so the database confirms the row exists
    // and is visible rather than this code assuming it.
    //
    // No self-target guard here, unlike deactivate-user: an admin resetting their
    // own password is harmless and occasionally useful (they will be prompted to
    // set a new one immediately), and it locks nobody out.
    const { data: target, error: lookupError } = await ctx.supabase
      .from("profiles")
      .select("id")
      .eq("id", userId)
      .maybeSingle();

    if (lookupError || !target) {
      return json({ error: "User not found" }, 404);
    }

    const temporaryPassword = generateTempPassword();

    // Authorization settled — service role from here.
    const { error: passwordError } =
      await ctx.supabaseAdmin.auth.admin.updateUserById(userId, {
        password: temporaryPassword,
      });

    if (passwordError) {
      return json(
        { error: `Could not reset the password: ${passwordError.message}` },
        500,
      );
    }

    // After the password change, not before. If this write fails the rep can
    // still log in with the temporary password — a working account with a
    // missing prompt. The other order would set the flag against a password that
    // was never actually changed.
    const { error: flagError } = await ctx.supabaseAdmin
      .from("profiles")
      .update({ must_change_password: true })
      .eq("id", userId);

    const auditError = await writeAudit(
      ctx.supabaseAdmin,
      actorId,
      "admin_reset_password",
      userId,
    );

    return json({
      user_id: userId,
      // Shown to the admin once and stored nowhere.
      temporary_password: temporaryPassword,
      // Both non-fatal: the password HAS been reset, so reporting failure would
      // be wrong. Surfaced so neither is silent.
      forcedChangeFlagFailed: flagError ? true : undefined,
      auditWriteFailed: auditError ? true : undefined,
    });
  }),
};

/* To invoke locally:

  1. Run `supabase start` and `supabase functions serve`
  2. Sign in as an admin to get an access token, then:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/admin-reset-password' \
    --header 'Authorization: Bearer <ADMIN_ACCESS_TOKEN>' \
    --header 'Content-Type: application/json' \
    --data '{"user_id":"<TARGET_USER_ID>"}'

  Expected: 200 with { user_id, temporary_password }
            404 if no such user
            403 if the caller is not an active admin
            401 if there is no valid JWT
*/
