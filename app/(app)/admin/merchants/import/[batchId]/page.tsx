import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ArrowLeftIcon, MapPinIcon } from "lucide-react";

import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatDate, formatText } from "@/lib/format";
import {
  MERCHANT_IMPORT_BATCH_COLUMNS,
  MERCHANT_IMPORT_ROW_COLUMNS,
  batchStatusIntent,
  blockerLabel,
  noteLabel,
  rateLabel,
  reviewMerchantImport,
  type MerchantImportBatch,
  type MerchantImportRow,
} from "@/lib/merchant-imports";
import { Callout } from "@/components/callout";
import {
  MerchantImportActions,
  MerchantImportCommitButton,
} from "@/components/merchant-import-actions";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { StatCard } from "@/components/stat-card";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";

/** "rows 3, 7, 12" -- the file's own row numbers, at most twenty. */
function rowList(rows: number[]): string {
  const shown = rows.slice(0, 20).join(", ");
  const more = rows.length > 20 ? ` and ${rows.length - 20} more` : "";
  return `row${rows.length === 1 ? "" : "s"} ${shown}${more}`;
}

/**
 * The review screen, then the result: one page, the same batch at two points.
 * Every refusal group with the offending values and their row numbers, the
 * informational notes, and Commit -- disabled until there is no refusal. The
 * database re-derives every check at commit regardless.
 */
