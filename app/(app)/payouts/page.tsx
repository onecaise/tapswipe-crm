import Link from "next/link";
import { Suspense } from "react";
import { UploadIcon } from "lucide-react";

import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatMoney, formatPeriod, periodParam } from "@/lib/format";
import { payoutMonthLabel, summarizeByPeriod, type PayoutRow } from "@/lib/payouts";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { PayoutAdjustmentForm } from "@/components/payout-adjustment-form";
import { PayoutExportButton } from "@/components/payout-export-button";
import { PayoutMonthPaid } from "@/components/payout-month-paid";
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
  | "period"
  | "volume"
  | "residual_income"
  | "rep_split_pct"
  | "rep_payout"
  | "line_kind"
>;

async function PayoutPeriods() {
  const profile = await requireUser();
  const supabase = await createClient();

  // No agent_id filter, deliberately — adding one would duplicate the policy in
  // application code, where it could drift out of sync with it.
  const { data, error } = await supabase
    .from("rep_payout_rows")
    .select("period, volume, residual_income, rep_split_pct, rep_payout, line_kind")
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

  // Where "Lines with no figure" should send someone — and only when that question
  // has one answer. The card totals unfilled rows across every period, so it is
  // a link exactly while a single period is waiting, which is the ordinary case
  // (one import, one month, many blank rows). With two months outstanding an
  // admin genuinely has to choose, and picking one for them would be a card
  // reading 5 that lands on a page showing 2. The per-period badges below are
  // linked either way, so nothing becomes unreachable when this is undefined.
  const unfilledPeriods = periods.filter((period) => period.unfilled > 0);
  const soleUnfilledHref =
    unfilledPeriods.length === 1
      ? `/payouts/${periodParam(unfilledPeriods[0].period)}`
      : undefined;

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Periods" value={periods.length} />
        <StatCard
          label={isAdmin ? "Total payout" : "Your total payout"}
          value={formatMoney(overall.repPayout)}
        />
        {/* Accented only for an admin, and only because it is the one figure on
            this page that flags a problem — lines with no residual or rate,
            which since 20261102140000 nobody edits: an admin fixes the month
            by replacing it, or by an adjustment once it is paid. A rep cannot
            act on it, so it stays plain for them.

            Linked for BOTH roles, though, and the asymmetry is deliberate: the
            two props answer different questions. `accent` is about priority, and
            only an admin can act, so only they get the emphasis. `href` is about
            where the figures are — and the period page is useful to a rep too,
            as the place they see WHICH of their merchants is still blank. Both
            roles could already reach it from the period name; this just stops
            the figure naming the work from being the one thing that is inert. */}
        <StatCard
          label="Lines with no figure"
          value={overall.unfilled}
          accent={isAdmin && overall.unfilled > 0}
          href={soleUnfilledHref}
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
                    mean everywhere else, so no new colour is needed.

                    The count is a LINK to the period, because it was the one
                    thing on this page naming the outstanding work and the one
                    thing that could not be clicked — the period name in the
                    first column was the only way in, and it reads as a label
                    rather than as the place the work is done. Only the warning
                    branch links: "complete" names no work, so a link from it
                    would be decoration.

                    Wrapped rather than given an href prop, so StatusBadge stays
                    a presentational span with no opinion about navigation — the
                    same reason StatCard's href is opt-in. */}
                {period.unfilled === 0 ? (
                  <StatusBadge intent="success">complete</StatusBadge>
                ) : (
                  <Link
                    href={`/payouts/${periodParam(period.period)}`}
                    // Named rather than left to read as a bare count, which says
                    // nothing out of its row. It states a fact and promises no
                    // action: nobody enters a figure (20261102140000); a month
                    // is fixed by a replace, or an adjustment once paid.
                    aria-label={`${formatPeriod(period.period)} — ${period.unfilled} with no figure`}
                    className="rounded-full focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <StatusBadge
                      intent="warning"
                      className="transition-opacity hover:opacity-80"
                    >
                      {period.unfilled} with no figure
                    </StatusBadge>
                  </Link>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * Every committed processor-month, with whether it is marked paid and the two
 * actions (memo §3.2, A8), and the adjustment form on a paid one (§3.3).
 * Admin-only by requireUser's role AND by RLS: rep_payout_batches and
 * payout_period_closures are admin-SELECT tables, so a rep's query would
 * return nothing here anyway.
 *
 * Paid is per processor and month because a file is: TSYS July can be paid
 * while Square July is still being corrected.
 */
async function ProcessorMonths() {
  const profile = await requireUser();
  if (profile.role !== "admin") return null;

  const supabase = await createClient();
  const [batches, closures, reps] = await Promise.all([
    supabase
      .from("rep_payout_batches")
      .select("id, file_name, processor, period, committed_at")
      .eq("status", "committed")
      .order("period", { ascending: false })
      .order("processor", { ascending: true }),
    supabase.from("payout_period_closures").select("period, processor, closed_at"),
    supabase
      .from("profiles")
      .select("id, full_name")
      .eq("is_active", true)
      .order("full_name", { ascending: true }),
  ]);

  const error = batches.error ?? closures.error ?? reps.error;
  if (error) {
    return (
      <p className="text-sm text-destructive">
        Could not load the processor months: {error.message}
      </p>
    );
  }

  type Month = { id: number; file_name: string; processor: string; period: string; committed_at: string | null };
  const months = (batches.data ?? []) as Month[];
  if (months.length === 0) return null;

  const paid = new Map(
    ((closures.data ?? []) as { period: string; processor: string; closed_at: string }[]).map(
      (c) => [`${c.processor}|${c.period}`, c.closed_at],
    ),
  );
  const activeReps = (reps.data ?? []) as { id: string; full_name: string }[];

  return (
    <section className="flex flex-col gap-3" aria-labelledby="processor-months">
      <div>
        <h2 id="processor-months" className="text-base font-semibold tracking-tight">
          Processor months
        </h2>
        <p className="text-sm text-muted-foreground">
          Until a month is marked paid it can be replaced (upload the corrected file) or
          deleted. Once paid, it is corrected with an adjustment.
        </p>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Month</TableHead>
            <TableHead>Processor</TableHead>
            <TableHead>Import</TableHead>
            <TableHead>Paid</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {months.map((month) => {
            const closedAt = paid.get(`${month.processor}|${month.period}`) ?? null;
            return (
              <TableRow key={month.id} data-testid="processor-month">
                <TableCell className="whitespace-nowrap font-medium">
                  {formatPeriod(month.period)}
                </TableCell>
                <TableCell>{month.processor}</TableCell>
                <TableCell>
                  <Link
                    href={`/payouts/import/${month.id}`}
                    className="block max-w-[22ch] truncate underline underline-offset-4"
                    title={month.file_name}
                  >
                    {month.file_name}
                  </Link>
                </TableCell>
                <TableCell className="whitespace-normal">
                  <div className="flex min-w-0 flex-col gap-2">
                    <PayoutMonthPaid
                      period={month.period}
                      processor={month.processor}
                      label={payoutMonthLabel(month.processor, month.period)}
                      closedAt={closedAt}
                    />
                    {closedAt !== null && (
                      <PayoutAdjustmentForm
                        period={month.period}
                        processor={month.processor}
                        reps={activeReps}
                      />
                    )}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </section>
  );
}

async function HeaderActions() {
  const profile = await requireUser();

  return (
    <div className="flex items-start gap-2">
      {/* Every period the caller can see, in one file. Scoped by RLS, so this is
          the whole company for an admin and their own book for a rep. */}
      <PayoutExportButton label="Export all" />
      {profile.role === "admin" && (
        <Button asChild size="sm">
          <Link href="/payouts/import">
            <UploadIcon size={16} />
            Import residuals
          </Link>
        </Button>
      )}
    </div>
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
            <HeaderActions />
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

      <Suspense fallback={null}>
        <ProcessorMonths />
      </Suspense>
    </PageShell>
  );
}
