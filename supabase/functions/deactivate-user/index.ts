// Switches an account off or back on, at BOTH layers.
//
// verify_jwt = false in config.toml, so this function authenticates the caller
// itself — withSupabase({ auth: "user" }) rejects a missing or invalid JWT
// before the handler runs.
//
// Two layers, because either alone leaves a hole:
//
//   - profiles.is_active = false is what RLS reads. Every policy's own-row
//     branch is gated on is_active_agent(), so this removes access to data
//     immediately, including for a token already in a browser.
//   - banned_until on auth.users is what GoTrue reads. Without it a deactivated
//     rep can still authenticate successfully — they would get a valid session
//     against an app with no rows in it, which looks like a bug rather than a
//     revoked account.
//
// Neither layer invalidates an access token that has already been issued; see
// the longer note at the end of the handler for why RLS is what makes that
// window harmless rather than merely short.
//
// Master plan §8 is explicit that this is deactivation and never deletion: a rep
// who leaves still has agent_id on real historical deals and residuals.
//
// Handles reactivation too, via `is_active`. Splitting that into a fourth
// function would duplicate this one's guards and its unban call to no purpose.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

import {
  PERMANENT_BAN_DURATION,
  callerIsActive,
  callerIsAdmin,
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

    const { user_id: userId, is_active: isActive } = body;

    if (!isUuid(userId)) {
      return json({ error: "user_id must be a uuid" }, 400);
    }
    if (typeof isActive !== "boolean") {
      return json({ error: "is_active must be a boolean" }, 400);
    }

    // The guard that makes zero active admins unreachable. An admin switching
    // their own account off would lose the screen they are standing on
    // mid-session, and if they were the only admin nobody could switch it back —
    // recovery would be hand-written SQL in the dashboard.
    if (userId === actorId) {
      return json(
        { error: "You cannot change your own account's active state" },
        409,
      );
    }

    // Read through the caller-scoped client: the profiles select policy is
    // `id = auth.uid() or is_admin()`, and the caller is a confirmed admin, so
    // this both finds the row and keeps the visibility decision in the database.
    const { data: target, error: lookupError } = await ctx.supabase
      .from("profiles")
      .select("id, full_name, role, is_active")
      .eq("id", userId)
      .maybeSingle();

    if (lookupError || !target) {
      return json({ error: "User not found" }, 404);
    }

    // Authorization settled — service role from here.
    //
    // Auth layer FIRST, then the flag. The order decides which way a partial
    // failure fails: ban-then-flag leaves the account locked but displaying as
    // active, which is visible and safe. Flag-then-ban would leave it displaying
    // as deactivated while login still worked, which is invisible and not.
    const { error: banError } =
      await ctx.supabaseAdmin.auth.admin.updateUserById(userId, {
        ban_duration: isActive ? "none" : PERMANENT_BAN_DURATION,
      });

    if (banError) {
      return json(
        { error: `Could not update the account at the auth layer: ${banError.message}` },
        500,
      );
    }

    const { error: profileError } = await ctx.supabaseAdmin
      .from("profiles")
      .update({ is_active: isActive })
      .eq("id", userId);

    if (profileError) {
      return json(
        {
          error: `Auth layer updated but the profile flag did not: ${profileError.message}`,
          // Named explicitly because the two layers now disagree, and which way
          // they disagree determines how urgent it is.
          authLayerUpdated: true,
        },
        500,
      );
    }

    // On the lifetime of an already-issued token, since "blocked at the auth
    // layer" is easy to over-read:
    //
    // The ban takes effect immediately for sign-in and for token refresh, so a
    // deactivated rep cannot log in and cannot extend a session. It does NOT
    // invalidate an access token already in a browser — that stays syntactically
    // valid until it expires, up to an hour.
    //
    // RLS is what makes that window harmless rather than merely short: every
    // policy's own-row branch is gated on is_active_agent(), which is false the
    // moment the flag above is written, so the lingering token can read and write
    // nothing. This is exactly why master plan §5 insists the own-row branch
    // carries that check instead of trusting agent_id alone.
    //
    // There is deliberately no session-revocation call here. auth-js exposes
    // admin.signOut(jwt, scope), which needs the target's own access token — an
    // admin acting on someone else does not have it. Passing a user id there
    // compiles and silently does nothing, which would be worse than not calling
    // it: code that looks like it revokes sessions and doesn't.

    const auditError = await writeAudit(
      ctx.supabaseAdmin,
      actorId,
      isActive ? "reactivate_user" : "deactivate_user",
      userId,
    );

    return json({
      user_id: userId,
      is_active: isActive,
      auditWriteFailed: auditError ? true : undefined,
    });
  }),
};

/* To invoke locally:

  1. Run `supabase start` and `supabase functions serve`
  2. Sign in as an admin to get an access token, then:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/deactivate-user' \
    --header 'Authorization: Bearer <ADMIN_ACCESS_TOKEN>' \
    --header 'Content-Type: application/json' \
    --data '{"user_id":"<TARGET_USER_ID>","is_active":false}'

  Expected: 200 with { user_id, is_active }
            409 if the target is the caller
            404 if no such user
            403 if the caller is not an active admin
            401 if there is no valid JWT

  Then confirm the point of the whole function — a correct password no longer
  works:

  curl -i --location --request POST 'http://127.0.0.1:54321/auth/v1/token?grant_type=password' \
    --header 'apiKey: <PUBLISHABLE_KEY>' \
    --header 'Content-Type: application/json' \
    --data '{"email":"<TARGET_EMAIL>","password":"<CORRECT_PASSWORD>"}'
*/
