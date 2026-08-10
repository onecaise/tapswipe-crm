import { cn } from "@/lib/utils";

/**
 * A bordered notice block — the decline reason on a pre-app, the wizard's
 * ready-to-submit and missing-fields messages, the admin-editing warning.
 *
 * These were four hand-rolled `border-emerald-200 bg-emerald-50 dark:…` blocks,
 * the only place in the app that named palette colours in compound light/dark
 * pairs. On a non-white page background they read as pasted on, so they go
 * through tokens like everything else.
 *
 * `danger` derives from `destructive` rather than the status palette on purpose:
 * it marks a bad outcome (a declined application), which is the one place a red
 * surface is the honest signal.
 */
export type CalloutTone = "success" | "warning" | "danger";

const TONE_STYLES: Record<CalloutTone, string> = {
  success: "border-success/25 bg-success-bg",
  warning: "border-warning/25 bg-warning-bg",
  danger: "border-destructive/25 bg-destructive/5",
};

export function Callout({
  tone,
  className,
  children,
}: {
  tone: CalloutTone;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border p-3 text-sm text-foreground",
        TONE_STYLES[tone],
        className,
      )}
    >
      {children}
    </div>
  );
}
