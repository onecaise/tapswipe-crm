// Storage plumbing for the marketing material library.
//
// Dependency-free, like _shared/documents.ts and _shared/residual-imports.ts:
// it takes clients as arguments rather than importing @supabase/server, so it
// needs no deno.json import map of its own.
//
// On `json`, `callerIsActive` and `callerIsAdmin`: the two marketing functions
// import those from _shared/admin-users.ts rather than growing a fourth copy,
// which is the same call _shared/residual-imports.ts made and for the same
// reason — extracting them properly means re-pointing the imports of a dozen
// working, deployed functions, which is real deploy risk for a JSON wrapper and
// two RPC calls.

/** The third private bucket. See the storage note in
 *  docs/tapswipe_crm_schema.sql for why a material could live in neither of the
 *  other two. */
export const MARKETING_BUCKET = "marketing";

/**
 * The four things a rep can do with a material, mirroring the check constraint
 * on marketing_material_events.event_type.
 *
 * 'emailed' is logged by the UI today and does not send anything — the proposal
 * email feature does not exist yet. See the note in components/
 * marketing-material-actions.tsx: when it lands, the send goes there and this
 * stays exactly as it is, because the event is a record of intent either way.
 */
export const MARKETING_EVENT_TYPES = [
  "viewed",
  "downloaded",
  "printed",
  "emailed",
] as const;

export type MarketingEventType = (typeof MARKETING_EVENT_TYPES)[number];

export function isMarketingEventType(
  value: unknown,
): value is MarketingEventType {
  return MARKETING_EVENT_TYPES.includes(value as MarketingEventType);
}

/**
 * Strips a filename down to something safe to put in a Storage key.
 *
 * Copied in spirit from _shared/residual-imports.ts, and for the identical
 * reason: path separators would let a name like `../documents/x` escape the
 * material's prefix, and with the service-role client doing the signing there
 * is nothing else in the way. The material id, not this string, makes a key
 * unique, so collapsing two different names to the same value is harmless.
 *
 * Not imported from that module: this one would then carry a residual-named
 * dependency for a sanitiser, and residual-imports.ts already made the same
 * call about isPositiveInt. The rule is short enough that the duplication is
 * self-evident and cannot drift meaningfully.
 */
export function sanitizeFileName(name: unknown): string {
  const text = typeof name === "string" ? name.trim() : "";
  const cleaned = text
    .replace(/[^A-Za-z0-9._-]/g, "_")
    // A leading dot makes a hidden file and `..` is a traversal attempt.
    .replace(/^\.+/, "")
    .slice(0, 120);

  return cleaned === "" ? "material" : cleaned;
}

/**
 * The object key for a material's file: `{material_id}/{file_name}`.
 *
 * The id leads, so every file for a material sits under one prefix and the row
 * naming it is the only way to find it. This is why the material row is created
 * BEFORE the upload rather than after — the key cannot be built without its id,
 * exactly as rep_payout_batches works.
 */
export function buildMaterialKey(materialId: number, fileName: string): string {
  return `${materialId}/${sanitizeFileName(fileName)}`;
}

/**
 * True when a stored file_key really is the key for that material's id.
 *
 * The database carries the same rule as a CHECK
 * (marketing_materials_file_key_matches_id), and unlike the documents pair that
 * constraint is VALIDATED — this table is new, so there are no legacy rows to
 * exempt. So this is NOT covering rows the constraint misses, which is what
 * fileKeyMatchesOwner() exists for. It is here for the other half of that
 * argument: re-deriving the key before handing it to the service role means the
 * signing step never trusts a column, so a future migration that relaxed the
 * CHECK, or a hand-written repair that bypassed it, cannot turn into a signed
 * URL for an arbitrary object.
 *
 * Structural rather than a prefix test, so it agrees with the constraint
 * exactly rather than approximately: a bare `startsWith` also accepts
 * `{id}/` with nothing after it (a directory, which signs a URL that can never
 * resolve) and `{id}/a/b` (nested, which buildMaterialKey would never mint).
 */
export function fileKeyMatchesMaterial(
  fileKey: unknown,
  materialId: unknown,
): boolean {
  if (
    typeof fileKey !== "string" ||
    (typeof materialId !== "number" && typeof materialId !== "string")
  ) {
    return false;
  }

  const parsed = parseMaterialKey(fileKey);
  if (!parsed) return false;

  // materialId arrives as a number from PostgREST and as whatever JSON carried
  // elsewhere, so compare as text — the parsed value is already known to be a
  // positive integer.
  return String(parsed.materialId) === String(materialId);
}

/**
 * Reads a storage key back into the pair it encodes, or null if it isn't one.
 *
 * Deliberately strict about shape, matching parseFileKey in _shared/documents.ts:
 * exactly two segments, neither empty, and the first a positive integer — so a
 * key with a traversal segment, a trailing slash, or extra depth is rejected
 * outright rather than half-understood.
 */
export function parseMaterialKey(
  fileKey: string,
): { materialId: number; fileName: string } | null {
  const parts = fileKey.split("/");
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) return null;

  const [materialIdRaw, fileName] = parts;
  if (!/^[0-9]+$/.test(materialIdRaw)) return null;
  const materialId = Number(materialIdRaw);
  if (!Number.isSafeInteger(materialId) || materialId <= 0) return null;

  return { materialId, fileName };
}

/** Positive integer check — material_id is `int` in the schema. */
export function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** Trimmed non-empty string, capped. Used for category and title, which are
 *  `text not null` with no vocabulary — so the only rules are "says something"
 *  and "is not a novel". */
export function cleanLabel(value: unknown, max = 120): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.slice(0, max);
}
