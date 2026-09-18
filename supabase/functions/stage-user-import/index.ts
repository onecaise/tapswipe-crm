// Parses a CSV of reps into user_import_rows, creating the batch on the way.
//
// verify_jwt = false in config.toml, so this function authenticates the caller
// itself. Admin-only, and the order is the house order: authenticated, active
// profile, admin, and only then the service-role client.
//
// ONE FUNCTION WHERE RESIDUALS NEEDED TWO. residual-import-file-url exists
// separately from parse-residual-import because the Storage key contains the
// batch id, so the row has to exist before the upload can be signed. A rep list
// is small text carried in the request body, so there is no upload step and no
// ordering constraint: the batch row and its staging rows are written by the
// same call.
//
// IDEMPOTENT ON PURPOSE, exactly as parse-residual-import is. Re-staging a batch
// deletes its existing staging rows first, so "fix something, then read again"
// is an ordinary action rather than a duplicate import. That is the whole
// mechanism behind the review screen's re-read button: one code path into
// staging, run again against a database that has changed.
//
// All the parsing JUDGEMENT is in _shared/user-imports.ts, which stays
// dependency-free and is unit-tested under vitest without Deno. This file only
// moves text in and rows out, and does the two database lookups the parser
// cannot do for itself.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

import {
  callerIsActive,
  callerIsAdmin,
  json,
} from "../_shared/admin-users.ts";
import {
  blockerMessage,
  isBlocking,
  isPositiveInt,
  parseUserImport,
  pickBlocker,
  type UserImportBlocker,
} from "../_shared/user-imports.ts";

/**
 * The most CSV text one request may carry.
 *
 * MAX_IMPORT_ROWS caps the row count, but that check happens after parsing, so
 * something has to bound the work before then — a single 40 MB line is one row.
 * 512 KB is far past 200 rows of names and addresses and far short of anything
 * that costs the runtime a thought.
 */
const MAX_SOURCE_BYTES = 512 * 1024;

