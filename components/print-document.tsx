import Image from "next/image";
import { type ReactNode } from "react";

/**
 * The scaffold every printable document sits in, and the Tapswipe mark that
 * heads each of its sheets.
 *
 * Used by the three printable routes — /pre-apps/blank-form,
 * /merchants/[id]/print and /payouts/[period]/summary/[agentId] — so the three
 * cannot drift, and rendering `public/logo-icon.png`, the same file the
 * sidebar uses. There is no second copy of the asset and no print-specific
 * export of it: one file means the printed mark changes when the app's does.
 *
 * ## Why this is a real <table>, which is not a decision taken lightly
 *
 * A running head has to repeat on every sheet AND reserve its own space on
 * every sheet. Three mechanisms were measured against a real six-sheet
 * paginated PDF of the blank application, and only one does both:
 *
 *   - `display: table-header-group` on a div — does NOT repeat. Not with the
 *     content as one block, not with every child made a `table-row`, not with
 *     an explicit row group. Chrome's header repetition is a property of real
 *     table markup, not of the computed display value. Measured: mark on sheet
 *     1 of 6 in all three arrangements.
 *   - `position: fixed` — repeats, but cannot reserve space. A fixed box is
 *     laid out against the page's CONTENT area, which is exactly where the
 *     text starts, so it prints over the first lines of every sheet. Pushing
 *     it into the page margin with a negative `top` and a bigger `@page`
 *     margin looks like the fix and is not: measured, it silently drops off
 *     the LAST sheet (6 of 7), and `@page` margins are overridable from the
 *     user's own print dialog anyway.
 *   - a real `<table>` with a real `<thead>` — repeats on every sheet, and
 *     reserves its space because that is what a table header does. Verified
 *     with the body as a single tall row wrapping a flex column, which is
 *     exactly the shape below: mark on 8 of 8.
 *
 * So the table is a paged-media device, not a data table, and it is marked
 * `role="presentation"` to say so — that strips the table, row and cell roles
 * from the accessibility tree, leaving the document's own semantics (the
 * <article> around this, and each page's <header> and <section>s) as the only
 * structure a screen reader sees.
 *
 * `table-fixed` is load-bearing on the payout summary: auto layout sizes a
 * table to its widest content, and that page nests a ledger table holding a
 * 100-character merchant name, which would otherwise push the sheet wider than
 * the paper.
 *
 * ## The mark itself
 *
 *   - **No `print:hidden`, and nothing that could sweep it up.** This is the
 *     one element on these pages that must SURVIVE print media, and it sits
 *     where the old global `header { display: none }` rule used to reach.
 *   - **`priority`.** next/image is lazy by default, and an image that has not
 *     loaded when the print dialog opens prints as nothing — invisible on
 *     screen. Eager and preloaded removes the race, and it matters more for a
 *     running head than it did for a one-off: a late image loses every sheet.
 *   - **The intrinsic size is ~4x the painted one.** The browser picks a
 *     srcset candidate from the screen's DPR and does not pick again for the
 *     printer. Measured: asking for 176px to paint 44px fetches the 256px
 *     candidate, so a 300dpi sheet gets a crisp mark, not an upscaled
 *     thumbnail. `w-auto` keeps the 835x603 aspect.
 *
 * No white plate behind it, unlike the sidebar: that exists because the mark's
 * black linework would vanish on #0E0E10, and paper is already white. Which
 * also keeps it clear of print-color-adjust — a CSS background is what a
 * browser strips when printing, and an <img> is not.
 */
export function PrintDocument({
  bodyClassName,
  children,
}: {
  /** The document's own layout classes, e.g. "flex flex-col gap-6". */
  bodyClassName: string;
  children: ReactNode;
}) {
  return (
    <table data-print-document role="presentation" className="w-full table-fixed">
      <thead>
        <tr>
          {/* Spacing goes on the cell: it is what repeats, so it separates the
              mark from the text on every sheet rather than only the first. */}
          <td className="pb-4">
            <div className="flex items-center gap-2.5">
              <Image
                src="/logo-icon.png"
                alt="Tapswipe"
                width={176}
                height={127}
                priority
                className="h-8 w-auto"
              />
              <span className="text-[15px] font-bold tracking-[0.12em]">
                TAPSWIPE
              </span>
            </div>
          </td>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>
            <div className={bodyClassName}>{children}</div>
          </td>
        </tr>
      </tbody>
    </table>
  );
}
