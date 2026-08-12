"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import type { AnnotationOwnerType, Note, WithAuthor } from "@/lib/annotations";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/**
 * The notes trail on a lead / pre-app / merchant / ghost sheet.
 *
 * **Notes are append-only, and this panel has no edit affordance on purpose.**
 * There is no update policy on `notes` for anyone, admins included, and since
 * 20260812143407 no UPDATE grant either, so an UPDATE from here would come back
 * "permission denied" rather than reporting a successful save that changed
 * nothing. A correction is a new note, which is also what keeps the trail
 * readable in order. Removal is admin-only, per the delete policy added in
 * 20260810171500.
 *
 * `ownerType` and `ownerId` arrive as props from a server page that has already
 * loaded that parent row under RLS. They are never read from the URL here:
 * `owner_id` carries no foreign key, so nothing in the database would catch a
 * note filed against a record the writer cannot see.
 */
export function NotesPanel({
  ownerType,
  ownerId,
  notes,
  agentId,
  isAdmin,
}: {
  ownerType: AnnotationOwnerType;
  ownerId: number;
  notes: WithAuthor<Note>[];
  agentId: string;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    setBusy(true);
    setError(null);

    const supabase = createClient();
    // agent_id is what the insert policy's `with check` requires; sending
    // someone else's id is refused outright rather than filtered.
    const { error: insertError } = await supabase.from("notes").insert({
      agent_id: agentId,
      owner_type: ownerType,
      owner_id: ownerId,
      body: body.trim(),
    });

    if (insertError) {
      setError(insertError.message);
      setBusy(false);
      return;
    }

    setBody("");
    setBusy(false);
    router.refresh();
  };

  const remove = async (id: number) => {
    setBusy(true);
    setError(null);

    const supabase = createClient();
    // count: "exact" for the same reason the forms use it — RLS filters rather
    // than erroring, so a delete the policy declines is a silent no-op.
    const { error: deleteError, count } = await supabase
      .from("notes")
      .delete({ count: "exact" })
      .eq("id", id);

    if (deleteError || count === 0) {
      setError(
        deleteError?.message ?? "That note could not be removed.",
      );
      setBusy(false);
      return;
    }

    setBusy(false);
    router.refresh();
  };

  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-semibold text-lg">Notes ({notes.length})</h2>

      <div className="flex flex-col gap-2 items-start">
        <Textarea
          rows={3}
          value={body}
          disabled={busy}
          placeholder="What happened, in your own words. Notes cannot be edited afterwards."
          onChange={(e) => setBody(e.target.value)}
        />
        <Button
          size="sm"
          onClick={() => void add()}
          disabled={busy || body.trim() === ""}
        >
          <PlusIcon size={16} />
          {busy ? "Saving…" : "Add note"}
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {notes.length === 0 ? (
        <p className="text-sm text-muted-foreground">No notes yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {notes.map((note) => (
            <li
              key={note.id}
              className="flex items-start justify-between gap-4 rounded-md border p-3"
            >
              <div className="flex flex-col gap-1">
                {/* whitespace-pre-line so line breaks survive. React renders
                    this as text, never as markup. */}
                <p className="text-sm whitespace-pre-line">{note.body}</p>
                <p className="text-xs text-muted-foreground">
                  {note.author_name ?? "Unknown author"} ·{" "}
                  {formatDate(note.created_at)}
                </p>
              </div>
              {isAdmin && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void remove(note.id)}
                  aria-label="Remove note"
                >
                  <Trash2Icon size={16} />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
