// Storage plumbing for residual imports.
//
// Kept apart from _shared/residuals.ts, which is the parser and knows nothing
// about buckets or requests. Dependency-free for the same reason: no deno.json
// import map of its own.
//
// On `json`, `callerIsActive` and `callerIsAdmin`: the residual functions import
// those from _shared/admin-users.ts rather than getting a third copy. That file's
// header notes two copies exist (there and in _shared/documents.ts) and says to
// extract a shared module "if a third caller ever appears". This is that third
// caller — and the extraction is still deliberately deferred, because doing it
// properly means editing seven working, deployed functions to re-point their
// imports. That is real deploy risk for a JSON wrapper and two RPC calls. Reusing
// the existing copy adds no duplication, which was the actual concern.

/** The second private bucket. `documents` is the first; see the storage note in
 * docs/tapswipe_crm_schema.sql for why an import file could not live there. */
export const RESIDUAL_BUCKET = "residual-imports";

/**
 * Strips a filename down to something safe to put in a Storage key.
 *
 * Path separators are the point: a name like `../documents/x` would otherwise
 * escape the batch's prefix, and with the service-role client doing the signing
 * there is nothing else standing in the way. Everything outside a conservative
 * allow-list becomes an underscore, and the result is capped — a Storage key has a
 * length limit and a 300-character filename is not worth discovering that at.
 *
 * The batch id, not this string, is what makes a key unique, so collapsing two
 * different names to the same value is harmless.
 */
export function sanitizeFileName(name: unknown): string {
  const text = typeof name === "string" ? name.trim() : "";
  const cleaned = text
    .replace(/[^A-Za-z0-9._-]/g, "_")
    // Leading dots would make a hidden file and `..` a traversal attempt; both
    // are pointless here.
    .replace(/^\.+/, "")
    .slice(0, 120);

  return cleaned === "" ? "upload.xlsx" : cleaned;
}

/**
 * The object key for a batch's file: `{batch_id}/{file_name}`.
 *
 * The batch id leads, so every file for a batch is under one prefix and the row
 * that names it is the only way to find it. This is why the batch row is created
 * before the upload rather than after — the key cannot be built without its id.
 */
export function buildBatchKey(batchId: number, fileName: string): string {
  return `${batchId}/${sanitizeFileName(fileName)}`;
}

/**
 * A positive integer, for a batch id arriving as JSON.
 *
 * Three lines duplicated from _shared/documents.ts rather than imported, so this
 * module does not pull in a documents-named dependency for a type guard. The
 * duplication is self-evident and the rule cannot drift meaningfully.
 */
export function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
