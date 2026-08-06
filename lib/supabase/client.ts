import { createBrowserClient } from "@supabase/ssr";

import { assertSupabaseEnv } from "@/lib/env-guard";

/**
 * Warned once per page load rather than on every createClient() call, which
 * happens on each form submit and each autosave.
 *
 * A warning and not a throw: by the time the bundle is running, the URL was
 * fixed at build time and the page cannot do anything about it — replacing the
 * app with an error overlay would hide the very screen someone is trying to
 * read. The server-side check in next.config.ts is the one that stops a bad
 * dev server from starting; this catches a stale bundle built with the wrong
 * value.
 */
let warned = false;

export function createClient() {
  if (!warned) {
    warned = true;
    assertSupabaseEnv();
  }

  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  );
}
