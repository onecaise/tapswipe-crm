// Creates the accounts for a staged user import, a bounded chunk per call.
//
// verify_jwt = false in config.toml, so this function authenticates the caller
// itself. Admin-only, house order: authenticated, active profile, admin, and
// only then the service-role client.
//
// WHY A CHUNK PER CALL RATHER THAN THE WHOLE BATCH, AND WHY NOT AN RPC.
//
// commit_residual_import is a security definer RPC that moves a whole batch in
// one transaction. That is not available here: each account is a GoTrue write
// plus a Postgres write, in two different systems, with nothing spanning them.
// Two hundred accounts is four hundred operations that can stop anywhere, so
// there is no "commit" that either happens or does not — only progress.
//
// Nor can the loop live inside one invocation. An Edge Function has a wall-clock
// limit, and two hundred sequential account creations would exceed it; a run
// that dies at row 150 with no record of rows 1-149 is the worst possible
// outcome. So the caller loops, this function does a few rows per call, and
// EVERY ROW'S OUTCOME IS WRITTEN BEFORE THE NEXT ROW STARTS. A death mid-chunk
// therefore loses at most the in-flight row — and even that is recoverable,
// because provisionUser's resume path adopts the orphan on the next attempt.
//
// A real queue (pg_cron, pgmq) would be new infrastructure with new failure
// modes and no observability surface in this app. The staging table already IS
// the queue: `outcome is null` is the work list, and asking for it again is the
// whole of resume.
//
// NOTHING ABOUT THE TEMPORARY PASSWORD IS RETURNED. provisionUser generates one
// per account and this function discards it unread. That is deliberate: a batch
// that hands out forty secrets at once is a worse problem than a batch whose
// accounts each need a password issued at onboarding time. Every account lands
// with must_change_password = true, and an admin issues a password per rep from
// Manage Users (admin-reset-password) when they actually onboard that person.
// The UI has to say so, or forty accounts get created and nobody can sign in.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

import {
  callerIsActive,
  callerIsAdmin,
  json,
  type Role,
} from "../_shared/admin-users.ts";
import { provisionUser } from "../_shared/provision-user.ts";
import {
  SKIPPABLE_BLOCKERS,
  isBlocking,
  isPositiveInt,
  type UserImportBlocker,
} from "../_shared/user-imports.ts";

/**
 * Rows per call.
 *
 * Five amortises the per-invocation cost — a JWT verification and two
 * authorization RPCs — five ways, while leaving each invocation far inside the
 * wall-clock limit. The cap matters more than the default: provisionUser's
 * resume path pages listUsers to tell a duplicate from a leftover, so a chunk in
 * which every row takes that path does real work per row. Ten is the most this
 * will accept however large a number is asked for.
 */
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;

