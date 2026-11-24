import Link from "next/link";
import { Suspense } from "react";
import { PlusIcon, UploadIcon } from "lucide-react";

import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  MERCHANT_FILTER_OPTIONS,
  MERCHANT_PAGE_SIZES,
  MERCHANT_SORT_LABELS,
  type MerchantListParams,
  type MerchantListRow,
  type MerchantListSearchParams,
  type MerchantSort,
  merchantFiltersActive,
  merchantListHref,
  merchantSortHref,
  parseMerchantListParams,
  statusIntent,
} from "@/lib/merchants";
import { loadMerchantPage } from "@/lib/merchants-data";
import { loadProcessors } from "@/lib/processors";
import { formatDate, formatPct, formatText } from "@/lib/format";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { FilterTabs } from "@/components/filter-tabs";
import { ListTable, type ListColumn } from "@/components/list-table";
import { ListPagination } from "@/components/list-pagination";
import {
  MerchantFilters,
  type MerchantAgentOption,
} from "@/components/merchant-filters";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";

/**
 * The merchants list, one page at a time (docs/design/merchants-and-dashboard.md
 * §1, phase 1a): filters, sort, page size and page all in the URL, read through
 * the security_invoker `merchant_list` view so RLS still decides whose
 * merchants these are. Never the whole table in the browser.
 */
async function MerchantsList({
  searchParams,
}: {
  searchParams: Promise<MerchantListSearchParams>;
}) {
  const raw = await searchParams;
  const profile = await requireUser();
  const isAdmin = profile.role === "admin";
  const supabase = await createClient();

  // The processor list validates ?processor= and fills the select; the rep
  // list is an admin's only (the agent filter is hidden from a rep, whose
  // profiles policy would return only themselves anyway).
  const [processors, agentsResult] = await Promise.all([
    loadProcessors(supabase),
    isAdmin
      ? supabase.from("profiles").select("id, full_name").order("full_name")
      : Promise.resolve({ data: [] as MerchantAgentOption[], error: null }),
  ]);
  if (agentsResult.error) {
    throw new Error(`Could not load the agent list: ${agentsResult.error.message}`);
  }
  const agents = (agentsResult.data ?? []) as MerchantAgentOption[];

  const params = parseMerchantListParams(raw, {
    isAdmin,
    processors: processors.map((p) => p.code),
  });

  // Tier 1: RLS scopes this to the caller's own rows, or everything for an
  // admin. There is no agent_id filter for a rep on purpose — adding one would
  // duplicate the policy in application code, where it could drift.
  let result: Awaited<ReturnType<typeof loadMerchantPage>>;
  try {
    result = await loadMerchantPage(supabase, params);
  } catch (error) {
    return (
      <p className="text-sm text-destructive">
        {error instanceof Error ? error.message : "Could not load merchants."}
      </p>
    );
  }
  // The page actually shown: the last one when the URL asked for more.
  const shown: MerchantListParams = { ...params, page: result.page };

  const sortFor = (sort: MerchantSort): ListColumn<MerchantListRow>["sort"] => {
    const active = shown.sort === sort;
    const labels = MERCHANT_SORT_LABELS[sort];
    const next = active ? (shown.dir === "asc" ? "desc" : "asc") : null;
    return {
      href: merchantSortHref(shown, sort),
      direction: active ? (shown.dir === "asc" ? "ascending" : "descending") : null,
      label: next ? `Sort by ${labels.name}, ${labels[next]}` : `Sort by ${labels.name}`,
    };
  };

  // The list's shape as data, so the table and the stacked-card view below lg
  // cannot disagree about it. The admin-only Agent column keeps its position,
  // before Added. Its name now comes with the row, from the view's join,
  // instead of a second profiles read.
  const columns: ListColumn<MerchantListRow>[] = [
    {
      header: "DBA",
      primary: true,
      className: "font-medium",
      sort: sortFor("dba"),
      cell: (merchant) => (
        <Link
          href={`/merchants/${merchant.id}`}
          className="underline underline-offset-4"
        >
          {merchant.dba}
        </Link>
      ),
    },
    { header: "MID", sort: sortFor("mid"), cell: (merchant) => formatText(merchant.mid) },
    {
      header: "Status",
      cell: (merchant) => (
        <StatusBadge intent={statusIntent(merchant.status)}>
          {merchant.status}
        </StatusBadge>
      ),
    },
    { header: "Processor", cell: (merchant) => formatText(merchant.processor) },
    {
      header: "Split",
      sort: sortFor("split"),
      cell: (merchant) => formatPct(merchant.split_agent_pct),
    },
    ...(isAdmin
      ? [
          {
            header: "Agent",
            className: "text-muted-foreground",
            sort: sortFor("agent"),
            cell: (merchant: MerchantListRow) => formatText(merchant.agent_name),
          },
        ]
      : []),
    {
      header: "Added",
      className: "text-muted-foreground",
      sort: sortFor("added"),
      cell: (merchant) => formatDate(merchant.date_added),
    },
  ];

  const emptyMessage = merchantFiltersActive(shown)
    ? "No merchants match these filters."
    : "No merchants yet.";

  return (
    <div className="flex flex-col gap-4">
      <FilterTabs
        options={MERCHANT_FILTER_OPTIONS}
        active={shown.status}
        hrefFor={(status) => merchantListHref(shown, { status, page: 1 })}
      />

      <MerchantFilters
        params={shown}
        isAdmin={isAdmin}
        processors={processors}
        agents={agents}
      />

      <SortChips params={shown} isAdmin={isAdmin} />

      <ListPagination
        total={result.total}
        page={result.page}
        lastPage={result.lastPage}
        size={shown.size}
        sizes={MERCHANT_PAGE_SIZES}
        hrefFor={(page, size) =>
          merchantListHref(shown, {
            page,
            size: size as MerchantListParams["size"],
          })
        }
        noun={["merchant", "merchants"]}
      />

      <ListTable
        columns={columns}
        rows={result.rows}
        rowKey={(merchant) => merchant.id}
        emptyMessage={emptyMessage}
      />
    </div>
  );
}

