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
};

export default nextConfig;
