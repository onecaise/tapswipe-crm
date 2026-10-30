import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ArrowLeftIcon } from "lucide-react";

import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { EMPTY, formatDate, formatPeriod, formatText } from "@/lib/format";
import {
  PAYOUT_BATCH_COLUMNS,
  PAYOUT_IMPORT_ROW_COLUMNS,
  batchStatusIntent,
  blockerLabel,
  previewFlagLabel,
  reviewImportRows,
  rowsWritten,
  warningLabel,
  warningQuestion,
  type PayoutBatch,
  type PayoutImportRow,
} from "@/lib/payouts";
import { loadSkipReviewers } from "@/lib/residual-skips";
import { Callout } from "@/components/callout";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { ResidualBatchActions } from "@/components/residual-batch-actions";
import { ResidualSkipsNotice } from "@/components/residual-skips-notice";
import {
  ResidualWarningConfirmations,
  RowList,
  type WarningBlock,
} from "@/components/residual-warning-confirmations";
import { StatCard } from "@/components/stat-card";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";

/**
 * The review screen -- where a refused import waits, and where its warnings
 * are confirmed.
 *
 * A PAGE rather than a dismissible dialog on purpose. A batch outlives the
 * session: adding the merchants an import refused for can take a day, and the
 * admin will navigate away and come back. components/new-user-form.tsx records
 * the same reasoning for the same kind of thing.
 *
 * Phase 7 of docs/design/intake-and-reports.md (§2.2, §2.4). Two kinds of thing,
 * shown two ways:
 *   - REFUSALS (any blocker) refuse the whole import: a Callout at the top lists
 *     every one, and nothing can be committed. An unknown MID is fixed in the
 *     CRM and then "Read again"; every other refusal needs a corrected file
 *     (A27). The screen is the alert (A9): nothing is sent anywhere.
 *   - WARNINGS (processor mismatch, inactive merchant, bad numbers) are
 *     confirmed with one yes per TYPE, never per line, before the commit is
 *     offered.
 * Nothing here edits a figure the processor sent.
 */
