import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ArrowLeftIcon } from "lucide-react";

import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  EMPTY,
  formatMoney,
  formatPct,
  formatPeriod,
  formatText,
} from "@/lib/format";
import {
  PAYOUT_ROW_COLUMNS,
  parsePeriodParam,
  payoutTotals,
  splitPayoutLines,
  type PayoutRow,
} from "@/lib/payouts";
import { loadOwnShareViews } from "@/lib/rep-shares";
import { PageShell } from "@/components/page-shell";
import { PrintButton } from "@/components/print-button";
import { PrintDocument } from "@/components/print-document";
import { Button } from "@/components/ui/button";

/**
 * A rep's payout summary for one period, built to be printed.
 *
 * No PDF library. A print-styled route costs nothing, renders in the app's own
 * tokens so it cannot drift from the rest of the CRM, and is adjustable in minutes
 * as the layout settles from real use. Server-side PDF generation is a documented
 * follow-up, reusing this layout, rather than a gap.
 *
 * Everything outside the document itself is hidden at print time by the
 * `print:hidden` utilities here and the rules in app/globals.css — so what comes
 * out of the printer is the statement and not the application around it.
 *
 * Reachable by the rep it is about as well as by an admin: RLS returns nothing for
 * anyone else's rows, and no rows becomes notFound(), so the URL cannot be used to
 * discover what another rep earned.
 */
