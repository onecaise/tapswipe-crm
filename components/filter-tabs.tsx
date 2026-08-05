import Link from "next/link";

import { Button } from "@/components/ui/button";

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
      {options.map((option) => (
        <Button
          key={option.value}
          asChild
          size="sm"
          variant={option.value === active ? "default" : "outline"}
        >
          <Link href={hrefFor(option.value)}>{option.label}</Link>
        </Button>
      ))}
    </div>
  );
}
