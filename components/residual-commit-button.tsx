"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CheckIcon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { ConfirmPair } from "@/components/confirm-pair";
import { Button } from "@/components/ui/button";

/**
 * Commits a reviewed batch into the ledger.
 *
 * Calls commit_residual_import_v2, the shared-account-aware commit (phase 4b of
 * docs/design/residual-splits.md). It returns {written, skipped}; the old
 * commit_residual_import is kept only for an app version still deployed
 * somewhere and refuses any batch a share covers.
 *
 * Goes through an RPC rather than an Edge Function, and the
 * reasons are in the migration: atomicity (one transaction, so a period is never
 * half-imported), no PostgREST row cap to page around, an audit row that fails
 * closed for free, and auth.uid() surviving `security definer` so the history rows
 * the merge triggers are attributed to whoever committed.
 *
 * Nothing here is a boundary. The RPC re-checks is_admin() itself and refuses a
 * batch that is not `review`, has no rows, or still has blockers — every message it
 * raises is written to be read by a person, so they are shown verbatim.
 */
export function ResidualCommitButton({
  batchId,
  rowCount,
}: {
  batchId: number;
  rowCount: number;
}) {
  const router = useRouter();

  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const commit = async () => {
    setBusy(true);
    setError(null);

    const supabase = createClient();
    const { error: rpcError } = await supabase.rpc(
      "commit_residual_import_v2",
      { batch_id_input: batchId },
    );

    setConfirming(false);

    if (rpcError) {
      setBusy(false);
      setError(rpcError.message);
      return;
    }

    // Busy stays on: the batch is committed now, and the button must not offer
    // itself again in the moment before the refreshed page replaces it.
    //
    // To the commit result: this batch's own page, which for a committed batch
    // reports rows written and rows skipped, with any skipped rows in a Callout
    // at the top until an admin reviews them. The figures are read back from
    // the batch rather than carried in the URL -- written is row_count less the
    // skip record v2 stored -- so they are the same after a reload, and a
    // skipped row cannot be lost by navigating away from a toast.
    router.push(`/payouts/import/${batchId}`);
    router.refresh();
  };

  return (
    <div className="flex flex-col items-start gap-1">
      {confirming ? (
        <ConfirmPair
          label={`Add ${rowCount} row${rowCount === 1 ? "" : "s"} to the ledger?`}
          confirmLabel="Commit import"
          onConfirm={() => void commit()}
          onCancel={() => setConfirming(false)}
          busy={busy}
        />
      ) : (
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={() => setConfirming(true)}
        >
          <CheckIcon size={16} />
          Commit {rowCount} row{rowCount === 1 ? "" : "s"}
        </Button>
      )}
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
