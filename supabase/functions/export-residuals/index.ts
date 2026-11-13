// Exports rep_payout_rows as an XLSX download.
//
// verify_jwt = false in config.toml, so this function authenticates the caller
// itself.
//
// NOT ADMIN-GATED, and that is the design rather than an omission. Every row is
// read through ctx.supabase, the CALLER-scoped client, so RLS is the whole
// authorization story: an admin gets everything in scope, a rep gets their own
// rows, and a deactivated caller is rejected earlier by callerIsActive. There is no
// role branch anywhere below.
//
// That is the same reasoning search_crm is `security invoker`: an export is exactly
// the shape of thing that becomes a disclosure bug, and running as the caller means
// it physically cannot return a row the rest of the app hides. Reaching for
// supabaseAdmin here — even "just to join the agent names" — would silently turn a
// rep's export into the whole company's.
//
// SheetJS is imported here rather than in _shared/, for the reason
// parse-residual-import gives: a _shared module with a dependency would need an
// import map of its own. The header row is EXPORT_HEADER in _shared/residuals.ts
// (memo §2.6, phase 11 of docs/design/intake-and-reports.md). The export is NOT
// an import format: the parser reads the processor's six-column file and refuses
// this one, which carries Agent # and Rep payout.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import * as XLSX from "xlsx";

import { callerIsActive, json } from "../_shared/admin-users.ts";
import { EXPORT_HEADER } from "../_shared/residuals.ts";

/** PostgREST caps a response at [api] max_rows; read in pages under that. */
const PAGE_SIZE = 500;

type Row = {
  agent_id: string;
  period: string;
  processor: string | null;
  mid: string;
  merchant_name: string | null;
  volume: string | null;
  residual_income: string | null;
  rep_split_pct: string | null;
  rep_payout: string | null;
  line_kind: string;
  share_role: string | null;
  primary_rep_pct: string | null;
  secondary_rep_pct: string | null;
};

