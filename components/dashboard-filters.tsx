import Link from "next/link";

import { LEAD_STATUS_FILTER_OPTIONS } from "@/lib/leads";
import {
  dashboardFiltersActive,
  dashboardHref,
  type DashboardFilters,
} from "@/lib/dashboard";
import { cn } from "@/lib/utils";
import { FilterTabs } from "@/components/filter-tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * The dashboard's filter bar.
 *
 * A SERVER component with no client JavaScript at all, which is what lets the
 * two halves below coexist:
 *
 *   * **Stage** is a FilterTabs row, exactly as the leads and tasks lists use
 *     it. A bounded vocabulary that fits on one line is what that primitive is
 *     for, and each chip is a link carrying every other filter — the job
 *     leadsHref does for the leads list's pair.
 *   * **Rep, manager, territory and the date range** are a plain GET form. They
 *     could not be FilterTabs: a rep list is unbounded, and a hundred reps is a
 *     hundred chips. A form keeps them linkable and shareable like the chips,
 *     survives back/forward, and works with JavaScript off — so this adds no
 *     second interaction model, only a second layout.
 *
 * The Apply button is the price of the form half, and it is deliberate. The
 * alternative is a client component navigating on change, which would make this
 * the only filter in the app that needs JavaScript to work at all.
 *
 * ## Only admins see the rep/manager/territory controls
 *
 * Not because a rep sending `?rep=<someone else>` would learn anything —
 * dashboard_counts() is security invoker, so that request returns zeros, which
 * tests/rls/dashboard-filters.test.ts asserts directly. The reason is simpler:
 * for a rep those three controls can only ever return their own numbers or an
 * empty dashboard, and a control whose every setting is a no-op or a blank page
 * is a broken control. The date range and stage are genuinely useful to a rep
 * over their own book, so both are shown to everyone.
 */

export type RepOption = {
  id: string;
  full_name: string;
};

export type DashboardFilterOptions = {
  /** Every rep an admin may filter by, by name. Empty for an agent. */
  reps: RepOption[];
  /** Only profiles that actually manage someone — the rest would select zero. */
  managers: RepOption[];
  /** Distinct non-null profiles.territory values, sorted. */
  territories: string[];
};

/**
 * A labelled native `<select>` on the app's own input tokens.
 *
 * Local to this file rather than promoted to components/ui: there is one caller,
 * and a primitive invented before its second use is a guess about what the
 * second use needs. Native rather than a popover library for the reason
 * StateCombobox gives for not reaching for cmdk — this needs a list and a
 * value, and two dependencies to get a listbox is a poor trade.
 */
function FilterSelect({
  name,
  label,
  value,
  options,
  anyLabel,
}: {
  name: string;
  label: string;
  value: string;
  options: { value: string; label: string }[];
  /** What the unset option reads as, e.g. "All reps". */
  anyLabel: string;
}) {
  const id = `dashboard-filter-${name}`;
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

export function DashboardFilterBar({
  filters,
  isAdmin,
  options,
}: {
  filters: DashboardFilters;
  isAdmin: boolean;
  options: DashboardFilterOptions;
}) {
  const active = dashboardFiltersActive(filters);

  return (
    <section className="flex flex-col gap-4 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold text-lg">
          {isAdmin ? "Company overview" : "Your overview"}
        </h2>
        {active && (
          // A way back that is one click rather than six. Omitted entirely when
          // nothing is filtered, so it never reads as a control that does
          // something.
          <Link
            href="/dashboard"
            className="text-sm underline underline-offset-4"
          >
            Clear filters
          </Link>
        )}
      </div>

      {/* method="get" and no action: the browser builds /dashboard?… from the
          named fields, so the result is an ordinary linkable URL rather than a
          POST this page would have to handle. */}
      <form method="get" action="/dashboard" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-3">
          {isAdmin && (
            <>
              <FilterSelect
                name="rep"
                label="Rep"
                anyLabel="All reps"
                value={filters.rep ?? ""}
                options={options.reps.map((rep) => ({
                  value: rep.id,
                  label: rep.full_name,
                }))}
              />
              <FilterSelect
                name="manager"
                label="Manager"
                anyLabel="All managers"
                value={filters.manager ?? ""}
                options={options.managers.map((manager) => ({
                  value: manager.id,
                  label: manager.full_name,
                }))}
              />
              <FilterSelect
                name="territory"
                label="Territory"
                anyLabel="All territories"
                value={filters.territory ?? ""}
                options={options.territories.map((territory) => ({
                  value: territory,
                  label: territory,
                }))}
              />
            </>
          )}

          <div className="grid gap-1.5">
            <Label
              htmlFor="dashboard-filter-from"
              className="text-xs text-muted-foreground"
            >
              Created from
            </Label>
            <Input
              id="dashboard-filter-from"
              name="from"
              type="date"
              defaultValue={filters.from ?? ""}
              className="w-auto"
            />
          </div>

          <div className="grid gap-1.5">
            <Label
              htmlFor="dashboard-filter-to"
              className="text-xs text-muted-foreground"
            >
              Created to
            </Label>
            <Input
              id="dashboard-filter-to"
              name="to"
              type="date"
              defaultValue={filters.to ?? ""}
              className="w-auto"
            />
          </div>

          <Button type="submit" size="sm">
            Apply
          </Button>
        </div>

        {/* The stage lives on the chips below, not in this form — but a submit
            has to carry it or applying a date would silently discard whichever
            stage was selected. Omitted at the default so the URL stays clean. */}
        {filters.stage !== "all" && (
          <input type="hidden" name="stage" value={filters.stage} />
        )}
      </form>

      <div className="flex flex-col gap-2">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          Lead stage
        </p>
        <FilterTabs
          options={LEAD_STATUS_FILTER_OPTIONS}
          active={filters.stage}
          // Every chip carries the other five filters, so picking a stage does
          // not throw away the rep or the dates someone just applied.
          hrefFor={(stage) => dashboardHref(filters, { stage })}
        />
      </div>
    </section>
  );
}
