/**
 * The shape `check_duplicates()` returns, and how to say it in English.
 *
 * The RPC is `security definer` and reaches across every rep's book, so the
 * rows it hands back come in two kinds and the UI must never confuse them:
 *
 *   - `own`      a record the caller could already see under RLS. Safe to name
 *                and link, because nothing is disclosed that a list page would
 *                not already show them.
 *   - `redacted` a record in someone else's book, or a merchant that is not
 *                theirs. `record_id`, `title` and `subtitle` are NULL from the
 *                function — not blanked here, and not merely unrendered. Never
 *                write a component that tries to recover them.
 *
 * Nothing here blocks a save. See the migration for why a hard block on a
 * cross-book duplicate is unworkable: the rep cannot see the offending record,
 * so the only way past it is to type the phone number wrong.
 */
export type DuplicateVisibility = "own" | "redacted";

export type DuplicateRecordType = "lead" | "ghost_sheet" | "merchant";

export type DuplicateMatchedField =
  | "contact_email"
  | "phone"
  | "website"
  | "name"
  | "address";

export type DuplicateStrength = "exact" | "fuzzy";

export type DuplicateMatch = {
  visibility: DuplicateVisibility;
  record_type: DuplicateRecordType;
  /** NULL for every redacted row, by construction in the function. */
  record_id: number | null;
  title: string | null;
  subtitle: string | null;
  matched_field: DuplicateMatchedField;
  strength: DuplicateStrength;
};

/** What the rep typed that caused the hit. */
export const MATCHED_FIELD_LABELS: Record<DuplicateMatchedField, string> = {
  contact_email: "email address",
  phone: "phone number",
  website: "website",
  name: "business name",
  address: "address",
};

export const RECORD_TYPE_LABELS: Record<DuplicateRecordType, string> = {
  lead: "lead",
  ghost_sheet: "ghost sheet",
  merchant: "merchant",
};

/** Where an own-book match lives, so the rep can go and look at it. */
export function duplicateHref(match: DuplicateMatch): string | null {
  if (match.record_id === null) return null;
  switch (match.record_type) {
    case "lead":
      return `/leads/${match.record_id}`;
    case "ghost_sheet":
      return `/ghost-sheets/${match.record_id}`;
    case "merchant":
      return `/merchants/${match.record_id}`;
  }
}

/**
 * The sentence shown for a record the caller cannot see.
 *
 * Deliberately says what matched and what to do, and carries no detail about
 * the record itself — there is none to carry. A merchant gets its own wording
 * because "already a customer" and "someone else is working it" are different
 * problems with the same escalation path.
 */
export function redactedMessage(match: DuplicateMatch): string {
  const field = MATCHED_FIELD_LABELS[match.matched_field];
  const qualifier = match.strength === "fuzzy" ? "similar " : "";

  if (match.record_type === "merchant") {
    return `A ${qualifier}${field} already belongs to an existing merchant. This account may already be with Tapswipe — contact an admin before working it.`;
  }

  const what =
    match.record_type === "ghost_sheet" ? "ghost sheet" : "another rep's lead";
  return `A ${qualifier}${field} already appears on ${what} outside your book. Contact an admin to find out who owns it.`;
}

/** The sentence shown above a record the caller owns. */
export function ownMessage(match: DuplicateMatch): string {
  const field = MATCHED_FIELD_LABELS[match.matched_field];
  const qualifier = match.strength === "fuzzy" ? "Similar " : "Same ";
  return `${qualifier}${field} as this ${RECORD_TYPE_LABELS[match.record_type]} in your book:`;
}

/**
 * Collapses redacted rows for display.
 *
 * The function already aggregates them to (record_type, matched_field,
 * strength) so the row count cannot be read as a census of other people's
 * books. This only guards against a future caller rendering a list with
 * repeated sentences.
 */
export function splitMatches(matches: DuplicateMatch[]): {
  own: DuplicateMatch[];
  redacted: DuplicateMatch[];
} {
  return {
    own: matches.filter((m) => m.visibility === "own"),
    redacted: matches.filter((m) => m.visibility === "redacted"),
  };
}
