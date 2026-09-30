import Link from "next/link";
import { Suspense } from "react";
import { PlusIcon } from "lucide-react";

import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  GHOST_SHEET_FILTER_OPTIONS,
  GHOST_SHEET_LIST_COLUMNS,
  type GhostSheetListRow,
  conversionIntent,
  isConverted,
  parseGhostSheetFilter,
} from "@/lib/ghost-sheets";
import { formatDate, formatText } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { FilterTabs } from "@/components/filter-tabs";
import { ListTable, type ListColumn } from "@/components/list-table";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";

async function GhostSheetsList({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const { filter: rawFilter } = await searchParams;
  const filter = parseGhostSheetFilter(rawFilter);

  const profile = await requireUser();
  const supabase = await createClient();

  // Tier 1: RLS scopes the rows; no agent_id filter in application code.
  let query = supabase
    .from("ghost_sheets")
    .select(GHOST_SHEET_LIST_COLUMNS)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });

  // lead_id, not status: it's the column conversion actually writes, so it
  // can't drift from reality the way an unconstrained status string could.
  if (filter === "open") {
    query = query.is("lead_id", null);
  } else if (filter === "converted") {
    query = query.not("lead_id", "is", null);
  }

  const { data, error } = await query;

  if (error) {
    return (
      <p className="text-sm text-destructive">
        Could not load ghost sheets: {error.message}
      </p>
    );
  }

  const sheets = (data ?? []) as GhostSheetListRow[];
  const isAdmin = profile.role === "admin";

  let agentNames = new Map<string, string>();
  if (isAdmin && sheets.length > 0) {
    const agentIds = [...new Set(sheets.map((s) => s.agent_id))];
    const { data: agents } = await supabase
      .from("profiles")
      .select("id, full_name")
      .in("id", agentIds);
    agentNames = new Map(
      (agents ?? []).map((a) => [a.id as string, a.full_name as string]),
    );
  }

  const emptyMessage =
    filter === "all" ? "No ghost sheets yet." : `No ${filter} ghost sheets.`;

  // The list's shape as data, so the table and the stacked-card view below lg
  // cannot disagree about it. The admin-only Agent column is spliced in at its
  // existing position — before Created, not appended — so the column order is
  // unchanged. This also retires the hand-counted `colSpan={isAdmin ? 6 : 5}`
  // the empty row used to carry.
  const columns: ListColumn<GhostSheetListRow>[] = [
    {
      header: "DBA",
      primary: true,
      className: "font-medium",
      cell: (sheet) => (
        <Link
          href={`/ghost-sheets/${sheet.id}`}
          className="underline underline-offset-4"
        >
          {formatText(sheet.dba)}
        </Link>
      ),
    },
    { header: "Contact", cell: (sheet) => formatText(sheet.contact_name) },
    { header: "Phone", cell: (sheet) => formatText(sheet.contact_phone) },
    {
      header: "Converted",
      // Keyed off lead_id via isConverted/conversionIntent, not off status —
      // see lib/ghost-sheets.ts. A converted sheet's badge links to the lead it
      // produced; an unconverted one is a bare badge.
      cell: (sheet) =>
        isConverted(sheet) ? (
          <Link
            href={`/leads/${sheet.lead_id}`}
            className="underline underline-offset-4"
          >
            <StatusBadge intent={conversionIntent(sheet)}>converted</StatusBadge>
          </Link>
        ) : (
          <StatusBadge intent={conversionIntent(sheet)}>open</StatusBadge>
        ),
    },
    ...(isAdmin
      ? [
          {
            header: "Agent",
            className: "text-muted-foreground",
            cell: (sheet: GhostSheetListRow) =>
              formatText(agentNames.get(sheet.agent_id)),
          },
        ]
      : []),
    {
      header: "Created",
      className: "text-muted-foreground",
      cell: (sheet) => formatDate(sheet.created_at),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <FilterTabs
        options={GHOST_SHEET_FILTER_OPTIONS}
        active={filter}
        hrefFor={(value) =>
          value === "all" ? "/ghost-sheets" : `/ghost-sheets?filter=${value}`
        }
      />

      <ListTable
        columns={columns}
        rows={sheets}
        rowKey={(sheet) => sheet.id}
        emptyMessage={emptyMessage}
      />
    </div>
  );
}

export default function GhostSheetsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  return (
    <PageShell width="list">
      <PageHeader
        title="Ghost Sheets"
        subtitle="Lightweight pre-lead capture. Convert one to promote it to a full lead."
        action={
          <Button asChild size="sm">
            <Link href="/ghost-sheets/new">
              <PlusIcon size={16} />
              New ghost sheet
            </Link>
          </Button>
        }
      />

      <Suspense
        fallback={
          <p className="text-sm text-muted-foreground">Loading ghost sheets…</p>
        }
      >
        <GhostSheetsList searchParams={searchParams} />
      </Suspense>
    </PageShell>
  );
}
