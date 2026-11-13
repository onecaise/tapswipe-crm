import Link from "next/link";
import { Suspense } from "react";
import { ArrowLeftIcon } from "lucide-react";

import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatDate, formatText } from "@/lib/format";
import {
  MERCHANT_IMPORT_BATCH_COLUMNS,
  batchStatusIntent,
  type MerchantImportBatch,
} from "@/lib/merchant-imports";
import { MerchantImportUpload } from "@/components/merchant-import-upload";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";

/**
 * Import merchants (phase 14 of docs/design/intake-and-reports.md): the upload
 * form and every import started. Two boundaries, as on the other admin pages:
 * requireAdmin() here, and the admin-only policies on merchant_import_batches.
 */
async function ImportBatches() {
  await requireAdmin();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("merchant_import_batches")
    .select(MERCHANT_IMPORT_BATCH_COLUMNS)
    .order("id", { ascending: false });

  if (error) {
    return <p className="text-sm text-destructive">Could not load imports: {error.message}</p>;
  }
  const batches = (data ?? []) as MerchantImportBatch[];

  return (
    <div className="flex flex-col gap-6">
      <MerchantImportUpload />
      {batches.length === 0 ? (
        <p className="text-sm text-muted-foreground">No merchant files have been imported yet.</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-xl border bg-card">
          {batches.map((batch) => (
            <li key={batch.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <div className="min-w-0">
                <Link
                  href={`/admin/merchants/import/${batch.id}`}
                  className="break-all font-medium text-primary hover:underline"
                >
                  {formatText(batch.file_name)}
                </Link>
                <p className="text-xs text-muted-foreground">
                  {batch.row_count} row{batch.row_count === 1 ? "" : "s"} · uploaded{" "}
                  {formatDate(batch.uploaded_at)}
                  {batch.merchant_count !== null &&
                    ` · ${batch.merchant_count} merchant${batch.merchant_count === 1 ? "" : "s"} created`}
                </p>
              </div>
              <StatusBadge intent={batchStatusIntent(batch.status)}>{batch.status}</StatusBadge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function MerchantImportPage() {
  return (
    <PageShell width="list">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href="/merchants">
          <ArrowLeftIcon size={16} />
          Back to merchants
        </Link>
      </Button>
      <PageHeader
        title="Import merchants"
        subtitle="Create many merchants from the ISO Hub export. Nothing is created until every problem in the file is fixed and you press Commit — and then all of them are created, or none."
      />
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading imports…</p>}>
        <ImportBatches />
      </Suspense>
    </PageShell>
  );
}
