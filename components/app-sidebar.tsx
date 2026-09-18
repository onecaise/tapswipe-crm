import Image from "next/image";
import { Suspense } from "react";

import { NavGroups } from "@/components/sidebar-nav-list";
import { SidebarNav } from "@/components/sidebar-nav";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * The fixed left navigation.
 *
 * A server component, with two Suspense boundaries inside it rather than one
 * around the whole thing. That split is what lets the logo header — the only
 * genuinely static part — prerender, while the two pieces that need the caller's
 * identity stream in:
 *
 *   - the nav, because the Users item is admin-only and the ticket pill is a
 *     per-caller count, and because the active item comes from usePathname()
 *     which cacheComponents treats as runtime-only data
 *   - the footer identity block
 *
 * Both read the profile through requireUser(), which is memoised per request, so
 * the two boundaries share one lookup rather than issuing two.
 */
export function AppSidebar() {
  return (
    // sticky + h-screen rather than `position: fixed`: it pins the same way
    // while staying in the flex row, so the main column needs no matching
    // left offset to stay in sync with it.
    // print:hidden here rather than an `aside` selector in globals.css: the
    // chrome hides itself, so a document's own semantic elements are not
    // collateral. See the print block in app/globals.css.
    <aside className="sticky top-0 flex h-screen w-[248px] shrink-0 flex-col bg-sidebar print:hidden">
      <div className="flex items-center gap-2.5 border-b border-sidebar-border px-4 py-3.5">
        {/* The mark has black linework in it, so it needs a light plate to sit
            on — straight onto #0E0E10 half the logo would vanish. */}
        <div className="flex h-[34px] w-10 shrink-0 items-center justify-center rounded-lg bg-white p-1">
          <Image
            src="/logo-icon.png"
            alt=""
            width={40}
            height={34}
            priority
            className="h-full w-full object-contain"
          />
        </div>
        <span className="text-base font-bold tracking-tight text-sidebar-foreground-active">
          TAPSWIPE CRM
        </span>
      </div>

      {/* The fallback renders the same rows with nothing active and no
          admin-only items, so nav is present and readable immediately instead of
          arriving after a blank panel. */}
      <Suspense
        fallback={
          <NavGroups pathname={null} isAdmin={false} openTicketCount={null} />
        }
      >
        <SidebarNavWithData />
      </Suspense>

      <Suspense fallback={<SidebarUserSkeleton />}>
        <SidebarUser />
      </Suspense>
    </aside>
  );
}

async function SidebarNavWithData() {
  const profile = await requireUser();
  const supabase = await createClient();

  // Tier 1 read: RLS scopes the count, so an agent's pill counts their own open
  // tickets and an admin's counts everyone's. head: true returns the count
  // without the rows. "open" matches the list page's default filter, so the pill
  // and the page agree about what needs attention.
  const { count } = await supabase
    .from("support_tickets")
    .select("id", { count: "exact", head: true })
    .eq("status", "open");

  return (
    <SidebarNav
      isAdmin={profile.role === "admin"}
      openTicketCount={count ?? null}
    />
  );
}

async function SidebarUser() {
  const profile = await requireUser();

  return (
    <div className="flex items-center gap-3 border-t border-sidebar-border px-4 py-3.5">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-destructive text-xs font-semibold text-primary-foreground">
        {initials(profile.full_name)}
      </div>
      <div className="min-w-0">
        <p className="truncate text-[13px] font-semibold text-sidebar-foreground-active">
          {profile.full_name}
        </p>
        <p className="text-[11px] capitalize text-muted-foreground">
          {profile.role}
        </p>
      </div>
    </div>
  );
}

function SidebarUserSkeleton() {
  return (
    <div className="flex items-center gap-3 border-t border-sidebar-border px-4 py-3.5">
      <div className="h-9 w-9 shrink-0 animate-pulse rounded-full bg-sidebar-active" />
      <div className="h-3 w-24 animate-pulse rounded bg-sidebar-active" />
    </div>
  );
}

/** First and last initial, e.g. "Owen Baker" -> "OB". */
function initials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);

  if (parts.length === 0) {
    return "?";
  }

  const first = parts[0][0];
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";

  return `${first}${last}`.toUpperCase();
}
