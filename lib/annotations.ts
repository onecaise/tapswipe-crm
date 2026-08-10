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
