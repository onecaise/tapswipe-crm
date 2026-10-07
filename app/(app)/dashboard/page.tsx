import Link from "next/link";
import { Suspense } from "react";

import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  DASHBOARD_TASK_LIMIT,
  taskIndexHref,
  taskIndexLabel,
  taskIsOverdue,
  type Task,
  type WithAuthor,
  type WithOwner,
} from "@/lib/annotations";
import { loadMyTaskDigest } from "@/lib/annotations-data";
import {
  dashboardCountArgs,
  parseDashboardFilters,
  type DashboardCounts,
  type DashboardFilters,
  type DashboardSearchParams,
} from "@/lib/dashboard";
import { LEAD_STATUS_LABELS, isLeadStatus } from "@/lib/leads";
import { formatDate } from "@/lib/format";
import {
  DashboardFilterBar,
  type DashboardFilterOptions,
} from "@/components/dashboard-filters";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { StatCard } from "@/components/stat-card";
import { Badge } from "@/components/ui/badge";

/**
 * The filter bar and the stat row it drives.
 *
 * One `dashboard_counts()` RPC rather than five head:true selects, which makes
 * the figures a single snapshot instead of five reads that can disagree. The
 * function is SECURITY INVOKER, so the caller's own RLS scopes every count
 * inside it: an agent gets the size of their own book, an admin the company's,
 * with no role branch anywhere.
 *
 * **The filters do not change that, and the distinction is worth holding on
 * to.** This page used to carry no `agent_id` filter at all, on the grounds
 * that a copy of a policy in application code is how the two drift apart. That
 * rule is about a query meaning *everything I may see*. What goes to the RPC
 * here means *a subset of it, chosen by the reader* — it is ANDed with the
 * policy rather than standing in for it, which is why a rep sending
 * `?rep=<someone else>` gets zeros and why there is no permission check in this
 * function. Adding one would imply the RPC needed it. See lib/dashboard.ts and
 * tests/rls/dashboard-filters.test.ts.
 *
 * The cards are ordered as a funnel, left to right — ghost sheet, lead,
 * pre-app, merchant — which is also why `active_leads` excludes leads that
 * already have a pre-app. A deal is counted once, at the stage it has reached.
 */
async function DashboardOverview({
  searchParams,
}: {
  searchParams: Promise<DashboardSearchParams>;
}) {
  const filters = parseDashboardFilters(await searchParams);
  const profile = await requireUser();
  const isAdmin = profile.role === "admin";

  const supabase = await createClient();

  // The filter arguments ride straight into the same invoker RPC. There is no
  // permission check here and there must not be one: an agent who sends
  // ?rep=<another rep> gets zeros because the policy and the filter cannot both
  // hold, which is a property of the function rather than of this page. Adding
  // a check would imply the function needed one.
  const [{ data, error }, options] = await Promise.all([
    supabase.rpc("dashboard_counts", dashboardCountArgs(filters)).maybeSingle(),
    loadFilterOptions(isAdmin),
  ]);

  return (
    <div className="flex flex-col gap-4">
      <DashboardFilterBar
        filters={filters}
        isAdmin={isAdmin}
        options={options}
      />
      <DashboardStats
        counts={data as DashboardCounts | null}
        error={error?.message ?? null}
        filters={filters}
      />
    </div>
  );
}

/**
 * The rep, manager and territory lists behind the admin-only selects.
 *
 * One read of `profiles`, derived three ways. RLS does the scoping as usual —
 * an admin sees every row, which is why this is only called for one — and the
 * manager list is built from the manager_id values actually in use rather than
 * from every profile: a "manager" who manages nobody is an option whose every
 * result is zero.
 */
async function loadFilterOptions(
  isAdmin: boolean,
): Promise<DashboardFilterOptions> {
  if (!isAdmin) return { reps: [], managers: [], territories: [] };

  const supabase = await createClient();
  const { data } = await supabase
    .from("profiles")
    .select("id, full_name, territory, manager_id")
    .order("full_name", { ascending: true });

  const profiles = (data ?? []) as {
    id: string;
    full_name: string;
    territory: string | null;
    manager_id: string | null;
  }[];

  const managerIds = new Set(
    profiles.map((p) => p.manager_id).filter((id): id is string => id !== null),
  );

  return {
    reps: profiles.map((p) => ({ id: p.id, full_name: p.full_name })),
    managers: profiles
      .filter((p) => managerIds.has(p.id))
      .map((p) => ({ id: p.id, full_name: p.full_name })),
    territories: [
      ...new Set(
        profiles
          .map((p) => p.territory)
          .filter((t): t is string => t !== null && t.trim() !== ""),
      ),
    ].sort((a, b) => a.localeCompare(b)),
  };
}

