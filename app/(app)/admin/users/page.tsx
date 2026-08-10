import Link from "next/link";
import { Suspense } from "react";
import { ArrowLeftIcon } from "lucide-react";

import { requireAdmin, type Role } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { StatusBadge } from "@/components/status-badge";
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
  role: Role;
  is_active: boolean;
  created_at: string | null;
};

async function UsersTable() {
  // Application-level boundary: non-admins never render this page.
  await requireAdmin();

  // Tier 1 read — plain supabase-js, RLS does the enforcement. This is a
  // second, independent boundary: strip requireAdmin() above and an agent
  // would still only get their own row back, because the `profiles` select
  // policy is `id = auth.uid() or is_admin()`.
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, role, is_active, created_at")
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
          <TableHead>Role</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {profiles.length === 0 ? (
          <TableRow>
            <TableCell colSpan={4} className="text-muted-foreground">
              No users found.
            </TableCell>
          </TableRow>
        ) : (
          profiles.map((profile) => (
            <TableRow key={profile.id}>
              <TableCell className="font-medium">{profile.full_name}</TableCell>
              <TableCell>
                {/* A role is not a status, so it gets no status colour and
                    certainly not brand red — the word already says which one it
                    is. */}
                <Badge variant="secondary">{profile.role}</Badge>
              </TableCell>
              <TableCell>
                {/* Deactivated is grey rather than red: it's an inert state, not
                    a danger, and red here would read as "something is wrong with
                    this account" on every row an admin has deliberately
                    switched off. */}
                <StatusBadge intent={profile.is_active ? "success" : "neutral"}>
                  {profile.is_active ? "active" : "deactivated"}
                </StatusBadge>
              </TableCell>
              <TableCell className="text-muted-foreground">
                {profile.created_at
                  ? new Date(profile.created_at).toLocaleDateString()
                  : "—"}
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
    <div className="flex-1 w-full flex flex-col gap-6 max-w-5xl mx-auto">
      <div className="flex flex-col gap-2 items-start">
        <Button asChild variant="ghost" size="sm">
          <Link href="/dashboard">
            <ArrowLeftIcon size={16} />
            Back to dashboard
          </Link>
        </Button>
        <h1 className="text-2xl font-bold">Manage Users</h1>
        <p className="text-sm text-muted-foreground">
          Read-only for now. Creating, deactivating and resetting passwords go
          through the create-user / deactivate-user / admin-reset-password Edge
          Functions, which are still stubs.
        </p>
      </div>

      {/* cacheComponents: true means dynamic fetches need a Suspense boundary. */}
      <Suspense
        fallback={<p className="text-sm text-muted-foreground">Loading users…</p>}
      >
        <UsersTable />
      </Suspense>
    </div>
  );
}
