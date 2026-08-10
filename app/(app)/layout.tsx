import { AppSidebar } from "@/components/app-sidebar";
import { AppTopbar } from "@/components/app-topbar";

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
      <AppSidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        <AppTopbar />
        <main className="flex-1 p-7 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
