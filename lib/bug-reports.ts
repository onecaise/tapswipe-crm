import { NAV_GROUPS, isNavItemActive } from "@/lib/nav";

/**
 * Bug reports: the floating bubble on every CRM page, and the admin queue.
 *
 * Pure types, vocabulary and helpers — no Supabase import, so the client
 * components can use these without dragging lib/supabase/server into the bundle.
 */
export type BugReportStatus = "open" | "resolved" | "dismissed";

export type BugReport = {
  id: number;
  agent_id: string;
  page: string;
  description: string;
  status: BugReportStatus;
  resolved_at: string | null;
  resolved_by: string | null;
  created_at: string | null;
};

/** Columns the admin list reads. One place, so a test can assert the same set. */
export const BUG_REPORT_LIST_COLUMNS =
  "id, agent_id, page, description, status, resolved_at, resolved_by, created_at";

/**
 * The queue filter, defined once.
 *
 * Reports are cleared by setting status, never by deleting, so the row for a
 * dismissed report is still there — and a query that means "the queue" but
 * forgets to say so does not fail, it just shows closed work as live. That is
 * the standing cost of the soft-clear design, and this constant is where it is
 * paid.
 */
export const BUG_REPORT_OPEN_STATUS: BugReportStatus = "open";

/**
 * How a report leaves the queue.
 *
 * Two closures rather than one because they claim different things: 'resolved'
 * says it was fixed, 'dismissed' says it was not a bug or will not be actioned.
 * Both disappear from the list; only one of them is a promise.
 */
export const BUG_REPORT_RESOLUTIONS = ["resolved", "dismissed"] as const;

export type BugReportResolution = (typeof BUG_REPORT_RESOLUTIONS)[number];

export const BUG_REPORT_RESOLUTION_LABELS: Record<BugReportResolution, string> =
  {
    resolved: "Resolved",
    dismissed: "Dismissed",
  };

/** Longest description we accept, so one paste cannot fill the column. */
export const BUG_REPORT_MAX_LENGTH = 2000;

export type BugReportPageOption = {
  /** Stored in bug_reports.page. A route path, or the literal "other". */
  value: string;
  label: string;
};

/**
 * The pages a report can be filed against.
 *
 * Derived from the sidebar rather than hand-listed, so a new section appears
 * here the moment it appears in the nav. Items without an href are skipped —
 * there are none today, but the field is optional and a row that is not a
 * destination is not a page either.
 *
 * "Somewhere else" is last and deliberate: the list covers index pages, and a
 * bug on `/merchants/17/edit` should not have to be filed as `/merchants`. When
 * the current path is not one of these, the bubble adds it as its own option
 * (see bugReportPageOptions) so the common case still needs no typing.
 */
export const OTHER_PAGE_VALUE = "other";

export function navPageOptions(isAdmin: boolean): BugReportPageOption[] {
  return NAV_GROUPS.flatMap((group) =>
    group.items
      // adminOnly items are filtered for the same reason the sidebar filters
      // them: offering a rep "/admin/users" as a page they might have hit a bug
      // on names a route they cannot reach and have no business knowing about.
      .filter((item) => item.href !== undefined && (!item.adminOnly || isAdmin))
      .map((item) => ({ value: item.href as string, label: item.label })),
  );
}

/**
 * The option list for one particular pathname.
 *
 * If the caller is on a page the nav does not list — a detail or edit route —
 * the exact path is prepended as its own option and selected, because that is
 * the page they mean and losing the id would make the report harder to act on.
 */
export function bugReportPageOptions(
  pathname: string | null,
  isAdmin: boolean,
): BugReportPageOption[] {
  const navOptions = navPageOptions(isAdmin);
  const options = [...navOptions];

  if (pathname !== null && !navOptions.some((o) => o.value === pathname)) {
    options.unshift({ value: pathname, label: `This page (${pathname})` });
  }

  options.push({ value: OTHER_PAGE_VALUE, label: "Somewhere else" });
  return options;
}

/**
 * Which option the form should start on.
 *
 * Prefix match through isNavItemActive, the same function that lights the
 * sidebar — so /merchants/17 defaults to the exact path when it is offered, and
 * otherwise to Merchants, and the two cannot disagree about what "the current
 * section" means.
 */
export function defaultBugReportPage(
  pathname: string | null,
  isAdmin: boolean,
): string {
  if (pathname === null) return OTHER_PAGE_VALUE;

  const options = bugReportPageOptions(pathname, isAdmin);
  const exact = options.find((option) => option.value === pathname);
  if (exact !== undefined) return exact.value;

  const section = navPageOptions(isAdmin).find((option) =>
    isNavItemActive(option.value, pathname),
  );
  return section?.value ?? OTHER_PAGE_VALUE;
}
