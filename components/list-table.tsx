import { Fragment } from "react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

/**
 * The app's one responsive list pattern: a table on a wide screen, a stack of
 * cards on a narrow one, from a single column definition.
 *
 * Every list page renders the same shape by hand today — a header row, a
 * conditional admin-only Agent column, an empty-state row, and a linked
 * identifying column — and none of them has a mobile fallback. The `Table`
 * primitive scrolls horizontally, so a phone does not break, but the
 * identifying column scrolls out of view and you lose track of which row you are
 * reading. Defining columns as data instead means the two layouts cannot drift,
 * the way lib/nav.ts keeps the sidebar's contents out of JSX.
 *
 * WHY CARDS AND NOT A STICKY FIRST COLUMN. A sticky column keeps the DBA in
 * view, but it leaves you scrolling seven columns one at a time through a 343px
 * window, and `position: sticky` inside `overflow-x-auto` on a border-collapse
 * table needs a background and a border workaround per cell. Cards show every
 * field of one record at once, which is what someone on a phone is actually
 * doing — reading one lead, not comparing forty.
 *
 * WHY `lg` (1024px) AND NOT `md`. This looks like the wrong breakpoint until you
 * measure, because the pinned sidebar makes the content width NON-MONOTONIC —
 * it gets wider with the viewport, then jumps DOWN at md when the sidebar takes
 * its 248px back. Measured against /leads as an admin:
 *
 *     viewport   content width   leads table wants
 *        375px           343px               821px
 *        767px           711px               821px
 *        768px           464px   <-- md, and NARROWER than 767px
 *       1024px           712px               821px
 *       1280px           968px               966px   <-- first honest fit
 *
 * So switching to a table at md would hand the table its worst width of the
 * whole range. Cards hold until lg, where a mild scroll remains and the table is
 * genuinely the better view; it stops scrolling around xl.
 *
 * BOTH LAYOUTS ARE RENDERED, one hidden with `display:none`. That doubles the
 * DOM for a list, which is the real cost and is worth stating. The alternative
 * is picking a layout from a JS breakpoint check, and these are server
 * components: that would mean a client component, a hydration mismatch or a
 * flash of the wrong layout, and a list that cannot render until JS arrives.
 * `display:none` is also the version that is properly hidden — absent from the
 * accessibility tree, and therefore from Playwright's `getByRole`, so the
 * duplicate rows do not make a role query ambiguous the way `visibility` or an
 * offscreen wrapper would.
 *
 * BUT NOT EVERY LOCATOR IS FILTERED THAT WAY, and this is the sharp edge. A
 * locator that does not consult the accessibility tree — `getByLabel` is the one
 * that bit — matches the hidden copy too, and strict mode then fails with
 * "resolved to 2 elements". Measured: converting the payouts ledger red 9 editing
 * specs outright, every one of them a getByLabel on a figure input.
 *
 * So the rule for a list with FORM CONTROLS in it is: assert with `getByRole`,
 * and expect any existing `getByLabel` against it to need scoping. That is a
 * real cost of rendering both layouts, and it is the reason the payouts ledger
 * is deliberately NOT on this component — see the note at the end of
 * app/(app)/payouts/[period]/page.tsx.
 */
export type ListColumn<T> = {
  /**
   * Column header, and the field label on the stacked card.
   *
   * An EMPTY string means the column has no label — an action column, like the
   * Document Center's download button, which renders under a bare <TableHead />
   * in the table. On the card such a column is NOT given an empty <dt> next to
   * it; it drops out of the field list and renders under it, full width, where
   * a button belongs. Several label-less columns are allowed and keep their
   * order.
   */
  header: string;
  /** The cell's contents. The same node serves both layouts. */
  cell: (row: T) => React.ReactNode;
  /**
   * Marks the column that identifies the row — usually the linked DBA. On the
   * card it becomes the heading rather than a labelled field. Exactly one
   * column should set it; the first column is used if none does.
   */
  primary?: boolean;
  /**
   * Renders BESIDE the card's heading instead of in the field list — for a
   * row-level control that belongs with the title rather than under it, like
   * the checkbox on /tasks and the bug-report queue.
   *
   * An ordinary column in the table, in whatever position it is declared. This
   * exists because such a control is usually a LEADING label-less column, and
   * the label-less handling below would otherwise push it to the bottom of the
   * card, far from the thing it acts on.
   */
  leading?: boolean;
  /**
   * Extra classes for the value — applied to the <td> and to the card's <dd>,
   * because `text-muted-foreground` means "this reads as secondary" in either
   * layout. Not applied to the card heading: the primary column is the heading,
   * which owns its own type.
   *
   * Static, not a function of the row. A per-row rule (a completed task's
   * strike-through, an overdue date in destructive red) belongs inside `cell`,
   * on the node it describes — which is also the only way the card gets it,
   * since a primary column's className never reaches the heading.
   */
  className?: string;
  /**
   * Extra classes for the <th>. Table-only, and almost always a width: the
   * checkbox columns pin themselves narrow with `w-10` so the control does not
   * sit in a column as wide as its neighbours.
   */
  headerClassName?: string;
};

