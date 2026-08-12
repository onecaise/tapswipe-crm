import Link from "next/link";
import { Suspense } from "react";

import { requireUser } from "@/lib/auth";
import { loadNoteIndex } from "@/lib/annotations-data";
import { ANNOTATION_INDEX_LIMIT } from "@/lib/annotations";
import { formatDate, formatText } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

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

  return (
    <div className="flex flex-col gap-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Note</TableHead>
            <TableHead>Attached to</TableHead>
            {isAdmin && <TableHead>Agent</TableHead>}
            <TableHead>Written</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={isAdmin ? 4 : 3}
                className="text-muted-foreground"
              >
                No notes yet. Add one from a lead, merchant, pre-app or ghost
                sheet.
              </TableCell>
            </TableRow>
          ) : (
            rows.map((note) => (
              <TableRow key={note.id}>
                {/* whitespace-pre-line so line breaks survive. React renders
                    this as text, never as markup. */}
                <TableCell className="max-w-md whitespace-pre-line font-medium">
                  {note.body}
                </TableCell>
                <TableCell>
                  {note.owner_href ? (
                    <Link
                      href={note.owner_href}
                      className="underline underline-offset-4"
                    >
                      {note.owner_label}
                    </Link>
                  ) : (
                    // The owner was deleted, or is not this caller's to see.
                    // Shown without a link rather than as a dead one.
                    <span className="text-muted-foreground">
                      {note.owner_label}
                    </span>
                  )}
                </TableCell>
                {isAdmin && (
                  <TableCell className="text-muted-foreground">
                    {formatText(note.author_name)}
                  </TableCell>
                )}
                <TableCell className="text-muted-foreground">
                  {formatDate(note.created_at)}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

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
