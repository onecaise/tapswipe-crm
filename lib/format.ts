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

export function formatDate(value: string | null | undefined): string {
  if (!value) return EMPTY;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? EMPTY : date.toLocaleDateString();
}
