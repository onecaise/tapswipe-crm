import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The processor list, read from the `processors` table (20261023130000, phase 1
 * of docs/design/intake-and-reports.md).
 *
 * The TABLE is the list. Every drop-down that offers a processor -- the merchant
 * form and the pre-app wizard now, the residual import later -- loads it with
 * loadProcessors() and renders it through components/processor-select.tsx, so a
 * processor added by migration appears everywhere at once. The foreign keys on
 * merchants.processor and pre_apps.processor are what actually refuse anything
 * else; the select is the courtesy that keeps a rep from typing it.
 */

export type Processor = { code: string; label: string };

export const PROCESSOR_COLUMNS = "code, label";

/**
 * Every processor, in drop-down order. Throws rather than returning [] on an
 * error: an empty list would render a select with only "Not set" in it, and a
 * save from that form would silently clear the merchant's processor.
 */
export async function loadProcessors(supabase: SupabaseClient): Promise<Processor[]> {
  const { data, error } = await supabase
    .from("processors")
    .select(PROCESSOR_COLUMNS)
    .order("sort_order");
  if (error) throw new Error(`Could not load the processor list: ${error.message}`);
  return (data ?? []) as Processor[];
}

/** What the select shows for "no processor". The value it stands for is "". */
export const PROCESSOR_UNSET_LABEL = "Not set";

/**
 * The options a select should offer for a field currently holding `current`.
 *
 * The list itself, plus -- only when the field already holds a value the list
 * does not have -- that value, labelled, at the top. The foreign keys make that
 * impossible for a saved row today, but a select whose value is not among its
 * options silently shows the first option instead, and saving the form would
 * then quietly change the processor. Showing the value it holds is the rule the
 * merchant owner picker follows for the same reason (lib/merchant-owners.ts).
 */
export function processorOptions(
  processors: readonly Processor[],
  current: string | null | undefined,
): { value: string; label: string }[] {
  const options = [
    { value: "", label: PROCESSOR_UNSET_LABEL },
    ...processors.map((p) => ({ value: p.code, label: p.label })),
  ];
  if (current && !processors.some((p) => p.code === current)) {
    options.splice(1, 0, { value: current, label: `${current} (not in the list)` });
  }
  return options;
}

/**
 * The codes the migration seeds, for the ONE place that cannot read the table:
 * the blank paper application (app/(app)/pre-apps/blank-form), which is
 * deliberately static -- no data, no Suspense. tests/unit/processors.test.ts
 * pins this against the migration's own insert and the schema doc, so a
 * processor added there without updating this list is a red test, not a
 * stale form.
 */
export const PAPER_PROCESSOR_CODES = [
  "TSYS",
  "Red Fynn",
  "PayBright",
  "Netevia HQ",
  "Square",
] as const;
