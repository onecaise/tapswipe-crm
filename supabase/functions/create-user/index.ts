// Creates a rep or admin account: the auth.users row, the matching profiles
// row, and the one-time password the calling admin chose for it.
//
// THE ADMIN SUPPLIES THAT PASSWORD, and this function does not generate one.
// That is the opposite arrangement to provision-user-batch, on purpose and not
// by oversight: there, forty accounts are created with nobody standing over each
// row, so the generated password is discarded unread and no credential surfaces
// anywhere. Here one admin is typing one password for one person they are about
// to ring up, so the password is theirs to know — it arrives in the request body
// and is echoed back in the response. must_change_password is still set, so it
// buys exactly one sign-in either way.
//
// It is validated here as well as in the form, because the form is not a
// boundary — anyone with an admin session can POST to this URL. MIN_PASSWORD_LENGTH
// in _shared/admin-users.ts is the rule, mirrored from lib/passwords.ts.
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
  MIN_PASSWORD_LENGTH,
  callerIsActive,
  callerIsAdmin,
  isAcceptablePassword,
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
      password,
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
    // Required, and checked before anything is created. The form enforces the
    // same rule, which is a courtesy rather than the boundary — this is the
    // check that cannot be skipped by posting to the URL directly.
    if (!isAcceptablePassword(password)) {
      return json(
        {
          error:
            `password is required and must be at least ${MIN_PASSWORD_LENGTH} ` +
            `characters`,
        },
        400,
      );
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
      // Passed through exactly as typed. provisionUser falls back to a generated
      // password when this is absent, which is the batch caller's path and not
      // one this function ever takes.
      password,
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
        // The password the account can actually sign in with — the one the admin
        // just typed, on both the created and the resumed path (the resume resets
        // the adopted row to it). Echoed back rather than dropped so the success
        // screen can state what was set without the form having to hold it, and
        // so "this finished a half-created account" comes with the password that
        // is now live on it. Stored nowhere; first login forces a replacement.
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
    --data '{"full_name":"New Rep","email":"rep@tapswipe.test","role":"agent","password":"hand-this-over","agent_number":"4471"}'

  agent_number is optional; omit it, or send "" / null, for a rep with none.
  password is REQUIRED, and is the account's first password.

  Expected: 201 with { user_id, email, temporary_password }
            400 if password is missing or shorter than MIN_PASSWORD_LENGTH
            201 with resumedOrphanedAuthUser: true if that email had an
                auth.users row but no profiles row — an interrupted earlier
                attempt, finished rather than refused, with a fresh password
            409 if that email already has a complete account
            409 if that agent number belongs to another rep
            403 if the caller is not an active admin
            401 if there is no valid JWT
*/

