import { createClient } from "@/lib/supabase/server";
import {
  ANNOTATION_INDEX_LIMIT,
  NOTE_LIST_COLUMNS,
  TASK_LIST_COLUMNS,
  annotationOwnerHref,
  ANNOTATION_OWNER_LABELS,
  type AnnotationOwnerType,
  type Note,
  type Task,
  type TaskIndexFilter,
  type WithAuthor,
  type WithOwner,
} from "@/lib/annotations";
import { PG_TODAY } from "@/lib/leads";

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

/* =========================================================================
 * The cross-record index pages (/notes, /tasks).
 *
 * Same tables, same policies, opposite addressing: loadAnnotations above asks
 * for one record's annotations, these ask for all of the caller's across every
 * owner type. This is the one place in the app that legitimately omits
 * `owner_type` from the query — the standing rule at the top of this file is
 * about addressing a single record, where dropping it would mix a merchant's
 * notes into a lead with the same id. Here nothing is being addressed, so the
 * pair is carried through to the resolution step instead of the WHERE clause,
 * and every lookup below keys on `${owner_type}:${owner_id}` rather than on
 * owner_id alone. A lead and a merchant really do share id 1 in the fixtures.
 *
 * `agent_id` is still absent for the usual reason: RLS enforces it whether the
 * query mentions it or not, and a copy of the policy in application code is how
 * the two drift apart.
 * ====================================================================== */

export type AnnotationIndexResult<T> = {
  rows: T[];
  /** True when the row cap bit, so the page can say so rather than imply completeness. */
  truncated: boolean;
  error: string | null;
};

/** Display name column per owner table. The pair is the key; this is the label. */
const OWNER_NAME_SOURCES: Record<
  AnnotationOwnerType,
  { table: string; nameColumn: string }
> = {
  lead: { table: "leads", nameColumn: "dba" },
  pre_app: { table: "pre_apps", nameColumn: "dba_name" },
  merchant: { table: "merchants", nameColumn: "dba" },
  ghost_sheet: { table: "ghost_sheets", nameColumn: "dba" },
};

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

/**
 * Author display names for a set of rows.
 *
 * Unconditional rather than admin-only: for an agent it returns their own
 * profile row and nothing else (the profiles select policy is own-row plus
 * admin), so it costs one cheap query and means a rep sees their own byline.
 */
async function resolveAuthors(
  supabase: SupabaseServerClient,
  rows: { agent_id: string }[],
): Promise<Map<string, string>> {
  const authorIds = [...new Set(rows.map((row) => row.agent_id))];
  if (authorIds.length === 0) return new Map();

  const { data } = await supabase
    .from("profiles")
    .select("id, full_name")
    .in("id", authorIds);

  return new Map(
    (data ?? []).map((p) => [p.id as string, p.full_name as string]),
  );
}

/**
 * Attaches the owner record's label and link to each row.
 *
 * One select per owner type actually present, each `.in("id", ids)` and each
 * independently RLS-scoped — four plain selects rather than an embed, matching
 * the rule the other list pages follow. There is no relationship to embed here
 * in any case: owner_id carries no foreign key, which is exactly why a row can
 * come back with no owner at all.
 */
