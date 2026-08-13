import Link from "next/link";
import { Suspense } from "react";
import { ArrowLeftIcon } from "lucide-react";

import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  BUG_REPORT_FILTER_OPTIONS,
  BUG_REPORT_LIST_COLUMNS,
  BUG_REPORT_OPEN_STATUS,
  DEFAULT_BUG_REPORT_FILTER,
  type BugReport,
  parseBugReportFilter,
} from "@/lib/bug-reports";
import { BugReportsTable } from "@/components/bug-reports-table";
import { FilterTabs } from "@/components/filter-tabs";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { Button } from "@/components/ui/button";

/**
 * The bug-report queue. Reached from the bubble's menu, admin only.
 *
 * Two independent boundaries, as on the users page: requireAdmin() keeps
 * non-admins off the route, and the select policy would return an agent only
 * their own reports even if it were removed.
 */
async function ReportsList({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status: rawStatus } = await searchParams;
  const filter = parseBugReportFilter(rawStatus);

  const viewer = await requireAdmin();

  const supabase = await createClient();
  let query = supabase
    .from("bug_reports")
    .select(BUG_REPORT_LIST_COLUMNS)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });

  // Reports are cleared by status, never deleted, so an unfiltered list shows
  // every dismissed report as live work — the standing cost of the soft-clear
  // design. The default is still the queue; the other tabs exist because the
  // page promises the cleared ones stay on file and previously gave no way to
  // see one.
  if (filter !== "all") {
    query = query.eq("status", filter);
  }

  const { data, error } = await query;

  if (error) {
    return (
      <p className="text-sm text-destructive">
        Could not load reports: {error.message}
      </p>
    );
  }

  const reports = (data ?? []) as BugReport[];

  // Who filed each one. Second plain query rather than a PostgREST embed,
  // matching every other admin list here.
  let reporterNames = new Map<string, string>();
  if (reports.length > 0) {
    const reporterIds = [...new Set(reports.map((r) => r.agent_id))];
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, full_name")
      .in("id", reporterIds);
    reporterNames = new Map(
      (profiles ?? []).map((p) => [p.id as string, p.full_name as string]),
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <FilterTabs
        options={BUG_REPORT_FILTER_OPTIONS}
        active={filter}
        hrefFor={(value) =>
          value === DEFAULT_BUG_REPORT_FILTER
            ? "/admin/bug-reports"
            : `/admin/bug-reports?status=${value}`
        }
      />

      <BugReportsTable
        adminId={viewer.id}
        // Only open reports can be cleared, so the checkboxes and the clear
        // control are meaningless on the other tabs — those are a record, not a
        // queue.
        selectable={filter === BUG_REPORT_OPEN_STATUS}
        reports={reports.map((report) => ({
          ...report,
          reporter_name: reporterNames.get(report.agent_id) ?? null,
        }))}
      />
    </div>
  );
}

export default function BugReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  return (
    <PageShell width="list">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href="/dashboard">
          <ArrowLeftIcon size={16} />
          Back to dashboard
        </Link>
      </Button>

      <PageHeader
        title="Bug reports"
        subtitle="Everything reported through the bubble, newest first. Clearing a report keeps it on file — the Resolved and Dismissed tabs are where it goes."
      />

      <Suspense
        fallback={
          <p className="text-sm text-muted-foreground">Loading reports…</p>
        }
      >
        <ReportsList searchParams={searchParams} />
      </Suspense>
    </PageShell>
  );
}
