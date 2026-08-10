import Link from "next/link";
import { Suspense } from "react";
import { ArrowLeftIcon } from "lucide-react";

import { requireUser } from "@/lib/auth";
import { merchantOptions } from "@/lib/merchant-options";
import { SupportTicketForm } from "@/components/support-ticket-form";
import { Button } from "@/components/ui/button";

async function NewTicket() {
  const profile = await requireUser();
  const merchants = await merchantOptions();

  return <SupportTicketForm agentId={profile.id} merchants={merchants} />;
}

export default function NewTicketPage() {
  return (
    <div className="flex-1 w-full flex flex-col gap-6 p-6 md:p-10 max-w-3xl mx-auto">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href="/support-tickets">
          <ArrowLeftIcon size={16} />
          Back to tickets
        </Link>
      </Button>

      <Suspense
        fallback={<p className="text-sm text-muted-foreground">Loading…</p>}
      >
        <NewTicket />
      </Suspense>
    </div>
  );
}
