import { cn } from "@/lib/utils";

/**
 * The status colour system, kept deliberately separate from brand red.
 *
 * A status badge says what state a record is in; a red button says "this is the
 * action to take". Rendering the first in the second's colour makes an ordinary
 * "active" row look like something demanding attention, so brand red and
 * destructive red never appear here — see the note in app/globals.css.
 *
 * Three intents rather than one per status word, so every table agrees on what a
 * colour means: green is a settled good outcome, amber is waiting on someone,
 * grey is inert. The per-table mapping lives with each domain
 * (lib/merchants.ts, lib/pre-apps.ts, lib/support-tickets.ts, …).
 */
export type StatusIntent = "success" | "warning" | "neutral";

const INTENT_STYLES: Record<StatusIntent, string> = {
  success: "bg-success-bg text-success",
  warning: "bg-warning-bg text-warning",
  neutral: "bg-neutral-bg text-neutral",
};

export function StatusBadge({
  intent,
  children,
  className,
}: {
  intent: StatusIntent;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold capitalize leading-none",
        INTENT_STYLES[intent],
        className,
      )}
    >
      {/* bg-current picks up the text colour, so a new intent needs one line
          above rather than a matching dot rule here. */}
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
      {children}
    </span>
  );
}
