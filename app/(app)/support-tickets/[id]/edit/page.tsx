import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ArrowLeftIcon } from "lucide-react";

import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { merchantOptions } from "@/lib/merchant-options";
import { type SupportTicket } from "@/lib/support-tickets";
import { PageShell } from "@/components/page-shell";
import { LoadingState } from "@/components/loading-state";
import { SupportTicketForm } from "@/components/support-ticket-form";
import { Button } from "@/components/ui/button";

async function EditTicket({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const profile = await requireUser();
  const supabase = await createClient();

  const ticketId = Number(id);
  if (!Number.isInteger(ticketId)) {
    notFound();
  }

  const { data, error } = await supabase
    .from("support_tickets")
    .select("*")
    .eq("id", ticketId)
    .maybeSingle();

  // Same reasoning as the detail page: nonexistent and not-yours both 404, so
  // the edit route can't be used to probe which ids exist.
  if (error || !data) {
    notFound();
  }

  const ticket = data as SupportTicket;
  const merchants = await merchantOptions();

  return (
    <>
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href={`/support-tickets/${ticket.id}`}>
          <ArrowLeftIcon size={16} />
          Back to ticket
        </Link>
      </Button>
      <SupportTicketForm
        ticket={ticket}
        agentId={profile.id}
        merchants={merchants}
      />
    </>
  );
}

export default function EditTicketPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <PageShell width="form">
      <Suspense fallback={<LoadingState />}>
        <EditTicket params={params} />
      </Suspense>
    </PageShell>
  );
}
