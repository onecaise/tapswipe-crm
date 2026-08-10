import { describe, expect, it } from "vitest";

import { EMPTY, formatDate, formatText, parseDisplayDate } from "@/lib/format";
import { taskIsOverdue } from "@/lib/annotations";

/**
 * The formatters, and specifically the date-only vs instant distinction.
 *
 * These assert **local calendar components** rather than a formatted string,
 * because `toLocaleDateString()` output depends on the runner's locale. Local
 * components are exact: a bare date must mean that day, wherever it is read.
 *
 * Honest limit: on a machine set to UTC the old UTC-midnight parsing produced the
 * same components, so these tests would have passed against the bug there. They
 * fail against it in every zone west of UTC, which is where this app is used.
 */
describe("parseDisplayDate", () => {
  it("reads a bare date as that local calendar day", () => {
    const date = parseDisplayDate("2026-08-07");

    expect(date).not.toBeNull();
    expect(date?.getFullYear()).toBe(2026);
    expect(date?.getMonth()).toBe(7); // zero-based: August
    expect(date?.getDate()).toBe(7); // was 6 west of UTC before the fix
  });

  it("does not shift a date at a month boundary", () => {
    // The worst-looking form of the bug: the 1st rendering as the last day of
    // the previous month, so a follow-up looked a month stale.
    const date = parseDisplayDate("2026-09-01");

    expect(date?.getMonth()).toBe(8); // September
    expect(date?.getDate()).toBe(1);
  });

  it("still treats a timestamp as an instant", () => {
    // Carries a zone, so it names a moment rather than a day and must convert to
    // the viewer's zone. Compared against the platform's own parse.
    const value = "2026-08-07T15:30:00Z";
    expect(parseDisplayDate(value)?.getTime()).toBe(new Date(value).getTime());
  });

  it("returns null for an unparseable value", () => {
    expect(parseDisplayDate("not a date")).toBeNull();
  });
});

describe("formatDate", () => {
  it("renders a bare date as the same local day", () => {
    expect(formatDate("2026-08-07")).toBe(
      new Date(2026, 7, 7).toLocaleDateString(),
    );
  });

  it("renders absent and unparseable values as the em dash", () => {
    expect(formatDate(null)).toBe(EMPTY);
    expect(formatDate(undefined)).toBe(EMPTY);
    expect(formatDate("")).toBe(EMPTY);
    expect(formatDate("not a date")).toBe(EMPTY);
  });
});

describe("formatText", () => {
  it("treats whitespace-only as absent", () => {
    expect(formatText("   ")).toBe(EMPTY);
    expect(formatText(null)).toBe(EMPTY);
    expect(formatText("Dot's Diner")).toBe("Dot's Diner");
  });
});

describe("taskIsOverdue", () => {
  const today = new Date();
  const iso = (offsetDays: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() + offsetDays);
    return d.toISOString().slice(0, 10);
  };

  it("is false for a task due today", () => {
    // The boundary that matters: due_date is a `date`, so "today" must not read
    // as overdue at one minute past midnight.
    expect(taskIsOverdue({ due_date: iso(0), completed: false })).toBe(false);
  });

  it("is true for an open task due yesterday", () => {
    expect(taskIsOverdue({ due_date: iso(-1), completed: false })).toBe(true);
  });

  it("is false once completed, however late", () => {
    expect(taskIsOverdue({ due_date: iso(-30), completed: true })).toBe(false);
  });

  it("is false with no due date", () => {
    expect(taskIsOverdue({ due_date: null, completed: false })).toBe(false);
  });
});