/**
 * The sort control below lg, where ListTable renders cards and a card has no
 * column headers to click. The same links the headers are: the active one
 * flips direction, the others start in their own default.
 */
function SortChips({
  params,
  isAdmin,
}: {
  params: MerchantListParams;
  isAdmin: boolean;
}) {
  const sorts: MerchantSort[] = isAdmin
    ? ["added", "dba", "mid", "split", "agent"]
    : ["added", "dba", "mid", "split"];
  return (
    <nav
      aria-label="Sort merchants"
      className="flex flex-wrap items-center gap-2 lg:hidden"
    >
      <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
        Sort by
      </span>
      {sorts.map((sort) => {
        const labels = MERCHANT_SORT_LABELS[sort];
        const active = params.sort === sort;
        return (
          <Link
            key={sort}
            href={merchantSortHref(params, sort)}
            aria-current={active ? "true" : undefined}
            className={cn(
              "inline-flex min-h-11 items-center rounded-full px-3.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              active
                ? "bg-foreground text-card"
                : "bg-muted text-muted-foreground hover:text-foreground",
            )}
          >
            {active ? `${labels.name}, ${labels[params.dir]}` : labels.name}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * Admin only: merchants are admin-only to create (20261021120000), and
 * /merchants/new requires an admin. A rep's merchants come from
 * approve_pre_app().
 */
async function HeaderActions() {
  const profile = await requireUser();
  if (profile.role !== "admin") return null;

  return (
    <div className="flex flex-wrap gap-2">
      {/* The merchant bulk import (phase 14 of docs/design/intake-and-reports.md). */}
      <Button asChild size="sm" variant="outline">
        <Link href="/admin/merchants/import">
          <UploadIcon size={16} />
          Import merchants
        </Link>
      </Button>
      <Button asChild size="sm">
        <Link href="/merchants/new">
          <PlusIcon size={16} />
          New merchant
        </Link>
      </Button>
    </div>
  );
}

export default function MerchantsPage({
  searchParams,
}: {
  searchParams: Promise<MerchantListSearchParams>;
}) {
  return (
    <PageShell width="list">
      <PageHeader
        title="Merchants"
        subtitle="Agents see their own book; admins see the whole company."
        action={
          // Its own Suspense boundary because it reads the session, and
          // cacheComponents: true means a dynamic read cannot sit outside one.
          <Suspense fallback={null}>
            <HeaderActions />
          </Suspense>
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
