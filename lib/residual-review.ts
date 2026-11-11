import type { PayoutImportRow } from "@/lib/payouts";
import { isBlankFigure } from "@/supabase/functions/_shared/residuals";

/**
 * The review screen's server-side helpers that need the parser's own rules.
 *
 * Kept out of lib/payouts.ts on purpose: client components import that file,
 * and the residual parser (supabase/functions/_shared/residuals.ts) runs on
 * the server only (RESIDUALS_SPEC decision 22). Import this from Server
 * Components only.
 */

/**
 * Rows whose blank Volume or Residual the parser read as 0 (phase 15 of
 * docs/design/intake-and-reports.md): a MID, a figure of 0, and a raw cell
 * that was blank. Derived from the staged row, so it needs no column of its
 * own. Sheet row numbers, in order.
 */
export function blankFigureRows(rows: readonly PayoutImportRow[]): number[] {
  return rows
    .filter(
      (row) =>
        row.mid_raw !== null &&
        ((row.volume === 0 && isBlankFigure(row.volume_raw)) ||
          (row.residual_income === 0 && isBlankFigure(row.residual_income_raw))),
    )
    .map((row) => row.row_number);
}
