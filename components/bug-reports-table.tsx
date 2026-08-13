"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { createClient } from "@/lib/supabase/client";
import {
  BUG_REPORT_RESOLUTIONS,
  BUG_REPORT_RESOLUTION_LABELS,
  type BugReport,
  type BugReportResolution,
  bugReportStatusIntent,
} from "@/lib/bug-reports";
import { formatDate, formatText } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export type BugReportRow = BugReport & { reporter_name: string | null };

/**
 * The admin queue: check reports off, confirm, and they leave the list.
 *
 * "Leave the list" is exactly what happens — the update sets status, and the row
 * stays. Nothing here deletes, there is no delete policy, and the copy says so
 * rather than implying otherwise, because a control labelled "remove" that
 * quietly keeps the data is its own kind of lie.
 *
 * The confirm is the repo's inline two-step, not a modal: same reasoning as
 * user-row-actions.tsx and owners-step.tsx, and the same reason the bubble is a
 * panel. The design system asks for a confirmation before anything destructive,
 * and clearing someone else's report qualifies even though the row survives.
 */
export function BugReportsTable({
  reports,
  adminId,
  selectable = true,
}: {
  reports: BugReportRow[];
  /** The viewer's own profile id, recorded as resolved_by. */
  adminId: string;
  /**
   * Whether rows can be picked and cleared. False on the Resolved, Dismissed
   * and All tabs: only an open report has anywhere to go, so offering the
   * checkboxes there would be a control that does nothing.
   */
  selectable?: boolean;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: number) => {
    setConfirming(false);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clear = async (resolution: BugReportResolution) => {
    setBusy(true);
    setError(null);

    const supabase = createClient();
    // count: "exact" — RLS filters rather than erroring, so an update the
    // "admin resolves" policy declines would otherwise look like it worked
    // until the next refresh.
    const { error: updateError, count } = await supabase
      .from("bug_reports")
      .update(
        {
          status: resolution,
          resolved_at: new Date().toISOString(),
          // The policy already proved the caller is an admin; this records
          // which one, so the queue can answer "who dismissed this" without
          // reading audit_log. The trail there is the copy that cannot be
          // edited afterwards.
          resolved_by: adminId,
        },
        { count: "exact" },
      )
      .in("id", [...selected]);

    if (updateError || count === 0) {
      setError(updateError?.message ?? "Those reports could not be cleared.");
      setBusy(false);
      return;
    }

    setSelected(new Set());
    setConfirming(false);
    setBusy(false);
    router.refresh();
  };

  return (
    <div className="flex flex-col gap-4">
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card p-3">
          <span className="text-sm">
            {selected.size} selected. Clearing keeps the report on file and
            removes it from this queue.
          </span>

          {confirming ? (
            <div className="flex items-center gap-2">
              {/* Only "resolved" carries the primary fill. These two sit side by
                  side and mean opposite things, so rendering both in the brand
                  red made the pair a coin toss — the same misclick the design
                  system keeps primary and destructive apart to prevent. */}
              {BUG_REPORT_RESOLUTIONS.map((resolution) => (
                <Button
                  key={resolution}
                  size="sm"
                  variant={resolution === "resolved" ? "default" : "outline"}
                  disabled={busy}
                  onClick={() => void clear(resolution)}
                >
                  {busy ? "Clearing…" : BUG_REPORT_RESOLUTION_LABELS[resolution]}
                </Button>
              ))}
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button size="sm" onClick={() => setConfirming(true)}>
              Clear selected
            </Button>
          )}
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Table>
        <TableHeader>
          <TableRow>
            {selectable && <TableHead className="w-10" />}
            <TableHead>Report</TableHead>
            <TableHead>Page</TableHead>
            <TableHead>Reported by</TableHead>
            <TableHead>When</TableHead>
            {!selectable && <TableHead>Status</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {reports.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="text-muted-foreground">
                {selectable
                  ? "Nothing outstanding. Cleared reports stay on file — the Resolved and Dismissed tabs are where they go."
                  : "Nothing here yet."}
              </TableCell>
            </TableRow>
          ) : (
            reports.map((report) => (
              <TableRow key={report.id}>
                {selectable && (
                  <TableCell>
                    <Checkbox
                      checked={selected.has(report.id)}
                      disabled={busy}
                      aria-label={`Select report ${report.id}`}
                      onCheckedChange={() => toggle(report.id)}
                    />
                  </TableCell>
                )}
                {/* whitespace-pre-line so line breaks survive. React renders
                    this as text, never as markup. */}
                <TableCell className="max-w-md whitespace-pre-line font-medium">
                  {report.description}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {report.page}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatText(report.reporter_name)}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDate(report.created_at)}
                </TableCell>
                {/* Only on the read-only tabs, where "All" mixes the three and
                    the word is the only thing telling them apart. */}
                {!selectable && (
                  <TableCell>
                    <StatusBadge intent={bugReportStatusIntent(report.status)}>
                      {report.status}
                    </StatusBadge>
                  </TableCell>
                )}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
