// Creating one account: the auth.users row, the matching profiles row, and the
// temporary password, including every way that can go half-done.
//
// Extracted from create-user/index.ts, which is now a thin HTTP wrapper over
// this. The extraction happened because a second caller appeared — the bulk rep
// import provisions a batch of rows and needs exactly this logic per row — and
// the alternative was a second copy of the resume path. That path is the most
// carefully reasoned code in the admin surface and the least forgiving to get
// subtly wrong, so a copy was never a real option.
//
// Dependency-free: clients arrive as arguments and are typed structurally, so
// this file needs no deno.json import map of its own. Same arrangement as
// _shared/admin-users.ts and _shared/documents.ts.
//
// This module does NOT authenticate or authorize. Callers are responsible for
// establishing that the caller is an active admin BEFORE calling provisionUser,
// through the caller-scoped client, in the house order. The `supabase` argument
// below is that same caller-scoped client and is used for exactly one read; the
// `supabaseAdmin` argument bypasses RLS entirely.

import {
  findAuthUserByEmail,
  generateTempPassword,
  writeAudit,
  type Role,
} from "./admin-users.ts";

/**
 * The minimum surface of the caller-scoped client: one read of profiles.
 *
 * Structural rather than importing SupabaseClient, so this file stays out of the
 * import map — the reason every _shared module here does it this way.
 */
type CallerClient = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: string) => {
        maybeSingle: () => PromiseLike<
          { data: { id: string } | null; error: { message: string } | null }
        >;
      };
    };
  };
};

/** The service-role surface: the Auth admin API plus two profiles operations. */
type AdminClient = {
  auth: {
    admin: {
      createUser: (
        attributes: { email: string; password: string; email_confirm: boolean },
      ) => PromiseLike<
        {
          data: { user: { id: string; email?: string | null } | null } | null;
          error: { message: string } | null;
        }
      >;
      updateUserById: (
        id: string,
        attributes: { password: string; email_confirm: boolean },
      ) => PromiseLike<{ error: { message: string } | null }>;
      deleteUser: (
        id: string,
      ) => PromiseLike<{ error: { message: string } | null }>;
      listUsers: (params: { page: number; perPage: number }) => PromiseLike<
        {
          data: { users?: { id: string; email?: string | null }[] } | null;
          error: unknown;
        }
      >;
    };
  };
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: string) => {
        maybeSingle: () => PromiseLike<
          { data: { id: string } | null; error: { message: string } | null }
        >;
      };
    };
    insert: (
      row: Record<string, unknown>,
    ) => PromiseLike<{ error: { message: string } | null }>;
  };
};

/** Validated, normalised input. Callers normalise with the helpers below. */
export type ProvisionInput = {
  fullName: string;
  email: string;
  role: Role;
  agentNumber: string | null;
  /**
   * The account's first password, when the caller has one to set.
   *
   * Present for create-user, where an admin types it and will hand it over
   * themselves — see that function for why this flow is allowed to know a
   * credential. ABSENT for provision-user-batch, which has no admin standing
   * over each of forty rows and takes the generated password below precisely so
   * it can discard it unread. Omitting it is therefore the safe default and the
   * reason this is optional rather than required.
   *
   * Callers validate it before calling — MIN_PASSWORD_LENGTH in admin-users.ts.
   * Nothing is trimmed or normalised here: whatever arrives is what GoTrue is
   * given, because it is what the admin is about to read out.
   */
  password?: string;
};

/**
 * Four outcomes, and they are kept distinct because each needs a different
 * answer from the caller.
 *
 * `conflict` is a refusal the admin can act on — the address or the agent number
 * belongs to someone. The single-row caller returns 409; the batch caller
 * records the row as skipped and carries on, because one rep who already exists
 * is not a reason to abandon thirty-nine who do not.
 *
 * `failed` is everything else, carrying the status the HTTP caller should use
 * and, when there is one, the id of an auth.users row left with no profile.
 */
export type ProvisionResult =
  | {
    outcome: "created" | "resumed";
    userId: string;
    email: string;
    temporaryPassword: string;
    auditWriteFailed: boolean;
  }
  | { outcome: "conflict"; message: string }
  | {
    outcome: "failed";
    message: string;
    status: number;
    orphanedAuthUser?: string;
  };

/**
 * Lower-cased and trimmed, so 'Rep@Tapswipe.com' and 'rep@tapswipe.com' cannot
 * become two accounts for one person — the access model depends on agent_id
 * naming exactly one human.
 */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Blank and whitespace are treated as absent rather than stored, because '' is a
 * value the partial unique index on profiles.agent_number enforces — the second
 * rep created with an empty field would collide with the first.
 *
 * Absent is the norm: a rep can be created before anyone knows what the
 * processor will call them.
 */
