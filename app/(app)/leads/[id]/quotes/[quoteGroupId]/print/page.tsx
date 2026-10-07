import { Suspense } from "react";

import { requireUser } from "@/lib/auth";
import { loadProposal } from "@/lib/quote-proposal";
import { PageShell } from "@/components/page-shell";
import { QuoteProposalDocument } from "@/components/quote-proposal-document";

/**
 * One version of one hardware proposal on a LEAD, laid out to be handed over.
 *
 * Everything this page knows is the owner kind. The reads are in
 * `loadProposal()` and the document is `QuoteProposalDocument`, both shared
 * verbatim with /merchants/[id]/quotes/[quoteGroupId]/print — so there is ONE
 * implementation of a sheet a merchant reads, and no way for the two routes to
 * drift into saying slightly different things.
 *
 * ## Why the URL names the GROUP, with the version as a search param
 *
 * `quote_group_id` is the proposal; the rows sharing it are its versions, and
 * the current one is whichever holds the highest `version` (see
 * currentVersion() in lib/quotes.ts — the rule lives there and nowhere else,
 * because the database stores no is_current flag, only the uniqueness that
 * makes "highest" unambiguous).
 *
 * So the group id is what identifies the document, and keying the path on it
 * means **this URL keeps printing the current version as the proposal is
 * revised**. Keying it on a row id instead would freeze the link to whatever
 * version was current when somebody copied it: paste that into an email a
 * month later and it quietly prints a superseded offer, which is precisely the
 * mistake the append-only design exists to make answerable.
 *
 * A past version is then addressed by `?quote=<row id>` — named for what it
 * holds rather than `?version=`, because the value is a row id and not a
 * version number. Those are different scales (version 1 of a group can be row
 * 97), and a param whose name promises one while carrying the other is a bug
 * waiting on whoever reads the URL next.
 */
export default function LeadQuotePrintPage({
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
        <LeadQuotePrint params={params} searchParams={searchParams} />
      </Suspense>
    </PageShell>
  );
}

async function LeadQuotePrint({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; quoteGroupId: string }>;
  searchParams: Promise<{ quote?: string }>;
}) {
  const { id, quoteGroupId } = await params;
  const { quote } = await searchParams;

  await requireUser();

  // notFound() on every failure, inside the loader. A proposal that does not
  // exist and one belonging to another rep are the same answer, or the URL
  // becomes an id oracle.
  const proposal = await loadProposal("lead", id, quoteGroupId, quote);

  return <QuoteProposalDocument proposal={proposal} />;
}
