import Link from "next/link";
import { Suspense } from "react";
import { ArrowLeftIcon } from "lucide-react";

import { requireAdmin, type Role } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
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
      <p className="text-sm text-red-500">
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
                <Badge
                  variant={profile.role === "admin" ? "default" : "secondary"}
                >
                  {profile.role}
                </Badge>
              </TableCell>
              <TableCell>
                <Badge
                  variant={profile.is_active ? "outline" : "destructive"}
                >
                  {profile.is_active ? "active" : "deactivated"}
                </Badge>
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
    <div className="flex-1 w-full flex flex-col gap-6 p-6 md:p-10 max-w-5xl mx-auto">
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
