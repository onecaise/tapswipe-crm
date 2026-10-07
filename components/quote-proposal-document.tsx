import Link from "next/link";
import { ArrowLeftIcon } from "lucide-react";

import { formatDate, formatMoney, formatText } from "@/lib/format";
import {
  QUOTE_STATUS_LABELS,
  type QuoteLineItem,
  groupQuoteLines,
  isQuoteStatus,
  lineTotals,
} from "@/lib/quotes";
import { PROPOSAL_TERMS, type Proposal } from "@/lib/quote-proposal";
import { PrintButton } from "@/components/print-button";
import { PrintDocument } from "@/components/print-document";
import { Button } from "@/components/ui/button";

/**
 * The Hardware Proposal — ONE document component, two routes.
 *
 * `/leads/[id]/quotes/[quoteGroupId]/print` and
 * `/merchants/[id]/quotes/[quoteGroupId]/print` both render this, and
 * `loadProposal()` in lib/quote-proposal.ts flattens the two owner tables into
 * one shape first. So the two routes are each about ten lines: await the
 * loader, render this. Two copies of a document a merchant reads is how the
 * lead version comes to say something the merchant version does not — and this
 * is the sheet somebody is handed, so "slightly different" is the whole
 * problem.
 *
 * ## The grouping comes from the SNAPSHOT
 *
 * Devices with their add-ons indented underneath, read off (sort_order,
 * product_kind) by groupQuoteLines() — the same function the builder's history
 * view uses. Deliberately NOT a live join against product_compatibility: that
 * would make a sent proposal re-group itself when an admin unlinks an
 * accessory, which is a document changing shape after it was handed over.
 *
 * ## TWO totals, never one
 *
 * One-time and monthly, side by side, with no combined figure anywhere.
 * $1,497 of terminals and $29 a month are not the same unit, so a sum of them
 * is a number that means nothing and reads as a price. Both come from the
 * snapshot — `line_total` (stored generated) and `product_billing` — so an
 * admin moving a product between billing cycles cannot move a figure between
 * the totals of a proposal that was already sent.
 *
 * ## Terms
 *
 * From PROPOSAL_TERMS, which is EMPTY. While it is empty no terms block
 * renders — not an empty heading, not a placeholder. Nothing in this
 * repository knows what Tapswipe's hardware terms are, and inventing
 * plausible legal wording for a document handed to a merchant is worse than
 * inventing a price, because a wrong price is obvious and wrong terms are not.
 * The rep's own `notes` still render, because a rep typed those.
 */
