import Link from "next/link";
import { PlusIcon } from "lucide-react";

import { formatDateTime, formatMoney } from "@/lib/format";
import type { ProposalSummary } from "@/lib/quotes-data";
import {
  QUOTE_STATUS_LABELS,
  type QuoteOwnerType,
  isQuoteStatus,
  newProposalHref,
  proposalHref,
  statusIntent,
} from "@/lib/quotes";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";

/**
 * A lead's or merchant's proposals, as a compact list linking to /proposals —
 * where the builder now lives — plus a "New proposal" button that opens
 * /proposals/new prefilled with this record.
 *
 * `ownerType` is a LITERAL at both call sites, never read from the URL, and
 * the prefill carries only the record's kind and id: /proposals/new loads it
 * again under the caller's RLS and takes the name from there.
 */
export function RecordProposals({
  ownerType,
  ownerId,
  proposals,
}: {
  ownerType: QuoteOwnerType;
  ownerId: number;
  proposals: ProposalSummary[];
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Proposals</h2>
        <Button asChild size="sm">
          <Link href={newProposalHref({ type: ownerType, id: ownerId })}>
            <PlusIcon size={16} />
            New proposal
          </Link>
        </Button>
      </div>

      {proposals.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No proposals for this {ownerType === "lead" ? "lead" : "merchant"} yet.
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {proposals.map(({ group, totals }) => (
            <li key={group.quoteGroupId}>
              <Link
                href={proposalHref(group.quoteGroupId)}
                className="flex flex-col gap-1 p-3 hover:bg-accent sm:flex-row sm:items-center sm:justify-between sm:gap-3"
              >
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="truncate font-medium">
                    {group.current.title ?? "Untitled proposal"}
                  </span>
                  <StatusBadge intent={statusIntent(group.current.status)}>
                    {isQuoteStatus(group.current.status)
                      ? QUOTE_STATUS_LABELS[group.current.status]
                      : group.current.status}
                  </StatusBadge>
                  <span className="text-xs text-muted-foreground">
                    v{group.current.version} ·{" "}
                    {formatDateTime(group.current.created_at)}
                  </span>
                </span>
                <span className="shrink-0 text-sm tabular-nums">
                  {formatMoney(totals.oneTime)}
                  <span className="text-muted-foreground"> one-time</span>
                  {totals.monthly > 0 && (
                    <>
                      {" · "}
                      {formatMoney(totals.monthly)}
                      <span className="text-muted-foreground">/mo</span>
                    </>
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
