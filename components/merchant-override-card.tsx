"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { PercentIcon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { friendlyDbError } from "@/lib/db-errors";
import { formatPeriod } from "@/lib/format";
import {
  CHOOSE_FUNDING,
  type MerchantOverride,
  OVERRIDE_FUNDING_CHOICES,
  type OverrideFunding,
  type OverrideMonth,
  overrideExample,
  overrideFundingText,
  overrideInForce,
  overrideMonths,
  parseOverridePct,
} from "@/lib/overrides";
import {
  monthInputToPeriod,
  nextPeriod,
  periodToMonthInput,
  previousPeriod,
} from "@/lib/rep-shares";
import { cn } from "@/lib/utils";
import { ConfirmPair } from "@/components/confirm-pair";
import type { ShareRep } from "@/components/merchant-share-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/**
 * The admin's "Override" card on a merchant page (20261102120000, memo §4):
 * the override in force, every override past and present, and the set
 * (or change), end and cancel controls.
 *
 * Admin-only by construction: the page renders it for an admin only,
 * merchant_overrides returns no rows to anyone else, and every function it
 * calls checks is_admin() first. Nothing here is a boundary; the cap at the
 * merchant's rate, the recipient rules and the month rule are applied again
 * by the database, whose sentences are shown as they come.
 *
 * "Change" is a new override from a later month: set_merchant_override ends
 * the open one at that month in the same call, so the list is the history.
 * Who pays it (20261116120000, docs/design/override-funding.md) is chosen on
 * every new override with no default, and changed afterwards only through
 * "Change who pays" (set_merchant_override_funding: a reason, refused while a
 * month it touched is marked paid; a committed month takes it on replace).
 * Every control is at least 44px tall: this page is used on phones.
 */
const TOUCH = "min-h-11";
const FIELD = "h-11";

/** "TSYS September 2026" */
const monthLabel = (month: OverrideMonth) => `${month.processor} ${formatPeriod(month.period)}`;

