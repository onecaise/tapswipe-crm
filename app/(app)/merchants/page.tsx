import Link from "next/link";
import { Suspense } from "react";
import { PlusIcon } from "lucide-react";

import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  MERCHANT_FILTER_OPTIONS,
  MERCHANT_LIST_COLUMNS,
  type MerchantListRow,
  parseMerchantFilter,
  statusIntent,
} from "@/lib/merchants";
import { formatDate, formatPct, formatText } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { FilterTabs } from "@/components/filter-tabs";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

async function MerchantsList({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const filter = parseMerchantFilter(status);

  const profile = await requireUser();
  const supabase = await createClient();

  // Tier 1: RLS scopes this to the caller's own rows, or everything for an
  // admin. There is no agent_id filter here on purpose — adding one would
  // duplicate the policy in application code, where it could drift out of sync.
  let query = supabase
    .from("merchants")
    .select(MERCHANT_LIST_COLUMNS)
    .order("date_added", { ascending: false })
    .order("id", { ascending: false });

  if (filter !== "all") {
    query = query.eq("status", filter);
  }

  const { data, error } = await query;

  if (error) {
    return (
      <p className="text-sm text-destructive">
        Could not load merchants: {error.message}
      </p>
    );
  }

  const merchants = (data ?? []) as MerchantListRow[];
  const isAdmin = profile.role === "admin";

  // Admins see whose book each merchant is in. Resolved with a second plain
  // query rather than a PostgREST embed: two simple selects are easier to
  // reason about (and to verify) than relationship-traversal syntax, and this
  // only runs for admins.
  let agentNames = new Map<string, string>();
  if (isAdmin && merchants.length > 0) {
    const agentIds = [...new Set(merchants.map((m) => m.agent_id))];
    const { data: agents } = await supabase
      .from("profiles")
      .select("id, full_name")
      .in("id", agentIds);
    agentNames = new Map(
      (agents ?? []).map((a) => [a.id as string, a.full_name as string]),
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <FilterTabs
        options={MERCHANT_FILTER_OPTIONS}
        active={filter}
        hrefFor={(value) =>
          value === "all" ? "/merchants" : `/merchants?status=${value}`
        }
      />

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>DBA</TableHead>
            <TableHead>MID</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Processor</TableHead>
            <TableHead>Split</TableHead>
            {isAdmin && <TableHead>Agent</TableHead>}
            <TableHead>Added</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {merchants.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={isAdmin ? 7 : 6}
                className="text-muted-foreground"
              >
                {filter === "all"
                  ? "No merchants yet."
                  : `No ${filter} merchants.`}
              </TableCell>
            </TableRow>
          ) : (
            merchants.map((merchant) => (
              <TableRow key={merchant.id}>
                <TableCell className="font-medium">
                  <Link
                    href={`/merchants/${merchant.id}`}
                    className="underline underline-offset-4"
                  >
                    {merchant.dba}
                  </Link>
                </TableCell>
                <TableCell>{formatText(merchant.mid)}</TableCell>
                <TableCell>
                  <StatusBadge intent={statusIntent(merchant.status)}>
                    {merchant.status}
                  </StatusBadge>
                </TableCell>
                <TableCell>{formatText(merchant.processor)}</TableCell>
                <TableCell>{formatPct(merchant.split_agent_pct)}</TableCell>
                {isAdmin && (
                  <TableCell className="text-muted-foreground">
                    {formatText(agentNames.get(merchant.agent_id))}
                  </TableCell>
                )}
                <TableCell className="text-muted-foreground">
                  {formatDate(merchant.date_added)}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

export default function MerchantsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  return (
    <PageShell width="list">
      <PageHeader
        title="Merchants"
        subtitle="Agents see their own book; admins see the whole company."
        action={
          <Button asChild size="sm">
            <Link href="/merchants/new">
              <PlusIcon size={16} />
              New merchant
            </Link>
          </Button>
        }
      />

      {/* cacheComponents: true means both the searchParams await and the fetch
          must sit inside a Suspense boundary. */}
      <Suspense
        fallback={
          <p className="text-sm text-muted-foreground">Loading merchants…</p>
        }
      >
        <MerchantsList searchParams={searchParams} />
      </Suspense>
    </PageShell>
  );
}
