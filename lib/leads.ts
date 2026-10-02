import type { FilterOption } from "@/components/filter-tabs";
import type { StatusIntent } from "@/components/status-badge";

/**
 * Shared lead types, the status vocabulary, and the two list filters.
 *
 * LEAD_STATUSES mirrors `leads_status_vocabulary` on `leads.status`, added by
 * supabase/migrations/20261002120000_leads_status_vocabulary.sql. If that
 * constraint changes, change this too — the database is the authority, this is
 * a copy for the UI's benefit, the same arrangement MERCHANT_STATUSES has.
 *
 * This file used to carry the opposite note: that `leads.status` was bare text
 * with no vocabulary to build a filter from, and that inventing one here would
 * let the UI's list and the column's real contents drift apart. The second half
 * of that was right, which is why the vocabulary now lives in the column rather
 * than only here.
 *
 * There is no `won`. A lead's win is derived from an approved pre-app or a
 * merchant pointing back at the lead — the same thing `dashboard_counts()`
 * does for `active_leads` — and never hand-set, so a rep cannot mark a deal won
 * that no application supports.
 */
export const LEAD_STATUSES = [
  "new",
  "contacted",
  "qualified",
  "proposal_sent",
  "application_sent",
  "nurturing",
  "lost",
] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** Display labels: the column stores snake_case, people read words. */
export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  proposal_sent: "Proposal sent",
  application_sent: "Application sent",
  nurturing: "Nurturing",
  lost: "Lost",
};

/**
 * Whether a value read from the database is one this build knows about.
 *
 * Worth having as its own function rather than an inline `includes`, because
 * `leads_status_vocabulary` ships NOT VALID: rows written before it exist and
 * hold arbitrary rep-typed strings, so every read path has to cope with a
 * status outside the vocabulary rather than assume the type is true.
 */
export function isLeadStatus(value: string | null): value is LeadStatus {
  return LEAD_STATUSES.includes(value as LeadStatus);
}

/**
 * Status colour, through the three shared intents only.
 *
 * `lost` is grey, not red. Brand and destructive red never appear on a status
 * badge (see components/status-badge.tsx) — a lost lead is an inert record, not
 * a danger, and colouring it like the delete button puts every closed-out row
 * in the palette reserved for "this action is irreversible".
 *
 * `application_sent` is the only success: it is the one stage that means the
 * work left this table and became a pre-app. `contacted` through `proposal_sent`
 * are all waiting on the merchant, which is what amber means everywhere else
 * here. `new` and `nurturing` are inert — nothing is pending on either.
 *
 * A value outside the vocabulary (a pre-migration row) is neutral rather than a
 * crash: see isLeadStatus.
 */
export function statusIntent(status: string | null): StatusIntent {
  if (status === "application_sent") return "success";
  if (
    status === "contacted" ||
    status === "qualified" ||
    status === "proposal_sent"
  ) {
    return "warning";
  }
  return "neutral";
}

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
  website: string | null;
  next_followup_date: string | null;
  probability_to_close: string | null;
  preferred_communication_method: string | null;
  industry_vertical: string | null;
  /**
   * Typed as `string`, not `LeadStatus`, and that is deliberate.
   *
   * The column is `not null` so it is never null, but `leads_status_vocabulary`
   * is NOT VALID — rows that predate it hold values outside the union, and
   * claiming otherwise in the type would make every consumer trust a narrowing
   * the database has not performed. Narrow with `isLeadStatus` at the point of
   * use instead.
   */
  status: string;
  /** Required when status is 'lost', enforced by leads_lost_reason_required. */
  lost_reason: string | null;
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

// ---------------------------------------------------------------------------
// Filter 1 — the pipeline, on ?status=
// ---------------------------------------------------------------------------

/** Filter values accepted by the list page: a real status, or "all". */
export const LEAD_STATUS_FILTERS = ["all", ...LEAD_STATUSES] as const;

export type LeadStatusFilter = (typeof LEAD_STATUS_FILTERS)[number];

export const LEAD_STATUS_FILTER_OPTIONS: readonly FilterOption<LeadStatusFilter>[] =
  LEAD_STATUS_FILTERS.map((value) => ({
    value,
    label: value === "all" ? "All" : LEAD_STATUS_LABELS[value],
  }));

/**
 * Narrows an untrusted `?status=` value.
 *
 * Falls back to "all" rather than passing the raw value into the query, where an
 * unrecognised status would return zero rows and read as "you have no leads"
 * instead of "that filter doesn't exist".
 */
export function parseLeadStatusFilter(
  value: string | undefined,
): LeadStatusFilter {
  return LEAD_STATUS_FILTERS.includes(value as LeadStatusFilter)
    ? (value as LeadStatusFilter)
    : "all";
}

// ---------------------------------------------------------------------------
// Filter 2 — the follow-up window, on ?followup=
// ---------------------------------------------------------------------------

/**
 * The original list filter, kept and moved off `?status=`.
 *
 * It was on `?status=` because every other list page here uses that param and
 * this one was the holdout — which was right while leads had no status to speak
 * of. Now it does, and `?status=` has to mean the status; a date window living
 * under that name would be the same kind of lie the free-text column was.
 * `next_followup_date` is still the column §14.8 has us index and §3 treats as
 * core to working a lead, so it stays, as the secondary filter.
 */
export const LEAD_FOLLOWUP_FILTERS = [
  "all",
  "overdue",
  "today",
  "next7",
  "unscheduled",
] as const;

export type LeadFollowupFilter = (typeof LEAD_FOLLOWUP_FILTERS)[number];

export const LEAD_FOLLOWUP_FILTER_OPTIONS: readonly FilterOption<LeadFollowupFilter>[] =
  [
    { value: "all", label: "Any date" },
    { value: "overdue", label: "Overdue" },
    { value: "today", label: "Due today" },
    { value: "next7", label: "Next 7 days" },
    { value: "unscheduled", label: "Unscheduled" },
  ];

/** Narrows an untrusted `?followup=` value. Same fallback reasoning as above. */
export function parseLeadFollowupFilter(
  value: string | undefined,
): LeadFollowupFilter {
  return LEAD_FOLLOWUP_FILTERS.includes(value as LeadFollowupFilter)
    ? (value as LeadFollowupFilter)
    : "all";
}

/**
 * Builds a `/leads` href that changes one filter and preserves the other.
 *
 * The whole point of two filters is combining them, so a tab that dropped the
 * other one would make the pair unusable — pick a stage, lose your date window,
 * pick the window back, lose the stage. Defaults are omitted from the query so
 * the unfiltered page stays `/leads`.
 */
export function leadsHref(
  status: LeadStatusFilter,
  followup: LeadFollowupFilter,
): string {
  const params = new URLSearchParams();
  if (status !== "all") params.set("status", status);
  if (followup !== "all") params.set("followup", followup);
  const query = params.toString();
  return query === "" ? "/leads" : `/leads?${query}`;
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
