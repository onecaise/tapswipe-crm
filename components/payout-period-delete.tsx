"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Trash2Icon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { formatPeriod } from "@/lib/format";
import { ConfirmPair } from "@/components/confirm-pair";
import { Button } from "@/components/ui/button";

/**
 * Deletes a whole period's ledger rows — the escape hatch for an import that was
 * simply wrong.
 *
 * Individual rows are deliberately not deletable from the UI: a wrong merchant line
 * is a correction, made by editing, which the history table then records. A whole
 * period is different, because a bad import is bad in one piece.
 *
 * **The confirmation names how many rows carry hand-entered figures**, because that
 * is the part that cannot be re-imported — the processor's columns come back with
 * the next upload, but a month of typed-in residuals does not. The count is what
 * makes the cost of the click visible before it happens rather than after.
 *
 * The rep_payout_row_history rows survive this, which is why row_id carries no
 * foreign key. So the record that someone entered a figure outlives the figure.
 */
export function PayoutPeriodDelete({
  period,
  rowCount,
  filledCount,
}: {
  period: string;
  rowCount: number;
  /** Rows with a residual income or split entered by hand. */
  filledCount: number;
}) {
  const router = useRouter();

  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    setBusy(true);
    setError(null);

    const supabase = createClient();
    const { error: deleteError, count } = await supabase
      .from("rep_payout_rows")
      .delete({ count: "exact" })
      .eq("period", period);

    setBusy(false);
    setConfirming(false);

    if (deleteError) {
      setError(deleteError.message);
      return;
    }
    if (count === 0) {
      setError("Nothing was deleted. Reload the page.");
      return;
    }

    // The period no longer exists, so its page would 404. Back to the list, which
    // is where the admin now needs to be.
    router.push("/payouts");
  };

  return (
    <div className="flex flex-col items-end gap-1">
      {confirming ? (
        <ConfirmPair
          label={
            filledCount === 0
              ? `Delete all ${rowCount} rows for ${formatPeriod(period)}? This cannot be undone.`
              : `Delete all ${rowCount} rows for ${formatPeriod(period)}? ${filledCount} of them have figures entered by hand, which a re-import will not bring back.`
          }
          confirmLabel={`Delete ${rowCount} rows`}
          onConfirm={() => void remove()}
          onCancel={() => setConfirming(false)}
          busy={busy}
          destructive
        />
      ) : (
        <Button
          type="button"
          variant="destructive"
          size="sm"
          disabled={busy}
          onClick={() => setConfirming(true)}
        >
          <Trash2Icon size={14} />
          Delete period
        </Button>
      )}
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
