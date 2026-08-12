import { requireUser } from "@/lib/auth";
import { BugReportBubble } from "@/components/bug-report-bubble";

/**
 * Server half of the bug-report bubble: reads the caller, renders the client
 * half with what it needs.
 *
 * The same split AppSidebar uses, and for the same reason — reading the profile
 * is dynamic, which cacheComponents rejects unsuspended, so this sits inside a
 * Suspense boundary in the layout. requireUser() is memoised per request, so
 * this shares the lookup the sidebar and the password gate already do rather
 * than issuing a third.
 */
export async function BugReportLauncher() {
  const profile = await requireUser();

  return (
    <BugReportBubble
      agentId={profile.id}
      isAdmin={profile.role === "admin"}
    />
  );
}
