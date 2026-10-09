import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ArrowLeftIcon } from "lucide-react";

import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { loadQuoteCatalog } from "@/lib/quotes-data";
import { NewProposal, type ProposalLink } from "@/components/new-proposal";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { Button } from "@/components/ui/button";

type SearchParams = { lead?: string; merchant?: string };

/**
 * The record a "New proposal" button named, loaded under the caller's RLS.
 *
 * The name comes from HERE, not from the URL, so a hand-edited param can only
 * name a record the caller can already see. One the caller cannot see is a
 * 404 — the same answer as one that does not exist, so this page is not an
 * oracle for other reps' lead ids. (The database would also refuse the link on
 * save; this is so the page never shows a name it should not.)
 */
async function loadPrefill(
  params: SearchParams,
): Promise<(ProposalLink & { agentId: string }) | null> {
  const supabase = await createClient();

  if (params.lead !== undefined) {
    const id = Number(params.lead);
    if (!Number.isInteger(id)) notFound();
    const { data } = await supabase
      .from("leads")
      .select("id, dba, merchant_legal_name, agent_id")
      .eq("id", id)
      .maybeSingle();
    if (!data) notFound();
    return {
      type: "lead",
      id,
      // The same fallback order the trigger snapshots with.
      name:
        (data.dba as string | null)?.trim() ||
        (data.merchant_legal_name as string | null)?.trim() ||
        `Lead #${id}`,
      agentId: data.agent_id as string,
    };
  }

  if (params.merchant !== undefined) {
    const id = Number(params.merchant);
    if (!Number.isInteger(id)) notFound();
    const { data } = await supabase
      .from("merchants")
      .select("id, dba, legal_business_name, agent_id")
      .eq("id", id)
      .maybeSingle();
    if (!data) notFound();
    return {
      type: "merchant",
      id,
      name:
        (data.dba as string | null)?.trim() ||
        (data.legal_business_name as string | null)?.trim() ||
        `Merchant #${id}`,
      agentId: data.agent_id as string,
    };
  }

  return null;
}

async function NewProposalBody({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const profile = await requireUser();
  const isAdmin = profile.role === "admin";
  const params = await searchParams;

  const [prefill, catalog, reps] = await Promise.all([
    loadPrefill(params),
    loadQuoteCatalog(),
    isAdmin ? loadActiveReps() : Promise.resolve(null),
  ]);

  return (
    <NewProposal
      viewerId={profile.id}
      reps={reps}
      prefill={prefill}
      devices={catalog.devices}
      addons={catalog.addons}
      addonsByDevice={catalog.addonsByDevice}
    />
  );
}

/** Admins only: the active profiles a proposal may be made for. */
async function loadActiveReps(): Promise<{ id: string; name: string }[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("profiles")
    .select("id, full_name")
    .eq("is_active", true)
    .order("full_name", { ascending: true });
  return ((data ?? []) as { id: string; full_name: string | null }[]).map(
    (p) => ({ id: p.id, name: p.full_name ?? "Unnamed rep" }),
  );
}

export default function NewProposalPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  return (
    <PageShell width="detail">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href="/proposals">
          <ArrowLeftIcon size={16} />
          All proposals
        </Link>
      </Button>
      <PageHeader title="New proposal" />
      <Suspense
        fallback={<p className="text-sm text-muted-foreground">Loading…</p>}
      >
        <NewProposalBody searchParams={searchParams} />
      </Suspense>
    </PageShell>
  );
}
