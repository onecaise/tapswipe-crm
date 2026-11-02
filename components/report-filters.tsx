import { formatPeriod, periodParam } from "@/lib/format";
import type { Processor } from "@/lib/processors";
import type { ReportFilters } from "@/lib/reports";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

/**
 * The reports' month range and processor: a plain GET form, no client
 * JavaScript, for the reasons DashboardFilterBar gives (linkable, survives
 * back/forward, works with JavaScript off). The tab is carried as a hidden
 * field so Apply keeps it.
 */
function ReportSelect({
  name,
  label,
  value,
  options,
}: {
  name: string;
  label: string;
  value: string;
  options: { value: string; label: string }[];
}) {
  const id = `report-filter-${name}`;
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
          // DashboardFilterBar's select, so the two filter bars match.
          "flex h-9 w-full min-w-[10rem] rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm transition-colors",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:text-sm",
        )}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function ReportFilterBar({
  filters,
  months,
  processors,
}: {
  filters: ReportFilters;
  /** Committed months, newest first, YYYY-MM-DD. */
  months: readonly string[];
  processors: readonly Processor[];
}) {
  // The months in the address are always offered, so the selects show what
  // the page is showing even for a month with no committed batch.
  const all = [...new Set([...months, filters.from, filters.to])].sort().reverse();
  const monthOptions = all.map((m) => ({ value: periodParam(m), label: formatPeriod(m) }));

  return (
    <form
      method="get"
      action="/admin/reports"
      className="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-[repeat(3,minmax(0,1fr))_auto] sm:items-end print:hidden"
      aria-label="Report filters"
    >
      {filters.report !== "reps" && <input type="hidden" name="report" value={filters.report} />}
      <ReportSelect name="from" label="From month" value={periodParam(filters.from)} options={monthOptions} />
      <ReportSelect name="to" label="To month" value={periodParam(filters.to)} options={monthOptions} />
      <ReportSelect
        name="processor"
        label="Processor"
        value={filters.processor ?? ""}
        options={[
          { value: "", label: "All processors" },
          ...processors.map((p) => ({ value: p.code, label: p.label })),
        ]}
      />
      <Button type="submit" size="sm" variant="outline" className="h-9">
        Apply
      </Button>
    </form>
  );
}
