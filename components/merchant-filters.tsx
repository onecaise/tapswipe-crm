import Link from "next/link";

import {
  MERCHANT_DEFAULT_PAGE_SIZE,
  MERCHANT_SORT_DEFAULT_DIRECTION,
  PROCESSOR_NONE,
  merchantFiltersActive,
  merchantListHref,
  type MerchantListParams,
} from "@/lib/merchants";
import { PROCESSOR_UNSET_LABEL, type Processor } from "@/lib/processors";
import { FilterSelect } from "@/components/filter-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type MerchantAgentOption = { id: string; full_name: string };

/**
 * The merchants list's filter form (docs/design/merchants-and-dashboard.md
 * §1.2): processor, agent (admins), split range or "no rate", and the date
 * added. Status stays on the chips above the list, as it always has, and
 * every chip carries these.
 *
 * A SERVER component and a plain GET form — the dashboard filter bar's shape
 * and for its reasons: linkable, survives back/forward, works with JavaScript
 * off. Applying sends no `page`, so a narrower list always starts at page 1.
 * The status, sort and page size ride along as hidden fields, each omitted at
 * its default so the URL stays short.
 *
 * The agent select is an admin's only. For a rep it could only return their
 * own book or nothing — RLS ANDs it with the policy — and the parser ignores
 * it for a rep anyway.
 */
export function MerchantFilters({
  params,
  isAdmin,
  processors,
  agents,
}: {
  params: MerchantListParams;
  isAdmin: boolean;
  processors: Processor[];
  agents: MerchantAgentOption[];
}) {
  return (
    <section
      aria-labelledby="merchant-filters-heading"
      className="flex flex-col gap-3 rounded-xl border bg-card p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="merchant-filters-heading" className="text-sm font-semibold">
          Filters
        </h2>
        {merchantFiltersActive(params) && (
          // Clears the filters and keeps the order and page size someone chose.
          <Link
            href={hrefKeepingView(params)}
            className="text-sm underline underline-offset-4"
          >
            Clear filters
          </Link>
        )}
      </div>

      <form method="get" action="/merchants" className="flex flex-wrap items-end gap-3">
        <FilterSelect
          idPrefix="merchant-filter"
          name="processor"
          label="Processor"
          anyLabel="All processors"
          value={params.processor ?? ""}
          options={[
            ...processors.map((p) => ({ value: p.code, label: p.label })),
            { value: PROCESSOR_NONE, label: PROCESSOR_UNSET_LABEL },
          ]}
        />

        {isAdmin && (
          <FilterSelect
            idPrefix="merchant-filter"
            name="agent"
            label="Agent"
            anyLabel="All agents"
            value={params.agent ?? ""}
            options={agents.map((a) => ({ value: a.id, label: a.full_name }))}
          />
        )}

        <fieldset className="grid gap-1.5">
          <legend className="mb-1.5 text-xs font-medium text-muted-foreground">
            Split %
          </legend>
          <div className="flex items-center gap-2">
            <Label htmlFor="merchant-filter-split-min" className="sr-only">
              Split from
            </Label>
            <Input
              id="merchant-filter-split-min"
              name="split_min"
              type="number"
              inputMode="decimal"
              min={0}
              max={50}
              step="0.01"
              placeholder="0"
              defaultValue={params.splitMin ?? ""}
              className="w-20"
            />
            <span aria-hidden className="text-muted-foreground">
              –
            </span>
            <Label htmlFor="merchant-filter-split-max" className="sr-only">
              Split to
            </Label>
            <Input
              id="merchant-filter-split-max"
              name="split_max"
              type="number"
              inputMode="decimal"
              min={0}
              max={50}
              step="0.01"
              placeholder="50"
              defaultValue={params.splitMax ?? ""}
              className="w-20"
            />
          </div>
        </fieldset>

        <div className="flex h-9 items-center gap-2">
          <input
            id="merchant-filter-split-none"
            name="split"
            type="checkbox"
            value="none"
            defaultChecked={params.splitNone}
            className="size-4"
          />
          <Label htmlFor="merchant-filter-split-none" className="text-sm font-normal">
            No rate set
          </Label>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="merchant-filter-from" className="text-xs text-muted-foreground">
            Added from
          </Label>
          <Input
            id="merchant-filter-from"
            name="from"
            type="date"
            defaultValue={params.from ?? ""}
            className="w-auto"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="merchant-filter-to" className="text-xs text-muted-foreground">
            Added to
          </Label>
          <Input
            id="merchant-filter-to"
            name="to"
            type="date"
            defaultValue={params.to ?? ""}
            className="w-auto"
          />
        </div>

        {params.status !== "all" && <input type="hidden" name="status" value={params.status} />}
        {params.sort !== "added" && <input type="hidden" name="sort" value={params.sort} />}
        {params.dir !== MERCHANT_SORT_DEFAULT_DIRECTION[params.sort] && (
          <input type="hidden" name="dir" value={params.dir} />
        )}
        {params.size !== MERCHANT_DEFAULT_PAGE_SIZE && (
          <input type="hidden" name="size" value={params.size} />
        )}

        <Button type="submit" size="sm">
          Apply
        </Button>
      </form>
    </section>
  );
}

/** The list with every filter cleared but the order and page size kept. */
function hrefKeepingView(params: MerchantListParams): string {
  return merchantListHref(params, {
    status: "all",
    processor: null,
    agent: null,
    splitNone: false,
    splitMin: null,
    splitMax: null,
    from: null,
    to: null,
    page: 1,
  });
}
