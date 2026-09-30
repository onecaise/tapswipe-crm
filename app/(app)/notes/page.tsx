import Link from "next/link";
import { Suspense } from "react";

import { requireUser } from "@/lib/auth";
import { loadNoteIndex } from "@/lib/annotations-data";
import { ANNOTATION_INDEX_LIMIT } from "@/lib/annotations";
import { formatDate, formatText } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { ListTable, type ListColumn } from "@/components/list-table";

/**
 * Every note the caller can see, across all four owner types.
 *
 * Read-only, and that is not an oversight: notes are append-only by design, so
 * there is no edit affordance here any more than there is in the panel. Since
 * 20260812143407 an UPDATE is refused outright rather than filtered to zero
 * rows, so offering one would produce a permission error rather than a silent
 * no-op — worse, not better. Corrections are a new note, written on the record.
 *
 * Creation stays on the record pages too. A composer here would have to take
 * owner_type/owner_id from client input, and owner_id carries no foreign key —
 * nothing in the database would catch a note filed against a record the writer
 * cannot see.
 */
async function NotesList() {
  const profile = await requireUser();
  const { rows, truncated, error } = await loadNoteIndex();

  if (error) {
    return (
      <p className="text-sm text-destructive">Could not load notes: {error}</p>
    );
  }

  const isAdmin = profile.role === "admin";

  // The list's shape as data, so the table and the stacked-card view below lg
  // cannot disagree about it. The admin-only Agent column is spliced in at its
  // existing position — before Written, not appended. This also retires the
  // hand-counted `colSpan={isAdmin ? 4 : 3}` the empty row used to carry.
  const columns: ListColumn<(typeof rows)[number]>[] = [
    {
      header: "Note",
      primary: true,
      // max-w-md is a table-layout concern and stays on the <td>.
      // whitespace-pre-line is NOT: it is what makes a note's line breaks
      // survive, and ListTable deliberately does not put a primary column's
      // className on the card heading — so it lives on the rendered node
      // instead, where both layouts get it. React renders this as text, never
      // as markup.
      className: "max-w-md font-medium",
      cell: (note) => (
        <span className="whitespace-pre-line">{note.body}</span>
      ),
    },
    {
      header: "Attached to",
      cell: (note) =>
        note.owner_href ? (
          <Link
            href={note.owner_href}
            className="underline underline-offset-4"
          >
            {note.owner_label}
          </Link>
        ) : (
          // The owner was deleted, or is not this caller's to see. Shown
          // without a link rather than as a dead one.
          <span className="text-muted-foreground">{note.owner_label}</span>
        ),
    },
    ...(isAdmin
      ? [
          {
            header: "Agent",
            className: "text-muted-foreground",
            cell: (note: (typeof rows)[number]) => formatText(note.author_name),
          },
        ]
      : []),
    {
      header: "Written",
      className: "text-muted-foreground",
      cell: (note) => formatDate(note.created_at),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <ListTable
        columns={columns}
        rows={rows}
        rowKey={(note) => note.id}
        emptyMessage="No notes yet. Add one from a lead, merchant, pre-app or ghost sheet."
      />

      {truncated && (
        <p className="text-sm text-muted-foreground">
          Showing the {ANNOTATION_INDEX_LIMIT} most recent notes. Older ones stay
          on their record.
        </p>
      )}
    </div>
  );
}

export default function NotesPage() {
  return (
    <PageShell width="list">
      <PageHeader
        title="Notes"
        subtitle="Notes across every lead, merchant, pre-app and ghost sheet, newest first. Agents see their own; admins see all. Notes cannot be edited — a correction is a new note on the record."
      />

      {/* cacheComponents: true means the fetch has to sit inside a Suspense
          boundary. */}
      <Suspense
        fallback={<p className="text-sm text-muted-foreground">Loading notes…</p>}
      >
        <NotesList />
      </Suspense>
    </PageShell>
  );
}
