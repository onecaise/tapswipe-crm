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
    <div className="rounded-xl border bg-card px-4 py-3.5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          "mt-1.5 text-2xl font-bold leading-none tracking-tight",
          accent && "text-primary",
        )}
      >
        {value}
      </p>
    </div>
  );
}