export function normalizeAgentNumber(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Creates one account, or finishes one a previous attempt left half-built.
 *
 * The two writes are not one transaction — they cannot be, one is in GoTrue and
 * one is in Postgres — so the half-created account is handled from both ends: a
 * profiles insert that fails deletes the auth.users row it just made, and a call
 * for an address that already has an auth.users row with no profiles row adopts
 * it instead of refusing. The second is what covers the case the first cannot
 * see, where the process dies between the two writes and no rollback ever runs.
 *
 * Retrying is therefore always safe, and is the cure. That property is what the
 * bulk import's batch-level resume is built on: a row whose outcome was never
 * recorded is simply provisioned again.
 *
 * @param supabase      CALLER-scoped client. One read, so RLS decides it.
 * @param supabaseAdmin Service-role client. Bypasses RLS; nothing may reach it
 *                      before the caller has been authorized.
 * @param actorId       The verified caller's id, for audit_log. Service-role
 *                      connections have no auth.uid(), so it must be carried.
 */
export async function provisionUser(
  supabase: CallerClient,
  supabaseAdmin: AdminClient,
  actorId: string,
  input: ProvisionInput,
): Promise<ProvisionResult> {
  const { fullName, role } = input;
  const email = normalizeEmail(input.email);
  const agentNumber = input.agentNumber;
  // The caller's password if it set one, otherwise a generated one. The variable
  // keeps its name because "temporary" is still true of both: must_change_password
  // is set below either way, so neither survives the rep's first sign-in.
  const temporaryPassword = input.password ?? generateTempPassword();

  // Checked BEFORE createUser, deliberately.
  //
  // The unique index is the real authority and would catch this anyway — but it
  // would catch it on the profiles insert, i.e. after the auth.users row exists,
  // sending a duplicate agent number down the rollback path and reporting it as
  // "Could not create the profile: duplicate key value violates unique
  // constraint …". That is a fixable mistake dressed as an internal failure.
  // Failing here costs one query and says what is wrong.
  //
  // Through the caller-scoped client, so RLS is still what decides what is
  // readable. Safe as a completeness check only because the caller is already a
  // verified active admin and admins see every profiles row; the index, not this
  // query, is what closes the race.
  if (agentNumber !== null) {
    const { data: clash, error: clashError } = await supabase
      .from("profiles")
      .select("id")
      .eq("agent_number", agentNumber)
      .maybeSingle();

    if (clashError) {
      return {
        outcome: "failed",
        message: `Could not check the agent number: ${clashError.message}`,
        status: 500,
      };
    }
    if (clash) {
      return {
        outcome: "conflict",
        message:
          `Agent # ${agentNumber} is already assigned to another rep`,
      };
    }
  }

  // Authorization is settled by the caller, so the service role may be used now.
  //
  // email_confirm: true because there is no inbox step in this flow. The admin
  // hands the password over out-of-band (§8), so leaving the address unconfirmed
  // would block a login that is already authorised out of band.
  const { data: created, error: createError } = await supabaseAdmin.auth.admin
    .createUser({
      email,
      password: temporaryPassword,
      email_confirm: true,
    });

  // The id the profiles row will hang off — created just now, or adopted from an
  // attempt that died half-way. `resumed` only changes what gets audited and
  // what the caller is told; the profiles insert below is identical.
  let newUserId: string;
  let storedEmail: string | null;
  let resumed = false;

  if (createError || !created?.user) {
    const message = createError?.message ?? "unknown error";
    const alreadyExists = /already|registered|exists/i.test(message);

    if (!alreadyExists) {
      return {
        outcome: "failed",
        message: `Could not create the account: ${message}`,
        status: 500,
      };
    }

    // "Already registered" has two causes that need opposite answers, and
    // returning a flat conflict to both is what makes a half-created account
    // permanent.
    //
    // One: an ordinary duplicate. The address belongs to an account that has its
    // profiles row, so it is a real account. A conflict, and the admin can act
    // on it — that is the case the live suite pins.
    //
    // Two: the auth.users row is a leftover. The rollback below fires only for a
    // profiles insert that *returns* an error; nothing fires when the process
    // itself is gone — a function timeout, an isolate recycled mid-request, a
    // redeploy, a dropped connection between the two calls. The leftover can log
    // in, lands on /auth/error?error=no-profile, and cannot self-heal because
    // profiles has no insert policy for `authenticated`. If the retry answers
    // "already exists" as well, nothing inside the app can repair it — it needs
    // someone in the dashboard.
    //
    // So tell them apart and adopt the leftover. That makes retrying the cure for
    // a half-created account, which is what closes the window the rollback cannot
    // reach: the two writes still are not one transaction, but the outcome is no
    // longer an orphaned login either way.
    const lookup = await findAuthUserByEmail(supabaseAdmin, email);

    // A failed lookup is not evidence of anything. Report the original conflict
    // rather than guessing, because the alternative — treating "we could not
    // check" as "there is no profile" — would take the adopt path against a live
    // account and reset a working rep's password.
    if (!lookup.ok) {
      return {
        outcome: "conflict",
        message:
          `A user with that email already exists, and checking whether it ` +
          `has a profile failed: ${lookup.error}`,
      };
    }

    // GoTrue says the address is taken but no row carries it. Nothing sane
    // produces this; do not go down either path on a contradiction.
    if (!lookup.user) {
      return {
        outcome: "conflict",
        message:
          "A user with that email already exists, but it could not be " +
          "found to check. Try again, and check the Auth dashboard if it " +
          "persists.",
      };
    }

    const { data: existingProfile, error: existingProfileError } =
      await supabaseAdmin
        .from("profiles")
        .select("id")
        .eq("id", lookup.user.id)
        .maybeSingle();

    // Same fail-closed reasoning as the lookup above.
    if (existingProfileError) {
      return {
        outcome: "conflict",
        message:
          `A user with that email already exists, and checking whether it ` +
          `has a profile failed: ${existingProfileError.message}`,
      };
    }

    if (existingProfile) {
      return {
        outcome: "conflict",
        message: "A user with that email already exists",
      };
    }

    // An auth.users row with no profiles row. Adopt it.
    //
    // The password has to be reset, not reused: whatever the interrupted attempt
    // set was generated in a process that died before returning it, so nobody has
    // ever seen it. Returning a fresh one is the only way the answer can be true.
    // email_confirm is re-asserted for the same reason — the leftover may predate
    // the confirmation.
    const { error: adoptError } = await supabaseAdmin.auth.admin
      .updateUserById(lookup.user.id, {
        password: temporaryPassword,
        email_confirm: true,
      });

    if (adoptError) {
      return {
        outcome: "failed",
        message:
          `An account for that email exists with no profile, and resetting ` +
          `its password failed: ${adoptError.message}`,
        status: 500,
        orphanedAuthUser: lookup.user.id,
      };
    }

    newUserId = lookup.user.id;
    storedEmail = lookup.user.email ?? null;
    resumed = true;
  } else {
    newUserId = created.user.id;
    // Denormalised copy of auth.users.email, which stays the authority. Manage
    // Users cannot read auth.users — nothing at the Data API can — so without
    // this the page has no way to tell two reps with the same name apart. Taken
    // from `created.user` rather than the request body so it matches what GoTrue
    // actually stored, normalisation included.
    storedEmail = created.user.email ?? null;
  }

  const { error: profileError } = await supabaseAdmin.from("profiles").insert({
    id: newUserId,
    full_name: fullName.trim(),
    email: storedEmail,
    // The join to a processor's residual report (RESIDUALS_SPEC §3.1). Null is
    // the ordinary case — it is filled in later from Manage Users or from the
    // import review screen, whichever comes first.
    agent_number: agentNumber,
    role,
    is_active: true,
    // Forces the rep to replace the password the admin knows. The (app) layout
    // redirects to /auth/update-password while this is set.
    must_change_password: true,
  });

  if (profileError) {
    // Roll the auth user back. Without this the account exists, can log in, and
    // lands on /auth/error?error=no-profile forever — the ghost-user state
    // lib/auth.ts routes, which nothing in the app can repair because profiles
    // has no insert policy. A failed create must leave nothing behind.
    //
    // Only for a row this call created. On the resume path the auth.users row
    // predates the call, and deleting it would turn a transient profiles error
    // into the silent destruction of an account somebody may have deliberately
    // made in the dashboard — well outside what "create a user" was asked to do.
    // It stays an orphan, and it stays adoptable: the next retry runs this same
    // path again.
    const cleanupError = resumed
      ? null
      : (await supabaseAdmin.auth.admin.deleteUser(newUserId)).error;

    return {
      outcome: "failed",
      message: resumed
        ? `An account for that email exists with no profile, and creating ` +
          `the profile failed again: ${profileError.message}. Retrying is ` +
          `safe — it resumes from the same account.`
        : `Could not create the profile: ${profileError.message}`,
      status: 500,
      // Surfaced rather than swallowed: if the rollback itself failed there IS
      // now an orphan auth user, and whoever reads this needs to know.
      orphanedAuthUser: resumed || cleanupError ? newUserId : undefined,
    };
  }

  const auditError = await writeAudit(
    supabaseAdmin,
    actorId,
    // A distinct verb, because audit_log has no detail column and the two are
    // not the same event: one made an account, the other finished one a previous
    // attempt left half-built. Recording them identically would hide every
    // occurrence of the failure this path exists for.
    resumed ? "resume_create_user" : "create_user",
    newUserId,
  );

  return {
    outcome: resumed ? "resumed" : "created",
    userId: newUserId,
    email,
    // Stored nowhere. The single-row caller shows it to the admin — who typed
    // it in that flow, so showing it back reveals nothing they do not already
    // know; the batch caller discards it unread, because there it IS a secret
    // nobody has seen, and a batch that hands out forty of those at once is a
    // worse problem than a batch whose accounts need a password issued per rep
    // at onboarding time.
    temporaryPassword,
    // Non-fatal: the account exists either way, and reporting failure for an
    // action that succeeded would be the worse lie. Surfaced so it is not silent.
    auditWriteFailed: auditError !== null,
  };
}
