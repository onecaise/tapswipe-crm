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

/**
 * US dollars, for the residual ledger and the payout summary.
 *
 * PostgREST sends `numeric` as a string to preserve exactness, so this takes both
 * and does the coercion in one place rather than at every call site. A string that
 * is not a number returns the em dash rather than "$NaN" — for a money column,
 * looking absent is a better failure than looking like a figure.
 *
 * Negative values render as `-$88.40`, not `($88.40)`. The accounting-parentheses
 * convention reads as a typo in a web table, and a clawback is a normal month
 * here rather than an exception worth a second notation.
 */
export function formatMoney(
  value: number | string | null | undefined,
): string {
  if (value === null || value === undefined || value === "") return EMPTY;

  const amount = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(amount)) return EMPTY;

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}

/**
 * A stored lowercase vocabulary word, for display beside a StatusBadge.
 *
 * StatusBadge capitalises through CSS, so a detail page showed "Open" in the
 * badge and a bare "open" in the field below it — the same value, twice, in two
 * casings. This capitalises the first letter only: these are single words from
 * a fixed vocabulary ("open", "submitted", "declined"), not titles, so
 * per-word capitalisation would be wrong for anything with a space in it.
 * Everything else, including free text a rep typed, is left exactly as entered.
 */
export function formatStatus(value: string | null | undefined): string {
  const text = formatText(value);
  if (text === EMPTY) return EMPTY;
  return text.charAt(0).toUpperCase() + text.slice(1);
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

/**
 * A residual period — always the first of a month — as "July 2026".
 *
 * Built on parseDisplayDate, and that is the whole reason this exists rather than
 * being inlined at each call site. The date-only-is-UTC bug documented above
 * shifts a calendar date one day earlier everywhere west of UTC; on the FIRST of a
 * month that lands in the *previous month*, so December 2026 would render as
 * "November 2026" and January 2027 as "December 2026". A date off by a day gets
 * noticed. A commission statement headed with the wrong month and year does not,
 * until someone reconciles it against the processor's own report.
 */
export function formatPeriod(value: string | null | undefined): string {
  if (!value) return EMPTY;
  const date = parseDisplayDate(value);
  if (date === null) return EMPTY;
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

/**
 * The `YYYY-MM` form a period takes in a route segment, from a stored `date`.
 *
 * Same local-time reasoning as formatPeriod, with the same consequence if it is
 * got wrong: every period would link to the month before its own.
 */
export function periodParam(value: string): string {
  const date = parseDisplayDate(value);
  if (date === null) return "";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${date.getFullYear()}-${month}`;
}

/** A `time` column, as PostgREST sends it: "HH:MM" or "HH:MM:SS". */
const CLOCK_TIME = /^(\d{2}):(\d{2})(?::\d{2})?$/;

/**
 * A wall-clock time carrying no date — `pre_app_terminal.batch_out_time` is the
 * only one so far.
 *
 * Formatted arithmetically rather than through `Date`, for the same reason
 * parseDisplayDate exists: a `time` value names a time of day, not an instant.
 * There is no correct date to anchor it to, and anchoring it to today would
 * reintroduce exactly the zone-shift bug documented above.
 */
export function formatClockTime(value: string | null | undefined): string {
  if (!value) return EMPTY;
  const parts = CLOCK_TIME.exec(value);
  if (parts === null) return EMPTY;

  const hours = Number(parts[1]);
  const minutes = parts[2];
  if (hours > 23 || Number(minutes) > 59) return EMPTY;

  const suffix = hours < 12 ? "AM" : "PM";
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${minutes} ${suffix}`;
}

/**
 * A `timestamptz` as date and time, e.g. "8/21/2026, 2:14 PM".
 *
 * The first place this app shows the *time* half of a timestamp: every other
 * created_at is rendered with formatDate, where the date is the whole point. The
 * notifications panel needs more resolution, because "what is new since you last
 * looked" is frequently several items on the same day, and three rows all
 * reading "8/21/2026" cannot be ordered by eye.
 *
 * Safe to hand straight to `new Date()`, unlike the date-only values
 * parseDisplayDate exists for: a timestamptz carries its zone, so there is a
 * correct instant to convert and no midnight to shift across. That is why this
 * does NOT go through parseDisplayDate — doing so would route it into the
 * DATE_ONLY branch's local-midnight construction for no reason.
 *
 * Deliberately not a relative formatter ("3 minutes ago"). That reads better for
 * exactly as long as the page is fresh, then quietly starts lying: without a
 * ticking clock it is frozen at render time, and with one it is a re-render per
 * second in the topbar of every page. An absolute stamp is right whenever it is
 * read.
 */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return EMPTY;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return EMPTY;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
