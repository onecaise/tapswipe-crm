"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2Icon, RotateCcwIcon, XCircleIcon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import type { PreAppStatus } from "@/lib/pre-apps";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

/**
 * The admin decision on a submitted pre-app, and the reopen that follows a
 * decline.
 *
 * Three RPCs, and they remain the authority — this offers only the transitions
 * the server would accept anyway (`approve_pre_app` and `decline_pre_app` want
 * `submitted`, `reopen_pre_app` wants `declined`), and shows whatever they raise
 * verbatim. Their messages are written for a person to read, and both admin-only
 * ones sit behind an `is_admin()` guard, so the ids they name are only ever shown
 * to someone who can already see every row.
 *
 * Two decisions worth spelling out:
 *
 *  - **Approve is two-step.** It creates a merchant and there is no un-approve.
 *    A second click is not the risk — `approve_pre_app` raises on an already
 *    approved pre-app rather than creating a second merchant — so the confirm
 *    step is about the admin's intent, and it is where the consequence (a live
 *    merchant, in the rep's book, not the admin's) is stated.
 *  - **Reopen is offered to the owning rep too**, not just admins, matching
 *    `reopen_pre_app`. Recording a decline reason is pointless if the rep cannot
 *    act on it. No role check is needed here: RLS means anyone who can load this
 *    page is either the owner or an admin, and the RPC re-checks regardless.
 *
 * A declined pre-app keeps its reason on screen (the page renders it above) while
 * the rep works, and `submit_pre_app` clears it on the next submission.
 */
export function PreAppDecision({
  preAppId,
  status,
  isAdmin,
  agentName,
}: {
  preAppId: number;
  status: PreAppStatus;
  isAdmin: boolean;
  agentName: string | null;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState<"approve" | "decline" | null>(
    null,
  );
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const approve = async () => {
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { data, error: rpcError } = await supabase.rpc("approve_pre_app", {
      pre_app_id_input: preAppId,
    });
    if (rpcError) {
      setError(rpcError.message);
      setBusy(false);
      return;
    }
    // The RPC returns the new merchant's id, and that is the one fact this page
    // cannot recover afterwards — pre_apps holds no pointer to it. Going there
    // is also where an admin wants to be next.
    router.push(`/merchants/${data}`);
    router.refresh();
  };

  const decline = async () => {
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { error: rpcError } = await supabase.rpc("decline_pre_app", {
      pre_app_id_input: preAppId,
      reason_input: reason,
    });
    if (rpcError) {
      setError(rpcError.message);
      setBusy(false);
      return;
    }
    // Stays on the page: the point of declining is the reason, and it now
    // renders above along with the reopen this component switches to.
    setConfirming(null);
    setReason("");
    setBusy(false);
    router.refresh();
  };

  const reopen = async () => {
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { error: rpcError } = await supabase.rpc("reopen_pre_app", {
      pre_app_id_input: preAppId,
    });
    if (rpcError) {
      setError(rpcError.message);
      setBusy(false);
      return;
    }
    setBusy(false);
    router.refresh();
  };

  if (status === "declined") {
    return (
      <Panel title="Reopen">
        <p className="text-sm text-muted-foreground">
          Reopening returns this pre-app to draft so it can be corrected and
          submitted again. The reason above stays on file until it is
          resubmitted.
        </p>
        <div className="flex flex-col gap-2 items-start">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void reopen()}
            disabled={busy}
          >
            <RotateCcwIcon size={16} />
            {busy ? "Reopening…" : "Reopen as draft"}
          </Button>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
      </Panel>
    );
  }

  // Nothing to decide on a draft, and approval is terminal.
  if (status !== "submitted" || !isAdmin) return null;

  return (
    <Panel title="Review decision">
      {confirming === null && (
        <>
          <p className="text-sm text-muted-foreground">
            This pre-app is waiting on you. Approving creates the merchant;
            declining sends it back to the rep with a reason.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button size="sm" onClick={() => setConfirming("approve")}>
              <CheckCircle2Icon size={16} />
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setConfirming("decline")}
            >
              <XCircleIcon size={16} />
              Decline
            </Button>
          </div>
        </>
      )}

      {confirming === "approve" && (
        <>
          <p className="text-sm">
            Approving creates an active merchant in{" "}
            <strong>{agentName ?? "the submitting rep"}</strong>
            &rsquo;s book, carrying this pre-app&rsquo;s split across, and
            records both in the audit log. It cannot be undone.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" onClick={() => void approve()} disabled={busy}>
              <CheckCircle2Icon size={16} />
              {busy ? "Approving…" : "Confirm approval"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirming(null)}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </>
      )}

      {confirming === "decline" && (
        <>
          <label className="flex flex-col gap-2 text-sm">
            <span className="font-medium">
              Why is this being declined?{" "}
              <span className="font-normal text-muted-foreground">
                The rep sees this, and it is required.
              </span>
            </span>
            <Textarea
              rows={3}
              autoFocus
              value={reason}
              disabled={busy}
              placeholder="Bank statements are for a different legal entity — need three months for Dot's Diner LLC."
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              variant="destructive"
              onClick={() => void decline()}
              disabled={busy || reason.trim() === ""}
            >
              <XCircleIcon size={16} />
              {busy ? "Declining…" : "Confirm decline"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setConfirming(null);
                setReason("");
                setError(null);
              }}
              disabled={busy}
            >
              Cancel
            </Button>
            {reason.trim() === "" && (
              <span className="text-sm text-muted-foreground">
                Add a reason to enable this.
              </span>
            )}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </>
      )}
    </Panel>
  );
}

function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-md border p-4">
      <h2 className="font-semibold">{title}</h2>
      {children}
    </div>
  );
}
