"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CheckIcon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";

/**
 * "I've reviewed these N skipped rows" — the only way the skipped-rows Callout
 * goes away (docs/design/residual-splits.md §5.4).
 *
 * One click, no confirm step: it removes nothing. The skip record stays on the
 * batch and the page keeps a muted line naming who reviewed it, so the
 * acknowledgement is a statement an admin can be held to, not a dismissal.
 *
 * Nothing here is a boundary. acknowledge_residual_skips() re-checks is_admin(),
 * refuses a second acknowledgement and a batch with nothing skipped, and every
 * message it raises is written to be read, so they are shown verbatim.
 */
export function AcknowledgeSkipsButton({
  batchId,
  count,
}: {
  batchId: number;
  count: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const acknowledge = async () => {
    setBusy(true);
    setError(null);

    const supabase = createClient();
    const { error: rpcError } = await supabase.rpc(
      "acknowledge_residual_skips",
      { batch_id_input: batchId },
    );

    if (rpcError) {
      setBusy(false);
      setError(rpcError.message);
      return;
    }

    // Busy stays on until the refreshed render replaces this button, so a
    // second click cannot reach the RPC (it would be refused anyway).
    router.refresh();
  };

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => void acknowledge()}
      >
        <CheckIcon size={16} />
        {count === 1
          ? "I've reviewed this skipped row"
          : `I've reviewed these ${count} skipped rows`}
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
