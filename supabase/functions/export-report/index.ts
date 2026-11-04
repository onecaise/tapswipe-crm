// Downloads one of the two /admin/reports reports as an .xlsx (phase 12b of
// docs/design/intake-and-reports.md, §7.2: "an XLSX download through a new
// caller-scoped Edge Function").
//
// verify_jwt = false in config.toml, so this function authenticates the caller
// itself, in the fixed order: withSupabase (401) -> callerIsActive -> callerIsAdmin
// (both through the CALLER-scoped client, 403) -> the reads -> the audit row.
//
// ADMIN-ONLY, unlike export-residuals, because the page is: a rep is refused
// before anything is read. The reads are still CALLER-scoped, so the database
// decides twice -- both report functions are security invoker AND is_admin()
// first (PT403) -- and nothing here could widen what an admin's own session
// reads. supabaseAdmin is reached for exactly one thing, the audit_log insert,
// which no client role may do.
//
// THE FILE IS THE PAGE. It calls the same two functions with the same three
// arguments the page does and writes their rows as they came back, totals
// rows included (_shared/report-sheets.ts); nothing here adds a figure up, so
// the file cannot disagree with the page or a statement.
//
// AUDITED, failing closed. export-residuals writes no audit row; a financial
// export of the whole company's commissions is the safer place to record one.
// audit_log has no detail column, so the report goes in table_name (the SQL
// function's name) and the selection in row_id. Written after the reads and
// before the response: if the row cannot be written, no file leaves.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import * as XLSX from "xlsx";

import { callerIsActive, callerIsAdmin, json } from "../_shared/admin-users.ts";
import { isFirstOfMonth } from "../_shared/residual-imports.ts";
import {
  auditSelection,
  buildReportSheet,
  type MerchantSummaryRow,
  type PaidState,
  type RepSummaryRow,
  type ReportSelection,
} from "../_shared/report-sheets.ts";

const FUNCTION_FOR = {
  reps: "rep_payout_summary",
  merchants: "merchant_processor_summary",
} as const;

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    if (req.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    const userId = ctx.userClaims?.id;
    if (!userId) {
      return json({ error: "Not authenticated" }, 401);
    }

    // Before the body is even parsed: nothing is read for a non-admin.
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

    if (body.report !== "reps" && body.report !== "merchants") {
      return json({ error: "report must be reps or merchants" }, 400);
    }
    if (!isFirstOfMonth(body.from) || !isFirstOfMonth(body.to)) {
      return json({ error: "from and to must be the first of a month, YYYY-MM-01" }, 400);
    }
    if (body.to < body.from) {
      return json({ error: "The first month is after the last." }, 400);
    }
    const processor = body.processor ?? null;
    if (processor !== null && (typeof processor !== "string" || processor === "" || processor.length > 64)) {
      return json({ error: "processor must be a processor code, or null for every processor" }, 400);
    }

    const selection: ReportSelection = {
      report: body.report,
      from: body.from,
      to: body.to,
      processor: processor as string | null,
    };

    // An unknown processor is refused, as the page refuses it, rather than
    // answered with an empty "every processor" look-alike.
    if (selection.processor !== null) {
      const { data, error } = await ctx.supabase
        .from("processors")
        .select("code")
        .eq("code", selection.processor)
        .maybeSingle();
      if (error) return json({ error: "Could not read the processor list" }, 500);
      if (!data) return json({ error: `"${selection.processor}" is not a processor in the CRM.` }, 400);
    }

    const { data: rowData, error: rowError } = await ctx.supabase.rpc(FUNCTION_FOR[selection.report], {
      period_from_input: selection.from,
      period_to_input: selection.to,
      processor_input: selection.processor,
    });
    if (rowError) {
      console.error(`[export-report] ${FUNCTION_FOR[selection.report]}: ${rowError.message}`);
      return json({ error: "Could not read the report" }, 500);
    }
    const rows = (rowData ?? []) as RepSummaryRow[] | MerchantSummaryRow[];
    if (rows.length === 0) {
      return json({ error: "Nothing is committed for that selection." }, 404);
    }

    // The covered processor-months and their paid state, read as the page reads them.
    let batchQuery = ctx.supabase
      .from("rep_payout_batches")
      .select("processor, period")
      .eq("status", "committed")
      .gte("period", selection.from)
      .lte("period", selection.to)
      .order("period", { ascending: false })
      .order("processor", { ascending: true });
    if (selection.processor !== null) batchQuery = batchQuery.eq("processor", selection.processor);
    const [batches, closures] = await Promise.all([
      batchQuery,
      ctx.supabase
        .from("payout_period_closures")
        .select("period, processor, closed_at")
        .gte("period", selection.from)
        .lte("period", selection.to),
    ]);
    if (batches.error || closures.error) {
      return json({ error: "Could not read which months are paid" }, 500);
    }
    const closedAt = new Map(
      ((closures.data ?? []) as { period: string; processor: string; closed_at: string }[])
        .map((c) => [`${c.processor}|${c.period}`, c.closed_at]),
    );
    const paid: PaidState[] = ((batches.data ?? []) as { processor: string; period: string }[]).map((b) => ({
      processor: b.processor,
      period: b.period,
      closed_at: closedAt.get(`${b.processor}|${b.period}`) ?? null,
    }));

    let built;
    try {
      built = buildReportSheet(selection, rows, paid);
    } catch (err) {
      console.error(`[export-report] build: ${err instanceof Error ? err.message : err}`);
      return json({ error: "Could not build the export" }, 500);
    }

    const { error: auditError } = await ctx.supabaseAdmin.from("audit_log").insert({
      actor_id: userId,
      action: "export_report",
      table_name: FUNCTION_FOR[selection.report],
      row_id: auditSelection(selection),
    });
    if (auditError) {
      console.error(`[export-report] audit write: ${auditError.message}`);
      return json({ error: "Could not record the export" }, 500);
    }

    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, built.sheet as XLSX.WorkSheet, built.sheetName);
    const bytes = XLSX.write(book, { type: "array", bookType: "xlsx" });

    // application/octet-stream, not the spreadsheet media type: supabase-js
    // reads only that (or JSON/PDF/...) as a Blob, and decodes anything else
    // as text, corrupting the zip. export-residuals explains it in full.
    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${built.fileName}"`,
        "Cache-Control": "no-store",
      },
    });
  }),
};

/* To invoke locally:

  1. Run `supabase start` and `supabase functions serve`
  2. Sign in as an admin to get an access token, then:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/export-report' \
    --header 'Authorization: Bearer <ACCESS_TOKEN>' \
    --header 'Content-Type: application/json' \
    --data '{"report":"reps","from":"2026-07-01","to":"2026-07-01","processor":null}' \
    --output residual-report-1-2026-07-all-processors.xlsx

  Expected: 200 with an .xlsx body, and one audit_log row (export_report)
            404 if nothing is committed for the selection
            403 for a rep or a deactivated admin; 401 with no valid JWT
*/
