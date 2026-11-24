import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * A labelled native `<select>` on the app's own input tokens, for a GET filter
 * form.
 *
 * Moved here from components/dashboard-filters.tsx when the merchants list
 * (docs/design/merchants-and-dashboard.md, phase 1a) became its second caller —
 * that file kept it local until a second use showed what one needed, and the
 * only thing the second use needed was its own id prefix, since two filter
 * forms must not share element ids. Native rather than a popover library for
 * the reason StateCombobox gives for not reaching for cmdk: this needs a list
 * and a value, and two dependencies to get a listbox is a poor trade.
 */
export function FilterSelect({
  idPrefix,
  name,
  label,
  value,
  options,
  anyLabel,
}: {
  /** Prefix for the element id, e.g. "dashboard-filter" → "dashboard-filter-rep". */
  idPrefix: string;
  name: string;
  label: string;
  value: string;
  options: { value: string; label: string }[];
  /** What the unset option reads as, e.g. "All reps". */
  anyLabel: string;
}) {
  const id = `${idPrefix}-${name}`;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <select
        id={id}
        name={name}
        defaultValue={value}
        className={cn(
          // The Input primitive's own classes, so this cannot drift from the
          // date fields sitting beside it in the same row.
          "flex h-9 w-full min-w-[10rem] rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm transition-colors",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:text-sm",
        )}
      >
        <option value="">{anyLabel}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
