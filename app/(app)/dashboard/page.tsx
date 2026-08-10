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
 * One `dashboard_counts()` RPC rather than five head:true selects. The function
 * is SECURITY INVOKER, so the caller's own RLS scopes every count inside it: an
 * agent gets the size of their own book, an admin the company's, and there is no
 * agent_id filter here to fall out of step with the policies. It also makes the
 * five figures a single snapshot instead of five reads that can disagree.
 *
 * Ordered as a funnel, left to right — ghost sheet, lead, pre-app, merchant —
 * which is also why `active_leads` excludes leads that already have a pre-app.
 * A deal is counted once, at the stage it has reached. See the migration.
 *
 * `count(*)` is bigint, so PostgREST sends these as strings; Number() rather
 * than trusting the shape. A failed RPC renders "—" rather than a confident
 * zero, which would read as an empty book.
 */
async function DashboardStats() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("dashboard_counts").maybeSingle();

  if (error || !data) {
    return (
      <p className="text-sm text-destructive">
        Could not load your counts{error ? `: ${error.message}` : "."}
      </p>
    );
  }

  const counts = data as Record<string, number | string | null>;
  const show = (key: string) => {
    const raw = counts[key];
    return raw === null || raw === undefined ? "—" : Number(raw);
  };

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
      <StatCard label="Ghost sheets" value={show("ghost_sheets_total")} />
      <StatCard label="Active leads" value={show("active_leads")} />
      <StatCard label="Pre-apps" value={show("pre_apps_total")} />
      <StatCard label="Active merchants" value={show("active_merchants")} />
      {/* The one red figure on the row: open tickets are the only number here
          that represents work someone still has to do. */}
      <StatCard label="Open tickets" value={show("open_tickets")} accent />
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
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
      {[0, 1, 2, 3, 4].map((i) => (
        <div
          key={i}
          className="h-[74px] animate-pulse rounded-xl border bg-card"
        />
      ))}
    </div>
  );
}
