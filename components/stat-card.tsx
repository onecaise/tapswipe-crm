import { cn } from "@/lib/utils";

/**
 * A single figure with a label, for the row above a page's main content.
 *
 * `accent` puts the number in brand red. It is for the one figure on a row that
 * represents outstanding work — a pending count someone should act on. Using it
 * on more than one card per row spends the emphasis it exists to provide.
 */
export function StatCard({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: React.ReactNode;
  accent?: boolean;
}) {
  return (
    // min-w-0 so the card can shrink inside a grid track rather than overflowing
    // it. Tailwind's grid-cols-N is repeat(N, minmax(0, 1fr)), so a card wider
    // than its track does not widen the grid -- it spills, and the NEXT card's
    // bg-card paints over the spill. The result reads as a cleanly clipped
    // number, which is the dangerous failure: a payouts period total of
    // $1,000,000,021,334.56 rendered as "$1,000,000,021,334.5" is not obviously
    // truncated, it is just a smaller, wrong, entirely plausible figure.
    <div className="min-w-0 rounded-xl border bg-card px-4 py-3.5">
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
    </div>
  );
}
