/**
 * Plain-language messages for the database errors a form can actually hit
 * (D-05 / C2).
 *
 * PostgREST hands the browser Postgres's own text — "numeric field overflow",
 * "duplicate key value violates unique constraint …" — which names columns and
 * constraints a rep has never seen and cannot act on. This maps the five common
 * SQLSTATEs to sentences, and deliberately touches nothing else:
 *
 *  - **Our own RPCs and triggers raise P0001 or PT4xx** (checked: every
 *    `errcode =` in supabase/migrations is PT400/403/404/409/422), and those
 *    messages were written for people. They pass through verbatim. Any other
 *    code does too, unchanged from before.
 *  - **A form's own wording for a code wins** (`overrides`), because some forms
 *    already say something more specific — "That MID is already in use." — and
 *    a generic sentence would be a step backwards.
 *
 * Applied ONLY to the busiest forms (leads, merchants, support tickets,
 * pre-apps, products, proposals). The rest still show `error.message`; the list
 * is in qa/QA-REPORT.md under C2.
 */
export const DB_ERROR_MESSAGES = {
  "23505": "That would duplicate something that already exists. Check the details and try again.",
  "23503": "That refers to a record that no longer exists or that you can't use.",
  "23514": "One of the values isn't allowed here. Check the fields and try again.",
  "22003": "A number is too large for this field.",
  "22P02": "One of the values isn't in the format this field expects.",
} as const;

export function friendlyDbError(
  err: unknown,
  fallback: string,
  overrides?: Readonly<Record<string, string>>,
): string {
  const code =
    err !== null && typeof err === "object" && "code" in err && typeof err.code === "string"
      ? err.code
      : undefined;

  if (code !== undefined) {
    if (overrides && Object.hasOwn(overrides, code)) return overrides[code];
    if (Object.hasOwn(DB_ERROR_MESSAGES, code)) {
      return DB_ERROR_MESSAGES[code as keyof typeof DB_ERROR_MESSAGES];
    }
  }

  const message =
    err !== null && typeof err === "object" && "message" in err ? err.message : undefined;
  return typeof message === "string" && message.length > 0 ? message : fallback;
}
