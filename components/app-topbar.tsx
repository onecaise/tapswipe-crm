import { BellIcon } from "lucide-react";

import { GlobalSearch } from "@/components/global-search";

/**
 * The 60px bar above the main content.
 *
 * Deliberately neutral — white, no red or black fill — so it doesn't compete
 * with the sidebar for attention.
 *
 * The bell is still presentational: there is no notifications table yet, so
 * `unreadCount` has no caller. The dot is wired to it so switching it on later
 * is passing a number, not restyling anything.
 */
export function AppTopbar({ unreadCount = 0 }: { unreadCount?: number }) {
  return (
    <header className="sticky top-0 z-10 flex h-[60px] shrink-0 items-center justify-between gap-4 border-b bg-card px-7">
      <GlobalSearch />

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
