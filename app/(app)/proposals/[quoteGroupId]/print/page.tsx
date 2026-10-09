import { Suspense } from "react";

import { requireUser } from "@/lib/auth";
import { loadProposal } from "@/lib/quote-proposal";
import { PageShell } from "@/components/page-shell";
import { QuoteProposalDocument } from "@/components/quote-proposal-document";

/**
 * One version of one hardware proposal, laid out to be handed over.
 *
 * THE print route for proposals, linked or not. The old
 * /leads/[id]/quotes/[quoteGroupId]/print and
 * /merchants/[id]/quotes/[quoteGroupId]/print redirect here (next.config.ts).
 *
 * ## Why the URL names the GROUP, with the version as a search param
 *
 * `quote_group_id` is the proposal; its rows are versions, and the current one
 * is the highest `version` (currentVersion() in lib/quotes.ts). Keying the path
 * on the group means **this URL keeps printing the current version as the
 * proposal is revised**; a row id in the path would freeze a pasted link on
 * whatever was current when it was copied.
 *
 * A past version is `?quote=<row id>` — named for what it holds rather than
 * `?version=`, because row ids and version numbers are different scales.
 */
export default function ProposalPrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ quoteGroupId: string }>;
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
        <ProposalPrint params={params} searchParams={searchParams} />
      </Suspense>
    </PageShell>
  );
}

async function ProposalPrint({
  params,
  searchParams,
}: {
  params: Promise<{ quoteGroupId: string }>;
  searchParams: Promise<{ quote?: string }>;
}) {
  const { quoteGroupId } = await params;
  const { quote } = await searchParams;
  await requireUser();

  // notFound() on every failure, inside the loader: not yours and does not
  // exist are the same answer.
  const proposal = await loadProposal(quoteGroupId, quote);
  return <QuoteProposalDocument proposal={proposal} />;
}
