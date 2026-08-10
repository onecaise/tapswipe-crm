import type { StatusIntent } from "@/components/status-badge";

/**
 * Shared support-ticket types, vocabulary and list-filter definitions.
 *
 * SUPPORT_TICKET_STATUSES mirrors the check constraint on
 * `support_tickets.status` added in
 * supabase/migrations/20260810171500_support_tickets_notes_tasks.sql. If that
 * constraint changes, change this too — the database is the authority, this is a
 * copy for the UI's benefit. Same arrangement as MERCHANT_STATUSES.
 *
 * The column was deliberately constrained *because* this list filters on it.
 * `leads.status` is bare text and the leads list filters on next_followup_date
 * instead, for exactly the reason this file would otherwise demonstrate: a
 * vocabulary that exists only here is free to drift from what the column holds.
 */
export const SUPPORT_TICKET_STATUSES = ["open", "pending", "closed"] as const;

export type SupportTicketStatus = (typeof SUPPORT_TICKET_STATUSES)[number];

/** Filter values accepted by the list page: a real status, or "all". */
export const SUPPORT_TICKET_FILTERS = [
  "all",
  ...SUPPORT_TICKET_STATUSES,
] as const;

export type SupportTicketFilter = (typeof SUPPORT_TICKET_FILTERS)[number];

export const SUPPORT_TICKET_FILTER_OPTIONS = SUPPORT_TICKET_FILTERS.map(
  (value) => ({ value, label: value === "all" ? "All" : value }),
);

export type SupportTicket = {
  id: number;
  agent_id: string;
  merchant_id: number | null;
  category: string | null;
  sub_category: string | null;
  priority: string | null;
  serial_number_imei: string | null;
  subject: string;
  message: string | null;
  status: SupportTicketStatus;
  created_at: string | null;
};

/** Columns the list page reads. One place, so a test can assert the same set. */
export const SUPPORT_TICKET_LIST_COLUMNS =
  "id, agent_id, merchant_id, subject, category, priority, status, created_at";

export type SupportTicketListRow = Pick<
  SupportTicket,
  | "id"
  | "agent_id"
  | "merchant_id"
  | "subject"
  | "category"
  | "priority"
  | "status"
  | "created_at"
>;

/**
 * Narrows an untrusted `?status=` value.
 *
 * Falls back to "all" rather than passing the raw value into the query, where an
 * unrecognised status returns zero rows and reads as "you have no tickets"
 * instead of "that filter doesn't exist".
 */
export function parseSupportTicketFilter(
  value: string | undefined,
): SupportTicketFilter {
  return SUPPORT_TICKET_FILTERS.includes(value as SupportTicketFilter)
    ? (value as SupportTicketFilter)
    : "all";
}

/**
 * The filter a viewer should land on.
 *
 * Everyone starts on the tickets that still need something doing, which is the
 * whole reason to open this page — closed tickets are reference material. Unlike
 * pre-apps there is no admin/agent split here: an admin's queue and a rep's own
 * list are both "what is still open".
 */
export const DEFAULT_SUPPORT_TICKET_FILTER: SupportTicketFilter = "open";

/**
 * Open is amber, not red.
 *
 * An open ticket is work waiting on someone, which is what amber means
 * everywhere else in the app; red is reserved for actions. The sidebar's count
 * pill is the one place open tickets show brand red, and that is an accent
 * drawing the eye to a number rather than a status colour.
 *
 * Each status gets a distinct intent, which is the point of mapping through this
 * function at all — amber for needs-work, grey for parked, green for done. The
 * previous mapping put open on `destructive` and pending on `secondary`; keeping
 * all three separable is what stops the list flattening into one colour.
 */
export function supportTicketStatusIntent(
  status: SupportTicketStatus,
): StatusIntent {
  if (status === "open") return "warning";
  if (status === "pending") return "neutral";
  return "success";
}

/**
 * Suggestions for the free-text reference fields, offered through a native
 * <datalist> the way documents-panel.tsx does for doc_type.
 *
 * Deliberately NOT a constraint and not a <select>: these are the values an
 * admin will want to extend without a migration, and a rep with a genuinely new
 * category needs to be able to type it rather than pick the closest wrong one.
 * The database agrees — only `status` is constrained.
 */
export const TICKET_CATEGORIES = [
  "Hardware",
  "Billing",
  "Statements",
  "Chargebacks",
  "Funding",
  "Account changes",
  "Other",
] as const;

export const TICKET_PRIORITIES = ["Low", "Normal", "High", "Urgent"] as const;