function DashboardStats({
  counts,
  error,
  filters,
}: {
  counts: DashboardCounts | null;
  error: string | null;
  filters: DashboardFilters;
}) {
  if (error || !counts) {
    return (
      <p className="text-sm text-destructive">
        Could not load your counts{error ? `: ${error}` : "."}
      </p>
    );
  }

  // `count(*)` is bigint, so PostgREST sends these as strings; Number() rather
  // than trusting the shape. An absent figure renders "—" rather than a
  // confident zero, which would read as an empty book — and that is also what
  // makes `leads_at_stage` safe to leave null: "you did not ask" never prints
  // as "there are none".
  const show = (key: keyof DashboardCounts) => {
    const raw = counts[key];
    return raw === null || raw === undefined ? "—" : Number(raw);
  };

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
      <StatCard label="Ghost sheets" value={show("ghost_sheets_total")} />
      {/* "Unconverted", not "Active". The figure is leads with no pre-app yet —
          it ignores leads.status entirely, so a lead the rep closed as lost
          still counted under the old label until someone started an
          application for it. Filtering on status instead would mean inventing a
          closed-lead vocabulary, which lib/leads.ts warns against precisely
          because the column is unconstrained free text. The count is right for
          a funnel; only the word was wrong. */}
      <StatCard label="Unconverted leads" value={show("active_leads")} />
      <StatCard label="Pre-apps" value={show("pre_apps_total")} />
      <StatCard label="Active merchants" value={show("active_merchants")} />
      {/* The one red figure on the row: open tickets are the only number here
          that represents work someone still has to do. */}
      <StatCard label="Open tickets" value={show("open_tickets")} accent />

      {/* A SIXTH card, shown only when a stage was asked for, and deliberately
          not folded into "Unconverted leads". That figure means "a lead no
          pre-app points at yet" — a funnel position the records prove — while a
          stage is something a rep types. One card cannot be both: filtering the
          funnel figure by 'application_sent' would read as near-zero, because
          those leads are exactly the ones a pre-app points at. See the
          leads_at_stage note in the migration. */}
      {filters.stage !== "all" && (
        <StatCard
          label={`Leads at ${
            isLeadStatus(filters.stage)
              ? LEAD_STATUS_LABELS[filters.stage].toLowerCase()
              : filters.stage
          }`}
          value={show("leads_at_stage")}
        />
      )}
    </div>
  );
}

/**
 * The signed-in user's own overdue and upcoming tasks.
 *
 * This is the login-surfaced half of the follow-up story. The lead page
 * reconciles one record's tasks against its `next_followup_date`
 * (components/followup-reconcile.tsx); this answers the question that brought
 * the rep here at all — what is late, and what is due this week — without
 * making them open a record to find out.
 *
 * **An admin sees their OWN tasks here, not the company's.** RLS would hand an
 * admin every task in the database, so loadMyTaskDigest narrows explicitly by
 * agent_id. That is a deliberate narrowing rather than a policy copied into
 * application code — see TaskIndexScope. A company-wide view is a different
 * feature with a different shape, and growing into it by accident would turn
 * a digest nobody can act on into the first thing on every admin's screen.
 *
 * Read-only on purpose: completing a task is a write, and it has two homes
 * already (the per-record panel and /tasks). A third copy of that control is a
 * third place for the optimistic-update bug to live, for a saving no one asked
 * for — the links below land on the row that owns it.
 */
