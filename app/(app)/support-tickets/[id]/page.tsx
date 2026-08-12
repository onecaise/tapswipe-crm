import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ArrowLeftIcon, PencilIcon, StoreIcon } from "lucide-react";

import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  type SupportTicket,
  supportTicketStatusIntent,
} from "@/lib/support-tickets";
import { formatDate, formatText } from "@/lib/format";
import { loadTicketReplies } from "@/lib/support-ticket-replies";
// Still no notes or tasks panel here: the check constraint on notes.owner_type /
// tasks.owner_type allows only lead | pre_app | merchant | ghost_sheet, so a
// ticket has nowhere to hang them — and it is not being given a member, because
// notes are scoped own-or-admin and an admin's note would be invisible to the
// rep who opened the ticket. The reply thread below is the parent-scoped
// alternative: whoever can see the ticket sees the conversation.
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { StatusBadge } from "@/components/status-badge";
import { LoadingState } from "@/components/loading-state";
import { TicketRepliesPanel } from "@/components/ticket-replies-panel";
import { Button } from "@/components/ui/button";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

async function TicketDetail({ params }: { params: Promise<{ id: string }> }) {
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

  // A ticket that doesn't exist and one belonging to another agent are both zero
  // rows under RLS, and both 404 — distinguishing them would leak which ids
  // exist.
  if (error || !data) {
    notFound();
  }

  const ticket = data as SupportTicket;

  let agentName: string | null = null;
  if (profile.role === "admin") {
    const { data: agent } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("id", ticket.agent_id)
      .maybeSingle();
    agentName = (agent?.full_name as string | undefined) ?? null;
  }

  // Scoped by the merchants select policy in its own right, so a merchant the
  // caller cannot see comes back as null rather than leaking a name.
  let merchantName: string | null = null;
  if (ticket.merchant_id !== null) {
    const { data: merchant } = await supabase
      .from("merchants")
      .select("dba")
      .eq("id", ticket.merchant_id)
      .maybeSingle();
    merchantName = (merchant?.dba as string | undefined) ?? null;
  }

  // Scoped through the parent ticket by its own policy, so this needs no
  // ownership check of its own — and the 404 above already ran if the ticket
  // isn't the caller's.
  const { replies, error: repliesError } = await loadTicketReplies(ticket.id);

  return (
    <>
      <PageHeader
        title={ticket.subject}
        action={
          <div className="flex items-center gap-2">
            {ticket.merchant_id !== null && merchantName !== null && (
              <Button asChild size="sm" variant="outline">
                <Link href={`/merchants/${ticket.merchant_id}`}>
                  <StoreIcon size={16} />
                  {merchantName}
                </Link>
              </Button>
            )}
            <Button asChild size="sm">
              <Link href={`/support-tickets/${ticket.id}/edit`}>
                <PencilIcon size={16} />
                Edit
              </Link>
            </Button>
          </div>
        }
      >
        <div className="mt-1 flex items-center gap-2">
          <StatusBadge intent={supportTicketStatusIntent(ticket.status)}>
            {ticket.status}
          </StatusBadge>
          <span className="text-sm text-muted-foreground">
            Opened {formatDate(ticket.created_at)}
          </span>
        </div>
      </PageHeader>

      <section className="flex flex-col gap-3">
        <h2 className="font-semibold text-lg">Details</h2>
        {ticket.message === null || ticket.message.trim() === "" ? (
          <p className="text-sm text-muted-foreground">
            No detail was recorded when this ticket was opened.
          </p>
        ) : (
          // whitespace-pre-line so a rep's line breaks survive. The value is
          // rendered as text by React, never as markup.
          <p className="text-sm whitespace-pre-line">{ticket.message}</p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-semibold text-lg">Classification</h2>
        <dl className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Category">{formatText(ticket.category)}</Field>
          <Field label="Sub-category">{formatText(ticket.sub_category)}</Field>
          <Field label="Priority">{formatText(ticket.priority)}</Field>
          <Field label="Serial / IMEI">
            {formatText(ticket.serial_number_imei)}
          </Field>
          <Field label="Merchant">
            {ticket.merchant_id === null
              ? formatText(null)
              : formatText(merchantName)}
          </Field>
          {agentName !== null && <Field label="Agent">{agentName}</Field>}
        </dl>
      </section>

      {repliesError === null ? (
        <TicketRepliesPanel
          ticketId={ticket.id}
          replies={replies}
          authorId={profile.id}
          isAdmin={profile.role === "admin"}
        />
      ) : (
        <p className="text-sm text-destructive">
          Could not load replies: {repliesError}
        </p>
      )}
    </>
  );
}

export default function TicketDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <PageShell width="detail">
      {/* params stays unawaited here — awaiting it outside Suspense is what
          cacheComponents rejects at build time. */}
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href="/support-tickets">
          <ArrowLeftIcon size={16} />
          Back to tickets
        </Link>
      </Button>

      <Suspense fallback={<LoadingState />}>
        <TicketDetail params={params} />
      </Suspense>
    </PageShell>
  );
}
