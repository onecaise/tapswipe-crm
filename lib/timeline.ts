/**
 * The lead timeline — one chronological feed over five sources the lead page
 * already loads, plus the admin-only audit trail.
 *
 * ## Why this file is pure, and where the one new query lives
 *
 * Everything here is a projection: the lead detail page already reads notes,
 * tasks, documents, quotes and marketing events, each under its own policy, to
 * render the five panels below the fold. The timeline is those same rows
 * re-sorted, so it costs no extra reads — `loadLeadTimelineExtras()` in
 * lib/timeline-data.ts adds the single source nobody else reads (`audit_log`)
 * and resolves bylines, and nothing else touches the network.
 *
 * That split is deliberate rather than tidy. A `loadLeadTimeline()` that did
 * its own six reads would double every one of them on the page's hot path, and
 * extending `loadAnnotations()` would push a lead-only concern into a function
 * four detail pages share. Keeping the merge pure is also what makes it
 * testable without a database — tests/unit/timeline.test.ts imports this file
 * directly, which it could not do if it reached `lib/supabase/server`.
 *
 * ## SCOPING: this file widens nothing, and cannot
 *
 * Every row handed in arrived through the caller's own policies. There is no
 * `security definer` RPC behind the feed and no service-role client; the
 * timeline is exactly as rich as RLS already allowed, and six separate policies
 * decide that rather than anything written here:
 *
 *   notes, tasks        own-row or admin
 *   documents           own-row or admin, where `agent_id` is the LEAD's owner
 *   quotes              own-row or admin
 *   marketing events    own-row or admin — so a rep sees their own trail only
 *   audit_log           `using (is_admin())`, with NO own-row branch at all
 *
 * The last one is the whole scoping story and is worth stating flatly: an
 * agent can read **zero** audit rows, on their own lead as much as anyone
 * else's. The grant exists (`grant select on audit_log to authenticated`), so
 * the query succeeds and returns nothing. So a rep's feed simply has no
 * `audit` entries in it, and the page says nothing about the gap — a
 * permanent "some events are hidden" line would be wallpaper on every lead,
 * and a conditional one would announce that an admin had touched the record,
 * which is precisely what the admin-only policy conceals.
 *
 * Nothing here filters by `agent_id`. That is the standing rule — a copy of a
 * policy in application code is how the two drift apart — and it holds
 * completely here, because unlike the dashboard digest the timeline means
 * "everything I may see about this lead" rather than a subset chosen by the
 * page.
 *
 * ## Which sources can carry a byline, and which must not
 *
 * Four of the six name their actor; two deliberately do not, and this is the
 * thing most likely to get "fixed" by someone reading `agent_id` and assuming
 * it means author:
 *
 *   notes, tasks      agent_id IS the author — the panels write profile.id
 *   marketing events  agent_id IS the acting rep, per the column's own comment
 *   audit_log         actor_id IS the actor, and is null for a service-role write
 *   documents         agent_id is the PARENT RECORD's owner, not the uploader
 *   quotes            agent_id is the owning rep — the page passes
 *                     lead.agent_id into QuotesPanel, not profile.id
 *
 * So an admin uploading a document or writing a quote on a rep's lead lands a
 * row stamped with the REP's id, which is what puts it in the rep's book and
 * what makes it the wrong value to print as a byline. The real actor for those
 * two is recorded in `audit_log` (`upload_document:lead`, `cross_agent_insert`)
 * and is therefore admin-only — so the honest rendering is no byline at all,
 * not a plausible wrong one.
 */

import {
  EVENT_LABELS,
  type MarketingEvent,
  type MarketingEventType,
} from "@/lib/marketing-materials";
import type { DocumentRow } from "@/lib/documents";
import type { Note, Task, WithAuthor } from "@/lib/annotations";
import type { Quote } from "@/lib/quotes";

/**
 * The feed's row cap.
 *
 * Applied after the merge, so the newest N survive whatever mix they came
 * from — capping per source would quietly drop a recent note because an old
 * lead had forty documents. The component says when it bit, for the reason
 * AnnotationIndexResult carries `truncated`: a list that silently ends reads
 * as a complete history.
 */
export const TIMELINE_LIMIT = 60;

