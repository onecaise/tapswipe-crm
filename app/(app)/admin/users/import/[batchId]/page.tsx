import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ArrowLeftIcon, KeyRoundIcon } from "lucide-react";

import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { EMPTY, formatDate, formatText } from "@/lib/format";
import {
  USER_IMPORT_BATCH_COLUMNS,
  USER_IMPORT_ROW_COLUMNS,
  batchStatusIntent,
  blockerLabel,
  outcomeIntent,
  outcomeLabel,
  reviewImportRows,
  rowLabel,
  summariseOutcomes,
  type UserImportBatch,
  type UserImportRow,
} from "@/lib/user-imports";
import { Callout } from "@/components/callout";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { StatCard } from "@/components/stat-card";
import { StatusBadge } from "@/components/status-badge";
import { UserImportBatchActions } from "@/components/user-import-batch-actions";
import { UserImportRunButton } from "@/components/user-import-run-button";
import { Button } from "@/components/ui/button";

/**
 * The review screen, and then the result screen — one page, because they are the
 * same batch at two points in its life and splitting them would mean a URL that
 * stops working once the import runs.
 *
 * It is a PAGE rather than a dialog for the reason the residual review screen
 * records: a batch outlives the session. A collision can take a day to sort out,
 * and the admin will navigate away to fix it and come back.
 *
 * Rows are presented in three groups before the run, because they are three
 * different situations with three different responses:
 *
 *   Ready        will become accounts.
 *   Skipped      already have accounts; the import passes over them.
 *   Problems     stop the import until the file is corrected.
 *
 * That middle group is the one the residual screen has no equivalent of, and it
 * is deliberate: accounts are independent of one another, so three people who
 * already exist must not stop thirty-nine who do not.
 *
 * NOTHING HERE SHOWS OR OFFERS A PASSWORD. There is no credential column, no
 * copy affordance and nothing to suppress — provision-user-batch returns no
 * password material at all. What the screen DOES have to say, loudly, is that
 * the accounts it just made cannot sign in yet.
 */
