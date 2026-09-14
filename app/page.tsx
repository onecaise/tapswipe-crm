import { Suspense } from "react";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

/**
 * `/` is a signpost, not a page. It renders nothing and never has.
 *
 * It used to be the with-supabase starter's marketing page — Next.js and
 * Supabase logos, a "Deploy to Vercel" button, a "Next steps" tutorial panel
 * and a "Powered by Supabase" footer — which meant the front door of an
 * internal CRM advertised the scaffold it was built from, and a signed-in rep
 * landing there got a greeting and a logout button instead of their book.
 * All of that is deleted rather than hidden; see the git history if you want it
 * back.
 *
 * Two layers do the redirect, and the duplication is deliberate:
 *
 *   - `lib/supabase/proxy.ts` sends BOTH cases on before this file is reached,
 *     so in practice nothing here ever renders. That is what makes the
 *     transition flash-free: under `cacheComponents` the static shell paints
 *     before a dynamic segment can stream its redirect, so a page-level
 *     redirect alone would show a blank frame first.
 *   - this file is the backstop for when it isn't — the proxy matcher excludes
 *     static assets today and could exclude more tomorrow, and a `/` that 404s
 *     or renders blank because someone edited a regex is a bad failure.
 *
 * Signed-in goes to `/dashboard` rather than anywhere cleverer, and this checks
 * only that a session exists. It deliberately does NOT re-implement the
 * no-profile / unreadable-profile / deactivated branches: `requireUser()` owns
 * those and routes each to its own /auth/error reason, and duplicating that
 * here would be a second copy to drift plus an extra `profiles` select on a
 * route whose entire job is to leave.
 */
export default function Home() {
  return (
    <Suspense fallback={null}>
      <RootRedirect />
    </Suspense>
  );
}

// `Promise<never>`, because `redirect()` is typed to return `never` and this
// function has no other path out. Without the annotation TypeScript infers
// `Promise<void>` and then refuses it as a JSX component type.
async function RootRedirect(): Promise<never> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();

  redirect(data?.claims ? "/dashboard" : "/auth/login");
}
