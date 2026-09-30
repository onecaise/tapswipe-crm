import Link from "next/link";
import { Suspense } from "react";
import { PlusIcon, PrinterIcon } from "lucide-react";

import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  PRE_APP_FILTER_OPTIONS,
  PRE_APP_LIST_COLUMNS,
  defaultPreAppFilter,
  parsePreAppFilter,
  type PreAppListRow,
  statusIntent,
} from "@/lib/pre-apps";
import { formatDate, formatText } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { FilterTabs } from "@/components/filter-tabs";
import { ListTable, type ListColumn } from "@/components/list-table";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";

async function PreAppsList({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;

  const profile = await requireUser();
  const isAdmin = profile.role === "admin";

  // An admin with no explicit filter lands on the review queue, since a
  // submitted pre-app is the only kind they need to act on. A rep has nothing
  // to review, so they get everything. This is why the filter is resolved after
  // requireUser() rather than at the top.
  const filter =
    status === undefined
      ? defaultPreAppFilter(isAdmin)
      : parsePreAppFilter(status);

  const supabase = await createClient();

  // Tier 1: RLS scopes this to the caller's own rows, or everything for an
  // admin. No agent_id filter here on purpose — duplicating the policy in
  // application code is how the two drift apart.
  let query = supabase
    .from("pre_apps")
    .select(PRE_APP_LIST_COLUMNS)
    .order("updated_at", { ascending: false })
    .order("id", { ascending: false });

  if (filter !== "all") {
    query = query.eq("status", filter);
  }

  const { data, error } = await query;

  if (error) {
    return (
      <p className="text-sm text-destructive">
        Could not load pre-apps: {error.message}
      </p>
    );
  }

  const preApps = (data ?? []) as PreAppListRow[];

  // Admins see whose book each pre-app is in. A second plain query rather than a
  // PostgREST embed, matching the merchants and leads lists.
  let agentNames = new Map<string, string>();
  if (isAdmin && preApps.length > 0) {
    const agentIds = [...new Set(preApps.map((p) => p.agent_id))];
    const { data: agents } = await supabase
      .from("profiles")
      .select("id, full_name")
      .in("id", agentIds);
    agentNames = new Map(
      (agents ?? []).map((a) => [a.id as string, a.full_name as string]),
    );
  }

  const emptyMessage =
    filter === "all" ? "No pre-apps yet." : `No ${filter} pre-apps.`;

  // The list's shape as data, so the table and the stacked-card view below lg
  // cannot disagree about it. The admin-only Agent column is spliced in at its
  // existing position — before Submitted, not appended — so the column order is
  // unchanged. This also retires the hand-counted `colSpan={isAdmin ? 6 : 5}`
  // the empty row used to carry.
  const columns: ListColumn<PreAppListRow>[] = [
    {
      header: "DBA",
      primary: true,
      className: "font-medium",
      cell: (preApp) => (
        <Link
          href={`/pre-apps/${preApp.id}`}
          className="underline underline-offset-4"
        >
          {preApp.dba_name}
        </Link>
      ),
    },
    {
      header: "Legal name",
      cell: (preApp) => formatText(preApp.legal_business_name),
    },
    {
      header: "Status",
      cell: (preApp) => (
        <StatusBadge intent={statusIntent(preApp.status)}>
          {preApp.status}
        </StatusBadge>
      ),
    },
    {
      header: "Location",
      // Kept verbatim, em dash and all: this is the one cell here that does not
      // go through lib/format, because it joins two columns before falling back.
      cell: (preApp) =>
        [preApp.city, preApp.state].filter(Boolean).join(", ") || "—",
    },
    ...(isAdmin
      ? [
          {
            header: "Agent",
            className: "text-muted-foreground",
            cell: (preApp: PreAppListRow) =>
              formatText(agentNames.get(preApp.agent_id)),
          },
        ]
      : []),
    {
      header: "Submitted",
      className: "text-muted-foreground",
      cell: (preApp) => formatDate(preApp.date_submitted),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <FilterTabs
        options={PRE_APP_FILTER_OPTIONS}
        active={filter}
        hrefFor={(value) =>
          value === "all" ? "/pre-apps?status=all" : `/pre-apps?status=${value}`
        }
      />

      <ListTable
        columns={columns}
        rows={preApps}
        rowKey={(preApp) => preApp.id}
        emptyMessage={emptyMessage}
      />
    </div>
  );
}

export default function PreAppsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  return (
    <PageShell width="list">
      <PageHeader
        title="Pre-Apps"
        subtitle="Merchant applications. Agents see their own; admins see the whole company and land on what needs review."
        action={
          <div className="flex items-center gap-2">
            {/* Secondary, because starting one in the app is the common case
                and printing a blank is the exception — a merchant with no
                computer to fill it in on. */}
            <Button asChild size="sm" variant="outline">
              <Link href="/pre-apps/blank-form">
                <PrinterIcon size={16} />
                Blank form
              </Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/pre-apps/new">
                <PlusIcon size={16} />
                New pre-app
              </Link>
            </Button>
          </div>
        }
      />

      {/* cacheComponents: true means both the searchParams await and the fetch
          must sit inside a Suspense boundary. */}
      <Suspense
        fallback={
          <p className="text-sm text-muted-foreground">Loading pre-apps…</p>
        }
      >
        <PreAppsList searchParams={searchParams} />
      </Suspense>
    </PageShell>
  );
}
