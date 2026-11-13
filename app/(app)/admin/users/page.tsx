import Link from "next/link";
import { Suspense } from "react";
import { ArrowLeftIcon, UploadIcon, UserPlusIcon } from "lucide-react";

import { requireAdmin, type Role } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatText } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AgentNumberCell } from "@/components/agent-number-cell";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { RepIdentityCell } from "@/components/rep-identity-cell";
import { SplitRateCell } from "@/components/split-rate-cell";
import { StatusBadge } from "@/components/status-badge";
import { TerritoryCell } from "@/components/territory-cell";
import { UserRowActions } from "@/components/user-row-actions";
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

type ProfileRow = {
  id: string;
  full_name: string;
  email: string | null;
  agent_number: string | null;
  territory: string | null;
  legal_name: string | null;
  llc_legal_name: string | null;
  split_rate_pct: number;
  role: Role;
  is_active: boolean;
  must_change_password: boolean;
  created_at: string | null;
};

/**
 * Compact cells, so all nine columns fit a laptop's content column without the
 * table scrolling sideways. The primitive's px-4 is right for the five-column
 * lists; nine columns at that padding spend over 100px on gutters alone.
 */
const HEAD = "px-2.5";
const CELL = "px-2.5 py-2.5";

/**
 * The name column stays put when the table does scroll (an iPad, or a laptop
 * with the sidebar showing), so a row is still identifiable from its Actions
 * end. Needs its own background or the scrolled columns show through it, and
 * the row's hover tint is re-applied as a layer over that background rather
 * than replacing it, for the same reason. The 1px shadow is the column's edge.
 */
const STICKY =
  "sticky left-0 z-[1] bg-card shadow-[1px_0_0_hsl(var(--border))]";

