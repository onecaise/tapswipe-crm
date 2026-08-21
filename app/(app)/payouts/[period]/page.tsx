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
  periodParam,
} from "@/lib/format";
import {
  PAYOUT_ROW_COLUMNS,
  parsePeriodParam,
  payoutTotals,
  type PayoutRow,
} from "@/lib/payouts";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { PayoutBulkSplit } from "@/components/payout-bulk-split";
import { PayoutExportButton } from "@/components/payout-export-button";
import { PayoutFigureCell } from "@/components/payout-figure-cell";
import { PayoutPeriodDelete } from "@/components/payout-period-delete";
import { StatCard } from "@/components/stat-card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * One period's ledger, grouped by rep.
 *
 * Role-aware through RLS rather than through a branch here: an admin's query
 * returns every rep's rows and a rep's returns their own, so the grouping code is
 * the same and a rep simply gets one group. The figures are read-only in this
 * commit; inline editing and the per-agent bulk split arrive with
 * commit-residual-import.
 */

type Rep = { id: string; full_name: string; agent_number: string | null };

type Group = {
  agentId: string;
  rep: Rep | undefined;
  rows: PayoutRow[];
};

function groupByAgent(rows: PayoutRow[], reps: Map<string, Rep>): Group[] {
  const byAgent = new Map<string, PayoutRow[]>();

  for (const row of rows) {
    const existing = byAgent.get(row.agent_id);
    if (existing) {
      existing.push(row);
    } else {
      byAgent.set(row.agent_id, [row]);
    }
  }

  return [...byAgent.entries()]
    .map(([agentId, group]) => ({
      agentId,
      rep: reps.get(agentId),
      rows: group,
    }))
    // By rep name, so an admin reading a long period gets a stable order rather
    // than whatever the processor's file happened to be sorted by.
    .sort((a, b) =>
      (a.rep?.full_name ?? "").localeCompare(b.rep?.full_name ?? ""),
    );
}

