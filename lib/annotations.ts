import type { FilterOption } from "@/components/filter-tabs";

/**
 * Notes and tasks: the two polymorphic Tier 1 tables, and the vocabulary they
 * share.
 *
 * One module for both because they are the same shape and are always built,
 * queried and tested together (see tests/rls/notes-tasks.test.ts). Pure types
 * and constants only — the server-side reads live in lib/annotations-data.ts, so
 * that a client component importing these types cannot drag
 * lib/supabase/server into the browser bundle.
 *
 * ANNOTATION_OWNER_TYPES mirrors the check constraint on `notes.owner_type` and
 * `tasks.owner_type` in
 * supabase/migrations/20260804201300_initial_schema.sql. If that constraint
 * changes, change this too — the database is the authority, this is a copy for
 * the UI's benefit.
 *
 * It is deliberately NOT the same set as DOCUMENT_OWNER_TYPES: documents can
 * hang off a support ticket, notes and tasks cannot. Sharing one union between
 * them would let a caller ask for something the check constraint rejects, and
 * the error would surface as a 400 from PostgREST rather than as a type error.
 */
export const ANNOTATION_OWNER_TYPES = [
  "lead",
  "pre_app",
  "merchant",
  "ghost_sheet",
] as const;

export type AnnotationOwnerType = (typeof ANNOTATION_OWNER_TYPES)[number];

export type Note = {
  id: number;
  agent_id: string;
  owner_type: AnnotationOwnerType;
  owner_id: number;
  body: string;
  created_at: string | null;
};

export type Task = {
  id: number;
  agent_id: string;
  owner_type: AnnotationOwnerType;
  owner_id: number;
  title: string;
  due_date: string | null;
  completed: boolean;
};

/** Columns each panel reads. One place, so the tests assert the same sets. */
export const NOTE_LIST_COLUMNS =
  "id, agent_id, owner_type, owner_id, body, created_at";

export const TASK_LIST_COLUMNS =
  "id, agent_id, owner_type, owner_id, title, due_date, completed";

/**
 * A row plus its author's display name, resolved server-side.
 *
 * The name is not on the row and cannot be — `notes` has no join to `profiles`
 * that RLS would allow through a PostgREST embed — so it is looked up separately
 * and attached. Null when the lookup returned nothing, which for an agent is
 * every author but themselves.
 */
export type WithAuthor<T> = T & { author_name: string | null };

/**
 * Whether a task is past due and still open.
 *
 * Compared as calendar dates, not timestamps: `due_date` is a `date` column, so
 * "today" must not be overdue at 00:01. Both sides are reduced to YYYY-MM-DD and
 * compared as strings, which is safe for ISO dates and sidesteps the timezone
 * question a Date comparison would raise.
 */
export function taskIsOverdue(task: Pick<Task, "due_date" | "completed">) {
  if (task.completed || task.due_date === null) return false;
  return task.due_date < new Date().toISOString().slice(0, 10);
}

/* -------------------------------------------------------------------------
 * The cross-record index pages (/notes, /tasks).
 *
 * The panels address one record; these pages collect every note or task the
 * caller can see, across all four owner types. Same policies, no owner filter —
 * `owner_type` appears in no policy on either table, so RLS scopes the wide
 * query exactly as it scopes the narrow one.
 * ---------------------------------------------------------------------- */

/**
 * Singular labels for the "Attached to" column.
 *
 * A Record over the union rather than a function with a default, so adding a
 * fifth owner type is a type error here instead of a blank cell in the UI.
 */
export const ANNOTATION_OWNER_LABELS: Record<AnnotationOwnerType, string> = {
  lead: "Lead",
  pre_app: "Pre-app",
  merchant: "Merchant",
  ghost_sheet: "Ghost sheet",
};

/**
 * The detail route for an owner record.
 *
 * Deliberately separate from `ownerHref` in lib/documents.ts and from
 * SEARCH_KIND_META in lib/search.ts, for the reason given at the top of this
 * file: the three owner-type unions are not the same set, and merging them
 * would let a caller ask for a pairing the check constraint rejects.
 *
 * Unlike the documents version this never returns null — all four annotation
 * owner types have a detail page. Whether the row still EXISTS is a different
 * question, and one only the query can answer; see WithOwner below.
 */
export function annotationOwnerHref(
  ownerType: AnnotationOwnerType,
  ownerId: number,
): string {
  switch (ownerType) {
    case "lead":
      return `/leads/${ownerId}`;
    case "pre_app":
      return `/pre-apps/${ownerId}`;
    case "merchant":
      return `/merchants/${ownerId}`;
    case "ghost_sheet":
      return `/ghost-sheets/${ownerId}`;
  }
}

/**
 * A row plus the record it hangs off, resolved server-side.
 *
 * `owner_href` is null when the owner lookup came back empty — the record was
 * deleted (owner_id carries no foreign key, so nothing cascades) or it belongs
 * to someone the caller cannot see. The index page is the first place in the app
 * where such a row is visible at all: the panels could never show one, because
 * nothing asks for that owner_id again. Rendering it unlinked keeps it visible
 * without offering a click that lands on a 404.
 */
export type WithOwner<T> = T & {
  owner_label: string;
  owner_href: string | null;
};

export const TASK_INDEX_FILTERS = [
  "open",
  "overdue",
  "completed",
  "all",
] as const;

export type TaskIndexFilter = (typeof TASK_INDEX_FILTERS)[number];

export const TASK_INDEX_FILTER_OPTIONS: readonly FilterOption<TaskIndexFilter>[] =
  [
    { value: "open", label: "Open" },
    { value: "overdue", label: "Overdue" },
    { value: "completed", label: "Completed" },
    { value: "all", label: "All" },
  ];

export const DEFAULT_TASK_INDEX_FILTER: TaskIndexFilter = "open";

/**
 * Narrows an untrusted `?status=` value.
 *
 * Falls back to the default rather than passing the raw value into the query,
 * where an unrecognised filter would return zero rows and read as "you have no
 * tasks" instead of "that filter doesn't exist" — the same reasoning as
 * parseLeadFilter.
 */
export function parseTaskIndexFilter(
  value: string | undefined,
): TaskIndexFilter {
  return TASK_INDEX_FILTERS.includes(value as TaskIndexFilter)
    ? (value as TaskIndexFilter)
    : DEFAULT_TASK_INDEX_FILTER;
}

/**
 * How many rows either index page will render.
 *
 * Both lists are unbounded by nature — an admin's note list grows with the whole
 * company's activity. The cap is surfaced in the UI when it bites rather than
 * silently truncating, because a list that quietly stops at 200 reads as "that's
 * everything".
 */
export const ANNOTATION_INDEX_LIMIT = 200;
