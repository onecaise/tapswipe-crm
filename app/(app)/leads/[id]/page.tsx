import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ArrowLeftIcon, FilePlusIcon, PencilIcon } from "lucide-react";

import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { type Lead } from "@/lib/leads";
import { formatDate, formatText } from "@/lib/format";
import { DOCUMENT_LIST_COLUMNS, type DocumentRow } from "@/lib/documents";
import { loadAnnotations } from "@/lib/annotations-data";
import { DocumentsPanel } from "@/components/documents-panel";
import { NotesPanel } from "@/components/notes-panel";
import { TasksPanel } from "@/components/tasks-panel";
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

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-semibold text-lg">{title}</h2>
      <dl className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">{children}</dl>
    </section>
  );
}

async function LeadDetail({ params }: { params: Promise<{ id: string }> }) {
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

  // A lead that doesn't exist and one owned by another agent are both zero rows
  // under RLS, and both 404 — distinguishing them would leak which ids exist.
  if (error || !data) {
    notFound();
  }

  const lead = data as Lead;

  let agentName: string | null = null;
  if (profile.role === "admin") {
    const { data: agent } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("id", lead.agent_id)
      .maybeSingle();
    agentName = (agent?.full_name as string | undefined) ?? null;
  }

  // Tier 1 read, scoped by the documents select policy.
  const { data: docs } = await supabase
    .from("documents")
    .select(DOCUMENT_LIST_COLUMNS)
    .eq("owner_type", "lead")
    .eq("owner_id", lead.id)
    .order("uploaded_at", { ascending: false });
  const documents = (docs ?? []) as DocumentRow[];

  // owner_type is a literal here, never from the URL: owner_id has no foreign
  // key, so a mismatched pair is not something the database would catch.
  const { notes, tasks } = await loadAnnotations("lead", lead.id);

  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-bold">{formatText(lead.dba)}</h1>
          <div className="flex items-center gap-2">
            <Badge variant="secondary">{formatText(lead.status)}</Badge>
            {lead.next_followup_date && (
              <span className="text-sm text-muted-foreground">
                Follow up {formatDate(lead.next_followup_date)}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* The lead's own fields ride across, so this is the path a rep should
              take rather than /pre-apps/new — see preAppDefaultsFromLead. */}
          <Button asChild size="sm" variant="outline">
            <Link href={`/pre-apps/new?lead=${lead.id}`}>
              <FilePlusIcon size={16} />
              Start pre-app
            </Link>
          </Button>
          <Button asChild size="sm">
            <Link href={`/leads/${lead.id}/edit`}>
              <PencilIcon size={16} />
              Edit
            </Link>
          </Button>
        </div>
      </div>

      <Section title="Contact">
        <Field label="Contact name">{formatText(lead.contact_name)}</Field>
        <Field label="Contact phone">{formatText(lead.contact_phone)}</Field>
        <Field label="Business phone">{formatText(lead.business_phone)}</Field>
        <Field label="Mobile phone">{formatText(lead.mobile_phone)}</Field>
        <Field label="Email">{formatText(lead.contact_email)}</Field>
        <Field label="Preferred contact">
          {formatText(lead.preferred_communication_method)}
        </Field>
      </Section>

      <Section title="Business">
        <Field label="Legal business name">
          {formatText(lead.merchant_legal_name)}
        </Field>
        <Field label="Industry / vertical">
          {formatText(lead.industry_vertical)}
        </Field>
        <Field label="Address">{formatText(lead.address)}</Field>
        <Field label="City">{formatText(lead.city)}</Field>
        <Field label="State">{formatText(lead.state)}</Field>
        <Field label="ZIP">{formatText(lead.zip)}</Field>
        <Field label="Country">{formatText(lead.country)}</Field>
      </Section>

      <Section title="Pipeline">
        <Field label="Lead source">{formatText(lead.lead_source)}</Field>
        <Field label="Probability to close">
          {formatText(lead.probability_to_close)}
        </Field>
        <Field label="Next follow-up">
          {formatDate(lead.next_followup_date)}
        </Field>
        <Field label="Status">{formatText(lead.status)}</Field>
        {agentName !== null && <Field label="Agent">{agentName}</Field>}
        <Field label="Last updated">{formatDate(lead.updated_at)}</Field>
      </Section>

      <TasksPanel
        ownerType="lead"
        ownerId={lead.id}
        tasks={tasks}
        agentId={profile.id}
        isAdmin={profile.role === "admin"}
      />

      <NotesPanel
        ownerType="lead"
        ownerId={lead.id}
        notes={notes}
        agentId={profile.id}
        isAdmin={profile.role === "admin"}
      />

      <DocumentsPanel
        ownerType="lead"
        ownerId={lead.id}
        documents={documents}
      />
    </>
  );
}

export default function LeadDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // params stays unawaited here — awaiting it outside Suspense is what
  // cacheComponents rejects at build time.
  return (
    <div className="flex-1 w-full flex flex-col gap-8 max-w-5xl mx-auto">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href="/leads">
          <ArrowLeftIcon size={16} />
          Back to leads
        </Link>
      </Button>

      <Suspense
        fallback={<p className="text-sm text-muted-foreground">Loading…</p>}
      >
        <LeadDetail params={params} />
      </Suspense>
    </div>
  );
}
