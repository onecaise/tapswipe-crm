import Link from "next/link";
import { Suspense } from "react";
import { PlusIcon } from "lucide-react";

import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  LEAD_FOLLOWUP_FILTER_OPTIONS,
  LEAD_LIST_COLUMNS,
  LEAD_STATUS_FILTER_OPTIONS,
  LEAD_STATUS_LABELS,
  PG_TODAY,
  type LeadListRow,
  isLeadStatus,
  leadsHref,
  nextWeekBound,
  parseLeadFollowupFilter,
  parseLeadStatusFilter,
  statusIntent,
} from "@/lib/leads";
import { formatDate, formatStatus, formatText } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { FilterTabs } from "@/components/filter-tabs";
import { ListTable, type ListColumn } from "@/components/list-table";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";

type LeadsSearchParams = Promise<{ status?: string; followup?: string }>;

async function LeadsList({
  searchParams,
}: {
  searchParams: LeadsSearchParams;
}) {
  // Two independent filters, two params. `?status=` is the pipeline stage, which
  // is what every other list page here means by that name; the follow-up window
  // it used to hold moved to `?followup=` when leads got a real status
  // vocabulary — see lib/leads.ts.
  const { status: rawStatus, followup: rawFollowup } = await searchParams;
  const status = parseLeadStatusFilter(rawStatus);
  const followup = parseLeadFollowupFilter(rawFollowup);

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

  if (status !== "all") {
    query = query.eq("status", status);
  }

  switch (followup) {
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

  // Names which filter came up empty rather than saying "no leads" over a
  // filtered view, which reads as an empty book. With two filters the stage is
  // the one to name first — it is the one a rep just clicked.
  const emptyMessage =
    status !== "all"
      ? `No leads at ${LEAD_STATUS_LABELS[status].toLowerCase()}${
          followup === "all" ? "" : " in that follow-up window"
        }.`
      : followup === "all"
        ? "No leads yet."
        : followup === "unscheduled"
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
      header: "Stage",
      cell: (lead) => (
        <StatusBadge intent={statusIntent(lead.status)}>
          {/* leads_status_vocabulary is NOT VALID, so a row written before it
              can still hold anything a rep typed. Those render as-is rather
              than crashing on a missing label — they are what the review query
              in the migration is for, and hiding them would hide the work. */}
          {isLeadStatus(lead.status)
            ? LEAD_STATUS_LABELS[lead.status]
            : formatStatus(lead.status)}
        </StatusBadge>
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
      {/* Two rows, labelled, because an unlabelled second row of chips reads as
          an overflow of the first and clicking one looks like it should clear
          the other. Each tab preserves the other filter — see leadsHref. */}
      <div className="flex flex-col gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Pipeline
        </span>
        <FilterTabs
          options={LEAD_STATUS_FILTER_OPTIONS}
          active={status}
          hrefFor={(value) => leadsHref(value, followup)}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Follow-up
        </span>
        <FilterTabs
          options={LEAD_FOLLOWUP_FILTER_OPTIONS}
          active={followup}
          hrefFor={(value) => leadsHref(status, value)}
        />
      </div>

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
  searchParams: LeadsSearchParams;
}) {
  return (
    <PageShell width="list">
      <PageHeader
        title="Leads"
        subtitle="Filter by pipeline stage, follow-up date, or both. Agents see their own; admins see all."
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
