import { Suspense } from "react";

import { requireUser } from "@/lib/auth";
import { loadTaskIndex } from "@/lib/annotations-data";
import {
  ANNOTATION_INDEX_LIMIT,
  TASK_INDEX_FILTER_OPTIONS,
  parseTaskIndexFilter,
} from "@/lib/annotations";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { FilterTabs } from "@/components/filter-tabs";
import { TasksIndexTable } from "@/components/tasks-index-table";

/**
 * Every task the caller can see, across all four owner types.
 *
 * Unlike notes, tasks have an update policy — `completed` exists to be toggled —
 * so the checkbox works here exactly as it does in the panel. Creation stays on
 * the record pages, where owner_type/owner_id come from a parent row already
 * loaded under RLS.
 */
async function TasksList({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status: rawStatus } = await searchParams;
  const filter = parseTaskIndexFilter(rawStatus);

  const profile = await requireUser();
  const { rows, truncated, error } = await loadTaskIndex(filter);

  if (error) {
    return (
      <p className="text-sm text-destructive">Could not load tasks: {error}</p>
    );
  }

  const emptyMessage =
    filter === "all"
      ? "No tasks yet. Add one from a lead, merchant, pre-app or ghost sheet."
      : filter === "completed"
        ? "Nothing completed yet."
        : filter === "overdue"
          ? "Nothing overdue."
          : "No open tasks.";

  return (
    <div className="flex flex-col gap-4">
      {/* The default is not "all", so every tab carries its param — an explicit
          ?status=all has to survive, the same as the support tickets list. */}
      <FilterTabs
        options={TASK_INDEX_FILTER_OPTIONS}
        active={filter}
        hrefFor={(value) => `/tasks?status=${value}`}
      />

      <TasksIndexTable
        tasks={rows}
        isAdmin={profile.role === "admin"}
        emptyMessage={emptyMessage}
      />

      {truncated && (
        <p className="text-sm text-muted-foreground">
          Showing {ANNOTATION_INDEX_LIMIT} tasks. Narrow the filter, or work from
          the record itself.
        </p>
      )}
    </div>
  );
}

export default function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  return (
    <PageShell width="list">
      <PageHeader
        title="Tasks"
        subtitle="Tasks across every lead, merchant, pre-app and ghost sheet. Agents see their own; admins see all."
      />

      {/* cacheComponents: true means the searchParams await and the fetch both
          have to sit inside a Suspense boundary. */}
      <Suspense
        fallback={<p className="text-sm text-muted-foreground">Loading tasks…</p>}
      >
        <TasksList searchParams={searchParams} />
      </Suspense>
    </PageShell>
  );
}
