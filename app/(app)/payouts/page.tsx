import Link from "next/link";
import { Suspense } from "react";
import { UploadIcon } from "lucide-react";

import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatMoney, formatPeriod, periodParam } from "@/lib/format";
import { summarizeByPeriod, type PayoutRow } from "@/lib/payouts";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { PayoutExportButton } from "@/components/payout-export-button";
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

  // Where "Awaiting figures" should send someone — and only when that question
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
            this page that represents outstanding work — rows still waiting for
            someone to enter a residual. A rep cannot act on it, so it stays
            plain for them.

            Linked for BOTH roles, though, and the asymmetry is deliberate: the
            two props answer different questions. `accent` is about priority, and
            only an admin can act, so only they get the emphasis. `href` is about
            where the figures are — and the period page is useful to a rep too,
            as the place they see WHICH of their merchants is still blank. Both
            roles could already reach it from the period name; this just stops
            the figure naming the work from being the one thing that is inert. */}
        <StatCard
          label="Awaiting figures"
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

                    "N to enter" is a LINK to the period, because it was the one
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
                    // Named rather than left to read as a bare "1 to enter",
                    // which says nothing out of its row. Deliberately NOT "Enter
                    // figures for…": a rep reaches this link too and cannot
                    // enter anything (update on rep_payout_rows is admin-only),
                    // so the label states the fact both roles share and neither
                    // is promised an action they do not have.
                    aria-label={`${formatPeriod(period.period)} — ${period.unfilled} awaiting figures`}
                    className="rounded-full focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <StatusBadge
                      intent="warning"
                      className="transition-opacity hover:opacity-80"
                    >
                      {period.unfilled} to enter
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
    </PageShell>
  );
}
