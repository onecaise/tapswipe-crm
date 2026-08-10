"use client";

import { usePathname } from "next/navigation";

import { NavGroups } from "@/components/sidebar-nav-list";

/**
 * The nav rows, with the active item resolved from the live URL.
 *
 * The one reason any of the sidebar is a client component. It must render inside
 * a <Suspense> boundary: next.config.ts sets cacheComponents, so usePathname()
 * is runtime-only data and Next refuses to prerender a route that reads it
 * unsuspended. app/(app)/layout.tsx supplies that boundary via AppSidebar.
 */
export function SidebarNav({
  isAdmin,
  openTicketCount,
}: {
  isAdmin: boolean;
  openTicketCount: number | null;
}) {
  return (
    <NavGroups
      pathname={usePathname()}
      isAdmin={isAdmin}
      openTicketCount={openTicketCount}
    />
  );
}