export const TIMELINE_SOURCES = [
  "note",
  "task",
  "quote",
  "document",
  "marketing",
  "audit",
] as const;

export type TimelineSource = (typeof TIMELINE_SOURCES)[number];

/**
 * What each source is called on screen.
 *
 * "Admin trail" rather than "Audit": it is the one source a rep never sees, so
 * the badge should read as an explanation to the admin looking at it rather
 * than as jargon.
 */
export const TIMELINE_SOURCE_LABELS: Record<TimelineSource, string> = {
  note: "Note",
  task: "Task",
  quote: "Quote",
  document: "Document",
  marketing: "Marketing",
  audit: "Admin trail",
};

/**
 * Tie-break order when two entries share an instant, lowest first.
 *
 * Exact ties are normal rather than freak: `created_at` defaults to `now()`,
 * which is fixed for a whole transaction, so `create_quote_version()` writes a
 * quote and `log_cross_agent_change()` writes its audit row at a timestamp
 * equal to the microsecond. `audit` sorts last of the six because an audit row
 * is the *trace* of an act — at one instant the act itself reads first.
 */
const SOURCE_RANK: Record<TimelineSource, number> = {
  note: 0,
  task: 1,
  quote: 2,
  document: 3,
  marketing: 4,
  audit: 5,
};

export type TimelineEntry = {
  /** Unique across sources: ids collide between tables, the pair does not. */
  key: string;
  source: TimelineSource;
  /** The row's own id, and the within-source tie-break. */
  id: number;
  /** The raw timestamp, or null when the row carries none. */
  at: string | null;
  title: string;
  detail: string | null;
  /** Null when the source cannot name an actor — see the header. */
  actorName: string | null;
  href: string | null;
};

/** The columns the audit read asks for. One place, so the type matches. */
export const AUDIT_COLUMNS =
  "id, actor_id, action, table_name, row_id, created_at";

export type AuditRow = {
  id: number;
  actor_id: string | null;
  action: string;
  table_name: string | null;
  /** `text`, not an int — ids collide across tables, so never read it alone. */
  row_id: string | null;
  created_at: string | null;
};

/**
 * The three audited tables whose rows belong to a lead's story.
 *
 * `leads` is the lead itself; `quotes` and `pre_apps` are the records that come
 * off it, and an admin editing a rep's quote or approving the application that
 * came from this lead is the same story told one table over.
 *
 * `documents` is deliberately NOT here, and the reason is specific rather than
 * squeamish. Its audit rows split two ways: the upload ones duplicate the
 * `document` entries this feed already builds from the table itself, at a
 * coarser granularity; and the DELETE one — the single genuinely new fact,
 * since a delete leaves nothing behind — names a `row_id` whose row is gone, so
 * it cannot be matched to this lead by any filter available here. Including
 * `documents` would therefore add only the duplicates and still miss the one
 * event worth surfacing. Reaching the deletes needs an `owner_id` on the audit
 * row, which is a schema change, not a query.
 */
export const AUDITED_TIMELINE_TABLES = ["leads", "quotes", "pre_apps"] as const;

export type AuditedTimelineTable = (typeof AUDITED_TIMELINE_TABLES)[number];

/**
 * Human labels for the audit verbs this feed can show.
 *
 * Every title is factual about WHAT happened and silent about WHO: the byline
 * carries the actor, and the "Admin trail" badge supplies the framing. A title
 * reading "Updated by an administrator" would over-claim — the trigger fires
 * whenever the actor is not the row's owner, which includes a service-role
 * write with no actor at all.
 *
 * NOT a closed vocabulary, and that is why `auditActionLabel` has a fallback.
 * Several writers template the verb — `read_pre_app_secrets:full`,
 * `submit_pre_app_secrets:<kind>`, `upload_document:<owner_type>` — so an
 * unmapped action is the normal case rather than a bug, exactly as a
 * rep-typed `leads.status` predating its vocabulary is.
 */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  cross_agent_insert: "Record created",
  cross_agent_update: "Record updated",
  cross_agent_delete: "Record deleted",
  record_reassigned: "Reassigned to another rep",
  approve_pre_app: "Pre-app approved",
  decline_pre_app: "Pre-app declined",
  reopen_pre_app: "Pre-app reopened",
  read_pre_app_secrets: "Sensitive data viewed",
  submit_pre_app_secrets: "Sensitive data submitted",
};