async function Summary({
  params,
}: {
  params: Promise<{ period: string; agentId: string }>;
}) {
  const { period: periodSegment, agentId } = await params;
  const period = parsePeriodParam(periodSegment);

  if (period === null) notFound();
  // Guarded before the query rather than trusting the segment, the same way the
  // merchants detail page guards its id.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agentId)) {
    notFound();
  }

  const profile = await requireUser();
  const isAdmin = profile.role === "admin";
  const supabase = await createClient();

  // PAYOUT_ROW_COLUMNS only, for admins too: a statement is the REP's
  // document, and it prints the rep's own share and the partner's name --
  // never the partner's share or payout -- whoever is printing it.
  const { data, error } = await supabase
    .from("rep_payout_rows")
    .select(PAYOUT_ROW_COLUMNS)
    .eq("period", period)
    .eq("agent_id", agentId)
    .order("mid", { ascending: true });

  if (error) {
    return (
      <p className="text-sm text-destructive">
        Could not load this summary: {error.message}
      </p>
    );
  }

  const rows = (data ?? []) as PayoutRow[];
  // No rows the caller may see and no rows at all are the same answer, so this
  // cannot report what another rep earned — or even that they earned anything.
  if (rows.length === 0) notFound();

  const { data: repData } = await supabase
    .from("profiles")
    .select("full_name, agent_number")
    .eq("id", agentId)
    .maybeSingle();

  const rep = repData as { full_name: string; agent_number: string | null } | null;
  const totals = payoutTotals(rows);
  // Adjustment lines (post_share_correction, phase 5) are printed in their own
  // block, naming the month each corrects; the total includes them.
  const { imports, adjustments } = splitPayoutLines(rows);

  // Shared lines: the partner's name and the rep's own share. An admin
  // reads them from merchant_rep_shares relative to this statement's rep; the
  // rep reads my_share_partners(), which answers for them alone.
  const shareIds = [
    ...new Set(
      imports.map((row) => row.rep_share_id).filter((id): id is number => id !== null),
    ),
  ];
  const shares = await loadOwnShareViews(supabase, isAdmin, agentId, shareIds);
  const anyShared = shareIds.length > 0;

  return (
    <div className="flex flex-col gap-6">
      {/* flex-wrap: "Back to September 2027" and Print do not fit side by
          side at 360px, and both buttons are nowrap -- without it Print sat
          5px off screen and the page scrolled sideways (found by the phase 7
          specs, in February; May happened to fit). */}
      <div className="flex flex-wrap items-start justify-between gap-4 print:hidden">
        <Button asChild variant="ghost" size="sm">
          <Link href={`/payouts/${periodSegment}`}>
            <ArrowLeftIcon size={16} />
            Back to {formatPeriod(period)}
          </Link>
        </Button>
        <PrintButton />
      </div>

      {/* The document. Deliberately plain markup on ordinary tokens — no separate
          print stylesheet to keep in step with the app's look. */}
      <article className="rounded-xl border bg-card p-6 print:rounded-none print:border-0 print:p-0">
        <PrintDocument bodyClassName="flex flex-col gap-5">
          <header className="flex flex-col gap-1 border-b pb-4">
            <h1 className="text-xl font-bold tracking-tight">Payout summary</h1>
            <p className="text-sm">
              <span className="font-medium">
                {formatText(rep?.full_name ?? null)}
              </span>
              <span className="ml-2 font-mono text-xs text-muted-foreground">
                Agent # {rep?.agent_number ?? EMPTY}
              </span>
            </p>
            <p className="text-sm text-muted-foreground">
              {formatPeriod(period)}
            </p>
            {totals.unfilled > 0 && (
              /* Said on the document, not just on screen. A statement printed from a
                 period that is still being worked on would otherwise look final. */
              <p className="mt-1 text-xs font-medium text-warning">
                {totals.unfilled} of {totals.rows} merchants have no residual figure
                entered yet — this summary is incomplete.
              </p>
            )}
          </header>

          {/* Scrolls sideways on a phone instead of painting the Payout column
              past the card edge (QA-010). Visible overflow on paper, where the
              sheet is wide enough and a scrollbar would mean nothing. */}
          <div className="overflow-x-auto print:overflow-visible">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="pb-2 font-medium">MID</th>
                  <th className="pb-2 font-medium">Merchant</th>
                  <th className="pb-2 text-right font-medium">Volume</th>
                  <th className="pb-2 text-right font-medium">Residual</th>
                  <th className="pb-2 text-right font-medium">Split</th>
                  <th className="pb-2 text-right font-medium">Payout</th>
                </tr>
              </thead>
              <tbody>
                {imports.map((row) => (
                  <tr key={row.id} className="border-b last:border-0">
                    <td className="py-1.5 font-mono text-xs">{row.mid}</td>
                    <td className="py-1.5">
                      {formatText(row.merchant_name)}
                      {row.rep_share_id !== null && (
                        <span
                          className="block break-words text-xs text-muted-foreground"
                          data-testid="statement-share-marker"
                        >
                          {/* The dagger ties the line to the footnote. */}
                          Shared account
                          {shares.has(row.rep_share_id) && (
                            <>
                              {" with "}
                              {shares.get(row.rep_share_id)!.partner_name} · your share{" "}
                              {formatPct(shares.get(row.rep_share_id)!.own_rep_pct)}
                            </>
                          )}
                          {" †"}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {formatMoney(row.volume)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {formatMoney(row.residual_income)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {formatPct(row.rep_split_pct)}
                    </td>
                    <td className="py-1.5 text-right font-medium tabular-nums">
                      {formatMoney(row.rep_payout)}
                    </td>
                  </tr>
                ))}
                {adjustments.length > 0 && (
                  <tr>
                    <th
                      colSpan={6}
                      className="pb-1 pt-4 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground"
                    >
                      Adjustments
                    </th>
                  </tr>
                )}
                {adjustments.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b last:border-0"
                    data-testid="statement-adjustment"
                  >
                    <td className="py-1.5 align-top font-mono text-xs">
                      {row.mid}
                    </td>
                    <td className="py-1.5 align-top" colSpan={4}>
                      {formatText(row.merchant_name)}
                      <span className="block break-words text-xs text-muted-foreground">
                        Corrects {formatPeriod(row.adjusts_period)}
                        {row.adjustment_note
                          ? ` — ${row.adjustment_note}`
                          : ""}
                      </span>
                    </td>
                    <td className="py-1.5 text-right align-top font-medium tabular-nums">
                      {formatMoney(row.rep_payout)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2">
                  <td className="pt-2 text-xs uppercase tracking-wide text-muted-foreground" colSpan={5}>
                    Total payout
                  </td>
                  <td className="pt-2 text-right text-base font-bold tabular-nums">
                    {formatMoney(totals.repPayout)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {anyShared && (
            <p
              className="text-xs text-muted-foreground"
              data-testid="statement-share-footnote"
            >
              † Shared account: the payout is your share of the account&rsquo;s
              rep payout, and the residual shown is your share of the
              account&rsquo;s residual. The account&rsquo;s volume is reported
              on the signer&rsquo;s line.
            </p>
          )}

          <footer className="border-t pt-3 text-xs text-muted-foreground">
            {/* No generation timestamp. It would change on every render, so two
                printouts of an unchanged period would look like different documents
                — and under cacheComponents a non-deterministic value here is its own
                problem. The period is what identifies this statement. */}
            Tapswipe — residual payout summary. Figures as recorded in the CRM for{" "}
            {formatPeriod(period)}.
          </footer>
        </PrintDocument>
      </article>
    </div>
  );
}

export default function SummaryPage({
  params,
}: {
  params: Promise<{ period: string; agentId: string }>;
}) {
  // params passed down unawaited, so the dynamic read stays inside the Suspense
  // boundary cacheComponents requires.
  return (
    <PageShell width="detail">
      <Suspense
        fallback={
          <p className="text-sm text-muted-foreground">Loading summary…</p>
        }
      >
        <Summary params={params} />
      </Suspense>
    </PageShell>
  );
}
