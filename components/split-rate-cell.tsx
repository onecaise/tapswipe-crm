"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { PencilIcon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * A rep's split rate (memo §0b.4), set in place on the users list. Admin-only
 * by construction: the page is behind requireAdmin().
 *
 * The TerritoryCell shape. Writes through set_rep_split(), the only write path
 * to profiles.split_rate_pct: profiles has no UPDATE grant or policy, and the
 * RPC re-checks is_admin() itself, so nothing on this screen is a security
 * boundary. The RPC refuses anything outside 0-50 or with more than two
 * decimals, and its messages are written to be shown as they are.
 *
 * A new rate applies to pre-apps submitted from now on. It does not change a
 * submitted pre-app or an existing merchant: both hold a snapshot.
 */
export function SplitRateCell({
  userId,
  fullName,
  rate,
}: {
  userId: string;
  fullName: string;
  rate: number;
}) {
  const router = useRouter();

  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(rate));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shown = `${Number(Number(rate).toFixed(2))}%`;

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
    const { error: rpcError } = await supabase.rpc("set_rep_split", {
      user_id: userId,
      rate: parsed,
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
          aria-label={`Change split rate for ${fullName}`}
          onClick={() => {
            setValue(String(Number(Number(rate).toFixed(2))));
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
          aria-label={`Split rate for ${fullName}`}
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
      <span className="max-w-[10rem] whitespace-normal text-xs text-muted-foreground">
        0 to 50. Applies to pre-apps submitted from now on.
      </span>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </span>
  );
}
