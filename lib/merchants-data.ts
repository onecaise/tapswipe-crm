import type { SupabaseClient } from "@supabase/supabase-js";

import {
  MERCHANT_LIST_COLUMNS,
  MERCHANT_SORT_COLUMN,
  PROCESSOR_NONE,
  clampMerchantPage,
  type MerchantListParams,
  type MerchantListRow,
} from "@/lib/merchants";

/**
 * One page of the merchants list, and the total it is a page of.
 *
 * Read from the `merchant_list` view (20261124120000), which is
 * security_invoker: RLS scopes it to the caller's own book, or everything for
 * an admin, so there is no agent_id filter here for a rep — the policy is the
 * filter. The `agent` param is an ADMIN's narrowing of a view they already
 * have in full, and parseMerchantListParams() only ever sets it for one.
 *
 * THE COUNT. `count: "exact"` returns the size of the FILTERED set with the
 * page, in one request: Postgres counts every matching row (and evaluates the
 * policy for each) on every page load, so the cost grows with the matching
 * rows, not the page size. At today's low thousands that is milliseconds; past
 * roughly 50–100k merchants switch this to `count: "planned"` (the planner's
 * estimate) and show it as "about". Paging is by offset because the page shows
 * page numbers and a total.
 *
 * ORDER. The chosen key with nulls last, then id descending, so equal keys
 * (two merchants added on one day, two at the same rate) never swap between
 * loads and an offset page never repeats or skips a row on an unchanged table.
 */
export async function loadMerchantPage(
  supabase: SupabaseClient,
  params: MerchantListParams,
): Promise<{
  rows: MerchantListRow[];
  total: number;
  /** The page actually shown — the last one when the URL asked for more. */
  page: number;
  lastPage: number;
}> {
  const query = (page: number) => {
    let q = supabase
      .from("merchant_list")
      .select(MERCHANT_LIST_COLUMNS, { count: "exact" });

    if (params.status !== "all") q = q.eq("status", params.status);
    if (params.processor === PROCESSOR_NONE) q = q.is("processor", null);
    else if (params.processor !== null) q = q.eq("processor", params.processor);
    if (params.agent !== null) q = q.eq("agent_id", params.agent);
    if (params.splitNone) {
      q = q.is("split_agent_pct", null);
    } else {
      if (params.splitMin !== null) q = q.gte("split_agent_pct", params.splitMin);
      if (params.splitMax !== null) q = q.lte("split_agent_pct", params.splitMax);
    }
    if (params.from !== null) q = q.gte("date_added", params.from);
    if (params.to !== null) q = q.lte("date_added", params.to);

    const offset = (page - 1) * params.size;
    return q
      .order(MERCHANT_SORT_COLUMN[params.sort], {
        ascending: params.dir === "asc",
        nullsFirst: false,
      })
      .order("id", { ascending: false })
      .range(offset, offset + params.size - 1);
  };

  let { data, count, error } = await query(params.page);

  // A page past the end is PostgREST's 416 (PGRST103), which carries no count.
  // Ask for the first page to learn the total, then show the last page rather
  // than an error: a bookmarked "page 9" of a list that shrank is still a
  // sensible place to land.
  if (error?.code === "PGRST103") {
    const first = await query(1);
    if (first.error) throw new Error(`Could not load merchants: ${first.error.message}`);
    const { page } = clampMerchantPage(params.page, first.count ?? 0, params.size);
    ({ data, count, error } = page === 1 ? first : await query(page));
  }
  if (error) throw new Error(`Could not load merchants: ${error.message}`);

  const total = count ?? 0;
  const { page, lastPage } = clampMerchantPage(params.page, total, params.size);
  return { rows: (data ?? []) as MerchantListRow[], total, page, lastPage };
}
