import { BellIcon } from "lucide-react";
import { Suspense } from "react";

import { GlobalSearch } from "@/components/global-search";
import { LogoutButton } from "@/components/logout-button";
import { NotificationsBell } from "@/components/notifications-bell";
import { requireUser } from "@/lib/auth";
import { countNotifications, notificationsFloor } from "@/lib/notifications";
import { createClient } from "@/lib/supabase/server";

/**
 * The 60px bar above the main content.
 *
 * Deliberately neutral — white, no red or black fill — so it doesn't compete
 * with the sidebar for attention.
 *
 * The bell is no longer presentational. Its badge is a per-caller count, which
 * makes it dynamic data, so it streams inside a Suspense boundary the same way
 * the sidebar's nav and ticket pill do — cacheComponents rejects an unsuspended
 * profile read. The fallback is the bell with a zero count rather than nothing:
 * the icon is part of the bar's layout, and having it pop in afterwards shifts
 * the header. A count that briefly reads zero is the right failure — it
 * understates, and understating is what the real value does the rest of the time
 * anyway.
 *
 * It also carries the app's only sign-out control. In here rather than on each
 * page so it is present everywhere inside the shell by construction — and, for
 * the same reason, absent from /auth/* and /, which are outside this route
 * group and have no topbar at all. That is a structural guarantee rather than a
 * check someone has to remember: there is nothing conditional to get wrong.
 */
export function AppTopbar() {
  return (
    // print:hidden here rather than a bare `header` selector in globals.css,
    // which also matched every printable document's own <header>. See the note
    // in the print block there.
    <header className="sticky top-0 z-10 flex h-[60px] shrink-0 items-center justify-between gap-4 border-b bg-card px-7 print:hidden">
      <GlobalSearch />

      {/* Grouped so justify-between pushes the pair right as one unit. */}
      <div className="flex shrink-0 items-center gap-1">
        <Suspense fallback={<BellFallback />}>
          <BellWithCount />
        </Suspense>

        {/* Not suspended, and that asymmetry is deliberate rather than an
            oversight: unlike the bell, the sidebar nav and BugReportLauncher,
            this reads no profile and takes no props, so there is nothing
            dynamic for cacheComponents to object to. It therefore paints with
            the bar instead of streaming in — which is the right behaviour for
            the control someone reaches for when they want out. */}
        <LogoutButton />
      </div>
    </header>
  );
}

async function BellWithCount() {
  const profile = await requireUser();
  const supabase = await createClient();

  // Tier 1 read: RLS scopes both counts inside countNotifications, so an agent's
  // badge counts their own new rows and an admin's counts the company's. No role
  // branch here, and none wanted — see lib/notifications.ts.
  const count = await countNotifications(supabase, notificationsFloor(profile));

  return <NotificationsBell initialCount={count} />;
}

/**
 * The same 36px hit area the real bell occupies, so nothing moves when it
 * arrives. Not the live component with initialCount={0}: that would mount, be
 * clickable, and advance the watermark against a count it never knew.
 */
function BellFallback() {
  return (
    <div className="relative shrink-0">
      <div className="flex h-9 w-9 items-center justify-center rounded-md">
        <BellIcon size={18} className="text-muted-foreground" aria-hidden />
      </div>
    </div>
  );
}
