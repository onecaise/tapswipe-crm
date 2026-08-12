import { describe, expect, it } from "vitest";

import {
  OTHER_PAGE_VALUE,
  bugReportPageOptions,
  defaultBugReportPage,
  navPageOptions,
} from "@/lib/bug-reports";

/**
 * The bubble's page picker.
 *
 * The point of the default is that a rep reporting a bug should not have to
 * tell the form where they are — it already knows. These pin that it picks the
 * right thing on the three shapes of path in the app: an index route, a detail
 * route the nav does not list, and something outside the nav entirely.
 */
describe("defaultBugReportPage", () => {
  it("selects the exact nav entry on an index page", () => {
    expect(defaultBugReportPage("/merchants", false)).toBe("/merchants");
    expect(defaultBugReportPage("/support-tickets", false)).toBe(
      "/support-tickets",
    );
  });

  it("keeps the full path on a detail or edit route", () => {
    // Not narrowed to /merchants: the id is the most useful part of the report,
    // and an admin reading "the merchant page is broken" has to guess which one.
    expect(defaultBugReportPage("/merchants/17", false)).toBe("/merchants/17");
    expect(defaultBugReportPage("/pre-apps/3/edit", false)).toBe(
      "/pre-apps/3/edit",
    );
  });

  it("falls back to the catch-all when the path is outside the nav", () => {
    expect(defaultBugReportPage(null, false)).toBe(OTHER_PAGE_VALUE);
  });
});

describe("bugReportPageOptions", () => {
  it("offers every nav destination", () => {
    const values = bugReportPageOptions("/dashboard", false).map(
      (o) => o.value,
    );

    for (const option of navPageOptions(false)) {
      expect(values).toContain(option.value);
    }
    expect(values).toContain(OTHER_PAGE_VALUE);
  });

  it("adds the current path as its own option when the nav lacks it", () => {
    const options = bugReportPageOptions("/merchants/17", false);

    // First, so the default is also the obvious choice in the list.
    expect(options[0]).toEqual({
      value: "/merchants/17",
      label: "This page (/merchants/17)",
    });
  });

  it("does not duplicate a path the nav already lists", () => {
    const values = bugReportPageOptions("/merchants", false).map((o) => o.value);
    const merchants = values.filter((v) => v === "/merchants");

    expect(merchants).toHaveLength(1);
  });

  it("tracks the nav rather than a hand-written copy of it", () => {
    // Notes and Tasks became real pages on 12 Aug; anything hard-coding this
    // list would have gone stale that day and nothing would have said so.
    const values = navPageOptions(false).map((o) => o.value);

    expect(values).toContain("/notes");
    expect(values).toContain("/tasks");
  });

  it("does not offer an agent an admin-only route", () => {
    // Caught in the browser: the picker was listing /admin/users to a rep,
    // naming a route they cannot reach. The sidebar filters adminOnly for the
    // same reason, and this list is derived from it, so it must filter too.
    expect(navPageOptions(false).map((o) => o.value)).not.toContain(
      "/admin/users",
    );
    expect(navPageOptions(true).map((o) => o.value)).toContain("/admin/users");
  });
});
