// Parses a batch's uploaded XLSX into rep_payout_import_rows.
//
// verify_jwt = false in config.toml, so this function authenticates the caller
// itself. Admin-only, and the order is the house order: authenticated, active
// profile, admin, and only then the service-role client.
//
// IDEMPOTENT ON PURPOSE. Re-parsing deletes the batch's existing staging rows
// first, so "resolve an agent number, then parse again" is an ordinary action
// rather than a duplicate import. That is the whole mechanism behind the review
// screen's Resolve button: there is one code path into staging, and resolution
// simply runs it again with one more rep in the database.
//
// SheetJS is imported here rather than in _shared/, because a _shared module with
// a dependency would need an import map of its own. All the parsing JUDGEMENT is
// in _shared/residuals.ts, which stays dependency-free and is unit-tested under
// vitest without Deno; this file only turns bytes into rows of cells and does the
// two database lookups the parser cannot.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import * as XLSX from "xlsx";

import {
  callerIsActive,
  callerIsAdmin,
  json,
} from "../_shared/admin-users.ts";
import {
  RESIDUAL_BUCKET,
  isPositiveInt,
} from "../_shared/residual-imports.ts";
import {
  blockerMessage,
  parseResidualSheet,
  pickBlocker,
  type ResidualBlocker,
} from "../_shared/residuals.ts";

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    if (req.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    const userId = ctx.userClaims?.id;
    if (!userId) {
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

    // Through the caller-scoped client, so RLS decides visibility and a missing
    // batch is indistinguishable from one that is not the caller's.
    const { data: batch, error: batchError } = await ctx.supabase
      .from("rep_payout_batches")
      .select("id, file_key, status")
      .eq("id", batchId)
      .maybeSingle();

    if (batchError) {
      return json(
        { error: `Could not read the batch: ${batchError.message}` },
        500,
      );
    }
    if (!batch) {
      return json({ error: "Batch not found" }, 404);
    }
    if (batch.status !== "review") {
      // Re-parsing a committed batch would rebuild staging rows for a period that
      // has already landed, and the next commit would import it twice.
      return json(
        { error: `This batch is ${String(batch.status)} and cannot be parsed` },
        409,
      );
    }

    // ---- Read the file -------------------------------------------------
    const { data: blob, error: downloadError } = await ctx.supabaseAdmin.storage
      .from(RESIDUAL_BUCKET)
      .download(batch.file_key as string);

    if (downloadError || !blob) {
      return json(
        {
          error:
            "That batch has no uploaded file yet. Upload one, or abandon the batch.",
        },
        404,
      );
    }

    let sheet: unknown[][];
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const workbook = XLSX.read(bytes, {
        type: "array",
        // So a date-formatted Period cell arrives as a Date rather than a serial
        // number. parsePeriodCell handles both, but a real Date needs no epoch
        // arithmetic and cannot be wrong about Excel's 1900 leap-year fiction.
        cellDates: true,
      });

      const first = workbook.SheetNames[0];
      if (first === undefined) {
        return json({ error: "That file has no sheets." }, 400);
      }

      // Only the first sheet. A residual report is one table; picking a sheet by
      // guessing would make which numbers got imported depend on tab order.
      sheet = XLSX.utils.sheet_to_json(workbook.Sheets[first], {
        // Arrays of cells rather than objects keyed by header, so
        // _shared/residuals.ts owns the header mapping and can report exactly
        // which column is missing.
        header: 1,
        // Cells as their underlying values, not their display strings: a number
        // stays a number and a date stays a Date.
        raw: true,
        // A gap inside a sheet must not shift every row number after it, which is
        // what an admin counts when told "row 22".
        defval: null,
        blankrows: true,
      }) as unknown[][];
    } catch (error) {
      // A .csv renamed to .xlsx, a corrupt upload, a password-protected workbook.
      // Reported rather than thrown, so the review screen can say so.
      return json(
        {
          error: `That file could not be read as a spreadsheet: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        },
        400,
      );
    }

    const parsed = parseResidualSheet(sheet);
    if (!parsed.ok) {
      return json({ error: parsed.error }, 400);
    }

    // ---- Resolve agent numbers and MIDs --------------------------------
    //
    // Through the ADMIN client, and this is the one place in the module that
    // reaches for it before authorization is "complete" in the usual sense.
    // Justified narrowly: the caller is already a verified active admin, checked
    // above through the caller-scoped client, and an admin may read every profiles
    // and merchants row anyway. So the admin client buys only the ability to
    // resolve in two queries instead of forty round trips. It must not be used to
    // DECIDE anything, and it is not — nothing below branches on privilege.
    const agentNumbers = [
      ...new Set(
        parsed.rows
          .map((row) => row.agent_number_raw)
          .filter((value): value is string => value !== null),
      ),
    ];
    const mids = [
      ...new Set(
        parsed.rows
          .map((row) => row.mid_raw)
          .filter((value): value is string => value !== null),
      ),
    ];

    const reps = new Map<string, string>();
    if (agentNumbers.length > 0) {
      const { data, error } = await ctx.supabaseAdmin
        .from("profiles")
        .select("id, agent_number")
        .in("agent_number", agentNumbers);

      if (error) {
        return json(
          { error: `Could not look up agent numbers: ${error.message}` },
          500,
        );
      }
      for (const profile of data ?? []) {
        reps.set(profile.agent_number as string, profile.id as string);
      }
    }

    const merchants = new Map<string, number>();
    if (mids.length > 0) {
      const { data, error } = await ctx.supabaseAdmin
        .from("merchants")
        .select("id, mid")
        .in("mid", mids);

      if (error) {
        return json({ error: `Could not look up MIDs: ${error.message}` }, 500);
      }
      for (const merchant of data ?? []) {
        merchants.set(merchant.mid as string, merchant.id as number);
      }
    }

    const staged = parsed.rows.map((row) => {
      const agentId =
        row.agent_number_raw === null
          ? null
          : (reps.get(row.agent_number_raw) ?? null);

      // unknown_agent joins the parser's findings and pickBlocker applies the
      // documented precedence, rather than this file deciding it wins or loses
      // against a bad figure.
      const candidates: (ResidualBlocker | null)[] = [...row.blockers];
      if (row.agent_number_raw === null || agentId === null) {
        candidates.push("unknown_agent");
      }

      const blocker = pickBlocker(candidates);

      return {
        batch_id: batchId,
        row_number: row.row_number,
        period_raw: row.period_raw,
        agent_number_raw: row.agent_number_raw,
        mid_raw: row.mid_raw,
        merchant_name_raw: row.merchant_name_raw,
        volume_raw: row.volume_raw,
        average_ticket_raw: row.average_ticket_raw,
        total_cost_raw: row.total_cost_raw,
        residual_income_raw: row.residual_income_raw,
        rep_split_raw: row.rep_split_raw,
        period: row.period,
        agent_id: agentId,
        merchant_id:
          row.mid_raw === null ? null : (merchants.get(row.mid_raw) ?? null),
        volume: row.volume,
        average_ticket: row.average_ticket,
        total_cost: row.total_cost,
        residual_income: row.residual_income,
        rep_split_pct: row.rep_split_pct,
        blocker,
        error:
          blocker === null
            ? null
            : blockerMessage(blocker, {
                agentNumber: row.agent_number_raw ?? "",
                mid: row.mid_raw ?? "",
                period: row.period_raw ?? "",
              }),
      };
    });

    // ---- Replace this batch's staging rows -----------------------------
    const { error: clearError } = await ctx.supabaseAdmin
      .from("rep_payout_import_rows")
      .delete()
      .eq("batch_id", batchId);

    if (clearError) {
      return json(
        { error: `Could not clear the previous parse: ${clearError.message}` },
        500,
      );
    }

    const { error: insertError } = await ctx.supabaseAdmin
      .from("rep_payout_import_rows")
      .insert(staged);

    if (insertError) {
      return json(
        { error: `Could not stage the rows: ${insertError.message}` },
        500,
      );
    }

    const blockedCount = staged.filter((row) => row.blocker !== null).length;

    const { error: countError } = await ctx.supabaseAdmin
      .from("rep_payout_batches")
      .update({ row_count: staged.length })
      .eq("id", batchId);

    if (countError) {
      return json(
        { error: `Could not update the batch: ${countError.message}` },
        500,
      );
    }

    // Counts only. The review screen reads the staging rows itself — it holds
    // SELECT on them — so shaping the whole review payload here would be a second
    // copy of that grouping to keep in step with the first.
    return json({
      batch_id: batchId,
      row_count: staged.length,
      blocked_count: blockedCount,
    });
  }),
};

/* To invoke locally:

  1. Run `supabase start` and `supabase functions serve`
  2. Create a batch and upload a file via residual-import-file-url, then:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/parse-residual-import' \
    --header 'Authorization: Bearer <ADMIN_ACCESS_TOKEN>' \
    --header 'Content-Type: application/json' \
    --data '{"batch_id":1}'

  Expected: 200 with { batch_id, row_count, blocked_count }
            400 if the file is unreadable or a required column is missing
            404 if the batch does not exist, or has no uploaded file
            409 if the batch is already committed or abandoned
            403 if the caller is not an active admin
*/