async function attachOwners<T extends { owner_type: AnnotationOwnerType; owner_id: number }>(
  supabase: SupabaseServerClient,
  rows: T[],
): Promise<WithOwner<T>[]> {
  const idsByType = new Map<AnnotationOwnerType, Set<number>>();
  for (const row of rows) {
    const ids = idsByType.get(row.owner_type) ?? new Set<number>();
    ids.add(row.owner_id);
    idsByType.set(row.owner_type, ids);
  }

  // Keyed on the PAIR. Keying on owner_id alone would cross-wire a lead and a
  // merchant that share an id, and no policy would object — both rows can
  // legitimately belong to the caller.
  const names = new Map<string, string | null>();
  await Promise.all(
    [...idsByType].map(async ([ownerType, ids]) => {
      const { table, nameColumn } = OWNER_NAME_SOURCES[ownerType];
      // The select list is built from the owner type, so supabase-js cannot
      // parse it into a row type at compile time — it infers a ParserError for
      // any non-literal string. Cast once here, at the boundary, rather than
      // fetching `*` from four tables to keep the inference happy.
      const { data } = (await supabase
        .from(table)
        .select(`id, ${nameColumn}`)
        .in("id", [...ids])) as unknown as {
        data: Record<string, unknown>[] | null;
      };

      for (const owner of data ?? []) {
        names.set(
          `${ownerType}:${owner.id as number}`,
          (owner[nameColumn] as string | null) ?? null,
        );
      }
    }),
  );

  return rows.map((row) => {
    const key = `${row.owner_type}:${row.owner_id}`;
    const typeLabel = ANNOTATION_OWNER_LABELS[row.owner_type];

    // Absent from the map means the row was not returned: deleted, or not the
    // caller's to see. Either way there is nothing to link to.
    if (!names.has(key)) {
      return {
        ...row,
        owner_label: `${typeLabel} #${row.owner_id} (no longer available)`,
        owner_href: null,
      };
    }

    const name = names.get(key);
    return {
      ...row,
      owner_label:
        name === null || name === ""
          ? `${typeLabel} #${row.owner_id}`
          : `${typeLabel} · ${name}`,
      owner_href: annotationOwnerHref(row.owner_type, row.owner_id),
    };
  });
}

/** Every note the caller can see, newest first. */
export async function loadNoteIndex(): Promise<
  AnnotationIndexResult<WithOwner<WithAuthor<Note>>>
> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("notes")
    .select(NOTE_LIST_COLUMNS)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    // One over the cap, so "there is more" is known rather than guessed.
    .limit(ANNOTATION_INDEX_LIMIT + 1);

  if (error) return { rows: [], truncated: false, error: error.message };

  const all = (data ?? []) as Note[];
  const notes = all.slice(0, ANNOTATION_INDEX_LIMIT);
  const authors = await resolveAuthors(supabase, notes);

  return {
    rows: await attachOwners(
      supabase,
      notes.map((note) => ({
        ...note,
        author_name: authors.get(note.agent_id) ?? null,
      })),
    ),
    truncated: all.length > ANNOTATION_INDEX_LIMIT,
    error: null,
  };
}

/** Every task the caller can see, filtered by status. */
export async function loadTaskIndex(
  filter: TaskIndexFilter,
): Promise<AnnotationIndexResult<WithOwner<WithAuthor<Task>>>> {
  const supabase = await createClient();

  let query = supabase
    .from("tasks")
    .select(TASK_LIST_COLUMNS)
    // Same ordering as the panel: open before done, then soonest due first.
    .order("completed", { ascending: true })
    .order("due_date", { ascending: true, nullsFirst: false })
    .order("id", { ascending: false })
    .limit(ANNOTATION_INDEX_LIMIT + 1);

  switch (filter) {
    case "open":
      query = query.eq("completed", false);
      break;
    case "overdue":
      // PG_TODAY keeps the boundary in the database rather than on a JS clock,
      // and means there is one definition of "today" in the app, not two.
      query = query.eq("completed", false).lt("due_date", PG_TODAY);
      break;
    case "completed":
      query = query.eq("completed", true);
      break;
    case "all":
      break;
  }

  const { data, error } = await query;

  if (error) return { rows: [], truncated: false, error: error.message };

  const all = (data ?? []) as Task[];
  const tasks = all.slice(0, ANNOTATION_INDEX_LIMIT);
  const authors = await resolveAuthors(supabase, tasks);

  return {
    rows: await attachOwners(
      supabase,
      tasks.map((task) => ({
        ...task,
        author_name: authors.get(task.agent_id) ?? null,
      })),
    ),
    truncated: all.length > ANNOTATION_INDEX_LIMIT,
    error: null,
  };
}
