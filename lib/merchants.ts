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
  date_added: string | null;
  created_at: string | null;
  updated_at: string | null;
};

/** Columns the list page reads. Kept in one place so the test can assert on the same set. */
export const MERCHANT_LIST_COLUMNS =
  "id, agent_id, mid, dba, legal_business_name, status, processor, split_agent_pct, date_added";

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
>;

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

export function statusBadgeVariant(
  status: MerchantStatus,
): "default" | "secondary" | "outline" {
  if (status === "active") return "default";
  if (status === "inactive") return "secondary";
  return "outline";
}
