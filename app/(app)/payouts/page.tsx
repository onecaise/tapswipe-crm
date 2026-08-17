import Link from "next/link";
import { Suspense } from "react";
import { UploadIcon } from "lucide-react";

import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatMoney, formatPeriod, periodParam } from "@/lib/format";
import { summarizeByPeriod, type PayoutRow } from "@/lib/payouts";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { StatCard } from "@/components/stat-card";
import { StatusBadge } from "@/components/status-badge";
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
 * Periods, newest first. One page, two audiences.
 *
 * An admin sees every rep's rows aggregated per period plus the import action; a
 * rep sees their own periods and their own totals, read-only. The difference is
 * RLS, not a branch in this file: the select policy on rep_payout_rows is
 * `(agent_id = auth.uid() and is_active_agent()) or is_admin()`, so the same query
 * returns different rows for different callers. The only role check here decides
 * whether to render the Import button, which is a UX nicety — /payouts/import
 * enforces its own boundary with requireAdmin().
 */

type PeriodRow = Pick<
  PayoutRow,
  "period" | "volume" | "residual_income" | "rep_split_pct" | "rep_payout"
>;

async function PayoutPeriods() {
  const profile = await requireUser();
  const supabase = await createClient();

  // No agent_id filter, deliberately — adding one would duplicate the policy in
  // application code, where it could drift out of sync with it.
  const { data, error } = await supabase
    .from("rep_payout_rows")
    .select("period, volume, residual_income, rep_split_pct, rep_payout")
    .order("period", { ascending: false });

  if (error) {
    return (
      <p className="text-sm text-destructive">
        Could not load payouts: {error.message}
      </p>
    );
  }

  const periods = summarizeByPeriod((data ?? []) as PeriodRow[]);
  const isAdmin = profile.role === "admin";

  if (periods.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {isAdmin
          ? "No residuals have been imported yet."
          : "You have no residuals recorded yet."}
      </p>
    );
  }

  const overall = periods.reduce(
    (acc, period) => ({
      repPayout: acc.repPayout + period.repPayout,
      unfilled: acc.unfilled + period.unfilled,
    }),
    { repPayout: 0, unfilled: 0 },
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Periods" value={periods.length} />
        <StatCard
          label={isAdmin ? "Total payout" : "Your total payout"}
          value={formatMoney(overall.repPayout)}
        />
        {/* Accented only for an admin, and only because it is the one figure on
            this page that represents outstanding work — rows still waiting for
            someone to enter a residual. A rep cannot act on it, so it stays
            plain for them. */}
        <StatCard
          label="Awaiting figures"
          value={overall.unfilled}
          accent={isAdmin && overall.unfilled > 0}
        />
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Period</TableHead>
            <TableHead>Merchants</TableHead>
            <TableHead>Volume</TableHead>
            <TableHead>Residual income</TableHead>
            <TableHead>{isAdmin ? "Total payout" : "Your payout"}</TableHead>
            <TableHead>Figures</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {periods.map((period) => (
            <TableRow key={period.period}>
              <TableCell className="font-medium">
                <Link
                  href={`/payouts/${periodParam(period.period)}`}
                  className="underline underline-offset-4"
                >
                  {formatPeriod(period.period)}
                </Link>
              </TableCell>
              <TableCell>{period.rows}</TableCell>
              <TableCell>{formatMoney(period.volume)}</TableCell>
              <TableCell>{formatMoney(period.residualIncome)}</TableCell>
              <TableCell className="font-medium">
                {formatMoney(period.repPayout)}
              </TableCell>
              <TableCell>
                {/* A period whose figures are all entered is settled; one with
                    blanks is waiting on someone. Exactly what the two intents
                    mean everywhere else, so no new colour is needed. */}
                {period.unfilled === 0 ? (
                  <StatusBadge intent="success">complete</StatusBadge>
                ) : (
                  <StatusBadge intent="warning">
                    {period.unfilled} to enter
                  </StatusBadge>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

async function ImportAction() {
  const profile = await requireUser();
  if (profile.role !== "admin") return null;

  return (
    <Button asChild size="sm">
      <Link href="/payouts/import">
        <UploadIcon size={16} />
        Import residuals
      </Link>
    </Button>
  );
}

export default function PayoutsPage() {
  return (
    <PageShell width="list">
      <PageHeader
        title="Payouts"
        subtitle="Residual income by period, per merchant. Imported from the processor's monthly report."
        action={
          // Its own Suspense boundary because it reads the session too, and
          // cacheComponents: true means a dynamic read cannot sit outside one.
          <Suspense fallback={null}>
            <ImportAction />
          </Suspense>
        }
      />

      <Suspense
        fallback={
          <p className="text-sm text-muted-foreground">Loading payouts…</p>
        }
      >
        <PayoutPeriods />
      </Suspense>
    </PageShell>
  );
}
