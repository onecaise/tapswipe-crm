import { formatMoney } from "@/lib/format";
import { type QuoteLineItem, groupQuoteLines } from "@/lib/quotes";

/**
 * The saved lines of one proposal version, devices with their add-ons
 * indented — moved here from the old QuotesPanel so the proposal page and its
 * version history render lines one way.
 *
 * Everything comes from the SNAPSHOT on quote_line_items, never from products:
 * a saved proposal shows the prices it was sent at.
 */
export function ProposalLines({ lines }: { lines: QuoteLineItem[] }) {
  if (lines.length === 0) {
    // create_quote_version() refuses a quote with no lines, so this is
    // unreachable through the app. Rendered rather than omitted because the
    // alternative — a proposal that silently shows nothing — is exactly the
    // state the RPC exists to make impossible, and it should be legible if it
    // ever appears.
    return (
      <p className="text-xs text-muted-foreground">No line items recorded.</p>
    );
  }

  // The same grouping the printed sheet uses, from the same function: read off
  // (sort_order, product_kind) rather than from a live join against
  // product_compatibility, so a saved proposal does not re-group itself when
  // an admin unlinks an accessory.
  const groups = groupQuoteLines(lines);

  return (
    <ul className="flex flex-col gap-1.5 text-sm">
      {groups.map((group, index) => (
        <li
          key={group.device?.id ?? `orphans-${index}`}
          className="flex flex-col gap-0.5"
        >
          {group.device !== null && <LineRow line={group.device} />}
          {group.addons.length > 0 && (
            <ul className="flex flex-col gap-0.5 border-l pl-3">
              {group.addons.map((addon) => (
                <li key={addon.id}>
                  <LineRow line={addon} />
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * One line: what it is on the left, the two figures on the right — stacked on
 * a phone. In one row at 375px the name was the only flexible part, so it was
 * truncated to its first letter while the sku and both prices kept their
 * width.
 */
function LineRow({ line }: { line: QuoteLineItem }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2">
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="tabular-nums text-muted-foreground">
          {line.quantity}×
        </span>
        <span className="min-w-0 break-words">{line.product_name}</span>
        {line.product_sku && (
          <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
            {line.product_sku}
          </span>
        )}
        {line.product_billing === "monthly" && (
          <span className="shrink-0 text-xs text-muted-foreground">/mo</span>
        )}
      </div>
      <div className="flex items-baseline justify-end gap-2">
        <span className="tabular-nums text-muted-foreground">
          {formatMoney(line.unit_price)}
        </span>
        <span className="w-24 shrink-0 text-right tabular-nums">
          {formatMoney(line.line_total)}
        </span>
      </div>
    </div>
  );
}
