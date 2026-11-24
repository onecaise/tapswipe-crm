import type { StatusIntent } from "@/components/status-badge";

/**
 * Shared merchant types and constants.
 *
 * MERCHANT_STATUSES mirrors the check constraint on `merchants.status` in
 * supabase/migrations/20260804201300_initial_schema.sql. If that constraint
 * changes, change this too — the database is the authority, this is a copy for
 * the UI's benefit.
 */
export const MERCHANT_STATUSES = ["active", "inactive", "other"] as const;

export type MerchantStatus = (typeof MERCHANT_STATUSES)[number];

/** Filter values accepted by the list page: a real status, or "all". */
export const MERCHANT_FILTERS = ["all", ...MERCHANT_STATUSES] as const;

export type MerchantFilter = (typeof MERCHANT_FILTERS)[number];

/** Tab options for the list page, in display order. */
export const MERCHANT_FILTER_OPTIONS = MERCHANT_FILTERS.map((value) => ({
  value,
  label: value === "all" ? "All" : value,
}));

export type Merchant = {
  id: number;
  agent_id: string;
  mid: string | null;
  dba: string;
  legal_business_name: string | null;
  status: MerchantStatus;
  processor: string | null;
  split_agent_pct: number | null;
  split_company_pct: number | null;
  /**
   * The pre-app this merchant was approved from, when there was one.
   *
   * Provenance, not a live link: approve_pre_app copies the columns it needs at
   * approval and nothing syncs afterwards, so editing an approved pre-app does
   * not change the merchant. Null for merchants created by hand and for every
   * row approved before 20260813162634, which had nothing to record.
   */
  pre_app_id: number | null;
  /**
   * Where the business is (20261013130000). City and state are required for
   * every NEW merchant (merchants_location_guard), but the columns stay
   * nullable because merchants that predate them have neither — and must stay
   * editable. They are listed for admins at /admin/merchants/missing-location.
   */
  street: string | null;
  city: string | null;
  /** Two upper-case letters when present (the constraint checks the shape). */
  state: string | null;
  zip: string | null;
  date_added: string | null;
  created_at: string | null;
  updated_at: string | null;
};

/**
 * Columns the list page reads, from the `merchant_list` view (20261124120000).
 * Kept in one place so the tests can assert on the same set.
 */
export const MERCHANT_LIST_COLUMNS =
  "id, agent_id, mid, dba, legal_business_name, status, processor, split_agent_pct, date_added, agent_name";

export type MerchantListRow = Pick<
  Merchant,
  | "id"
  | "agent_id"
  | "mid"
  | "dba"
  | "legal_business_name"
  | "status"
  | "processor"
  | "split_agent_pct"
  | "date_added"
> & {
  /**
   * The owner's name, from the view's left join on profiles. The caller's own
   * profiles policy applies (the view is security_invoker), so a rep gets their
   * own name and an admin everyone's. Null only if the policy hides the owner.
   */
  agent_name: string | null;
};

/**
 * Narrows an untrusted `?status=` value to a known filter.
 *
 * Falls back to "all" rather than passing the raw value through to the query:
 * an unrecognised status would return zero rows, which reads as "you have no
 * merchants" instead of "that filter doesn't exist".
 */
export function parseMerchantFilter(value: string | undefined): MerchantFilter {
  return MERCHANT_FILTERS.includes(value as MerchantFilter)
    ? (value as MerchantFilter)
    : "all";
}

export function statusIntent(status: MerchantStatus): StatusIntent {
  if (status === "active") return "success";
  return "neutral";
}

/** The longest city the database stores or searches for, trimmed. */
export const MAX_CITY_LENGTH = 60;

/**
 * "Nashville, TN", or null when the merchant has no location yet. Street and
 * zip are not part of it — this is the line the list and the search show.
 */
export function formatCityState(
  m: Pick<Merchant, "city" | "state">,
): string | null {
  if (!m.city || !m.state) return null;
  return `${m.city}, ${m.state}`;
}

/**
 * The PostgREST filter for merchants with no (complete) location: in practice
 * the rows that predate the columns, since every new merchant must have both
 * and a complete location cannot be removed. One definition, so the admin count on the dashboard and the list it
 * links to cannot disagree about what "missing" means.
 */
export const MISSING_LOCATION_FILTER = "city.is.null,state.is.null";

/**
 * One account from accounts_in_city(). The four required fields are all a
 * non-admin ever receives; the optional ones arrive only for an admin. They
 * are optional here because the KEYS are absent for a rep, not null — the
 * function builds each row with jsonb_build_object per role.
 */
export type CityAccount = {
  dba: string;
  legal_business_name: string | null;
  city: string;
  state: string;
  merchant_id?: number;
  agent_id?: string;
  agent_name?: string | null;
  status?: MerchantStatus;
  street?: string | null;
  zip?: string | null;
};

export type CityAccountsResult = {
  results: CityAccount[];
  has_more: boolean;
};

