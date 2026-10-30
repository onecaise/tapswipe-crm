"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { PencilIcon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * One merchant's split rate (memo §0b.4, §1.C), set in place on the merchant
 * page. Rendered for admins only; nothing here is a security boundary.
 *
 * The SplitRateCell shape. Writes through set_merchant_split(), the only write
 * path to merchants.split_agent_pct / split_company_pct (20261030160000): a
 * trigger refuses any other change to them, an admin's included. The RPC
 * re-checks is_admin(), refuses anything outside 0-50 or with more than two
 * decimals, and refuses while the merchant has a live shared-account split;
 * its messages are written to be shown as they are.
 *
 * The rate is what the next committed residual for this MID pays the rep.
 * Months already committed keep the rate they were committed at.
 */
export function MerchantSplitCell({
  merchantId,
  dba,
  rate,
}: {
  merchantId: number;
  dba: string;
  /** NULL: a merchant created by hand, with no rate yet. */
  rate: number | null;
}) {
  const router = useRouter();

  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(rate === null ? "" : String(rate));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shown =
    rate === null ? "Not set" : `${Number(Number(rate).toFixed(2))}%`;

  const cancel = () => {
    setEditing(false);
    setError(null);
  };

  const save = async () => {
    const trimmed = value.trim();
    const parsed = Number(trimmed);
    if (trimmed === "" || Number.isNaN(parsed)) {
      setError("Enter a number from 0 to 50.");
      return;
    }

    setBusy(true);
    setError(null);

    const supabase = createClient();
    const { error: rpcError } = await supabase.rpc("set_merchant_split", {
      merchant_id_input: merchantId,
      rate_input: parsed,
    });

    if (rpcError) {
      setError(rpcError.message);
      setBusy(false);
      return;
    }

    setBusy(false);
    setEditing(false);
    router.refresh();
  };

  if (!editing) {
    return (
      <span className="flex items-center gap-1.5">
        <span className="text-sm">{shown}</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-1.5"
          aria-label={`Change split rate for ${dba}`}
          onClick={() => {
            setValue(rate === null ? "" : String(Number(Number(rate).toFixed(2))));
            setError(null);
            setEditing(true);
          }}
        >
          <PencilIcon size={12} />
        </Button>
      </span>
    );
  }

  return (
    <span className="flex flex-col gap-1">
      <span className="flex items-center gap-1.5">
        <Input
          aria-label={`Split rate for ${dba}`}
          inputMode="decimal"
          value={value}
          disabled={busy}
          autoFocus
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void save();
            }
            if (event.key === "Escape") cancel();
          }}
          className="h-7 w-20 text-xs"
        />
        <Button
          type="button"
          size="sm"
          className="h-7"
          disabled={busy}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7"
          disabled={busy}
          onClick={cancel}
        >
          Cancel
        </Button>
      </span>
      <span className="text-xs text-muted-foreground">
        0 to 50. Applies to residuals committed from now on.
      </span>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </span>
  );
}
