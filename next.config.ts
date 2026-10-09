import type { NextConfig } from "next";

import { assertSupabaseEnv } from "./lib/env-guard";

// Runs once when the dev server boots (and at build time), which is the
// earliest point the Supabase URL is known. Throwing here means a
// misconfiguration stops `npm run dev` outright, with the reason on screen,
// instead of surfacing later as a page that renders someone else's data.
//
// A relative import, not the `@/` alias: next.config is evaluated before the
// tsconfig paths are applied to it.
assertSupabaseEnv({ throwOnFailure: true });

const nextConfig: NextConfig = {
  cacheComponents: true,

  // Proposals moved to their own route (/proposals/[quoteGroupId]/print).
  // The old per-record print URLs are in emails and bookmarks, so they
  // redirect rather than 404. Here rather than as page files that call
  // redirect(): under cacheComponents a page paints its static shell before a
  // streamed redirect lands — the blank frame app/page.tsx documents for "/" —
  // whereas a config redirect answers before any rendering.
  //
  // The query string passes through untouched, so ?quote=<row id> still
  // pins the same version. The record id in the old path is dropped: the
  // group id alone names the proposal, and the new route 404s a group the
  // caller cannot see exactly as the old one did. 307, not 308, so the old
  // paths stay reusable rather than cached by browsers forever.
  async redirects() {
    return [
      {
        source: "/leads/:id/quotes/:quoteGroupId/print",
        destination: "/proposals/:quoteGroupId/print",
        permanent: false,
      },
      {
        source: "/merchants/:id/quotes/:quoteGroupId/print",
        destination: "/proposals/:quoteGroupId/print",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