/**
 * A readable title for an audit action, whatever it is.
 *
 * Tries the whole verb, then the part before a colon (so every
 * `read_pre_app_secrets:*` variant lands on one label with its qualifier
 * carried through), then falls back to the raw verb with its punctuation
 * softened. The fallback renders rather than crashes for the reason the lead
 * status badge does: a missing label must not take the page down.
 */
export function auditActionLabel(action: string): string {
  const exact = AUDIT_ACTION_LABELS[action];
  if (exact !== undefined) return exact;

  const colon = action.indexOf(":");
  if (colon > 0) {
    const stem = AUDIT_ACTION_LABELS[action.slice(0, colon)];
    const qualifier = action.slice(colon + 1).replace(/_/g, " ").trim();
    if (stem !== undefined && qualifier !== "") return `${stem} (${qualifier})`;
    if (stem !== undefined) return stem;
  }

  const words = action.replace(/[_:]+/g, " ").trim();
  if (words === "") return "Recorded action";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/* =========================================================================
 * Per-source projectors. Each takes rows the page already holds and returns
 * entries; none of them reads anything.
 * ====================================================================== */

export function noteEntries(
  notes: readonly WithAuthor<Note>[],
): TimelineEntry[] {
  return notes.map((note) => ({
    key: `note:${note.id}`,
    source: "note" as const,
    id: note.id,
    at: note.created_at,
    title: "Note added",
    detail: note.body,
    actorName: note.author_name,
    // No link: the note is rendered in full in the panel on this same page,
    // so a link would scroll the reader to a copy of what they just read.
    href: null,
  }));
}

/**
 * Tasks, dated by CREATION rather than by due date.
 *
 * A timeline is a record of what has happened, and a due date is a plan — a
 * task due next Tuesday placed next Tuesday would appear in the future, above
 * everything real. The due date rides along as detail instead.
 *
 * Completion is deliberately absent: `tasks` has no `completed_at`, only the
 * boolean, so there is no instant to place a "task completed" entry at.
 * Inventing one from `due_date` would date the event to when it was *meant* to
 * happen. The panel above shows current state; this shows when the work was
 * added.
 */
export function taskEntries(
  tasks: readonly WithAuthor<Task>[],
): TimelineEntry[] {
  return tasks.map((task) => ({
    key: `task:${task.id}`,
    source: "task" as const,
    id: task.id,
    at: task.created_at,
    title: task.completed ? "Task added (since completed)" : "Task added",
    detail:
      task.due_date === null
        ? task.title
        : `${task.title} — due ${task.due_date}`,
    actorName: task.author_name,
    href: null,
  }));
}

/**
 * Document uploads. No byline, on purpose — see the file header.
 *
 * `documents.agent_id` is the parent record's owner so the file lands in that
 * rep's book, which makes it precisely the wrong value to print as "uploaded
 * by". The uploader is in `audit_log` and so is admin-only.
 */
export function documentEntries(
  documents: readonly DocumentRow[],
): TimelineEntry[] {
  return documents.map((doc) => ({
    key: `document:${doc.id}`,
    source: "document" as const,
    id: doc.id,
    at: doc.uploaded_at,
    title: "Document uploaded",
    detail:
      doc.file_name === null || doc.file_name === ""
        ? doc.doc_type
        : `${doc.doc_type} — ${doc.file_name}`,
    actorName: null,
    href: null,
  }));
}

/**
 * Every quote version as its own event, which is what the append-only design
 * makes possible: an edit inserts a row rather than mutating one, so "v3 was
 * written on the 14th" is a fact the table still holds.
 *
 * Each links to the print page with an explicit `?quote=` rather than to the
 * bare group URL. The bare URL prints whatever is CURRENT now, so a v1 entry
 * pointing at it would show v3's figures under v1's date — the one thing the
 * version history exists to prevent.
 *
 * No byline, for the same reason documents have none: the page passes
 * `lead.agent_id` into the builder, so `quotes.agent_id` is the owning rep.
 */
export function quoteEntries(
  quotes: readonly Quote[],
  leadId: number,
): TimelineEntry[] {
  return quotes.map((quote) => ({
    key: `quote:${quote.id}`,
    source: "quote" as const,
    id: quote.id,
    at: quote.created_at,
    title:
      quote.version === 1
        ? "Quote created"
        : `Quote revised to v${quote.version}`,
    detail:
      quote.title === null || quote.title === ""
        ? `Version ${quote.version}`
        : `${quote.title} — version ${quote.version}`,
    actorName: null,
    href: `/leads/${leadId}/quotes/${quote.quote_group_id}/print?quote=${quote.id}`,
  }));
}

/**
 * `emailed` gets its own wording, and it is not decoration.
 *
 * No email feature exists in this codebase: the button logs the event and tells
 * the rep plainly that nothing was sent. A timeline row reading "Emailed" in a
 * list of things that happened is exactly how an admin comes to believe a
 * proposal went out — so the entry says what the row actually is. When sending
 * lands, this label changes with it.
 */
const MARKETING_TITLES: Record<MarketingEventType, string> = {
  viewed: EVENT_LABELS.viewed,
  downloaded: EVENT_LABELS.downloaded,
  printed: EVENT_LABELS.printed,
  emailed: "Logged as emailed — no email was sent",
};

export function marketingEntries(
  events: readonly MarketingEvent[],
  materialTitles: ReadonlyMap<number, string>,
  actorNames: ReadonlyMap<string, string>,
): TimelineEntry[] {
  return events.map((event) => ({
    key: `marketing:${event.id}`,
    source: "marketing" as const,
    id: event.id,
    at: event.occurred_at,
    title:
      MARKETING_TITLES[event.event_type] ?? auditActionLabel(event.event_type),
    // A material that has since been archived still has a title here, because
    // the page builds this map from the UNFILTERED library for that reason. A
    // miss means a row the caller cannot resolve at all, so it names the id
    // rather than inventing a title.
    detail:
      materialTitles.get(event.material_id) ??
      `Material #${event.material_id}`,
    actorName: actorNames.get(event.agent_id) ?? null,
    href: null,
  }));
}

/**
 * Audit rows, which for an agent is always an empty list.
 *
 * `row_id` is `text` and ids collide across tables, so an entry is only built
 * when the (table_name, row_id) PAIR resolves — a lead and a quote both
 * numbered 7 are real, and matching on the id alone would file one under the
 * other with no policy objecting.
 *
 * `quoteVersions` turns a quote id into the version a reader recognises, and
 * supplies the print link; a quote id on its own names nothing a person can
 * look up.
 */
export function auditEntries(
  rows: readonly AuditRow[],
  context: {
    leadId: number;
    quoteVersions: ReadonlyMap<number, { version: number; groupId: string }>;
    preAppId: number | null;
  },
  actorNames: ReadonlyMap<string, string>,
): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  for (const row of rows) {
    if (row.table_name === null || row.row_id === null) continue;
    const rowId = Number(row.row_id);
    if (!Number.isInteger(rowId)) continue;

    let detail: string;
    let href: string | null = null;

    if (row.table_name === "leads") {
      if (rowId !== context.leadId) continue;
      detail = "This lead";
    } else if (row.table_name === "quotes") {
      const quote = context.quoteVersions.get(rowId);
      if (quote === undefined) continue;
      detail = `Quote version ${quote.version}`;
      href = `/leads/${context.leadId}/quotes/${quote.groupId}/print?quote=${rowId}`;
    } else if (row.table_name === "pre_apps") {
      if (context.preAppId === null || rowId !== context.preAppId) continue;
      detail = `Pre-app #${rowId}`;
      href = `/pre-apps/${rowId}`;
    } else {
      continue;
    }

    entries.push({
      key: `audit:${row.id}`,
      source: "audit",
      id: row.id,
      at: row.created_at,
      title: auditActionLabel(row.action),
      detail,
      // Null actor is a real and common case rather than a lookup failure: a
      // service-role write has no auth.uid(), so every seeded or
      // function-written row lands with actor_id null. The component renders
      // that as an automated action, not as a blank byline.
      actorName:
        row.actor_id === null ? null : actorNames.get(row.actor_id) ?? null,
      href,
    });
  }

  return entries;
}

