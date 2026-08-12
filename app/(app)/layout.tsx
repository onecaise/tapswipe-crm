import { redirect } from "next/navigation";
import { Suspense } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { AppTopbar } from "@/components/app-topbar";
import { BugReportLauncher } from "@/components/bug-report-launcher";
import { requireUser } from "@/lib/auth";

/**
 * The shell every CRM route renders inside.
 *
 * A route group rather than the root layout, because `/`, `/auth/*` and the
 * starter's `/protected` must not get the chrome. Route groups don't affect
 * URLs, so the paths under here are unchanged.
 *
 * The Suspense boundaries cacheComponents requires live inside AppSidebar,
 * around the two pieces that need the caller's identity — see the note there.
 */
export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen">
      {/* First in the tree so it starts resolving before anything else. */}
      <Suspense fallback={null}>
        <ForcePasswordChangeGate />
      </Suspense>

      <AppSidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        <AppTopbar />
        <main className="flex-1 p-7 lg:p-8">{children}</main>
      </div>

      {/* Fixed-position, so it sits outside the flex row rather than in it. In
          the layout rather than on each page so it is present everywhere inside
          the shell — and absent from /auth/*, which is a different route group.
          Suspended for the same reason the gate above is: it reads the profile,
          and cacheComponents rejects that unsuspended. */}
      <Suspense fallback={null}>
        <BugReportLauncher />
      </Suspense>
    </div>
  );
}

/**
 * Sends anyone still holding an admin-issued temporary password to set their own.
 *
 * One gate in the layout rather than a check in 23 pages, and the target sits
 * outside this route group so there is no redirect loop. `requireUser()` is
 * memoised per request, so this shares the lookup the sidebar already does.
 *
 * Not in proxy.ts: that would put a database round trip in the request pipeline
 * for every asset and page, and CLAUDE.md is explicit about not disturbing that
 * file's session flow.
 *
 * It renders nothing, and it must sit inside a Suspense boundary — reading the
 * profile is dynamic, which cacheComponents rejects unsuspended. One consequence
 * of that, worth knowing rather than discovering: because the boundary streams,
 * the shell can paint for an instant before the redirect lands. The redirect is
 * a convenience, not the security boundary — RLS and the RPCs are — so a brief
 * flash of empty chrome is a fair trade for not querying on every request.
 */
async function ForcePasswordChangeGate() {
  const profile = await requireUser();

  if (profile.must_change_password) {
    redirect("/auth/update-password");
  }

  return null;
}
