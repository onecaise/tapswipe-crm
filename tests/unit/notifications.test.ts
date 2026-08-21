import { describe, expect, it } from "vitest";

import {
  NOTIFICATION_LIMIT,
  compareNotifications,
  mergeNotifications,
  notificationHref,
  notificationKey,
  notificationKindLabel,
  notificationsFloor,
  type NotificationItem,
} from "@/lib/notifications";
import { formatDateTime } from "@/lib/format";

/**
 * The pure half of the bell: the watermark fallback, the merge, and the
 * per-item identity. All of it is logic no database can check, and most of it is
 * logic whose failure is silent — a wrong sort order or a colliding key looks
 * like a working panel that occasionally shows the wrong thing.
 */

const item = (
  kind: NotificationItem["kind"],
  id: number,
  createdAt: string,
  title = `${kind} ${id}`,
): NotificationItem => ({ kind, id, title, createdAt });

describe("notificationsFloor", () => {
  it("uses the watermark when the user has opened the panel before", () => {
    expect(
      notificationsFloor({
        last_viewed_notifications_at: "2026-08-01T00:00:00Z",
        created_at: "2024-01-01T00:00:00Z",
      }),
    ).toBe("2026-08-01T00:00:00Z");
  });

  it("falls back to the account's creation date when never opened", () => {
    // Not the epoch: a rep who has never clicked the bell should see what
    // arrived since their account existed, not every record the company ever
    // created. The same coalesce is in mark_notifications_viewed(), and the two
    // must agree or the badge and the panel disagree about what is new.
    expect(
      notificationsFloor({
        last_viewed_notifications_at: null,
        created_at: "2024-01-01T00:00:00Z",
      }),
    ).toBe("2024-01-01T00:00:00Z");
  });

  it("falls back to the epoch only when both are missing", () => {
    // Unreachable through any current write path — profiles.created_at defaults
    // to now(). Over-reporting is the right failure here: a bell showing too
    // much gets reported, a silently empty one does not.
    expect(
      notificationsFloor({
        last_viewed_notifications_at: null,
        created_at: null,
      }),
    ).toBe(new Date(0).toISOString());
  });
});

describe("notificationKey", () => {
  it("keeps colliding ids across kinds apart", () => {
    // Both id spaces start at 1, so ticket 7 and sheet 7 both existing is the
    // normal case. A bare id as the dismissal identity would make dismissing
    // one dismiss the other — the same trap owner_type exists to avoid on notes
    // and tasks.
    expect(notificationKey(item("support_ticket", 7, "2026-01-01T00:00:00Z"))).not.toBe(
      notificationKey(item("ghost_sheet", 7, "2026-01-01T00:00:00Z")),
    );
  });
});

describe("notificationHref", () => {
  it("points each kind at its own record", () => {
    expect(notificationHref(item("support_ticket", 12, "2026-01-01T00:00:00Z"))).toBe(
      "/support-tickets/12",
    );
    expect(notificationHref(item("ghost_sheet", 12, "2026-01-01T00:00:00Z"))).toBe(
      "/ghost-sheets/12",
    );
  });

  it("labels each kind distinguishably", () => {
    expect(notificationKindLabel("support_ticket")).not.toBe(
      notificationKindLabel("ghost_sheet"),
    );
  });
});

describe("compareNotifications", () => {
  it("puts the newest first", () => {
    const older = item("support_ticket", 1, "2026-01-01T00:00:00Z");
    const newer = item("support_ticket", 2, "2026-06-01T00:00:00Z");
    expect([older, newer].sort(compareNotifications)).toEqual([newer, older]);
  });

  it("breaks ties deterministically", () => {
    // Both tables default created_at to now(), so two rows inserted in the same
    // transaction can share a timestamp to the microsecond. Without a tie-break
    // the order is whatever the two queries happened to return, and the panel
    // reshuffles between renders.
    const sameTime = "2026-05-05T12:00:00Z";
    const a = item("ghost_sheet", 3, sameTime);
    const b = item("support_ticket", 3, sameTime);

    expect([a, b].sort(compareNotifications)).toEqual(
      [b, a].sort(compareNotifications),
    );
  });
});

describe("mergeNotifications", () => {
  it("interleaves the two sources by time rather than grouping them", () => {
    const tickets = [
      item("support_ticket", 1, "2026-03-01T00:00:00Z"),
      item("support_ticket", 2, "2026-03-03T00:00:00Z"),
    ];
    const sheets = [item("ghost_sheet", 1, "2026-03-02T00:00:00Z")];

    expect(mergeNotifications(tickets, sheets).map((i) => i.kind)).toEqual([
      "support_ticket",
      "ghost_sheet",
      "support_ticket",
    ]);
  });

  it("applies the cap after merging, not per source", () => {
    // The reason the cap lives here rather than in the two queries: taking
    // NOTIFICATION_LIMIT of each and then merging would let a busy week of
    // tickets push out a ghost sheet that is genuinely newer than all of them.
    const tickets = Array.from({ length: NOTIFICATION_LIMIT }, (_, i) =>
      item("support_ticket", i + 1, `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`),
    );
    const newestSheet = item("ghost_sheet", 99, "2026-12-31T00:00:00Z");

    const merged = mergeNotifications(tickets, [newestSheet]);

    expect(merged).toHaveLength(NOTIFICATION_LIMIT);
    expect(merged[0]).toEqual(newestSheet);
  });

  it("handles either source being empty", () => {
    const only = item("ghost_sheet", 1, "2026-03-01T00:00:00Z");
    expect(mergeNotifications([], [only])).toEqual([only]);
    expect(mergeNotifications([only], [])).toEqual([only]);
    expect(mergeNotifications([], [])).toEqual([]);
  });
});

describe("formatDateTime", () => {
  it("keeps the time, which formatDate drops", () => {
    // The reason this helper was added: "what is new since you last looked" is
    // frequently several items on one day, and three rows all reading the same
    // date cannot be ordered by eye.
    const formatted = formatDateTime("2026-08-21T14:30:00Z");
    expect(formatted).not.toBe("—");
    expect(formatted).toMatch(/\d/);
    expect(formatted.length).toBeGreaterThan("8/21/2026".length);
  });

  it("returns the empty dash for null and unparseable input", () => {
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime(undefined)).toBe("—");
    expect(formatDateTime("not a timestamp")).toBe("—");
  });
});