/* =========================================================================
 * The merge.
 * ====================================================================== */

/**
 * An entry's instant, or null when it has none the feed can trust.
 *
 * Parsed rather than string-compared. PostgREST renders `timestamptz` with an
 * offset, and two rows can carry different offsets for the same instant — so
 * `"…T12:00:00+00:00" < "…T09:00:00-04:00"` is a lexical answer to a question
 * about time, and it is the wrong one. An unparseable value is treated as
 * undated rather than as the epoch, which would plant it at the bottom of the
 * feed claiming 1970.
 */
function instant(at: string | null): number | null {
  if (at === null || at === "") return null;
  const parsed = Date.parse(at);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Newest first, with a total order — no two entries ever compare equal.
 *
 * Three rules, in order:
 *
 *   1. Dated before undated. A row with no timestamp cannot be placed, so it
 *      goes to the end rather than being guessed into the middle.
 *   2. Later instant first.
 *   3. Exact tie: SOURCE_RANK, then id DESCENDING.
 *
 * Rule 3 is load-bearing, not a formality. `created_at` defaults to `now()`,
 * which is frozen for the whole transaction, so a quote and the audit row its
 * own trigger writes tie to the microsecond — and `Array.prototype.sort` is
 * only stable with respect to the INPUT order, which here is six concatenated
 * lists. Without a deterministic tie-break the feed would reorder itself when
 * an unrelated source gained a row.
 */
export function compareTimelineEntries(
  a: TimelineEntry,
  b: TimelineEntry,
): number {
  const at = instant(a.at);
  const bt = instant(b.at);

  if (at === null && bt !== null) return 1;
  if (bt === null && at !== null) return -1;
  if (at !== null && bt !== null && at !== bt) return bt - at;

  const rank = SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
  if (rank !== 0) return rank;

  return b.id - a.id;
}

/**
 * Flattens any number of per-source lists into one feed, newest first.
 *
 * Takes lists rather than one array so a caller cannot forget to concatenate,
 * and copies rather than sorting in place: the page hands in the same arrays it
 * renders the panels from, and reordering a caller's array under it is the kind
 * of bug that shows up two components away.
 */
export function mergeTimeline(
  ...groups: readonly TimelineEntry[][]
): TimelineEntry[] {
  return groups.flat().sort(compareTimelineEntries);
}

export type LeadTimeline = {
  entries: TimelineEntry[];
  /** True when TIMELINE_LIMIT bit, so the component can say so. */
  truncated: boolean;
};

/**
 * The whole feed for one lead, from rows the caller already has.
 *
 * `auditRows` is the only input that needs a read of its own, and for an agent
 * it is always empty — see the file header on `audit_log`'s policy.
 */
export function buildLeadTimeline(input: {
  leadId: number;
  notes: readonly WithAuthor<Note>[];
  tasks: readonly WithAuthor<Task>[];
  documents: readonly DocumentRow[];
  quotes: readonly Quote[];
  marketingEvents: readonly MarketingEvent[];
  materialTitles: ReadonlyMap<number, string>;
  auditRows: readonly AuditRow[];
  preAppId: number | null;
  actorNames: ReadonlyMap<string, string>;
  limit?: number;
}): LeadTimeline {
  const limit = input.limit ?? TIMELINE_LIMIT;

  const quoteVersions = new Map(
    input.quotes.map((quote) => [
      quote.id,
      { version: quote.version, groupId: quote.quote_group_id },
    ]),
  );

  const all = mergeTimeline(
    noteEntries(input.notes),
    taskEntries(input.tasks),
    documentEntries(input.documents),
    quoteEntries(input.quotes, input.leadId),
    marketingEntries(
      input.marketingEvents,
      input.materialTitles,
      input.actorNames,
    ),
    auditEntries(
      input.auditRows,
      {
        leadId: input.leadId,
        quoteVersions,
        preAppId: input.preAppId,
      },
      input.actorNames,
    ),
  );

  return { entries: all.slice(0, limit), truncated: all.length > limit };
}
