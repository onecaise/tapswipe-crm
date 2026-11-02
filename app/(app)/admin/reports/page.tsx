import Link from "next/link";
import { Suspense } from "react";

import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatDate, formatPeriod } from "@/lib/format";
import { loadProcessors } from "@/lib/processors";
import {
  REPORT_TABS,
  detailKey,
  parseReportFilters,
  reportsHref,
  type MerchantSummaryRow,
  type OverrideDetail,
  type RepSummaryRow,
} from "@/lib/reports";
import { Callout } from "@/components/callout";
import { FilterTabs } from "@/components/filter-tabs";
import { MerchantProcessorReport } from "@/components/merchant-processor-report";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { PrintButton } from "@/components/print-button";
import { ReportFilterBar } from "@/components/report-filters";
import { RepPayoutReport } from "@/components/rep-payout-report";
import { StatusBadge } from "@/components/status-badge";

/**
 * /admin/reports: the rep payout summary and merchants by processor (phase 12
 * of docs/design/intake-and-reports.md, §7.2).
 *
 * Admin-only twice over: requireAdmin() sends anyone else to /dashboard, as
 * every admin page does, and both SQL functions refuse a non-admin (PT403)
 * whatever this page does. They are security invoker, so RLS scopes every
 * row they read as well.
 *
 * Committed months only, read from the ledger (memo §7.2): never a batch in
 * review, abandoned, replaced or deleted. The figures and totals are the
 * functions' rows; this page formats them. Printing is the export (§7.2: an
 * XLSX download only if asked).
 */

type SearchParams = { report?: string; from?: string; to?: string; processor?: string };

type Batch = { id: number; processor: string; period: string };