/** accounts_in_city() returns at most this many, plus has_more. */
export const CITY_ACCOUNTS_CAP = 100;

// ---------------------------------------------------------------------------
// The list page's URL: filters, sort, page size and page
// (docs/design/merchants-and-dashboard.md §1.2–1.4, phase 1a)
// ---------------------------------------------------------------------------

/** What the list can be sorted by. `agent` is an admin's only: a rep's book has one owner. */
export const MERCHANT_SORTS = ["added", "dba", "mid", "split", "agent"] as const;

export type MerchantSort = (typeof MERCHANT_SORTS)[number];

export type SortDirection = "asc" | "desc";

/** The direction a column sorts in when first clicked: newest, A–Z, highest rate. */
export const MERCHANT_SORT_DEFAULT_DIRECTION: Record<MerchantSort, SortDirection> = {
  added: "desc",
  dba: "asc",
  mid: "asc",
  split: "desc",
  agent: "asc",
};

/**
 * The merchant_list column each sort orders by. The three `_sort` columns are
 * the view's own keys (lower(dba), mid_key(mid), lower(full_name)), because
 * PostgREST orders by column name only. Every page also orders by id last, in
 * lib/merchants-data.ts, so equal keys never swap between loads.
 */
export const MERCHANT_SORT_COLUMN: Record<MerchantSort, string> = {
  added: "date_added",
  dba: "dba_sort",
  mid: "mid_sort",
  split: "split_agent_pct",
  agent: "agent_sort",
};

/** How each sort reads: the column's name and what each direction means. */
export const MERCHANT_SORT_LABELS: Record<
  MerchantSort,
  { name: string; asc: string; desc: string }
> = {
  added: { name: "Added", asc: "oldest first", desc: "newest first" },
  dba: { name: "DBA", asc: "A to Z", desc: "Z to A" },
  mid: { name: "MID", asc: "A to Z", desc: "Z to A" },
  split: { name: "Split", asc: "lowest first", desc: "highest first" },
  agent: { name: "Agent", asc: "A to Z", desc: "Z to A" },
};

export const MERCHANT_PAGE_SIZES = [25, 50, 100] as const;

export type MerchantPageSize = (typeof MERCHANT_PAGE_SIZES)[number];

export const MERCHANT_DEFAULT_PAGE_SIZE: MerchantPageSize = 25;

/** `?processor=none`: merchants with no processor set. */
export const PROCESSOR_NONE = "none";

/** The list's query string, untrusted. */
export type MerchantListSearchParams = {
  status?: string;
  processor?: string;
  agent?: string;
  split?: string;
  split_min?: string;
  split_max?: string;
  from?: string;
  to?: string;
  sort?: string;
  dir?: string;
  size?: string;
  page?: string;
};

