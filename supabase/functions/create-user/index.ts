// Creates a rep or admin account: the auth.users row, the matching profiles
// row, and a temporary password returned to the calling admin once.
//
// verify_jwt = false in config.toml, so this function authenticates the caller
// itself — withSupabase({ auth: "user" }) rejects a missing or invalid JWT
// before the handler runs.
//
// This is the only way a single account gets created. Master plan §8: no public
// sign-up (enable_signup = false), because an auth.users row with no profiles
// row can log in, sees an app that is empty by design, and cannot self-heal —
// profiles has no insert policy for `authenticated`.
//
// THE ACCOUNT-CREATION LOGIC ITSELF LIVES IN _shared/provision-user.ts, and this
// file is the HTTP wrapper over it: authenticate, authorize, validate the body,
// call provisionUser, map its result to a status code. The extraction happened
// when the bulk rep import needed the same logic per row — in particular the
// resume path, which is the one piece of this worth never having two copies of.
// Everything that file does, and why, is documented there.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

import {
  callerIsActive,
  callerIsAdmin,
  isAgentNumber,
  isEmail,
  isFullName,
  isRole,
  json,
} from "../_shared/admin-users.ts";
import {
  normalizeAgentNumber,
  provisionUser,
} from "../_shared/provision-user.ts";

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    if (req.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    const actorId = ctx.userClaims?.id;
    if (!actorId) {
      return json({ error: "Not authenticated" }, 401);
    }

    // Authorization before anything else, and both checks through the
    // caller-scoped client so the database decides. callerIsActive first so a
    // deactivated admin gets an accurate reason rather than "admin only".
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

    const {
      full_name: fullName,
      email,
      role,
      agent_number: agentNumber,
    } = body;

    if (!isFullName(fullName)) {
      return json({ error: "full_name is required" }, 400);
    }
    if (!isEmail(email)) {
      return json({ error: "email must be a valid email address" }, 400);
    }
    if (!isRole(role)) {
      return json({ error: "role must be 'agent' or 'admin'" }, 400);
    }

    // Optional, and absent is the norm. normalizeAgentNumber is shared with the
    // bulk import so the two paths cannot disagree about what a blank cell means.
    const normalisedAgentNumber = normalizeAgentNumber(agentNumber);

    if (
      normalisedAgentNumber !== null &&
      !isAgentNumber(normalisedAgentNumber)
    ) {
      return json(
        { error: "agent_number must be 32 characters or fewer" },
        400,
      );
    }

    const result = await provisionUser(ctx.supabase, ctx.supabaseAdmin, actorId, {
      fullName,
      email,
      role,
      agentNumber: normalisedAgentNumber,
    });

    if (result.outcome === "conflict") {
      return json({ error: result.message }, 409);
    }

    if (result.outcome === "failed") {
      return json(
        {
          error: result.message,
          orphanedAuthUser: result.orphanedAuthUser,
        },
        result.status,
      );
    }

    return json(
      {
        user_id: result.userId,
        email: result.email,
        // Returned exactly once and stored nowhere. The admin passes it to the
        // rep out-of-band; first login forces a replacement.
        temporary_password: result.temporaryPassword,
        // Set when this call adopted a leftover auth.users row rather than
        // creating one. The account is complete and the password above is live
        // either way — this is here so an address the admin was just told
        // already existed does not appear to have gone through by magic, and so
        // the state is visible rather than silently absorbed.
        //
        // undefined rather than false so the key is dropped from the JSON, which
        // is what the response has always looked like on the ordinary path.
        resumedOrphanedAuthUser: result.outcome === "resumed" ? true : undefined,
        auditWriteFailed: result.auditWriteFailed ? true : undefined,
      },
      201,
    );
  }),
};

/* To invoke locally:

  1. Run `supabase start` and `supabase functions serve`
  2. Sign in as an admin to get an access token, then:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/create-user' \
    --header 'Authorization: Bearer <ADMIN_ACCESS_TOKEN>' \
    --header 'Content-Type: application/json' \
    --data '{"full_name":"New Rep","email":"rep@tapswipe.test","role":"agent","agent_number":"4471"}'

  agent_number is optional; omit it, or send "" / null, for a rep with none.

  Expected: 201 with { user_id, email, temporary_password }
            201 with resumedOrphanedAuthUser: true if that email had an
                auth.users row but no profiles row — an interrupted earlier
                attempt, finished rather than refused, with a fresh password
            409 if that email already has a complete account
            409 if that agent number belongs to another rep
            403 if the caller is not an active admin
            401 if there is no valid JWT
*/