/** numeric arrives as a string; a workbook should carry numbers, not text. */
function num(value: string | null): number | null {
  if (value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    if (req.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    if (!ctx.userClaims?.id) {
      return json({ error: "Not authenticated" }, 401);
    }

    // A valid JWT does not mean the account is still enabled. Through the
    // caller-scoped client, or is_active_agent() has no auth.uid() to read.
    if (!(await callerIsActive(ctx.supabase))) {
      return json({ error: "Account is not active" }, 403);
    }

    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      // An empty body is fine: it means "everything I can see".
    }

    const period = typeof body.period === "string" ? body.period : null;
    const agentId = typeof body.agent_id === "string" ? body.agent_id : null;

    if (period !== null && !/^\d{4}-\d{2}-\d{2}$/.test(period)) {
      return json({ error: "period must be YYYY-MM-DD" }, 400);
    }

    // Paged, because PostgREST would otherwise return only the first max_rows and
    // an admin exporting a large month would get a silent prefix. A truncated
    // commission export that looks complete is the worst possible failure here.
    const rows: Row[] = [];
    for (let page = 0; ; page += 1) {
      let query = ctx.supabase
        .from("rep_payout_rows")
        .select(
          "agent_id, period, processor, mid, merchant_name, volume, residual_income, rep_split_pct, rep_payout, line_kind, share_role, primary_rep_pct, secondary_rep_pct",
        )
        .order("period", { ascending: false })
        .order("agent_id", { ascending: true })
        .order("mid", { ascending: true })
        .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);

      if (period !== null) query = query.eq("period", period);
      if (agentId !== null) query = query.eq("agent_id", agentId);

      const { data, error } = await query;
      if (error) {
        return json({ error: `Could not read payouts: ${error.message}` }, 500);
      }

      const batch = (data ?? []) as Row[];
      rows.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    }

    // Agent numbers and names, resolved through the SAME caller-scoped client. A
    // rep can read their own profiles row and an admin can read all, so this needs
    // no privilege the caller does not already have — and using supabaseAdmin here
    // would be the one line that broke the guarantee above.
    const agentIds = [...new Set(rows.map((row) => row.agent_id))];
    const reps = new Map<string, { name: string; number: string | null }>();
    if (agentIds.length > 0) {
      const { data, error } = await ctx.supabase
        .from("profiles")
        .select("id, full_name, agent_number")
        .in("id", agentIds);

      if (error) {
        return json({ error: `Could not read reps: ${error.message}` }, 500);
      }
      for (const rep of data ?? []) {
        reps.set(rep.id as string, {
          name: rep.full_name as string,
          number: (rep.agent_number as string | null) ?? null,
        });
      }
    }

    // The header (memo §2.6): EXPORT_HEADER, one row per ledger line.
    //
    // `Processor` is the line's (the batch's; an adjustment's is the paid
    // month's); blank on a line from before processors were recorded.
    // `Residual` is the line's own residual (a shared line's piece of the
    // account's). `Line` says what kind of line it is: blank for a merchant
    // line from a file, "Adjustment" for a correction, "Override" for an
    // override debit or credit (20261102120000). An adjustment and an override
    // have no Volume, Residual or Rep split; their Rep payout is the amount.
    //
    // `Account share` is the row's OWN share of the rep side on a shared
    // account -- 40 on the signer's line, 10 on the partner's -- and blank
    // otherwise. Never the other rep's figure: a rep's export holds only their
    // own lines (RLS), and each line names its own share.
    //
    // No total row: the pages show the totals, and a row with no MID is not a
    // ledger line.
    const sheet: unknown[][] = [[...EXPORT_HEADER]];

    for (const row of rows) {
      const rep = reps.get(row.agent_id);
      sheet.push([
        // YYYY-MM-DD as text: a Date would let Excel's display format decide
        // what the file says.
        row.period,
        row.processor ?? "",
        rep?.number ?? "",
        rep?.name ?? "",
        row.mid,
        row.merchant_name ?? "",
        num(row.volume),
        num(row.residual_income),
        num(row.rep_split_pct),
        num(row.rep_payout),
        // "Override" (20261102120000, memo §2.6): a debit or credit line
        // commit v3 wrote; its Rep payout is the signed override amount.
        row.line_kind === "adjustment"
          ? "Adjustment"
          : row.line_kind === "override"
            ? "Override"
            : "",
        row.share_role === "primary"
          ? num(row.primary_rep_pct)
          : row.share_role === "secondary"
            ? num(row.secondary_rep_pct)
            : null,
      ]);
    }

    const worksheet = XLSX.utils.aoa_to_sheet(sheet);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, worksheet, "Residuals");
    const bytes = XLSX.write(book, { type: "array", bookType: "xlsx" });

    const name = period === null ? "all-periods" : period.slice(0, 7);

    // application/octet-stream, NOT the real XLSX media type — and this is
    // load-bearing rather than laziness. DO NOT "correct" it back.
    //
    // supabase-js decides how to READ a function's body from this header, and it
    // matches an explicit list (FunctionsClient: application/json -> .json(),
    // application/octet-stream and application/pdf -> .blob(), text/event-stream,
    // multipart/form-data, and **everything else -> .text()**). The spreadsheet
    // type is not on that list, so the correct header sent the caller down the
    // text branch: invoke() resolved { error: null, data: <string> }, the export
    // button's `data instanceof Blob` guard failed, and it reported "Could not
    // build the export." on a 200 that had just returned a perfectly good file.
    //
    // Worse than a bad message: UTF-8-decoding a zip is lossy (16,597 bytes came
    // back as a 16,509-character string), so relaxing that guard to accept the
    // text would have produced a silently corrupt .xlsx — the failure mode this
    // file already refuses elsewhere, for the same reason it writes no total row.
    //
    // Nothing is lost by the generic type. The filename still travels in
    // Content-Disposition below for a direct fetch or the curl example, and the
    // browser download is named by the component's own `anchor.download` — a Blob
    // URL carries no headers, so that has always been the naming mechanism.
    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="residuals-${name}.xlsx"`,
      },
    });
  }),
};

/* To invoke locally:

  1. Run `supabase start` and `supabase functions serve`
  2. Sign in to get a user access token, then:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/export-residuals' \
    --header 'Authorization: Bearer <ACCESS_TOKEN>' \
    --header 'Content-Type: application/json' \
    --data '{"period":"2026-07-01"}' --output residuals.xlsx

  Expected: 200 with an .xlsx body, containing only rows the caller may see
            403 if the caller's profile is deactivated
            401 if there is no valid JWT
*/
