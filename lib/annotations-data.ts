import { createClient } from "@/lib/supabase/server";
import {
  NOTE_LIST_COLUMNS,
  TASK_LIST_COLUMNS,
  type AnnotationOwnerType,
  type Note,
  type Task,
  type WithAuthor,
} from "@/lib/annotations";

/**
 * Every note and task hanging off one owner record, authors resolved.
 *
 * Called from the four detail pages (lead, pre-app, merchant, ghost sheet) so the
 * reads stay server-side and RLS does the scoping — an agent gets the rows they
 * wrote, an admin gets all of them. `owner_type` is passed as a literal by the
 * calling page, never from a searchParam, because owner_id carries no foreign key
 * and nothing in the database will catch a mismatched pair.
 *
 * Both filters matter and for different reasons: agent_id is enforced by RLS
 * whether the query mentions it or not, while `owner_type` + `owner_id` is
 * entirely on this query. Drop owner_type and a merchant's notes surface on the
 * lead page with the same id — both rows legitimately belong to the caller, so
 * no policy would object. That is what idx_notes_owner exists to serve, and what
 * tests/rls/notes-tasks.test.ts pins.
 */
export async function loadAnnotations(
  ownerType: AnnotationOwnerType,
  ownerId: number,
): Promise<{ notes: WithAuthor<Note>[]; tasks: WithAuthor<Task>[] }> {
  const supabase = await createClient();

  const [{ data: noteRows }, { data: taskRows }] = await Promise.all([
    supabase
      .from("notes")
      .select(NOTE_LIST_COLUMNS)
      .eq("owner_type", ownerType)
      .eq("owner_id", ownerId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false }),
    supabase
      .from("tasks")
      .select(TASK_LIST_COLUMNS)
      .eq("owner_type", ownerType)
      .eq("owner_id", ownerId)
      // Open before done, then soonest due first. Undated open tasks sort after
      // dated ones but still ahead of anything completed — a live task must not
      // end up below finished work.
      .order("completed", { ascending: true })
      .order("due_date", { ascending: true, nullsFirst: false })
      .order("id", { ascending: false }),
  ]);

  const notes = (noteRows ?? []) as Note[];
  const tasks = (taskRows ?? []) as Task[];

  // One lookup for both lists. Unconditional rather than admin-only: for an
  // agent it returns their own profile row and nothing else (the profiles select
  // policy is own-row plus admin), so it costs one cheap query and means a rep
  // sees their own name rather than a blank byline.
  const authorIds = [
    ...new Set([...notes, ...tasks].map((row) => row.agent_id)),
  ];
  let authors = new Map<string, string>();
  if (authorIds.length > 0) {
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, full_name")
      .in("id", authorIds);
    authors = new Map(
      (profiles ?? []).map((p) => [p.id as string, p.full_name as string]),
    );
  }

  const withAuthor = <T extends { agent_id: string }>(row: T) => ({
    ...row,
    author_name: authors.get(row.agent_id) ?? null,
  });

  return {
    notes: notes.map(withAuthor),
    tasks: tasks.map(withAuthor),
  };
}
