import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ArrowLeftIcon } from "lucide-react";

import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatDate, formatText } from "@/lib/format";
import {
  PAYOUT_BATCH_COLUMNS,
  PAYOUT_IMPORT_ROW_COLUMNS,
  batchStatusIntent,
  blockerLabel,
  reviewImportRows,
  type PayoutBatch,
  type PayoutImportRow,
} from "@/lib/payouts";
import { Callout } from "@/components/callout";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { ResidualBatchActions } from "@/components/residual-batch-actions";
import { ResidualCommitButton } from "@/components/residual-commit-button";
import { StatCard } from "@/components/stat-card";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";

/**
 * The review screen — where a blocked import waits.
 *
 * This is the "block that row's import" surface, and it is a PAGE rather than a
 * dismissible dialog on purpose. A batch outlives the session: an unrecognised
 * agent number can take a day to sort out, and the admin will navigate away to
 * create the rep and come back. components/new-user-form.tsx records the same
 * reasoning for the same kind of thing — a dialog that can be dismissed is the
 * wrong container for something that must not be lost.
 *
 * Blockers are presented in two groups because they are fixed two different ways:
 * an unrecognised agent number is one action that unblocks all of its rows, while
 * a bad figure on row 22 needs the spreadsheet corrected and re-uploaded. Only the
 * first is offered an in-place fix; the second says so rather than presenting an
 * edit affordance that would let someone silently retype a figure the processor
 * sent.
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

  // Which resolved reps are switched off. Not a blocker — money owed and the
  // ability to log in are separate questions — but worth saying, because those
  // rows will import and the rep will not be able to see them (the own-row select
  // branch requires is_active_agent()).
  const resolvedIds = [
    ...new Set(
      rows
        .map((row) => row.agent_id)
        .filter((value): value is string => value !== null),
    ),
  ];
  let inactive: { full_name: string; agent_number: string | null }[] = [];
  if (resolvedIds.length > 0) {
    const { data: reps } = await supabase
      .from("profiles")
      .select("id, full_name, agent_number, is_active")
      .in("id", resolvedIds)
      .eq("is_active", false);
    inactive = (reps ?? []) as typeof inactive;
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={formatText(batch.file_name)}
        subtitle={`Uploaded ${formatDate(batch.uploaded_at)}`}
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
          <div className="grid gap-3 sm:grid-cols-3">
            <StatCard label="Rows in the file" value={review.total} />
            <StatCard label="Ready" value={review.clean} />
            <StatCard
              label="Blocked"
              value={review.blocked}
              accent={review.blocked > 0}
            />
          </div>

          {review.unknownAgents.length > 0 && (
            <section className="flex flex-col gap-2">
              <h2 className="text-sm font-semibold tracking-tight">
                Unrecognised agent numbers
              </h2>
              <p className="text-xs text-muted-foreground">
                Each of these can be fixed here: give the number to a rep who
                already exists, or create the rep. Then choose &ldquo;Read
                again&rdquo;.
              </p>
              <ul className="flex flex-col gap-2">
                {review.unknownAgents.map((group) => (
                  <li
                    key={group.agentNumber ?? "(blank)"}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        <span className="font-mono">
                          {group.agentNumber === null
                            ? "(no agent #)"
                            : group.agentNumber}
                        </span>
                        <span className="ml-2 font-normal text-muted-foreground">
                          {group.rowCount} row
                          {group.rowCount === 1 ? "" : "s"}
                        </span>
                      </p>
                      {group.sampleMerchants.length > 0 && (
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {group.sampleMerchants.join(", ")}
                          {group.rowCount > group.sampleMerchants.length &&
                            `, +${group.rowCount - group.sampleMerchants.length} more`}
                        </p>
                      )}
                    </div>
                    {/* A blank cell cannot be assigned to anyone — there is no
                        number to give out — so that group gets no action. */}
                    {group.agentNumber !== null && (
                      <div className="flex shrink-0 items-center gap-2">
                        <Button asChild variant="outline" size="sm">
                          <Link href="/admin/users">Assign to a rep</Link>
                        </Button>
                        <Button asChild size="sm">
                          <Link
                            href={`/admin/users/new?agent_number=${encodeURIComponent(
                              group.agentNumber,
                            )}&returnTo=/payouts/import/${batch.id}`}
                          >
                            Create the rep
                          </Link>
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {review.fileProblems.length > 0 && (
            <section className="flex flex-col gap-2">
              <h2 className="text-sm font-semibold tracking-tight">
                Problems in the file
              </h2>
              <p className="text-xs text-muted-foreground">
                These cannot be fixed here. Correct the spreadsheet and upload it
                again — a re-upload merges by period, agent # and MID, so nothing
                is duplicated and any figures already entered are kept.
              </p>
              {review.fileProblems.map((problem) => (
                <div
                  key={problem.blocker}
                  className="flex flex-col gap-1 rounded-xl border bg-card px-4 py-3"
                >
                  <p className="text-sm font-medium">
                    {blockerLabel(problem.blocker)}
                    <span className="ml-2 font-normal text-muted-foreground">
                      {problem.rows.length} row
                      {problem.rows.length === 1 ? "" : "s"}
                    </span>
                  </p>
                  <ul className="flex flex-col gap-0.5">
                    {problem.rows.map((row) => (
                      <li
                        key={row.rowNumber}
                        className="text-xs text-muted-foreground"
                      >
                        {/* The spreadsheet line, because that is what an admin
                            counts when they open the file to fix it. */}
                        Row {row.rowNumber} — {row.detail}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          )}

          {inactive.length > 0 && (
            <Callout tone="warning">
              <p className="font-medium">
                {inactive.length === 1
                  ? "One resolved rep is deactivated."
                  : `${inactive.length} resolved reps are deactivated.`}
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

          {review.ready && batch.status === "review" && (
            <Callout tone="success">
              <p className="font-medium">
                All {review.total} rows resolved. This import is ready.
              </p>
              <p className="mt-1 text-muted-foreground">
                Committing merges by period, agent # and MID — so a row that is
                already in the ledger is updated rather than duplicated, and any
                residual income or split entered by hand is kept unless this file
                supplies one.
              </p>
              <div className="mt-3">
                <ResidualCommitButton
                  batchId={batch.id}
                  rowCount={review.total}
                />
              </div>
            </Callout>
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
