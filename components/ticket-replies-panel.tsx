"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { SendIcon, Trash2Icon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import type { ReplyWithAuthor } from "@/lib/support-ticket-replies";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/**
 * The reply thread on a support ticket.
 *
 * This is what moves responding onto the ticket: before it, the only place to
 * record a response was a note on the merchant record, which meant navigating
 * away from the thing being answered.
 *
 * **Replies are append-only, and this panel has no edit affordance on purpose.**
 * There is no update policy and no update grant on support_ticket_replies, so an
 * UPDATE from here would come back "permission denied" — a correction is another
 * reply, which is also what keeps the thread readable in order. Removal is
 * admin-only, matching the delete policy.
 *
 * `authorId` is the caller's own profile id and is what the insert policy's
 * `with check` requires: `author_id = auth.uid()`. Sending anyone else's id is
 * refused outright rather than filtered, so a rep cannot post under the admin's
 * name.
 */
export function TicketRepliesPanel({
  ticketId,
  replies,
  authorId,
  isAdmin,
}: {
  ticketId: number;
  replies: ReplyWithAuthor[];
  authorId: string;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    setBusy(true);
    setError(null);

    const supabase = createClient();
    const { error: insertError } = await supabase
      .from("support_ticket_replies")
      .insert({ ticket_id: ticketId, author_id: authorId, body: body.trim() });

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
    // count: "exact" for the same reason the panels use it — RLS filters rather
    // than erroring, so a delete the policy declines is a silent no-op.
    const { error: deleteError, count } = await supabase
      .from("support_ticket_replies")
      .delete({ count: "exact" })
      .eq("id", id);

    if (deleteError || count === 0) {
      setError(deleteError?.message ?? "That reply could not be removed.");
      setBusy(false);
      return;
    }

    setBusy(false);
    router.refresh();
  };

  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-semibold text-lg">Replies ({replies.length})</h2>

      {replies.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No replies yet. Anyone who can see this ticket will see what you write
          here.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {replies.map((reply) => {
            const mine = reply.author_id === authorId;
            return (
              <li
                key={reply.id}
                className={cn(
                  "flex items-start justify-between gap-4 rounded-md border p-3",
                  // The caller's own replies sit on a tinted ground so a thread
                  // reads as a conversation at a glance rather than a list.
                  mine && "bg-muted/50",
                )}
              >
                <div className="flex flex-col gap-1">
                  {/* whitespace-pre-line so line breaks survive. React renders
                      this as text, never as markup. */}
                  <p className="text-sm whitespace-pre-line">{reply.body}</p>
                  <p className="text-xs text-muted-foreground">
                    {/* An agent cannot read an admin's profile row, so an
                        unnamed author is the support side answering. */}
                    {reply.author_name ?? "Support"} ·{" "}
                    {formatDate(reply.created_at)}
                  </p>
                </div>
                {isAdmin && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void remove(reply.id)}
                    aria-label="Remove reply"
                  >
                    <Trash2Icon size={16} />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-col gap-2 items-start">
        <Textarea
          rows={3}
          value={body}
          disabled={busy}
          aria-label="Write a reply"
          placeholder="Write a reply. Replies cannot be edited afterwards."
          onChange={(e) => setBody(e.target.value)}
        />
        <Button
          size="sm"
          onClick={() => void send()}
          disabled={busy || body.trim() === ""}
        >
          <SendIcon size={16} />
          {busy ? "Sending…" : "Send reply"}
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
    </section>
  );
}