export function ListTable<T>({
  columns,
  rows,
  rowKey,
  emptyMessage,
}: {
  columns: readonly ListColumn<T>[];
  rows: readonly T[];
  /** Stable key per row — the record id, not the array index. */
  rowKey: (row: T) => React.Key;
  emptyMessage: string;
}) {
  const primary = columns.find((column) => column.primary) ?? columns[0];
  const rest = columns.filter((column) => column !== primary);
  // Split for the card layout only: the table renders every column the same
  // way, header or not.
  const leading = rest.filter((column) => column.leading);
  const body = rest.filter((column) => !column.leading);
  const labelled = body.filter((column) => column.header !== "");
  const actions = body.filter((column) => column.header === "");
  const isEmpty = rows.length === 0;

  return (
    <>
      {/* Table, lg and up. */}
      <div className="hidden lg:block">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((column, index) => (
                <TableHead key={index} className={column.headerClassName}>
                  {column.header}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isEmpty ? (
              <TableRow>
                {/*
                  colSpan from the definition rather than a hand-counted
                  `isAdmin ? 8 : 7`. Every list page carried one of those, and it
                  is a number that silently stops matching the moment a column is
                  added — an empty state that under-spans just looks slightly
                  wrong, so nothing makes you check it.
                */}
                <TableCell
                  colSpan={columns.length}
                  className="text-muted-foreground"
                >
                  {emptyMessage}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow key={rowKey(row)}>
                  {columns.map((column, index) => (
                    <TableCell key={index} className={column.className}>
                      {column.cell(row)}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Cards, below lg. */}
      <div className="lg:hidden">
        {isEmpty ? (
          <div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
            {emptyMessage}
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {rows.map((row) => (
              <li
                key={rowKey(row)}
                // Same surface as the Table primitive draws for itself — white
                // card, hairline border, 12px radius — so the two layouts read
                // as one component rather than two.
                className="rounded-xl border bg-card p-4"
              >
                <div className="flex items-start gap-3">
                  {leading.length > 0 && (
                    // pt-0.5 nudges a checkbox onto the heading's first-line
                    // baseline; without it the control floats above a title
                    // that wraps.
                    <div className="flex shrink-0 items-center gap-2 pt-0.5">
                      {leading.map((column, index) => (
                        <Fragment key={index}>{column.cell(row)}</Fragment>
                      ))}
                    </div>
                  )}
                  <div className="min-w-0 flex-1 text-[15px] font-semibold">
                    {primary.cell(row)}
                  </div>
                </div>

                {labelled.length > 0 && (
                  <dl className="mt-3 grid grid-cols-[minmax(0,6.5rem)_minmax(0,1fr)] gap-x-3 gap-y-2">
                    {labelled.map((column, index) => (
                      <Fragment key={index}>
                        {/* Deliberately the same treatment as TableHead: a
                            field label here and a column header there are the
                            same thing wearing different layouts. */}
                        <dt className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
                          {column.header}
                        </dt>
                        <dd className={cn("min-w-0 text-sm", column.className)}>
                          {column.cell(row)}
                        </dd>
                      </Fragment>
                    ))}
                  </dl>
                )}

                {actions.length > 0 && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {actions.map((column, index) => (
                      <Fragment key={index}>{column.cell(row)}</Fragment>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
