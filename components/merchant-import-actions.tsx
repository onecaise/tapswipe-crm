"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CheckIcon, RefreshCwIcon, XIcon } from "lucide-react";

import { callAdminFunction } from "@/lib/admin-users";
import { createClient } from "@/lib/supabase/client";
import { ConfirmPair } from "@/components/confirm-pair";
import { Button } from "@/components/ui/button";

/**
 * Read again and Abandon, for a merchant import still in review.
 *
 * Read again re-stages the stored file (stage-merchant-import is idempotent),
 * so "set that rep's LLC legal name, then Read again" needs no re-upload.
 * Abandon is an UPDATE of the status, the one client write the table allows.
 */
export function MerchantImportActions({ batchId }: { batchId: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | "read" | "abandon">(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reread = async () => {
    setBusy("read");
    setError(null);
    const { error: callError } = await callAdminFunction("stage-merchant-import", {
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
    const { error: updateError, count } = await createClient()
      .from("merchant_import_batches")
      .update({ status: "abandoned" }, { count: "exact" })
      .eq("id", batchId);
    // RLS filters rather than errors, so zero rows is a refusal too.
    if (updateError) setError(updateError.message);
    else if (count === 0) setError("That import could not be abandoned. Reload the page.");
    setBusy(null);
    if (!updateError && count !== 0) router.refresh();
  };

  return (
    <div className="flex flex-col items-start gap-1.5 sm:items-end">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => void reread()}>
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
          <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => setConfirming(true)}>
            <XIcon size={14} />
            Abandon
          </Button>
        )}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

/**
 * Calls commit_merchant_import(), which re-derives every check and creates all
 * the merchants or none. Disabled while the page shows any refusal; the
 * database refuses on its own anyway, and its sentence is shown as it is.
 */
export function MerchantImportCommitButton({
  batchId,
  merchantCount,
  disabled,
}: {
  batchId: number;
  merchantCount: number;
  disabled: boolean;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const commit = async () => {
    setBusy(true);
    setError(null);
    const { error: rpcError } = await createClient().rpc("commit_merchant_import", {
      batch_id_input: batchId,
    });
    setConfirming(false);
    if (rpcError) {
      setBusy(false);
      setError(rpcError.message);
      return;
    }
    // Busy stays on: the refreshed page replaces this button.
    router.refresh();
  };

  return (
    <div className="flex flex-col items-start gap-1">
      {confirming ? (
        <ConfirmPair
          label={`Create ${merchantCount} merchant${merchantCount === 1 ? "" : "s"}?`}
          confirmLabel="Commit import"
          onConfirm={() => void commit()}
          onCancel={() => setConfirming(false)}
          busy={busy}
        />
      ) : (
        <Button type="button" size="sm" disabled={disabled || busy} onClick={() => setConfirming(true)}>
          <CheckIcon size={16} />
          Commit import
        </Button>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
