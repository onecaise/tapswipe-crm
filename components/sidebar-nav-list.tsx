import Link from "next/link";

import { NAV_GROUPS, type NavItem, isNavItemActive } from "@/lib/nav";
import { cn } from "@/lib/utils";

/**
 * The grouped nav rows.
 *
 * Deliberately hook-free and pathname-as-a-prop, so the same component serves
 * two callers: components/sidebar-nav.tsx renders it on the client with the live
 * pathname, and components/app-sidebar.tsx renders it on the server as that
 * boundary's Suspense fallback with `pathname={null}`. One definition, so the
 * prerendered nav and the streamed one cannot drift apart.
 *
 * `pathname === null` means "not known yet": every row renders inactive.
 */
export function NavGroups({
  pathname,
  isAdmin,
  openTicketCount,
}: {
  pathname: string | null;
  isAdmin: boolean;
  openTicketCount: number | null;
}) {
  return (
    <nav className="flex-1 overflow-y-auto py-2">
      {NAV_GROUPS.map((group) => {
        const items = group.items.filter((item) => !item.adminOnly || isAdmin);

        if (items.length === 0) {
          return null;
        }

        return (
          <div key={group.label} className="pb-1">
            <p className="px-4 pb-1.5 pt-4 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {group.label}
            </p>
            <ul>
              {items.map((item) => (
                <li key={item.label}>
                  <NavRow
                    item={item}
                    pathname={pathname}
                    openTicketCount={openTicketCount}
                  />
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

/**
 * One nav row. Renders as a link when the item has a route and as an inert span
 * when it doesn't (Notes and Tasks, which are panels rather than pages).
 *
 * Both states carry the same 3px left border — transparent when inactive — so
 * activating an item recolours the border instead of shifting the label 3px.
 */
function NavRow({
  item,
  pathname,
  openTicketCount,
}: {
  item: NavItem;
  pathname: string | null;
  openTicketCount: number | null;
}) {
  const active =
    item.href !== undefined &&
    pathname !== null &&
    isNavItemActive(item.href, pathname);
  const count = item.badge === "openTickets" ? openTicketCount : null;

  const shared =
    "flex items-center gap-2.5 border-l-[3px] px-4 py-2 text-[13px] font-medium";
  const icon = (
    <item.icon
      size={16}
      className={cn("shrink-0", active && "text-primary")}
      aria-hidden
    />
  );

  if (item.href === undefined) {
    return (
      <span
        className={cn(
          shared,
          "cursor-default border-transparent text-sidebar-foreground/50",
        )}
        // Reads as unavailable to a screen reader too, not just visually.
        aria-disabled="true"
      >
        {icon}
        {item.label}
      </span>
    );
  }

  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        shared,
        "transition-colors",
        active
          ? "border-primary bg-sidebar-active text-sidebar-foreground-active"
          : "border-transparent text-sidebar-foreground hover:bg-sidebar-active hover:text-sidebar-foreground-active",
      )}
    >
      {icon}
      {item.label}
      {count !== null && count > 0 && (
        <span className="ml-auto rounded-full bg-primary px-1.5 py-0.5 text-[11px] font-semibold leading-none text-primary-foreground">
          {count}
        </span>
      )}
    </Link>
  );
}
