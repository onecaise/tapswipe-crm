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

/** Where a document's owner lives in the app, for linking out of the list. */
export function ownerHref(
  ownerType: DocumentOwnerType,
  ownerId: number,
): string | null {
  switch (ownerType) {
    case "merchant":
      return `/merchants/${ownerId}`;
    case "lead":
      return `/leads/${ownerId}`;
    // No pages for these yet — the rows can exist, there's just nowhere to go.
    case "pre_app":
    case "support_ticket":
      return null;
  }
}

