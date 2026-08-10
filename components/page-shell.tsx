import { cn } from "@/lib/utils";

/**
 * The three content widths the app uses, named by what they hold.
 *
 * These were already the convention — every page hand-wrote one of them — but
 * copied into 23 files, which is why adjusting the reading width used to mean 23
 * edits. Outer padding is not here: app/(app)/layout.tsx owns that, so it stays
 * consistent whether or not a route uses this component.
 */
const WIDTHS = {
  list: "max-w-6xl gap-6",
  detail: "max-w-5xl gap-8",
  form: "max-w-3xl gap-6",
} as const;

export type PageWidth = keyof typeof WIDTHS;

export function PageShell({
  width,
  className,
  children,
}: {
  width: PageWidth;
  /** Escape hatch for one-off spacing; conflicting classes win via cn(). */
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("mx-auto flex w-full flex-col", WIDTHS[width], className)}>
      {children}
    </div>
  );
}
