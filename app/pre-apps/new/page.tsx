import Link from "next/link";
import { Suspense } from "react";
import { ArrowLeftIcon } from "lucide-react";

import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { type Lead } from "@/lib/leads";
import { preAppDefaultsFromLead } from "@/lib/pre-apps";
import { PreAppCreateForm } from "@/components/pre-app-create-form";
import { Button } from "@/components/ui/button";

function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Button asChild variant="ghost" size="sm" className="self-start">
      <Link href={href}>
        <ArrowLeftIcon size={16} />
        {label}
      </Link>
    </Button>
  );
}

/**
 * `?lead=<id>` starts a pre-app from a lead, carrying its business fields over.
 *
 * The lead is resolved HERE, server-side, through the caller-scoped client — not
 * accepted from the query string and handed to the insert. Two reasons, and the
 * second is the one that matters:
 *
 *   1. RLS scopes the lookup, so another agent's lead reads as zero rows.
 *   2. `pre_apps`' insert policy only checks `agent_id`. It says nothing about
 *      `lead_id`, so a hand-typed `?lead=` would otherwise let a rep point their
 *      own pre-app at a lead they cannot see — and later attach it to an
 *      approved merchant. Only an id this lookup actually returned is passed on.
 *
 * An unresolvable lead is not an error: the page falls back to a blank form
 * rather than 404ing, because a stale bookmark should still let the rep start
 * the application they came here to start. The back link follows the same
 * resolution, so it never offers a lead the rep cannot open.
 */
async function NewPreApp({
  searchParams,
}: {
  searchParams: Promise<{ lead?: string }>;
}) {
  const { lead: leadParam } = await searchParams;
  const profile = await requireUser();

  const leadId = Number(leadParam);
  const wantsLead =
    leadParam !== undefined && Number.isInteger(leadId) && leadId > 0;

  const supabase = await createClient();
  const { data } = wantsLead
    ? await supabase.from("leads").select("*").eq("id", leadId).maybeSingle()
    : { data: null };

  if (!data) {
    return (
      <>
        <BackLink href="/pre-apps" label="Back to pre-apps" />
        <PreAppCreateForm agentId={profile.id} />
      </>
    );
  }

  const lead = data as Lead;
  const { dba_name, legal_business_name, ...carryOver } =
    preAppDefaultsFromLead(lead);

  return (
    <>
      <BackLink href={`/leads/${leadId}`} label="Back to lead" />
      {/* agent_id comes from the LEAD, not the caller. For a rep these are the
          same id — RLS shows them only their own leads — but an admin starting a
          pre-app from a rep's lead must not move the deal into their own book.
          Same rule as approve_pre_app ("never auth.uid()") and the documents
          object key, which files an admin's upload under the parent's owner. */}
      <PreAppCreateForm
        agentId={lead.agent_id}
        leadId={leadId}
        prefill={{ dba_name, legal_business_name }}
        carryOver={carryOver}
      />
    </>
  );
}

export default function NewPreAppPage({
  searchParams,
}: {
  searchParams: Promise<{ lead?: string }>;
}) {
  return (
    <div className="flex-1 w-full flex flex-col gap-6 p-6 md:p-10 max-w-3xl mx-auto">
      {/* searchParams stays unawaited here — awaiting it outside a Suspense
          boundary is what cacheComponents rejects at build time. The back link
          lives inside for the same reason: its href depends on whether the lead
          resolved. */}
      <Suspense
        fallback={<p className="text-sm text-muted-foreground">Loading…</p>}
      >
        <NewPreApp searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
