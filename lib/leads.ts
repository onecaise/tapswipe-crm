import type { FilterOption } from "@/components/filter-tabs";

/**
 * Shared lead types and list-filter definitions.
 *
 * Note `leads.status` is bare `text default 'open'` in the schema — no check
 * constraint, unlike `merchants.status`. So there is no database-defined
 * vocabulary to build a status filter from, and inventing one here would leave
 * the UI's list and the column's real contents free to drift apart. The list
 * filters on `next_followup_date` instead, which is the column §14.8 has us
 * index and the one §3 treats as core to working a lead.
 */
export type Lead = {
  id: number;
  agent_id: string;
  lead_source: string | null;
  merchant_legal_name: string | null;
  dba: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  business_phone: string | null;
  mobile_phone: string | null;
  contact_email: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  zip: string | null;
  next_followup_date: string | null;
  probability_to_close: string | null;
  preferred_communication_method: string | null;
  industry_vertical: string | null;
  status: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export const LEAD_LIST_COLUMNS =
  "id, agent_id, dba, contact_name, contact_phone, lead_source, industry_vertical, next_followup_date, status";

export type LeadListRow = Pick<
  Lead,
  | "id"
  | "agent_id"
  | "dba"
  | "contact_name"
  | "contact_phone"
  | "lead_source"
  | "industry_vertical"
  | "next_followup_date"
  | "status"
>;

export const LEAD_FILTERS = [
  "all",
  "overdue",
  "today",
  "next7",
  "unscheduled",
] as const;

export type LeadFilter = (typeof LEAD_FILTERS)[number];

export const LEAD_FILTER_OPTIONS: readonly FilterOption<LeadFilter>[] = [
  { value: "all", label: "All" },
  { value: "overdue", label: "Overdue" },
  { value: "today", label: "Due today" },
  { value: "next7", label: "Next 7 days" },
  { value: "unscheduled", label: "Unscheduled" },
];

/**
 * Narrows an untrusted `?filter=` value.
 *
 * Falls back to "all" rather than passing the raw value into the query, where an
 * unrecognised filter would return zero rows and read as "you have no leads"
 * instead of "that filter doesn't exist".
 */
export function parseLeadFilter(value: string | undefined): LeadFilter {
  return LEAD_FILTERS.includes(value as LeadFilter)
    ? (value as LeadFilter)
    : "all";
}

/**
 * Postgres accepts 'today' as a date literal, so the overdue/today boundaries
 * are evaluated by the database rather than from a JS clock.
 *
 * The one exception is the upper bound of "next 7 days": PostgREST filter values
 * can't carry expressions, so `today + 7` has to be computed here. This runs in
 * a server component, so it's the server's clock rather than a browser's — and
 * both Supabase and the Node runtime are UTC, so in practice it agrees with
 * `current_date`. Worth knowing it's the one date not resolved by the database.
 */
export const PG_TODAY = "today";

export function nextWeekBound(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 7);
  return date.toISOString().slice(0, 10);
}
