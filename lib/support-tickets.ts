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
 * Sort order for the list: open, then pending, then closed.
 *
 * Applied in application code rather than in the query because PostgREST has no
 * way to express a CASE ordering, and the three status words do not sort into
 * this order alphabetically in either direction. The list is fetched whole and
 * unpaginated, so sorting it here costs nothing and keeps the rule readable.
 *
 * It exists because the page subtitle says "Open tickets first" and only the
 * default filter honoured it — the All view was plain id-desc, so a closed
 * ticket could sit above an open one.
 */
const STATUS_RANK: Record<string, number> = {
  open: 0,
  pending: 1,
  closed: 2,
};

export function compareByStatusThenNewest(
  a: { status: string; id: number },
  b: { status: string; id: number },
): number {
  // Unknown statuses sort last rather than first: `status` is constrained
  // today, but a value outside the three is not something to promote.
  const rank =
    (STATUS_RANK[a.status] ?? Number.MAX_SAFE_INTEGER) -
    (STATUS_RANK[b.status] ?? Number.MAX_SAFE_INTEGER);
  return rank !== 0 ? rank : b.id - a.id;
}

/**
 * Priority, as a badge intent.
 *
 * It rendered as plain body text in both the list and the detail page, so an
 * Urgent ticket was typographically identical to a Normal one — the column
 * existed and carried no weight at all.
 *
 * Two intents, not four. Amber means "this one is louder than the rest"; grey
 * means it is not. Giving High and Urgent separate colours would need a fourth
 * status colour that does not exist, and the two that do — brand and
 * destructive red — are barred from status badges on purpose (see
 * components/status-badge.tsx). The vocabulary is ordered but the colour system
 * is not, so this maps the ordering onto the one distinction it can carry
 * honestly, and the word itself still says which of the two it is.
 *
 * Unknown values are neutral rather than assumed loud: the column is
 * unconstrained, so a value outside TICKET_PRIORITIES is something a person
 * typed and nothing here can rank it.
 */
export function supportTicketPriorityIntent(
  priority: string | null | undefined,
): StatusIntent {
  return priority === "High" || priority === "Urgent" ? "warning" : "neutral";
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

/**
 * Priority is the exception to the paragraph above: a <select>, not a datalist.
 *
 * The column stays unconstrained — an admin can still introduce a new level
 * without a migration, and an old row holding one still displays. But the
 * datalist rendered as a plain textbox pre-filled "Normal", with no affordance
 * saying other values existed, so in practice the field read as fixed. Four
 * ordered levels are a vocabulary, unlike category's open-ended reference data,
 * and a control that shows all four is worth more than the ability to type a
 * fifth by hand.
 *
 * supportTicketPriorityOptions() is what the form renders: these four, plus
 * whatever the ticket already holds if it is not among them, so editing an old
 * ticket cannot silently rewrite its priority.
 */
export const TICKET_PRIORITIES = ["Low", "Normal", "High", "Urgent"] as const;

export const DEFAULT_TICKET_PRIORITY = "Normal";

export function supportTicketPriorityOptions(
  current: string | null | undefined,
): string[] {
  const options: string[] = [...TICKET_PRIORITIES];
  if (
    current !== null &&
    current !== undefined &&
    current !== "" &&
    !options.includes(current)
  ) {
    // Preserved rather than coerced: the stored value is what this ticket
    // actually says, and a save should not quietly change a field nobody
    // touched.
    options.push(current);
  }
  return options;
}
