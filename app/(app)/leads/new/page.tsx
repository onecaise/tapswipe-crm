import Link from "next/link";
import { Suspense } from "react";
import { ArrowLeftIcon } from "lucide-react";

import { requireUser } from "@/lib/auth";
import { PageShell } from "@/components/page-shell";
import { LeadForm } from "@/components/lead-form";
import { Button } from "@/components/ui/button";

async function NewLead() {
  const profile = await requireUser();

  return <LeadForm agentId={profile.id} />;
}

export default function NewLeadPage() {
  return (
    <PageShell width="form">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href="/leads">
          <ArrowLeftIcon size={16} />
          Back to leads
        </Link>
      </Button>

      <Suspense
        fallback={<p className="text-sm text-muted-foreground">Loading…</p>}
      >
        <NewLead />
      </Suspense>
    </PageShell>
  );
}
