"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { UsersIcon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { friendlyDbError } from "@/lib/db-errors";
import { formatPeriod } from "@/lib/format";
import {
  type CorrectableMonth,
  type MerchantShare,
  REP_SIDE_PCT,
  monthInputToPeriod,
  nextPeriod,
  periodToMonthInput,
  previousPeriod,
  shareMonths,
  shareSplitProblem,
  shareSummary,
} from "@/lib/rep-shares";
import { cn } from "@/lib/utils";
import { ConfirmPair } from "@/components/confirm-pair";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export type ShareRep = { id: string; full_name: string; is_active: boolean };

/**
 * The admin's "Shared account" card on a merchant page
 * (docs/design/residual-splits.md §8): every share past and present, and the
 * set, end, cancel and correction controls.
 *
 * Admin-only by construction, not by a role check here: the page renders it
 * only for an admin, merchant_rep_shares returns no rows to anyone else, and
 * every RPC it calls re-checks is_admin(). Nothing on this card is a boundary;
 * every rule it applies early (the 50 total, the month order) is applied again
 * by the database, whose sentences are shown verbatim when it refuses.
 *
 * Input is in REP-PERCENT terms, the way the admin thinks about it: "40 + 10",
 * totalling the 50-point rep side. The company's 50 is shown, never typed.
 *
 * Every control is at least 44px tall: this page is used on phones.
 */
const TOUCH = "min-h-11";
const FIELD = "h-11";

function RepSelect({
  id,
  label,
  value,
  onChange,
  reps,
  exclude,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  reps: ShareRep[];
  exclude?: string;
}) {
  return (
    <div className="grid min-w-0 gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          // The Input primitive's own classes, as dashboard-filters does.
          "flex w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm transition-colors",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:text-sm",
          FIELD,
        )}
      >
        <option value="">Choose a rep</option>
        {reps
          .filter((rep) => rep.is_active && rep.id !== exclude)
          .map((rep) => (
            <option key={rep.id} value={rep.id}>
              {rep.full_name}
            </option>
          ))}
      </select>
    </div>
  );
}

function SplitInputs({
  idPrefix,
  signer,
  partner,
  onSigner,
  onPartner,
}: {
  idPrefix: string;
  signer: string;
  partner: string;
  onSigner: (value: string) => void;
  onPartner: (value: string) => void;
}) {
  const problem = shareSplitProblem(signer, partner);
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-3">
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor={`${idPrefix}-signer-pct`}>Signer&apos;s share</Label>
          <Input
            id={`${idPrefix}-signer-pct`}
            inputMode="decimal"
            value={signer}
            onChange={(event) => onSigner(event.target.value)}
            className={FIELD}
          />
        </div>
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor={`${idPrefix}-partner-pct`}>Partner&apos;s share</Label>
          <Input
            id={`${idPrefix}-partner-pct`}
            inputMode="decimal"
            value={partner}
            onChange={(event) => onPartner(event.target.value)}
            className={FIELD}
          />
        </div>
      </div>
      <p className="text-sm" data-testid={`${idPrefix}-summary`}>
        {shareSummary(signer, partner)}
      </p>
      <p
        className={cn("text-xs", problem ? "text-destructive" : "text-muted-foreground")}
        data-testid={`${idPrefix}-problem`}
      >
        {problem ??
          `The two shares divide the rep side, ${REP_SIDE_PCT}. The company keeps the other ${REP_SIDE_PCT}.`}
      </p>
    </div>
  );
}

