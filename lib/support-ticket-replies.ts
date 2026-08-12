import { createClient } from "@/lib/supabase/server";

/**
 * The conversation on a support ticket.
 *
 * A child of support_tickets rather than a use of `notes`, and the reason is the
 * policy rather than the shape: notes is scoped own-or-admin, so an admin's
 * reply would be invisible to the rep who opened the ticket — the one person who
 * has to read it. Replies are scoped through the parent, so whoever can see the
 * ticket sees its replies.
 *
 * Append-only, like notes. There is no update policy and no update grant, so
 * this module offers no edit path and the panel offers no edit affordance.
 */
export type TicketReply = {
  id: number;
  ticket_id: number;
  author_id: string;
  body: string;
  created_at: string | null;
};

/** Columns the panel reads. One place, so a test can assert the same set. */
export const REPLY_LIST_COLUMNS = "id, ticket_id, author_id, body, created_at";

/**
 * A reply plus its author's display name, resolved server-side.
 *
 * Same shape as WithAuthor in lib/annotations.ts, and separate from it for the
 * same reason the owner-type unions are separate: these are different tables
 * with different policies, and one type spanning both would invite a query that
 * fits the type but not the schema.
 */
export type ReplyWithAuthor = TicketReply & { author_name: string | null };

/**
 * Every reply on one ticket, oldest first.
 *
 * Oldest first because a thread reads forward, unlike the notes trail — the
 * newest note is the headline, the newest reply is the end of a conversation.
 *
 * No author_id filter and no ownership check here: the select policy reaches
 * through the parent ticket, so a caller who cannot see the ticket gets zero
 * rows without this query mentioning it. The page that calls this has already
 * 404'd on the ticket itself in that case.
 */
export async function loadTicketReplies(
  ticketId: number,
): Promise<{ replies: ReplyWithAuthor[]; error: string | null }> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("support_ticket_replies")
    .select(REPLY_LIST_COLUMNS)
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });

  if (error) return { replies: [], error: error.message };

  const replies = (data ?? []) as TicketReply[];

  // One lookup for the whole thread. Unconditional rather than admin-only: an
  // agent's own profile row is visible to them, and — unlike notes — the other
  // party here is an admin, whose row an agent cannot read. Those come back
  // unnamed and render as "Support", which is honest about what the reader is
  // allowed to know.
  const authorIds = [...new Set(replies.map((reply) => reply.author_id))];
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

  return {
    replies: replies.map((reply) => ({
      ...reply,
      author_name: authors.get(reply.author_id) ?? null,
    })),
    error: null,
  };
}
