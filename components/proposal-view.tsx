"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { PencilIcon, PrinterIcon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { formatDateTime, formatMoney } from "@/lib/format";
import type { Product } from "@/lib/products";
import {
  QUOTE_STATUSES,
  QUOTE_STATUS_LABELS,
  type QuoteGroup,
  type QuoteLineItem,
  cartFromLines,
  isQuoteStatus,
  lineTotals,
  proposalPrintHref,
  statusIntent,
} from "@/lib/quotes";
import { ProposalBuilder } from "@/components/proposal-builder";
import { ProposalLines } from "@/components/proposal-lines";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";

/**
 * One proposal: its current version, its status, Revise, and every version.
 *
 * Revise opens the builder pre-filled from the CURRENT version through
 * cartFromLines() — the one reading of the device/add-on nesting, shared with
 * the printed sheet — and saves a NEW version with the same group, link,
 * customer and rep. Nothing here updates a version except `status`, the one
 * column `authenticated` may update.
 */
export function ProposalView({
  group,
  linesByQuote,
  devices,
  addons,
  addonsByDevice,
}: {
  group: QuoteGroup;
  linesByQuote: Record<number, QuoteLineItem[]>;
  devices: Product[];
  addons: Product[];
  addonsByDevice: Map<number, number[]>;
}) {
  const router = useRouter();
  const [revising, setRevising] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const current = group.current;
  const currentLines = linesByQuote[current.id] ?? [];
  const totals = lineTotals(currentLines);

  const setStatus = async (status: string) => {
    setBusy(true);
    setError(null);
    // The ONLY column `authenticated` may update on this table; anything else
    // fails with "permission denied for column".
    const { error: updateError } = await createClient()
      .from("quotes")
      .update({ status })
      .eq("id", current.id);
    setBusy(false);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    router.refresh();
  };

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3 rounded-md border p-3 sm:p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">
                {current.title ?? "Untitled proposal"}
              </span>
              <StatusBadge intent={statusIntent(current.status)}>
                {isQuoteStatus(current.status)
                  ? QUOTE_STATUS_LABELS[current.status]
                  : current.status}
              </StatusBadge>
              {/* Always shown, even at v1: it is what tells a rep this is a
                  record with a history before they click Revise. */}
              <span className="text-xs text-muted-foreground">
                Version {current.version} of {group.versions.length}
              </span>
            </div>
            <span className="text-xs text-muted-foreground">
              {formatDateTime(current.created_at)}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Two figures, never summed — see lineTotals(). */}
            <span className="text-sm tabular-nums" data-testid="proposal-totals">
              <span className="font-medium">{formatMoney(totals.oneTime)}</span>
              <span className="text-muted-foreground"> one-time</span>
              {totals.monthly > 0 && (
                <>
                  {" · "}
                  <span className="font-medium">{formatMoney(totals.monthly)}</span>
                  <span className="text-muted-foreground">/mo</span>
                </>
              )}
            </span>
            {/* No ?quote= — the bare URL prints whatever is current. */}
            <Button asChild size="sm" variant="outline">
              <Link href={proposalPrintHref(group.quoteGroupId)}>
                <PrinterIcon size={14} />
                Print
              </Link>
            </Button>
            {!revising && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setRevising(true)}
              >
                <PencilIcon size={14} />
                Revise
              </Button>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-muted-foreground" htmlFor="proposal-status">
            Status
          </label>
          <select
            id="proposal-status"
            className="h-8 rounded-md border bg-background px-2 text-xs"
            value={current.status}
            disabled={busy}
            onChange={(e) => void setStatus(e.target.value)}
          >
            {QUOTE_STATUSES.map((status) => (
              <option key={status} value={status}>
                {QUOTE_STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </div>

        <ProposalLines lines={currentLines} />
        {current.notes && (
          <p className="text-xs text-muted-foreground">{current.notes}</p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </section>

      {revising && (
        <ProposalBuilder
          heading={`Revising version ${current.version} — saves as a new version`}
          target={{
            groupId: group.quoteGroupId,
            leadId: current.lead_id,
            merchantId: current.merchant_id,
            customerName: current.customer_name,
            agentId: current.agent_id,
          }}
          targetProblem={null}
          initial={{
            title: current.title ?? "",
            notes: current.notes ?? "",
            cart: cartFromLines(currentLines),
          }}
          devices={devices}
          addons={addons}
          addonsByDevice={addonsByDevice}
          onCancel={() => setRevising(false)}
        />
      )}

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">Version history</h2>
        <ol className="flex flex-col divide-y rounded-md border">
          {group.versions.map((version) => {
            const versionTotals = lineTotals(linesByQuote[version.id] ?? []);
            return (
              <li
                key={version.id}
                className="flex flex-col gap-1 p-3 text-sm"
                data-testid={`proposal-version-${version.version}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">Version {version.version}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatDateTime(version.created_at)}
                  </span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {formatMoney(versionTotals.oneTime)} one-time
                    {versionTotals.monthly > 0 &&
                      ` · ${formatMoney(versionTotals.monthly)}/mo`}
                  </span>
                  <Link
                    className="text-xs text-primary hover:underline"
                    href={proposalPrintHref(group.quoteGroupId, version.id)}
                  >
                    Print this version
                  </Link>
                </div>
                {version.notes && (
                  <p className="text-xs text-muted-foreground">{version.notes}</p>
                )}
              </li>
            );
          })}
        </ol>
        <p className="text-xs text-muted-foreground">
          Proposals are never edited in place. Revising one saves a new version
          and leaves the old one exactly as it was, with the prices it was sent
          at.
        </p>
      </section>
    </div>
  );
}
