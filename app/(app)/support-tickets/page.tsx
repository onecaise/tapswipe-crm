import Link from "next/link";
import { Suspense } from "react";
import { PlusIcon } from "lucide-react";

import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  DEFAULT_SUPPORT_TICKET_FILTER,
  SUPPORT_TICKET_FILTER_OPTIONS,
  SUPPORT_TICKET_LIST_COLUMNS,
  type SupportTicketListRow,
  compareByStatusThenNewest,
  parseSupportTicketFilter,
  supportTicketPriorityIntent,
  supportTicketStatusIntent,
} from "@/lib/support-tickets";
import { formatDate, formatText } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { FilterTabs } from "@/components/filter-tabs";
import { ListTable, type ListColumn } from "@/components/list-table";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";

async function TicketsList({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status: rawStatus } = await searchParams;
  // No ?status= means the default queue rather than "all" — but an explicitly
  // chosen "all" must survive, so the raw value is checked before defaulting.
  const filter =
    rawStatus === undefined
      ? DEFAULT_SUPPORT_TICKET_FILTER
      : parseSupportTicketFilter(rawStatus);

  const profile = await requireUser();
  const supabase = await createClient();

  // Tier 1: RLS scopes the rows. No agent_id filter here on purpose —
  // duplicating the policy in application code is how the two drift apart.
  let query = supabase
    .from("support_tickets")
    .select(SUPPORT_TICKET_LIST_COLUMNS)
    .order("id", { ascending: false });

  if (filter !== "all") {
    query = query.eq("status", filter);
  }

  const { data, error } = await query;

  if (error) {
    return (
      <p className="text-sm text-destructive">
        Could not load tickets: {error.message}
      </p>
    );
  }

  // Open first, then pending, then closed — see compareByStatusThenNewest.
  // Sorted here rather than in the query because PostgREST cannot express a
  // CASE ordering and the three words do not sort this way alphabetically.
  const tickets = ((data ?? []) as SupportTicketListRow[]).sort(
    compareByStatusThenNewest,
  );
  const isAdmin = profile.role === "admin";

  // Two extra lookups, both plain selects rather than PostgREST embeds, matching
  // the merchants and leads lists: two simple queries are verifiable by the test
  // harness, relationship traversal isn't. Both are scoped by RLS in their own
  // right, so a merchant the caller cannot see simply doesn't come back.
  let agentNames = new Map<string, string>();
  if (isAdmin && tickets.length > 0) {
    const agentIds = [...new Set(tickets.map((t) => t.agent_id))];
    const { data: agents } = await supabase
      .from("profiles")
      .select("id, full_name")
      .in("id", agentIds);
    agentNames = new Map(
      (agents ?? []).map((a) => [a.id as string, a.full_name as string]),
    );
  }

  let merchantNames = new Map<number, string>();
  const merchantIds = [
    ...new Set(
      tickets
        .map((t) => t.merchant_id)
        .filter((id): id is number => id !== null),
    ),
  ];
  if (merchantIds.length > 0) {
    const { data: merchants } = await supabase
      .from("merchants")
      .select("id, dba")
      .in("id", merchantIds);
    merchantNames = new Map(
      (merchants ?? []).map((m) => [m.id as number, m.dba as string]),
    );
  }

  const emptyMessage =
    filter === "all"
      ? "No support tickets yet."
      : `No ${filter} tickets.`;

  // The list's shape as data, so the table and the stacked-card view below lg
  // cannot disagree about it. The admin-only Agent column stays last, where it
  // already was. This also retires the hand-counted `colSpan={isAdmin ? 7 : 6}`
  // the empty row used to carry.
  const columns: ListColumn<SupportTicketListRow>[] = [
    {
      header: "Subject",
      primary: true,
      className: "font-medium",
      cell: (ticket) => (
        <Link
          href={`/support-tickets/${ticket.id}`}
          className="underline underline-offset-4"
        >
          {ticket.subject}
        </Link>
      ),
    },
    {
      header: "Merchant",
      cell: (ticket) =>
        ticket.merchant_id === null
          ? formatText(null)
          : formatText(merchantNames.get(ticket.merchant_id)),
    },
    { header: "Category", cell: (ticket) => formatText(ticket.category) },
    {
      header: "Priority",
      // Blank priority stays an em dash rather than an empty badge: the column
      // is free text, so "" and null are both ordinary.
      cell: (ticket) =>
        ticket.priority === null || ticket.priority.trim() === "" ? (
          formatText(ticket.priority)
        ) : (
          <StatusBadge intent={supportTicketPriorityIntent(ticket.priority)}>
            {ticket.priority}
          </StatusBadge>
        ),
    },
    {
      header: "Opened",
      className: "text-muted-foreground",
      cell: (ticket) => formatDate(ticket.created_at),
    },
    {
      header: "Status",
      cell: (ticket) => (
        <StatusBadge intent={supportTicketStatusIntent(ticket.status)}>
          {ticket.status}
        </StatusBadge>
      ),
    },
    ...(isAdmin
      ? [
          {
            header: "Agent",
            className: "text-muted-foreground",
            cell: (ticket: SupportTicketListRow) =>
              formatText(agentNames.get(ticket.agent_id)),
          },
        ]
      : []),
  ];

  return (
    <div className="flex flex-col gap-4">
      <FilterTabs
        options={SUPPORT_TICKET_FILTER_OPTIONS}
        active={filter}
        hrefFor={(value) => `/support-tickets?status=${value}`}
      />

      <ListTable
        columns={columns}
        rows={tickets}
        rowKey={(ticket) => ticket.id}
        emptyMessage={emptyMessage}
      />
    </div>
  );
}

export default function SupportTicketsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  return (
    <PageShell width="list">
      <PageHeader
        title="Support Tickets"
        subtitle="Open tickets first. Agents see their own; admins see all."
        action={
          <Button asChild size="sm">
            <Link href="/support-tickets/new">
              <PlusIcon size={16} />
              New ticket
            </Link>
          </Button>
        }
      />

      {/* cacheComponents: true means the searchParams await and the fetch both
          have to sit inside a Suspense boundary. */}
      <Suspense
        fallback={
          <p className="text-sm text-muted-foreground">Loading tickets…</p>
        }
      >
        <TicketsList searchParams={searchParams} />
      </Suspense>
    </PageShell>
  );
}
