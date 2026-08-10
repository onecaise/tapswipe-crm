/**
 * Display formatters shared across list and detail pages.
 *
 * All of these render an em dash for absent values rather than an empty cell, so
 * "no value" and "failed to load" don't look the same in a table.
 */

export const EMPTY = "—";

export function formatText(value: string | null | undefined): string {
  if (value === null || value === undefined) return EMPTY;
  return value.trim() === "" ? EMPTY : value;
}

export function formatPct(value: number | null | undefined): string {
  return value === null || value === undefined ? EMPTY : `${value}%`;
}

/** A bare calendar date, as every `date` column arrives from PostgREST. */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parses a value for display, distinguishing a calendar date from an instant.
 *
 * **Why this is not just `new Date(value)`.** Per ECMA-262, `new Date("2026-08-07")`
 * parses a date-only string as **UTC midnight**, while a string with a time is
 * parsed as local. So anywhere west of UTC — which is everywhere this CRM is used —
 * every `date` column rendered one day early: a task due the 7th displayed as
 * "Due 8/6", a follow-up set for the 1st shown as the previous month. It was
 * visible on the leads, merchants and pre-app pages before the tasks panel made
 * it obvious by putting an "Overdue" label next to the wrong day (the overdue test
 * compares YYYY-MM-DD strings, which was right, so the two disagreed).
 *
 * Splitting the parts and using the multi-argument constructor builds the date in
 * local time, which is what a calendar date means. Timestamps (`created_at`,
 * `updated_at`, `uploaded_at`) carry a zone and still go through `new Date` as
 * instants — they name a moment, not a day, and converting them to the viewer's
 * zone is correct.
 *
 * Exported so tests can assert the local calendar components directly, which is
 * the only timezone-independent way to pin this.
 */
export function parseDisplayDate(value: string): Date | null {
  const parts = DATE_ONLY.exec(value);
  const date = parts
    ? new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return EMPTY;
  const date = parseDisplayDate(value);
  return date === null ? EMPTY : date.toLocaleDateString();
}
