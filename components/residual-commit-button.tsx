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
 * Goes through the commit_residual_import RPC rather than an Edge Function, and the
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
    const { data, error: rpcError } = await supabase.rpc(
      "commit_residual_import",
      { batch_id_input: batchId },
    );

    setBusy(false);
    setConfirming(false);

    if (rpcError) {
      setError(rpcError.message);
      return;
    }

    // Straight to the period the rows landed in, which is where the figures now
    // need entering. The RPC returns how many rows it wrote; the period comes from
    // the rows themselves, so the list page is the safe destination when a batch
    // spanned more than one month.
    router.push(`/payouts?imported=${String(data ?? rowCount)}`);
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