async function DashboardTasks() {
  const profile = await requireUser();
  const { rows, truncated, error } = await loadMyTaskDigest(profile.id);

  if (error) {
    return (
      <p className="text-sm text-destructive">
        Could not load your tasks: {error}
      </p>
    );
  }

  const overdue = rows.filter(taskIsOverdue);
  // Not `!taskIsOverdue`: every row here is open and dated (the digest's query
  // excludes a null due_date), so the complement is exactly "due today through
  // the end of the window".
  const upcoming = rows.filter((task) => !taskIsOverdue(task));

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h2 className="font-semibold text-lg">Your tasks</h2>
          {/* Said on the page, because the filter bar sits directly above and
              an admin who has just narrowed the overview to one rep would
              otherwise read this list as that rep's. It is always the
              signed-in user's own: DashboardTasks never touches searchParams,
              and loadMyTaskDigest takes profile.id and nothing else. */}
          <p className="text-xs text-muted-foreground">
            Your own work. Not affected by the filters above.
          </p>
        </div>
        {/* Both the word and the URL come from TASK_INDEX_FILTER_OPTIONS, so
            this page and /tasks cannot come to call the same filter two
            different things. */}
        <Link
          href={taskIndexHref("open")}
          className="text-sm underline underline-offset-4"
        >
          All {taskIndexLabel("open").toLowerCase()} tasks
        </Link>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing overdue, and nothing due in the next 7 days.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <TaskGroup
            heading={taskIndexLabel("overdue")}
            href={taskIndexHref("overdue")}
            tasks={overdue}
            overdue
          />
          <TaskGroup
            heading="Due in the next 7 days"
            tasks={upcoming}
          />
        </div>
      )}

      {truncated && (
        <p className="text-sm text-muted-foreground">
          Showing your {DASHBOARD_TASK_LIMIT} soonest. The rest are on{" "}
          <Link
            href={taskIndexHref("open")}
            className="underline underline-offset-4"
          >
            Tasks
          </Link>
          .
        </p>
      )}
    </section>
  );
}

/**
 * One half of the digest. Renders nothing when empty rather than an "Overdue
 * (0)" heading — a zero here is good news, and good news does not need a row.
 */
function TaskGroup({
  heading,
  href,
  tasks,
  overdue = false,
}: {
  heading: string;
  /** Where the full list of this group lives, when there is one. */
  href?: string;
  tasks: WithOwner<WithAuthor<Task>>[];
  overdue?: boolean;
}) {
  if (tasks.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {href === undefined ? (
          `${heading} (${tasks.length})`
        ) : (
          <Link href={href} className="underline underline-offset-4">
            {heading} ({tasks.length})
          </Link>
        )}
      </h3>

      <ul className="flex flex-col gap-2">
        {tasks.map((task) => (
          <li
            key={task.id}
            className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-md border p-3"
          >
            <span className="text-sm font-medium">{task.title}</span>
            <span className="flex items-baseline gap-3 text-xs text-muted-foreground">
              {task.owner_href === null ? (
                // Owner deleted, or no longer the caller's to see. owner_id
                // carries no foreign key, so nothing cascaded. Shown without a
                // link rather than as a dead one, exactly as /tasks does.
                <span>{task.owner_label}</span>
              ) : (
                <Link
                  href={task.owner_href}
                  className="underline underline-offset-4"
                >
                  {task.owner_label}
                </Link>
              )}
              <time
                dateTime={task.due_date ?? undefined}
                className={overdue ? "text-destructive" : undefined}
              >
                {overdue ? "Overdue — " : ""}
                {formatDate(task.due_date)}
              </time>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

async function DashboardHeader() {
  const profile = await requireUser();

  return (
    <PageHeader title={`Welcome back, ${profile.full_name}`}>
      <div className="mt-1">
        <Badge variant="secondary">{profile.role}</Badge>
      </div>
    </PageHeader>
  );
}

export default function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<DashboardSearchParams>;
}) {
  // The grid of nav buttons that used to be here is gone: the sidebar does
  // navigation now, and a second copy of the same links is just something else
  // to keep in step with lib/nav.ts.
  //
  // searchParams is passed down UNAWAITED. Awaiting it here would pull the
  // dynamic read outside the Suspense boundary, which cacheComponents rejects
  // at build time — the same rule the lead detail page follows for params.
  return (
    <PageShell width="detail">
      {/* cacheComponents: true in next.config.ts means dynamic data fetching
          must sit inside a Suspense boundary. Three boundaries rather than one
          so the greeting doesn't wait on the counts, and the counts don't wait
          on the digest. */}
      <Suspense
        fallback={<p className="text-sm text-muted-foreground">Loading…</p>}
      >
        <DashboardHeader />
      </Suspense>

      <Suspense fallback={<StatsSkeleton />}>
        <DashboardOverview searchParams={searchParams} />
      </Suspense>

      {/* A SEPARATE boundary, and separate data. The digest is the signed-in
          user's own tasks and takes no part in the filters above: it reads
          profile.id, never searchParams, so no combination of filters can
          change, empty or widen it. Keeping it outside DashboardOverview is
          what makes that structural rather than a promise. */}
      <Suspense
        fallback={
          <p className="text-sm text-muted-foreground">Loading your tasks…</p>
        }
      >
        <DashboardTasks />
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
