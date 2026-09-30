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
import { ListTable, type ListColumn } from "@/components/list-table";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

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

  // The list's shape as data, so the table and the stacked-card view below lg
  // cannot disagree about it. Both conditional columns keep their existing
  // positions: the select checkbox leads, the Status column trails and appears
  // only on the read-only tabs.
  //
  // The checkbox is a LEADING column, so on a card it sits beside the report's
  // first line rather than under its fields — a control that picks a row belongs
  // next to the row, not below it.
  //
  // whitespace-pre-line moved OFF the column className and onto the rendered
  // node. It is what makes a reporter's line breaks survive, and a primary
  // column's className never reaches the card heading — so leaving it there
  // would have kept line breaks in the table and silently collapsed them on a
  // phone. max-w-md is a table-layout concern and stays on the column.
  const columns: ListColumn<BugReportRow>[] = [
    ...(selectable
      ? [
          {
            header: "",
            leading: true,
            headerClassName: "w-10",
            cell: (report: BugReportRow) => (
              <Checkbox
                checked={selected.has(report.id)}
                disabled={busy}
                aria-label={`Select report ${report.id}`}
                onCheckedChange={() => toggle(report.id)}
              />
            ),
          },
        ]
      : []),
    {
      header: "Report",
      primary: true,
      className: "max-w-md font-medium",
      // React renders this as text, never as markup.
      cell: (report) => (
        <span className="whitespace-pre-line">{report.description}</span>
      ),
    },
    {
      header: "Page",
      className: "text-muted-foreground",
      cell: (report) => report.page,
    },
    {
      header: "Reported by",
      className: "text-muted-foreground",
      cell: (report) => formatText(report.reporter_name),
    },
    {
      header: "When",
      className: "text-muted-foreground",
      cell: (report) => formatDate(report.created_at),
    },
    // Only on the read-only tabs, where "All" mixes the three and the word is
    // the only thing telling them apart.
    ...(!selectable
      ? [
          {
            header: "Status",
            cell: (report: BugReportRow) => (
              <StatusBadge intent={bugReportStatusIntent(report.status)}>
                {report.status}
              </StatusBadge>
            ),
          },
        ]
      : []),
  ];

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

      <ListTable
        columns={columns}
        rows={reports}
        rowKey={(report) => report.id}
        emptyMessage={
          selectable
            ? "Nothing outstanding. Cleared reports stay on file — the Resolved and Dismissed tabs are where they go."
            : "Nothing here yet."
        }
      />
    </div>
  );
}