export function QuoteProposalDocument({ proposal }: { proposal: Proposal }) {
  const { owner, quote, versions, current, isCurrent, lines, preparer } =
    proposal;

  const totals = lineTotals(lines);
  const groups = groupQuoteLines(lines);
  const backHref = owner.type === "lead" ? `/leads/${owner.id}` : `/merchants/${owner.id}`;

  // Only the parts the record actually has. A merchant carries no contact
  // columns at all, so this is empty on that route and the line is omitted
  // rather than printed blank.
  const contact = [owner.contactName, owner.contactPhone, owner.contactEmail]
    .filter((part): part is string => part !== null && part !== "")
    .join(" · ");

  // Same treatment for the preparer: profiles has no phone column, so no
  // phone is printed. An agent number is included because it is how this
  // company identifies a rep on paper already (it is the join to every
  // processor residual report).
  const preparerDetails = [preparer.email, preparer.agentNumber && `Agent ${preparer.agentNumber}`]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join(" · ");

  return (
    <>
      <div className="flex items-start justify-between gap-4 print:hidden">
        <Button asChild variant="ghost" size="sm">
          <Link href={backHref}>
            <ArrowLeftIcon size={16} />
            Back to {formatText(owner.name)}
          </Link>
        </Button>
        <PrintButton />
      </div>

      <article className="rounded-xl border bg-card p-6 print:rounded-none print:border-0 print:p-0">
        <PrintDocument bodyClassName="flex flex-col gap-6">
          <header className="flex flex-col gap-1 border-b pb-4">
            <h1 className="text-xl font-bold tracking-tight">
              Hardware Proposal
            </h1>
            {/* The rep's own title is the subtitle, not the heading. The
                heading says what KIND of document this is, which is what a
                merchant holding a sheet of paper needs first; "Countertop
                package" is which one. */}
            {quote.title !== null && quote.title !== "" && (
              <p className="text-base">{quote.title}</p>
            )}
            <p className="text-sm text-muted-foreground">
              Version {quote.version} of {versions.length} ·{" "}
              {formatDate(quote.created_at)}
              {isQuoteStatus(quote.status)
                ? ` · ${QUOTE_STATUS_LABELS[quote.status]}`
                : ""}
            </p>
            {!isCurrent && (
              /* On the document, not only on screen — the same call the payout
                 summary makes with its "incomplete" line. A superseded version
                 printed without this is indistinguishable on paper from the
                 current offer, and handing one to a merchant is exactly the
                 argument the append-only design exists to settle. */
              <p className="mt-1 text-xs font-medium text-warning">
                Superseded — version {current.version} is the current one. This
                sheet is a record of an earlier offer.
              </p>
            )}
          </header>

          <div className="flex flex-col gap-6 sm:flex-row sm:gap-10">
            <section className="flex min-w-0 flex-1 flex-col gap-1">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Prepared for
              </h2>
              <p className="text-base font-medium">{formatText(owner.name)}</p>
              {/* The legal name only when it differs: on a document the
                  merchant reads, the same business printed twice reads as a
                  mistake. */}
              {owner.legalName !== null &&
                owner.legalName !== "" &&
                owner.legalName !== owner.name && (
                  <p className="text-sm text-muted-foreground">
                    {owner.legalName}
                  </p>
                )}
              {contact !== "" && <p className="text-sm">{contact}</p>}
            </section>

            <section className="flex min-w-0 flex-1 flex-col gap-1">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Prepared by
              </h2>
              {/* Null when the lookup came back empty, which for a rep is
                  every profile but their own. Omitted rather than filled with
                  a placeholder — the same treatment the lead timeline gives an
                  unresolvable author. */}
              <p className="text-base font-medium">
                {formatText(preparer.fullName)}
              </p>
              {preparerDetails !== "" && (
                <p className="text-sm text-muted-foreground">
                  {preparerDetails}
                </p>
              )}
            </section>
          </div>

          <section>
            <h2 className="sr-only">Line items</h2>
            {lines.length === 0 ? (
              /* create_quote_version() refuses a proposal with no lines, so
                 this is unreachable through the app — rendered rather than
                 omitted because a document that silently shows nothing is
                 exactly the state the RPC exists to make impossible, and it
                 should be legible if it appears. */
              <p className="text-sm text-muted-foreground">
                No line items recorded.
              </p>
            ) : (
              /* overflow-x-auto on the WRAPPER, not the table: a four-column
                 money table at 375px needs somewhere to go, and the rule is
                 that wide content scrolls inside its own container rather than
                 making the page scroll. Harmless in print, where the sheet is
                 wide enough. */
              <div className="overflow-x-auto">
                <table className="w-full min-w-[22rem] text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="pb-2 font-medium">Item</th>
                      <th className="pb-2 text-right font-medium">Qty</th>
                      <th className="pb-2 text-right font-medium">Unit</th>
                      <th className="pb-2 text-right font-medium">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((group, index) => (
                      /* A fragment per group rather than a nested table: a
                         table cannot nest inside a row and keep its columns
                         aligned with the parent's, and alignment is the whole
                         point of a money column. The indent below is what
                         carries the nesting instead. */
                      <ProposalGroup
                        key={group.device?.id ?? `orphans-${index}`}
                        device={group.device}
                        addons={group.addons}
                      />
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2">
                      <td
                        className="pt-2 text-xs uppercase tracking-wide text-muted-foreground"
                        colSpan={3}
                      >
                        One-time total
                      </td>
                      <td className="pt-2 text-right text-base font-bold tabular-nums">
                        {formatMoney(totals.oneTime)}
                      </td>
                    </tr>
                    {/* The monthly row only when there IS something monthly.
                        A permanent "$0.00 / month" on a hardware-only
                        proposal invites the question of what the merchant is
                        being billed monthly for. */}
                    {totals.monthly > 0 && (
                      <tr>
                        <td
                          className="pt-1 text-xs uppercase tracking-wide text-muted-foreground"
                          colSpan={3}
                        >
                          Monthly total
                        </td>
                        <td className="pt-1 text-right text-base font-bold tabular-nums">
                          {formatMoney(totals.monthly)}
                          <span className="text-xs font-normal text-muted-foreground">
                            {" "}
                            / month
                          </span>
                        </td>
                      </tr>
                    )}
                  </tfoot>
                </table>
              </div>
            )}
          </section>

          {quote.notes && (
            <section className="break-inside-avoid">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Notes
              </h2>
              {/* whitespace-pre-wrap: these are typed prose and the line
                  breaks are part of what the rep wrote. */}
              <p className="whitespace-pre-wrap text-sm">{quote.notes}</p>
            </section>
          )}

          {/* Renders only if somebody who knows the terms has filled the
              constant in. See PROPOSAL_TERMS. */}
          {PROPOSAL_TERMS !== "" && (
            <section className="break-inside-avoid">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Terms
              </h2>
              <p className="whitespace-pre-wrap text-sm">{PROPOSAL_TERMS}</p>
            </section>
          )}

          <footer className="border-t pt-3 text-xs text-muted-foreground">
            {/* No generation timestamp, following the payout summary: it would
                change on every render, so two printouts of an unchanged
                proposal would look like different documents. The proposal's
                own date and version are what identify this sheet. */}
            Tapswipe — hardware proposal, version {quote.version}, dated{" "}
            {formatDate(quote.created_at)}. Prices as quoted on that date.
          </footer>
        </PrintDocument>
      </article>
    </>
  );
}

/**
 * One device and the add-ons chosen under it, as sibling table rows.
 *
 * The add-ons are indented with padding on the Item cell rather than by
 * nesting a table, so every money column stays aligned with the device rows
 * above and below. A nested table would lose that alignment, which is the one
 * thing a money column is for.
 *
 * `device` is null only for an add-on line with no device above it —
 * unreachable from the store, possible from a direct insert. See
 * groupQuoteLines().
 */
function ProposalGroup({
  device,
  addons,
}: {
  device: QuoteLineItem | null;
  addons: QuoteLineItem[];
}) {
  return (
    <>
      {device !== null && <ProposalLine line={device} />}
      {addons.map((addon) => (
        <ProposalLine key={addon.id} line={addon} indented />
      ))}
    </>
  );
}

function ProposalLine({
  line,
  indented = false,
}: {
  line: QuoteLineItem;
  indented?: boolean;
}) {
  return (
    <tr className="border-b last:border-0">
      <td className={indented ? "py-1.5 pl-4" : "py-1.5"}>
        {indented && (
          // A visible marker as well as the indent: on a photocopy or a
          // black-and-white print, 16px of whitespace is not reliably legible
          // as "belongs to the line above".
          <span className="mr-1 text-muted-foreground" aria-hidden="true">
            ↳
          </span>
        )}
        {line.product_name}
        {line.product_sku && (
          <span className="ml-2 font-mono text-xs text-muted-foreground">
            {line.product_sku}
          </span>
        )}
        {/* Said on the line as well as in the total, because a merchant
            reading "19.00" next to a dock needs to know it recurs. */}
        {line.product_billing === "monthly" && (
          <span className="ml-2 text-xs text-muted-foreground">/ month</span>
        )}
      </td>
      <td className="py-1.5 text-right tabular-nums">{line.quantity}</td>
      {/* Both figures straight off the snapshot. line_total is the stored
          generated column, read rather than recomputed — a second
          implementation is a figure that can disagree with its own row. */}
      <td className="py-1.5 text-right tabular-nums">
        {formatMoney(line.unit_price)}
      </td>
      <td className="py-1.5 text-right tabular-nums">
        {formatMoney(line.line_total)}
      </td>
    </tr>
  );
}
