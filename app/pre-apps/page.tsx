import Link from "next/link";
import { Suspense } from "react";
import { PlusIcon } from "lucide-react";

import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  PRE_APP_FILTER_OPTIONS,
  PRE_APP_LIST_COLUMNS,
  defaultPreAppFilter,
  parsePreAppFilter,
  type PreAppListRow,
  statusBadgeVariant,
} from "@/lib/pre-apps";
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
      <p className="text-sm text-red-500">
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

  return (
    <div className="flex flex-col gap-4">
      <FilterTabs
        options={PRE_APP_FILTER_OPTIONS}
        active={filter}
        hrefFor={(value) =>
          value === "all" ? "/pre-apps?status=all" : `/pre-apps?status=${value}`
        }
      />

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>DBA</TableHead>
            <TableHead>Legal name</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Location</TableHead>
            {isAdmin && <TableHead>Agent</TableHead>}
            <TableHead>Submitted</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {preApps.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={isAdmin ? 6 : 5}
                className="text-muted-foreground"
              >
                {filter === "all"
                  ? "No pre-apps yet."
                  : `No ${filter} pre-apps.`}
              </TableCell>
            </TableRow>
          ) : (
            preApps.map((preApp) => (
              <TableRow key={preApp.id}>
                <TableCell className="font-medium">
                  <Link
                    href={`/pre-apps/${preApp.id}`}
                    className="underline underline-offset-4"
                  >
                    {preApp.dba_name}
                  </Link>
                </TableCell>
                <TableCell>{formatText(preApp.legal_business_name)}</TableCell>
                <TableCell>
                  <Badge variant={statusBadgeVariant(preApp.status)}>
                    {preApp.status}
                  </Badge>
                </TableCell>
                <TableCell>
                  {[preApp.city, preApp.state].filter(Boolean).join(", ") || "—"}
                </TableCell>
                {isAdmin && (
                  <TableCell className="text-muted-foreground">
                    {formatText(agentNames.get(preApp.agent_id))}
                  </TableCell>
                )}
                <TableCell className="text-muted-foreground">
                  {formatDate(preApp.date_submitted)}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

export default function PreAppsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  return (
    <div className="flex-1 w-full flex flex-col gap-6 p-6 md:p-10 max-w-6xl mx-auto">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold">Pre-Apps</h1>
          <p className="text-sm text-muted-foreground">
            Merchant applications. Agents see their own; admins see the whole
            company and land on what needs review.
          </p>
        </div>
        <Button asChild size="sm">
          <Link href="/pre-apps/new">
            <PlusIcon size={16} />
            New pre-app
          </Link>
        </Button>
      </div>

      {/* cacheComponents: true means both the searchParams await and the fetch
          must sit inside a Suspense boundary. */}
      <Suspense
        fallback={
          <p className="text-sm text-muted-foreground">Loading pre-apps…</p>
        }
      >
        <PreAppsList searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
