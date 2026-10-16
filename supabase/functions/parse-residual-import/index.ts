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
  lookbackStart,
  parseResidualSheet,
  pickBlocker,
  previewSharedRow,
  previewUnsharedRow,
  sharePreviewNote,
  unsharedPreviewNote,
  type PaidLine,
  type PreviewLedgerLine,
  type PreviewShare,
  type ResidualBlocker,
} from "../_shared/residuals.ts";

/** PostgREST caps a response at [api] max_rows; read in pages under that. */
const PAGE_SIZE = 500;

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

    // ---- Shared-account preview flags (phase 4b) ------------------------
    //
    // What commit_residual_import_v2 would do with each row about a shared
    // account: the rules are previewSharedRow() in _shared/residuals.ts, a
    // mirror of v2's plan. Read with the admin client for the reason above --
    // an active admin may read every share, ledger line and profile -- and,
    // as above, nothing here DECIDES anything: a flag is advisory, never a
    // blocker, and the commit recomputes it from the shares in force then.
    const shares: PreviewShare[] = [];
    const ledger: PreviewLedgerLine[] = [];
    const names = new Map<string, string>();

    const midOfMerchant = new Map<number, string>(
      [...merchants].map(([mid, id]) => [id, mid]),
    );
    if (midOfMerchant.size > 0) {
      const { data, error } = await ctx.supabaseAdmin
        .from("merchant_rep_shares")
        .select(
          "id, merchant_id, primary_agent_id, secondary_agent_id, effective_from, effective_to",
        )
        .in("merchant_id", [...midOfMerchant.keys()]);

      if (error) {
        return json(
          { error: `Could not look up shared accounts: ${error.message}` },
          500,
        );
      }
      for (const share of data ?? []) {
        shares.push({
          id: share.id as number,
          mid: midOfMerchant.get(share.merchant_id as number) as string,
          primaryAgentId: share.primary_agent_id as string,
          secondaryAgentId: share.secondary_agent_id as string,
          effectiveFrom: share.effective_from as string,
          effectiveTo: (share.effective_to as string | null) ?? null,
        });
      }
    }

    if (shares.length > 0) {
      const periods = [
        ...new Set(
          parsed.rows
            .map((row) => row.period)
            .filter((value): value is string => value !== null),
        ),
      ];
      const sharedMids = [...new Set(shares.map((share) => share.mid))];

      if (periods.length > 0) {
        const { data, error } = await ctx.supabaseAdmin
          .from("rep_payout_rows")
          .select("period, mid, agent_id, rep_share_id, share_role, line_kind")
          .in("mid", sharedMids)
          .in("period", periods);

        if (error) {
          return json(
            { error: `Could not read the ledger: ${error.message}` },
            500,
          );
        }
        for (const line of data ?? []) {
          ledger.push({
            period: line.period as string,
            mid: line.mid as string,
            agentId: line.agent_id as string,
            repShareId: (line.rep_share_id as number | null) ?? null,
            shareRole: (line.share_role as string | null) ?? null,
            lineKind: line.line_kind as string,
          });
        }
      }
    }

    // ---- "Looks shared" lookback (phase 5) ------------------------------
    //
    // Who else was paid on each of the file's MIDs in the six months before
    // a row's month, or in it: committed IMPORT lines (an adjustment is a
    // correction, not a payee), read in pages because a large file times
    // seven months can pass PostgREST's max_rows, and a truncated lookback
    // would drop a warning silently. Admin client, for the reason above.
    const filePeriods = parsed.rows
      .map((row) => row.period)
      .filter((value): value is string => value !== null)
      .sort();
    const paid: PaidLine[] = [];
    if (mids.length > 0 && filePeriods.length > 0) {
      const from = lookbackStart(filePeriods[0]);
      const to = filePeriods[filePeriods.length - 1];
      for (let page = 0; ; page += 1) {
        const { data, error } = await ctx.supabaseAdmin
          .from("rep_payout_rows")
          .select("period, mid, agent_id")
          .eq("line_kind", "import")
          .in("mid", mids)
          .gte("period", from)
          .lte("period", to)
          .order("id", { ascending: true })
          .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);

        if (error) {
          return json(
            { error: `Could not read the ledger: ${error.message}` },
            500,
          );
        }
        for (const line of data ?? []) {
          paid.push({
            period: line.period as string,
            mid: line.mid as string,
            agentId: line.agent_id as string,
          });
        }
        if ((data ?? []).length < PAGE_SIZE) break;
      }
    }
    // The file's own rows count too: the same MID under two Agent #s.
    for (const row of parsed.rows) {
      const fileAgent =
        row.agent_number_raw === null
          ? undefined
          : reps.get(row.agent_number_raw);
      if (
        fileAgent !== undefined && row.period !== null && row.mid_raw !== null
      ) {
        paid.push({ period: row.period, mid: row.mid_raw, agentId: fileAgent });
      }
    }

    const people = [
      ...new Set([
        ...shares.flatMap((share) => [
          share.primaryAgentId,
          share.secondaryAgentId,
        ]),
        ...reps.values(),
        ...paid.map((line) => line.agentId),
      ]),
    ];
    if (people.length > 0) {
      const { data, error } = await ctx.supabaseAdmin
        .from("profiles")
        .select("id, full_name")
        .in("id", people);

      if (error) {
        return json(
          { error: `Could not look up rep names: ${error.message}` },
          500,
        );
      }
      for (const person of data ?? []) {
        names.set(person.id as string, person.full_name as string);
      }
    }
    const nameOf = (id: string) => names.get(id) ?? "an unknown rep";

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

      const previewRow = {
        period: row.period,
        agentId,
        mid: row.mid_raw,
        blocked: blocker !== null,
      };
      const preview = previewSharedRow(previewRow, shares, ledger);
      // Only where no share covers the month: one flag per row, in the
      // precedence _shared/residuals.ts documents.
      const unshared = preview === null
        ? previewUnsharedRow(previewRow, shares, paid)
        : null;

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
        preview_flag: preview?.flag ?? unshared?.flag ?? null,
        preview_note: agentId === null
          ? null
          : preview !== null
          ? sharePreviewNote(preview, {
            mid: row.mid_raw ?? "",
            period: row.period ?? "",
            signerName: nameOf(preview.share.primaryAgentId),
            partnerName: nameOf(preview.share.secondaryAgentId),
            fileRepName: nameOf(agentId),
          })
          : unshared !== null
          ? unsharedPreviewNote(unshared, {
            mid: row.mid_raw ?? "",
            period: row.period ?? "",
            fileRepName: nameOf(agentId),
            hasMerchant: row.mid_raw !== null && merchants.has(row.mid_raw),
            nameOf,
          })
          : null,
        // A misplaced comma names its cell (D-10), so the admin is not left
        // hunting across five figures for the one that was refused.
        error:
          blocker === null
            ? null
            : blocker === "bad_number" && row.number_problems.length > 0
              ? row.number_problems.join(" ")
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
    const flaggedCount = staged.filter((row) => row.preview_flag !== null)
      .length;

    const { error: countError } = await ctx.supabaseAdmin
      .from("rep_payout_batches")
      .update({
        row_count: staged.length,
        adjustment_rows_ignored: parsed.adjustments_ignored,
      })
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
      flagged_count: flaggedCount,
      adjustments_ignored: parsed.adjustments_ignored,
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

  Expected: 200 with { batch_id, row_count, blocked_count, flagged_count,
            adjustments_ignored }
            400 if the file is unreadable or a required column is missing
            404 if the batch does not exist, or has no uploaded file
            409 if the batch is already committed or abandoned
            403 if the caller is not an active admin
*/
