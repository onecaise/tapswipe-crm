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
import { ListTable, type ListColumn } from "@/components/list-table";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";

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

  const emptyMessage =
    filter === "all" ? "No merchants yet." : `No ${filter} merchants.`;

  // The list's shape as data, so the table and the stacked-card view below lg
  // cannot disagree about it. The admin-only Agent column is spliced in at its
  // existing position — before Added, not appended — so the column order is
  // unchanged. This also retires the hand-counted `colSpan={isAdmin ? 7 : 6}`
  // the empty row used to carry.
  const columns: ListColumn<MerchantListRow>[] = [
    {
      header: "DBA",
      primary: true,
      className: "font-medium",
      cell: (merchant) => (
        <Link
          href={`/merchants/${merchant.id}`}
          className="underline underline-offset-4"
        >
          {merchant.dba}
        </Link>
      ),
    },
    { header: "MID", cell: (merchant) => formatText(merchant.mid) },
    {
      header: "Status",
      cell: (merchant) => (
        <StatusBadge intent={statusIntent(merchant.status)}>
          {merchant.status}
        </StatusBadge>
      ),
    },
    { header: "Processor", cell: (merchant) => formatText(merchant.processor) },
    { header: "Split", cell: (merchant) => formatPct(merchant.split_agent_pct) },
    ...(isAdmin
      ? [
          {
            header: "Agent",
            className: "text-muted-foreground",
            cell: (merchant: MerchantListRow) =>
              formatText(agentNames.get(merchant.agent_id)),
          },
        ]
      : []),
    {
      header: "Added",
      className: "text-muted-foreground",
      cell: (merchant) => formatDate(merchant.date_added),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <FilterTabs
        options={MERCHANT_FILTER_OPTIONS}
        active={filter}
        hrefFor={(value) =>
          value === "all" ? "/merchants" : `/merchants?status=${value}`
        }
      />

      <ListTable
        columns={columns}
        rows={merchants}
        rowKey={(merchant) => merchant.id}
        emptyMessage={emptyMessage}
      />
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
