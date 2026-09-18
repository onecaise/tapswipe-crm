"use client";

import { LogOutIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { createClient } from "@/lib/supabase/client";

/**
 * The app's only sign-out affordance, mounted in the topbar so it is present on
 * every authenticated page rather than on whichever ones remembered to add it.
 *
 * It lived on the dashboard's PageHeader until 2026-09-18 — a leftover of the
 * starter kit, whose deleted components/auth-button.tsx surfaced it on the old
 * marketing `/` page. When that page went, the dashboard copy is what survived,
 * so a rep on /merchants had to navigate home to log out.
 *
 * Deliberately not in components/ui/: it is one specific control, not a
 * primitive. It takes no props and reads no profile, which is why
 * components/app-topbar.tsx renders it with no Suspense boundary while
 * everything else dynamic in the shell needs one.
 *
 * Styled to match NotificationsBell's trigger exactly — same 36px hit area,
 * same hover and focus treatment — because the two sit side by side and a
 * mismatched pair reads as a mistake. Neither `primary` nor `destructive`:
 * logging out is not the page's main action and it is not a delete, and the
 * design system reserves those two reds for precisely those things.
 */
export function LogoutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  const logout = async () => {
    // Guards against a double-click firing two signOut() calls and two pushes.
    if (pending) return;
    setPending(true);

    const supabase = createClient();
    const { error } = await supabase.auth.signOut();

    // Logged rather than shown. There is nothing a rep can usefully do about a
    // failed sign-out, and navigating is the right move either way: the local
    // session is dropped regardless, and if one somehow survived, the proxy
    // re-checks it on the next protected navigation. This button is a
    // convenience, not the security boundary — so it does not claim to be one.
    if (error) {
      console.error(`[LogoutButton] sign-out reported an error: ${error.message}`);
    }

    router.push("/auth/login");
    // Drop server-rendered content cached for the session we just ended.
    router.refresh();
  };

  return (
    <button
      type="button"
      onClick={logout}
      disabled={pending}
      // Icon-only, so the name has to come from somewhere. `title` rides along
      // for a sighted mouse user's tooltip; aria-label wins over it for a
      // screen reader, so the two do not double up.
      aria-label="Log out"
      title="Log out"
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
    >
      <LogOutIcon size={18} aria-hidden />
    </button>
  );
}
