import type { SupabaseClient } from "@supabase/supabase-js";

import type { Profile } from "@/lib/auth";

/**
 * The topbar bell: what is new since this user last opened the panel.
 *
 * There is no notifications table and there deliberately never will be. The
 * whole feature is one comparison — a support ticket or ghost sheet whose
 * created_at is later than the caller's `last_viewed_notifications_at` is new to
 * them — so nothing is ever written per item, nothing can go stale, and
 * dismissing an item is client-only state by construction rather than by
 * omission (see the migration 20260821154500 for the full reasoning).
 *
 * Two properties worth stating before reading the query below:
 *
 *  - **RLS is the entire authorization story.** Both selects go through the
 *    caller's own client, so an agent's bell shows their own new rows and an
 *    admin's shows the company's, with no role branch anywhere here. That is the
 *    same choice `search_crm` made: a feed is exactly the shape of thing that
 *    becomes a disclosure bug, and the way to make that structurally impossible
 *    is for the query to have no privilege to widen.
 *  - **An agent's own new rows are not always their own doing.** The `insert
 *    own` policy on both tables permits `is_admin()`, so an admin can file a
 *    ticket or a ghost sheet *for* a rep — which is precisely the case where a
 *    rep needs telling. It also means a rep sees their own creations echoed back,
 *    which is noise; if that turns out to matter the fix is a created-by column,
 *    not a filter on agent_id, because agent_id is the owner and not the author.
 */

/** The two record kinds the bell reports on. */
export type NotificationKind = "support_ticket" | "ghost_sheet";

export type NotificationItem = {
  kind: NotificationKind;
  /** The source row's id. Unique per kind, NOT across kinds — see key(). */
  id: number;
  title: string;
  createdAt: string;
};

/**
 * How many items the panel will show, and the cap on the badge.
 *
 * A bounded query, because "everything since a date" has no natural ceiling: a
 * rep returning from leave, or an admin on a busy week, would otherwise pull
 * every row created in the interval into a dropdown. The badge renders as
 * "20+" at the cap rather than a true count, which is honest about being
 * truncated — and the panel says so too.
 */
export const NOTIFICATION_LIMIT = 20;

/**
 * The timestamp to compare `created_at` against.
 *
 * null `last_viewed_notifications_at` means "has never opened the panel", which
 * falls back to when the account was created — not to the beginning of time,
 * which would dump the company's whole history into a first click. The same
 * coalesce lives in mark_notifications_viewed(); this is the read-side twin, and
 * the two must agree or the badge and the panel disagree about what is new.
 *
 * Falls back to the epoch only if both are somehow null, which would mean a
 * profile row with no created_at — impossible via any current write path, and a
 * visible over-report is a better failure than a silently empty bell.
 */
export function notificationsFloor(
  profile: Pick<Profile, "last_viewed_notifications_at" | "created_at">,
): string {
  return (
    profile.last_viewed_notifications_at ??
    profile.created_at ??
    new Date(0).toISOString()
  );
}

/**
 * A stable React key / dismissal identity.
 *
 * Kind-prefixed because the two id spaces overlap: ticket 7 and ghost sheet 7
 * both exist, both can legitimately belong to the caller, and a bare id would
 * make dismissing one dismiss the other. The same trap `owner_type` exists to
 * avoid on notes and tasks.
 */
export function notificationKey(item: NotificationItem): string {
  return `${item.kind}:${item.id}`;
}

/** Where clicking the item goes. */
export function notificationHref(item: NotificationItem): string {
  return item.kind === "support_ticket"
    ? `/support-tickets/${item.id}`
    : `/ghost-sheets/${item.id}`;
}

/** The label above the item's title in the panel. */
export function notificationKindLabel(kind: NotificationKind): string {
  return kind === "support_ticket" ? "New support ticket" : "New ghost sheet";
}

/**
 * Newest first, with a deterministic tie-break.
 *
 * Both tables default created_at to now(), so a seeded batch or two inserts in
 * the same transaction can share a timestamp to the microsecond. Without the
 * tie-break the order of equal-timestamp items is whatever the two queries
 * happened to return, which makes the panel reshuffle between renders.
 */
export function compareNotifications(
  a: NotificationItem,
  b: NotificationItem,
): number {
  const byTime = b.createdAt.localeCompare(a.createdAt);
  if (byTime !== 0) return byTime;
  const byKind = a.kind.localeCompare(b.kind);
  return byKind !== 0 ? byKind : b.id - a.id;
}

