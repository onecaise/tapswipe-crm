import { BellIcon, SearchIcon } from "lucide-react";

/**
 * The 60px bar above the main content.
 *
 * Deliberately neutral — white, no red or black fill — so it doesn't compete
 * with the sidebar for attention.
 *
 * Both controls are presentational for now, and that is on purpose rather than
 * unfinished: there is no global search index and no notifications table yet.
 * The search field is `disabled` instead of live, because a search box that
 * swallows a query and does nothing is worse than one that plainly isn't ready.
 * Wire it up by turning this into a client component with a form that navigates
 * to a results route, and pass a real `unreadCount` once notifications exist.
 */
export function AppTopbar({ unreadCount = 0 }: { unreadCount?: number }) {
  return (
    <header className="sticky top-0 z-10 flex h-[60px] shrink-0 items-center justify-between gap-4 border-b bg-card px-7">
      <div className="relative w-full max-w-sm">
        <SearchIcon
          size={16}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <input
          type="search"
          disabled
          placeholder="Search (coming soon)"
          aria-label="Search"
          className="h-9 w-full rounded-full bg-muted pl-9 pr-4 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed"
        />
      </div>

      <div className="relative shrink-0">
        <BellIcon size={18} className="text-muted-foreground" aria-hidden />
        {unreadCount > 0 && (
          <>
            <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-primary" />
            <span className="sr-only">{unreadCount} unread notifications</span>
          </>
        )}
      </div>
    </header>
  );
}
