import { formatMoney, formatText } from "@/lib/format";
import { overrideLineLabel, type OverrideRecipientView } from "@/lib/overrides";
import type { PayoutRow } from "@/lib/payouts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * One rep's override lines for a period, under their merchant table
 * (20261102120000, memo §4.3 and A4c).
 *
 *   * A DEBIT is an override coming out of this rep's side of one of their
 *     merchants: "Override 10% of residual · to Dana Cole", a negative
 *     amount (positive in a clawback month).
 *   * A CREDIT is an override this rep RECEIVES: "Override received", with
 *     the merchant's name as plain text.
 *
 * The merchant name is never a link, on either side: the recipient has no
 * access to the merchant (no merchants policy was widened for overrides),
 * and a link that 404s for one of the two people reading the block is worse
 * than none -- the adjustments block's rule. Who receives a rep's override
 * comes from `views` (my_override_recipients() for a rep, the table for an
 * admin); a line whose name could not load shows its amount without one.
 * Renders nothing when there are none.
 */
export function PayoutOverrides({
  lines,
  views,
  repName,
  isAdmin,
}: {
  lines: readonly PayoutRow[];
  views: Map<number, OverrideRecipientView>;
  repName: string;
  isAdmin: boolean;
}) {
  if (lines.length === 0) return null;

  return (
    <div className="flex flex-col gap-2" data-testid="payout-overrides">
      <h3 className="text-sm font-semibold tracking-tight">
        Overrides
        <span className="ml-2 font-normal text-muted-foreground">
          {lines.length} line{lines.length === 1 ? "" : "s"}
        </span>
      </h3>
      <Table aria-label={`Overrides for ${repName}`}>
        <TableHeader>
          <TableRow>
            <TableHead>Merchant</TableHead>
            <TableHead>Amount</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.map((line) => {
            const negative = line.rep_payout !== null && line.rep_payout < 0;
            const view = line.override_id === null ? undefined : views.get(line.override_id);
            return (
              <TableRow key={line.id} data-testid="payout-override-line">
                {/* Two columns, the label wrapping under the name: three
                    put the amount behind the table's sideways scroll at
                    360px (measured). The name is capped and truncated for
                    the reason the merchant table's cell gives. */}
                <TableCell className="whitespace-normal">
                  <span
                    className="block max-w-[22ch] truncate"
                    title={line.merchant_name ?? undefined}
                  >
                    {formatText(line.merchant_name)}
                  </span>
                  <span className="block max-w-[40ch] break-words text-xs text-muted-foreground">
                    {overrideLineLabel(line, view, isAdmin)}
                  </span>
                </TableCell>
                <TableCell className="font-medium">
                  <span className={negative ? "text-destructive" : undefined}>
                    {formatMoney(line.rep_payout)}
                  </span>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
