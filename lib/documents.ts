/**
 * Shared document types.
 *
 * DOCUMENT_OWNER_TYPES mirrors the check constraint on `documents.owner_type`,
 * and is duplicated in supabase/functions/_shared/documents.ts because Deno
 * Edge Functions can't import from here. If the constraint changes, all three
 * have to change.
 */
export const DOCUMENT_OWNER_TYPES = [
  "pre_app",
  "merchant",
  "support_ticket",
  "lead",
] as const;

export type DocumentOwnerType = (typeof DOCUMENT_OWNER_TYPES)[number];

export type DocumentRow = {
  id: number;
  agent_id: string;
  owner_type: DocumentOwnerType;
  owner_id: number;
  doc_type: string;
  file_key: string;
  file_name: string | null;
  mime_type: string | null;
  uploaded_at: string | null;
};

export const DOCUMENT_LIST_COLUMNS =
  "id, agent_id, owner_type, owner_id, doc_type, file_key, file_name, mime_type, uploaded_at";

/**
 * Suggested doc types, from §3's Document Center description. Free text in the
 * schema (`doc_type text not null`), so this is a convenience list rather than a
 * constraint — the input allows anything.
 */
export const SUGGESTED_DOC_TYPES = [
  "Driver's license",
  "Voided check",
  "Business verification",
  "Signed application",
  "Statement",
  "Other",
] as const;

export const OWNER_TYPE_LABELS: Record<DocumentOwnerType, string> = {
  pre_app: "Pre-app",
  merchant: "Merchant",
  support_ticket: "Support ticket",
  lead: "Lead",
};

/**
 * Where a document's owner lives in the app, for linking out of the list.
 *
 * All four owner types have a detail page now. This returned null for
 * support_ticket long after `/support-tickets/[id]` was built, so the Document
 * Center rendered "Support ticket #12" as dead grey text — the one owner type
 * whose documents you could never navigate to from the list. The return type
 * stays nullable rather than being narrowed to `string`, because a fifth owner
 * type will land in the check constraint before it has a page, and that is the
 * case this function exists to express.
 */
export function ownerHref(
  ownerType: DocumentOwnerType,
  ownerId: number,
): string | null {
  switch (ownerType) {
    case "merchant":
      return `/merchants/${ownerId}`;
    case "lead":
      return `/leads/${ownerId}`;
    case "pre_app":
      return `/pre-apps/${ownerId}`;
    case "support_ticket":
      return `/support-tickets/${ownerId}`;
  }
}

/**
 * The largest file the app will hand to Storage: 50 MiB.
 *
 * Chosen to match `[storage] file_size_limit` in config.toml, which is the
 * number the project already declared it wanted — but that setting does NOT
 * constrain a signed upload. Measured against the running local stack: with it
 * set to 50MiB, a 120 MiB PUT through `uploadToSignedUrl` was accepted, and so
 * was a 120 MiB service-role upload. The real server-side ceiling is the
 * per-bucket `file_size_limit`, which was null on both private buckets — so
 * until it is set out-of-band on the hosted project, this constant is the only
 * limit there is. See the storage notes in docs/tapswipe_crm_schema.sql.
 */
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

/**
 * Re-points a signed Storage URL at the API origin this client can actually
 * reach.
 *
 * The Edge Function signs with its own `SUPABASE_URL`, and that is not always
 * the URL the browser knows the project by. On the local stack it is
 * `http://kong:8000` — the container-internal hostname — so every signed URL the
 * function hands back is unresolvable from the browser, and the download button
 * did nothing at all in development. It failed silently, because navigating to
 * an unresolvable host is not an error the page can catch.
 *
 * A no-op in production, where the two are the same string. Only the ORIGIN is
 * replaced: the path and the `token` query parameter are the signature and are
 * left untouched, and the token is not bound to a hostname — the live suite has
 * always had to do this same rewrite to fetch a signed URL from the test
 * process, which is what made it clear the browser needed it too.
 *
 * Returns the URL unchanged if either side won't parse, on the principle that a
 * URL that might work beats one this function decided to mangle.
 */
export function reachableStorageUrl(
  signedUrl: string,
  apiUrl: string | undefined,
): string {
  if (!apiUrl) return signedUrl;
  try {
    const signed = new URL(signedUrl);
    const target = new URL(apiUrl);
    if (signed.origin === target.origin) return signedUrl;
    signed.protocol = target.protocol;
    signed.host = target.host;
    return signed.toString();
  } catch {
    return signedUrl;
  }
}

/** Human-readable byte count for an error message. Binary units, like the cap. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // One decimal below 10, none above: "9.8 MiB", "51 MiB".
  const rounded = value < 10 ? value.toFixed(1) : Math.round(value).toString();
  return `${rounded} ${units[unit]}`;
}

/**
 * Why a file can't be uploaded, or null if it can.
 *
 * Both checks are about failures that are otherwise *silent*. An empty file
 * uploads perfectly happily and produces a document whose row, badge and
 * download button all look exactly like a real one — the only way to find out
 * the driver's licence never made it is to open it. And with no size ceiling
 * anywhere below this, an accidental 4 GB video sat on "Uploading…" with no
 * progress, no error and no way to tell whether it was working.
 *
 * Deliberately NOT a file-type or extension check. The doc types here are
 * whatever a merchant sent — a phone photo, a bank's PDF, a scanner's TIFF — and
 * an allow-list would reject real paperwork for looking unfamiliar. Uploaded
 * bytes are never executed and never served inline: create-download-url signs
 * every object with `download`, so Storage answers with
 * `Content-Disposition: attachment` and an uploaded .html or .svg is saved
 * rather than rendered on the storage origin. That is what makes an open
 * accept-anything input safe here, and it is asserted in
 * tests/live/document-urls.test.ts rather than left as an assumption.
 */
export function documentUploadProblem(file: {
  size: number;
  name: string;
}): string | null {
  if (file.size === 0) {
    return `${file.name} is empty (0 bytes). Check the file and try again.`;
  }
  if (file.size > MAX_DOCUMENT_BYTES) {
    return `${file.name} is ${formatBytes(file.size)}. The limit is ${formatBytes(
      MAX_DOCUMENT_BYTES,
    )}.`;
  }
  return null;
}

