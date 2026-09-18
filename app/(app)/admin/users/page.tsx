import Link from "next/link";
import { Suspense } from "react";
import { ArrowLeftIcon, UploadIcon, UserPlusIcon } from "lucide-react";

import { requireAdmin, type Role } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatText } from "@/lib/format";
import { AgentNumberCell } from "@/components/agent-number-cell";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { StatusBadge } from "@/components/status-badge";
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
  role: Role;
  is_active: boolean;
  must_change_password: boolean;
  created_at: string | null;
};

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
      "id, full_name, email, agent_number, role, is_active, must_change_password, created_at",
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
          <TableHead>Name</TableHead>
          <TableHead>Agent #</TableHead>
          <TableHead>Role</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Created</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {profiles.length === 0 ? (
          <TableRow>
            <TableCell colSpan={6} className="text-muted-foreground">
              No users found.
            </TableCell>
          </TableRow>
        ) : (
          profiles.map((profile) => (
            <TableRow key={profile.id}>
              <TableCell className="font-medium">
                <span className="flex flex-col">
                  <span>
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
                  <span className="text-xs font-normal text-muted-foreground">
                    {formatText(profile.email)}
                  </span>
                </span>
              </TableCell>
              <TableCell>
                {/* How a processor's residual report names this rep. Blank for
                    everyone until someone fills it in — the column is new and
                    there was nothing to backfill it from. */}
                <AgentNumberCell
                  userId={profile.id}
                  fullName={profile.full_name}
                  agentNumber={profile.agent_number}
                />
              </TableCell>
              <TableCell>
                {/* A role is not a status, so it gets no status colour and
                    certainly not brand red — the word already says which one it
                    is. */}
                <Badge variant="secondary">{profile.role}</Badge>
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
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
              <TableCell className="text-muted-foreground">
                {profile.created_at
                  ? new Date(profile.created_at).toLocaleDateString()
                  : "—"}
              </TableCell>
              <TableCell>
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
    <PageShell width="list">
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