function ShareRow({
  share,
  names,
  latestCommitted,
}: {
  share: MerchantShare;
  names: Map<string, string>;
  latestCommitted: string | null;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"idle" | "end" | "cancel">("idle");
  const firstOpen = latestCommitted ? nextPeriod(latestCommitted) : null;
  const defaultEnd = periodToMonthInput(
    [nextPeriod(share.effective_from), firstOpen ?? ""].sort().at(-1)!,
  );
  const [endMonth, setEndMonth] = useState(defaultEnd);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: string, args: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    const { error: rpcError } = await createClient().rpc(fn, args);
    if (rpcError) {
      setBusy(false);
      setError(friendlyDbError(rpcError, "That did not save. Try again."));
      return;
    }
    setMode("idle");
    setBusy(false);
    router.refresh();
  };

  const name = (id: string) => names.get(id) ?? "Unknown rep";
  const endPeriod = monthInputToPeriod(endMonth);

  return (
    <li
      className="flex min-w-0 flex-col gap-2 rounded-md border p-3"
      data-testid="merchant-share-row"
    >
      <p className="min-w-0 break-words text-sm">
        <span className="font-medium">{name(share.primary_agent_id)}</span> (signer){" "}
        {share.primary_rep_pct} ·{" "}
        <span className="font-medium">{name(share.secondary_agent_id)}</span> (partner){" "}
        {share.secondary_rep_pct}
      </p>
      <p className="text-xs text-muted-foreground">
        {shareMonths(share.effective_from, share.effective_to)}
      </p>

      {mode === "idle" && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className={TOUCH}
            onClick={() => setMode("end")}
          >
            {share.effective_to ? "Change end" : "End share"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className={TOUCH}
            onClick={() => setMode("cancel")}
          >
            Cancel share
          </Button>
        </div>
      )}

      {mode === "end" && (
        <div className="flex flex-col gap-2">
          <div className="grid gap-1.5">
            <Label htmlFor={`share-${share.id}-end`}>First month it no longer applies</Label>
            <Input
              id={`share-${share.id}-end`}
              type="month"
              value={endMonth}
              onChange={(event) => setEndMonth(event.target.value)}
              className={cn(FIELD, "max-w-[14rem]")}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {endPeriod
              ? `The last month it pays is ${formatPeriod(previousPeriod(endPeriod))}.`
              : "Choose a month."}
          </p>
          <ConfirmPair
            label=""
            confirmLabel="End share"
            busy={busy}
            buttonClassName={TOUCH}
            onConfirm={() =>
              endPeriod &&
              void run("end_merchant_rep_share", {
                share_id_input: share.id,
                effective_to_input: endPeriod,
              })
            }
            onCancel={() => setMode("idle")}
          />
        </div>
      )}

      {mode === "cancel" && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            Cancelling deletes a share that never applied to a committed month. One that
            has must be ended instead.
          </p>
          <ConfirmPair
            label=""
            confirmLabel="Delete share"
            destructive
            busy={busy}
            buttonClassName={TOUCH}
            onConfirm={() =>
              void run("cancel_merchant_rep_share", { share_id_input: share.id })
            }
            onCancel={() => setMode("idle")}
          />
        </div>
      )}

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

function SetShareForm({
  merchantId,
  reps,
  defaultSignerId,
  latestCommitted,
  hasOpenShare,
}: {
  merchantId: number;
  reps: ShareRep[];
  defaultSignerId: string | null;
  latestCommitted: string | null;
  hasOpenShare: boolean;
}) {
  const router = useRouter();
  const [signerId, setSignerId] = useState(defaultSignerId ?? "");
  const [partnerId, setPartnerId] = useState("");
  const [signerPct, setSignerPct] = useState("25");
  const [partnerPct, setPartnerPct] = useState("25");
  const [fromMonth, setFromMonth] = useState(
    latestCommitted ? periodToMonthInput(nextPeriod(latestCommitted)) : "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fromPeriod = monthInputToPeriod(fromMonth);
  const problem =
    shareSplitProblem(signerPct, partnerPct) ??
    (!signerId || !partnerId
      ? "Choose the signer and the partner."
      : signerId === partnerId
        ? "The signer and the partner must be two different reps."
        : !fromPeriod
          ? "Choose the first month the share applies to."
          : null);

  const save = async () => {
    if (problem || !fromPeriod) return;
    setBusy(true);
    setError(null);
    const { error: rpcError } = await createClient().rpc("set_merchant_rep_share", {
      merchant_id_input: merchantId,
      primary_agent_id_input: signerId,
      secondary_agent_id_input: partnerId,
      primary_rep_pct_input: Number(signerPct),
      secondary_rep_pct_input: Number(partnerPct),
      effective_from_input: fromPeriod,
    });
    setBusy(false);
    if (rpcError) {
      setError(friendlyDbError(rpcError, "The share did not save. Try again."));
      return;
    }
    setPartnerId("");
    router.refresh();
  };

  return (
    <form
      className="flex flex-col gap-3 rounded-md border p-3"
      aria-label="Set a shared account"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h3 className="text-sm font-semibold">Set a shared account</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <RepSelect id="share-signer" label="Signer" value={signerId} onChange={setSignerId} reps={reps} />
        <RepSelect
          id="share-partner"
          label="Partner"
          value={partnerId}
          onChange={setPartnerId}
          reps={reps}
          exclude={signerId}
        />
      </div>
      <SplitInputs
        idPrefix="share"
        signer={signerPct}
        partner={partnerPct}
        onSigner={setSignerPct}
        onPartner={setPartnerPct}
      />
      <div className="grid gap-1.5">
        <Label htmlFor="share-from">First month it applies to</Label>
        <Input
          id="share-from"
          type="month"
          value={fromMonth}
          onChange={(event) => setFromMonth(event.target.value)}
          className={cn(FIELD, "max-w-[14rem]")}
        />
        <p className="text-xs text-muted-foreground">
          {latestCommitted
            ? `${formatPeriod(latestCommitted)} is the latest month committed for this MID, so a share can start from ${formatPeriod(nextPeriod(latestCommitted))}. An earlier month is corrected below instead.`
            : "No month is committed for this MID yet."}
          {hasOpenShare && " Saving ends the current share at that month."}
        </p>
      </div>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" className={cn(TOUCH, "self-start")} disabled={busy || problem !== null}>
        {busy ? "Saving…" : "Save share"}
      </Button>
      {/* The split's own problem is already shown under the inputs. */}
      {problem && shareSplitProblem(signerPct, partnerPct) === null && (
        <p className="text-xs text-muted-foreground">{problem}</p>
      )}
    </form>
  );
}

function CorrectionForm({
  merchantId,
  reps,
  names,
  months,
}: {
  merchantId: number;
  reps: ShareRep[];
  names: Map<string, string>;
  months: CorrectableMonth[];
}) {
  const router = useRouter();
  const [period, setPeriod] = useState(months[0]?.period ?? "");
  const [partnerId, setPartnerId] = useState("");
  const [signerPct, setSignerPct] = useState("25");
  const [partnerPct, setPartnerPct] = useState("25");
  const [note, setNote] = useState("");
  const [posting, setPosting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const month = months.find((m) => m.period === period) ?? null;
  const problem = !month
    ? "Choose the month being corrected."
    : month.corrected_in
      ? `${formatPeriod(month.period)} was already corrected, in ${formatPeriod(month.corrected_in)}. A month is corrected once.`
      : !month.payout_known
        ? `${formatPeriod(month.period)}'s payout is not worked out yet: fill in its residual and rate first.`
        : !partnerId
          ? "Choose the partner."
          : (shareSplitProblem(signerPct, partnerPct) ??
            (note.trim() === ""
              ? "Add a note saying what was agreed. Both reps see it on their statements."
              : note.trim().length > 500
                ? "The note can be at most 500 characters."
                : null));

  // Any edit after review invalidates the confirmation: it was for those
  // exact figures.
  const edit = <T,>(set: (value: T) => void) => (value: T) => {
    setPosting(null);
    setDone(null);
    set(value);
  };

  const review = async () => {
    if (problem) return;
    setBusy(true);
    setError(null);
    const { data, error: rpcError } = await createClient().rpc(
      "share_correction_posting_period",
    );
    setBusy(false);
    if (rpcError || typeof data !== "string") {
      setError(friendlyDbError(rpcError, "Could not work out the posting month. Try again."));
      return;
    }
    setPosting(data);
  };

  const post = async () => {
    if (problem || !posting || !month) return;
    setBusy(true);
    setError(null);
    const { data, error: rpcError } = await createClient().rpc("post_share_correction", {
      merchant_id_input: merchantId,
      original_period_input: month.period,
      partner_agent_id_input: partnerId,
      primary_rep_pct_input: Number(signerPct),
      secondary_rep_pct_input: Number(partnerPct),
      note_input: note.trim(),
      expected_posting_period_input: posting,
    });
    setBusy(false);
    setPosting(null);
    if (rpcError) {
      setError(friendlyDbError(rpcError, "The correction did not post. Try again."));
      return;
    }
    const result = data as { posting_period: string; amount: number };
    setDone(
      `Posted to ${formatPeriod(result.posting_period)}: ${names.get(partnerId) ?? "the partner"} receives $${Number(result.amount).toFixed(2)} from ${names.get(month.agent_id) ?? "the signer"}.`,
    );
    setNote("");
    router.refresh();
  };

  return (
    <form
      className="flex flex-col gap-3 rounded-md border p-3"
      aria-label="Post a correction"
      onSubmit={(event) => {
        event.preventDefault();
        void review();
      }}
    >
      <h3 className="text-sm font-semibold">Correct a month already committed</h3>
      <p className="text-xs text-muted-foreground">
        For a share agreed after its month was paid. The committed month is not edited: two
        adjustment lines are posted in the next open month, moving the partner&apos;s part
        from the rep who was paid.
      </p>
      <div className="grid gap-1.5">
        <Label htmlFor="correction-month">Month being corrected</Label>
        <select
          id="correction-month"
          value={period}
          onChange={(event) => edit(setPeriod)(event.target.value)}
          className={cn(
            "flex w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:text-sm",
            FIELD,
          )}
        >
          {months.map((m) => (
            <option key={m.period} value={m.period}>
              {formatPeriod(m.period)} · paid to {names.get(m.agent_id) ?? "Unknown rep"}
              {m.corrected_in ? " · already corrected" : ""}
            </option>
          ))}
        </select>
      </div>
      <RepSelect
        id="correction-partner"
        label="Partner"
        value={partnerId}
        onChange={edit(setPartnerId)}
        reps={reps}
        exclude={month?.agent_id}
      />
      <SplitInputs
        idPrefix="correction"
        signer={signerPct}
        partner={partnerPct}
        onSigner={edit(setSignerPct)}
        onPartner={edit(setPartnerPct)}
      />
      <div className="grid gap-1.5">
        <Label htmlFor="correction-note">Note (both reps see it)</Label>
        <Textarea
          id="correction-note"
          value={note}
          maxLength={500}
          onChange={(event) => edit(setNote)(event.target.value)}
        />
      </div>

      {problem && month?.corrected_in && (
        <p className="text-sm text-destructive" role="alert" data-testid="correction-refused">
          {problem}
        </p>
      )}
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {done && (
        <p className="text-sm" role="status" data-testid="correction-done">
          {done}
        </p>
      )}

      {posting ? (
        <div
          className="flex flex-col gap-2 rounded-md border border-warning/25 bg-warning-bg p-3"
          data-testid="correction-confirm"
        >
          <p className="text-sm">
            This will post to <span className="font-semibold">{formatPeriod(posting)}</span>:
            an adjustment paying {names.get(partnerId) ?? "the partner"} their{" "}
            {partnerPct} of {REP_SIDE_PCT} of {formatPeriod(month?.period)}, and the same
            amount taken from {names.get(month?.agent_id ?? "") ?? "the signer"}.
          </p>
          <ConfirmPair
            label=""
            confirmLabel="Post correction"
            busy={busy}
            buttonClassName={TOUCH}
            onConfirm={() => void post()}
            onCancel={() => setPosting(null)}
          />
        </div>
      ) : (
        <Button
          type="submit"
          variant="outline"
          className={cn(TOUCH, "self-start")}
          disabled={busy || problem !== null}
        >
          {busy ? "Checking…" : "Review correction"}
        </Button>
      )}
    </form>
  );
}

export function MerchantShareCard({
  merchantId,
  mid,
  shares,
  reps,
  defaultSignerId,
  latestCommitted,
  months,
}: {
  merchantId: number;
  mid: string | null;
  shares: MerchantShare[];
  reps: ShareRep[];
  defaultSignerId: string | null;
  latestCommitted: string | null;
  months: CorrectableMonth[];
}) {
  const names = new Map(reps.map((rep) => [rep.id, rep.full_name]));

  return (
    <section className="flex min-w-0 flex-col gap-4" data-testid="merchant-share-card">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <UsersIcon size={18} />
        Shared account
      </h2>
      <p className="text-sm text-muted-foreground">
        Two reps can divide this account&apos;s rep side ({REP_SIDE_PCT}%). The company&apos;s{" "}
        {REP_SIDE_PCT}% never changes. Each rep sees the other&apos;s name and their own share,
        never the other&apos;s payout.
      </p>

      {!mid ? (
        <p className="text-sm">
          This merchant has no MID, so no residual can match a share on it. Add the MID first.
        </p>
      ) : (
        <>
          {shares.length === 0 ? (
            <p className="text-sm text-muted-foreground">Not shared.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {shares.map((share) => (
                <ShareRow
                  key={share.id}
                  share={share}
                  names={names}
                  latestCommitted={latestCommitted}
                />
              ))}
            </ul>
          )}
          <SetShareForm
            merchantId={merchantId}
            reps={reps}
            defaultSignerId={defaultSignerId}
            latestCommitted={latestCommitted}
            hasOpenShare={shares.some((share) => share.effective_to === null)}
          />
          {months.length > 0 && (
            <CorrectionForm
              merchantId={merchantId}
              reps={reps}
              names={names}
              months={months}
            />
          )}
        </>
      )}
    </section>
  );
}
