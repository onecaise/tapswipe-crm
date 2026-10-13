// Storage plumbing for the business document library (/documents).
//
// Dependency-free, like _shared/marketing-materials.ts, which this mirrors
// rule for rule: it takes nothing from @supabase/server, so it needs no import
// map of its own -- and, because it imports nothing, Next can re-export
// BUSINESS_DOCUMENTS_BUCKET from here without dragging anything into the
// browser bundle (lib/business-documents.ts does exactly that).
//
// Not imported from _shared/marketing-materials.ts, although several helpers
// are the same few lines: a library module carrying a marketing-named
// dependency for a sanitiser is the coupling those two modules already declined
// between each other. The rules are short enough that a drift is visible.

/**
 * The fourth private bucket -- ONE definition, used by the Edge Function and,
 * through lib/business-documents.ts, by the browser upload. A drifted bucket
 * name is not a mismatched label: the function would sign into one bucket and
 * the browser upload into another.
 */
export const BUSINESS_DOCUMENTS_BUCKET = "business-documents";

/**
 * Strips a filename down to something safe to put in a Storage key: no path
 * separators (a name like `../marketing/x` must not escape the document's
 * prefix, and the service role does the signing), no leading dot, capped. The
 * document id, not this string, makes a key unique.
 */
export function sanitizeFileName(name: unknown): string {
  const text = typeof name === "string" ? name.trim() : "";
  const cleaned = text
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);

  return cleaned === "" ? "document" : cleaned;
}

/** The object key for a document's file: `{document_id}/{file_name}`. */
export function buildBusinessDocumentKey(
  documentId: number,
  fileName: string,
): string {
  return `${documentId}/${sanitizeFileName(fileName)}`;
}

/**
 * Reads a storage key back into the pair it encodes, or null if it isn't one.
 * Exactly two non-empty segments, the first a positive integer -- the same
 * shape business_documents_file_key_matches_id enforces in the database.
 */
export function parseBusinessDocumentKey(
  fileKey: string,
): { documentId: number; fileName: string } | null {
  const parts = fileKey.split("/");
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) return null;

  const [idRaw, fileName] = parts;
  if (!/^[0-9]+$/.test(idRaw)) return null;
  const documentId = Number(idRaw);
  if (!Number.isSafeInteger(documentId) || documentId <= 0) return null;

  return { documentId, fileName };
}

/**
 * True when a stored file_key really is the key for that document's id.
 *
 * The CHECK constraint carries the same rule and is validated, so this is not
 * covering legacy rows. It is here so the signing step never trusts a column:
 * a relaxed constraint or a hand-written repair cannot become a signed URL for
 * an arbitrary object.
 */
export function fileKeyMatchesBusinessDocument(
  fileKey: unknown,
  documentId: unknown,
): boolean {
  if (
    typeof fileKey !== "string" ||
    (typeof documentId !== "number" && typeof documentId !== "string")
  ) {
    return false;
  }
  const parsed = parseBusinessDocumentKey(fileKey);
  if (!parsed) return false;
  return String(parsed.documentId) === String(documentId);
}

/** Positive integer check -- business_documents.id is `serial`. */
export function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** Trimmed non-empty string, capped. For category and title. */
export function cleanLabel(value: unknown, max = 120): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.slice(0, max);
}

/**
 * The browser's reported size, or null. A display hint only (see
 * business_documents.size_bytes): a value that is not a non-negative safe
 * integer is dropped rather than refused, because nothing decides anything
 * from it and refusing an upload over a label would be the wrong trade.
 */
export function sizeOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}
