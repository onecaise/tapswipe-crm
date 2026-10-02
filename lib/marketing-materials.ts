/**
 * Shared marketing-library types for the browser side.
 *
 * MARKETING_EVENT_TYPES mirrors the check constraint on
 * marketing_material_events.event_type, and is duplicated in
 * supabase/functions/_shared/marketing-materials.ts because Deno Edge Functions
 * cannot import from here. If the constraint changes, all three change — the
 * same arrangement DOCUMENT_OWNER_TYPES already lives under.
 *
 * Unlike the pre-app secrets validators, nothing here is a security rule, so
 * the duplication carries no risk beyond a mismatched label: the database is
 * the thing that rejects a bad event_type, and it would reject it whichever
 * copy drifted.
 */
export const MARKETING_EVENT_TYPES = [
  "viewed",
  "downloaded",
  "printed",
  "emailed",
] as const;

export type MarketingEventType = (typeof MARKETING_EVENT_TYPES)[number];

export type MarketingMaterial = {
  id: number;
  category: string;
  title: string;
  file_key: string | null;
  file_name: string | null;
  mime_type: string | null;
  uploaded_by: string;
  uploaded_at: string | null;
  archived_at: string | null;
};

export const MATERIAL_LIST_COLUMNS =
  "id, category, title, file_key, file_name, mime_type, uploaded_by, uploaded_at, archived_at";

export type MarketingEvent = {
  id: number;
  material_id: number;
  lead_id: number | null;
  agent_id: string;
  event_type: MarketingEventType;
  occurred_at: string | null;
};

export const EVENT_COLUMNS =
  "id, material_id, lead_id, agent_id, event_type, occurred_at";

/** Past-tense labels, because every one of these describes something that has
 *  already happened — the row is written after the act, not before it. */
export const EVENT_LABELS: Record<MarketingEventType, string> = {
  viewed: "Viewed",
  downloaded: "Downloaded",
  printed: "Printed",
  emailed: "Emailed",
};

/**
 * Suggested categories, mirroring SUGGESTED_DOC_TYPES.
 *
 * `category` is `text not null` with no vocabulary in the schema — deliberately,
 * so marketing can invent a new kind of collateral without a migration — so this
 * is a convenience list behind a datalist, not a constraint. The input accepts
 * anything.
 */
export const SUGGESTED_CATEGORIES = [
  "Rate cards",
  "Sell sheets",
  "One-pagers",
  "Case studies",
  "Terminal guides",
  "Other",
] as const;

/**
 * The upload ceiling, matching MAX_DOCUMENT_BYTES.
 *
 * Deliberately the same number and deliberately its own constant: these are two
 * buckets with two per-bucket limits set independently, and writing
 * MAX_DOCUMENT_BYTES here would imply one ceiling governs both. If marketing
 * ever needs a 200 MiB video this moves and documents does not.
 */
export const MAX_MATERIAL_BYTES = 50 * 1024 * 1024;

/**
 * Why a file cannot be uploaded, or null if it can.
 *
 * Mirrors documentUploadProblem(), and is a courtesy rather than the boundary —
 * the per-bucket file_size_limit is what actually refuses an over-size PUT. What
 * this buys is a readable sentence instead of a 413 from Storage, and catching
 * the empty file, which uploads perfectly happily and produces a material that
 * looks real until somebody opens it in front of a merchant.
 */
export function materialUploadProblem(file: File): string | null {
  if (file.size === 0) {
    return "That file is empty.";
  }
  if (file.size > MAX_MATERIAL_BYTES) {
    return `That file is ${formatBytes(file.size)}. The limit is ${formatBytes(
      MAX_MATERIAL_BYTES,
    )}.`;
  }
  return null;
}

/** Human-readable byte count. Binary units, like the cap. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/**
 * Groups materials into categories, in display order.
 *
 * Categories are sorted alphabetically and materials by title within each, so
 * the library has a stable order rather than whatever the id sequence produced
 * — an admin adding a rate card should not reshuffle the page.
 */
export function groupByCategory(
  materials: MarketingMaterial[],
): { category: string; materials: MarketingMaterial[] }[] {
  const byCategory = new Map<string, MarketingMaterial[]>();
  for (const material of materials) {
    const list = byCategory.get(material.category);
    if (list) list.push(material);
    else byCategory.set(material.category, [material]);
  }

  return [...byCategory.entries()]
    .map(([category, list]) => ({
      category,
      materials: [...list].sort((a, b) => a.title.localeCompare(b.title)),
    }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

/**
 * True when a material has a file behind it.
 *
 * file_key is nullable because the row is created before the upload — so a null
 * is an upload that was started and never finished, not a data error. The admin
 * list says so and offers a re-upload; the rep-facing list hides the row
 * entirely, because a download button that can only ever return 409 is worse
 * than an absence.
 */
export function hasFile(material: MarketingMaterial): boolean {
  return typeof material.file_key === "string" && material.file_key !== "";
}
