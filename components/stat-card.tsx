import Link from "next/link";

import { cn } from "@/lib/utils";

/**
 * A single figure with a label, for the row above a page's main content.
 *
 * `accent` puts the number in brand red. It is for the one figure on a row that
 * represents outstanding work — a pending count someone should act on. Using it
 * on more than one card per row spends the emphasis it exists to provide.
 *
 * `href` turns the whole card into a link to wherever that work is done. Pass it
 * only when the figure has ONE unambiguous destination: a card that aggregates
 * across several records has no single right answer, and sending someone to an
 * arbitrary one of them is worse than not linking at all. /payouts is the worked
 * example — it links "Awaiting figures" only while a single period is unfilled.
 */
export function StatCard({
  label,
  value,
  accent = false,
  href,
}: {
  label: string;
  value: React.ReactNode;
  accent?: boolean;
  /** Where this figure's outstanding work is done. Omit for a plain card. */
  href?: string;
}) {
  const body = (
    <>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          // break-words rather than truncate, deliberately. Truncating would
          // show an ellipsis -- honest, but it still hides digits, and the full
          // value would live only in a title attribute that no one hovers on a
          // figure they are reading. Wrapping is lossless: the card grows, the
          // row grows with it, and every digit stays on screen.
          //
          // leading-tight rather than leading-none because a wrapped number on
          // leading-none has its lines touching.
          "mt-1.5 text-2xl font-bold leading-tight tracking-tight break-words",
          accent && "text-primary",
        )}
      >
        {value}
      </p>
    </>
  );

  // min-w-0 so the card can shrink inside a grid track rather than overflowing
  // it. Tailwind's grid-cols-N is repeat(N, minmax(0, 1fr)), so a card wider
  // than its track does not widen the grid -- it spills, and the NEXT card's
  // bg-card paints over the spill. The result reads as a cleanly clipped
  // number, which is the dangerous failure: a payouts period total of
  // $1,000,000,021,334.56 rendered as "$1,000,000,021,334.5" is not obviously
  // truncated, it is just a smaller, wrong, entirely plausible figure.
  // data-slot matches the convention components/ui/table.tsx already uses. It
  // exists so the e2e specs can locate a whole card and compare its box to its
  // figure's box — the clipping bug was geometric, and asserting on text would
  // have passed against it. BOTH branches below carry it, and both keep the
  // label and figure as the card's only two <p>s, because those specs read the
  // first and last paragraph inside the slot.
  const shell = "min-w-0 rounded-xl border bg-card px-4 py-3.5";

  if (href === undefined) {
    return (
      <div data-slot="stat-card" className={shell}>
        {body}
      </div>
    );
  }

  return (
    <Link
      data-slot="stat-card"
      href={href}
      // `block` because an <a> is inline by default. As a grid item it would be
      // blockified anyway, but the geometry specs measure this box against its
      // figure's, and a card is not always in a grid.
      className={cn(
        shell,
        "block transition-colors hover:bg-accent",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      )}
    >
      {body}
    </Link>
  );
}