type StagedRow = {
  id: number;
  row_number: number;
  full_name: string | null;
  email: string | null;
  role: string | null;
  agent_number: string | null;
};

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

    if (!isPositiveInt(body.batch_id)) {
      return json({ error: "batch_id must be a positive integer" }, 400);
    }
    const batchId = body.batch_id;

    let limit = DEFAULT_LIMIT;
    if (body.limit !== undefined && body.limit !== null) {
      if (!isPositiveInt(body.limit)) {
        return json({ error: "limit must be a positive integer" }, 400);
      }
      limit = Math.min(body.limit, MAX_LIMIT);
    }

    const retryFailed = body.retry_failed === true;

    // Through the caller-scoped client, so RLS decides visibility and a batch
    // that is not visible is indistinguishable from one that does not exist.
    const { data: batch, error: batchError } = await ctx.supabase
      .from("user_import_batches")
      .select("id, status")
      .eq("id", batchId)
      .maybeSingle();

    if (batchError) {
      return json(
        { error: `Could not read the import: ${batchError.message}` },
        500,
      );
    }
    if (!batch) {
      return json({ error: "Import not found" }, 404);
    }

    // 'provisioning' is accepted as a starting state, not just 'review'. That is
    // what makes a batch whose browser tab was closed mid-run resumable by
    // pressing the button again. The status is an advisory lock against a
    // double-click, not a correctness boundary — a genuine concurrent run is
    // made harmless by provisionUser itself, which adopts or refuses rather than
    // creating a second account.
    if (batch.status !== "review" && batch.status !== "provisioning") {
      return json(
        {
          error:
            `This import is ${String(batch.status)} and cannot be provisioned`,
        },
        409,
      );
    }

    // ---- Retrying rows that failed --------------------------------------
    //
    // Without this a transient fault is permanent. An outcome of 'failed' takes
    // the row out of the work list, so an Auth blip that failed five rows would
    // leave five people uncreated with no way back through the UI. Retrying is
    // safe for exactly the reason resume is: provisionUser adopts whatever an
    // interrupted attempt left behind.
    if (retryFailed) {
      const { error: retryError } = await ctx.supabaseAdmin
        .from("user_import_rows")
        .update({
          outcome: null,
          outcome_detail: null,
          orphaned_auth_user: null,
          provisioned_at: null,
        })
        .eq("batch_id", batchId)
        .eq("outcome", "failed");

      if (retryError) {
        return json(
          { error: `Could not reset the failed rows: ${retryError.message}` },
          500,
        );
      }
    }

    // ---- Refuse to start while the file still has blocking problems ------
    //
    // Counted in JS against isBlocking() rather than filtered in the query, so
    // the blocking/skippable split has exactly one definition and this cannot
    // drift from the review screen's counts.
    const { data: blockerRows, error: blockerError } = await ctx.supabaseAdmin
      .from("user_import_rows")
      .select("blocker")
      .eq("batch_id", batchId);

    if (blockerError) {
      return json(
        { error: `Could not check the staged rows: ${blockerError.message}` },
        500,
      );
    }

    const blocking = (blockerRows ?? []).filter((row) =>
      isBlocking(row.blocker as UserImportBlocker | null)
    ).length;

    if (blocking > 0) {
      return json(
        {
          error:
            `This import still has ${blocking} row${
              blocking === 1 ? "" : "s"
            } that cannot be created. Correct the file and read it again.`,
        },
        409,
      );
    }

    // ---- Take the lock ----------------------------------------------------
    if (batch.status === "review") {
      const { error: lockError } = await ctx.supabaseAdmin
        .from("user_import_batches")
        .update({ status: "provisioning" })
        .eq("id", batchId)
        .eq("status", "review");

      if (lockError) {
        return json(
          { error: `Could not start provisioning: ${lockError.message}` },
          500,
        );
      }
    }

    // ---- Record the rows that are skipped rather than created -------------
    //
    // Done in one statement before the loop, so a skipped row is never left
    // looking unprocessed. Idempotent: it only touches rows with no outcome yet.
    const counts = { created: 0, resumed: 0, skipped: 0, failed: 0 };

    const { data: skippedRows, error: skipError } = await ctx.supabaseAdmin
      .from("user_import_rows")
      .update({
        outcome: "skipped_duplicate",
        provisioned_at: new Date().toISOString(),
      })
      .eq("batch_id", batchId)
      .is("outcome", null)
      .in("blocker", SKIPPABLE_BLOCKERS)
      // Returned so they can be COUNTED. Without this the response
      // under-reported: rows skipped by this statement never went through the
      // loop below, so `skipped` came back 0 for a batch in which every row was
      // skipped, and the caller had no way to tell that from "nothing to do".
      .select("id");

    if (skipError) {
      return json(
        { error: `Could not record the skipped rows: ${skipError.message}` },
        500,
      );
    }

    counts.skipped += (skippedRows ?? []).length;

    // ---- The chunk --------------------------------------------------------
    const { data: pending, error: pendingError } = await ctx.supabaseAdmin
      .from("user_import_rows")
      .select("id, row_number, full_name, email, role, agent_number")
      .eq("batch_id", batchId)
      .is("outcome", null)
      .is("blocker", null)
      .order("row_number", { ascending: true })
      .limit(limit);

    if (pendingError) {
      return json(
        { error: `Could not read the next rows: ${pendingError.message}` },
        500,
      );
    }

    for (const row of (pending ?? []) as StagedRow[]) {
      // A row with no blocker has been validated by the parser, so these are
      // non-null by construction. Checked anyway rather than asserted: a row
      // that somehow lacks them must be reported, not thrown on halfway through
      // a batch.
      if (row.full_name === null || row.email === null || row.role === null) {
        await recordOutcome(ctx.supabaseAdmin, row.id, {
          outcome: "failed",
          outcome_detail:
            "This row is missing a name, an email or a role. Read the file again.",
        });
        counts.failed += 1;
        continue;
      }

      let result;
      try {
        result = await provisionUser(ctx.supabase, ctx.supabaseAdmin, actorId, {
          fullName: row.full_name,
          email: row.email,
          role: row.role as Role,
          agentNumber: row.agent_number,
        });
      } catch (error) {
        // Recorded rather than rethrown, so the rows already done in this chunk
        // keep their outcomes and the admin sees which row went wrong. Marked
        // 'failed', which retry_failed can clear -- the reason that option
        // exists.
        await recordOutcome(ctx.supabaseAdmin, row.id, {
          outcome: "failed",
          outcome_detail: error instanceof Error
            ? error.message
            : "Unknown error while creating the account.",
        });
        counts.failed += 1;
        continue;
      }

      // Written BEFORE the next row starts. This is the whole resumability
      // story: whatever happens next, this row's fate is already durable.
      if (result.outcome === "created" || result.outcome === "resumed") {
        await recordOutcome(ctx.supabaseAdmin, row.id, {
          outcome: result.outcome,
          user_id: result.userId,
          outcome_detail: result.auditWriteFailed
            ? "The account was created, but its audit log entry could not be written."
            : null,
        });
        counts[result.outcome] += 1;
        // result.temporaryPassword is deliberately not read. See the header.
      } else if (result.outcome === "conflict") {
        await recordOutcome(ctx.supabaseAdmin, row.id, {
          outcome: "skipped_duplicate",
          outcome_detail: result.message,
        });
        counts.skipped += 1;
      } else {
        await recordOutcome(ctx.supabaseAdmin, row.id, {
          outcome: "failed",
          outcome_detail: result.message,
          orphaned_auth_user: result.orphanedAuthUser ?? null,
        });
        counts.failed += 1;
      }
    }

    // ---- How much is left -------------------------------------------------
    const { count: remaining, error: remainingError } = await ctx.supabaseAdmin
      .from("user_import_rows")
      .select("id", { count: "exact", head: true })
      .eq("batch_id", batchId)
      .is("outcome", null)
      .is("blocker", null);

    if (remainingError) {
      return json(
        { error: `Could not count what is left: ${remainingError.message}` },
        500,
      );
    }

    const left = remaining ?? 0;
    let committed = false;

    // ---- Finish, SERVER-SIDE ----------------------------------------------
    //
    // The flip happens here rather than in the caller, so a browser that dies
    // after the final chunk still leaves a correctly committed batch. A client
    // that had to send a "now mark it done" request would be one more thing
    // between the work and the record of it.
    if (left === 0) {
      const { error: commitError } = await ctx.supabaseAdmin
        .from("user_import_batches")
        .update({ status: "committed", committed_at: new Date().toISOString() })
        .eq("id", batchId);

      if (commitError) {
        return json(
          { error: `Could not finish the import: ${commitError.message}` },
          500,
        );
      }
      committed = true;

      // The batch-level audit row. writeAudit() is not reused because it
      // hardcodes table_name 'profiles', which is right for the per-account rows
      // provisionUser already writes and wrong for this one.
      //
      // Two granularities on purpose, the same split the payout tables settled
      // on: one create_user or resume_create_user per account, plus one row
      // saying the batch finished. audit_log has no detail column, so a single
      // granularity would either lose the per-account trail or bury the batch.
      //
      // Best-effort. The accounts exist either way, and reporting failure for
      // work that succeeded would be the worse lie.
      await ctx.supabaseAdmin.from("audit_log").insert({
        actor_id: actorId,
        action: "commit_user_import",
        table_name: "user_import_batches",
        // audit_log.row_id is text, so the batch id goes in as one --
        // commit_residual_import does the same.
        row_id: String(batchId),
      });
    }

    return json({
      batch_id: batchId,
      processed: counts.created + counts.resumed + counts.skipped +
        counts.failed,
      remaining: left,
      committed,
      ...counts,
    });
  }),
};

