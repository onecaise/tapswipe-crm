/**
 * The business document library behind /documents, browser side.
 *
 * Modelled on lib/marketing-materials.ts. See docs/tapswipe_crm_schema.sql
 * (BUSINESS DOCUMENTS) for the table and why it replaced the per-record
 * `documents` uploads.
 */

/**
 * The bucket's name -- ONE definition, re-exported from the Edge Function side
 * rather than copied, exactly as MARKETING_BUCKET is. Next can import a
 * dependency-free module under supabase/functions/_shared; a Deno function
 * cannot import from lib/. A drifted name would make the function sign into one
 * bucket and the browser upload into another.
 */
export { BUSINESS_DOCUMENTS_BUCKET } from "@/supabase/functions/_shared/business-documents";

export type BusinessDocument = {
  id: number;
  category: string;
  title: string;
  file_key: string | null;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  uploaded_by: string;
  uploaded_at: string | null;
  archived_at: string | null;
};

export const BUSINESS_DOCUMENT_COLUMNS =
  "id, category, title, file_key, file_name, mime_type, size_bytes, uploaded_by, uploaded_at, archived_at";

/**
 * Suggested categories behind a datalist. `category` is free text in the
 * schema, so these are suggestions, not a vocabulary.
 */
export const SUGGESTED_CATEGORIES = [
  "Policies",
  "Procedures",
  "Agreements",
  "Forms",
  "Guides",
  "Training",
  "Other",
] as const;

/**
 * The upload ceiling, matching the bucket's file_size_limit (52428800, set by
 * 20261013120500). Its own constant rather than MAX_MATERIAL_BYTES: two buckets,
 * two limits set independently.
 */
export const MAX_BUSINESS_DOCUMENT_BYTES = 50 * 1024 * 1024;

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
 * Why a file cannot be published, or null if it can. A courtesy, not the
 * boundary -- the bucket's limit is what refuses an over-size PUT. What this
 * buys is a sentence instead of a 413, and catching the empty file, which
 * uploads happily and looks real until a rep opens it.
 */
export function businessDocumentUploadProblem(file: {
  size: number;
}): string | null {
  if (file.size === 0) {
    return "That file is empty.";
  }
  if (file.size > MAX_BUSINESS_DOCUMENT_BYTES) {
    return `That file is ${formatBytes(file.size)}. The limit is ${formatBytes(
      MAX_BUSINESS_DOCUMENT_BYTES,
    )}.`;
  }
  return null;
}

/**
 * Plain words for what business-document-file-url and Storage can answer, in
 * the manner of QA-008 and lib/db-errors.ts.
 *
 * The function's own 4xx messages are short and accurate but written for a
 * developer ("Document has no file yet"); its 5xx messages carry Storage's raw
 * text ("Could not create upload URL: The related resource does not exist"),
 * which is a fact about the server nobody on the page can act on. So: the known
 * 4xx answers become sentences, any 5xx or missing status becomes the caller's
 * fallback, and anything unrecognised passes through unchanged rather than
 * being guessed at.
 */
export const LIBRARY_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  "Document not found":
    "That document is no longer in the library. Refresh the page to see what is.",
  "Document has no file yet":
    "That document's file never finished uploading. An admin needs to publish it again.",
  "Account is not active":
    "Your account is no longer active, so the library is closed to it.",
  "Admin only": "Only an admin can publish documents.",
};

export function friendlyLibraryError(
  message: string | null | undefined,
  status: number | undefined,
  fallback: string,
): string {
  if (!message) return fallback;
  if (Object.hasOwn(LIBRARY_ERROR_MESSAGES, message)) {
    return LIBRARY_ERROR_MESSAGES[message];
  }
  // No status means the request never got an answer (the function is down or
  // unreachable); a 5xx means it answered with a server fault. Either way the
  // text is about the server, not about anything the person did.
  if (status === undefined || status >= 500) return fallback;
  return message;
}

/**
 * Plain words for a failed browser PUT into the bucket. Storage answers an
 * over-size object with a 413 whose text names a "maximum allowed size"; the
 * limit is the same one businessDocumentUploadProblem() checks first, so this
 * is only reached when the two disagree -- worth a sentence anyway.
 */
export function friendlyUploadError(err: unknown, fallback: string): string {
  const message =
    err !== null && typeof err === "object" && "message" in err
      ? String((err as { message: unknown }).message)
      : "";
  if (/maximum allowed size|payload too large|413/i.test(message)) {
    return `That file is larger than the ${formatBytes(
      MAX_BUSINESS_DOCUMENT_BYTES,
    )} limit.`;
  }
  return fallback;
}

/**
 * Groups documents by category in display order: categories alphabetical,
 * titles alphabetical within each, so adding one never reshuffles the page.
 */
export function groupByCategory(
  documents: BusinessDocument[],
): { category: string; documents: BusinessDocument[] }[] {
  const byCategory = new Map<string, BusinessDocument[]>();
  for (const doc of documents) {
    const list = byCategory.get(doc.category);
    if (list) list.push(doc);
    else byCategory.set(doc.category, [doc]);
  }
  return [...byCategory.entries()]
    .map(([category, list]) => ({
      category,
      documents: [...list].sort((a, b) => a.title.localeCompare(b.title)),
    }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

/**
 * True when a document has a file behind it. A null file_key is an upload
 * that started and never finished: the rep list hides it, the manage page
 * shows it with a warning.
 */
export function hasFile(doc: BusinessDocument): boolean {
  return typeof doc.file_key === "string" && doc.file_key !== "";
}
