"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { formatPeriod } from "@/lib/format";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const SELECT_CLASS =
  "border-input bg-background focus-visible:ring-ring flex h-8 w-full rounded-md border px-2 text-sm focus-visible:ring-1 focus-visible:outline-none disabled:opacity-50";

/**
 * Posts an adjustment line against a PAID processor-month (memo §3.3, A23):
 * the only way to change what a paid month paid. Admin-only; nothing here is
 * a boundary.
 *
 * post_payout_adjustment() does the checking and is refused for a month that
 * is not marked paid (a correction then is a replace). The line is posted in
 * the open month -- the month after the latest imported one, as a share
 * correction is -- and names the month it adjusts; the rep reads the reason on
 * their statement. Positive pays the rep, negative takes back.
 */
export function PayoutAdjustmentForm({
  period,
  processor,
  reps,
}: {
  period: string;
  processor: string;
  /** Active profiles an adjustment may name. */
  reps: readonly { id: string; full_name: string }[];
}) {
  const router = useRouter();

  const [openForm, setOpenForm] = useState(false);
  const [agentId, setAgentId] = useState("");
  const [mid, setMid] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [posted, setPosted] = useState<string | null>(null);

  const key = `${processor}-${period}`.replace(/\s+/g, "-");

  const submit = async () => {
    setError(null);
    setPosted(null);
    const parsed = Number(amount.replace(/[$,\s]/g, ""));
    if (agentId === "" || mid.trim() === "" || amount.trim() === "" || Number.isNaN(parsed)) {
      setError("Choose the rep, and enter the MID and an amount.");
      return;
    }
    setBusy(true);
    const supabase = createClient();
    const { data, error: rpcError } = await supabase.rpc("post_payout_adjustment", {
      agent_id_input: agentId,
      mid_input: mid.trim(),
      adjusts_period_input: period,
      processor_input: processor,
      amount_input: parsed,
      note_input: note,
    });
    setBusy(false);
    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    const posting = (data as { posting_period: string } | null)?.posting_period;
    setPosted(posting ? `Posted in ${formatPeriod(posting)}.` : "Posted.");
    setAgentId("");
    setMid("");
    setAmount("");
    setNote("");
    setOpenForm(false);
    router.refresh();
  };

  if (!openForm) {
    return (
      <div className="flex flex-col items-start gap-1">
        <Button type="button" size="sm" variant="outline" onClick={() => setOpenForm(true)}>
          Post adjustment
        </Button>
        {posted && <span className="text-xs text-muted-foreground">{posted}</span>}
      </div>
    );
  }

  return (
    <form
      className="grid min-w-0 gap-2 rounded-md border p-3 sm:grid-cols-2"
      aria-label={`Adjustment for ${processor} ${formatPeriod(period)}`}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor={`adj-rep-${key}`}>Rep</Label>
        <select
          id={`adj-rep-${key}`}
          className={SELECT_CLASS}
          value={agentId}
          disabled={busy}
          onChange={(event) => setAgentId(event.target.value)}
        >
          <option value="">Choose…</option>
          {reps.map((rep) => (
            <option key={rep.id} value={rep.id}>
              {rep.full_name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`adj-mid-${key}`}>MID</Label>
        <Input
          id={`adj-mid-${key}`}
          value={mid}
          disabled={busy}
          onChange={(event) => setMid(event.target.value)}
          className="h-8 text-sm"
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`adj-amount-${key}`}>Amount (negative takes back)</Label>
        <Input
          id={`adj-amount-${key}`}
          inputMode="decimal"
          value={amount}
          disabled={busy}
          onChange={(event) => setAmount(event.target.value)}
          className="h-8 text-sm"
        />
      </div>
      <div className="flex flex-col gap-1 sm:col-span-2">
        <Label htmlFor={`adj-note-${key}`}>Reason (the rep sees it)</Label>
        <textarea
          id={`adj-note-${key}`}
          value={note}
          rows={2}
          maxLength={500}
          disabled={busy}
          onChange={(event) => setNote(event.target.value)}
          className="border-input bg-background focus-visible:ring-ring w-full rounded-md border px-3 py-1.5 text-sm focus-visible:ring-1 focus-visible:outline-none"
        />
      </div>
      <span className="flex items-center gap-1.5 sm:col-span-2">
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? "Posting…" : "Post adjustment"}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setOpenForm(false)}>
          Cancel
        </Button>
      </span>
      {error && <span className="text-xs text-destructive sm:col-span-2">{error}</span>}
    </form>
  );
}
