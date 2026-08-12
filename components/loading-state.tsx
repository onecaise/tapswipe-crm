"use client";

import { useEffect, useState } from "react";

/**
 * A Suspense fallback that admits when it has been waiting too long.
 *
 * Same text and styling as the bare `<p>` fallbacks elsewhere, so nothing looks
 * different in the normal case — the streamed content arrives in a few hundred
 * milliseconds and this never renders its second line.
 *
 * It exists because "Loading…" is indistinguishable from "this will never
 * finish". A stalled stream — a dev server mid-recompile, a slow network, a
 * request that died after the shell flushed — leaves the fallback on screen with
 * no status code to see and nothing in the console, which reads as a broken
 * page. After `afterMs` this says so and offers the one action that helps.
 */
export function LoadingState({
  label = "Loading…",
  afterMs = 10_000,
}: {
  label?: string;
  afterMs?: number;
}) {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), afterMs);
    return () => clearTimeout(timer);
  }, [afterMs]);

  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm text-muted-foreground">{label}</p>
      {slow && (
        <p className="text-sm text-muted-foreground">
          This is taking longer than usual.{" "}
          <button
            type="button"
            className="underline underline-offset-4"
            onClick={() => window.location.reload()}
          >
            Reload the page
          </button>
          .
        </p>
      )}
    </div>
  );
}
