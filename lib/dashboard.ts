import {
  parseLeadStatusFilter,
  type LeadStatusFilter,
} from "@/lib/leads";

/**
 * The dashboard's filter vocabulary: parsing the URL, and building it back.
 *
 * Pure types and functions only — no Supabase import — so the filter bar can be
 * a plain server component and nothing here drags a client into the bundle.
 *
 * ## What these filters are, and what they are not
 *
 * They narrow a view the caller ALREADY HAS IN FULL. dashboard_counts() is
 * security invoker, so every parameter below is an extra WHERE clause ANDed on
 * top of the caller's own policies: an agent who somehow sends
 * `?rep=<another rep>` gets zeros, not that rep's numbers, because
 * `agent_id = other` and the policy's `agent_id = auth.uid()` cannot both hold.
 * That is why none of this needs a server-side permission check of its own, and
 * why nothing here may ever become a `security definer` call.
 *
 * The rep/manager/territory controls are nonetheless ADMIN-ONLY in the UI, for
 * a different reason: offering a rep a control that can only ever return their
 * own numbers or zero is offering a broken control. See components/
 * dashboard-filters.tsx.
 *
 * **manager and territory are reporting labels, not access boundaries.** No
 * policy reads either column, and filtering by a manager here gives an admin a
 * subset of what they could already see. It does not give a manager anything.
 */

/** The `?rep=` and `?manager=` params are uuids, and nothing else is accepted. */
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The two date params, as a `date` column's own shape. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type DashboardFilters = {
  /** One rep's book. */
  rep: string | null;
  /** Every rep reporting to this manager. One hop — see profiles.manager_id. */
  manager: string | null;
  territory: string | null;
  /** The lead pipeline stage, or "all". Shares the leads list's vocabulary. */
  stage: LeadStatusFilter;
  /** created_at lower bound, inclusive. */
  from: string | null;
  /** created_at upper bound, inclusive of the whole day — see the migration. */
  to: string | null;
};

export type DashboardSearchParams = {
  rep?: string;
  manager?: string;
  territory?: string;
  stage?: string;
  from?: string;
  to?: string;
};

/**
 * Narrows the untrusted query string.
 *
 * Every field falls back to "no filter" rather than being passed through, the
 * same reasoning parseLeadStatusFilter gives: a malformed value reaching the
 * RPC is a 400 from PostgREST ("invalid input syntax for type uuid") rendered
 * as a broken dashboard, where dropping it is a page that simply is not
 * filtered by the thing nobody can read anyway. These values come from links
 * and from a mangled URL, never from a person typing a uuid.
 *
 * `territory` is free text by design (profiles.territory has no vocabulary), so
 * it is only trimmed and length-capped — the cap matching set_territory()'s, so
 * a value this accepts is one the column could actually hold.
 */
export function parseDashboardFilters(
  params: DashboardSearchParams,
): DashboardFilters {
  const uuid = (value: string | undefined) =>
    value !== undefined && UUID.test(value) ? value : null;
  const date = (value: string | undefined) =>
    value !== undefined && ISO_DATE.test(value) ? value : null;

  const territory = (params.territory ?? "").trim();

  const from = date(params.from);
  const to = date(params.to);

  return {
    rep: uuid(params.rep),
    manager: uuid(params.manager),
    territory: territory === "" || territory.length > 64 ? null : territory,
    stage: parseLeadStatusFilter(params.stage),
    // A backwards range is dropped rather than sent, because the RPC would
    // answer it with a confident set of zeros and the page would read as "this
    // rep has no records" instead of "those dates are the wrong way round".
    ...(from !== null && to !== null && from > to
      ? { from: null, to: null }
      : { from, to }),
  };
}

/**
 * A `/dashboard` href with some filters changed and the rest preserved.
 *
 * The same job leadsHref does for the leads list's two filters, and for the
 * same reason: the whole point of six filters is combining them, so a control
 * that dropped the other five would make the set unusable. Defaults are omitted
 * so the unfiltered page stays `/dashboard`.
 */
export function dashboardHref(
  filters: DashboardFilters,
  changes: Partial<DashboardFilters> = {},
): string {
  const next = { ...filters, ...changes };
  const params = new URLSearchParams();

  if (next.rep !== null) params.set("rep", next.rep);
  if (next.manager !== null) params.set("manager", next.manager);
  if (next.territory !== null) params.set("territory", next.territory);
  if (next.stage !== "all") params.set("stage", next.stage);
  if (next.from !== null) params.set("from", next.from);
  if (next.to !== null) params.set("to", next.to);

  const query = params.toString();
  return query === "" ? "/dashboard" : `/dashboard?${query}`;
}

/** Whether anything is narrowed, so the page can offer a way back. */
export function dashboardFiltersActive(filters: DashboardFilters): boolean {
  return dashboardHref(filters) !== "/dashboard";
}

/**
 * The filters as dashboard_counts() arguments.
 *
 * Named exactly as the function's parameters, because supabase-js sends an RPC
 * body keyed by parameter name — a typo here is a PostgREST 404 ("could not
 * find the function"), not a silently unfiltered page, which is the failure
 * worth having.
 *
 * `stage: "all"` becomes null rather than the string "all": null is what tells
 * the function nobody asked about a stage, which is what makes leads_at_stage
 * null rather than a count of leads literally at stage 'all'.
 */
export function dashboardCountArgs(filters: DashboardFilters) {
  return {
    agent_id_input: filters.rep,
    manager_id_input: filters.manager,
    territory_input: filters.territory,
    status_input: filters.stage === "all" ? null : filters.stage,
    from_date_input: filters.from,
    to_date_input: filters.to,
  };
}

/**
 * The shape dashboard_counts() returns, as PostgREST sends it.
 *
 * count(*) is bigint, which arrives as a string — hence the union. The caller
 * coerces with Number() rather than trusting it, which is what the page did
 * before these filters existed and still does.
 */
export type DashboardCounts = {
  active_merchants: number | string | null;
  active_leads: number | string | null;
  ghost_sheets_total: number | string | null;
  pre_apps_total: number | string | null;
  open_tickets: number | string | null;
  /** Null when no stage filter was applied. Not zero — a different fact. */
  leads_at_stage: number | string | null;
};
