import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ArrowLeftIcon, PencilIcon, StoreIcon } from "lucide-react";

import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  type SupportTicket,
  supportTicketStatusVariant,
} from "@/lib/support-tickets";
import { formatDate, formatText } from "@/lib/format";
// No notes or tasks panel here on purpose: the check constraint on
// notes.owner_type / tasks.owner_type allows only lead | pre_app | merchant |
// ghost_sheet, so a support ticket has nowhere to hang them. The ticket's own
// message field is the record of what was said.
import { Badge } from "@/components/ui/badge";
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

  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-bold">{ticket.subject}</h1>
          <div className="flex items-center gap-2">
            <Badge variant={supportTicketStatusVariant(ticket.status)}>
              {ticket.status}
            </Badge>
            <span className="text-sm text-muted-foreground">
              Opened {formatDate(ticket.created_at)}
            </span>
          </div>
        </div>
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
      </div>

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
    </>
  );
}

export default function TicketDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <div className="flex-1 w-full flex flex-col gap-8 p-6 md:p-10 max-w-5xl mx-auto">
      {/* params stays unawaited here — awaiting it outside Suspense is what
          cacheComponents rejects at build time. */}
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href="/support-tickets">
          <ArrowLeftIcon size={16} />
          Back to tickets
        </Link>
      </Button>

      <Suspense
        fallback={<p className="text-sm text-muted-foreground">Loading…</p>}
      >
        <TicketDetail params={params} />
      </Suspense>
    </div>
  );
}
