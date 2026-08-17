"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { DownloadIcon, RefreshCwIcon } from "lucide-react";

import { callAdminFunction } from "@/lib/admin-users";
import { createClient } from "@/lib/supabase/client";
import { ConfirmPair } from "@/components/confirm-pair";
import { Button } from "@/components/ui/button";

/**
 * Re-parse, download the original, and abandon — the three things that can be
 * done to a batch that is still under review.
 *
 * Re-parse is the mechanism behind resolving an unrecognised agent number: the
 * parse function is idempotent (it clears the batch's staging rows first), so
 * "create the rep, then parse again" is one code path rather than a second
 * resolution route to keep in step with the first.
 *
 * Abandon is an UPDATE, not a delete. rep_payout_batches has no delete policy and
 * no delete grant — a batch is the record that an import was attempted, and the
 * uploaded file stays downloadable behind it.
 */
export function ResidualBatchActions({
  batchId,
  status,
}: {
  batchId: number;
  status: string;
}) {
  const router = useRouter();

  const [busy, setBusy] = useState<null | "parse" | "download" | "abandon">(
    null,
  );
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reparse = async () => {
    setBusy("parse");
    setError(null);

    const { error: callError } = await callAdminFunction(
      "parse-residual-import",
      { batch_id: batchId },
    );

    if (callError) setError(callError);
    setBusy(null);
    if (!callError) router.refresh();
  };

  const download = async () => {
    setBusy("download");
    setError(null);

    const { data, error: callError } = await callAdminFunction<{
      signedUrl: string;
    }>("residual-import-file-url", { batch_id: batchId });

    if (callError || !data) {
      setError(callError ?? "Could not get a download link.");
      setBusy(null);
      return;
    }

    // Opened rather than fetched: the signed URL is short-lived and the browser
    // should do the download, exactly as download-document-button does.
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
    setBusy(null);
  };

  const abandon = async () => {
    setBusy("abandon");
    setError(null);
    setConfirming(false);

    const supabase = createClient();
    const { error: updateError, count } = await supabase
      .from("rep_payout_batches")
      .update({ status: "abandoned" }, { count: "exact" })
      .eq("id", batchId);

    // RLS filters rather than errors, so a write the policy hides reports success
    // having changed nothing. Without the count check a rep who reached this
    // control would be told the batch was abandoned.
    if (updateError) {
      setError(updateError.message);
    } else if (count === 0) {
      setError("That batch could not be abandoned. Reload the page.");
    }

    setBusy(null);
    if (!updateError && count !== 0) router.refresh();
  };

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy !== null}
          onClick={() => void download()}
        >
          <DownloadIcon size={14} />
          {busy === "download" ? "Linking…" : "Original file"}
        </Button>

        {status === "review" && (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() => void reparse()}
            >
              <RefreshCwIcon size={14} />
              {busy === "parse" ? "Reading…" : "Read again"}
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
                variant="destructive"
                size="sm"
                disabled={busy !== null}
                onClick={() => setConfirming(true)}
              >
                Abandon
              </Button>
            )}
          </>
        )}
      </div>

      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