async function BatchReview({ params }: { params: Promise<{ batchId: string }> }) {
  const { batchId: segment } = await params;
  const batchId = Number(segment);
  if (!Number.isInteger(batchId) || batchId <= 0) notFound();

  await requireAdmin();
  const supabase = await createClient();

  const { data: batchData, error: batchError } = await supabase
    .from("merchant_import_batches")
    .select(MERCHANT_IMPORT_BATCH_COLUMNS)
    .eq("id", batchId)
    .maybeSingle();
  if (batchError) {
    return <p className="text-sm text-destructive">Could not load this import: {batchError.message}</p>;
  }
  if (!batchData) notFound();
  const batch = batchData as MerchantImportBatch;

  // Up to 2,000 rows: read in pages under PostgREST's max_rows.
  const rows: MerchantImportRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("merchant_import_rows")
      .select(MERCHANT_IMPORT_ROW_COLUMNS)
      .eq("batch_id", batchId)
      .order("row_number", { ascending: true })
      .range(from, from + 999);
    if (error) {
      return <p className="text-sm text-destructive">Could not load the rows: {error.message}</p>;
    }
    rows.push(...((data ?? []) as MerchantImportRow[]));
    if ((data ?? []).length < 1000) break;
  }

  // Owner names for the row list (admins read every profile).
  const ownerIds = [...new Set(rows.map((r) => r.owner_id).filter((id): id is string => id !== null))];
  const owners = new Map<string, string>();
  if (ownerIds.length > 0) {
    const { data } = await supabase.from("profiles").select("id, full_name").in("id", ownerIds);
    for (const p of data ?? []) owners.set(p.id as string, p.full_name as string);
  }

  const review = reviewMerchantImport(rows);
  const committed = batch.status === "committed";
  const inReview = batch.status === "review";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={formatText(batch.file_name)}
        subtitle={`Uploaded ${formatDate(batch.uploaded_at)} · ${batch.file_kind.toUpperCase()}`}
        action={inReview ? <MerchantImportActions batchId={batch.id} /> : undefined}
      >
        <div className="mt-1 flex items-center gap-2">
          <StatusBadge intent={batchStatusIntent(batch.status)}>{batch.status}</StatusBadge>
        </div>
      </PageHeader>

      {committed && (
        <Callout tone="success">
          <p className="font-medium">
            {batch.merchant_count} merchant{batch.merchant_count === 1 ? "" : "s"} created
          </p>
          <p className="mt-1 text-muted-foreground">
            Committed {formatDate(batch.committed_at)}. The file has no addresses, so each new
            merchant is listed under Merchants missing a location until one is added. Overrides
            were not imported: add them on each merchant.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button asChild size="sm">
              <Link href="/merchants">Go to Merchants</Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link href="/admin/merchants/missing-location">
                <MapPinIcon size={16} />
                Missing locations
              </Link>
            </Button>
          </div>
        </Callout>
      )}

      {batch.status === "abandoned" && (
        <p className="text-sm text-muted-foreground">This import was abandoned. Nothing was created from it.</p>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Rows in the file" value={review.total} />
        <StatCard label={committed ? "Merchants created" : "Merchants to create"} value={committed ? (batch.merchant_count ?? 0) : review.willCreate} />
        <StatCard label="Duplicate rows merged" value={review.merged} />
        <StatCard label="Rows refused" value={review.refusedRows} accent={review.refusedRows > 0} />
      </div>

      {inReview && review.problems.length > 0 && (
        <section className="flex flex-col gap-2" aria-labelledby="refusals">
          <h2 id="refusals" className="text-sm font-semibold tracking-tight">
            Problems — nothing can be created until every one is gone
          </h2>
          <p className="text-xs text-muted-foreground">
            Fix the file and upload it again, or fix the CRM (a rep&apos;s LLC legal name on
            Manage Users, for example) and press &ldquo;Read again&rdquo;.
          </p>
          {review.problems.map((problem) => (
            <div
              key={problem.code}
              role="group"
              aria-label={blockerLabel(problem.code)}
              className="flex flex-col gap-1 rounded-xl border bg-card px-4 py-3"
            >
              <p className="text-sm font-medium">
                {blockerLabel(problem.code)}
                <span className="ml-2 font-normal text-muted-foreground">
                  {problem.rowCount} row{problem.rowCount === 1 ? "" : "s"}
                </span>
              </p>
              {problem.duplicates ? (
                <ul className="flex flex-col gap-2">
                  {problem.duplicates.map((group) => (
                    <li key={group.mid} className="text-xs">
                      <span className="font-mono">{group.mid}</span>
                      <ul className="mt-0.5 flex flex-col gap-0.5 text-muted-foreground">
                        {group.rows.map((r) => (
                          <li key={r.rowNumber} className="break-words">
                            Row {r.rowNumber}: {formatText(r.agent)} · split {formatText(r.split)} ·{" "}
                            {formatText(r.processor)} · {formatText(r.status)} · {formatText(r.name)}
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              ) : (
                <ul className="flex flex-col gap-0.5">
                  {problem.values.map((v) => (
                    <li key={v.value} className="break-words text-xs text-muted-foreground">
                      <span className="font-mono text-foreground">{v.value}</span> — {rowList(v.rows)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </section>
      )}

      {review.notes.length > 0 && (
        <section className="flex flex-col gap-2" aria-labelledby="notes">
          <h2 id="notes" className="text-sm font-semibold tracking-tight">
            For your information
          </h2>
          <ul className="flex flex-col gap-1 rounded-xl border bg-card px-4 py-3">
            {review.notes.map((note) => (
              <li key={note.code} className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{note.count}</span> — {noteLabel(note.code)}
              </li>
            ))}
          </ul>
        </section>
      )}

      {inReview && (
        <Callout tone={review.canCommit ? "success" : "warning"}>
          <p className="font-medium">
            {review.canCommit
              ? `Ready to create ${review.willCreate} merchant${review.willCreate === 1 ? "" : "s"}.`
              : "Not ready: fix every problem above first."}
          </p>
          <p className="mt-1 text-muted-foreground">
            All of them are created at once, or none. The file has no addresses, so the new
            merchants will be listed under Merchants missing a location.
          </p>
          <div className="mt-3">
            <MerchantImportCommitButton batchId={batch.id} merchantCount={review.willCreate} disabled={!review.canCommit} />
          </div>
        </Callout>
      )}

      <section className="flex flex-col gap-2" aria-labelledby="rows">
        <h2 id="rows" className="text-sm font-semibold tracking-tight">
          Every row in the file
        </h2>
        <div className="overflow-x-auto rounded-xl border bg-card">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 text-left font-medium">Row</th>
                <th className="px-3 py-2 text-left font-medium">Merchant ID</th>
                <th className="px-3 py-2 text-left font-medium">Name</th>
                <th className="px-3 py-2 text-left font-medium">Rep</th>
                <th className="px-3 py-2 text-left font-medium">Split</th>
                <th className="px-3 py-2 text-left font-medium">Processor</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-left font-medium">Check</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b last:border-0">
                  <td className="px-3 py-2 text-muted-foreground">{row.row_number}</td>
                  <td className="px-3 py-2 font-mono text-xs">{formatText(row.mid ?? row.mid_raw)}</td>
                  <td className="px-3 py-2">{formatText(row.name ?? row.name_raw)}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {formatText(row.owner_id ? owners.get(row.owner_id) ?? row.agent_raw : row.agent_raw)}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{rateLabel(row)}</td>
                  <td className="px-3 py-2 text-muted-foreground">{formatText(row.processor ?? row.processor_raw)}</td>
                  <td className="px-3 py-2 text-muted-foreground">{formatText(row.status ?? row.status_raw)}</td>
                  <td className="px-3 py-2">
                    {row.blockers.length > 0 ? (
                      <StatusBadge intent="warning">{blockerLabel(row.blockers[0])}</StatusBadge>
                    ) : row.merged_into !== null ? (
                      <StatusBadge intent="neutral">Merged into row {row.merged_into}</StatusBadge>
                    ) : (
                      <StatusBadge intent="success">Ready</StatusBadge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

export default function MerchantImportBatchPage({ params }: { params: Promise<{ batchId: string }> }) {
  return (
    <PageShell width="detail">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href="/admin/merchants/import">
          <ArrowLeftIcon size={16} />
          All merchant imports
        </Link>
      </Button>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading import…</p>}>
        <BatchReview params={params} />
      </Suspense>
    </PageShell>
  );
}
