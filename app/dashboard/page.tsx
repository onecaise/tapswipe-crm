import Link from "next/link";
import { Suspense } from "react";
import {
  ClipboardListIcon,
  FolderIcon,
  GhostIcon,
  LifeBuoyIcon,
  StoreIcon,
  TargetIcon,
  UsersIcon,
} from "lucide-react";

import { requireUser } from "@/lib/auth";
import { LogoutButton } from "@/components/logout-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

async function DashboardContent() {
  const profile = await requireUser();

  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold">
            Welcome back, {profile.full_name}
          </h1>
          <div className="flex items-center gap-2">
            <Badge variant={profile.role === "admin" ? "default" : "secondary"}>
              {profile.role}
            </Badge>
          </div>
        </div>
        <LogoutButton />
      </div>

      <div className="flex flex-col gap-2 items-start">
        <h2 className="font-semibold text-lg">Book of business</h2>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link href="/merchants">
              <StoreIcon size={16} />
              Merchants
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/pre-apps">
              <ClipboardListIcon size={16} />
              Pre-Apps
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/leads">
              <TargetIcon size={16} />
              Leads
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/ghost-sheets">
              <GhostIcon size={16} />
              Ghost Sheets
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/documents">
              <FolderIcon size={16} />
              Document Center
            </Link>
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-2 items-start">
        <h2 className="font-semibold text-lg">Support</h2>
        <div className="flex flex-wrap gap-2">
          {/* Its own row rather than a sixth tile above: a ticket is not part of
              the book of business, it is work outstanding against it. */}
          <Button asChild variant="outline">
            <Link href="/support-tickets">
              <LifeBuoyIcon size={16} />
              Support Tickets
            </Link>
          </Button>
        </div>
      </div>

      {/* Hiding this for agents is a UX nicety only — /admin/users enforces the
          real boundary itself via requireAdmin(), and RLS enforces it again at
          the row level. See §8 of the master plan. */}
      {profile.role === "admin" && (
        <div className="flex flex-col gap-2 items-start">
          <h2 className="font-semibold text-lg">Admin</h2>
          <Button asChild variant="outline">
            <Link href="/admin/users">
              <UsersIcon size={16} />
              Manage Users
            </Link>
          </Button>
        </div>
      )}
    </>
  );
}

export default function DashboardPage() {
  return (
    <div className="flex-1 w-full flex flex-col gap-10 p-6 md:p-10 max-w-5xl mx-auto">
      {/* cacheComponents: true in next.config.ts means dynamic data fetching
          must sit inside a Suspense boundary. */}
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <DashboardContent />
      </Suspense>
    </div>
  );
}
