"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  SendIcon,
  XCircleIcon,
} from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import {
  type PreApp,
  type PreAppBusinessProfile,
  type PreAppOwner,
  type PreAppStatus,
  preAppSubmitBlockers,
} from "@/lib/pre-apps";
import { Callout } from "@/components/callout";
import { Button } from "@/components/ui/button";

/**
 * The last step: what still blocks submission, and the button that submits.
 *
 * `submit_pre_app` is the authority and this step never pretends otherwise.
 * `preAppSubmitBlockers` mirrors the RPC's rules so the rep can see what is
 * missing without spending a round trip, but the button stays clickable whenever
 * the list is empty and whatever the RPC says on failure is shown verbatim. If
 * the two ever disagree, the RPC wins and the rep sees why.
 *
 * Two facts the blocker list needs live in tables the browser cannot read:
 * whether banking ciphertext exists, and how many owners still have no SSN. The
 * `*_secrets` tables have no grant to `authenticated` and no policy, by design,
 * so both come from the `pre_app_secrets_presence` RPC, which answers with
 * `exists`/`count` and never names a ciphertext column.
 *
 * NOT `read-pre-app-secrets`, which is the obvious-looking choice and was the
 * first attempt here. That function decrypts: pointed at an admin it returned
 * full plaintext to the browser to populate a checklist, and it audits every
 * read, so merely opening this tab wrote an audit_log row claiming a full SSN
 * read that no human performed. The trail exists to answer "who looked at an
 * SSN" and form renders would bury the answer.
 *
 * When the RPC fails this does NOT invent blockers and does NOT disable the
 * button. It says the two rules could not be checked and lets the rep try:
 * `submit_pre_app` enforces both server-side regardless, so the worst case is an
 * error message instead of a silent, unexplained dead end.
 */
type SecretsPresence = {
  banking_on_file: boolean;
  owners_missing_ssn: number;
};

export function ReviewStep({
  preApp,
  owners,
  profile,
  isAdmin,
}: {
  preApp: PreApp;
  owners: PreAppOwner[];
  profile: PreAppBusinessProfile | null;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [presence, setPresence] = useState<SecretsPresence | null>(null);
  const [presenceFailed, setPresenceFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPresence = useCallback(async () => {
    // Nothing below draft status is submittable, so there is no checklist to
    // build and no reason to make the call. Guarded here rather than by an early
    // return in render, because hooks run either way.
    if (preApp.status !== "draft") return;
    setPresenceFailed(false);
    const supabase = createClient();
    // `returns table (...)` arrives as an array of one row.
    const { data, error: rpcError } = await supabase
      .rpc("pre_app_secrets_presence", { pre_app_id_input: preApp.id })
      .maybeSingle();
    if (rpcError || !data) {
      setPresenceFailed(true);
      return;
    }
    setPresence(data as SecretsPresence);
  }, [preApp.id, preApp.status]);

  useEffect(() => {
    void loadPresence();
  }, [loadPresence]);

  // Optimistic when presence is unknown, so an unreachable RPC cannot
  // manufacture a blocker the rep has no way to clear.
  const blockers = preAppSubmitBlockers({
    preApp,
    owners,
    profile,
    hasBankingSecrets: presence ? presence.banking_on_file : true,
    ownersMissingSsn: presence ? presence.owners_missing_ssn : 0,
  });

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
      // "no such row", so nothing here leaks. Shown as-is.
      setError(rpcError.message);
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

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="font-semibold text-lg">Review &amp; submit</h2>
        <p className="text-sm text-muted-foreground">
          Everything below is checked again on the server when you submit.
        </p>
      </div>

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
          <ul className="flex flex-col gap-1 pl-6">
            {blockers.map((blocker) => (
              <li
                key={blocker}
                className="list-disc text-sm text-muted-foreground"
              >
                {blocker}
              </li>
            ))}
          </ul>
        </div>
      )}

      {presenceFailed && (
        <Callout tone="warning" className="flex items-start gap-2">
          <AlertTriangleIcon size={16} className="mt-0.5 shrink-0" />
          <span>
            Could not check the SSN and banking rules — those two are not
            included in the list above. Submitting still enforces them.{" "}
            <button
              type="button"
              onClick={() => void loadPresence()}
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
