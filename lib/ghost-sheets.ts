import type { FilterOption } from "@/components/filter-tabs";
import type { StatusIntent } from "@/components/status-badge";

/**
 * Shared ghost sheet types and list-filter definitions.
 *
 * Two schema differences from merchants and leads worth keeping in mind:
 *
 *   - `ghost_sheets` has no `updated_at` column, so it gets no set_updated_at()
 *     trigger and no "last updated" field on the detail page.
 *   - `lead_id` is a nullable FK to `leads`. It's null until the sheet is
 *     converted, and non-null afterwards, which makes it the authoritative
 *     record of conversion state — `status` is just a label alongside it.
 */
export type GhostSheet = {
  id: number;
  agent_id: string;
  lead_id: number | null;
  dba: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  notes: string | null;
  status: string | null;
  created_at: string | null;
};

export const GHOST_SHEET_LIST_COLUMNS =
  "id, agent_id, lead_id, dba, contact_name, contact_phone, status, created_at";

export type GhostSheetListRow = Pick<
  GhostSheet,
  | "id"
  | "agent_id"
  | "lead_id"
  | "dba"
  | "contact_name"
  | "contact_phone"
  | "status"
  | "created_at"
>;

/**
 * Filters on conversion state rather than `status`.
 *
 * Like leads, `ghost_sheets.status` is unconstrained text — but unlike leads
 * there's a column that genuinely records the distinction that matters here.
 * Filtering on `lead_id is null` is derived from behaviour rather than an
 * invented vocabulary, and it can't disagree with reality the way a status
 * string could.
 */
export const GHOST_SHEET_FILTERS = ["all", "open", "converted"] as const;

export type GhostSheetFilter = (typeof GHOST_SHEET_FILTERS)[number];

export const GHOST_SHEET_FILTER_OPTIONS: readonly FilterOption<GhostSheetFilter>[] =
  [
    { value: "all", label: "All" },
    { value: "open", label: "Open" },
    { value: "converted", label: "Converted" },
  ];

export function parseGhostSheetFilter(
  value: string | undefined,
): GhostSheetFilter {
  return GHOST_SHEET_FILTERS.includes(value as GhostSheetFilter)
    ? (value as GhostSheetFilter)
    : "all";
}

export function isConverted(sheet: {
  lead_id: number | null;
}): boolean {
  return sheet.lead_id !== null;
}

/**
 * Badge intent for a sheet's conversion state.
 *
 * Keyed off `lead_id` like everything else here, rather than off `status`: the FK
 * is the authoritative record of conversion, and the text column is just a label
 * that travels alongside it. Converting a sheet is the outcome the whole record
 * exists for, so it reads as success; unconverted is inert, not a problem.
 */
export function conversionIntent(sheet: {
  lead_id: number | null;
}): StatusIntent {
  return isConverted(sheet) ? "success" : "neutral";
}
