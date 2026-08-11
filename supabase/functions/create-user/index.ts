// Creates a rep or admin account: the auth.users row, the matching profiles
// row, and a temporary password returned to the calling admin once.
//
// verify_jwt = false in config.toml, so this function authenticates the caller
// itself — withSupabase({ auth: "user" }) rejects a missing or invalid JWT
// before the handler runs.
//
// This is the only way an account gets created. Master plan §8: no public
// sign-up (enable_signup = false), because an auth.users row with no profiles
// row can log in, sees an app that is empty by design, and cannot self-heal —
// profiles has no insert policy for `authenticated`.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

import {
  callerIsActive,
  callerIsAdmin,
  generateTempPassword,
  isEmail,
  isFullName,
  isRole,
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

    const { full_name: fullName, email, role } = body;

    if (!isFullName(fullName)) {
      return json({ error: "full_name is required" }, 400);
    }
    if (!isEmail(email)) {
      return json({ error: "email must be a valid email address" }, 400);
    }
    if (!isRole(role)) {
      return json({ error: "role must be 'agent' or 'admin'" }, 400);
    }

    // Normalised so 'Rep@Tapswipe.com' and 'rep@tapswipe.com' cannot become two
    // accounts for one person — the access model depends on agent_id naming
    // exactly one human.
    const normalisedEmail = email.trim().toLowerCase();
    const temporaryPassword = generateTempPassword();

    // Authorization is settled, so the service role may be used now.
    //
    // email_confirm: true because there is no inbox step in this flow. The admin
    // hands the password over out-of-band (§8), so leaving the address
    // unconfirmed would block a login that is already authorised out of band.
    const { data: created, error: createError } =
      await ctx.supabaseAdmin.auth.admin.createUser({
        email: normalisedEmail,
        password: temporaryPassword,
        email_confirm: true,
      });

    if (createError || !created?.user) {
      const message = createError?.message ?? "unknown error";
      // GoTrue reports an existing address as a 422 with a message naming it.
      // 409 is the honest status, and worth distinguishing: "already registered"
      // is something the admin can act on, unlike a generic failure.
      const alreadyExists = /already|registered|exists/i.test(message);
      return json(
        {
          error: alreadyExists
            ? "A user with that email already exists"
            : `Could not create the account: ${message}`,
        },
        alreadyExists ? 409 : 500,
      );
    }

    const newUserId = created.user.id;

    const { error: profileError } = await ctx.supabaseAdmin
      .from("profiles")
      .insert({
        id: newUserId,
        full_name: (fullName as string).trim(),
        role,
        is_active: true,
        // Forces the rep to replace the password the admin knows. The (app)
        // layout redirects to /auth/update-password while this is set.
        must_change_password: true,
      });

    if (profileError) {
      // Roll the auth user back. Without this the account exists, can log in,
      // and lands on /auth/error?error=no-profile forever — the ghost-user state
      // lib/auth.ts routes, which nothing in the app can repair because profiles
      // has no insert policy. A failed create must leave nothing behind.
      const { error: cleanupError } =
        await ctx.supabaseAdmin.auth.admin.deleteUser(newUserId);

      return json(
        {
          error: `Could not create the profile: ${profileError.message}`,
          // Surfaced rather than swallowed: if the rollback itself failed there
          // IS now an orphan auth user, and whoever reads this needs to know.
          orphanedAuthUser: cleanupError ? newUserId : undefined,
        },
        500,
      );
    }

    const auditError = await writeAudit(
      ctx.supabaseAdmin,
      actorId,
      "create_user",
      newUserId,
    );

    return json(
      {
        user_id: newUserId,
        email: normalisedEmail,
        // Returned exactly once and stored nowhere. The admin passes it to the
        // rep out-of-band; first login forces a replacement.
        temporary_password: temporaryPassword,
        // Non-fatal: the account exists either way, and reporting failure for an
        // action that succeeded would be the worse lie. Surfaced so it is not
        // silent.
        auditWriteFailed: auditError ? true : undefined,
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
    --data '{"full_name":"New Rep","email":"rep@tapswipe.test","role":"agent"}'

  Expected: 201 with { user_id, email, temporary_password }
            409 if that email already has an account
            403 if the caller is not an active admin
            401 if there is no valid JWT
*/
