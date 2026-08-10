import Link from "next/link";

import { cn } from "@/lib/utils";

export type FilterOption<T extends string> = {
  value: T;
  label: string;
};

/**
 * A row of filter tabs rendered as plain links.
 *
 * Links rather than a client-side control on purpose: the filter is navigation,
 * so it stays linkable and shareable, survives back/forward, works without JS,
 * and adds nothing to the client bundle.
 *
 * Styled by hand rather than through Button, because the active chip must be
 * black and Button's `default` variant is now brand red. Red here would put a
 * filter on the same footing as the page's create action and compete with the
 * sidebar's active accent, so a filter chip is never red.
 */
export function FilterTabs<T extends string>({
  options,
  active,
  hrefFor,
}: {
  options: readonly FilterOption<T>[];
  active: T;
  hrefFor: (value: T) => string;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((option) => {
        const isActive = option.value === active;

        return (
          <Link
            key={option.value}
            href={hrefFor(option.value)}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "rounded-full px-3.5 py-1.5 text-xs font-semibold capitalize transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              isActive
                ? "bg-foreground text-card"
                : "bg-muted text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </Link>
        );
      })}
    </div>
  );
}
