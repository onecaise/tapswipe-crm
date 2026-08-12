import Link from "next/link";
import { Suspense } from "react";
import { ArrowLeftIcon } from "lucide-react";

import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  BUG_REPORT_LIST_COLUMNS,
  BUG_REPORT_OPEN_STATUS,
  type BugReport,
} from "@/lib/bug-reports";
import { BugReportsTable } from "@/components/bug-reports-table";
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
async function ReportsList() {
  const viewer = await requireAdmin();

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("bug_reports")
    .select(BUG_REPORT_LIST_COLUMNS)
    // The queue filter. Reports are cleared by status, never deleted, so
    // without this the list would show every dismissed report as live work —
    // the standing cost of the soft-clear design, paid here and in
    // lib/bug-reports.ts.
    .eq("status", BUG_REPORT_OPEN_STATUS)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });

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
    <BugReportsTable
      adminId={viewer.id}
      reports={reports.map((report) => ({
        ...report,
        reporter_name: reporterNames.get(report.agent_id) ?? null,
      }))}
    />
  );
}

export default function BugReportsPage() {
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
        subtitle="Everything reported through the bubble, newest first. Clearing a report keeps it on file — it leaves this queue rather than being deleted."
      />

      <Suspense
        fallback={
          <p className="text-sm text-muted-foreground">Loading reports…</p>
        }
      >
        <ReportsList />
      </Suspense>
    </PageShell>
  );
}
