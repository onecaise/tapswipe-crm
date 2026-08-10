import {
  ClipboardListIcon,
  GhostIcon,
  LifeBuoyIcon,
  StoreIcon,
  TargetIcon,
  type LucideIcon,
} from "lucide-react";

/**
 * Client-side vocabulary for the `search_crm` RPC.
 *
 * The function is SECURITY INVOKER, so the caller's own RLS scopes the results:
 * nothing here needs to filter by agent, and nothing here should try. See
 * supabase/migrations/20260810180000_dashboard_counts_and_search.sql.
 */
export const SEARCH_KINDS = [
  "lead",
  "pre_app",
  "merchant",
  "ghost_sheet",
  "support_ticket",
] as const;

export type SearchKind = (typeof SEARCH_KINDS)[number];

/** One row of `search_crm`, exactly as the function returns it. */
export type SearchHit = {
  kind: SearchKind;
  record_id: number;
  title: string;
  subtitle: string | null;
};

/**
 * Mirrors the two-character floor inside `search_crm`.
 *
 * Duplicated rather than shared because the database is the authority and this
 * is a copy for the UI's benefit — the same arrangement as MERCHANT_STATUSES.
 * The value of having it here is that the browser can skip a round trip it
 * knows will return nothing; if the two ever disagree the function wins, and
 * the only symptom is a request that comes back empty.
 */
export const MIN_SEARCH_LENGTH = 2;

/** Label and destination per record kind. Icons match the sidebar's. */
export const SEARCH_KIND_META: Record<
  SearchKind,
  { label: string; icon: LucideIcon; href: (id: number) => string }
> = {
  lead: {
    label: "Leads",
    icon: TargetIcon,
    href: (id) => `/leads/${id}`,
  },
  pre_app: {
    label: "Pre-Apps",
    icon: ClipboardListIcon,
    href: (id) => `/pre-apps/${id}`,
  },
  merchant: {
    label: "Merchants",
    icon: StoreIcon,
    href: (id) => `/merchants/${id}`,
  },
  ghost_sheet: {
    label: "Ghost Sheets",
    icon: GhostIcon,
    href: (id) => `/ghost-sheets/${id}`,
  },
  support_ticket: {
    label: "Support Tickets",
    icon: LifeBuoyIcon,
    href: (id) => `/support-tickets/${id}`,
  },
};

/**
 * Groups hits by kind, preserving the order the function returned them in.
 *
 * `search_crm` orders by kind rank then title, so this only has to walk the list
 * once and never re-sorts — the ordering decision lives in SQL, in one place.
 */
export function groupHits(
  hits: SearchHit[],
): { kind: SearchKind; hits: SearchHit[] }[] {
  const groups: { kind: SearchKind; hits: SearchHit[] }[] = [];

  for (const hit of hits) {
    const last = groups.at(-1);
    if (last?.kind === hit.kind) {
      last.hits.push(hit);
    } else {
      groups.push({ kind: hit.kind, hits: [hit] });
    }
  }

  return groups;
}