async function BatchReview({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  const { batchId: segment } = await params;
  const batchId = Number(segment);

  // Guarded before the query, the way the other detail pages guard their id.
  if (!Number.isInteger(batchId) || batchId <= 0) notFound();

  await requireAdmin();
  const supabase = await createClient();

  const { data: batchData, error: batchError } = await supabase
    .from("user_import_batches")
    .select(USER_IMPORT_BATCH_COLUMNS)
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

  const batch = batchData as UserImportBatch;

  const { data: rowData, error: rowError } = await supabase
    .from("user_import_rows")
    .select(USER_IMPORT_ROW_COLUMNS)
    .eq("batch_id", batchId)
    .order("row_number", { ascending: true });

  if (rowError) {
    return (
      <p className="text-sm text-destructive">
        Could not load the rows: {rowError.message}
      </p>
    );
  }

  const rows = (rowData ?? []) as UserImportRow[];
  const review = reviewImportRows(rows);
  const result = summariseOutcomes(rows);

  // Anything with an outcome means provisioning has started, so the screen
  // switches from "what will happen" to "what happened". Derived from the rows
  // rather than the status, because a run interrupted mid-way is still in
  // `provisioning` and must show both.
  const hasRun = rows.some((row) => row.outcome !== null);
  const isSettled = batch.status === "committed";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={formatText(batch.file_name)}
        subtitle={`Uploaded ${formatDate(batch.uploaded_at)}`}
        action={
          <UserImportBatchActions batchId={batch.id} status={batch.status} />
        }
      >
        <div className="mt-1 flex items-center gap-2">
          <StatusBadge intent={batchStatusIntent(batch.status)}>
            {batch.status}
          </StatusBadge>
        </div>
      </PageHeader>

      {rows.length === 0 ? (
        <Callout tone="warning">
          <p className="font-medium">This import has no rows.</p>
          <p className="mt-1 text-muted-foreground">
            The file could not be read, or it had a header and nothing under it.
            Try &ldquo;Read again&rdquo; — if it was the wrong file, abandon this
            import and upload the right one.
          </p>
        </Callout>
      ) : (
        <>
          {hasRun ? (
            <div className="grid gap-3 sm:grid-cols-4">
              <StatCard label="Created" value={result.created} />
              <StatCard label="Skipped" value={result.skipped} />
              <StatCard
                label="Failed"
                value={result.failed}
                accent={result.failed > 0}
              />
              <StatCard
                label={isSettled ? "Finished" : "Left to do"}
                value={
                  isSettled
                    ? batch.committed_at === null
                      ? EMPTY
                      : formatDate(batch.committed_at)
                    : result.pending
                }
              />
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-4">
              <StatCard label="Rows in the file" value={review.total} />
              <StatCard label="Will be created" value={review.ready} />
              <StatCard label="Will be skipped" value={review.willSkip} />
              <StatCard
                label="Blocked"
                value={review.blocked}
                accent={review.blocked > 0}
              />
            </div>
          )}

          {/* ---------------- THE POINT OF THE WHOLE SCREEN ----------------
              Accounts exist and nobody can use them yet. Said at the top of the
              result, in the success tone rather than a warning, because nothing
              is wrong — this is simply the next step, and an admin who does not
              read it will conclude the import is broken. */}
          {hasRun && result.created + result.resumed > 0 && (
            <Callout tone="success">
              <p className="font-medium">
                {result.created + result.resumed} account
                {result.created + result.resumed === 1 ? "" : "s"} created — and
                nobody can sign in yet.
              </p>
              <p className="mt-1 text-muted-foreground">
                No passwords were issued by this import, deliberately: a list of
                credentials is not something to hand out in bulk. Each rep gets
                one when you actually onboard them — open Manage Users, find
                them, and choose <strong>Reset password</strong>. That shows the
                password once, for you to pass on directly.
              </p>
              <div className="mt-3">
                <Button asChild size="sm">
                  <Link href="/admin/users">
                    <KeyRoundIcon size={16} />
                    Go to Manage Users
                  </Link>
                </Button>
              </div>
            </Callout>
          )}

          {/* Orphans, never buried in a progress bar. An auth user with no
              profile can log in, lands on /auth/error?error=no-profile, and
              cannot self-heal — so it has to be visible and it has to say what
              fixes it. */}
          {result.orphans.length > 0 && (
            <Callout tone="warning">
              <p className="font-medium">
                {result.orphans.length} sign-in
                {result.orphans.length === 1 ? " was" : "s were"} left without a
                profile
              </p>
              <p className="mt-1 text-muted-foreground">
                An earlier attempt got half-way through creating these and
                stopped. They can log in but would land on an error page, and
                they cannot fix themselves. Running the import again finishes
                them — it adopts the half-made account rather than refusing the
                address.
              </p>
              <ul className="mt-2 flex flex-col gap-0.5">
                {result.orphans.map((row) => (
                  <li key={row.id} className="text-xs">
                    Row {row.row_number} — {rowLabel(row)}
                  </li>
                ))}
              </ul>
            </Callout>
          )}

          {/* ---------------- BEFORE THE RUN ---------------- */}
          {!hasRun && review.skipped.length > 0 && (
            <section className="flex flex-col gap-2">
              <h2 className="text-sm font-semibold tracking-tight">
                Already have accounts
              </h2>
              <p className="text-xs text-muted-foreground">
                These rows will be passed over and the rest of the file will
                still import. If one of them is a different person who happens to
                share an address, that is a problem in the file rather than here.
              </p>
              <div className="flex flex-col gap-1 rounded-xl border bg-card px-4 py-3">
                {review.skipped.map((row) => (
                  <p key={row.rowNumber} className="text-xs text-muted-foreground">
                    Row {row.rowNumber} — {row.detail}
                  </p>
                ))}
              </div>
            </section>
          )}

          {!hasRun && review.fileProblems.length > 0 && (
            <section className="flex flex-col gap-2">
              <h2 className="text-sm font-semibold tracking-tight">
                Problems in the file
              </h2>
              <p className="text-xs text-muted-foreground">
                These cannot be fixed here, and nothing will be created until
                they are gone. Correct the spreadsheet and upload it again, or
                use &ldquo;Read again&rdquo; if you fixed something outside the
                file.
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
                        {/* The file's own line, because that is what an admin
                            counts when they open it to fix it. */}
                        Row {row.rowNumber} — {row.detail}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          )}

          {!hasRun && review.canProvision && (
            <Callout tone="success">
              <p className="font-medium">
                {review.ready === 0
                  ? "Every row already has an account."
                  : `Ready to create ${review.ready} account${review.ready === 1 ? "" : "s"}.`}
              </p>
              <p className="mt-1 text-muted-foreground">
                {review.willSkip > 0 &&
                  `${review.willSkip} row${review.willSkip === 1 ? "" : "s"} will be passed over. `}
                Accounts are created without a usable password — you issue one
                per rep from Manage Users when you onboard them.
              </p>
              <div className="mt-3">
                <UserImportRunButton
                  batchId={batch.id}
                  readyCount={review.ready}
                  skipCount={review.willSkip}
                />
              </div>
            </Callout>
          )}

          {/* ---------------- MID-RUN ---------------- */}
          {hasRun && !isSettled && result.pending > 0 && (
            <Callout tone="warning">
              <p className="font-medium">
                This import stopped part-way, with {result.pending} row
                {result.pending === 1 ? "" : "s"} still to do.
              </p>
              <p className="mt-1 text-muted-foreground">
                Nothing was lost. Every row that finished is recorded above, and
                carrying on picks up exactly where it stopped.
              </p>
              <div className="mt-3">
                <UserImportRunButton
                  batchId={batch.id}
                  readyCount={result.pending}
                  skipCount={0}
                  resuming
                />
              </div>
            </Callout>
          )}

          {/* ---------------- FAILURES ---------------- */}
          {hasRun && result.failures.length > 0 && (
            <section className="flex flex-col gap-2">
              <h2 className="text-sm font-semibold tracking-tight">
                Rows that failed
              </h2>
              <p className="text-xs text-muted-foreground">
                Each one carries the reason the server gave. Trying again is
                safe: a row that got half-way is finished rather than
                duplicated.
              </p>
              <div className="flex flex-col gap-1 rounded-xl border bg-card px-4 py-3">
                {result.failures.map((row) => (
                  <p key={row.id} className="text-xs text-muted-foreground">
                    Row {row.row_number} — {rowLabel(row)}:{" "}
                    {formatText(row.outcome_detail)}
                  </p>
                ))}
              </div>
              <div>
                <UserImportRunButton
                  batchId={batch.id}
                  readyCount={0}
                  skipCount={0}
                  failedCount={result.failures.length}
                />
              </div>
            </section>
          )}

          {/* ---------------- THE ROWS ---------------- */}
          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold tracking-tight">
              {hasRun ? "What happened to each row" : "Everyone in the file"}
            </h2>
            <div className="overflow-x-auto rounded-xl border bg-card">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2 text-left font-medium">Row</th>
                    <th className="px-4 py-2 text-left font-medium">Name</th>
                    <th className="px-4 py-2 text-left font-medium">Email</th>
                    <th className="px-4 py-2 text-left font-medium">Role</th>
                    <th className="px-4 py-2 text-left font-medium">Agent #</th>
                    <th className="px-4 py-2 text-left font-medium">
                      {hasRun ? "Outcome" : "Status"}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className="border-b last:border-0">
                      <td className="px-4 py-2 text-muted-foreground">
                        {row.row_number}
                      </td>
                      <td className="px-4 py-2">
                        {formatText(row.full_name ?? row.full_name_raw)}
                      </td>
                      <td className="px-4 py-2">
                        {formatText(row.email ?? row.email_raw)}
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {formatText(row.role ?? row.role_raw)}
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {formatText(row.agent_number ?? row.agent_number_raw)}
                      </td>
                      <td className="px-4 py-2">
                        {row.outcome !== null ? (
                          <StatusBadge intent={outcomeIntent(row.outcome)}>
                            {outcomeLabel(row.outcome)}
                          </StatusBadge>
                        ) : row.blocker !== null ? (
                          <StatusBadge intent="warning">
                            {blockerLabel(row.blocker)}
                          </StatusBadge>
                        ) : (
                          <StatusBadge intent="neutral">Ready</StatusBadge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

export default function UserImportBatchPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  // params passed down unawaited, so the dynamic read stays inside the Suspense
  // boundary that cacheComponents requires.
  return (
    <PageShell width="detail">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href="/admin/users/import">
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
