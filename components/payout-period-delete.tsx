"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Trash2Icon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { formatPeriod } from "@/lib/format";
import { ConfirmPair } from "@/components/confirm-pair";
import { Button } from "@/components/ui/button";

/**
 * Deletes one processor's lines for a month -- the escape hatch for an import
 * filed under the wrong month or processor. A wrong FIGURE is not this: until
 * the month is paid it is a replace (upload the corrected file), and after it
 * an adjustment.
 *
 * Through delete_payout_period() (20261030190000), never a client DELETE: the
 * ledger has no DELETE grant or policy any more. The function re-checks
 * is_admin(), refuses a month marked paid or one an adjustment corrects,
 * deletes only that processor's import lines (adjustment lines stay), frees
 * the processor-month for a new file, and writes one audit row -- which the
 * old browser delete never did, though the docs said it did. Its messages are
 * written for people and shown as they are.
 *
 * `processor` null is the lines committed before processors were recorded.
 */
export function PayoutPeriodDelete({
  period,
  processor,
  rowCount,
}: {
  period: string;
  processor: string | null;
  /** Import lines of that processor in the month. */
  rowCount: number;
}) {
  const router = useRouter();

  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const what = processor === null ? "lines with no processor" : `${processor} lines`;

  const remove = async () => {
    setBusy(true);
    setError(null);

    const supabase = createClient();
    const { error: rpcError } = await supabase.rpc("delete_payout_period", {
      period_input: period,
      processor_input: processor,
    });

    setBusy(false);
    setConfirming(false);

    if (rpcError) {
      setError(rpcError.message);
      return;
    }

    // The month may be empty now, and its page would 404. Back to the list,
    // which is where the admin now needs to be.
    router.push("/payouts");
    router.refresh();
  };

  return (
    <div className="flex flex-col items-end gap-1">
      {confirming ? (
        <ConfirmPair
          label={`Delete all ${rowCount} ${what} for ${formatPeriod(period)}? Adjustment lines stay. This cannot be undone.`}
          confirmLabel={`Delete ${rowCount} line${rowCount === 1 ? "" : "s"}`}
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
          {processor === null ? "Delete period" : `Delete ${processor}`}
        </Button>
      )}
      {error && <span className="max-w-xs text-right text-xs text-destructive">{error}</span>}
    </div>
  );
}
