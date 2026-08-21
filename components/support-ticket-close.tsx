"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2Icon, LockIcon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import type { SupportTicketStatus } from "@/lib/support-tickets";
import { Button } from "@/components/ui/button";

/**
 * Closing a ticket, as a deliberate one-way action.
 *
 * Closing was already possible before this component existed — the edit form's
 * status <select> offered "closed" like any other value. That is precisely why
 * this exists: since 20260821113000 a close cannot be undone, and an
 * irreversible action does not belong in a dropdown among priority and
 * sub-category, saved by the same button as a typo fix.
 *
 * So the form no longer offers "closed" at all (see support-ticket-form.tsx) and
 * this is the only path. Two properties matter:
 *
 *  - **Two steps.** The confirm step is where the consequence is stated, and it
 *    is the only place the word "permanent" appears in the flow. This is the
 *    same treatment `pre-app-decision.tsx` gives approve — also irreversible,
 *    also creating something that cannot be walked back.
 *  - **No role check.** Anyone who can load this page is either the owning rep
 *    or an admin (RLS decided that before render), and both may close. The
 *    update policy re-checks regardless, so a stale page cannot close a ticket
 *    the caller has since lost access to.
 *
 * `variant="outline"` on the trigger, `destructive` on the confirm. A close is
 * not a delete — nothing is destroyed and the ticket stays readable — so it does
 * not earn destructive red at rest, where it would sit next to Edit and invite
 * the misclick the two-red system exists to prevent. Once the confirm step is
 * showing, the irreversibility IS the message and red carries it.
 */
export function SupportTicketClose({
  ticketId,
  status,
}: {
  ticketId: number;
  status: SupportTicketStatus;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = async () => {
    setBusy(true);
    setError(null);

    const supabase = createClient();
    // count: "exact" for the reason support-ticket-form.tsx uses it: RLS
    // filters rather than erroring, so a ticket that is no longer the caller's
    // returns no error and changes nothing. Without the count this would report
    // a close that never happened.
    const { error: updateError, count } = await supabase
      .from("support_tickets")
      .update({ status: "closed" }, { count: "exact" })
      .eq("id", ticketId);

    if (updateError) {
      setError(updateError.message);
      setBusy(false);
      return;
    }
    if (count === 0) {
      setError("That ticket could not be closed. It may no longer be yours.");
      setBusy(false);
      return;
    }

    setBusy(false);
    setConfirming(false);
    router.refresh();
  };

  // Already closed: say so, and say that it is final. The alternative — showing
  // nothing — reads as a missing feature rather than a finished ticket, and
  // leaves someone hunting the edit form for a reopen that does not exist.
  if (status === "closed") {
    return (
      <div className="flex flex-col gap-2 rounded-md border p-4">
        <h2 className="flex items-center gap-2 font-semibold">
          <LockIcon size={16} />
          Closed
        </h2>
        <p className="text-sm text-muted-foreground">
          This ticket is closed for good — closing cannot be undone. The
          conversation below stays readable. If it turns out more is needed, open
          a new ticket and link back to this one.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 rounded-md border p-4">
      <h2 className="font-semibold">Close this ticket</h2>

      {!confirming ? (
        <>
          <p className="text-sm text-muted-foreground">
            Closing takes the ticket out of the open queue. It stays readable,
            with its replies, under the Closed filter.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="self-start"
            onClick={() => setConfirming(true)}
          >
            <CheckCircle2Icon size={16} />
            Close ticket
          </Button>
        </>
      ) : (
        <>
          <p className="text-sm">
            This is <strong>permanent</strong>. A closed ticket cannot be
            reopened by anyone, including an admin — if the problem comes back,
            it needs a new ticket.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              variant="destructive"
              onClick={() => void close()}
              disabled={busy}
            >
              <CheckCircle2Icon size={16} />
              {busy ? "Closing…" : "Confirm close"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setConfirming(false);
                setError(null);
              }}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        </>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
