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
  parseSupportTicketFilter,
  supportTicketStatusVariant,
} from "@/lib/support-tickets";
import { formatDate, formatText } from "@/lib/format";
import { FilterTabs } from "@/components/filter-tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

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
      <p className="text-sm text-red-500">
        Could not load tickets: {error.message}
      </p>
    );
  }

  const tickets = (data ?? []) as SupportTicketListRow[];
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

  return (
    <div className="flex flex-col gap-4">
      <FilterTabs
        options={SUPPORT_TICKET_FILTER_OPTIONS}
        active={filter}
        hrefFor={(value) => `/support-tickets?status=${value}`}
      />

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Subject</TableHead>
            <TableHead>Merchant</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>Priority</TableHead>
            <TableHead>Opened</TableHead>
            <TableHead>Status</TableHead>
            {isAdmin && <TableHead>Agent</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {tickets.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={isAdmin ? 7 : 6}
                className="text-muted-foreground"
              >
                {emptyMessage}
              </TableCell>
            </TableRow>
          ) : (
            tickets.map((ticket) => (
              <TableRow key={ticket.id}>
                <TableCell className="font-medium">
                  <Link
                    href={`/support-tickets/${ticket.id}`}
                    className="underline underline-offset-4"
                  >
                    {ticket.subject}
                  </Link>
                </TableCell>
                <TableCell>
                  {ticket.merchant_id === null
                    ? formatText(null)
                    : formatText(merchantNames.get(ticket.merchant_id))}
                </TableCell>
                <TableCell>{formatText(ticket.category)}</TableCell>
                <TableCell>{formatText(ticket.priority)}</TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDate(ticket.created_at)}
                </TableCell>
                <TableCell>
                  <Badge variant={supportTicketStatusVariant(ticket.status)}>
                    {ticket.status}
                  </Badge>
                </TableCell>
                {isAdmin && (
                  <TableCell className="text-muted-foreground">
                    {formatText(agentNames.get(ticket.agent_id))}
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

export default function SupportTicketsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  return (
    <div className="flex-1 w-full flex flex-col gap-6 max-w-6xl mx-auto">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold">Support Tickets</h1>
          <p className="text-sm text-muted-foreground">
            Open tickets first. Agents see their own; admins see all.
          </p>
        </div>
        <Button asChild size="sm">
          <Link href="/support-tickets/new">
            <PlusIcon size={16} />
            New ticket
          </Link>
        </Button>
      </div>

      {/* cacheComponents: true means the searchParams await and the fetch both
          have to sit inside a Suspense boundary. */}
      <Suspense
        fallback={
          <p className="text-sm text-muted-foreground">Loading tickets…</p>
        }
      >
        <TicketsList searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