/** Display only — there is no Storage key to keep safe, so this just bounds it. */
const MAX_FILE_NAME_LENGTH = 200;

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

    // Two modes, and which one this is depends only on whether a batch id came
    // in. Sending both is a caller bug rather than a merge of the two, so it is
    // refused instead of guessed at.
    const isReparse = body.batch_id !== undefined && body.batch_id !== null;
    if (isReparse && typeof body.source_text === "string") {
      return json(
        {
          error:
            "Send either batch_id to read a stored file again, or source_text " +
            "to start a new import — not both.",
        },
        400,
      );
    }

    let batchId: number;
    let sourceText: string;

    if (isReparse) {
      // ---- Mode B: read a stored file again ----------------------------
      if (!isPositiveInt(body.batch_id)) {
        return json({ error: "batch_id must be a positive integer" }, 400);
      }
      batchId = body.batch_id;

      // Through the caller-scoped client, so RLS decides visibility and a batch
      // that is not the caller's is indistinguishable from one that does not
      // exist.
      const { data: batch, error: batchError } = await ctx.supabase
        .from("user_import_batches")
        .select("id, status, source_text")
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
      if (batch.status !== "review") {
        // Re-staging a batch that has started provisioning would rebuild the
        // work list underneath a run in flight, and re-staging a committed one
        // would discard the per-row outcomes that ARE the record of what
        // happened. Both are worse than refusing.
        return json(
          {
            error:
              `This import is ${String(batch.status)} and cannot be read again`,
          },
          409,
        );
      }

      sourceText = String(batch.source_text ?? "");
    } else {
      // ---- Mode A: a new import ----------------------------------------
      const { file_name: fileName, source_text: text } = body;

      if (typeof fileName !== "string" || fileName.trim() === "") {
        return json({ error: "file_name is required" }, 400);
      }
      if (typeof text !== "string" || text.trim() === "") {
        return json({ error: "source_text is required" }, 400);
      }
      // Byte length, not string length: the cap is about what has to be carried
      // and stored, and a name with accents is more bytes than characters.
      if (new TextEncoder().encode(text).length > MAX_SOURCE_BYTES) {
        return json(
          {
            error:
              `That file is too large to import. The limit is ${
                Math.floor(MAX_SOURCE_BYTES / 1024)
              } KB of text.`,
          },
          400,
        );
      }

      sourceText = text;

      // Parsed BEFORE the batch row is created, so a file that cannot be read at
      // all leaves nothing behind. A residual batch deliberately survives a
      // failed parse because its uploaded file is worth keeping and looking at;
      // here the text IS the payload, so a batch that never parsed is a row with
      // nothing to review and nothing to fix.
      const preflight = parseUserImport(sourceText);
      if (!preflight.ok) {
        return json({ error: preflight.error }, 400);
      }

      const { data: created, error: createError } = await ctx.supabaseAdmin
        .from("user_import_batches")
        .insert({
          imported_by: actorId,
          file_name: fileName.trim().slice(0, MAX_FILE_NAME_LENGTH),
          // Kept verbatim. It is the provenance of the import and what a
          // re-read re-parses, so it must not be the normalised form.
          source_text: sourceText,
        })
        .select("id")
        .single();

      if (createError || !created) {
        return json(
          {
            error: `Could not start the import: ${
              createError?.message ?? "unknown error"
            }`,
          },
          500,
        );
      }

      batchId = created.id as number;
    }

    // ---- Parse ---------------------------------------------------------
    const parsed = parseUserImport(sourceText);
    if (!parsed.ok) {
      // Reachable only on the re-read path: mode A parsed before inserting.
      return json({ error: parsed.error, batch_id: batchId }, 400);
    }

    // ---- Look up what already exists ------------------------------------
    //
    // Through the ADMIN client, and this is the one place in the module that
    // reaches for it before authorization is "complete" in the usual sense.
    // Justified narrowly and identically to parse-residual-import: the caller is
    // already a verified active admin, checked above through the caller-scoped
    // client, and an admin may read every profiles row anyway. So the admin
    // client buys the ability to resolve in two queries instead of N round
    // trips. It must not be used to DECIDE anything, and it is not — nothing
    // below branches on privilege.
    const emails = [
      ...new Set(
        parsed.rows
          .map((row) => row.email)
          .filter((value): value is string => value !== null),
      ),
    ];
    const agentNumbers = [
      ...new Set(
        parsed.rows
          .map((row) => row.agent_number)
          .filter((value): value is string => value !== null),
      ),
    ];

    const takenEmails = new Set<string>();
    if (emails.length > 0) {
      const { data, error } = await ctx.supabaseAdmin
        .from("profiles")
        .select("email")
        .in("email", emails);

      if (error) {
        return json(
          { error: `Could not check existing accounts: ${error.message}` },
          500,
        );
      }
      for (const profile of data ?? []) {
        const value = profile.email as string | null;
        // Lower-cased before comparing because the parser normalised its side
        // and profiles.email is only as normalised as whatever wrote it.
        if (value !== null) takenEmails.add(value.trim().toLowerCase());
      }
    }

    const takenAgentNumbers = new Set<string>();
    if (agentNumbers.length > 0) {
      const { data, error } = await ctx.supabaseAdmin
        .from("profiles")
        .select("agent_number")
        .in("agent_number", agentNumbers);

      if (error) {
        return json(
          { error: `Could not check agent numbers: ${error.message}` },
          500,
        );
      }
      for (const profile of data ?? []) {
        const value = profile.agent_number as string | null;
        if (value !== null) takenAgentNumbers.add(value);
      }
    }

    // ---- Shape the staging rows ------------------------------------------
    const staged = parsed.rows.map((row) => {
      // The two lookup-derived blockers join the parser's findings and
      // pickBlocker applies the documented precedence, rather than this file
      // deciding they win or lose against a structural problem.
      const candidates: (UserImportBlocker | null)[] = [...row.blockers];
      const context = { ...row.context };

      if (row.email !== null && takenEmails.has(row.email)) {
        candidates.push("email_exists");
        context.email = row.email;
      }
      if (
        row.agent_number !== null &&
        takenAgentNumbers.has(row.agent_number)
      ) {
        candidates.push("agent_number_taken");
        context.agentNumber = row.agent_number;
      }

      const blocker = pickBlocker(candidates);

      return {
        batch_id: batchId,
        row_number: row.row_number,
        full_name_raw: row.full_name_raw,
        email_raw: row.email_raw,
        role_raw: row.role_raw,
        agent_number_raw: row.agent_number_raw,
        full_name: row.full_name,
        email: row.email,
        role: row.role,
        agent_number: row.agent_number,
        blocker,
        error: blocker === null ? null : blockerMessage(blocker, context),
      };
    });

    // ---- Replace this batch's staging rows --------------------------------
    const { error: clearError } = await ctx.supabaseAdmin
      .from("user_import_rows")
      .delete()
      .eq("batch_id", batchId);

    if (clearError) {
      return json(
        { error: `Could not clear the previous read: ${clearError.message}` },
        500,
      );
    }

    const { error: insertError } = await ctx.supabaseAdmin
      .from("user_import_rows")
      .insert(staged);

    if (insertError) {
      return json(
        { error: `Could not stage the rows: ${insertError.message}` },
        500,
      );
    }

    const { error: countError } = await ctx.supabaseAdmin
      .from("user_import_batches")
      .update({ row_count: staged.length })
      .eq("id", batchId);

    if (countError) {
      return json(
        { error: `Could not update the import: ${countError.message}` },
        500,
      );
    }

    // Counts only. The review screen reads the staging rows itself — it holds
    // SELECT on them — so shaping the whole review payload here would be a
    // second copy of that grouping to keep in step with the first.
    //
    // `blocked` and `skipped` are counted apart because they mean opposite
    // things to the admin: blocked stops the import until the file is corrected,
    // skipped is a row that will be passed over while the rest proceeds.
    const blocked = staged.filter((row) => isBlocking(row.blocker)).length;
    const skipped = staged.filter(
      (row) => row.blocker !== null && !isBlocking(row.blocker),
    ).length;

    return json({
      batch_id: batchId,
      row_count: staged.length,
      blocked_count: blocked,
      skipped_count: skipped,
      /** Nothing structural is wrong, so provisioning may start. */
      ready: blocked === 0 && staged.length > skipped,
    });
  }),
};

/* To invoke locally:

  1. Run `supabase start` and `supabase functions serve`
  2. Sign in as an admin to get an access token, then:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/stage-user-import' \
    --header 'Authorization: Bearer <ADMIN_ACCESS_TOKEN>' \
    --header 'Content-Type: application/json' \
    --data '{"file_name":"reps.csv","source_text":"Full name,Email,Role,Agent #\nAvery Agent,avery@tapswipe.test,agent,4471"}'

  Re-read a stored file after fixing something:

    --data '{"batch_id":1}'

  Expected: 200 with { batch_id, row_count, blocked_count, skipped_count, ready }
            400 if the text is unreadable, missing a column, empty, over the row
                cap, or over the size cap
            400 if both batch_id and source_text are sent
            404 if the batch does not exist
            409 if the batch is no longer in review
            403 if the caller is not an active admin
            401 if there is no valid JWT
*/
