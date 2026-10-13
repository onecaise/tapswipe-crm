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
   * every row written since — merchants_location_required — but the column
   * types stay nullable because the constraint is NOT VALID: merchants that
   * predate it have neither, and they are listed for admins at
   * /admin/merchants/missing-location.
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
 * The PostgREST filter for merchants with no location: exactly the rows that
 * predate merchants_location_required, since every write after it must supply
 * both. One definition, so the admin count on the dashboard and the list it
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
