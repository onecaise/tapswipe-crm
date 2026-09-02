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
//
// The two writes are not one transaction — they cannot be, one is in GoTrue and
// one is in Postgres — so the half-created account is handled from both ends:
// a profiles insert that fails deletes the auth.users row it just made, and a
// call for an address that already has an auth.users row with no profiles row
// adopts it instead of refusing. The second is what covers the case the first
// cannot see, where the process dies between the two writes and no rollback
// ever runs. Retrying create-user is therefore always safe, and is the cure.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

import {
  callerIsActive,
  callerIsAdmin,
  findAuthUserByEmail,
  generateTempPassword,
  isAgentNumber,
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

    // Optional, and absent is the norm: a rep can be created before anyone knows
    // what the processor will call them. Blank and whitespace are treated as
    // absent rather than stored, because '' is a value the partial unique index
    // on profiles.agent_number enforces — the second rep created with an empty
    // field would collide with the first.
    const normalisedAgentNumber =
      typeof agentNumber === "string" && agentNumber.trim() !== ""
        ? agentNumber.trim()
        : null;

    if (
      normalisedAgentNumber !== null &&
      !isAgentNumber(normalisedAgentNumber)
    ) {
      return json(
        { error: "agent_number must be 32 characters or fewer" },
        400,
      );
    }

    // Normalised so 'Rep@Tapswipe.com' and 'rep@tapswipe.com' cannot become two
    // accounts for one person — the access model depends on agent_id naming
    // exactly one human.
    const normalisedEmail = email.trim().toLowerCase();
    const temporaryPassword = generateTempPassword();

    // Checked BEFORE createUser, deliberately.
    //
    // The unique index is the real authority and would catch this anyway — but it
    // would catch it on the profiles insert, i.e. after the auth.users row
    // exists, sending a duplicate agent number down the rollback path and
    // reporting it as "Could not create the profile: duplicate key value violates
    // unique constraint …". That is a fixable mistake dressed as an internal
    // failure. Failing here costs one query and says what is wrong.
    //
    // Through the caller-scoped client, so RLS is still what decides what is
    // readable. Safe as a completeness check only because the caller is already
    // a verified active admin and admins see every profiles row; the index, not
    // this query, is what closes the race.
    if (normalisedAgentNumber !== null) {
      const { data: clash, error: clashError } = await ctx.supabase
        .from("profiles")
        .select("id")
        .eq("agent_number", normalisedAgentNumber)
        .maybeSingle();

      if (clashError) {
        return json(
          { error: `Could not check the agent number: ${clashError.message}` },
          500,
        );
      }
      if (clash) {
        return json(
          {
            error: `Agent # ${normalisedAgentNumber} is already assigned to another rep`,
          },
          409,
        );
      }
    }

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

    // The id the profiles row will hang off — created just now, or adopted from
    // an attempt that died half-way. `resumed` only changes what gets audited
    // and what the response says; the profiles insert below is identical.
    let newUserId: string;
    let storedEmail: string | null;
    let resumed = false;

    if (createError || !created?.user) {
      const message = createError?.message ?? "unknown error";
      const alreadyExists = /already|registered|exists/i.test(message);

      if (!alreadyExists) {
        return json({ error: `Could not create the account: ${message}` }, 500);
      }

      // "Already registered" has two causes that need opposite answers, and
      // returning 409 to both is what makes a half-created account permanent.
      //
      // One: an ordinary duplicate. The address belongs to an account that has
      // its profiles row, so it is a real account. 409, and the admin can act on
      // it — that is the case the live suite pins.
      //
      // Two: the auth.users row is a leftover. The rollback below fires only for
      // a profiles insert that *returns* an error; nothing fires when the
      // process itself is gone — a function timeout, an isolate recycled
      // mid-request, a redeploy, a dropped connection between the two calls. The
      // leftover can log in, lands on /auth/error?error=no-profile, and cannot
      // self-heal because profiles has no insert policy for `authenticated`. If
      // the retry answers "already exists" as well, nothing inside the app can
      // repair it — it needs someone in the dashboard.
      //
      // So tell them apart and adopt the leftover. That makes retrying
      // create-user the cure for a half-created account, which is what closes
      // the window the rollback cannot reach: the two writes still are not one
      // transaction, but the outcome is no longer an orphaned login either way.
      const lookup = await findAuthUserByEmail(
        ctx.supabaseAdmin,
        normalisedEmail,
      );

      // A failed lookup is not evidence of anything. Report the original
      // conflict rather than guessing, because the alternative — treating "we
      // could not check" as "there is no profile" — would take the adopt path
      // against a live account and reset a working rep's password.
      if (!lookup.ok) {
        return json(
          {
            error:
              `A user with that email already exists, and checking whether it ` +
              `has a profile failed: ${lookup.error}`,
          },
          409,
        );
      }

      // GoTrue says the address is taken but no row carries it. Nothing sane
      // produces this; do not go down either path on a contradiction.
      if (!lookup.user) {
        return json(
          {
            error:
              "A user with that email already exists, but it could not be " +
              "found to check. Try again, and check the Auth dashboard if it " +
              "persists.",
          },
          409,
        );
      }

      const { data: existingProfile, error: existingProfileError } =
        await ctx.supabaseAdmin
          .from("profiles")
          .select("id")
          .eq("id", lookup.user.id)
          .maybeSingle();

      // Same fail-closed reasoning as the lookup above.
      if (existingProfileError) {
        return json(
          {
            error:
              `A user with that email already exists, and checking whether it ` +
              `has a profile failed: ${existingProfileError.message}`,
          },
          409,
        );
      }

      if (existingProfile) {
        return json({ error: "A user with that email already exists" }, 409);
      }

      // An auth.users row with no profiles row. Adopt it.
      //
      // The password has to be reset, not reused: whatever the interrupted
      // attempt set was generated in a process that died before returning it, so
      // nobody has ever seen it. Returning a fresh one is the only way the
      // response can be true. email_confirm is re-asserted for the same reason —
      // the leftover may predate the confirmation.
      const { error: adoptError } =
        await ctx.supabaseAdmin.auth.admin.updateUserById(lookup.user.id, {
          password: temporaryPassword,
          email_confirm: true,
        });

      if (adoptError) {
        return json(
          {
            error:
              `An account for that email exists with no profile, and resetting ` +
              `its password failed: ${adoptError.message}`,
            orphanedAuthUser: lookup.user.id,
          },
          500,
        );
      }

      newUserId = lookup.user.id;
      storedEmail = lookup.user.email ?? null;
      resumed = true;
    } else {
      newUserId = created.user.id;
      // Denormalised copy of auth.users.email, which stays the authority.
      // Manage Users cannot read auth.users — nothing at the Data API can — so
      // without this the page has no way to tell two reps with the same name
      // apart. Taken from `created.user` rather than the request body so it
      // matches what GoTrue actually stored, normalisation included.
      storedEmail = created.user.email ?? null;
    }

    const { error: profileError } = await ctx.supabaseAdmin
      .from("profiles")
      .insert({
        id: newUserId,
        full_name: (fullName as string).trim(),
        email: storedEmail,
        // The join to a processor's residual report (RESIDUALS_SPEC §3.1). Null
        // is the ordinary case — it is filled in later from Manage Users or from
        // the import review screen, whichever comes first.
        agent_number: normalisedAgentNumber,
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
      //
      // Only for a row this request created. On the resume path the auth.users
      // row predates the request, and deleting it would turn a transient
      // profiles error into the silent destruction of an account somebody may
      // have deliberately made in the dashboard — well outside what "create a
      // user" was asked to do. It stays an orphan, and it stays adoptable: the
      // next retry runs this same path again.
      const cleanupError = resumed
        ? null
        : (await ctx.supabaseAdmin.auth.admin.deleteUser(newUserId)).error;

      return json(
        {
          error: resumed
            ? `An account for that email exists with no profile, and creating ` +
              `the profile failed again: ${profileError.message}. Retrying is ` +
              `safe — it resumes from the same account.`
            : `Could not create the profile: ${profileError.message}`,
          // Surfaced rather than swallowed: if the rollback itself failed there
          // IS now an orphan auth user, and whoever reads this needs to know.
          orphanedAuthUser: resumed || cleanupError ? newUserId : undefined,
        },
        500,
      );
    }

    const auditError = await writeAudit(
      ctx.supabaseAdmin,
      actorId,
      // A distinct verb, because audit_log has no detail column and the two are
      // not the same event: one made an account, the other finished one a
      // previous attempt left half-built. Recording them identically would hide
      // every occurrence of the failure this path exists for.
      resumed ? "resume_create_user" : "create_user",
      newUserId,
    );

    return json(
      {
        user_id: newUserId,
        email: normalisedEmail,
        // Returned exactly once and stored nowhere. The admin passes it to the
        // rep out-of-band; first login forces a replacement.
        temporary_password: temporaryPassword,
        // Set when this call adopted a leftover auth.users row rather than
        // creating one. The account is complete and the password above is live
        // either way — this is here so an address the admin was just told
        // already existed does not appear to have gone through by magic, and so
        // the state is visible rather than silently absorbed.
        resumedOrphanedAuthUser: resumed ? true : undefined,
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
