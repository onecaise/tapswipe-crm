/**
 * File sizes in words, shared by the two upload forms that refuse a file over
 * a bucket's limit (marketing materials and business documents).
 *
 * One copy, because both forms had their own identical formatBytes() and the
 * same message built from it -- and the same defect: a file over the limit by
 * less than the formatter's rounding read "That file is 50 MiB. The limit is
 * 50 MiB.", a sentence that contradicts itself.
 */

/** Human-readable byte count. Binary units, matching the bucket limits. One
 *  decimal below 10 of a unit, none above: "9.8 MiB", "51 MiB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/**
 * The sentence for a file over `limit`, or null when it is within it (a file
 * of exactly `limit` bytes is accepted, as the bucket accepts it).
 *
 * When the rounded size reads the same as the rounded limit -- 50 MiB plus a
 * byte, or plus a few hundred KiB -- quoting both numbers would say "50 MiB is
 * over 50 MiB". So that case says "slightly over" instead, and only a size
 * that rounds visibly above the limit is quoted.
 */
export function oversizeMessage(size: number, limit: number): string | null {
  if (size <= limit) return null;
  const sizeText = formatBytes(size);
  const limitText = formatBytes(limit);
  if (sizeText === limitText) {
    return `That file is slightly over the ${limitText} limit.`;
  }
  return `That file is ${sizeText}. The limit is ${limitText}.`;
}