/**
 * Merge the two result sets into one ordered, capped list.
 *
 * Separated from the queries so it is testable without a database, and so the
 * cap is applied *after* the merge — taking 20 of each and then merging would
 * let a busy week of tickets push out a ghost sheet that is genuinely newer.
 */
export function mergeNotifications(
  tickets: NotificationItem[],
  sheets: NotificationItem[],
): NotificationItem[] {
  return [...tickets, ...sheets]
    .sort(compareNotifications)
    .slice(0, NOTIFICATION_LIMIT);
}

type TicketRow = { id: number; subject: string; created_at: string | null };
type SheetRow = {
  id: number;
  dba: string | null;
  contact_name: string | null;
  created_at: string | null;
};

/**
 * A ghost sheet's display title.
 *
 * Both `dba` and `contact_name` are nullable on that table, and a sheet with
 * neither is a real row a rep can create — so this degrades to the id rather
 * than rendering an empty line the user cannot identify or click with
 * confidence.
 */
function sheetTitle(row: SheetRow): string {
  const dba = row.dba?.trim();
  if (dba) return dba;
  const contact = row.contact_name?.trim();
  if (contact) return contact;
  return `Ghost sheet #${row.id}`;
}

/**
 * Everything created after `since` that the caller can see.
 *
 * Both queries are ordinary Tier 1 reads through the caller-scoped client. They
 * are issued concurrently because neither depends on the other, and a sequential
 * pair would put two round trips in front of a dropdown that opens on click.
 *
 * Rows with a null created_at are dropped rather than shown: the column is
 * `default now()` but nullable on both tables, and an item the bell cannot place
 * in time cannot be compared against the watermark either — it would reappear on
 * every open, forever.
 */
export async function fetchNotifications(
  supabase: SupabaseClient,
  since: string,
): Promise<{ items: NotificationItem[]; error: string | null }> {
  const [ticketResult, sheetResult] = await Promise.all([
    supabase
      .from("support_tickets")
      .select("id, subject, created_at")
      .gt("created_at", since)
      .order("created_at", { ascending: false })
      .limit(NOTIFICATION_LIMIT),
    supabase
      .from("ghost_sheets")
      .select("id, dba, contact_name, created_at")
      .gt("created_at", since)
      .order("created_at", { ascending: false })
      .limit(NOTIFICATION_LIMIT),
  ]);

  const failure = ticketResult.error ?? sheetResult.error;
  if (failure) {
    // Reported rather than swallowed to an empty list: "nothing new" and "the
    // query failed" look identical in a dropdown, and the second one should not
    // be indistinguishable from the first.
    return { items: [], error: failure.message };
  }

  const tickets: NotificationItem[] = ((ticketResult.data ?? []) as TicketRow[])
    .filter((row) => row.created_at !== null)
    .map((row) => ({
      kind: "support_ticket" as const,
      id: row.id,
      title: row.subject,
      createdAt: row.created_at as string,
    }));

  const sheets: NotificationItem[] = ((sheetResult.data ?? []) as SheetRow[])
    .filter((row) => row.created_at !== null)
    .map((row) => ({
      kind: "ghost_sheet" as const,
      id: row.id,
      title: sheetTitle(row),
      createdAt: row.created_at as string,
    }));

  return { items: mergeNotifications(tickets, sheets), error: null };
}

/**
 * The badge count, without advancing the watermark.
 *
 * A separate head-only count rather than reusing fetchNotifications, because the
 * layout renders on every page load and only needs a number — pulling 20 rows
 * and their text to render a dot would be paying for the panel on every
 * navigation. Capped at NOTIFICATION_LIMIT + 1 so the caller can tell "at the
 * cap" from "exactly the cap" and render "20+".
 */
export async function countNotifications(
  supabase: SupabaseClient,
  since: string,
): Promise<number> {
  const [tickets, sheets] = await Promise.all([
    supabase
      .from("support_tickets")
      .select("id", { count: "exact", head: true })
      .gt("created_at", since),
    supabase
      .from("ghost_sheets")
      .select("id", { count: "exact", head: true })
      .gt("created_at", since),
  ]);

  // A failed count reads as zero: the bell is an ambient affordance, and a
  // broken badge must not be the thing that takes the topbar down.
  return Math.min(
    (tickets.count ?? 0) + (sheets.count ?? 0),
    NOTIFICATION_LIMIT + 1,
  );
}
