import { Suspense } from "react";

import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { StatCard } from "@/components/stat-card";
import { LogoutButton } from "@/components/logout-button";
import { Badge } from "@/components/ui/badge";

/**
 * Counts for the stat row.
 *
 * All four are Tier 1 reads with `head: true`, so RLS scopes them and Postgres
 * returns the count without the rows — an agent sees the size of their own book
 * and an admin sees the company's. Issued together because they don't depend on
 * each other, and a null count (an errored query) renders as "—" rather than a
 * confident zero, which would read as "you have no merchants".
 */
async function DashboardStats() {
  const supabase = await createClient();

  const [merchants, leads, preApps, openTickets] = await Promise.all([
    supabase.from("merchants").select("id", { count: "exact", head: true }),
    supabase.from("leads").select("id", { count: "exact", head: true }),
    supabase.from("pre_apps").select("id", { count: "exact", head: true }),
    supabase
      .from("support_tickets")
      .select("id", { count: "exact", head: true })
      .eq("status", "open"),
  ]);

  const show = (count: number | null) => count ?? "—";

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard label="Merchants" value={show(merchants.count)} />
      <StatCard label="Leads" value={show(leads.count)} />
      <StatCard label="Pre-apps" value={show(preApps.count)} />
      {/* The one red figure on the row: open tickets are the only number here
          that represents work someone still has to do. */}
      <StatCard label="Open tickets" value={show(openTickets.count)} accent />
    </div>
  );
}

async function DashboardHeader() {
  const profile = await requireUser();

  return (
    <PageHeader
      title={`Welcome back, ${profile.full_name}`}
      action={<LogoutButton />}
    >
      <div className="mt-1">
        <Badge variant="secondary">{profile.role}</Badge>
      </div>
    </PageHeader>
  );
}

export default function DashboardPage() {
  // The grid of nav buttons that used to be here is gone: the sidebar does
  // navigation now, and a second copy of the same links is just something else
  // to keep in step with lib/nav.ts.
  return (
    <PageShell width="detail">
      {/* cacheComponents: true in next.config.ts means dynamic data fetching
          must sit inside a Suspense boundary. Two boundaries rather than one so
          the greeting doesn't wait on four count queries. */}
      <Suspense
        fallback={<p className="text-sm text-muted-foreground">Loading…</p>}
      >
        <DashboardHeader />
      </Suspense>

      <Suspense fallback={<StatsSkeleton />}>
        <DashboardStats />
      </Suspense>
    </PageShell>
  );
}

function StatsSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="h-[74px] animate-pulse rounded-xl border bg-card"
        />
      ))}
    </div>
  );
}
