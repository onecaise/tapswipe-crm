import Link from "next/link";
import { Suspense } from "react";
import { ArrowLeftIcon } from "lucide-react";

import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatDate, formatText } from "@/lib/format";
import {
  PAYOUT_BATCH_COLUMNS,
  batchStatusIntent,
  type PayoutBatch,
} from "@/lib/payouts";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { ResidualUpload } from "@/components/residual-upload";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * Import residuals: the upload form, and every batch ever uploaded.
 *
 * Two independent boundaries, as on the other admin pages: requireAdmin() here,
 * and admin-only policies on rep_payout_batches. Strip the first and a rep still
 * gets nothing back.
 */
async function ImportBatches() {
  await requireAdmin();

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("rep_payout_batches")
    .select(PAYOUT_BATCH_COLUMNS)
    .order("id", { ascending: false });

  if (error) {
    return (
      <p className="text-sm text-destructive">
        Could not load imports: {error.message}
      </p>
    );
  }

  const batches = (data ?? []) as PayoutBatch[];

  return (
    <div className="flex flex-col gap-6">
      <ResidualUpload />

      {batches.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No residual reports have been uploaded yet.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>File</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Rows</TableHead>
              <TableHead>Uploaded</TableHead>
              <TableHead>Committed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {batches.map((batch) => (
              <TableRow key={batch.id}>
                <TableCell className="font-medium">
                  <Link
                    href={`/payouts/import/${batch.id}`}
                    className="underline underline-offset-4"
                  >
                    {formatText(batch.file_name)}
                  </Link>
                </TableCell>
                <TableCell>
                  <StatusBadge intent={batchStatusIntent(batch.status)}>
                    {batch.status}
                  </StatusBadge>
                </TableCell>
                {/* A `review` batch with no rows got as far as being started and
                    then failed to upload or parse. Shown rather than hidden: the
                    file may still be there to look at, and the review screen
                    offers to abandon it. */}
                <TableCell>{batch.row_count}</TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDate(batch.uploaded_at)}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDate(batch.committed_at)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

export default function ImportPage() {
  return (
    <PageShell width="list">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href="/payouts">
          <ArrowLeftIcon size={16} />
          Back to payouts
        </Link>
      </Button>

      <PageHeader
        title="Import residuals"
        subtitle="Nothing is added to the ledger until every row of a batch resolves, so an import can wait here while a rep is set up."
      />

      <Suspense
        fallback={
          <p className="text-sm text-muted-foreground">Loading imports…</p>
        }
      >
        <ImportBatches />
      </Suspense>
    </PageShell>
  );
}