export type MerchantListParams = {
  status: MerchantFilter;
  /** A processors.code, PROCESSOR_NONE, or null for any. */
  processor: string | null;
  /** The owner's profile id. Admin only; always null for a rep. */
  agent: string | null;
  /** True for "no rate set"; the range is then ignored. */
  splitNone: boolean;
  splitMin: number | null;
  splitMax: number | null;
  /** date_added bounds, inclusive, YYYY-MM-DD. */
  from: string | null;
  to: string | null;
  sort: MerchantSort;
  dir: SortDirection;
  size: MerchantPageSize;
  /** 1-based. Past the last page, the page shows the last one. */
  page: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A rate as the column holds it: at most two digits and two decimals (0–50 checked below). */
const RATE = /^\d{1,2}(\.\d{1,2})?$/;
/** No list is long enough for a bigger page number to mean anything. */
const MAX_PAGE = 100_000;

function parseRate(value: string | undefined): number | null {
  if (value === undefined || !RATE.test(value.trim())) return null;
  const rate = Number(value.trim());
  return rate >= 0 && rate <= 50 ? rate : null;
}

/**
 * Narrows the untrusted query string. Every field falls back to "no filter"
 * rather than being passed through — the parseDashboardFilters rule: a
 * malformed value reaching PostgREST is a 400 rendered as a broken page, where
 * dropping it is a page that is simply not filtered by something nobody could
 * read. Backwards ranges are dropped whole, because the query would answer them
 * with a confident "no merchants".
 *
 * `processors` is the loaded processor list: a code it does not hold is dropped
 * rather than sent, so a stale link reads as unfiltered instead of empty.
 *
 * `agent` and the agent sort are an admin's only. For a rep they could only
 * ever return their own book or nothing (RLS ANDs them with the policy), and a
 * control whose every setting is a no-op or a blank page is a broken control.
 */
export function parseMerchantListParams(
  raw: MerchantListSearchParams,
  options: { isAdmin: boolean; processors: readonly string[] },
): MerchantListParams {
  // A repeated param (`?page=1&page=2`) reaches a page as an array. Anything
  // but a single string is treated as absent, before any rule below runs.
  const params = Object.fromEntries(
    Object.entries(raw).filter(([, value]) => typeof value === "string"),
  ) as MerchantListSearchParams;

  const date =(value: string | undefined) =>
    value !== undefined && ISO_DATE.test(value) ? value : null;

  const processor =
    params.processor === PROCESSOR_NONE
      ? PROCESSOR_NONE
      : params.processor !== undefined && options.processors.includes(params.processor)
        ? params.processor
        : null;

  const agent =
    options.isAdmin && params.agent !== undefined && UUID.test(params.agent)
      ? params.agent.toLowerCase()
      : null;

  const splitNone = params.split === "none";
  let splitMin = splitNone ? null : parseRate(params.split_min);
  let splitMax = splitNone ? null : parseRate(params.split_max);
  if (splitMin !== null && splitMax !== null && splitMin > splitMax) {
    splitMin = null;
    splitMax = null;
  }

  let from = date(params.from);
  let to = date(params.to);
  if (from !== null && to !== null && from > to) {
    from = null;
    to = null;
  }

  let sort: MerchantSort = MERCHANT_SORTS.includes(params.sort as MerchantSort)
    ? (params.sort as MerchantSort)
    : "added";
  if (sort === "agent" && !options.isAdmin) sort = "added";
  const dir: SortDirection =
    params.dir === "asc" || params.dir === "desc"
      ? params.dir
      : MERCHANT_SORT_DEFAULT_DIRECTION[sort];

  const sizeNumber = Number(params.size);
  const size = MERCHANT_PAGE_SIZES.includes(sizeNumber as MerchantPageSize)
    ? (sizeNumber as MerchantPageSize)
    : MERCHANT_DEFAULT_PAGE_SIZE;

  const pageNumber = /^\d{1,6}$/.test(params.page ?? "") ? Number(params.page) : 1;
  const page = Math.min(Math.max(pageNumber, 1), MAX_PAGE);

  return {
    status: parseMerchantFilter(params.status),
    processor,
    agent,
    splitNone,
    splitMin,
    splitMax,
    from,
    to,
    sort,
    dir,
    size,
    page,
  };
}

/**
 * A `/merchants` href with some params changed and the rest kept — the job
 * dashboardHref and leadsHref do for their pages. Defaults are omitted, so the
 * unfiltered first page is plain `/merchants` and today's `?status=active`
 * links still mean what they meant.
 *
 * The page is NOT reset here: a caller changing a filter, the sort or the page
 * size passes `page: 1` itself, because only the caller knows whether the rows
 * on screen are about to change.
 */
export function merchantListHref(
  params: MerchantListParams,
  changes: Partial<MerchantListParams> = {},
): string {
  const next = { ...params, ...changes };
  const query = new URLSearchParams();
  if (next.status !== "all") query.set("status", next.status);
  if (next.processor !== null) query.set("processor", next.processor);
  if (next.agent !== null) query.set("agent", next.agent);
  if (next.splitNone) {
    query.set("split", "none");
  } else {
    if (next.splitMin !== null) query.set("split_min", String(next.splitMin));
    if (next.splitMax !== null) query.set("split_max", String(next.splitMax));
  }
  if (next.from !== null) query.set("from", next.from);
  if (next.to !== null) query.set("to", next.to);
  if (next.sort !== "added") query.set("sort", next.sort);
  if (next.dir !== MERCHANT_SORT_DEFAULT_DIRECTION[next.sort]) query.set("dir", next.dir);
  if (next.size !== MERCHANT_DEFAULT_PAGE_SIZE) query.set("size", String(next.size));
  if (next.page !== 1) query.set("page", String(next.page));
  const text = query.toString();
  return text === "" ? "/merchants" : `/merchants?${text}`;
}

/**
 * Where clicking a sort control goes: the same column flips direction, a new
 * column starts in its own default direction. Always back to page 1 — page 3
 * of one order has nothing to do with page 3 of another.
 */
export function merchantSortHref(params: MerchantListParams, sort: MerchantSort): string {
  const dir: SortDirection =
    params.sort === sort
      ? params.dir === "asc"
        ? "desc"
        : "asc"
      : MERCHANT_SORT_DEFAULT_DIRECTION[sort];
  return merchantListHref(params, { sort, dir, page: 1 });
}

/** Whether anything narrows the list (the sort, size and page do not). */
export function merchantFiltersActive(params: MerchantListParams): boolean {
  return (
    params.status !== "all" ||
    params.processor !== null ||
    params.agent !== null ||
    params.splitNone ||
    params.splitMin !== null ||
    params.splitMax !== null ||
    params.from !== null ||
    params.to !== null
  );
}

/** The last page for `total` rows (1 for an empty list), and the page actually shown. */
export function clampMerchantPage(
  page: number,
  total: number,
  size: number,
): { page: number; lastPage: number } {
  const lastPage = Math.max(1, Math.ceil(total / size));
  return { page: Math.min(page, lastPage), lastPage };
}