async function Reports({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  await requireAdmin();
  const supabase = await createClient();

  const [processors, batchesResult] = await Promise.all([
    loadProcessors(supabase),
    supabase
      .from("rep_payout_batches")
      .select("id, processor, period")
      .eq("status", "committed")
      .order("period", { ascending: false }),
  ]);
  if (batchesResult.error) {
    return <p className="text-sm text-destructive">Could not load the committed months: {batchesResult.error.message}</p>;
  }
  const batches = (batchesResult.data ?? []) as Batch[];
  const months = [...new Set(batches.map((b) => b.period))];

  if (months.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="reports-empty">
        No residual month has been committed yet. The reports read committed months only.
      </p>
    );
  }

  const parsed = parseReportFilters(params, months[0], processors.map((p) => p.code));
  if (!parsed.ok) {
    return (
      <Callout tone="warning">
        {parsed.message}{" "}
        <Link href="/admin/reports" className="underline underline-offset-4">
          Show the latest month
        </Link>
      </Callout>
    );
  }
  const filters = parsed.filters;
  const multiMonth = filters.from !== filters.to;
  const range = multiMonth ? `${formatPeriod(filters.from)} to ${formatPeriod(filters.to)}` : formatPeriod(filters.from);
  const scope = filters.processor ?? "all processors";

  // The processor-months the selection covers, and whether each is marked paid.
  const inRange = batches.filter(
    (b) => b.period >= filters.from && b.period <= filters.to
      && (filters.processor === null || b.processor === filters.processor),
  );
  const closures = await supabase
    .from("payout_period_closures")
    .select("period, processor, closed_at")
    .gte("period", filters.from)
    .lte("period", filters.to);
  if (closures.error) {
    return <p className="text-sm text-destructive">Could not load which months are paid: {closures.error.message}</p>;
  }
  const paid = new Map(
    ((closures.data ?? []) as { period: string; processor: string; closed_at: string }[]).map(
      (c) => [`${c.processor}|${c.period}`, c.closed_at],
    ),
  );

  const args = {
    period_from_input: filters.from,
    period_to_input: filters.to,
    processor_input: filters.processor,
  };

  let body: React.ReactNode;
  if (filters.report === "reps") {
    const { data, error } = await supabase.rpc("rep_payout_summary", args);
    if (error) return <p className="text-sm text-destructive">Could not load the report: {error.message}</p>;
    const rows = (data ?? []) as RepSummaryRow[];
    const details = rows.length === 0 ? {} : await loadOverrideDetail(supabase, inRange.map((b) => b.id), filters);
    body = rows.length === 0
      ? <EmptySelection range={range} scope={scope} />
      : <RepPayoutReport rows={rows} details={details} multiMonth={multiMonth} />;
  } else {
    const { data, error } = await supabase.rpc("merchant_processor_summary", args);
    if (error) return <p className="text-sm text-destructive">Could not load the report: {error.message}</p>;
    const rows = (data ?? []) as MerchantSummaryRow[];
    body = rows.length === 0
      ? <EmptySelection range={range} scope={scope} />
      : <MerchantProcessorReport rows={rows} paid={paid} multiMonth={multiMonth} />;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="print:hidden">
        <FilterTabs
          options={REPORT_TABS}
          active={filters.report}
          hrefFor={(value) => reportsHref({ ...filters, report: value })}
        />
      </div>
      <ReportFilterBar filters={filters} months={months} processors={processors} />

      <div className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold" data-testid="report-heading">
          {REPORT_TABS.find((t) => t.value === filters.report)!.label} · {range} · {scope}
        </h2>
        {inRange.length > 0 && (
          <ul className="flex flex-wrap gap-2 text-xs" aria-label="Paid state of each processor-month" data-testid="report-paid-states">
            {inRange.map((b) => {
              const closedAt = paid.get(`${b.processor}|${b.period}`);
              return (
                <li key={b.id} className="flex items-center gap-1.5 rounded-full border px-2.5 py-1">
                  {b.processor} {formatPeriod(b.period)}
                  {closedAt ? (
                    <StatusBadge intent="success">paid {formatDate(closedAt)}</StatusBadge>
                  ) : (
                    <StatusBadge intent="warning">not marked paid</StatusBadge>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {body}
    </div>
  );
}

function EmptySelection({ range, scope }: { range: string; scope: string }) {
  return (
    <p className="text-sm text-muted-foreground" data-testid="reports-empty">
      Nothing is committed for {range}, {scope}.
    </p>
  );
}

/**
 * The override lines behind Report 1's plus (memo §4.5's detail row): each
 * one from a committed batch of the selection, with its percent and the
 * person on the other side. Display only; no figure here is summed.
 */
async function loadOverrideDetail(
  supabase: Awaited<ReturnType<typeof createClient>>,
  batchIds: number[],
  filters: { from: string; to: string },
): Promise<Record<string, OverrideDetail[]>> {
  if (batchIds.length === 0) return {};
  const { data: lineData } = await supabase
    .from("rep_payout_rows")
    .select("id, agent_id, period, mid, merchant_name, batch_id, override_id, override_role, override_amount")
    .eq("line_kind", "override")
    .in("batch_id", batchIds)
    .gte("period", filters.from)
    .lte("period", filters.to)
    .order("mid");
  type Line = {
    id: number; agent_id: string; period: string; mid: string; merchant_name: string | null;
    batch_id: number; override_id: number; override_role: "debit" | "credit"; override_amount: number | null;
  };
  const lines = (lineData ?? []) as Line[];
  if (lines.length === 0) return {};

  const overrideIds = [...new Set(lines.map((l) => l.override_id))];
  const { data: overrideData } = await supabase
    .from("merchant_overrides")
    .select("id, override_pct, recipient_id")
    .in("id", overrideIds);
  const overrides = new Map(
    ((overrideData ?? []) as { id: number; override_pct: number; recipient_id: string }[]).map((o) => [o.id, o]),
  );
  const people = [...new Set([...lines.map((l) => l.agent_id), ...[...overrides.values()].map((o) => o.recipient_id)])];
  const { data: profileData } = await supabase.from("profiles").select("id, full_name").in("id", people);
  const names = new Map(((profileData ?? []) as { id: string; full_name: string }[]).map((p) => [p.id, p.full_name]));

  // Who carries each override in a batch: the debit lines' reps.
  const debtors = new Map<string, string[]>();
  for (const line of lines.filter((l) => l.override_role === "debit")) {
    const key = `${line.batch_id}|${line.override_id}`;
    debtors.set(key, [...(debtors.get(key) ?? []), names.get(line.agent_id) ?? "a rep"]);
  }

  const details: Record<string, OverrideDetail[]> = {};
  for (const line of lines) {
    const override = overrides.get(line.override_id);
    const counterpart = line.override_role === "debit"
      ? (override ? names.get(override.recipient_id) ?? null : null)
      : [...(debtors.get(`${line.batch_id}|${line.override_id}`) ?? [])].sort().join(" and ") || null;
    const key = detailKey(line.agent_id, line.period);
    (details[key] ??= []).push({
      id: line.id,
      role: line.override_role,
      mid: line.mid,
      merchant_name: line.merchant_name,
      pct: override?.override_pct ?? null,
      counterpart,
      amount: line.override_amount,
    });
  }
  return details;
}

export default function ReportsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  return (
    <PageShell width="list">
      <PageHeader
        title="Reports"
        subtitle="Committed residual months only. Every figure is read from the payout ledger, so it matches the reps' statements."
        action={
          <div className="print:hidden">
            <PrintButton />
          </div>
        }
      />
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading reports…</p>}>
        <Reports searchParams={searchParams} />
      </Suspense>
    </PageShell>
  );
}
