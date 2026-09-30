import Link from "next/link";
import { Suspense } from "react";
import { PlusIcon } from "lucide-react";

import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  LEAD_FILTER_OPTIONS,
  LEAD_LIST_COLUMNS,
  PG_TODAY,
  type LeadListRow,
  nextWeekBound,
  parseLeadFilter,
} from "@/lib/leads";
import { formatDate, formatText } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { FilterTabs } from "@/components/filter-tabs";
import { ListTable, type ListColumn } from "@/components/list-table";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";

async function LeadsList({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  // `status`, not `filter`. Every other list here (merchants, tickets, tasks,
  // bug reports) uses ?status=, and this page was the sole holdout — enough to
  // send someone hand-editing a URL to a page that silently ignored them.
  const { status: rawFilter } = await searchParams;
  const filter = parseLeadFilter(rawFilter);

  const profile = await requireUser();
  const supabase = await createClient();

  // Tier 1: RLS scopes the rows. No agent_id filter here on purpose —
  // duplicating the policy in application code is how the two drift apart.
  let query = supabase
    .from("leads")
    .select(LEAD_LIST_COLUMNS)
    // nullsFirst: false keeps undated leads at the end of the unfiltered list,
    // where they don't push scheduled follow-ups out of view.
    .order("next_followup_date", { ascending: true, nullsFirst: false })
    .order("id", { ascending: false });

  switch (filter) {
    case "overdue":
      query = query.lt("next_followup_date", PG_TODAY);
      break;
    case "today":
      query = query.eq("next_followup_date", PG_TODAY);
      break;
    case "next7":
      query = query
        .gte("next_followup_date", PG_TODAY)
        .lte("next_followup_date", nextWeekBound());
      break;
    case "unscheduled":
      query = query.is("next_followup_date", null);
      break;
    case "all":
      break;
  }

  const { data, error } = await query;

  if (error) {
    return (
      <p className="text-sm text-destructive">
        Could not load leads: {error.message}
      </p>
    );
  }

  const leads = (data ?? []) as LeadListRow[];
  const isAdmin = profile.role === "admin";

  // Admins see whose book each lead is in. Second plain query rather than a
  // PostgREST embed, matching the merchants list: two simple selects are
  // verifiable by the test harness, relationship traversal isn't.
  let agentNames = new Map<string, string>();
  if (isAdmin && leads.length > 0) {
    const agentIds = [...new Set(leads.map((l) => l.agent_id))];
    const { data: agents } = await supabase
      .from("profiles")
      .select("id, full_name")
      .in("id", agentIds);
    agentNames = new Map(
      (agents ?? []).map((a) => [a.id as string, a.full_name as string]),
    );
  }

  const emptyMessage =
    filter === "all"
      ? "No leads yet."
      : filter === "unscheduled"
        ? "Every lead has a follow-up date."
        : "No leads match that follow-up window.";

  // The list's shape as data, so the table and the stacked-card view below lg
  // cannot disagree about it. The admin-only Agent column is appended rather
  // than guarded inline, which also retires the hand-counted
  // `colSpan={isAdmin ? 8 : 7}` the empty row used to carry.
  const columns: ListColumn<LeadListRow>[] = [
    {
      header: "DBA",
      primary: true,
      className: "font-medium",
      cell: (lead) => (
        <Link href={`/leads/${lead.id}`} className="underline underline-offset-4">
          {formatText(lead.dba)}
        </Link>
      ),
    },
    { header: "Contact", cell: (lead) => formatText(lead.contact_name) },
    { header: "Phone", cell: (lead) => formatText(lead.contact_phone) },
    { header: "Source", cell: (lead) => formatText(lead.lead_source) },
    { header: "Industry", cell: (lead) => formatText(lead.industry_vertical) },
    {
      header: "Follow-up",
      className: "text-muted-foreground",
      cell: (lead) => formatDate(lead.next_followup_date),
    },
    {
      header: "Status",
      cell: (lead) => (
        <StatusBadge intent="neutral">{formatText(lead.status)}</StatusBadge>
      ),
    },
    ...(isAdmin
      ? [
          {
            header: "Agent",
            className: "text-muted-foreground",
            cell: (lead: LeadListRow) =>
              formatText(agentNames.get(lead.agent_id)),
          },
        ]
      : []),
  ];

  return (
    <div className="flex flex-col gap-4">
      <FilterTabs
        options={LEAD_FILTER_OPTIONS}
        active={filter}
        hrefFor={(value) => (value === "all" ? "/leads" : `/leads?status=${value}`)}
      />

      <ListTable
        columns={columns}
        rows={leads}
        rowKey={(lead) => lead.id}
        emptyMessage={emptyMessage}
      />
    </div>
  );
}

export default function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  return (
    <PageShell width="list">
      <PageHeader
        title="Leads"
        subtitle="Filtered by follow-up date. Agents see their own; admins see all."
        action={
          <Button asChild size="sm">
            <Link href="/leads/new">
              <PlusIcon size={16} />
              New lead
            </Link>
          </Button>
        }
      />

      {/* cacheComponents: true means the searchParams await and the fetch both
          have to sit inside a Suspense boundary. */}
      <Suspense
        fallback={<p className="text-sm text-muted-foreground">Loading leads…</p>}
      >
        <LeadsList searchParams={searchParams} />
      </Suspense>
    </PageShell>
  );
}
