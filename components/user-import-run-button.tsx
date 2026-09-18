"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { PlayIcon, RotateCcwIcon } from "lucide-react";

import { callAdminFunction } from "@/lib/admin-users";
import { Callout } from "@/components/callout";
import { ConfirmPair } from "@/components/confirm-pair";
import { Button } from "@/components/ui/button";

type ChunkResult = {
  batch_id: number;
  processed: number;
  remaining: number;
  committed: boolean;
  created: number;
  resumed: number;
  skipped: number;
  failed: number;
};

type Progress = {
  created: number;
  resumed: number;
  skipped: number;
  failed: number;
  remaining: number;
};

/**
 * Runs the import, a chunk per call, until nothing is left.
 *
 * THE LOOP IS HERE, IN THE BROWSER, AND THAT IS THE DESIGN. Account creation is
 * a GoTrue write plus a Postgres write per rep, with no transaction spanning
 * them, so two hundred reps is four hundred operations that cannot all fit in
 * one Edge Function invocation's wall clock. provision-user-batch does a bounded
 * few and reports what is left; this asks again until the answer is zero.
 *
 * Every row's outcome is durable before the next row starts, server-side. So
 * closing this tab mid-run loses nothing: the batch sits in `provisioning`, and
 * pressing the button again picks up exactly where it stopped. That is worth
 * knowing while reading this, because it is why the loop needs no persistence,
 * no cancellation token and no cleanup — the browser is a scheduler here, not a
 * source of truth.
 *
 * A failed call stops the loop rather than retrying. The rows already done keep
 * their outcomes, and the admin can see the error and press again.
 *
 * NOTHING ABOUT A PASSWORD APPEARS HERE, and there is nothing to suppress: the
 * function's response carries no credential at all, which
 * tests/live/user-provision.test.ts asserts against the response body. Accounts
 * are created unable to sign in until an admin issues a password per rep from
 * Manage Users.
 */
export function UserImportRunButton({
  batchId,
  readyCount,
  skipCount,
  failedCount = 0,
  resuming = false,
}: {
  batchId: number;
  readyCount: number;
  skipCount: number;
  failedCount?: number;
  resuming?: boolean;
}) {
  const router = useRouter();

  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (retryFailed: boolean) => {
    setConfirming(false);
    setRunning(true);
    setError(null);

    const totals: Progress = {
      created: 0,
      resumed: 0,
      skipped: 0,
      failed: 0,
      remaining: readyCount,
    };
    setProgress({ ...totals });

    // Bounded rather than `while (true)`. The server decides the chunk size, so
    // the worst case is one call per row plus one — a cap well above that means
    // a bug cannot spin here forever.
    const maxCalls = readyCount + skipCount + failedCount + 10;

    for (let call = 0; call < maxCalls; call += 1) {
      const body: Record<string, unknown> = { batch_id: batchId };
      // Only on the first call: after that the failed rows have been cleared and
      // asking again would reset the ones that failed during THIS run.
      if (retryFailed && call === 0) body.retry_failed = true;

      const { data, error: callError } = await callAdminFunction<ChunkResult>(
        "provision-user-batch",
        body,
      );

      if (callError || !data) {
        setError(
          (callError ?? "The import stopped.") +
            " Nothing before this point was lost — press Run again to carry on.",
        );
        setRunning(false);
        router.refresh();
        return;
      }

      totals.created += data.created;
      totals.resumed += data.resumed;
      totals.skipped += data.skipped;
      totals.failed += data.failed;
      totals.remaining = data.remaining;
      setProgress({ ...totals });

      if (data.remaining === 0) break;
    }

    setRunning(false);
    // So the page re-renders from the staging rows, which are the authority on
    // what happened. The counts above are a progress indicator, not the record.
    router.refresh();
  };

  if (running && progress) {
    const done = progress.created + progress.resumed + progress.skipped +
      progress.failed;
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">
          Creating accounts… {done} of {done + progress.remaining}
        </p>
        <p className="text-xs text-muted-foreground">
          {progress.created} created
          {progress.resumed > 0 && `, ${progress.resumed} resumed`}
          {progress.skipped > 0 && `, ${progress.skipped} skipped`}
          {progress.failed > 0 && `, ${progress.failed} failed`}. Leaving this
          page is safe — the import carries on from where it stopped when you
          come back.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        {confirming ? (
          <ConfirmPair
            label={
              failedCount > 0
                ? `Try ${failedCount} failed row${failedCount === 1 ? "" : "s"} again?`
                : `Create ${readyCount} account${readyCount === 1 ? "" : "s"}?`
            }
            confirmLabel={failedCount > 0 ? "Try again" : "Create accounts"}
            onConfirm={() => void run(failedCount > 0)}
            onCancel={() => setConfirming(false)}
            busy={running}
          />
        ) : (
          <Button
            type="button"
            size="sm"
            variant={failedCount > 0 ? "outline" : "default"}
            onClick={() => setConfirming(true)}
          >
            {failedCount > 0 ? <RotateCcwIcon size={16} /> : <PlayIcon size={16} />}
            {failedCount > 0
              ? "Try the failed rows again"
              : resuming
                ? "Carry on with the import"
                : "Create the accounts"}
          </Button>
        )}
      </div>

      {error && <Callout tone="warning">{error}</Callout>}
    </div>
  );
}
