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
 * Calls commit_residual_import_v3 (phase 8 of docs/design/intake-and-reports.md)
 * with the warning types the admin said yes to. v3 recomputes every warning
 * from the data at that moment and refuses any type not in `confirmed`, so the
 * yes is enforced in the database, not here. It also re-resolves each MID's
 * owner and refuses if one changed since the file was read.
 *
 * Goes through an RPC rather than an Edge Function, and the
 * reasons are in the migration: atomicity (one transaction, so a month is never
 * half-imported), no PostgREST row cap to page around, an audit row that fails
 * closed for free, and auth.uid() surviving `security definer` so the audit row
 * names whoever committed.
 *
 * Nothing here is a boundary. The RPC re-checks is_admin() itself, and every
 * message it raises is written to be read by a person, so they are shown
 * verbatim.
 */
export function ResidualCommitButton({
  batchId,
  rowCount,
  confirmed,
}: {
  batchId: number;
  rowCount: number;
  /** The warning types answered yes on the review screen. */
  confirmed: string[];
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
      "commit_residual_import_v3",
      { batch_id_input: batchId, confirmed_input: confirmed },
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
    // reports the rows imported, read back from the batch so a reload agrees.
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