async function PeriodLedger({
  params,
}: {
  params: Promise<{ period: string }>;
}) {
  const { period: periodSegment } = await params;
  const period = parsePeriodParam(periodSegment);

  // A malformed segment is a 404, not a fallback to some default period. Showing
  // one month's figures under another month's URL is the kind of wrong that gets
  // paid out before anyone notices.
  if (period === null) notFound();

  const profile = await requireUser();
  const isAdmin = profile.role === "admin";
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("rep_payout_rows")
    .select(PAYOUT_ROW_COLUMNS)
    .eq("period", period)
    .order("mid", { ascending: true });

  if (error) {
    return (
      <p className="text-sm text-destructive">
        Could not load this period: {error.message}
      </p>
    );
  }

  const rows = (data ?? []) as PayoutRow[];

  // No rows the caller may see and no rows at all are deliberately the same
  // answer. Distinguishing them would turn this URL into an oracle for which
  // periods exist and how much other reps earned in them — the same reasoning the
  // merchants detail page gives for 404-over-403.
  if (rows.length === 0) notFound();

  const agentIds = [...new Set(rows.map((row) => row.agent_id))];
  const { data: repData } = await supabase
    .from("profiles")
    .select("id, full_name, agent_number")
    .in("id", agentIds);

  const reps = new Map<string, Rep>(
    ((repData ?? []) as Rep[]).map((rep) => [rep.id, rep]),
  );

  const groups = groupByAgent(rows, reps);
  const overall = payoutTotals(rows);

  return (
    <div className="flex flex-col gap-8">
      {/* The header lives inside the boundary because its title comes from the
          period, which is dynamic data — awaiting params in the default export
          would put that access outside the Suspense boundary and cacheComponents
          rejects it at build time. */}
      <PageHeader
        title={formatPeriod(period)}
        subtitle="Residual income per merchant, grouped by rep."
        action={
          <div className="flex items-start gap-2">
            {/* Not admin-only: the export is scoped by RLS, so a rep exporting
                gets their own rows. And it is the bulk-entry path for an admin —
                export, fill the two columns in Excel, upload it again. */}
            <PayoutExportButton period={period} label="Export XLSX" />
            {isAdmin && (
              <PayoutPeriodDelete
                period={period}
                rowCount={overall.rows}
                filledCount={overall.rows - overall.unfilled}
              />
            )}
          </div>
        }
      />

      <div className="grid gap-3 sm:grid-cols-4">
        <StatCard label="Merchants" value={overall.rows} />
        <StatCard label="Volume" value={formatMoney(overall.volume)} />
        <StatCard
          label="Residual income"
          value={formatMoney(overall.residualIncome)}
        />
        <StatCard label="Payout" value={formatMoney(overall.repPayout)} />
      </div>

      {groups.map((group) => {
        const totals = payoutTotals(group.rows);

        return (
          <section key={group.agentId} className="flex flex-col gap-3">
            <div className="flex items-baseline justify-between gap-4">
              <h2 className="text-base font-semibold tracking-tight">
                {group.rep?.full_name ?? "Unknown rep"}
                {/* The agent number, because it is what the processor's report
                    says and what an admin reconciles against. Monospace so 0/O
                    and 1/l are separable. */}
                <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">
                  {group.rep?.agent_number ?? EMPTY}
                </span>
              </h2>
              <div className="flex flex-col items-end gap-1.5">
                <p className="text-sm text-muted-foreground">
                  {totals.rows} merchant{totals.rows === 1 ? "" : "s"} ·{" "}
                  <span className="font-medium text-foreground">
                    {formatMoney(totals.repPayout)}
                  </span>
                  {totals.unfilled > 0 && (
                    <> · {totals.unfilled} awaiting figures</>
                  )}
                  {" · "}
                  <Link
                    href={`/payouts/${periodParam(period)}/summary/${group.agentId}`}
                    className="underline underline-offset-4"
                  >
                    Payout summary
                  </Link>
                </p>
                {/* The common case in one action: a rep's split is usually the
                    same percentage on every merchant, and typing it forty times
                    is how a wrong one gets missed. */}
                {isAdmin && (
                  <PayoutBulkSplit
                    period={period}
                    agentId={group.agentId}
                    repName={group.rep?.full_name ?? "this rep"}
                    rowCount={totals.rows}
                  />
                )}
              </div>
            </div>

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>MID</TableHead>
                  <TableHead>Merchant</TableHead>
                  <TableHead>Volume</TableHead>
                  <TableHead>Avg ticket</TableHead>
                  <TableHead>Total cost</TableHead>
                  <TableHead>Residual income</TableHead>
                  <TableHead>Split</TableHead>
                  <TableHead>Payout</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {group.rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-mono text-xs">
                      {row.mid}
                    </TableCell>
                    <TableCell>
                      {/* Links through only when the MID matched a merchant
                          record. An unmatched MID is ordinary — a residual
                          report legitimately names merchants nobody entered —
                          so it renders as plain text rather than a dead link. */}
                      {row.merchant_id === null ? (
                        formatText(row.merchant_name)
                      ) : (
                        <Link
                          href={`/merchants/${row.merchant_id}`}
                          className="underline underline-offset-4"
                        >
                          {formatText(row.merchant_name)}
                        </Link>
                      )}
                    </TableCell>
                    <TableCell>{formatMoney(row.volume)}</TableCell>
                    <TableCell>{formatMoney(row.average_ticket)}</TableCell>
                    <TableCell>
                      <Money value={row.total_cost} />
                    </TableCell>
                    {/* The two hand-entered figures: editable for an admin, read
                        for a rep. Not a security boundary — update on
                        rep_payout_rows is admin-only by policy, so a rep who
                        reached the control would have their write filtered to
                        nothing, which is what the cell's count check catches. */}
                    <TableCell>
                      {isAdmin ? (
                        <PayoutFigureCell
                          rowId={row.id}
                          field="residual_income"
                          value={row.residual_income}
                          merchantName={row.merchant_name}
                        />
                      ) : (
                        <Money value={row.residual_income} />
                      )}
                    </TableCell>
                    <TableCell>
                      {isAdmin ? (
                        <PayoutFigureCell
                          rowId={row.id}
                          field="rep_split_pct"
                          value={row.rep_split_pct}
                          merchantName={row.merchant_name}
                        />
                      ) : (
                        formatPct(
                          row.rep_split_pct === null
                            ? null
                            : Number(row.rep_split_pct),
                        )
                      )}
                    </TableCell>
                    <TableCell className="font-medium">
                      <Money value={row.rep_payout} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>
        );
      })}
    </div>
  );
}

/**
 * A money cell that marks a negative.
 *
 * `destructive`, not a status colour: the status palette is for state
 * vocabularies, and a clawback is a value rather than a state. It is also not a
 * badge — every figure in these columns is money, so only the sign needs to stand
 * out.
 */
function Money({ value }: { value: number | null }) {
  const negative = value !== null && value < 0;
  return (
    <span className={negative ? "text-destructive" : undefined}>
      {formatMoney(value)}
    </span>
  );
}

export default function PeriodPage({
  params,
}: {
  params: Promise<{ period: string }>;
}) {
  // params is passed down unawaited on purpose. Awaiting it here would put
  // dynamic data access outside the Suspense boundary, which cacheComponents
  // rejects at build time — the same shape the merchants detail page uses, and
  // the reason PageHeader is rendered by the child rather than here.
  return (
    <PageShell width="detail">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href="/payouts">
          <ArrowLeftIcon size={16} />
          All periods
        </Link>
      </Button>

      <Suspense
        fallback={
          <p className="text-sm text-muted-foreground">Loading period…</p>
        }
      >
        <PeriodLedger params={params} />
      </Suspense>
    </PageShell>
  );
}
