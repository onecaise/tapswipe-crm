"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { createClient } from "@/lib/supabase/client";
import { EMPTY, formatMoney } from "@/lib/format";
import { parseFigureInput } from "@/lib/payouts";
import { cn } from "@/lib/utils";

type Field = "residual_income" | "rep_split_pct";

/**
 * One editable money or percentage cell on the period page.
 *
 * **Saves on blur and on Enter — deliberately not debounced per keystroke, and
 * deliberately not through useAutosave.** Two reasons, and the second is the one
 * that decided it:
 *
 *   1. useAutosave is built around a single react-hook-form instance with a
 *      hook-owned set of pending RHF paths. A forty-row grid is not that shape;
 *      forcing it would mean one form over eighty fields, and its pending-path set
 *      would be the least of the problems.
 *   2. Every change to these two columns writes a rep_payout_row_history row. A
 *      field saved on each keystroke would record `8`, `88`, `88.4` — three
 *      corrections for one edit, in a table whose entire purpose is a legible
 *      trail of who changed a commission figure and to what.
 *
 * Escape reverts to the stored value, so a half-typed number can be abandoned
 * without saving it. Blur while unchanged writes nothing at all: an inline editor
 * gets blurred constantly just by moving around a table, and a no-op UPDATE would
 * still fire the history trigger's comparison on every one of them.
 */
export function PayoutFigureCell({
  rowId,
  field,
  value,
  merchantName,
}: {
  rowId: number;
  field: Field;
  value: string | null;
  /** For the input's accessible name — a bare "Residual income" repeats 40 times. */
  merchantName: string | null;
}) {
  const router = useRouter();

  const [text, setText] = useState(value ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const label =
    field === "residual_income"
      ? `Residual income for ${merchantName ?? "this merchant"}`
      : `Rep split for ${merchantName ?? "this merchant"}`;

  const save = async () => {
    const parsed = parseFigureInput(text, field);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }

    // Nothing changed — including "blank stayed blank" and "88.40 retyped as
    // $88.40". Writing anyway would be a no-op UPDATE that still runs the history
    // trigger on every incidental blur.
    const stored = value === null ? null : Number(value);
    if (parsed.value === stored) {
      setError(null);
      return;
    }

    setBusy(true);
    setError(null);

    const supabase = createClient();
    const { error: updateError, count } = await supabase
      .from("rep_payout_rows")
      .update({ [field]: parsed.value }, { count: "exact" })
      .eq("id", rowId);

    setBusy(false);

    if (updateError) {
      setError(updateError.message);
      return;
    }
    // RLS filters rather than errors, so a write the policy hides reports success
    // having changed nothing. Without this check a rep who somehow reached the
    // control would be told their edit saved.
    if (count === 0) {
      setError("That change could not be saved. Reload the page.");
      return;
    }

    // Refreshed rather than patched locally: rep_payout is a generated column and
    // every total on the page derives from it, so the server is the only thing that
    // knows the new numbers.
    router.refresh();
  };

  return (
    <span className="flex flex-col gap-0.5">
      <input
        aria-label={label}
        value={text}
        inputMode="decimal"
        disabled={busy}
        onChange={(event) => {
          setText(event.target.value);
          setError(null);
        }}
        onBlur={() => void save()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
          if (event.key === "Escape") {
            setText(value ?? "");
            setError(null);
          }
        }}
        placeholder={EMPTY}
        className={cn(
          "h-7 w-24 rounded-lg border border-input bg-card px-2 text-sm tabular-nums",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          "disabled:cursor-not-allowed disabled:opacity-50",
          error !== null && "border-destructive",
        )}
      />
      {/* The stored value, formatted, under a cell that is mid-edit — so an admin
          typing over 88.4 can still see what it was. Hidden once they match it. */}
      {field === "residual_income" &&
        value !== null &&
        text.trim() !== value && (
          <span className="text-[11px] text-muted-foreground">
            was {formatMoney(value)}
          </span>
        )}
      {error && <span className="text-[11px] text-destructive">{error}</span>}
    </span>
  );
}
