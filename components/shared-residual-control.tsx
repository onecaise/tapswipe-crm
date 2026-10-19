"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { createClient } from "@/lib/supabase/client";
import { friendlyDbError } from "@/lib/db-errors";
import { formatMoney } from "@/lib/format";
import { parseFigureInput } from "@/lib/payouts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * "Set account total" on a shared pair's SIGNER line (admins only;
 * docs/design/residual-splits.md §5.2).
 *
 * A shared account's residual is one figure for the account, divided between
 * the two lines by shared_part(). Neither line's piece can be edited on its
 * own -- guard_shared_line() refuses it, PT409 -- so this replaces the
 * residual cell's editor for both lines of the pair: one input, one call to
 * set_shared_residual(), and the database writes both pieces and both payouts.
 *
 * Blank clears the pair back to "not worked out yet", the same as an empty
 * figure cell. Whole cents only, as the RPC requires; the shared figure
 * parser's rules otherwise (commas only as thousands, a $ allowed).
 *
 * 44px controls: the period page is opened on phones.
 */
export function SharedResidualControl({
  shareId,
  period,
  accountResidual,
  merchantName,
}: {
  shareId: number;
  period: string;
  accountResidual: number | null;
  merchantName: string | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(accountResidual === null ? "" : String(accountResidual));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const parsed = parseFigureInput(text, "residual_income");
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    if (parsed.value !== null && Math.round(parsed.value * 100) / 100 !== parsed.value) {
      setError("The account residual is in whole cents.");
      return;
    }
    setBusy(true);
    setError(null);
    const { error: rpcError } = await createClient().rpc("set_shared_residual", {
      rep_share_id_input: shareId,
      period_input: period,
      amount_input: parsed.value,
    });
    setBusy(false);
    if (rpcError) {
      setError(friendlyDbError(rpcError, "The account total did not save. Try again."));
      return;
    }
    setEditing(false);
    router.refresh();
  };

  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid="shared-residual-control">
      {editing ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Input
            aria-label={`Account total residual for ${merchantName ?? "this account"}`}
            inputMode="decimal"
            value={text}
            disabled={busy}
            onChange={(event) => {
              setText(event.target.value);
              setError(null);
            }}
            className="h-11 w-36 tabular-nums"
          />
          <Button type="submit" size="sm" className="min-h-11" disabled={busy}>
            {busy ? "Saving…" : "Save total"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="min-h-11"
            disabled={busy}
            onClick={() => {
              setEditing(false);
              setError(null);
            }}
          >
            Cancel
          </Button>
        </form>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="min-h-11 self-start"
          onClick={() => setEditing(true)}
        >
          {accountResidual === null ? "Set account total" : `Change account total (${formatMoney(accountResidual)})`}
        </Button>
      )}
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
