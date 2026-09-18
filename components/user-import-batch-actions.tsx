"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { RefreshCwIcon, XIcon } from "lucide-react";

import { callAdminFunction } from "@/lib/admin-users";
import { createClient } from "@/lib/supabase/client";
import { ConfirmPair } from "@/components/confirm-pair";
import { Button } from "@/components/ui/button";

/**
 * Read again, and abandon — the two things that can be done to an import that
 * has not run yet.
 *
 * Read again is the mechanism behind resolving a collision: stage-user-import is
 * idempotent (it clears the batch's staging rows first), so "give that rep an
 * agent number, then read again" is one code path rather than a second
 * resolution route to keep in step with the first. It re-runs the lookups
 * against a database that has changed since.
 *
 * There is deliberately no "download the original" button, unlike the residual
 * version. That file lives in Storage and is worth fetching; this one is text on
 * the batch row, and the review screen already shows every cell it contained.
 *
 * Abandon is an UPDATE, not a delete. user_import_batches has no delete policy
 * and no delete grant — a batch is the record that an import was attempted, and
 * its rows are the record of what each one did.
 */
export function UserImportBatchActions({
  batchId,
  status,
}: {
  batchId: number;
  status: string;
}) {
  const router = useRouter();

  const [busy, setBusy] = useState<null | "read" | "abandon">(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reread = async () => {
    setBusy("read");
    setError(null);

    const { error: callError } = await callAdminFunction("stage-user-import", {
      batch_id: batchId,
    });

    if (callError) setError(callError);
    setBusy(null);
    if (!callError) router.refresh();
  };

  const abandon = async () => {
    setBusy("abandon");
    setError(null);
    setConfirming(false);

    const supabase = createClient();
    const { error: updateError, count } = await supabase
      .from("user_import_batches")
      .update({ status: "abandoned" }, { count: "exact" })
      .eq("id", batchId);

    // RLS filters rather than errors, so a write the policy hides reports
    // success having changed nothing. Without the count check a rep who somehow
    // reached this control would be told the import was abandoned.
    if (updateError) {
      setError(updateError.message);
    } else if (count === 0) {
      setError("That import could not be abandoned. Reload the page.");
    }

    setBusy(null);
    if (!updateError && count !== 0) router.refresh();
  };

  // Nothing to offer once it is settled. A committed import's rows are the
  // record of what happened, and re-reading would rebuild them.
  if (status !== "review" && status !== "provisioning") return null;

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy !== null}
          onClick={() => void reread()}
        >
          <RefreshCwIcon size={14} />
          {busy === "read" ? "Reading…" : "Read again"}
        </Button>

        {confirming ? (
          <ConfirmPair
            label="Abandon this import?"
            confirmLabel="Abandon"
            onConfirm={() => void abandon()}
            onCancel={() => setConfirming(false)}
            busy={busy === "abandon"}
            destructive
          />
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={() => setConfirming(true)}
          >
            <XIcon size={14} />
            Abandon
          </Button>
        )}
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
