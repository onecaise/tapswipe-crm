import Link from "next/link";

import { EMPTY, formatDate, formatPeriod } from "@/lib/format";
import { skipReasonLabel, skipsOwed, type PayoutBatch } from "@/lib/payouts";
import { AcknowledgeSkipsButton } from "@/components/acknowledge-skips-button";
import { Callout } from "@/components/callout";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * The rows a commit did not import (docs/design/residual-splits.md §5.4).
 *
 * A non-blocking skip must still never be QUIET, so while a batch's skips are
 * unreviewed this is a warning Callout — on the commit result and on every
 * period the batch touched — listing each row and carrying the one button that
 * retires it. Not a toast: a toast is gone before anyone has read the third row.
 *
 * Once reviewed it shrinks to one muted line naming who reviewed it and when,
 * so the record stays findable without shouting. The reviewer's name comes
 * from audit_log (lib/residual-skips.ts); if it cannot be read the line simply
 * omits it.
 *
 * Every row of the batch is listed, not only those of the period being viewed:
 * the button acknowledges the whole batch, and its count must be the count the
 * admin is looking at.
 *
 * Admin-only by RLS rather than by a branch: rep_payout_batches' select policy
 * is is_admin(), so a rep's page never has a batch to pass in.
 */
export function ResidualSkipsNotice({
  batch,
  reviewerName,
  linkToBatch,
}: {
  batch: Pick<
    PayoutBatch,
    "id" | "file_name" | "status" | "skipped_rows" | "skips_acknowledged_at"
  >;
  reviewerName?: string;
  /** On a period page, name and link the batch; on the batch page, it is the page. */
  linkToBatch: boolean;
}) {
  const skipped = batch.skipped_rows;
  if (batch.status !== "committed" || skipped.length === 0) return null;

  const batchRef = linkToBatch ? (
    <Link
      href={`/payouts/import/${batch.id}`}
      className="underline underline-offset-4"
    >
      batch #{batch.id}
    </Link>
  ) : (
    <>batch #{batch.id}</>
  );

  if (skipsOwed(batch) === 0) {
    return (
      <p
        data-testid="residual-skips-reviewed"
        className="text-xs text-muted-foreground"
      >
        {skipped.length} row{skipped.length === 1 ? "" : "s"} skipped in{" "}
        {batchRef}, reviewed {formatDate(batch.skips_acknowledged_at)}
        {reviewerName ? ` by ${reviewerName}` : ""}.
      </p>
    );
  }

  return (
    <div data-testid="residual-skips-notice" className="min-w-0">
      <Callout tone="warning" className="flex min-w-0 flex-col gap-3">
        <div>
          <p className="font-medium">
            {skipped.length === 1
              ? "1 row was not imported"
              : `${skipped.length} rows were not imported`}
            {linkToBatch && <> from {batchRef}</>}
          </p>
          <p className="mt-1 text-muted-foreground">
            These rows fall on shared accounts and were left out so the shared
            lines stay correct. Nothing else in the import waited for them.
            Check each against the processor&rsquo;s report, then mark them
            reviewed.
          </p>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Row</TableHead>
              <TableHead>Period</TableHead>
              <TableHead>MID</TableHead>
              <TableHead>Agent #</TableHead>
              <TableHead>Reason</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {skipped.map((row) => (
              <TableRow key={`${row.row_number}-${row.mid}`}>
                <TableCell>{row.row_number}</TableCell>
                <TableCell>{formatPeriod(row.period)}</TableCell>
                <TableCell className="font-mono text-xs">{row.mid}</TableCell>
                <TableCell className="font-mono text-xs">
                  {row.agent_number ?? EMPTY}
                </TableCell>
                <TableCell className="whitespace-normal">
                  {skipReasonLabel(row.reason)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <AcknowledgeSkipsButton batchId={batch.id} count={skipped.length} />
      </Callout>
    </div>
  );
}
