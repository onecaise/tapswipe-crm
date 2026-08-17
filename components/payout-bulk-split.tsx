"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { createClient } from "@/lib/supabase/client";
import { parseFigureInput } from "@/lib/payouts";
import { ConfirmPair } from "@/components/confirm-pair";
import { Button } from "@/components/ui/button";

/**
 * Sets one rep's split across a whole period in a single action.
 *
 * The common case by a distance: a rep's split is usually the same percentage on
 * every merchant, and typing it into forty cells is how a wrong one gets missed.
 *
 * **It overwrites values that are already set, and the confirmation says so.** A
 * fill-the-blanks-only version was the alternative and is worse: after a
 * re-import an admin correcting one rep's rate would find some rows changed and
 * some not, with nothing on screen explaining which. A single stated behaviour is
 * easier to trust than a conditional one.
 *
 * Behind ConfirmPair because it rewrites commission figures in bulk, and each one
 * it touches writes a history row. Non-destructive red: it commits something
 * rather than removing it, which is the distinction ConfirmPair's `destructive`
 * flag encodes.
 */
export function PayoutBulkSplit({
  period,
  agentId,
  repName,
  rowCount,
}: {
  period: string;
  agentId: string;
  repName: string;
  rowCount: number;
}) {
  const router = useRouter();

  const [text, setText] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = async () => {
    const parsed = parseFigureInput(text, "rep_split_pct");
    if (!parsed.ok) {
      setError(parsed.message);
      setConfirming(false);
      return;
    }
    if (parsed.value === null) {
      // Clearing every split at once is not an action anyone means to take, and
      // an empty box submitted by accident is the likeliest way to reach it.
      setError("Enter a split to apply.");
      setConfirming(false);
      return;
    }

    setBusy(true);
    setError(null);

    const supabase = createClient();
    const { error: updateError, count } = await supabase
      .from("rep_payout_rows")
      .update({ rep_split_pct: parsed.value }, { count: "exact" })
      // Scoped to one rep and one period. Both are required: without agent_id it
      // would rewrite every rep's split for the month.
      .eq("period", period)
      .eq("agent_id", agentId);

    setBusy(false);
    setConfirming(false);

    if (updateError) {
      setError(updateError.message);
      return;
    }
    // RLS filters rather than errors, so zero rows means the policy hid them, not
    // that there was nothing to do.
    if (count === 0) {
      setError("No rows could be updated. Reload the page.");
      return;
    }

    setText("");
    router.refresh();
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <label className="text-xs text-muted-foreground">
          <span className="sr-only">{`Split to apply to all of ${repName}'s rows`}</span>
          Set split for all {rowCount} row{rowCount === 1 ? "" : "s"}
        </label>
        <input
          aria-label={`Split percentage for all of ${repName}'s rows this period`}
          value={text}
          inputMode="decimal"
          disabled={busy}
          placeholder="%"
          onChange={(event) => {
            setText(event.target.value);
            setError(null);
          }}
          className="h-7 w-16 rounded-lg border border-input bg-card px-2 text-sm tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        {confirming ? (
          <ConfirmPair
            label={`Set every one of ${repName}'s ${rowCount} rows to ${text.trim()}%, replacing any already entered?`}
            confirmLabel="Set split"
            onConfirm={() => void apply()}
            onCancel={() => setConfirming(false)}
            busy={busy}
          />
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7"
            disabled={busy || text.trim() === ""}
            onClick={() => setConfirming(true)}
          >
            Apply
          </Button>
        )}
      </div>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
