import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ArrowLeftIcon } from "lucide-react";

import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { loadProposalGroup, loadQuoteCatalog } from "@/lib/quotes-data";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { ProposalView } from "@/components/proposal-view";
import { Button } from "@/components/ui/button";

/**
 * One proposal: the builder and its version history.
 *
 * notFound() for a group the caller can see no row of — another rep's
 * proposal and one that does not exist are both zero rows under RLS, and must
 * be the same answer, or the URL becomes an oracle for other reps' work.
 */
async function ProposalDetail({
  params,
}: {
  params: Promise<{ quoteGroupId: string }>;
}) {
  const { quoteGroupId } = await params;
  const profile = await requireUser();

  const [loaded, catalog] = await Promise.all([
    loadProposalGroup(quoteGroupId),
    loadQuoteCatalog(),
  ]);
  if (loaded === null) notFound();

  const { group, linesByQuote } = loaded;
  const current = group.current;
  const supabase = await createClient();

  // The linked record, as a link ONLY if the caller can open it. An admin may
  // file a rep's proposal against another rep's record; that rep would get a
  // 404 from the link, so they get the name as plain text instead.
  let linked: { href: string; label: string } | null = null;
  if (current.lead_id !== null) {
    const { data } = await supabase
      .from("leads")
      .select("id")
      .eq("id", current.lead_id)
      .maybeSingle();
    if (data) linked = { href: `/leads/${current.lead_id}`, label: "Lead" };
  } else if (current.merchant_id !== null) {
    const { data } = await supabase
      .from("merchants")
      .select("id")
      .eq("id", current.merchant_id)
      .maybeSingle();
    if (data) {
      linked = { href: `/merchants/${current.merchant_id}`, label: "Merchant" };
    }
  }

  // The rep it is for, shown to admins (a rep's proposals are all their own).
  let repName: string | null = null;
  if (profile.role === "admin") {
    const { data } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("id", current.agent_id)
      .maybeSingle();
    repName = (data?.full_name as string | null) ?? null;
  }

  return (
    <>
      <PageHeader
        title={current.customer_name}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {linked ? (
              <Link href={linked.href} className="text-primary hover:underline">
                {linked.label}: {current.customer_name}
              </Link>
            ) : (
              <span>
                {current.lead_id === null && current.merchant_id === null
                  ? "Not linked to a lead or merchant"
                  : "Linked record not visible to you"}
              </span>
            )}
            {repName !== null && <span>Rep: {repName}</span>}
          </span>
        }
      />
      <ProposalView
        group={group}
        linesByQuote={linesByQuote}
        devices={catalog.devices}
        addons={catalog.addons}
        addonsByDevice={catalog.addonsByDevice}
      />
    </>
  );
}

export default function ProposalPage({
  params,
}: {
  params: Promise<{ quoteGroupId: string }>;
}) {
  return (
    <PageShell width="detail">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href="/proposals">
          <ArrowLeftIcon size={16} />
          All proposals
        </Link>
      </Button>
      <Suspense
        fallback={<p className="text-sm text-muted-foreground">Loading…</p>}
      >
        <ProposalDetail params={params} />
      </Suspense>
    </PageShell>
  );
}
