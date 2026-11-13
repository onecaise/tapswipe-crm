"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { formatDate } from "@/lib/format";
import { createClient } from "@/lib/supabase/client";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * One committed processor-month's paid state, and its two actions (memo §3.2,
 * A8): Mark paid, behind a typed confirmation, and Reopen, behind a written
 * reason. Rendered for admins only; nothing here is a boundary.
 *
 * Both go through security definer functions that re-check is_admin() and do
 * the real checking: close_payout_period() compares the typed text with the
 * processor and month itself (so the confirmation is enforced in the
 * database, not by this form), and reopen_payout_period() refuses a reason
 * under 10 characters. Their messages are written for people and shown as
 * they are. The audit row (who, when, and the reopen's reason) is written by
 * the closures table's own trigger.
 *
 * Paid is what stops a replace or a delete of the month; a paid month is then
 * corrected with an adjustment line.
 */
export function PayoutMonthPaid({
  period,
  processor,
  label,
  closedAt,
}: {
  period: string;
  processor: string;
  /** The processor and month as the admin types it, e.g. "TSYS July 2026". */
  label: string;
  /** When it was marked paid, or null when it is not. */
  closedAt: string | null;
}) {
  const router = useRouter();

  const [mode, setMode] = useState<null | "close" | "reopen">(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = (next: "close" | "reopen") => {
    setMode(next);
    setText("");
    setError(null);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { error: rpcError } =
      mode === "close"
        ? await supabase.rpc("close_payout_period", {
            period_input: period,
            processor_input: processor,
            confirmation_input: text,
          })
        : await supabase.rpc("reopen_payout_period", {
            period_input: period,
            processor_input: processor,
            reason_input: text,
          });
    setBusy(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    setMode(null);
    router.refresh();
  };

  const inputId = `paid-${processor}-${period}`.replace(/\s+/g, "-");

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {closedAt === null ? (
          <StatusBadge intent="warning">not paid</StatusBadge>
        ) : (
          <StatusBadge intent="success">paid {formatDate(closedAt)}</StatusBadge>
        )}
        {mode === null && (
          <Button
            type="button"
            size="sm"
            variant={closedAt === null ? "default" : "outline"}
            aria-label={`${closedAt === null ? "Mark paid" : "Reopen"}: ${label}`}
            onClick={() => open(closedAt === null ? "close" : "reopen")}
          >
            {closedAt === null ? "Mark paid" : "Reopen"}
          </Button>
        )}
      </div>

      {mode !== null && (
        <form
          className="flex min-w-0 flex-col gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label htmlFor={inputId} className="text-xs text-muted-foreground">
            {mode === "close" ? (
              <>
                Once paid, this month cannot be replaced or deleted; a correction
                becomes an adjustment. Type <strong className="text-foreground">{label}</strong> to
                confirm.
              </>
            ) : (
              <>
                Why is {label} being reopened? At least 10 characters. The reason is
                kept in the audit log.
              </>
            )}
          </label>
          {mode === "close" ? (
            <Input
              id={inputId}
              value={text}
              autoComplete="off"
              disabled={busy}
              onChange={(event) => setText(event.target.value)}
              className="h-8 max-w-xs text-sm"
            />
          ) : (
            <textarea
              id={inputId}
              value={text}
              rows={2}
              maxLength={500}
              disabled={busy}
              onChange={(event) => setText(event.target.value)}
              className="border-input bg-background focus-visible:ring-ring w-full max-w-sm rounded-md border px-3 py-1.5 text-sm focus-visible:ring-1 focus-visible:outline-none"
            />
          )}
          <span className="flex items-center gap-1.5">
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? "Working…" : mode === "close" ? "Mark paid" : "Reopen month"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setMode(null)}
            >
              Cancel
            </Button>
          </span>
        </form>
      )}

      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