async function UsersTable() {
  // Application-level boundary: non-admins never render this page.
  const viewer = await requireAdmin();

  // Tier 1 read — plain supabase-js, RLS does the enforcement. This is a
  // second, independent boundary: strip requireAdmin() above and an agent
  // would still only get their own row back, because the `profiles` select
  // policy is `id = auth.uid() or is_admin()`.
  //
  // tests/rls/manage-users.test.ts pins this exact column list — change it there
  // too, or that test is asserting the safety of a query nothing runs.
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .select(
      "id, full_name, email, agent_number, territory, legal_name, llc_legal_name, split_rate_pct, role, is_active, must_change_password, created_at",
    )
    .order("created_at", { ascending: true });

  if (error) {
    return (
      <p className="text-sm text-destructive">
        Could not load users: {error.message}
      </p>
    );
  }

  const profiles = (data ?? []) as ProfileRow[];

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className={cn(HEAD, STICKY)}>Name</TableHead>
          <TableHead className={HEAD}>Agent #</TableHead>
          <TableHead className={HEAD}>Territory</TableHead>
          <TableHead className={HEAD}>Legal names</TableHead>
          <TableHead className={HEAD}>Split</TableHead>
          <TableHead className={HEAD}>Role</TableHead>
          <TableHead className={HEAD}>Status</TableHead>
          <TableHead className={HEAD}>Created</TableHead>
          <TableHead className={cn(HEAD, "text-right")}>Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {profiles.length === 0 ? (
          <TableRow>
            <TableCell colSpan={9} className="text-muted-foreground">
              No users found.
            </TableCell>
          </TableRow>
        ) : (
          profiles.map((profile) => (
            <TableRow key={profile.id} className="group">
              <TableCell
                className={cn(
                  CELL,
                  STICKY,
                  "font-medium group-hover:bg-[linear-gradient(hsl(var(--muted)/0.5),hsl(var(--muted)/0.5))]",
                )}
              >
                {/* Capped and truncated rather than left to set the column's
                    width: one long address would otherwise widen the sticky
                    column for every row. The title carries the full text. */}
                <span className="flex max-w-[13rem] flex-col">
                  <span className="truncate" title={profile.full_name}>
                    {profile.full_name}
                    {profile.id === viewer.id && (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        you
                      </span>
                    )}
                  </span>
                  {/* The sign-in address. Without it two reps sharing a name
                      are indistinguishable on the one screen that deactivates
                      accounts and resets passwords. Null only for rows that
                      predate profiles.email and were not backfilled. */}
                  <span
                    className="truncate text-xs font-normal text-muted-foreground"
                    title={profile.email ?? undefined}
                  >
                    {formatText(profile.email)}
                  </span>
                </span>
              </TableCell>
              <TableCell className={CELL}>
                {/* How a processor's residual report names this rep. Blank for
                    everyone until someone fills it in — the column is new and
                    there was nothing to backfill it from. */}
                <AgentNumberCell
                  userId={profile.id}
                  fullName={profile.full_name}
                  agentNumber={profile.agent_number}
                />
              </TableCell>
              <TableCell className={CELL}>
                {/* A reporting label, not an access boundary — nothing reads
                    this to decide what the rep can see. Blank for everyone
                    until someone fills it in; the column is new and there was
                    nothing to backfill it from. */}
                <TerritoryCell
                  userId={profile.id}
                  fullName={profile.full_name}
                  territory={profile.territory}
                />
              </TableCell>
              <TableCell className={CELL}>
                {/* Legal name over LLC legal name, for the processor's
                    paperwork. Admin-set only, through set_rep_identity(); a rep
                    missing either cannot submit a pre-app (phase 4). */}
                <RepIdentityCell
                  userId={profile.id}
                  fullName={profile.full_name}
                  role={profile.role}
                  legalName={profile.legal_name}
                  llcLegalName={profile.llc_legal_name}
                />
              </TableCell>
              <TableCell className={CELL}>
                {/* The rep's share of a merchant's residual (memo §0b.4).
                    Admin-set only, through set_rep_split(); copied onto a
                    pre-app at submit, so a change here moves no existing
                    pre-app or merchant. */}
                <SplitRateCell
                  userId={profile.id}
                  fullName={profile.full_name}
                  rate={profile.split_rate_pct}
                />
              </TableCell>
              <TableCell className={CELL}>
                {/* A role is not a status, so it gets no status colour and
                    certainly not brand red — the word already says which one it
                    is. */}
                <Badge variant="secondary">{profile.role}</Badge>
              </TableCell>
              <TableCell className={CELL}>
                <div className="flex flex-col items-start gap-1">
                  {/* Deactivated is grey rather than red: it's an inert state, not
                      a danger, and red here would read as "something is wrong with
                      this account" on every row an admin has deliberately
                      switched off. */}
                  <StatusBadge
                    intent={profile.is_active ? "success" : "neutral"}
                  >
                    {profile.is_active ? "active" : "deactivated"}
                  </StatusBadge>
                  {/* Amber, not red: an account mid-onboarding is waiting on
                      someone, which is what amber means everywhere else here. */}
                  {profile.must_change_password && (
                    <StatusBadge intent="warning">temp password</StatusBadge>
                  )}
                </div>
              </TableCell>
              <TableCell className={cn(CELL, "text-muted-foreground")}>
                {profile.created_at
                  ? new Date(profile.created_at).toLocaleDateString()
                  : "—"}
              </TableCell>
              <TableCell className={CELL}>
                <UserRowActions
                  userId={profile.id}
                  fullName={profile.full_name}
                  role={profile.role}
                  isActive={profile.is_active}
                  isSelf={profile.id === viewer.id}
                />
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}

export default function ManageUsersPage() {
  return (
    // Full width: nine columns, and every one of them is wanted at once. The
    // table still scrolls inside its own card where they do not fit.
    <PageShell width="full">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href="/dashboard">
          <ArrowLeftIcon size={16} />
          Back to dashboard
        </Link>
      </Button>

      <PageHeader
        title="Manage Users"
        subtitle="Accounts are created here, never by self-service sign-up. Deactivate rather than delete — a rep who leaves still owns historical deals and residuals."
        action={
          <div className="flex items-center gap-2">
            {/* Secondary to "New user": one rep at a time is the ordinary case,
                and a bulk import is the thing you reach for when onboarding a
                book of them. */}
            <Button asChild variant="outline" size="sm">
              <Link href="/admin/users/import">
                <UploadIcon size={16} />
                Import reps
              </Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/admin/users/new">
                <UserPlusIcon size={16} />
                New user
              </Link>
            </Button>
          </div>
        }
      />

      {/* cacheComponents: true means dynamic fetches need a Suspense boundary. */}
      <Suspense
        fallback={<p className="text-sm text-muted-foreground">Loading users…</p>}
      >
        <UsersTable />
      </Suspense>
    </PageShell>
  );
}
