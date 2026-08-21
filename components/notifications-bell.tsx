"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { BellIcon, XIcon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import {
  NOTIFICATION_LIMIT,
  fetchNotifications,
  notificationHref,
  notificationKey,
  notificationKindLabel,
  type NotificationItem,
} from "@/lib/notifications";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * The topbar bell and its panel.
 *
 * `initialCount` comes from the server layout, which counts without advancing
 * the watermark. Opening the panel calls mark_notifications_viewed(), which
 * returns the *previous* watermark and advances it in one statement — so the
 * items listed are exactly those the badge was counting, and the same watermark
 * is never handed out twice.
 *
 * Three behaviours that are deliberate rather than incidental:
 *
 *  - **Fetched once per mount, not per open.** Because opening advances the
 *    watermark, a second call would return a watermark of ~now and the list
 *    would come back empty — closing and reopening would blank a panel the user
 *    was reading. So the items are held in state for the life of the page, and
 *    reopening shows the same list minus anything dismissed. A reload legitimately
 *    clears it: that is what "since you last looked" means.
 *  - **The badge clears on open, before the fetch resolves.** The watermark has
 *    moved by then whatever the render does, so leaving the dot lit would be
 *    claiming something untrue.
 *  - **Dismissal is local and nothing else.** No request, no delete — there is no
 *    server-side row to remove, which is the point of deriving the list from a
 *    timestamp. It affects this panel only: not the other items, and not what
 *    any other user sees.
 */
export function NotificationsBell({ initialCount }: { initialCount: number }) {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(initialCount);
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  // Guards the fetch-once rule against React's double-invoked effects and
  // against a fast second click landing before the first request resolves.
  const hasFetched = useRef(false);

  // Close on outside click and on Escape. A plain popover rather than the
  // DropdownMenu primitive: each row holds a link *and* a dismiss button, and a
  // menu item containing two independently focusable controls is not a menu
  // item — it fights both the keyboard model and the close-on-select behaviour.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const openPanel = async () => {
    setOpen(true);
    // Cleared immediately: the watermark is about to move regardless of what the
    // fetch returns, so a lit dot would be a lie from this point on.
    setCount(0);

    if (hasFetched.current) return;
    hasFetched.current = true;

    setLoading(true);
    setError(null);

    const supabase = createClient();

    // Read-and-advance in one statement. The returned value is the watermark
    // this panel reports against; see the migration for why splitting it into a
    // select plus an update would drop items silently.
    const { data: since, error: rpcError } = await supabase.rpc(
      "mark_notifications_viewed",
    );

    if (rpcError || typeof since !== "string") {
      setError(rpcError?.message ?? "Could not load notifications.");
      setLoading(false);
      // Left true on purpose. Retrying would call the RPC again, which has
      // already advanced the watermark — the second call returns ~now and would
      // report an empty panel as though nothing had happened.
      return;
    }

    const { items: fetched, error: fetchError } = await fetchNotifications(
      supabase,
      since,
    );

    if (fetchError) {
      setError(fetchError);
    } else {
      setItems(fetched);
    }
    setLoading(false);
  };

  const visible = (items ?? []).filter(
    (item) => !dismissed.has(notificationKey(item)),
  );
  const atCap = (items?.length ?? 0) >= NOTIFICATION_LIMIT;

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={
          count > 0
            ? `Notifications, ${count > NOTIFICATION_LIMIT ? `more than ${NOTIFICATION_LIMIT}` : count} new`
            : "Notifications"
        }
        onClick={() => (open ? setOpen(false) : void openPanel())}
        className="relative flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <BellIcon size={18} aria-hidden />
        {count > 0 && (
          <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground">
            {count > NOTIFICATION_LIMIT ? `${NOTIFICATION_LIMIT}+` : count}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 top-full z-20 mt-2 w-80 overflow-hidden rounded-md border bg-card shadow-lg"
        >
          <div className="flex items-center justify-between border-b px-3 py-2">
            <h2 className="text-sm font-semibold">Notifications</h2>
            {visible.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {visible.length}
                {atCap && "+"}
              </span>
            )}
          </div>

          <div className="max-h-80 overflow-y-auto">
            {loading && (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                Loading…
              </p>
            )}

            {!loading && error !== null && (
              <p className="px-3 py-4 text-sm text-destructive">{error}</p>
            )}

            {!loading && error === null && visible.length === 0 && (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                Nothing new since you last looked.
              </p>
            )}

            {!loading &&
              error === null &&
              visible.map((item) => (
                <div
                  key={notificationKey(item)}
                  className="flex items-start gap-2 border-b px-3 py-2.5 last:border-b-0 hover:bg-muted/50"
                >
                  <Link
                    href={notificationHref(item)}
                    onClick={() => setOpen(false)}
                    className="min-w-0 flex-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="block text-[11px] uppercase tracking-wide text-muted-foreground">
                      {notificationKindLabel(item.kind)}
                    </span>
                    {/* truncate, not wrap: a rep's ticket subject can be a
                        paragraph, and one item must not push the rest out of
                        view. The full text is on the record it links to. */}
                    <span className="block truncate text-sm font-medium">
                      {item.title}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {formatDateTime(item.createdAt)}
                    </span>
                  </Link>
                  <button
                    type="button"
                    // Labelled with the item's title, so a screen reader user
                    // moving between several dismiss buttons can tell which is
                    // which. "Dismiss" alone repeats N times identically.
                    aria-label={`Dismiss: ${item.title}`}
                    onClick={() =>
                      setDismissed((previous) => {
                        const next = new Set(previous);
                        next.add(notificationKey(item));
                        return next;
                      })
                    }
                    className={cn(
                      "shrink-0 rounded p-1 text-muted-foreground transition-colors",
                      "hover:bg-muted hover:text-foreground",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    )}
                  >
                    <XIcon size={14} aria-hidden />
                  </button>
                </div>
              ))}
          </div>

          {atCap && !loading && error === null && (
            <p className="border-t px-3 py-2 text-xs text-muted-foreground">
              Showing the {NOTIFICATION_LIMIT} most recent.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
