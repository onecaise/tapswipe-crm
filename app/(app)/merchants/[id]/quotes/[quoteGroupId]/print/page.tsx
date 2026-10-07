import { Suspense } from "react";

import { requireUser } from "@/lib/auth";
import { loadProposal } from "@/lib/quote-proposal";
import { PageShell } from "@/components/page-shell";
import { QuoteProposalDocument } from "@/components/quote-proposal-document";

/**
 * One version of one hardware proposal on a MERCHANT.
 *
 * The twin of /leads/[id]/quotes/[quoteGroupId]/print, and deliberately only
 * the owner kind apart from it: `loadProposal()` and
 * `QuoteProposalDocument` are shared verbatim, so there is ONE implementation
 * of a sheet a merchant reads. That header carries the reasoning for the URL
 * shape — the path names the GROUP so the link keeps printing the current
 * version, and `?quote=` pins one.
 *
 * ## The 404 matters more here than it does on the lead route
 *
 * `loadProposal()` calls notFound() for a merchant the caller cannot see, for
 * a group that is not on that merchant, and for a `?quote=` outside the group
 * — never a 403. Merchant ids are sequential and a rep knows their own, so
 * "does merchant 41 exist" is exactly the question a 403 would answer and a
 * 404 does not. RLS is what makes that honest rather than cosmetic: the
 * underlying select returns zero rows, so the page is not choosing to conceal
 * something it was handed.
 *
 * ## No timeline here, and that is not an omission
 *
 * The lead page carries a chronological feed; the merchant page does not. A
 * merchant's story spans residuals, support tickets and documents as much as
 * quotes, so a feed here is a different and larger feature than the lead one —
 * and `loadLeadTimelineExtras()` is keyed on a lead throughout. Nothing in
 * this route or the shared document touches it.
 */
export default function MerchantQuotePrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; quoteGroupId: string }>;
  searchParams: Promise<{ quote?: string }>;
}) {
  // Both passed down unawaited, so every dynamic read stays inside the
  // Suspense boundary cacheComponents requires.
  return (
    <PageShell width="detail">
      <Suspense
        fallback={
          <p className="text-sm text-muted-foreground">Loading proposal…</p>
        }
      >
        <MerchantQuotePrint params={params} searchParams={searchParams} />
      </Suspense>
    </PageShell>
  );
}

async function MerchantQuotePrint({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; quoteGroupId: string }>;
  searchParams: Promise<{ quote?: string }>;
}) {
  const { id, quoteGroupId } = await params;
  const { quote } = await searchParams;

  await requireUser();

  const proposal = await loadProposal("merchant", id, quoteGroupId, quote);

  return <QuoteProposalDocument proposal={proposal} />;
}
