// Exports rep_payout_rows as an XLSX — and one that can be fed straight back in.
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
// import map of its own. The column names come from _shared/residuals.ts, which is
// what keeps the export re-importable by the parser that reads it.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import * as XLSX from "xlsx";

import { callerIsActive, json } from "../_shared/admin-users.ts";
import { COLUMN_HEADERS } from "../_shared/residuals.ts";

/** PostgREST caps a response at [api] max_rows; read in pages under that. */
const PAGE_SIZE = 500;

type Row = {
  agent_id: string;
  period: string;
  mid: string;
  merchant_name: string | null;
  volume: string | null;
  average_ticket: string | null;
  total_cost: string | null;
  residual_income: string | null;
  rep_split_pct: string | null;
  rep_payout: string | null;
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
          "agent_id, period, mid, merchant_name, volume, average_ticket, total_cost, residual_income, rep_split_pct, rep_payout",
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

    // The nine canonical headers are what make this file re-importable; `Agent` and
    // `Rep payout` are extras the parser ignores, because mapHeaders skips headers
    // it does not recognise. `Agent` does not collide with `Agent #` — the
    // normaliser reduces them to `agent` and `agent#`.
    //
    // DELIBERATELY NO TOTAL ROW. A total has no MID, so re-importing this file would
    // block that row with missing_mid and refuse the whole batch — breaking the
    // round trip that is the entire point of the export. The pages show the totals.
    const sheet: unknown[][] = [
      [
        COLUMN_HEADERS.period,
        COLUMN_HEADERS.agent_number,
        "Agent",
        COLUMN_HEADERS.mid,
        COLUMN_HEADERS.merchant_name,
        COLUMN_HEADERS.volume,
        COLUMN_HEADERS.average_ticket,
        COLUMN_HEADERS.total_cost,
        COLUMN_HEADERS.residual_income,
        COLUMN_HEADERS.rep_split,
        "Rep payout",
      ],
    ];

    for (const row of rows) {
      const rep = reps.get(row.agent_id);
      sheet.push([
        // YYYY-MM-DD as text, which parsePeriodCell reads back exactly. Writing a
        // Date here would let Excel's display format decide what the file says.
        row.period,
        rep?.number ?? "",
        rep?.name ?? "",
        row.mid,
        row.merchant_name ?? "",
        num(row.volume),
        num(row.average_ticket),
        num(row.total_cost),
        // Blank rather than 0 when unset, so a re-import leaves the figure alone
        // instead of writing a zero nobody entered. This is the export half of the
        // coalesce rule in commit_residual_import.
        num(row.residual_income),
        num(row.rep_split_pct),
        num(row.rep_payout),
      ]);
    }

    const worksheet = XLSX.utils.aoa_to_sheet(sheet);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, worksheet, "Residuals");
    const bytes = XLSX.write(book, { type: "array", bookType: "xlsx" });

    const name = period === null ? "all-periods" : period.slice(0, 7);

    return new Response(bytes, {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
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
