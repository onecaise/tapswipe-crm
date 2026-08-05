import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ArrowLeftIcon } from "lucide-react";

import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { type Lead } from "@/lib/leads";
import { LeadForm } from "@/components/lead-form";
import { Button } from "@/components/ui/button";

async function EditLead({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const profile = await requireUser();
  const supabase = await createClient();

  const leadId = Number(id);
  if (!Number.isInteger(leadId)) {
    notFound();
  }

  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .eq("id", leadId)
    .maybeSingle();

  // Same reasoning as the detail page: nonexistent and not-yours both 404, so
  // the edit route can't be used to probe which ids exist.
  if (error || !data) {
    notFound();
  }

  const lead = data as Lead;

  return (
    <>
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href={`/leads/${lead.id}`}>
          <ArrowLeftIcon size={16} />
          Back to lead
        </Link>
      </Button>
      <LeadForm lead={lead} agentId={profile.id} />
    </>
  );
}

export default function EditLeadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <div className="flex-1 w-full flex flex-col gap-6 p-6 md:p-10 max-w-3xl mx-auto">
      <Suspense
        fallback={<p className="text-sm text-muted-foreground">Loading…</p>}
      >
        <EditLead params={params} />
      </Suspense>
    </div>
  );
}
