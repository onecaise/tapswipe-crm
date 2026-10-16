import { formatMoney, formatPeriod, formatText } from "@/lib/format";
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
 * One rep's adjustment lines for a period, under their merchant table.
 *
 * An adjustment is a correction post_share_correction() posted (phase 5 of
 * docs/design/residual-splits.md, §6): money moved between the two reps of a
 * share agreed after the month it covers was committed. It is not a merchant
 * line -- it has no volume, residual or rate, and nothing here is editable --
 * so it gets its own block, naming the month it corrects and the admin's note.
 * Renders nothing when there are none.
 *
 * The merchant name is plain text, never a link: the rep on the other side of
 * a correction usually has no access to the merchant record, and a link that
 * 404s for one of the two reps reading this block is worse than none.
 */
export function PayoutAdjustments({
  lines,
  repName,
}: {
  lines: readonly PayoutRow[];
  repName: string;
}) {
  if (lines.length === 0) return null;

  return (
    <div className="flex flex-col gap-2" data-testid="payout-adjustments">
      <h3 className="text-sm font-semibold tracking-tight">
        Adjustments
        <span className="ml-2 font-normal text-muted-foreground">
          {lines.length} line{lines.length === 1 ? "" : "s"}
        </span>
      </h3>
      <Table aria-label={`Adjustments for ${repName}`}>
        <TableHeader>
          <TableRow>
            <TableHead>MID</TableHead>
            <TableHead>Merchant</TableHead>
            <TableHead>Corrects</TableHead>
            <TableHead>Note</TableHead>
            <TableHead>Amount</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.map((line) => {
            const negative =
              line.rep_payout !== null && line.rep_payout < 0;
            return (
              <TableRow key={line.id}>
                <TableCell className="font-mono text-xs">{line.mid}</TableCell>
                <TableCell>
                  {/* Capped and truncated for the reason the merchant table's
                      cell gives: free text from a processor's file must not
                      push the amount off screen. */}
                  <span
                    className="block max-w-[22ch] truncate"
                    title={line.merchant_name ?? undefined}
                  >
                    {formatText(line.merchant_name)}
                  </span>
                </TableCell>
                <TableCell>{formatPeriod(line.adjusts_period)}</TableCell>
                <TableCell className="min-w-[16ch] max-w-[40ch] whitespace-normal break-words text-xs text-muted-foreground">
                  {formatText(line.adjustment_note)}
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