async function BatchReview({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  const { batchId: segment } = await params;
  const batchId = Number(segment);

  // Guarded before the query, the way the merchants detail page guards its id.
  if (!Number.isInteger(batchId) || batchId <= 0) notFound();

  await requireAdmin();
  const supabase = await createClient();

  const { data: batchData, error: batchError } = await supabase
    .from("rep_payout_batches")
    .select(PAYOUT_BATCH_COLUMNS)
    .eq("id", batchId)
    .maybeSingle();

  if (batchError) {
    return (
      <p className="text-sm text-destructive">
        Could not load this import: {batchError.message}
      </p>
    );
  }
  // Not found and not visible are the same answer, so this cannot be used to
  // discover which batch ids exist.
  if (!batchData) notFound();

  const batch = batchData as PayoutBatch;

  const { data: rowData, error: rowError } = await supabase
    .from("rep_payout_import_rows")
    .select(PAYOUT_IMPORT_ROW_COLUMNS)
    .eq("batch_id", batchId)
    .order("row_number", { ascending: true });

  if (rowError) {
    return (
      <p className="text-sm text-destructive">
        Could not load the staged rows: {rowError.message}
      </p>
    );
  }

  const rows = (rowData ?? []) as PayoutImportRow[];
  const review = reviewImportRows(rows);

  // Advisory notes (a changed payee, a share that does not cover the month):
  // a flagged row is still ready, and the commit recomputes everything then.
  const flagged = rows.filter((row) => row.preview_flag !== null);

  const reviewers =
    batch.skipped_rows.length > 0
      ? await loadSkipReviewers(supabase, [batch.id])
      : new Map<number, string>();

  // The CRM side of each warned row: the merchant's own processor and name
  // ("the file says X, the merchant is set to Y").
  const merchantIds = [
    ...new Set(
      rows
        .filter((row) => row.warnings.length > 0)
        .map((row) => row.merchant_id)
        .filter((value): value is number => value !== null),
    ),
  ];
  const merchants = new Map<
    number,
    { dba: string | null; processor: string | null }
  >();
  if (merchantIds.length > 0) {
    const { data } = await supabase
      .from("merchants")
      .select("id, dba, processor")
      .in("id", merchantIds);
    for (const merchant of (data ?? []) as {
      id: number;
      dba: string | null;
      processor: string | null;
    }[]) {
      merchants.set(merchant.id, {
        dba: merchant.dba,
        processor: merchant.processor,
      });
    }
  }
  const byNumber = new Map(rows.map((row) => [row.row_number, row]));

  const warningText = (warning: string, rowNumber: number): string => {
    const row = byNumber.get(rowNumber);
    if (!row) return "";
    const mid = `MID ${row.mid_raw ?? EMPTY}`;
    const merchant =
      row.merchant_id === null ? undefined : merchants.get(row.merchant_id);
    if (warning === "processor_mismatch") {
      const parts: string[] = [];
      const fileSays = (row.processor_raw ?? "").replace(/\s+/g, " ").trim();
      if (fileSays.toLowerCase() !== (batch.processor ?? "").toLowerCase()) {
        parts.push(
          fileSays === ""
            ? "the file's Processor cell is blank"
            : `the file says "${fileSays}"`,
        );
      }
      if (merchant?.processor && merchant.processor !== batch.processor) {
        parts.push(
          `the merchant is set to ${merchant.processor} (importing does not change it)`,
        );
      }
      return `${mid}: ${parts.join(" and ") || "the processor differs"}.`;
    }
    if (warning === "inactive_merchant") {
      return `${mid}: ${
        merchant?.dba ?? row.merchant_name_raw ?? "this merchant"
      } is inactive. The line is still paid to its owner.`;
    }
    if (warning === "bad_numbers") {
      return `${mid}: volume ${row.volume_raw ?? EMPTY}, residual ${
        row.residual_income_raw ?? EMPTY
      }.`;
    }
    return mid;
  };

  const blocks: WarningBlock[] = review.warnings.map((group) => ({
    warning: group.warning,
    label: warningLabel(group.warning),
    question: warningQuestion(group.warning),
    rows: group.rows.map((line) => ({
      rowNumber: line.rowNumber,
      text: warningText(group.warning, line.rowNumber),
    })),
  }));

  // Which payees are switched off. Not a blocker -- money owed and the ability
  // to log in are separate questions -- but worth saying, because those rows
  // will import and the rep will not be able to see them (the own-row select
  // branch requires is_active_agent()).
  const payeeIds = [
    ...new Set(
      rows
        .map((row) => row.agent_id)
        .filter((value): value is string => value !== null),
    ),
  ];
  let inactive: { full_name: string; agent_number: string | null }[] = [];
  if (payeeIds.length > 0) {
    const { data: reps } = await supabase
      .from("profiles")
      .select("id, full_name, agent_number, is_active")
      .in("id", payeeIds)
      .eq("is_active", false);
    inactive = (reps ?? []) as typeof inactive;
  }

  const fileProblems = review.refusals.filter(
    (refusal) => refusal.blocker !== "unknown_mid",
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={formatText(batch.file_name)}
        subtitle={`${batch.processor ?? "No processor"} · ${
          batch.period ? formatPeriod(batch.period) : "no month"
        } · Uploaded ${formatDate(batch.uploaded_at)}`}
        action={
          <ResidualBatchActions batchId={batch.id} status={batch.status} />
        }
      >
        <div className="mt-1 flex items-center gap-2">
          <StatusBadge intent={batchStatusIntent(batch.status)}>
            {batch.status}
          </StatusBadge>
        </div>
      </PageHeader>

      {/* The commit result's skipped rows, at the TOP: the first thing an
          admin sees after committing, until they are reviewed. */}
      <ResidualSkipsNotice
        batch={batch}
        reviewerName={reviewers.get(batch.id)}
        linkToBatch={false}
      />

      {/* The replace (phase 9): a batch that replaces another says so while
          it waits, and the one it replaced points to its successor. */}
      {batch.replaces_batch_id !== null && batch.status === "review" && (
        <Callout tone="warning">
          <div data-testid="replaces-import">
            <p className="font-medium">
              This file replaces{" "}
              <Link
                href={`/payouts/import/${batch.replaces_batch_id}`}
                className="underline underline-offset-4"
              >
                import #{batch.replaces_batch_id}
              </Link>
              .
            </p>
            <p className="mt-1 text-muted-foreground">
              Committing it removes every line that import wrote for{" "}
              {batch.processor} {formatPeriod(batch.period)} and writes these
              instead. It is refused if the month has been marked paid since.
            </p>
          </div>
        </Callout>
      )}
      {batch.status === "replaced" && batch.replaced_by_batch_id !== null && (
        <div className="rounded-xl border p-4 text-sm text-muted-foreground">
          <p data-testid="replaced-by">
            Replaced by{" "}
            <Link
              href={`/payouts/import/${batch.replaced_by_batch_id}`}
              className="underline underline-offset-4"
            >
              import #{batch.replaced_by_batch_id}
            </Link>
            . Its lines were removed when that one was committed; the file is
            kept.
          </p>
        </div>
      )}
      {batch.status === "deleted" && (
        <div className="rounded-xl border p-4 text-sm text-muted-foreground">
          <p>
            This month&rsquo;s lines from this import were deleted. The file is
            kept.
          </p>
        </div>
      )}

      {batch.status === "review" && batch.processor === null && (
        <Callout tone="warning">
          <p className="font-medium">
            This import was started before the processor and month were chosen
            at upload.
          </p>
          <p className="mt-1 text-muted-foreground">
            It cannot be read again or committed. Abandon it and upload the file
            again.
          </p>
        </Callout>
      )}

      {batch.row_count === 0 && rows.length === 0 ? (
        <Callout tone="warning">
          <p className="font-medium">This import has no rows.</p>
          <p className="mt-1 text-muted-foreground">
            The upload or the read did not finish. Try &ldquo;Read again&rdquo; —
            if the file never arrived, abandon this import and upload it afresh.
          </p>
        </Callout>
      ) : (
        <>
          {/* Two different questions, so two different sets of figures.
              `review` is derived from the STAGING rows, and commit deletes
              those -- so a settled batch reads rep_payout_batches.row_count,
              the surviving record of what was committed. */}
          {batch.status === "review" ? (
            <div className="grid gap-3 sm:grid-cols-3">
              <StatCard label="Rows in the file" value={review.total} />
              <StatCard label="Ready" value={review.clean} />
              <StatCard
                label="Refused"
                value={review.blocked}
                accent={review.blocked > 0}
              />
            </div>
          ) : (
            <div
              className={
                batch.skipped_rows.length > 0
                  ? "grid gap-3 sm:grid-cols-3"
                  : "grid gap-3 sm:grid-cols-2"
              }
            >
              {/* What the commit recorded on the batch, read back so a reload
                  agrees. v3 skips nothing; a skip count is only on a batch
                  an earlier commit wrote. */}
              <StatCard
                label={
                  batch.status === "committed"
                    ? "Rows imported"
                    : "Rows in the file"
                }
                value={
                  batch.status === "committed"
                    ? rowsWritten(batch)
                    : batch.row_count
                }
              />
              {batch.skipped_rows.length > 0 && (
                <StatCard
                  label="Rows skipped"
                  value={batch.skipped_rows.length}
                  accent
                />
              )}
              <StatCard
                label="Committed"
                value={
                  batch.committed_at === null
                    ? EMPTY
                    : formatDate(batch.committed_at)
                }
              />
            </div>
          )}

          {review.refusals.length > 0 && (
            <Callout tone="danger">
              <div data-testid="import-refused" className="flex flex-col gap-3">
                <p className="font-medium">
                  This import is refused. Nothing can be committed until every
                  problem below is fixed.
                </p>
                {review.unknownMids.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <p>
                      {review.unknownMids.length === 1
                        ? "1 MID is not a merchant in the CRM"
                        : `${review.unknownMids.length} MIDs are not merchants in the CRM`}
                      :{" "}
                      <span className="font-mono">
                        {review.unknownMids.join(", ")}
                      </span>
                      .
                    </p>
                    <p className="text-muted-foreground">
                      Add them (or correct their MID), then choose &ldquo;Read
                      again&rdquo;. The file does not need uploading again.
                    </p>
                  </div>
                )}
                {fileProblems.map((problem) => (
                  <div key={problem.blocker} className="flex flex-col gap-1">
                    <p className="font-medium">
                      {blockerLabel(problem.blocker)}
                      <span className="ml-2 font-normal text-muted-foreground">
                        {problem.rows.length} row
                        {problem.rows.length === 1 ? "" : "s"}
                      </span>
                    </p>
                    <RowList
                      rows={problem.rows.map((line) => ({
                        rowNumber: line.rowNumber,
                        text: line.detail,
                      }))}
                    />
                  </div>
                ))}
                {fileProblems.some(
                  (problem) => problem.blocker !== "mid_in_other_batch",
                ) && (
                  <p className="text-muted-foreground">
                    A problem in the file itself is not fixed by reading it
                    again: abandon this import and upload a corrected file.
                  </p>
                )}
              </div>
            </Callout>
          )}

          {/* Rows an earlier parser skipped as Line = Adjustment, kept on the
              batch. The current parser reads a processor file, which has no
              such column. */}
          {batch.adjustment_rows_ignored > 0 && (
            <Callout tone="warning">
              <p className="font-medium" data-testid="adjustments-ignored">
                {batch.adjustment_rows_ignored} adjustment line
                {batch.adjustment_rows_ignored === 1 ? "" : "s"} ignored:
                adjustments are entered in the CRM.
              </p>
            </Callout>
          )}

          {flagged.length > 0 && batch.status === "review" && (
            <section
              className="flex flex-col gap-2"
              data-testid="shared-account-flags"
            >
              <h2 className="text-sm font-semibold tracking-tight">
                Notes
                <span className="ml-2 font-normal text-muted-foreground">
                  {flagged.length} row{flagged.length === 1 ? "" : "s"}
                </span>
              </h2>
              <p className="text-xs text-muted-foreground">
                None of these stops the import. They say that a MID now pays a
                different rep than last month, or that its shared-account split
                does not cover this month, as the data stands now.
              </p>
              <ul className="flex flex-col gap-2">
                {flagged.map((row) => (
                  <li
                    key={row.id}
                    className="flex min-w-0 flex-col gap-0.5 rounded-xl border bg-card px-4 py-3"
                  >
                    <p className="text-sm font-medium">
                      {previewFlagLabel(row.preview_flag as string)}
                      <span className="ml-2 font-normal text-muted-foreground">
                        Row {row.row_number}
                      </span>
                    </p>
                    <p className="break-words text-xs text-muted-foreground">
                      {row.preview_note}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {inactive.length > 0 && (
            <Callout tone="warning">
              <p className="font-medium">
                {inactive.length === 1
                  ? "One payee is deactivated."
                  : `${inactive.length} payees are deactivated.`}
              </p>
              <p className="mt-1 text-muted-foreground">
                {inactive
                  .map(
                    (rep) =>
                      `${rep.full_name}${
                        rep.agent_number ? ` (${rep.agent_number})` : ""
                      }`,
                  )
                  .join(", ")}
                . Their rows will import — residuals are still owed — but they
                will not be able to see them while their account is switched off.
              </p>
            </Callout>
          )}

          {batch.status === "review" && batch.processor !== null && (
            <ResidualWarningConfirmations
              batchId={batch.id}
              rowCount={review.total}
              ready={review.ready}
              blocks={blocks}
            />
          )}
        </>
      )}
    </div>
  );
}

export default function BatchReviewPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  // params passed down unawaited, so the dynamic read stays inside the Suspense
  // boundary that cacheComponents requires.
  return (
    <PageShell width="detail">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href="/payouts/import">
          <ArrowLeftIcon size={16} />
          All imports
        </Link>
      </Button>

      <Suspense
        fallback={
          <p className="text-sm text-muted-foreground">Loading import…</p>
        }
      >
        <BatchReview params={params} />
      </Suspense>
    </PageShell>
  );
}