function OverrideRow({
  override,
  names,
  latestCommitted,
  months,
}: {
  override: MerchantOverride;
  names: Map<string, string>;
  latestCommitted: string | null;
  /** The committed processor-months its lines are in, with their paid and stale state. */
  months: readonly OverrideMonth[];
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"idle" | "end" | "cancel" | "funding">("idle");
  const [reason, setReason] = useState("");
  const other: OverrideFunding = override.funded_by === "company" ? "owner" : "company";
  const paidMonths = months.filter((month) => month.paid);
  const staleMonths = months.filter((month) => month.stale);
  const reasonProblem =
    reason.trim().length < 10
      ? "Give a reason of at least 10 characters. It is kept in the audit log."
      : reason.trim().length > 500
        ? "The reason can be at most 500 characters."
        : null;
  const firstOpen = latestCommitted ? nextPeriod(latestCommitted) : null;
  const defaultEnd = periodToMonthInput(
    [nextPeriod(override.effective_from), firstOpen ?? ""].sort().at(-1)!,
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
    setReason("");
    setBusy(false);
    router.refresh();
  };

  const endPeriod = monthInputToPeriod(endMonth);

  return (
    <li
      className="flex min-w-0 flex-col gap-2 rounded-md border p-3"
      data-testid="merchant-override-row"
    >
      <p className="min-w-0 break-words text-sm">
        <span className="font-medium">{Number(override.override_pct)}%</span> of residual to{" "}
        <span className="font-medium">{names.get(override.recipient_id) ?? "Unknown"}</span>
      </p>
      <p className="text-xs text-muted-foreground">
        {overrideMonths(override.effective_from, override.effective_to)}
      </p>
      <p className="text-xs" data-testid="merchant-override-funding">
        {override.funded_by === "company" ? "Paid from the company's share" : "Paid from the owner's side"}
      </p>
      {staleMonths.length > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="merchant-override-stale">
          Who pays it changed after {staleMonths.map(monthLabel).join(", ")}{" "}
          {staleMonths.length === 1 ? "was" : "were"} committed. Replace{" "}
          {staleMonths.length === 1 ? "that month" : "those months"} on Payouts to apply it.
        </p>
      )}

      {mode === "idle" && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className={TOUCH}
            onClick={() => setMode("end")}
          >
            {override.effective_to ? "Change end" : "End override"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className={TOUCH}
            onClick={() => setMode("cancel")}
          >
            Cancel override
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className={TOUCH}
            onClick={() => setMode("funding")}
          >
            Change who pays
          </Button>
        </div>
      )}

      {mode === "funding" && (
        <div className="flex flex-col gap-2" data-testid="merchant-override-funding-change">
          <p className="text-sm">
            Switch to: <span className="font-medium">{overrideFundingText(other)}</span>.
          </p>
          {months.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No month is committed with this override yet, so the change applies from its first month.
            </p>
          ) : (
            <ul className="flex flex-col gap-1 text-xs" aria-label="Months this override has paid">
              {months.map((month) => (
                <li key={`${month.processor}|${month.period}`}>
                  {monthLabel(month)}:{" "}
                  {month.paid
                    ? "marked paid. Reopen it on Payouts first."
                    : "will need a replace to take effect."}
                </li>
              ))}
            </ul>
          )}
          {paidMonths.length > 0 ? (
            <p className="text-sm text-destructive" role="alert">
              {paidMonths.map(monthLabel).join(", ")} {paidMonths.length === 1 ? "is" : "are"} marked
              paid. Reopen {paidMonths.length === 1 ? "it" : "them"} (with a reason) before changing who
              pays this override.
            </p>
          ) : (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor={`override-${override.id}-reason`}>Reason</Label>
                <Textarea
                  id={`override-${override.id}-reason`}
                  value={reason}
                  maxLength={500}
                  onChange={(event) => setReason(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {reasonProblem ?? "Kept in the audit log with the change."}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  className={TOUCH}
                  disabled={busy || reasonProblem !== null}
                  onClick={() =>
                    void run("set_merchant_override_funding", {
                      override_id_input: override.id,
                      funded_by_input: other,
                      reason_input: reason.trim(),
                    })
                  }
                >
                  {busy ? "Saving…" : "Save who pays"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className={TOUCH}
                  disabled={busy}
                  onClick={() => {
                    setReason("");
                    setMode("idle");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </>
          )}
          {paidMonths.length > 0 && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className={cn(TOUCH, "self-start")}
              onClick={() => setMode("idle")}
            >
              Back
            </Button>
          )}
        </div>
      )}

      {mode === "end" && (
        <div className="flex flex-col gap-2">
          <div className="grid gap-1.5">
            <Label htmlFor={`override-${override.id}-end`}>First month it no longer applies</Label>
            <Input
              id={`override-${override.id}-end`}
              type="month"
              value={endMonth}
              onChange={(event) => setEndMonth(event.target.value)}
              className={cn(FIELD, "max-w-[14rem]")}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {endPeriod
              ? `The last month it applies to is ${formatPeriod(previousPeriod(endPeriod))}.`
              : "Choose a month."}
          </p>
          <ConfirmPair
            label=""
            confirmLabel="End override"
            busy={busy}
            buttonClassName={TOUCH}
            onConfirm={() =>
              endPeriod &&
              void run("end_merchant_override", {
                override_id_input: override.id,
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
            Cancelling deletes an override that never applied to a committed month. One that
            has must be ended instead.
          </p>
          <ConfirmPair
            label=""
            confirmLabel="Delete override"
            destructive
            busy={busy}
            buttonClassName={TOUCH}
            onConfirm={() =>
              void run("cancel_merchant_override", { override_id_input: override.id })
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

function SetOverrideForm({
  merchantId,
  reps,
  ownerId,
  defaultRecipientId,
  rate,
  latestCommitted,
  hasOpen,
}: {
  merchantId: number;
  reps: ShareRep[];
  ownerId: string;
  defaultRecipientId: string | null;
  rate: number | null;
  latestCommitted: string | null;
  hasOpen: boolean;
}) {
  const router = useRouter();
  // The owner's manager by default (memo §0.1), editable; never the owner.
  const [recipientId, setRecipientId] = useState(
    defaultRecipientId && defaultRecipientId !== ownerId ? defaultRecipientId : "",
  );
  const [pct, setPct] = useState("");
  // Who pays it: required, and never preselected (design §3).
  const [fundedBy, setFundedBy] = useState<OverrideFunding | null>(null);
  const [fromMonth, setFromMonth] = useState(
    latestCommitted ? periodToMonthInput(nextPeriod(latestCommitted)) : "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = parseOverridePct(pct, rate);
  const fromPeriod = monthInputToPeriod(fromMonth);
  const problem =
    pct.trim() === ""
      ? "Enter the percent of the full residual."
      : !parsed.ok
        ? parsed.message
        : !recipientId
          ? "Choose who receives it."
          : fundedBy === null
            ? CHOOSE_FUNDING
            : !fromPeriod
              ? "Choose the first month it applies to."
              : null;

  const save = async () => {
    if (problem || !fromPeriod || !parsed.ok || fundedBy === null) return;
    setBusy(true);
    setError(null);
    const { error: rpcError } = await createClient().rpc("set_merchant_override", {
      merchant_id_input: merchantId,
      recipient_id_input: recipientId,
      override_pct_input: parsed.hundredths / 100,
      effective_from_input: fromPeriod,
      funded_by_input: fundedBy,
    });
    setBusy(false);
    if (rpcError) {
      setError(friendlyDbError(rpcError, "The override did not save. Try again."));
      return;
    }
    setPct("");
    setFundedBy(null);
    router.refresh();
  };

  return (
    <form
      className="flex flex-col gap-3 rounded-md border p-3"
      aria-label={hasOpen ? "Change the override" : "Set an override"}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h3 className="text-sm font-semibold">{hasOpen ? "Change the override" : "Set an override"}</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor="override-recipient">Paid to</Label>
          <select
            id="override-recipient"
            value={recipientId}
            onChange={(event) => setRecipientId(event.target.value)}
            className={cn(
              "flex w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm transition-colors",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:text-sm",
              FIELD,
            )}
          >
            <option value="">Choose a person</option>
            {reps
              .filter((rep) => rep.is_active && rep.id !== ownerId)
              .map((rep) => (
                <option key={rep.id} value={rep.id}>
                  {rep.full_name}
                  {rep.id === defaultRecipientId ? " (manager)" : ""}
                </option>
              ))}
          </select>
        </div>
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor="override-pct">Percent of the full residual</Label>
          <Input
            id="override-pct"
            inputMode="decimal"
            value={pct}
            onChange={(event) => setPct(event.target.value)}
            className={FIELD}
          />
        </div>
      </div>
      <fieldset className="grid gap-1.5" data-testid="override-funded-by">
        <legend className="mb-1.5 text-sm font-medium">Paid from</legend>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-x-6">
          {OVERRIDE_FUNDING_CHOICES.map((choice) => (
            <label key={choice.value} className={cn("flex items-center gap-2 text-sm", TOUCH)}>
              <input
                type="radio"
                name={`override-${merchantId}-funded-by`}
                value={choice.value}
                checked={fundedBy === choice.value}
                onChange={() => setFundedBy(choice.value)}
                // 44px tall like every control here (the phone test), the
                // circle itself the browser's usual size.
                className="h-11 w-4 shrink-0"
              />
              {choice.label}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          The owner&apos;s side: the owner keeps their rate less the override. The company&apos;s
          share: the owner keeps their full rate, and the company pays the override.
        </p>
      </fieldset>
      <p
        className={cn(
          "text-xs",
          !parsed.ok && pct.trim() !== "" ? "text-destructive" : "text-muted-foreground",
        )}
        data-testid="override-problem"
      >
        {parsed.ok && rate !== null
          ? overrideExample(parsed.hundredths, Number(rate), fundedBy)
          : problem}
      </p>
      <div className="grid gap-1.5">
        <Label htmlFor="override-from">First month it applies to</Label>
        <Input
          id="override-from"
          type="month"
          value={fromMonth}
          onChange={(event) => setFromMonth(event.target.value)}
          className={cn(FIELD, "max-w-[14rem]")}
        />
        <p className="text-xs text-muted-foreground">
          {latestCommitted
            ? `${formatPeriod(latestCommitted)} is the latest month committed for this MID, so an override can start from ${formatPeriod(nextPeriod(latestCommitted))}. An earlier month is fixed with an adjustment.`
            : "No month is committed for this MID yet."}
          {hasOpen && " Saving ends the current override at that month."}
        </p>
      </div>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" className={cn(TOUCH, "self-start")} disabled={busy || problem !== null}>
        {busy ? "Saving…" : "Save override"}
      </Button>
    </form>
  );
}

export function MerchantOverrideCard({
  merchantId,
  mid,
  rate,
  ownerId,
  defaultRecipientId,
  overrides,
  reps,
  latestCommitted,
  currentPeriod,
  overrideMonthsById = {},
}: {
  merchantId: number;
  mid: string | null;
  /** merchants.split_agent_pct: the cap. Null: not set yet. */
  rate: number | null;
  ownerId: string;
  /** The owner's profiles.manager_id: the default recipient. */
  defaultRecipientId: string | null;
  overrides: MerchantOverride[];
  reps: ShareRep[];
  latestCommitted: string | null;
  /** This month, YYYY-MM-01 (UTC), for "in force". */
  currentPeriod: string;
  /** Each override's touched months (loadOverrideMonths), keyed by override id. */
  overrideMonthsById?: Record<number, OverrideMonth[]>;
}) {
  const names = new Map(reps.map((rep) => [rep.id, rep.full_name]));
  const now = overrideInForce(overrides, currentPeriod);
  const rateShown = rate === null ? null : Number(rate);

  return (
    <section className="flex min-w-0 flex-col gap-4" data-testid="merchant-override-card">
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <PercentIcon size={18} />
        Override
      </h2>
      <p className="text-sm text-muted-foreground">
        A percent of the full residual paid to a named person, the owner&apos;s manager by
        default. It can be at most this merchant&apos;s rate
        {rateShown === null ? "" : ` (${rateShown}%)`}. Each override says who pays it: the
        owner&apos;s side (the owner keeps their rate less the override) or the company&apos;s share
        (the owner keeps their full rate). When the owner pays, the rep sees who receives it; the
        recipient sees the merchant&apos;s name only.
      </p>

      <p className="text-sm" data-testid="merchant-override-in-force">
        {now
          ? `In force: ${Number(now.override_pct)}% of residual to ${names.get(now.recipient_id) ?? "Unknown"}, ${overrideFundingText(now.funded_by)}, ${overrideMonths(now.effective_from, now.effective_to)}.`
          : "No override in force this month."}
      </p>

      {!mid ? (
        <p className="text-sm">
          This merchant has no MID, so no residual can carry an override. Add the MID first.
        </p>
      ) : (
        <>
          {overrides.length > 0 && (
            <ul className="flex flex-col gap-2">
              {overrides.map((override) => (
                <OverrideRow
                  key={override.id}
                  override={override}
                  names={names}
                  latestCommitted={latestCommitted}
                  months={overrideMonthsById[override.id] ?? []}
                />
              ))}
            </ul>
          )}
          <SetOverrideForm
            merchantId={merchantId}
            reps={reps}
            ownerId={ownerId}
            defaultRecipientId={defaultRecipientId}
            rate={rate}
            latestCommitted={latestCommitted}
            hasOpen={overrides.some((override) => override.effective_to === null)}
          />
        </>
      )}
    </section>
  );
}
