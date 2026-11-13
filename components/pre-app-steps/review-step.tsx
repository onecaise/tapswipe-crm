"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  SendIcon,
  XCircleIcon,
} from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { friendlyDbError } from "@/lib/db-errors";
import {
  type PreApp,
  type PreAppBusinessProfile,
  type PreAppOwner,
  type PreAppStatus,
  type PreAppTerminal,
  PRE_APP_STEP_LABELS,
} from "@/lib/pre-apps";
import type { PreAppMissingItem } from "@/lib/pre-app-required";
import { Callout } from "@/components/callout";
import { PreAppSummary } from "@/components/pre-app-summary";
import { Button } from "@/components/ui/button";

/**
 * The last step: what still blocks submission, and the button that submits.
 *
 * The list is pre_app_missing_fields() (20261028120000), fetched by the page
 * through the RPC: the SAME function submit_pre_app() calls and refuses with.
 * There is no browser-side copy of the rule any more (preAppSubmitBlockers
 * was retired in phase 4), so the list here and the refusal cannot disagree.
 * It covers the secrets too -- existence and kind only, the function never
 * names a ciphertext column -- so nothing here calls a decrypting function
 * (the read-pre-app-secrets lesson: it returned plaintext to build a
 * checklist and wrote an audit row per render).
 *
 * When the call failed (missing is null) this does NOT invent blockers and
 * does NOT disable the button: it says the list could not be loaded and lets
 * the rep try, because submit_pre_app() enforces the same list regardless.
 */
export function ReviewStep({
  preApp,
  owners,
  profile,
  terminal,
  isAdmin,
  missing,
  rep,
}: {
  preApp: PreApp;
  owners: PreAppOwner[];
  profile: PreAppBusinessProfile | null;
  terminal: PreAppTerminal | null;
  isAdmin: boolean;
  /** pre_app_missing_fields(), or null when it could not be read. */
  missing: PreAppMissingItem[] | null;
  /** The pre-app's rep (not the viewer), or null when unreadable. */
  rep: {
    full_name: string;
    legal_name: string | null;
    llc_legal_name: string | null;
    split_rate_pct: number;
  } | null;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const blockers = missing ?? [];

  const submit = async () => {
    setSubmitting(true);
    setError(null);

    const supabase = createClient();
    const { error: rpcError } = await supabase.rpc("submit_pre_app", {
      pre_app_id_input: preApp.id,
    });

    if (rpcError) {
      // Every raise in submit_pre_app is written for a rep to read ("one owner
      // must hold at least 51% ownership", "banking details have not been
      // submitted"), and its 404 is deliberately identical for "not yours" and
      // "no such row", so nothing here leaks. Those pass through verbatim; only
      // a bare constraint error would be reworded (lib/db-errors.ts).
      setError(friendlyDbError(rpcError, "The pre-app was not submitted."));
      setSubmitting(false);
      return;
    }

    // The record is no longer a draft, so the wizard would bounce a rep to the
    // read-only surface on the next render anyway. Going there directly means
    // they see the submitted state rather than a redirect they didn't ask for.
    router.push(`/pre-apps/${preApp.id}`);
    router.refresh();
  };

  if (preApp.status !== "draft") {
    return (
      <Submitted status={preApp.status} declineReason={preApp.decline_reason} />
    );
  }

  const ready = blockers.length === 0;
  const rate = rep ? Number(rep.split_rate_pct) : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="font-semibold text-lg">Review &amp; submit</h2>
        <p className="text-sm text-muted-foreground">
          Everything below is checked again on the server when you submit.
        </p>
      </div>

      {/* The actual application, above the verdict on it. Without this the step
          was a checklist under a subtitle promising "everything below", and the
          only way to read back what you were about to submit was to submit it
          and land on the detail page. */}
      <PreAppSummary
        preApp={preApp}
        owners={owners}
        terminal={terminal}
        cardMix={profile}
      />

      {/* What submit_pre_app() will copy onto the application from the
          rep's profile (memo §7.1, §0b.4). Read-only: an admin sets all
          three in Manage Users. */}
      <div className="flex flex-col gap-1 text-sm" data-testid="rep-snapshot">
        <span>
          Submitted by{" "}
          <strong>{rep?.legal_name ?? rep?.full_name ?? "—"}</strong>
          {rep?.llc_legal_name && <> · {rep.llc_legal_name}</>}
        </span>
        <span className="text-muted-foreground">
          Rep split{" "}
          {rate === null
            ? "—"
            : `${Number(rate.toFixed(2))}% · Company ${Number((100 - rate).toFixed(2))}%`}
          , copied from the rep&rsquo;s profile when this is submitted.
        </span>
      </div>

      <div className="border-t pt-6" />

      {ready ? (
        <Callout tone="success" className="flex items-center gap-2">
          <CheckCircle2Icon size={16} className="shrink-0" />
          This pre-app looks complete and is ready to submit.
        </Callout>
      ) : (
        <div className="flex flex-col gap-2 rounded-md border p-4">
          <p className="flex items-center gap-2 text-sm font-medium">
            <XCircleIcon size={16} className="shrink-0 text-destructive" />
            {blockers.length === 1
              ? "One thing is missing before this can be submitted:"
              : `${blockers.length} things are missing before this can be submitted:`}
          </p>
          <ul className="flex flex-col gap-1 pl-6" aria-label="Missing before submit">
            {blockers.map((blocker) => (
              <li
                key={`${blocker.code}:${blocker.owner_id ?? ""}`}
                data-code={blocker.code}
                className="list-disc text-sm text-muted-foreground"
              >
                {blocker.label}{" "}
                <span className="text-xs">
                  ({PRE_APP_STEP_LABELS[blocker.step]})
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {missing === null && (
        <Callout tone="warning" className="flex items-start gap-2">
          <AlertTriangleIcon size={16} className="mt-0.5 shrink-0" />
          <span>
            Could not load the list of what is still missing. Submitting
            checks everything regardless.{" "}
            <button
              type="button"
              onClick={() => router.refresh()}
              className="underline underline-offset-2"
            >
              Try again
            </button>
          </span>
        </Callout>
      )}

      <div className="flex flex-col gap-2 items-start border-t pt-4">
        <Button onClick={() => void submit()} disabled={submitting || !ready}>
          <SendIcon size={16} />
          {submitting ? "Submitting…" : "Submit for review"}
        </Button>
        {!ready && (
          <p className="text-sm text-muted-foreground">
            Clear the list above to enable this.
          </p>
        )}
        {isAdmin && (
          <p className="text-sm text-muted-foreground">
            Submitting on a rep&rsquo;s behalf leaves the pre-app with them —
            it does not move into your book.
          </p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    </div>
  );
}

/**
 * Already past draft. Reached by an admin, who can edit any status; a rep is
 * redirected to the read-only page before the wizard renders.
 */
function Submitted({
  status,
  declineReason,
}: {
  status: PreAppStatus;
  declineReason: string | null;
}) {
  return (
    <div className="flex flex-col gap-3">
      <h2 className="font-semibold text-lg">Review &amp; submit</h2>
      <p className="rounded-md border p-3 text-sm">
        This pre-app is <strong>{status}</strong>, so there is nothing to submit
        here.
        {status === "declined" && declineReason && (
          <>
            {" "}
            It was declined because: {declineReason}. Reopening it returns it to
            draft.
          </>
        )}
      </p>
    </div>
  );
}