/** The minimum client surface needed to write a row's outcome back. */
type OutcomeWriter = {
  from: (table: string) => {
    update: (values: Record<string, unknown>) => {
      eq: (
        column: string,
        value: number,
      ) => PromiseLike<{ error: { message: string } | null }>;
    };
  };
};

/**
 * Stamps a row with what happened to it.
 *
 * provisioned_at is set here rather than defaulted in SQL, so it means "when
 * this row was attempted" rather than "when the row was staged".
 */
async function recordOutcome(
  supabaseAdmin: OutcomeWriter,
  rowId: number,
  values: Record<string, unknown>,
): Promise<void> {
  await supabaseAdmin
    .from("user_import_rows")
    .update({ provisioned_at: new Date().toISOString(), ...values })
    .eq("id", rowId);
}

/* To invoke locally:

  1. Run `supabase start` and `supabase functions serve`
  2. Stage a batch with stage-user-import, then:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/provision-user-batch' \
    --header 'Authorization: Bearer <ADMIN_ACCESS_TOKEN>' \
    --header 'Content-Type: application/json' \
    --data '{"batch_id":1}'

  Call it repeatedly until `remaining` is 0; `committed` turns true on the call
  that empties the work list. Add "retry_failed": true to clear failed rows and
  attempt them again.

  Expected: 200 with { batch_id, processed, remaining, committed,
                       created, resumed, skipped, failed }
            400 if batch_id or limit is not a positive integer
            404 if the batch does not exist
            409 if the batch is committed or abandoned
            409 if the file still has rows that cannot be created
            403 if the caller is not an active admin
            401 if there is no valid JWT
*/
