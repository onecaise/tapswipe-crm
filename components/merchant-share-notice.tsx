import { UsersIcon } from "lucide-react";

import { formatPct } from "@/lib/format";
import { type SharePartnerEntry, shareMonths } from "@/lib/rep-shares";

/**
 * What a REP sees of a shared account on a merchant page they can open: the
 * partner's name, the months, and their own share. Nothing else, because
 * my_share_partners() returns nothing else -- this component cannot show the
 * partner's share or payout even by mistake, since it never receives them.
 *
 * Only the signer reaches it in practice: the partner cannot open the
 * merchant record (no RLS widening, docs/design/residual-splits.md §8), so the
 * page 404s for them before this renders. Renders nothing when there is no
 * share, rather than a "not shared" line on every merchant.
 */
export function MerchantShareNotice({ entries }: { entries: SharePartnerEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <section
      className="flex min-w-0 flex-col gap-1 rounded-lg border p-3 text-sm"
      data-testid="merchant-share-notice"
    >
      {entries.map((entry) => (
        <p key={entry.rep_share_id} className="flex min-w-0 items-start gap-2">
          <UsersIcon size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 break-words">
            Shared account with <span className="font-medium">{entry.partner_name}</span>{" "}
            {shareMonths(entry.effective_from, entry.effective_to)} · your share{" "}
            {formatPct(entry.own_rep_pct)}
          </span>
        </p>
      ))}
    </section>
  );
}
